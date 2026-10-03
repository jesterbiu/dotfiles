import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createPiRuntime } from '../pi-session.mjs';
import { Worker } from '../worker.mjs';
import { request } from '../protocol.mjs';
import { Tmux } from '../../background-task/manager.mjs';

const packageDir = process.env.PI_PACKAGE_DIR;
if (!packageDir) throw new Error('Set PI_PACKAGE_DIR to the installed Pi package directory');
const root = await mkdtemp(join(tmpdir(), 'pi-sa-sdk-'));
process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
const sdkPath = join(packageDir, 'dist/index.js');
const sdk = await import(pathToFileURL(sdkPath).href);
const ai = await import(pathToFileURL(join(packageDir, '../pi-ai/dist/compat.js')).href);
const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function eventually(action) {
  for (let i = 0; i < 300; i++) {
    const value = await action();
    if (value) return value;
    await delay(25);
  }
  assert.fail('Condition did not become true');
}

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

test('installed SDK preserves context and steering across settled runs with controlled child resources', async t => {
  const dir = join(root, 'child');
  const cwd = join(root, 'workspace');
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  await mkdir(dir, { recursive: true });
  await mkdir(join(cwd, '.pi', 'extensions'), { recursive: true });
  await mkdir(join(agentDir, 'extensions'), { recursive: true });
  await writeFile(join(cwd, 'AGENTS.md'), 'Use the durable workspace instructions.');
  await writeFile(join(cwd, '.pi', 'SYSTEM.md'), 'UNWANTED SYSTEM PROMPT');
  await writeFile(join(agentDir, 'extensions', 'bad.ts'), 'throw new Error("User extensions must not load")');
  await writeFile(join(cwd, '.pi', 'extensions', 'bad.ts'), 'throw new Error("Project extensions must not load")');
  const model = { provider: 'anthropic', id: 'claude-sonnet-4-5' };
  const runtime = await createPiRuntime({ sdkPath, dir, cwd, agentDir, model, thinkingLevel: 'low' });
  const session = runtime.session;
  assert.deepEqual(session.getActiveToolNames().sort(), ['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write']);
  assert.ok(session.systemPrompt.includes('durable workspace instructions'));
  assert.equal(session.systemPrompt.includes('UNWANTED SYSTEM PROMPT'), false);
  assert.equal(session.thinkingLevel, 'low');
  await session.modelRuntime.setRuntimeApiKey(model.provider, 'test-only-never-sent');
  const pending = [];
  const contexts = [];
  session.agent.streamFunction = (selected, context, options) => {
    const stream = ai.createAssistantMessageEventStream();
    contexts.push(structuredClone(context));
    const finish = (text, stopReason = 'stop') => {
      const message = { role: 'assistant', content: [{ type: 'text', text }], api: selected.api, provider: selected.provider, model: selected.id, usage, stopReason, timestamp: Date.now() };
      stream.push(stopReason === 'aborted' ? { type: 'error', reason: 'aborted', error: message } : { type: 'done', reason: 'stop', message });
      stream.end();
    };
    options?.signal?.addEventListener('abort', () => finish('Aborted', 'aborted'), { once: true });
    pending.push(finish);
    return stream;
  };
  let exits = 0;
  const worker = new Worker({ dir, socketPath: join(dir, 'control.sock'), session, dispose: () => runtime.dispose(), exit: () => { exits++; } });
  t.after(async () => { await worker.close(); await rm(root, { recursive: true, force: true }); });
  await worker.start();
  const send = (message, mode = 'steer') => request(worker.socketPath, { action: 'send', message, mode, messageId: randomUUID() });
  const state = async () => JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
  const initial = await send('Initial task');
  assert.equal(initial.disposition, 'started');
  assert.equal(initial.result, 1);
  await eventually(() => pending.length === 1);
  const steered = await send('Focus on tests');
  assert.equal(steered.disposition, 'queued');
  assert.equal(steered.result, 1);
  assert.equal((await send('Then review errors', 'followUp')).disposition, 'queued');
  pending.shift()('First response');
  await eventually(() => pending.length === 1);
  pending.shift()('Steered response');
  await eventually(() => pending.length === 1);
  pending.shift()('Final response');
  const first = await eventually(async () => { const s = await state(); return s.latestResult?.sequence === 1 && s; });
  assert.equal(first.phase, 'idle');
  assert.equal(await readFile(first.latestResult.answerPath, 'utf8'), 'Final response\n');
  const followUp = await send('Follow up in the same conversation');
  assert.equal(followUp.disposition, 'started');
  assert.equal(followUp.result, 2);
  await eventually(() => pending.length === 1);
  assert.ok(JSON.stringify(contexts.at(-1)).includes('Final response'));
  pending.shift()('Follow-up answer');
  const second = await eventually(async () => { const s = await state(); return s.latestResult?.sequence === 2 && s; });
  assert.equal(second.sessionId, first.sessionId);
  assert.ok((await readFile(session.sessionFile, 'utf8')).includes('Follow-up answer'));
  assert.equal(JSON.parse(await readFile(second.latestResult.resultPath, 'utf8')).usage.totalTokens, 2);
  assert.equal((await send('Work that gets stopped')).result, 3);
  await eventually(() => pending.length === 1);
  assert.deepEqual(await request(worker.socketPath, { action: 'stop' }), { phase: 'stopping' });
  const stopped = await eventually(async () => { const s = await state(); return s.phase === 'terminated' && s; });
  assert.equal(stopped.latestResult.sequence, 3);
  assert.equal(JSON.parse(await readFile(stopped.latestResult.resultPath, 'utf8')).status, 'failed');
  assert.equal(exits, 1);
});

