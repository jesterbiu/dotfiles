import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from '../worker.mjs';
import { request } from '../protocol.mjs';

class FakeSession {
  sessionId = randomUUID();
  sessionFile = '/fake/session.jsonl';
  calls = [];
  listeners = new Set();
  active = false;
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { for (const listener of this.listeners) listener(event); }
  async abort() { if (this.active) this.settle(); }
  async prompt(message, options) {
    if (message === 'reject') throw new Error('No credentials');
    this.calls.push(message);
    this.active = true;
    options.preflightResult('started');
    await new Promise(resolve => { this.resolve = resolve; });
  }
  async steer(message) {
    if (message === 'racing') { this.settle(); await delay(5); }
    this.calls.push(message);
    return 'queued';
  }
  finish(text, stopReason = 'stop') {
    this.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason, usage: { input: 2, output: 3 }, errorMessage: stopReason === 'error' ? 'fetch failed https://user:secret@host/token?key=secret' : undefined } });
    this.emit({ type: 'agent_end', messages: [] });
  }
  settle() {
    this.active = false;
    this.emit({ type: 'agent_settled' });
    this.resolve?.();
  }
}

async function eventually(action) {
  for (let i = 0; i < 150; i++) {
    const value = await action();
    if (value) return value;
    await delay(20);
  }
  assert.fail('Condition did not become true');
}

async function fixture(t, initial = 'Investigate') {
  const dir = await mkdtemp(join(tmpdir(), 'pi-sa-test-'));
  const session = new FakeSession();
  let disposed = 0;
  let exits = 0;
  const worker = new Worker({ dir, socketPath: join(dir, 'control.sock'), session, dispose: async () => { disposed++; }, exit: () => { exits++; } });
  t.after(async () => { await worker.close(); await rm(dir, { recursive: true, force: true }); });
  await worker.start({ action: 'send', message: initial, messageId: randomUUID() });
  const send = (message, messageId = randomUUID(), extra = {}) => request(worker.socketPath, { action: 'send', message, messageId, ...extra });
  const state = async () => JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
  const result = async () => JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'));
  return { worker, dir, session, send, state, result, disposed: () => disposed, exits: () => exits };
}

test('one task accepts steering, publishes one structured answer, and exits without admitting new work', async t => {
  const { worker, dir, session, send, state, result, disposed, exits } = await fixture(t);
  assert.equal((await stat(worker.socketPath)).mode & 0o777, 0o600);
  const id = randomUUID();
  const ack = await send('Focus on tests\u2028not UI', id);
  assert.deepEqual(ack, { messageId: id, disposition: 'queued' });
  assert.deepEqual(await send('Focus on tests\u2028not UI', id), ack);
  await assert.rejects(send('Different', id), /reused/);
  await assert.rejects(send('Follow up', randomUUID(), { mode: 'followUp' }), /steer|mode/);
  assert.equal(session.calls.length, 2);
  session.finish('Intermediate');
  await delay(20);
  await assert.rejects(result(), { code: 'ENOENT' });
  session.finish('Final answer');
  session.settle();
  await assert.rejects(Promise.resolve().then(() => worker.send({ message: 'Late', messageId: randomUUID() })), /settled|stopping/);
  await eventually(async () => (await state()).phase === 'terminated' && exits() === 1);
  assert.deepEqual(await result(), { status: 'succeeded', answer: 'Final answer' });
  assert.equal((await state()).usage.input, 4);
  assert.equal((await state()).messageIds.length, 2);
  assert.equal((await stat(join(dir, 'result.json'))).mode & 0o777, 0o600);
  assert.equal((await readdir(dir)).includes('results'), false);
  assert.equal((await readdir(dir)).includes('events.jsonl'), false);
  session.settle();
  await worker.close();
  assert.deepEqual(await result(), { status: 'succeeded', answer: 'Final answer' });
  assert.equal(disposed(), 1);
  await assert.rejects(send('Too late'), error => error.delivery === 'not_sent');
});

test('failure retains partial answer and sanitized evidence; initial rejection still produces a result', async t => {
  const first = await fixture(t);
  first.session.finish('Useful partial answer');
  first.session.finish('', 'error');
  first.session.settle();
  await eventually(async () => (await first.state()).phase === 'terminated');
  const result = await first.result();
  assert.equal(result.status, 'failed');
  assert.equal(result.answer, 'Useful partial answer');
  assert.equal(result.reportedError.source, 'sdk');
  assert.match(result.reportedError.message, /fetch failed/);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  const rejected = await fixture(t, 'reject');
  await eventually(async () => (await rejected.state()).phase === 'terminated');
  assert.equal((await rejected.result()).status, 'failed');
  assert.match((await rejected.result()).reportedError.message, /No credentials/);
  assert.equal((await rejected.result()).answer, undefined);
});

test('stop preserves partial output as failure; racing steering cannot start another prompt', async t => {
  const stopped = await fixture(t);
  stopped.session.finish('Partial answer');
  assert.deepEqual(await request(stopped.worker.socketPath, { action: 'stop' }), { phase: 'stopping' });
  await eventually(async () => (await stopped.state()).phase === 'terminated' && stopped.exits() === 1);
  assert.equal((await stopped.result()).status, 'failed');
  assert.equal((await stopped.result()).answer, 'Partial answer');
  assert.equal(stopped.disposed(), 1);
  const racing = await fixture(t);
  await assert.rejects(racing.send('racing'), /settled|stopping|closed/);
  await eventually(async () => (await racing.state()).phase === 'terminated');
  assert.deepEqual(racing.session.calls, ['Investigate', 'racing']);
  assert.equal((await racing.result()).status, 'failed');
});
