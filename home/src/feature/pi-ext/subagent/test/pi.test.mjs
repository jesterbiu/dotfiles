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
const http = await import(pathToFileURL(join(packageDir, 'dist/core/http-dispatcher.js')).href);
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

test('installed SDK preserves proxy setup, controlled resources, and steering through one settlement', async t => {
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
  const tunnels = [];
  const proxyServer = createServer();
  proxyServer.on('connect', (req, socket) => {
    tunnels.push(req.url);
    socket.on('error', () => {});
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'));
  });
  await new Promise(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
  t.after(() => proxyServer.close());
  const proxy = `http://127.0.0.1:${proxyServer.address().port}`;
  const existingProxy = 'http://127.0.0.1:19082';
  const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy'];
  const savedProxyEnv = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
  for (const key of proxyKeys) delete process.env[key];
  process.env.HTTPS_PROXY = existingProxy;
  t.after(() => {
    for (const [key, value] of Object.entries(savedProxyEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    http.configureHttpDispatcher();
  });
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ httpProxy: proxy, defaultTools: [], packages: ['missing-package'] }));
  await writeFile(join(cwd, '.pi', 'settings.json'), JSON.stringify({ httpProxy: 'http://127.0.0.1:19083' }));
  const model = { provider: 'anthropic', id: 'claude-sonnet-4-5' };
  const runtime = await createPiRuntime({ sdkPath, dir, cwd, agentDir, model, thinkingLevel: 'low' });
  const session = runtime.session;
  t.after(() => runtime.dispose());
  assert.equal(process.env.HTTP_PROXY, proxy);
  assert.equal(process.env.HTTPS_PROXY, existingProxy);
  const response = await fetch('http://subagent-proxy.invalid/check', { signal: AbortSignal.timeout(3000) });
  assert.equal(await response.text(), 'ok');
  assert.deepEqual(tunnels, ['subagent-proxy.invalid:80']);
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
  await worker.start({ message: 'Initial task', messageId: randomUUID() });
  const send = message => request(worker.socketPath, { action: 'send', message, messageId: randomUUID() });
  const state = async () => JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
  await eventually(() => pending.length === 1);
  const steered = await send('Focus on tests');
  assert.equal(steered.disposition, 'queued');
  pending.shift()('First response');
  await eventually(() => pending.length === 1);
  assert.ok(JSON.stringify(contexts.at(-1)).includes('Focus on tests'));
  pending.shift()('Final response');
  await eventually(async () => (await state()).phase === 'terminated' && exits === 1);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')), { status: 'succeeded', answer: 'Final response' });
  assert.equal((await state()).usage.totalTokens, 4);
  assert.ok((await readFile(session.sessionFile, 'utf8')).includes('Final response'));
  await assert.rejects(send('Late guidance'), error => error.delivery === 'not_sent');
  assert.equal(exits, 1);
});

