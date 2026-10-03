import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Controller } from '../controller.mjs';
import { atomicJson } from '../storage.mjs';
import { serve, request } from '../protocol.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-sa-control-'));
  const tasks = new Map();
  const calls = [];
  const execute = async args => {
    calls.push(args);
    let details;
    if (args.action === 'start') {
      details = { taskId: randomUUID(), status: 'running', metadataPath: '/task/metadata.json', stdoutPath: '/task/stdout.log', stderrPath: '/task/stderr.log' };
      tasks.set(details.taskId, details);
    } else if (args.action === 'list') details = { tasks: [...tasks.values()], errors: [] };
    else if (args.action === 'status') {
      details = tasks.get(args.taskId);
      if (!details) return { isError: true, result: { content: [{ type: 'text', text: 'missing' }], details: { action: 'status', taskId: args.taskId, cause: 'Task not found' } } };
    }
    else if (args.action === 'cancel') {
      details = { ...tasks.get(args.taskId), status: 'cancelled' };
      tasks.set(args.taskId, details);
    } else throw new Error('Must not use background cancelAll');
    return { isError: false, result: { content: [{ type: 'text', text: JSON.stringify(details) }], details } };
  };
  const notices = [];
  const options = { root, owner: 'parent-a', workerPath: '/extension/launch.mjs', sdkPath: '/pi/dist/index.js', agentDir: '/pi/agent', onResult: result => notices.push(result) };
  let controller = new Controller(options);
  await controller.init();
  const socketDirs = [];
  t.after(async () => {
    await controller.dispose();
    await rm(root, { recursive: true, force: true });
    for (const dir of socketDirs) await rm(dir, { recursive: true, force: true });
  });
  const call = args => controller.run(args, execute, { cwd: root, model: { provider: 'provider', id: 'model' }, thinkingLevel: 'medium' });
  const start = async task => {
    const result = await call({ action: 'start', task });
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    socketDirs.push(manifest.socketDir);
    return { result, manifest };
  };
  return { root, calls, tasks, options, notices, call, start, watching: () => controller.watchers.size, reload: async () => { await controller.dispose(); controller = new Controller(options); await controller.init(); } };
}

