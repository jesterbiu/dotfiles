import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactError, compactResponse, compactTask, errorText } from '../output.mjs';

test('tool and notice payloads retain recovery fields without internal metadata or empty errors', () => {
  const task = { taskId: 'task', status: 'failed', exitCode: 1, metadataPath: '/tasks/task/metadata.json', owner: 'private', command: 'private', notificationTarget: 'subagent', deadline: 1000, statusReport: { afterSeconds: 10 }, reason: 'failed https://user:secret@host/path' };
  const compact = compactTask(task);
  assert.deepEqual(compact, { taskId: 'task', process: 'failed', artifacts: '/tasks/task', exitCode: 1, deadline: '1970-01-01T00:00:01.000Z', statusReport: { afterSeconds: 10 }, reason: 'failed [redacted URL]' });
  assert.deepEqual(compactResponse({ tasks: [task], errors: [] }), { tasks: [compact] });
  assert.deepEqual(compactResponse({ results: [task], errors: [{ action: 'cancel', taskId: 'task', message: 'password=secret', sideEffects: [] }] }), { results: [compact], errors: [{ action: 'cancel', taskId: 'task', error: 'password=[redacted]' }] });
  assert.deepEqual(compactError({ message: 'Timed out', messageId: 'message', delivery: 'unknown', artifactDir: '/child' }), { error: 'Timed out', messageId: 'message', delivery: 'unknown', artifacts: '/child' });
  assert.equal(errorText('Bearer secret\napi_key=abc\u001b').includes('secret'), false);
  assert.equal(errorText('x'.repeat(500)).length, 300);
  assert.deepEqual(compactTask({ taskId: 'broken', metadataPath: '/tasks/broken/metadata.json', error: { cause: 'Bad JSON' } }), { taskId: 'broken', process: 'unknown', artifacts: '/tasks/broken', error: 'Bad JSON' });
  assert.deepEqual(compactError({ error: 'Bad record', artifacts: '/tasks/broken' }), { error: 'Bad record', artifacts: '/tasks/broken' });
});
