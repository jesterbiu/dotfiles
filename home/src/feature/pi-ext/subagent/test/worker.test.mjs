import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from '../worker.mjs';
import { request } from '../protocol.mjs';

export class FakeSession {
  sessionId = randomUUID();
  sessionFile = '/fake/session.jsonl';
  calls = [];
  listeners = new Set();
  active = false;
  deferred = new Set();
  compacting = new Set();
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { for (const listener of this.listeners) listener(event); }
  async abort() { if (this.active) this.settle(); }
  async prompt(message, options) {
    if (message === 'reject') throw new Error('No credentials');
    if (message.startsWith('deferred') && !this.deferred.has(message)) {
      this.deferred.add(message);
      setTimeout(() => void this.prompt(message, options), 20);
      return;
    }
    if (message === 'compacting' && !this.compacting.has(message)) {
      this.compacting.add(message);
      throw new Error('Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.');
    }
    const disposition = this.active ? 'queued' : message === 'handled' ? 'handled' : 'started';
    this.calls.push({ message, mode: options.streamingBehavior, disposition });
    if (disposition !== 'handled') this.active = true;
    options.preflightResult(disposition);
    if (disposition !== 'started') return;
    await new Promise(resolve => { this.resolve = resolve; });
  }
  finish(text, stopReason = 'stop') {
    this.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason, usage: { input: 2, output: 3 }, errorMessage: stopReason === 'error' ? 'Provider failed' : undefined } });
    this.emit({ type: 'agent_end', messages: [] });
  }
  settle() {
    this.active = false;
    this.emit({ type: 'agent_settled' });
    this.resolve?.();
  }
}

export async function eventually(action) {
  for (let i = 0; i < 150; i++) {
    const value = await action();
    if (value) return value;
    await delay(20);
  }
  assert.fail('Condition did not become true');
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-sa-test-'));
  const session = new FakeSession();
  let disposed = 0;
  let exits = 0;
  const worker = new Worker({ dir, socketPath: join(dir, 'control.sock'), session, dispose: async () => { disposed++; }, exit: () => { exits++; } });
  await worker.start();
  t.after(async () => { await worker.close(); await rm(dir, { recursive: true, force: true }); });
  const send = (message, mode = 'steer', messageId = randomUUID()) => request(worker.socketPath, { action: 'send', message, mode, messageId });
  const state = async () => JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
  const result = async sequence => JSON.parse(await readFile(join(dir, 'results', `${String(sequence).padStart(6, '0')}.json`), 'utf8'));
  return { worker, dir, session, send, state, result, disposed: () => disposed, exits: () => exits };
}

test('persistent conversation accepts steering and follow-up, saves settled results, and reconnects', async t => {
  const { worker, dir, session, send, state, result: read, disposed } = await fixture(t);
  assert.equal((await stat(worker.socketPath)).mode & 0o777, 0o600);
  const initial = await send('Investigate');
  assert.equal(initial.disposition, 'started');
  assert.equal(initial.result, 1);
  const id = randomUUID();
  const steering = await send('Focus on tests\u2028not UI', 'steer', id);
  assert.equal(steering.disposition, 'queued');
  assert.equal(steering.result, 1);
  assert.deepEqual(await send('Focus on tests\u2028not UI', 'steer', id), steering);
  await assert.rejects(send('Different text', 'steer', id), /reused/);
  assert.equal((await send('Then check errors', 'followUp')).disposition, 'queued');
  assert.equal(session.calls.length, 3);
  session.finish('Intermediate answer');
  await delay(30);
  assert.equal((await state()).latestResult, null);
  session.finish('Final answer');
  session.settle();
  const settled = await eventually(async () => { const s = await state(); return s.latestResult && s; });
  assert.equal(settled.phase, 'idle');
  assert.equal(settled.sessionId, session.sessionId);
  const result = JSON.parse(await readFile(settled.latestResult.resultPath, 'utf8'));
  assert.equal(result.status, 'succeeded');
  assert.equal(result.messageIds.length, 3);
  assert.equal(await readFile(result.answerPath, 'utf8'), 'Final answer\n');
  assert.equal(result.usage.input, 4);
  const more = await send('More work', 'followUp');
  assert.equal(more.disposition, 'started');
  assert.equal(more.result, 2);
  session.finish('Second answer');
  session.settle();
  const second = await eventually(async () => { const s = await state(); return s.latestResult?.sequence === 2 && s; });
  assert.equal(second.sessionId, settled.sessionId);
  assert.equal((await read(2)).usage.input, 2);
  assert.equal(await readFile(result.answerPath, 'utf8'), 'Final answer\n');
  const deferredId = randomUUID();
  const [deferred] = await Promise.all([send('deferred work', 'steer', deferredId), (async () => { await delay(5); session.settle(); })()]);
  assert.equal(deferred.disposition, 'started');
  assert.equal(deferred.result, 4);
  assert.deepEqual((await read(3)).messageIds, []);
  session.finish('Deferred answer');
  session.settle();
  const fourth = await eventually(async () => { const s = await state(); return s.latestResult?.sequence === 4 && s; });
  assert.deepEqual((await read(4)).messageIds, [deferredId]);
  assert.equal(await readFile(fourth.latestResult.answerPath, 'utf8'), 'Deferred answer\n');
  await assert.rejects(readFile(join(dir, 'events.jsonl')), { code: 'ENOENT' });
  await worker.close();
  await worker.close();
  assert.equal(disposed(), 1);
  assert.equal((await state()).phase, 'terminated');
  await assert.rejects(send('Too late'), error => error.delivery === 'not_sent');
});

