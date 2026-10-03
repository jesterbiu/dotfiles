import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskManager, Tmux } from '../manager.mjs';

const exec = promisify(execFile);
const metadata = task => JSON.parse(readFileSync(task.metadataPath, 'utf8'));
const session = task => metadata(task).tmuxSession;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi tasks ' $; "));
  const server = `pi-test-${randomUUID()}`;
  const tmux = new Tmux(server);
  const managers = [];
  const events = [];
  const errors = [];
  const manager = (owner = 'session-$;:/one', extra = {}) => {
    const value = new TaskManager({ owner, root, tmux, onEvent: event => events.push(event), onError: error => errors.push(error), ...extra });
    managers.push(value);
    return value;
  };
  t.after(async () => {
    for (const value of managers) await value.dispose();
    await exec('tmux', ['-L', server, 'kill-server']).catch(() => {});
    await rm(join(tmpdir(), `tmux-${process.getuid()}`, server), { force: true });
    await rm(root, { recursive: true, force: true });
  });
  return { root, server, tmux, manager, events, errors };
}

async function eventually(action, message = 'condition was not met') {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await action();
    if (value) return value;
    await delay(20);
  }
  assert.fail(message);
}

test('launch is prompt, non-interactive, exact, durable, and hides tmux resources', async t => {
  const { manager, root, tmux, server, events } = await fixture(t);
  const current = manager();
  const began = Date.now();
  const running = await current.start({ command: 'test ! -t 0 && test ! -t 1 && test ! -t 2 && ! read ignored && printf hello && printf error >&2 && exec sleep 30', cwd: root });
  assert.ok(Date.now() - began < 1000);
  assert.equal(running.tmuxSession, undefined);
  assert.equal((await current.list()).tasks[0].tmuxSession, undefined);
  await eventually(async () => (await readFile(running.stdoutPath, 'utf8')) === 'hello');
  assert.equal(await readFile(running.stderrPath, 'utf8'), 'error');
  await current.cancel(running.taskId);
  const failed = await current.start({ command: 'printf out; printf err >&2; exit 7', cwd: root });
  await eventually(() => metadata(failed).outcome);
  assert.equal(metadata(failed).outcome.status, 'failed');
  assert.equal(metadata(failed).outcome.exitCode, 7);
  assert.equal(await readFile(failed.exitPath, 'utf8'), '7');
  assert.equal(await readFile(failed.stdoutPath, 'utf8'), 'out');
  assert.equal(await readFile(failed.stderrPath, 'utf8'), 'err');
  await eventually(async () => (await tmux.inspect(session(failed))) === null);
  assert.equal(events.filter(event => event.type === 'completion' && event.task.taskId === failed.taskId).length, 1);
  assert.equal(events.some(event => event.type === 'completion' && event.task.tmuxSession), false);
  assert.equal(current.armed.has(failed.taskId), false);
  const run = tmux.run.bind(tmux);
  tmux.run = args => run(args.map(arg => arg.replace(/^'tmux' -L /, "'tmux-absent' -L ")));
  const gateless = await current.start({ command: 'touch should-not-run', cwd: root });
  tmux.run = run;
  await eventually(() => metadata(gateless).outcome);
  assert.equal(metadata(gateless).outcome.status, 'failed');
  assert.equal(metadata(gateless).outcome.exitCode, 127);
  await assert.rejects(access(join(root, 'should-not-run')));
  await eventually(async () => (await tmux.inspect(session(gateless))) === null);
  assert.equal(events.filter(event => event.type === 'completion' && event.task.taskId === gateless.taskId).length, 1);
  const away = await current.start({ command: 'exec sleep 30', cwd: root });
  await current.dispose();
  assert.equal(current.armed.size, 0);
  const panePid = (await exec('tmux', ['-L', server, 'list-panes', '-t', `=${session(away)}`, '-F', '#{pane_pid}'])).stdout.trim();
  await eventually(() => exec('pkill', ['-TERM', '-P', panePid]).then(() => true, () => false));
  await eventually(() => readFile(away.exitPath, 'utf8').catch(() => null));
  assert.equal(metadata(away).outcome, null);
  const replacement = manager();
  await replacement.observe();
  assert.equal(metadata(away).outcome.status, 'failed');
  assert.equal(metadata(away).outcome.exitCode, 143);
  assert.equal(events.filter(event => event.type === 'completion' && event.task.taskId === away.taskId).length, 1);
  assert.equal(await tmux.inspect(session(away)), null);
  assert.equal((await replacement.list()).tasks.find(task => task.taskId === failed.taskId).status, 'failed');
});

