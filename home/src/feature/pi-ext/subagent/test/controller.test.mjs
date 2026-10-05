import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
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
      details = { taskId: randomUUID(), process: 'running', artifacts: '/task' };
      tasks.set(details.taskId, details);
    } else if (args.action === 'list') details = { tasks: [...tasks.values()] };
    else if (args.action === 'status') {
      details = tasks.get(args.taskId);
      if (!details) return { isError: true, result: { details: { error: 'Task not found' } } };
    } else if (args.action === 'cancel') {
      details = { ...tasks.get(args.taskId), process: 'cancelled' };
      tasks.set(args.taskId, details);
    } else throw new Error('Must not use background cancelAll');
    return { result: { details } };
  };
  const notices = [];
  const changes = [];
  const errors = [];
  const options = { root, owner: 'parent-a', workerPath: '/extension/launch.mjs', sdkPath: '/pi/dist/index.js', agentDir: '/pi/agent', onResult: result => notices.push(result), onChange: row => changes.push(row), onError: error => errors.push(error) };
  let controller = new Controller(options);
  await controller.init();
  const socketDirs = [];
  t.after(async () => {
    await controller.dispose();
    await rm(root, { recursive: true, force: true });
    for (const dir of socketDirs) await rm(dir, { recursive: true, force: true });
  });
  const context = { cwd: root, model: { provider: 'provider', id: 'model' }, thinkingLevel: 'medium' };
  const call = args => controller.run(args, execute, context);
  const start = async (extra = {}) => {
    const result = await call({ action: 'start', task: "Inspect; don't execute $(touch unwanted)", model: 'provider/model', ...extra });
    const manifest = JSON.parse(await readFile(join(result.artifacts, 'manifest.json'), 'utf8'));
    socketDirs.push(manifest.socketDir);
    return { result, manifest };
  };
  return { root, calls, tasks, options, notices, changes, errors, call, start, context, execute, controller: () => controller, event: event => controller.onProcess(event), reload: async () => { await controller.dispose(); controller = new Controller(options); await controller.init(); } };
}

test('one-task delegation reconnects, routes one completion, and scopes cancellation', async t => {
  const f = await fixture(t);
  await assert.rejects(f.call({ action: 'start', task: 'Task' }), /exact model/);
  const foreignId = randomUUID();
  f.tasks.set(foreignId, { taskId: foreignId, process: 'running' });
  const { result, manifest } = await f.start();
  const launch = f.calls.find(call => call.action === 'start');
  assert.ok(launch.command.startsWith('exec '));
  assert.equal(launch.command.includes('touch unwanted'), false);
  assert.equal(launch.notificationTarget, 'subagent');
  assert.equal(manifest.thinkingLevel, 'medium');
  assert.equal(manifest.version, 2);
  assert.equal((await f.call({ action: 'list' })).tasks.length, 1);
  await assert.rejects(f.call({ action: 'cancel', taskId: foreignId }), /not owned/);
  await atomicJson(join(result.artifacts, 'state.json'), { phase: 'busy' });
  await f.reload();
  assert.equal((await f.call({ action: 'list' })).tasks[0].phase, 'busy');
  assert.equal(f.notices.length, 0);
  f.changes.length = 0;
  await f.controller().restore([...f.tasks.values()]);
  assert.equal(f.changes.length, 1);
  assert.equal(f.changes[0].taskId, result.taskId);
  assert.equal(f.changes[0].startedAt, manifest.startedAt);
  f.controller().onChange = () => { throw new Error('UI unavailable'); };
  const received = [];
  const close = await serve(manifest.socketPath, value => {
    received.push(value);
    return { messageId: value.messageId, disposition: 'queued' };
  });
  t.after(close);
  const messageId = randomUUID();
  assert.deepEqual(await f.call({ action: 'send', taskId: result.taskId, message: 'Focus', messageId }), { taskId: result.taskId, messageId, disposition: 'queued' });
  assert.equal(f.calls.at(-1).action, 'status');
  await assert.rejects(f.call({ action: 'send', taskId: result.taskId, message: 'Next', mode: 'followUp' }), /Only steering/);
  await atomicJson(join(result.artifacts, 'result.json'), { status: 'failed', answer: 'Private partial answer', reportedError: { source: 'sdk', message: 'fetch failed https://user:secret@host/path' } });
  const event = { owner: f.options.owner, type: 'completion', task: { taskId: result.taskId, process: 'succeeded', exitCode: 0 } };
  await f.event({ ...event, owner: 'other' });
  await Promise.all([f.event(event), f.event(event)]);
  assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0].type, 'subagent-completion');
  assert.equal(f.errors.at(-1).message, 'UI unavailable');
  assert.equal(f.notices[0].result, 'failed');
  assert.equal(f.notices[0].process, 'succeeded');
  assert.equal(JSON.stringify(f.notices).includes('Private partial'), false);
  assert.equal(JSON.stringify(f.notices).includes('secret'), false);
  const cancelled = await f.call({ action: 'cancelAll' });
  assert.equal(cancelled.results.length, 1);
  assert.equal(cancelled.errors, undefined);
  assert.equal(f.tasks.get(foreignId).process, 'running');
  assert.equal(received.at(-1).action, 'stop');
  await assert.rejects(f.call({ action: 'send', taskId: result.taskId, message: 'Late' }), /terminated/);
  f.tasks.delete(result.taskId);
  assert.equal((await f.call({ action: 'list' })).tasks[0].process, 'unknown');
  assert.equal(f.calls.some(call => call.action === 'cancelAll'), false);
});