test('rejection, handled input, and agent errors do not create false success or reuse an old answer', async t => {
  const { session, send, state, result: read } = await fixture(t);
  await assert.rejects(send('reject'), /No credentials/);
  const compactingId = randomUUID();
  await assert.rejects(send('compacting', 'steer', compactingId), error => error.delivery === 'busy');
  const retried = await send('compacting', 'steer', compactingId);
  assert.equal(retried.disposition, 'started');
  assert.equal(retried.result, 1);
  session.settle();
  const compacted = await eventually(async () => { const s = await state(); return s.latestResult?.sequence === 1 && s; });
  assert.deepEqual((await read(1)).messageIds, [compactingId]);
  assert.equal(compacted.phase, 'idle');
  const handled = await send('handled');
  assert.equal(handled.disposition, 'handled');
  assert.equal(handled.result, undefined);
  assert.equal((await state()).phase, 'idle');
  session.settle();
  const untracked = await eventually(async () => { const s = await state(); return s.latestResult?.sequence === 2 && s; });
  assert.deepEqual((await read(2)).messageIds, []);
  assert.equal((await read(2)).status, 'failed');
  assert.equal(untracked.phase, 'idle');
  await send('First');
  session.finish('Partial', 'error');
  session.settle();
  const failed = await eventually(async () => { const s = await state(); return s.latestResult?.sequence === 3 && s; });
  const result = JSON.parse(await readFile(failed.latestResult.resultPath, 'utf8'));
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'Provider failed');
  await send('Second');
  session.settle();
  const missing = await eventually(async () => { const s = await state(); return s.latestResult?.sequence === 4 && s; });
  assert.equal(JSON.parse(await readFile(missing.latestResult.resultPath, 'utf8')).status, 'failed');
});

test('requests are ordered and validated, and stop aborts the run, writes the final result, and exits', async t => {
  const { worker, session, send, state, result: read, disposed, exits } = await fixture(t);
  const responses = await Promise.all([send('One'), send('Two'), send('Three', 'followUp')]);
  assert.deepEqual(responses.map(r => r.order).sort(), [1, 2, 3]);
  assert.equal(responses.filter(r => r.disposition === 'started').length, 1);
  assert.deepEqual(responses.map(r => r.result), [1, 1, 1]);
  await assert.rejects(send('Invalid', 'other'), /mode/);
  await assert.rejects(send(''), /message/);
  assert.equal(session.calls.length, 3);
  session.finish('Partial answer');
  assert.deepEqual(await request(worker.socketPath, { action: 'stop' }), { phase: 'stopping' });
  await assert.rejects(send('After stop'), /stopping|connect|closed|ENOENT/);
  const final = await eventually(async () => { const s = await state(); return s.phase === 'terminated' && s; });
  assert.equal(final.latestResult.sequence, 1);
  assert.equal((await read(1)).messageIds.length, 3);
  assert.equal(await readFile(final.latestResult.answerPath, 'utf8'), 'Partial answer\n');
  assert.equal(disposed(), 1);
  assert.equal(exits(), 1);
});