test('start serializes its visible metadata with observation and disposal', async t => {
  const { manager, root, tmux, events } = await fixture(t);
  const current = manager();
  const launch = tmux.launch.bind(tmux);
  let release;
  tmux.launch = async (...args) => {
    await new Promise(resolve => { release = resolve; });
    return launch(...args);
  };
  const starting = current.start({ command: 'exec sleep 30', cwd: root });
  await eventually(() => current.taskIds().then(ids => ids.length === 1));
  const [taskId] = await current.taskIds();
  const observing = current.observe();
  await delay(20);
  assert.equal(metadata({ metadataPath: current.metadataPath(taskId) }).outcome, null);
  assert.equal(events.length, 0);
  const disposing = current.dispose();
  assert.equal(await Promise.race([disposing.then(() => true), delay(20).then(() => false)]), false);
  release();
  const task = await starting;
  await observing;
  await disposing;
  const replacement = manager();
  assert.equal((await replacement.list()).tasks.find(item => item.taskId === task.taskId).status, 'running');
  await replacement.cancel(task.taskId);
  tmux.launch = launch;
  const racing = await replacement.start({ command: `until test -e ${JSON.stringify(join(root, 'go'))}; do sleep 0.05; done; exit 3`, cwd: root });
  const read = replacement.readMetadata.bind(replacement);
  let armed = true;
  replacement.readMetadata = async taskId => {
    const record = await read(taskId);
    if (armed && taskId === racing.taskId) {
      armed = false;
      await writeFile(join(root, 'go'), '');
      await eventually(() => readFile(racing.exitPath, 'utf8').catch(() => null));
    }
    return record;
  };
  const listed = (await replacement.list()).tasks.find(item => item.taskId === racing.taskId);
  replacement.readMetadata = read;
  assert.equal(listed.status, 'failed');
  await eventually(() => metadata(racing).outcome);
  assert.equal(metadata(racing).outcome.exitCode, 3);
  await eventually(async () => (await tmux.inspect(session(racing))) === null);
  assert.equal(events.filter(event => event.type === 'completion' && event.task.taskId === racing.taskId).length, 1);
});

test('batch cleanup performs one locked action per task and retains terminal evidence on persistence failure', async t => {
  const { manager, root, tmux, errors } = await fixture(t);
  const current = manager();
  const write = current.writeMetadata.bind(current);
  current.writeMetadata = async record => {
    if (record.command === 'true' && record.outcome) throw new Error('terminal write failed');
    return write(record);
  };
  const terminal = await current.start({ command: 'true', cwd: root });
  const malformed = await current.start({ command: 'exec sleep 30', cwd: root });
  const malformedSession = session(malformed);
  await eventually(() => errors.some(error => error.action === 'observe' && error.taskId === terminal.taskId && error.cause.message === 'terminal write failed'));
  assert.equal((await tmux.inspect(session(terminal))).dead, true);
  assert.equal(metadata(terminal).outcome, null);
  await writeFile(malformed.metadataPath, '{bad json');
  const batch = await current.close();
  assert.equal(batch.errors.some(error => error.taskId === terminal.taskId && error.action === 'cancel'), true);
  assert.equal(batch.errors.some(error => error.taskId === malformed.taskId && error.sideEffects.includes('tmux session removed')), true);
  assert.equal((await tmux.inspect(session(terminal))).dead, true);
  assert.equal(await tmux.inspect(malformedSession), null);
});

test('terminal cleanup failure keeps recorded evidence for a later cancellation', async t => {
  const { manager, root, tmux, errors } = await fixture(t);
  const current = manager();
  const remove = tmux.remove.bind(tmux);
  tmux.remove = async () => { throw new Error('cleanup failed'); };
  const task = await current.start({ command: 'true', cwd: root });
  await eventually(() => errors.some(error => error.action === 'observe' && error.taskId === task.taskId));
  assert.equal(metadata(task).outcome.status, 'succeeded');
  assert.equal(metadata(task).operationErrors[0].cause, 'cleanup failed');
  assert.equal(current.armed.has(task.taskId), false);
  await assert.rejects(current.cancel(task.taskId), error => error.action === 'cancel' && error.taskId === task.taskId && error.cause.message === 'cleanup failed');
  const batch = await current.cancelAll();
  assert.equal(batch.errors.some(error => error.action === 'cancel' && error.taskId === task.taskId && error.cause === 'cleanup failed'), true);
  const write = current.writeMetadata.bind(current);
  current.writeMetadata = async () => { throw new Error('error persistence failed'); };
  await assert.rejects(current.cancel(task.taskId), error => error.action === 'cancel' && error.taskId === task.taskId && error.message.includes('cleanup failed') && error.message.includes('error persistence failed'));
  assert.equal(metadata(task).outcome.status, 'succeeded');
  assert.equal((await tmux.inspect(session(task))).dead, true);
  current.writeMetadata = write;
  tmux.remove = remove;
  await current.cancel(task.taskId);
  assert.equal(await tmux.inspect(session(task)), null);
});

