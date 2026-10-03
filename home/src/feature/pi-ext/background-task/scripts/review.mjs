import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { TaskManager, Tmux } from '../manager.mjs';

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const root = await mkdtemp(join(tmpdir(), 'pi-background-review-'));
const tmux = new Tmux(`pi-review-${randomUUID()}`);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const absentServer = error => error?.code === 1 && /no server running|error connecting to .*No such file or directory/.test(error.stderr ?? '');
let completionSettled = false;
let resolveCompletion;
let rejectCompletion;
let interruption;
let cleanupPromise;
const completion = new Promise((resolve, reject) => {
  resolveCompletion = resolve;
  rejectCompletion = reject;
});
completion.catch(() => {});

const describe = error => error?.stack ?? error?.message ?? String(error);
const settleCompletion = (value, error) => {
  if (completionSettled) return false;
  completionSettled = true;
  if (error) rejectCompletion(error);
  else resolveCompletion(value);
  return true;
};
const report = (phase, error) => {
  try {
    console.error(JSON.stringify({ type: 'error', phase, message: describe(error) }));
  } catch {}
};
const diagnostic = error => {
  settleCompletion(null, error);
  report('diagnostic', error);
};
const manager = new TaskManager({
  owner: `review-${randomUUID()}`,
  root,
  tmux,
  onEvent: event => {
    try {
      console.log(JSON.stringify(event));
      if (event.type === 'completion') settleCompletion(event.task);
    } catch (error) {
      diagnostic(error);
    }
  },
  onError: diagnostic,
});

async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    const errors = [];
    try {
      const outcome = await manager.close();
      for (const error of outcome.errors) {
        errors.push(error);
        report('cleanup', error);
      }
    } catch (error) {
      errors.push(error);
      report('cleanup', error);
    }
    try {
      await manager.dispose();
    } catch (error) {
      errors.push(error);
      report('cleanup', error);
    }
    try {
      await tmux.run(['kill-server']);
    } catch (error) {
      if (!absentServer(error)) {
        errors.push(error);
        report('cleanup', error);
      }
    }
    return errors;
  })();
  return cleanupPromise;
}

const interrupt = signal => {
  if (interruption) return;
  interruption = new Error(`Interrupted by ${signal}`);
  interruption.signal = signal;
  settleCompletion(null, interruption);
  report('signal', interruption);
  void cleanup();
};

process.once('SIGINT', () => interrupt('SIGINT'));
process.once('SIGTERM', () => interrupt('SIGTERM'));

const prompt = 'Read background-task/background-task-tmux.md and background-task/. Review the design and implementation for important bugs and missing behavioral tests. Respect the accepted best-effort pane cancellation and durable per-task metadata. Do not edit files or run tests. Report concrete findings with file paths and line numbers, ordered by severity. If none, say so.';
let result;
let failure;
let cleanupErrors;
try {
  const command = `pi --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --session-dir ${quote(join(root, 'sessions'))} --print --model gpt-5.6-terra --tools read,grep,find,ls ${quote(prompt)}`;
  const task = await manager.start({
    command,
    cwd,
    timeoutSeconds: 600,
    statusReport: { afterSeconds: 60, repeat: true },
  });
  console.log(JSON.stringify({ type: 'started', task }));
  result = await completion;
  if (result.taskId !== task.taskId) throw new Error(`Unexpected completion: ${result.taskId}`);
  if (result.status !== 'succeeded') throw new Error(`Review task ${result.taskId} ${result.status}`);
} catch (error) {
  failure = error;
  report('review', error);
} finally {
  cleanupErrors = await cleanup();
}

if (!failure && cleanupErrors.length) failure = new Error('Review cleanup failed');
if (!failure) console.log(JSON.stringify({ type: 'result', task: result }));
process.exitCode = interruption ? (interruption.signal === 'SIGINT' ? 130 : 143) : failure ? 1 : 0;
