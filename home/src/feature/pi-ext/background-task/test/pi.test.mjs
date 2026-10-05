import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Tmux } from '../manager.mjs';

const packageDir = process.env.PI_PACKAGE_DIR;
if (!packageDir) throw new Error('Set PI_PACKAGE_DIR to the installed @earendil-works/pi-coding-agent package directory');
const root = await mkdtemp(join(tmpdir(), 'pi-background-sdk-'));
process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
const sdk = await import(pathToFileURL(join(packageDir, 'dist/index.js')).href);
const agentCore = await import(pathToFileURL(join(packageDir, '../pi-agent-core/dist/agent-loop.js')).href);
const extension = resolve(dirname(fileURLToPath(import.meta.url)), '../index.ts');

async function eventually(action, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await action();
    if (value) return value;
    await delay(25);
  }
  assert.fail(message);
}

test('real Pi runtime exposes no wait action, preserves abort and reload, and cleans session discontinuations', async t => {
  const server = `pi-sdk-${randomUUID()}`;
  const tmux = new Tmux(server);
  const errors = [];
  const diagnostics = [];
  t.mock.method(console, 'error', message => diagnostics.push(String(message)));
  const cwd = join(root, 'workspace');
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const create = async ({ sessionManager, sessionStartEvent }) => {
    const services = await sdk.createAgentSessionServices({
      cwd, agentDir,
      settingsManager: sdk.SettingsManager.inMemory({ packages: [], extensions: [], cacheWarming: 'off' }),
      extensionFlagValues: new Map([['background-task-server', server]]),
      resourceLoaderOptions: {
        noExtensions: true,
        additionalExtensionPaths: [extension],
        noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      },
    });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    return { ...(await sdk.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, noTools: true })), services };
  };
  const runtime = await sdk.createAgentSessionRuntime(create, {
    cwd, agentDir, sessionManager: sdk.SessionManager.create(cwd, join(root, 'sessions')),
  });
  t.after(async () => {
    await runtime.dispose();
    await tmux.run(['kill-server']).catch(() => {});
    await rm(join(tmpdir(), `tmux-${process.getuid()}`, server), { force: true });
    await rm(root, { recursive: true, force: true });
  });
  const bind = async session => {
    await session.bindExtensions({ onError: error => errors.push(error), mode: 'json' });
  };
  runtime.setRebindSession(bind);
  await bind(runtime.session);

  const execute = async args => {
    const runner = runtime.session.extensionRunner;
    const tool = runner.getToolDefinition('background_task');
    assert.ok(tool);
    const id = randomUUID();
    const signal = new AbortController().signal;
    return tool.execute(id, args, signal, undefined, runner.createToolContext(id, signal));
  };
  const call = async args => (await execute(args)).details;
  const start = () => call({ action: 'start', command: 'exec sleep 60' });
  const present = async task => (await tmux.inspect(JSON.parse(await readFile(join(task.artifacts, 'metadata.json'), 'utf8')).tmuxSession)) !== null;

  const tool = runtime.session.extensionRunner.getToolDefinition('background_task');
  assert.equal(JSON.stringify(tool.parameters).includes('wait'), false);
  const failedStart = await execute({ action: 'start', command: 'true', cwd: 'missing' });
  assert.equal(failedStart.isError, true);
  assert.equal(failedStart.details.action, 'start');
  assert.ok(failedStart.details.taskId);
  assert.equal(typeof failedStart.details.error, 'string');
  assert.equal(failedStart.details.sideEffects, undefined);
  assert.deepEqual(JSON.parse(failedStart.content[0].text), failedStart.details);
  const loopFailure = await agentCore.runToolCall(
    { type: 'toolCall', id: randomUUID(), name: 'background_task', arguments: { action: 'start', command: 'true', cwd: 'missing' } },
    { tools: runtime.session.agent.state.tools, assistantMessage: { role: 'assistant', content: [] }, context: { messages: [], tools: runtime.session.agent.state.tools } },
  );
  assert.equal(loopFailure.isError, true);
  assert.equal(loopFailure.result.details.action, 'start');
  assert.ok(loopFailure.result.details.taskId);
  assert.equal(typeof loopFailure.result.details.error, 'string');
  assert.equal(loopFailure.result.details.sideEffects, undefined);
  const fast = await call({ action: 'start', command: 'printf sdk-output; printf sdk-error >&2' });
  const finished = await eventually(async () => {
    const listed = await call({ action: 'list' });
    return listed.tasks.find(task => task.taskId === fast.taskId && task.process === 'succeeded');
  }, 'fast task did not finish');
  assert.equal(finished.process, 'succeeded');
  assert.equal(await readFile(join(fast.artifacts, 'stdout.log'), 'utf8'), 'sdk-output');
  assert.equal(await readFile(join(fast.artifacts, 'stderr.log'), 'utf8'), 'sdk-error');
  await eventually(() => runtime.session.messages.some(message => message.role === 'custom' && message.customType === 'background-task'), 'completion was not delivered');
  assert.equal(runtime.session.isStreaming, false);

  const task = await start();
  await runtime.session.abort();
  assert.equal(await present(task), true);
  await runtime.session.reload();
  assert.equal((await call({ action: 'list' })).tasks.some(item => item.taskId === task.taskId), true);

  const originalFile = runtime.session.sessionFile;
  assert.ok(originalFile);
  await runtime.newSession();
  assert.equal(await present(task), false);

  const next = await start();
  await runtime.switchSession(originalFile);
  assert.equal(await present(next), false);

  const forked = await start();
  const entryId = runtime.session.sessionManager.appendMessage({ role: 'user', content: 'Fork point', timestamp: Date.now() });
  await runtime.fork(entryId, { position: 'at' });
  assert.equal(await present(forked), false);

  const quitting = await start();
  const malformed = await start();
  const malformedSession = JSON.parse(await readFile(join(malformed.artifacts, 'metadata.json'), 'utf8')).tmuxSession;
  await writeFile(join(malformed.artifacts, 'metadata.json'), '{broken');
  await runtime.dispose();
  assert.equal(await present(quitting), false);
  assert.equal(await tmux.inspect(malformedSession), null);
  assert.ok(diagnostics.some(message => message.includes(malformed.taskId) && message.includes('cancel')));
  assert.deepEqual(errors, []);
});