test('real extension delegates, steers, reloads, and cancels through tmux and a local test provider', async t => {
  const testRoot = await mkdtemp(join(tmpdir(), 'pi-sa-extension-'));
  const agentDir = join(testRoot, 'agent');
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const requests = [];
  const provider = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({
      body: JSON.parse(body),
      reply: text => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const base = { id: randomUUID(), object: 'chat.completion.chunk', created: 1, model: 'model' };
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
        res.end('data: [DONE]\n\n');
      },
    });
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => { provider.closeAllConnections(); provider.close(); });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: {
    'subagent-local': { api: 'openai-completions', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'test-only', models: [{ id: 'model', contextWindow: 65536, maxTokens: 1024 }] },
  } }));
  const server = `pi-sa-${randomUUID()}`;
  const tmux = new Tmux(server);
  const errors = [];
  const runtime = await sdk.createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
    const services = await sdk.createAgentSessionServices({
      cwd: testRoot, agentDir,
      settingsManager: sdk.SettingsManager.inMemory({ packages: [], cacheWarming: 'off' }),
      extensionFlagValues: new Map([['background-task-server', server]]),
      resourceLoaderOptions: { noExtensions: true, additionalExtensionPaths: [join(source, 'background-task/index.ts'), join(source, 'subagent/index.ts')], noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true },
    });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    services.modelRuntime.registerProvider('subagent-test', {
      baseUrl: 'http://127.0.0.1:1', api: 'openai-completions', apiKey: 'test-only',
      models: [{ id: 'model', name: 'Test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
    });
    return { ...(await sdk.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, tools: ['background_task', 'subagent'] })), services };
  }, { cwd: testRoot, agentDir, sessionManager: sdk.SessionManager.create(testRoot, join(testRoot, 'sessions')) });
  t.after(async () => { await runtime.dispose(); await tmux.run(['kill-server']).catch(() => {}); await rm(join(tmpdir(), `tmux-${process.getuid()}`, server), { force: true }); await rm(testRoot, { recursive: true, force: true }); });
  const bind = session => session.bindExtensions({ onError: error => errors.push(error), mode: 'json' });
  runtime.setRebindSession(bind);
  await bind(runtime.session);
  runtime.session.setActiveToolsByName(['background_task', 'subagent']);
  const call = async (name, args) => {
    const session = runtime.session;
    session.sessionManager.appendMessage({ role: 'assistant', content: [], api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4-5', usage, stopReason: 'stop', timestamp: Date.now() });
    session.refreshContext();
    const runner = session.extensionRunner;
    const id = randomUUID();
    const signal = new AbortController().signal;
    return runner.getToolDefinition(name).execute(id, args, signal, undefined, runner.createToolContext(id, signal));
  };
  const unrelated = (await call('background_task', { action: 'start', command: 'exec sleep 60' })).details;
  const started = await call('subagent', { action: 'start', task: 'This must fail before any model request', model: 'subagent-test/model' });
  assert.equal(started.isError, undefined, JSON.stringify(started));
  const task = started.details;
  assert.ok(task.taskId);
  const manifest = JSON.parse(await readFile(task.manifestPath, 'utf8'));
  t.after(() => rm(manifest.socketDir, { recursive: true, force: true }));
  await runtime.session.abort();
  await runtime.session.reload();
  runtime.session.setActiveToolsByName(['background_task', 'subagent']);
  const listed = (await call('subagent', { action: 'list' })).details;
  assert.equal(listed.tasks.length, 1);
  assert.equal(listed.tasks[0].taskId, task.taskId);
  await eventually(async () => {
    const value = (await call('subagent', { action: 'list' })).details;
    return value.tasks[0]?.status === 'failed';
  });
  assert.match(await readFile(join(task.artifactDir, 'startup-error.json'), 'utf8'), /Child model is unavailable/);
  const live = (await call('subagent', { action: 'start', task: 'Inspect without edits', model: 'subagent-local/model' })).details;
  assert.ok(live.taskId, JSON.stringify(live));
  const liveManifest = JSON.parse(await readFile(live.manifestPath, 'utf8'));
  t.after(() => rm(liveManifest.socketDir, { recursive: true, force: true }));
  await eventually(() => requests.length === 1);
  const steered = await call('subagent', { action: 'send', taskId: live.taskId, message: 'Focus on tests' });
  assert.equal(steered.details.disposition, 'queued', JSON.stringify(steered));
  await runtime.session.abort();
  requests[0].reply('First answer');
  await eventually(() => requests.length === 2);
  assert.ok(JSON.stringify(requests[1].body).includes('Focus on tests'));
  requests[1].reply('Steered answer');
  const child = async () => (await call('subagent', { action: 'list' })).details.tasks.find(item => item.taskId === live.taskId);
  const first = await eventually(async () => { const value = await child(); return value.latestResult?.sequence === 1 && value; });
  assert.equal(first.phase, 'idle');
  assert.equal(await readFile(first.latestResult.answerPath, 'utf8'), 'Steered answer\n');
  await eventually(() => runtime.session.messages.some(message => message.role === 'custom' && message.customType === 'subagent-result'));
  await runtime.session.reload();
  runtime.session.setActiveToolsByName(['background_task', 'subagent']);
  const followUp = await call('subagent', { action: 'send', taskId: live.taskId, message: 'Review the result', mode: 'followUp' });
  assert.equal(followUp.details.disposition, 'started', JSON.stringify(followUp));
  await eventually(() => requests.length === 3);
  assert.ok(JSON.stringify(requests[2].body).includes('Steered answer'));
  requests[2].reply('Reviewed answer');
  const second = await eventually(async () => { const value = await child(); return value.latestResult?.sequence === 2 && value; });
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(await readFile(second.latestResult.answerPath, 'utf8'), 'Reviewed answer\n');
  const cancelled = await call('subagent', { action: 'cancelAll' });
  assert.equal(cancelled.details.results.length, 2);
  assert.deepEqual(cancelled.details.errors, []);
  assert.equal((await child()).phase, 'terminated');
  assert.equal((await call('background_task', { action: 'list' })).details.tasks.find(item => item.taskId === unrelated.taskId).status, 'running');
  const owned = (await call('subagent', { action: 'start', task: 'Wait for owner shutdown', model: 'subagent-local/model' })).details;
  const ownedManifest = JSON.parse(await readFile(owned.manifestPath, 'utf8'));
  t.after(() => rm(ownedManifest.socketDir, { recursive: true, force: true }));
  await eventually(() => requests.length === 4);
  await runtime.newSession();
  const ownedTask = JSON.parse(await readFile(owned.metadataPath, 'utf8'));
  assert.equal(ownedTask.outcome.status, 'cancelled');
  assert.equal((await call('subagent', { action: 'list' })).details.tasks.length, 0);
  assert.deepEqual(errors, []);
});