test('thinking override, hard termination, and corrupt output remain explicit', async t => {
  const f = await fixture(t);
  const { result, manifest } = await f.start({ thinkingLevel: 'high' });
  assert.equal(manifest.thinkingLevel, 'high');
  await f.call({ action: 'cancel', taskId: result.taskId });
  const next = await f.start();
  const event = { owner: f.options.owner, type: 'completion', task: { taskId: next.result.taskId, process: 'timed_out' } };
  await f.event(event);
  assert.equal(f.notices[0].result, 'unavailable');
  assert.equal(f.notices[0].phase, 'terminated');
  await writeFile(join(next.result.artifacts, 'state.json'), '{broken');
  await f.event({ ...event, type: 'status', task: { ...event.task, taskId: result.taskId } });
  const corruptState = (await f.call({ action: 'list' })).tasks.find(task => task.taskId === next.result.taskId);
  assert.equal(corruptState.phase, 'unknown');
  assert.match(corruptState.error, /state.json/);
  await writeFile(join(next.result.artifacts, 'result.json'), '{broken');
  assert.equal((await f.call({ action: 'list' })).tasks.find(task => task.taskId === next.result.taskId).result, 'unknown');
  await writeFile(join(next.result.artifacts, 'binding.json'), '{broken');
  assert.match((await f.call({ action: 'list' })).errors[0].error, /JSON/);
  await assert.rejects(f.start(), /unreadable/);
});

test('launch failure keeps recovery artifacts and cancels a known process', async t => {
  const f = await fixture(t);
  const id = randomUUID();
  const calls = [];
  const execute = async args => {
    calls.push(args);
    if (args.action === 'list') return { result: { details: { tasks: [] } } };
    if (args.action === 'cancel') throw new Error('Cancellation unavailable');
    return { isError: true, result: { details: { error: 'Launch interrupted', taskId: id } } };
  };
  let failure;
  try { await f.controller().run({ action: 'start', task: 'Task', model: 'provider/model' }, execute, f.context); }
  catch (error) { failure = error; }
  assert.match(failure.message, /Launch interrupted/);
  assert.equal(failure.taskId, id);
  assert.equal(calls.at(-1).action, 'cancel');
  assert.match(failure.sideEffects[0], /Cancellation unavailable/);
  const manifest = JSON.parse(await readFile(join(failure.artifactDir, 'manifest.json'), 'utf8'));
  t.after(() => rm(manifest.socketDir, { recursive: true, force: true }));
  const listed = await f.call({ action: 'list' });
  assert.equal(listed.tasks[0].process, 'unknown');
  assert.equal(listed.tasks[0].artifacts, failure.artifactDir);
});

test('completion during launch waits for binding publication and is suppressed after disposal', async t => {
  const f = await fixture(t);
  let event;
  const execute = async args => {
    const outcome = await f.execute(args);
    if (args.action === 'start') event = f.event({ owner: f.options.owner, type: 'completion', task: { ...outcome.result.details, process: 'failed' } });
    return outcome;
  };
  const task = await f.controller().run({ action: 'start', task: 'Task', model: 'provider/model' }, execute, f.context);
  const manifest = JSON.parse(await readFile(join(task.artifacts, 'manifest.json'), 'utf8'));
  t.after(() => rm(manifest.socketDir, { recursive: true, force: true }));
  await event;
  assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0].taskId, task.taskId);
  assert.equal(f.notices[0].result, 'unavailable');
  let finish;
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.controller().view = () => { entered(); return new Promise(resolve => { finish = resolve; }); };
  const oldChanges = f.changes.length;
  const update = f.controller().changed({ dir: task.artifacts, manifest, binding: task }, task);
  await waiting;
  await f.controller().dispose();
  finish({ taskId: task.taskId });
  await update;
  assert.equal(f.changes.length, oldChanges);
  await f.event({ owner: f.options.owner, type: 'status', task });
  assert.equal(f.notices.length, 1);
});

test('socket timeout reports uncertain delivery and preserves the request ID', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-sa-timeout-'));
  const socketPath = join(root, 'control.sock');
  const close = await serve(socketPath, () => new Promise(() => {}));
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true }); });
  const messageId = randomUUID();
  await assert.rejects(request(socketPath, { action: 'send', messageId, message: 'Slow acknowledgement' }, { timeoutMs: 30 }), error => error.delivery === 'unknown' && error.messageId === messageId);
});