test('real extension discovers models, delegates, steers, reloads, and cancels through tmux and a local test provider', async t => {
  const testRoot = await mkdtemp(join(tmpdir(), 'pi-sa-extension-'));
  const agentDir = join(testRoot, 'agent');
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const requests = [];
  const provider = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({
      body: JSON.parse(body),
      fail: () => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid input https://user:secret@host/path', type: 'invalid_request_error' } }));
      },
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
    'subagent-local': { api: 'openai-completions', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'test-only', models: [{ id: 'model', name: 'Astra Local', contextWindow: 65536, maxTokens: 1024 }] },
  } }));
  const server = `pi-sa-${randomUUID()}`;
  const tmux = new Tmux(server);
  const errors = [];
  const extensionPaths = [join(source, 'background-task/index.ts'), join(source, 'subagent/index.ts'), join(source, 'statusline/index.ts')];
  const runtime = await sdk.createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
    const services = await sdk.createAgentSessionServices({
      cwd: testRoot, agentDir,
      settingsManager: sdk.SettingsManager.inMemory({ packages: [], cacheWarming: 'off' }),
      extensionFlagValues: new Map([['background-task-server', server]]),
      resourceLoaderOptions: { extensionFactories: [sdk.createCodemodeExtension({ mode: 'on' })], noExtensions: true, additionalExtensionPaths: extensionPaths, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true },
    });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    services.modelRuntime.registerProvider('subagent-test', {
      baseUrl: 'http://127.0.0.1:1', api: 'openai-completions', apiKey: 'test-only',
      models: [{ id: 'model', name: 'Astra Test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
    });
    return { ...(await sdk.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, tools: ['background_task', 'subagent', 'model_list', 'codemode'] })), services };
  }, { cwd: testRoot, agentDir, sessionManager: sdk.SessionManager.create(testRoot, join(testRoot, 'sessions')) });
  t.after(async () => { await runtime.dispose(); await tmux.run(['kill-server']).catch(() => {}); await rm(join(tmpdir(), `tmux-${process.getuid()}`, server), { force: true }); await rm(testRoot, { recursive: true, force: true }); });
  const themeModule = await import(pathToFileURL(join(packageDir, 'dist/modes/interactive/theme/theme.js')));
  themeModule.initTheme('dark');
  const footers = [];
  let activeFooter;
  let resets = 0;
  const uiContext = {
    get theme() { return themeModule.theme; },
    notify(message, type) { if (type === 'error') errors.push(message); },
    setFooter(factory) {
      activeFooter?.component.dispose?.();
      activeFooter = undefined;
      if (!factory) { resets++; return; }
      const record = { paints: 0 };
      record.component = factory({ requestRender() { record.paints++; } }, themeModule.theme, {});
      activeFooter = record;
      footers.push(record);
    },
  };
  const parentRequests = [];
  let holdParent = false;
  const parentPending = [];
  const bind = async session => {
    await session.modelRuntime.setRuntimeApiKey('subagent-test', 'test-only-never-sent');
    await session.setModel(session.modelRuntime.getModel('subagent-test', 'model'));
    session.agent.streamFunction = (selected, context) => {
      const stream = ai.createAssistantMessageEventStream();
      parentRequests.push(structuredClone(context));
      const finish = () => {
        const message = { role: 'assistant', content: [{ type: 'text', text: 'Parent observed completion' }], api: selected.api, provider: selected.provider, model: selected.id, usage, stopReason: 'stop', timestamp: Date.now() };
        stream.push({ type: 'done', reason: 'stop', message });
        stream.end();
      };
      if (holdParent) parentPending.push(finish);
      else queueMicrotask(finish);
      return stream;
    };
    await session.bindExtensions({ onError: error => errors.push(error), mode: 'tui', uiContext });
  };
  runtime.setRebindSession(bind);
  await bind(runtime.session);
  runtime.session.setActiveToolsByName(['background_task', 'subagent', 'model_list', 'codemode']);
  const call = async (name, args) => {
    const session = runtime.session;
    session.sessionManager.appendMessage({ role: 'assistant', content: [], api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4-5', usage, stopReason: 'stop', timestamp: Date.now() });
    session.refreshContext();
    const runner = session.extensionRunner;
    const id = randomUUID();
    const signal = new AbortController().signal;
    return runner.getToolDefinition(name).execute(id, args, signal, undefined, runner.createToolContext(id, signal));
  };
  const discovery = runtime.session.extensionRunner.getToolDefinition('model_list');
  assert.equal(discovery.annotations.readOnlyHint, true);
  assert.equal(discovery.outputSchema.properties.models.type, 'array');
  const runner = runtime.session.extensionRunner;
  const context = runner.createToolContext(randomUUID(), new AbortController().signal);
  const unavailableProvider = { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', models: [{ id: 'model', name: 'Astra Unavailable' }] };
  const modelConfig = JSON.parse(await readFile(join(agentDir, 'models.json'), 'utf8'));
  modelConfig.providers['subagent-unavailable'] = unavailableProvider;
  modelConfig.providers['subagent-refreshed'] = { ...unavailableProvider, apiKey: 'test-only' };
  await writeFile(join(agentDir, 'models.json'), JSON.stringify(modelConfig));
  assert.equal(context.modelRegistry.find('subagent-refreshed', 'model'), undefined);
  const allModels = await call('model_list', {});
  assert.ok(context.modelRegistry.find('subagent-unavailable', 'model'));
  assert.ok(allModels.structuredContent.models.includes('subagent-refreshed/model'));
  assert.equal(allModels.structuredContent.models.includes('subagent-unavailable/model'), false);
  const expectedModels = context.modelRegistry.getAvailable().map(model => `${model.provider}/${model.id}`).sort();
  assert.deepEqual(allModels.structuredContent, { models: expectedModels });
  assert.deepEqual(JSON.parse(allModels.content[0].text), allModels.structuredContent);
  assert.deepEqual((await call('model_list', { query: '' })).structuredContent, allModels.structuredContent);
  await runtime.session.modelRuntime.setRuntimeApiKey('subagent-unavailable', 'test-only');
  assert.deepEqual((await call('model_list', { query: 'subagent-unavailable' })).structuredContent, { models: ['subagent-unavailable/model'] });
  await runtime.session.modelRuntime.removeRuntimeApiKey('subagent-unavailable');
  assert.deepEqual((await call('model_list', { query: 'subagent-unavailable' })).structuredContent, { models: [] });
  for (const query of ['AsTrA', 'SUBAGENT-', 'MoDeL']) {
    const expected = context.modelRegistry.getAvailable()
      .filter(model => [model.provider, model.id, model.name].some(value => value.toLowerCase().includes(query.toLowerCase())))
      .map(model => `${model.provider}/${model.id}`).sort();
    const result = await call('model_list', { query });
    assert.deepEqual(result.structuredContent, { models: expected });
    assert.ok(result.structuredContent.models.includes('subagent-local/model'));
    assert.ok(result.structuredContent.models.includes('subagent-test/model'));
  }
  assert.deepEqual((await call('model_list', { query: 'no-such-subagent-model-xyz' })).structuredContent, { models: [] });
  const selected = (await call('model_list', { query: 'ASTRA LOCAL' })).structuredContent.models;
  assert.deepEqual(selected, ['subagent-local/model']);
  const scripted = await call('codemode', { code: 'const result = await tools.model_list({ query: "ASTRA LOCAL" }); text(result.models);' });
  assert.equal(scripted.isError, undefined, JSON.stringify(scripted));
  assert.ok(scripted.content.some(item => item.type === 'text' && item.text.includes('["subagent-local/model"]')), JSON.stringify(scripted));
  const notices = () => runtime.session.messages.filter(message => message.role === 'custom').map(message => ({ ...message.details, customType: message.customType }));
  const completion = task => notices().filter(notice => notice.taskId === task.taskId && notice.type === 'subagent-completion');
  const child = async task => (await call('subagent', { action: 'list' })).details.tasks.find(item => item.taskId === task.taskId);
  const launch = async extra => {
    const response = await call('subagent', { action: 'start', task: 'Inspect without edits', model: selected[0], ...extra });
    assert.equal(response.isError, undefined, JSON.stringify(response));
    const task = response.details;
    const manifest = JSON.parse(await readFile(join(task.artifacts, 'manifest.json'), 'utf8'));
    t.after(() => rm(manifest.socketDir, { recursive: true, force: true }));
    return { task, manifest };
  };
  assert.equal((await call('subagent', { action: 'start', task: 'Missing model' })).isError, true);
  assert.equal((await call('subagent', { action: 'start', task: 'No fuzzy resolution', model: 'astra' })).isError, true);
  assert.equal((await call('subagent', { action: 'start', task: 'No aliases', model: 'subagent-local/Astra Local' })).isError, true);
  const unrelated = (await call('background_task', { action: 'start', command: 'exec sleep 60' })).details;
  const standalone = (await call('background_task', { action: 'start', command: 'true' })).details;
  await eventually(() => notices().some(notice => notice.taskId === standalone.taskId && notice.type === 'background-task-completion'));

  const footerHas = topic => activeFooter?.component.render(120).some(line => line.includes(topic)) ?? false;
  const failed = await launch({ model: 'subagent-test/model', topic: 'Unavailable child' });
  await eventually(async () => (await child(failed.task)).process === 'failed');
  const failure = JSON.parse(await readFile(join(failed.task.artifacts, 'result.json'), 'utf8'));
  assert.equal(failure.status, 'failed');
  assert.match(failure.reportedError.message, /Child model is unavailable/);
  await eventually(() => completion(failed.task).length === 1);
  assert.equal(completion(failed.task)[0].result, 'failed');
  assert.equal(footerHas('Unavailable child'), false);
  await eventually(() => parentRequests.length === 1 && !runtime.session.isStreaming);
  assert.equal(runtime.session.messages.find(message => message.role === 'custom' && message.details?.taskId === failed.task.taskId).display, false);
  assert.ok(JSON.stringify(parentRequests[0]).includes('subagent-completion'));

  runtime.session.setThinkingLevel('high');
  const parentThinking = runtime.session.thinkingLevel;
  const beforeStatus = parentRequests.length;
  const live = await launch({ topic: 'Footer topic', statusReport: { afterSeconds: 0.5 } });
  assert.equal(live.manifest.thinkingLevel, parentThinking);
  assert.equal(live.manifest.topic, 'Footer topic');
  assert.ok(Number.isFinite(live.manifest.startedAt));
  const footerLines = footers.at(-1).component.render(120);
  const liveRow = footerLines.find(line => line.includes('Footer topic'));
  const plainLiveRow = liveRow.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plainLiveRow, /^↳ Footer topic \d+s model · off$/);
  assert.ok(liveRow.includes(themeModule.theme.fg('dim', '↳ ')));
  assert.ok(liveRow.includes(themeModule.theme.style('Footer topic', { fg: 'text' })));
  assert.ok(liveRow.includes(themeModule.theme.style('model', { fg: 'warning', bold: true })));
  assert.ok(liveRow.includes(themeModule.theme.style('off', { fg: 'warning' })));
  assert.ok(footerLines[0].includes(themeModule.theme.style('model', { fg: 'warning', bold: true })));
  assert.ok(footerLines[0].includes(themeModule.theme.fg('dim', ' · ')));
  const hiddenFooter = activeFooter;
  const beforeOff = resets;
  await runtime.session.prompt('/statusline off');
  assert.equal(activeFooter, undefined);
  assert.equal(resets, beforeOff + 1);
  const hiddenPaints = hiddenFooter.paints;
  await delay(1050);
  assert.equal(hiddenFooter.paints, hiddenPaints);
  await runtime.session.prompt('/statusline on');
  assert.equal(footerHas('Footer topic'), true);
  await eventually(() => notices().some(notice => notice.taskId === live.task.taskId && notice.type === 'subagent-status'));
  assert.equal(parentRequests.length, beforeStatus);
  await eventually(() => requests.length === 1);
  const resolved = JSON.parse(await readFile(join(live.task.artifacts, 'resolved.json'), 'utf8'));
  assert.equal(resolved.thinkingLevel, 'off');
  const steered = await call('subagent', { action: 'send', taskId: live.task.taskId, message: 'Focus on tests' });
  assert.equal(steered.details.disposition, 'queued', JSON.stringify(steered));
  await runtime.session.abort();
  const unrelatedMetadataPath = join(unrelated.artifacts, 'metadata.json');
  const unrelatedMetadata = await readFile(unrelatedMetadataPath, 'utf8');
  await writeFile(unrelatedMetadataPath, '{malformed');
  const oldFooter = footers.at(-1);
  await runtime.session.reload();
  await eventually(() => footers.at(-1).component.render(120).some(line => line.includes('Footer topic')));
  assert.notEqual(footers.at(-1), oldFooter);
  extensionPaths.reverse();
  await runtime.session.reload();
  const oldPaints = oldFooter.paints;
  await eventually(() => footers.at(-1).component.render(120).some(line => line.includes('Footer topic')));
  assert.notEqual(footers.at(-1), oldFooter);
  assert.ok(errors.length >= 2);
  assert.ok(errors.every(error => typeof error === 'string' && error.startsWith('Background tasks:')));
  errors.length = 0;
  await writeFile(unrelatedMetadataPath, unrelatedMetadata);
  await delay(1050);
  assert.equal(oldFooter.paints, oldPaints);
  runtime.session.setActiveToolsByName(['background_task', 'subagent']);
  assert.equal((await child(live.task)).phase, 'busy');
  requests[0].reply('First answer');
  await eventually(() => requests.length === 2);
  assert.ok(JSON.stringify(requests[1].body).includes('Focus on tests'));
  requests[1].reply('Steered answer');
  await eventually(async () => (await child(live.task)).process === 'succeeded');
  assert.deepEqual(JSON.parse(await readFile(join(live.task.artifacts, 'result.json'), 'utf8')), { status: 'succeeded', answer: 'Steered answer' });
  await eventually(() => completion(live.task).length === 1);
  assert.equal(completion(live.task)[0].result, 'succeeded');
  assert.equal(completion(live.task)[0].phase, 'terminated');
  assert.equal(footerHas('Footer topic'), false);
  assert.equal(notices().some(notice => notice.taskId === live.task.taskId && notice.customType === 'background-task'), false);
  assert.equal((await call('subagent', { action: 'send', taskId: live.task.taskId, message: 'Late' })).isError, true);
  await eventually(() => !runtime.session.isStreaming);
  const oldProcess = (await call('background_task', { action: 'list' })).details.tasks.find(task => task.taskId === live.task.taskId);
  const oldMetadataPath = join(oldProcess.artifacts, 'metadata.json');
  const oldMetadata = JSON.parse(await readFile(oldMetadataPath, 'utf8'));
  for (let order = 0; order < 2; order++) {
    await writeFile(oldMetadataPath, JSON.stringify({ ...oldMetadata, outcome: null }));
    extensionPaths.reverse();
    const beforeReload = parentRequests.length;
    await runtime.session.reload();
    runtime.session.setActiveToolsByName(['background_task', 'subagent']);
    assert.equal(parentRequests.length, beforeReload);
    assert.equal(completion(live.task).length, 1);
    assert.equal(footers.at(-1).component.render(120).some(line => line.includes('Footer topic')), false);
  }
  await runtime.session.prompt('/subagent-ui on');

  holdParent = true;
  const busyTurn = runtime.session.prompt('Remain busy');
  await eventually(() => parentPending.length === 1);
  const beforeBusy = parentRequests.length;
  const cancelled = await launch({ topic: 'Cancelled child', thinkingLevel: 'low' });
  assert.equal(cancelled.manifest.thinkingLevel, 'low');
  await eventually(() => requests.length === 3);
  const cancellation = await call('subagent', { action: 'cancel', taskId: cancelled.task.taskId });
  assert.equal(cancellation.details.process, 'cancelled');
  assert.equal(footerHas('Cancelled child'), false);
  await eventually(() => runtime.session.agent.hasQueuedMessages());
  assert.equal(completion(cancelled.task).length, 0);
  assert.equal(parentRequests.length, beforeBusy);
  holdParent = false;
  parentPending.shift()();
  await busyTurn;
  await eventually(() => parentRequests.length === beforeBusy + 1 && !runtime.session.isStreaming);
  assert.ok(JSON.stringify(parentRequests.at(-1)).includes(cancelled.task.taskId));
  assert.equal(completion(cancelled.task).length, 1);
  assert.equal(runtime.session.messages.find(message => message.role === 'custom' && message.details?.taskId === cancelled.task.taskId).display, true);
  await runtime.session.prompt('/subagent-ui off');
  assert.ok(['failed', 'unavailable'].includes(completion(cancelled.task)[0].result));
  assert.equal(completion(cancelled.task)[0].answer, undefined);
  assert.equal((await call('background_task', { action: 'list' })).details.tasks.find(item => item.taskId === unrelated.taskId).process, 'running');

  const timed = await launch({ topic: 'Timed child', timeoutSeconds: 3 });
  await eventually(() => requests.length === 4);
  await eventually(async () => (await child(timed.task)).process === 'timed_out');
  await eventually(() => completion(timed.task).length === 1);
  assert.ok(['failed', 'unavailable'].includes(completion(timed.task)[0].result));
  assert.equal(footerHas('Timed child'), false);

  const killed = await launch({ topic: 'Killed child' });
  await eventually(() => requests.length === 5);
  const killedProcess = (await call('background_task', { action: 'list' })).details.tasks.find(task => task.taskId === killed.task.taskId);
  const metadata = JSON.parse(await readFile(join(killedProcess.artifacts, 'metadata.json'), 'utf8'));
  const pane = (await tmux.run(['display-message', '-p', '-t', metadata.tmuxSession, '#{pane_pid}'])).trim();
  const children = (await readFile(`/proc/${pane}/task/${pane}/children`, 'utf8')).trim().split(/\s+/);
  assert.equal(children.length, 1);
  process.kill(Number(children[0]), 'SIGKILL');
  await eventually(() => completion(killed.task).length === 1);
  assert.equal(completion(killed.task)[0].process, 'failed');
  assert.equal(completion(killed.task)[0].result, 'unavailable');
  assert.equal(footerHas('Killed child'), false);
  await assert.rejects(readFile(join(killed.task.artifacts, 'result.json')), { code: 'ENOENT' });

  const rejected = await launch({ topic: 'Rejected child' });
  await eventually(() => requests.length === 6);
  requests[5].fail();
  await eventually(() => completion(rejected.task).length === 1);
  assert.equal(completion(rejected.task)[0].process, 'succeeded');
  assert.equal(completion(rejected.task)[0].result, 'failed');
  assert.equal(footerHas('Rejected child'), false);
  assert.match(completion(rejected.task)[0].reportedError.message, /Invalid input/);
  assert.equal(JSON.stringify(completion(rejected.task)).includes('secret'), false);
  const missing = await launch({ topic: 'Missing process child' });
  await eventually(() => requests.length === 7);
  const missingProcess = (await call('background_task', { action: 'list' })).details.tasks.find(task => task.taskId === missing.task.taskId);
  const missingMetadata = JSON.parse(await readFile(join(missingProcess.artifacts, 'metadata.json'), 'utf8'));
  await tmux.run(['kill-session', '-t', missingMetadata.tmuxSession]);
  assert.equal((await call('background_task', { action: 'status', taskId: missing.task.taskId })).details.process, 'unknown');
  await eventually(() => completion(missing.task).length === 1);
  assert.equal(completion(missing.task)[0].process, 'unknown');
  assert.equal(footerHas('Missing process child'), false);
  await eventually(() => !runtime.session.isStreaming);
  const beforeTerminalReload = parentRequests.length;
  await runtime.session.reload();
  runtime.session.setActiveToolsByName(['background_task', 'subagent']);
  assert.equal(footers.at(-1).component.render(120).length, 1);
  assert.equal(parentRequests.length, beforeTerminalReload);
  for (const task of [failed.task, live.task, cancelled.task, timed.task, killed.task, rejected.task, missing.task]) {
    assert.equal(completion(task).length, 1);
    assert.equal(notices().some(notice => notice.taskId === task.taskId && notice.customType === 'background-task'), false);
  }

  const owned = await launch();
  await eventually(() => requests.length === 8);
  const ownedProcess = (await call('background_task', { action: 'list' })).details.tasks.find(task => task.taskId === owned.task.taskId);
  const beforeCleanup = parentRequests.length;
  await runtime.newSession();
  assert.equal(parentRequests.length, beforeCleanup);
  assert.equal(footers.at(-1).component.render(120).length, 1);
  assert.equal(JSON.parse(await readFile(join(ownedProcess.artifacts, 'metadata.json'), 'utf8')).outcome.status, 'cancelled');
  assert.equal((await call('subagent', { action: 'list' })).details.tasks.length, 0);
  assert.deepEqual(errors, []);
});
