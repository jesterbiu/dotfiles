import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveTasks } from '../tasks.mjs';

test('live snapshots merge task evidence, remove termination immediately, and reject stale resurrection', () => {
  const tasks = new LiveTasks();
  const live = { taskId: 'a', process: 'running', topic: 'Task', model: 'model', thinkingLevel: 'high', startedAt: 1 };
  assert.equal(tasks.update(live), true);
  assert.equal(tasks.update(live), false);
  assert.equal(tasks.update({ taskId: 'a', thinkingLevel: 'off' }), true);
  assert.deepEqual(tasks.values(), [{ ...live, thinkingLevel: 'off' }]);
  const snapshot = tasks.values();
  snapshot[0].topic = 'Modified';
  snapshot.push({ taskId: 'b' });
  assert.equal(tasks.values().length, 1);
  assert.equal(tasks.values()[0].topic, 'Task');
  assert.equal(tasks.update({ taskId: 'a', process: 'failed' }), true);
  assert.deepEqual(tasks.values(), []);
  assert.equal(tasks.update(live), false);
  for (const [index, outcome] of [
    { process: 'succeeded' }, { process: 'failed' }, { process: 'cancelled' },
    { process: 'timed_out' }, { process: 'unknown' }, { phase: 'terminated' },
    { endedAt: 1 }, { observedAt: 1 },
  ].entries()) {
    const taskId = `terminal-${index}`;
    tasks.update({ taskId, ...outcome });
    assert.equal(tasks.update({ ...live, taskId }), false);
  }
  tasks.update({ taskId: 'completion' }, true);
  assert.equal(tasks.update({ ...live, taskId: 'completion' }), false);
  assert.deepEqual(tasks.values(), []);
  assert.deepEqual(new LiveTasks().values(), []);
});