test('delegation persists ownership, reconnects after reload, and scopes cancellation away from shell tasks', async t => {
  const { root, calls, tasks, options, notices, call, start, watching, reload } = await fixture(t);
  const foreignId = randomUUID();
  tasks.set(foreignId, { taskId: foreignId, status: 'running' });
  const { result, manifest } = await start("Inspect files; don't run shell text: $(touch unwanted)");
  assert.equal(result.phase, 'starting');
  assert.ok(calls[0].command.startsWith('exec '));
  assert.equal(calls[0].command.includes('touch unwanted'), false);
  assert.equal(manifest.task.includes('touch unwanted'), true);
  assert.equal(manifest.owner, options.owner);
  assert.equal(manifest.thinkingLevel, 'medium');
  assert.equal((await call({ action: 'list' })).tasks.length, 1);
  await assert.rejects(call({ action: 'cancel', taskId: foreignId }), /not owned/);
  const foreign = new Controller({ ...options, owner: 'parent-b' });
  await foreign.init();
  t.after(() => foreign.dispose());
  assert.equal((await foreign.run({ action: 'list' }, async () => ({ result: { details: { tasks: [...tasks.values()], errors: [] } } }), {})).tasks.length, 0);
  await atomicJson(join(result.artifactDir, 'state.json'), { phase: 'idle', sessionId: 'child', latestResult: { sequence: 1, resultPath: '/result/1.json' } });
  for (let i = 0; i < 100 && notices.length === 0; i++) await delay(10);
  assert.equal(notices[0]?.taskId, result.taskId);
  assert.equal(notices[0]?.sequence, 1);
  assert.equal(watching(), 1);
  await reload();
  assert.equal(watching(), 1);
  const listed = await call({ action: 'list' });
  assert.equal(listed.tasks[0].sessionId, 'child');
  assert.equal(listed.tasks[0].phase, 'idle');
  assert.equal(notices.length, 1);
  const received = [];
  const close = await serve(manifest.socketPath, value => {
    received.push(value);
    if (value.message === 'Busy') throw Object.assign(new Error('Compaction in progress'), { delivery: 'busy' });
    return { messageId: value.messageId, disposition: 'started', result: 3 };
  });
  t.after(close);
  const messageId = randomUUID();
  const sent = await call({ action: 'send', taskId: result.taskId, message: 'Follow up', messageId });
  assert.equal(sent.disposition, 'started');
  assert.equal(sent.result, 3);
  assert.equal(calls.at(-1).action, 'status');
  assert.equal(received[0].messageId, messageId);
  await assert.rejects(call({ action: 'send', taskId: result.taskId, message: 'Busy', messageId }), error => error.delivery === 'busy' && error.messageId === messageId);
  const cancelled = await call({ action: 'cancelAll' });
  assert.equal(cancelled.results.length, 1);
  assert.equal(tasks.get(foreignId).status, 'running');
  assert.equal(received.at(-1).action, 'stop');
  assert.equal((await call({ action: 'list' })).tasks[0].phase, 'terminated');
  await assert.rejects(call({ action: 'send', taskId: result.taskId, message: 'Late' }), /terminated/);
  await atomicJson(join(result.artifactDir, 'state.json'), { phase: 'terminated', sessionId: 'child', latestResult: { sequence: 2, resultPath: '/result/2.json' } });
  for (let i = 0; i < 100 && (notices.length < 2 || watching() > 0); i++) await delay(10);
  assert.equal(notices[1]?.sequence, 2);
  assert.equal(watching(), 0);
  await reload();
  assert.equal(watching(), 0);
  assert.equal((await call({ action: 'list' })).tasks[0].phase, 'terminated');
  tasks.delete(result.taskId);
  await assert.rejects(call({ action: 'send', taskId: result.taskId, message: 'Lost' }), /Task not found/);
  tasks.set(result.taskId, { taskId: result.taskId, status: 'cancelled' });
  assert.equal(calls.some(c => c.action === 'cancelAll'), false);
  tasks.delete(result.taskId);
  const unknown = await call({ action: 'list' });
  assert.equal(unknown.tasks[0].status, 'unknown');
  assert.equal(unknown.tasks[0].phase, 'unknown');
  assert.equal(unknown.errors[0].taskId, result.taskId);
  assert.ok(root);
});

test('launch failures retain useful artifacts and propagate nested errors instead of claiming a child started', async t => {
  const { options, root } = await fixture(t);
  const controller = new Controller(options);
  await controller.init();
  t.after(() => controller.dispose());
  let failure;
  try {
    await controller.run({ action: 'start', task: 'Task' }, async () => ({ isError: true, result: { content: [{ type: 'text', text: 'Blocked by policy' }], details: { cause: 'Blocked by policy' } } }), { cwd: root, model: { provider: 'p', id: 'm' } });
  } catch (error) { failure = error; }
  assert.match(failure.message, /Blocked by policy/);
  assert.ok(failure.artifactDir);
  const launch = JSON.parse(await readFile(join(failure.artifactDir, 'launch-error.json'), 'utf8'));
  assert.match(launch.error, /Blocked/);
  const listed = await controller.run({ action: 'list' }, async () => ({ result: { details: { tasks: [], errors: [] } } }), {});
  assert.equal(listed.tasks.length, 0);
  assert.equal(listed.errors[0].artifactDir, failure.artifactDir);
});

test('socket timeout reports uncertain delivery and preserves the request ID', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-sa-timeout-'));
  const socketPath = join(root, 'control.sock');
  const close = await serve(socketPath, () => new Promise(() => {}));
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true }); });
  const messageId = randomUUID();
  await assert.rejects(request(socketPath, { action: 'send', messageId, message: 'Slow acknowledgement' }, { timeoutMs: 30 }), error => error.delivery === 'unknown' && error.messageId === messageId);
});