test('external deletion and server loss record unknown with a reason, and cleanup succeeds without a server', async t => {
  const { manager, root, tmux, server, events, errors } = await fixture(t);
  const current = manager();
  const task = await current.start({ command: 'exec sleep 30', cwd: root });
  const remove = tmux.remove.bind(tmux);
  tmux.remove = async record => {
    await exec('tmux', ['-L', server, 'kill-session', '-t', `=${record.tmuxSession}`]);
    return remove(record);
  };
  assert.equal((await current.cancel(task.taskId)).status, 'unknown');
  assert.equal(metadata(task).outcome.status, 'unknown');
  assert.equal(metadata(task).outcome.reason, 'tmux session missing after inspection');
  tmux.remove = remove;
  const lost = await current.start({ command: 'exec sleep 30', cwd: root });
  await exec('tmux', ['-L', server, 'kill-server']);
  await current.observe();
  assert.equal(metadata(lost).outcome.status, 'unknown');
  assert.equal(metadata(lost).outcome.reason, 'tmux server unreachable');
  const notices = events.filter(event => event.type === 'completion' && event.task.taskId === lost.taskId);
  assert.equal(notices.length, 1);
  assert.deepEqual([notices[0].task.status, notices[0].task.reason, notices[0].task.stdoutPath, notices[0].task.stderrPath], ['unknown', 'tmux server unreachable', lost.stdoutPath, lost.stderrPath]);
  await current.observe();
  assert.deepEqual(errors, []);
  const listed = await current.list();
  assert.equal(listed.tasks.find(item => item.taskId === lost.taskId).status, 'unknown');
  assert.deepEqual(listed.errors, []);
  assert.equal((await current.cancel(lost.taskId)).status, 'unknown');
  assert.deepEqual((await current.close()).errors, []);
  assert.equal(events.filter(event => event.type === 'completion' && event.task.taskId === lost.taskId).length, 1);
  const unused = manager('unused', { tmux: new Tmux(`pi-test-${randomUUID()}`) });
  assert.deepEqual((await unused.close()).errors, []);
});

test('errors are task identified, diagnostics are isolated, and invalid records remain local', async t => {
  const { manager, root, tmux, errors } = await fixture(t);
  const current = manager('errors', {
    onEvent: () => { throw new Error('notification failed'); },
    onError: () => { throw new Error('diagnostic failed'); },
  });
  const a = await current.start({ command: 'exec sleep 30', cwd: root });
  const b = await current.start({ command: 'exec sleep 30', cwd: root, statusReport: { afterSeconds: 1 } });
  const bRecord = metadata(b);
  bRecord.deadline = 'bad';
  await writeFile(b.metadataPath, JSON.stringify(bRecord));
  assert.equal((await current.cancel(a.taskId)).status, 'cancelled');
  const listed = await current.list();
  assert.equal(listed.tasks.find(task => task.taskId === b.taskId).error.action, 'list');
  const c = await current.start({ command: 'exec sleep 30', cwd: root });
  tmux.inspect = async () => { throw new Error('transport failed'); };
  await assert.rejects(current.observe(c.taskId), error => error.action === 'observe' && error.taskId === c.taskId && Boolean(error.cause));
  assert.equal(errors.length, 0);
});

test('registered timers fire without polling, completion wins over deadlines, and async callbacks do not block peers', async t => {
  const { manager, root, tmux, events, errors } = await fixture(t);
  const current = manager('timers', {
    onEvent: event => { events.push(event); return Promise.reject(new Error('delivery rejected')); },
    onError: () => Promise.reject(new Error('diagnostic rejected')),
  });
  const plain = await current.start({ command: 'exec sleep 30', cwd: root });
  const once = await current.start({ command: 'exec sleep 30', cwd: root, statusReport: { afterSeconds: 0.05 } });
  const repeat = await current.start({ command: 'exec sleep 30', cwd: root, statusReport: { afterSeconds: 0.05, repeat: true } });
  const done = await current.start({ command: 'true', cwd: root, timeoutSeconds: 1 });
  const timed = await current.start({ command: 'exec sleep 30', cwd: root, timeoutSeconds: 0.03 });
  assert.deepEqual([current.armed.get(plain.taskId).deadline, current.armed.get(plain.taskId).report], [undefined, undefined]);
  assert.ok(current.armed.get(timed.taskId).deadline);
  assert.ok(current.armed.get(repeat.taskId).report);
  await eventually(() => metadata(done).outcome && metadata(timed).outcome, 'timers did not fire');
  assert.equal(metadata(timed).outcome.status, 'timed_out');
  assert.equal(await tmux.inspect(session(timed)), null);
  await eventually(() => events.filter(event => event.type === 'status' && event.task.taskId === repeat.taskId).length >= 2);
  await delay(Math.max(0, metadata(done).deadline - Date.now() + 100));
  assert.equal(metadata(done).outcome.status, 'succeeded');
  assert.equal(events.filter(event => event.type === 'completion' && event.task.taskId === done.taskId).length, 1);
  assert.equal(events.filter(event => event.type === 'status' && event.task.taskId === once.taskId).length, 1);
  assert.equal(metadata(once).nextReportAt, null);
  assert.equal(metadata(plain).outcome, null);
  assert.deepEqual(errors, []);
  await current.dispose();
  assert.equal(current.armed.size, 0);
});

test('batch discovery failures remain identified and dispose waits for accepted batch cleanup', async t => {
  const { manager, root, tmux } = await fixture(t);
  const current = manager();
  const task = await current.start({ command: 'exec sleep 30', cwd: root });
  const owned = tmux.owned.bind(tmux);
  let release;
  tmux.owned = async prefix => {
    await new Promise(resolve => { release = resolve; });
    return owned(prefix);
  };
  const batch = current.cancelAll();
  await eventually(() => Boolean(release), 'owned discovery did not start');
  let disposed = false;
  const disposing = current.dispose().then(() => { disposed = true; });
  await delay(20);
  assert.equal(disposed, false);
  release();
  await batch;
  await disposing;
  tmux.owned = owned;
  assert.equal(await tmux.inspect(session(task)), null);

  const storage = manager('storage');
  const storageTask = await storage.start({ command: 'exec sleep 30', cwd: root });
  storage.taskIds = async () => { throw new Error('storage unavailable'); };
  const storageBatch = await storage.cancelAll();
  assert.equal(storageBatch.errors.some(error => error.action === 'cancelAll' && error.cause === 'storage unavailable'), true);
  assert.equal(await tmux.inspect(session(storageTask)), null);

  const transport = manager('transport');
  const transportTask = await transport.start({ command: 'exec sleep 30', cwd: root });
  transport.tmux.owned = async () => { throw new Error('tmux unavailable'); };
  const transportBatch = await transport.cancelAll();
  assert.equal(transportBatch.errors.some(error => error.action === 'cancelAll' && error.cause === 'tmux unavailable'), true);
  assert.equal(metadata(transportTask).outcome.status, 'cancelled');
});

test('setup errors preserve identity and side effects, reject copied metadata, and contain shell metacharacters', async t => {
  const { manager, root, tmux } = await fixture(t);
  const current = manager();
  const run = tmux.run.bind(tmux);
  tmux.run = async args => {
    if (args[0] === 'wait-for' && args[1] === '-S') throw new Error('gate failed');
    return run(args);
  };
  await assert.rejects(current.start({ command: 'touch should-not-run', cwd: root }), error => error.action === 'start' && error.taskId && error.cause && error.sideEffects.length > 0);
  tmux.run = run;
  const write = current.writeMetadata.bind(current);
  current.writeMetadata = async record => {
    if (record.launch.status === 'created') throw new Error('initial metadata failed');
    return write(record);
  };
  let initialError;
  await assert.rejects(current.start({ command: 'true', cwd: root }), error => { initialError = error; return error.action === 'start' && error.taskId && Boolean(error.cause); });
  await assert.rejects(access(current.taskDir(initialError.taskId)));
  current.writeMetadata = async record => {
    if (record.launch.status === 'started') throw new Error('post-release metadata failed');
    return write(record);
  };
  await assert.rejects(current.start({ command: 'exec sleep 30', cwd: root }), error => error.action === 'start' && error.taskId && Boolean(error.cause) && error.sideEffects.includes('tmux session removed'));
  current.writeMetadata = write;
  const a = await current.start({ command: "printf literal > '$HOME-not-expanded'; test ! -e injected-artifact", cwd: root });
  await eventually(() => metadata(a).outcome);
  assert.equal(await readFile(join(root, '$HOME-not-expanded'), 'utf8'), 'literal');
  await assert.rejects(readFile(join(root, 'injected-artifact')));
  const b = await current.start({ command: 'exec sleep 30', cwd: root });
  await writeFile(b.metadataPath, JSON.stringify(metadata(a)));
  assert.equal((await current.list()).tasks.find(task => task.taskId === b.taskId).error.action, 'list');
});
