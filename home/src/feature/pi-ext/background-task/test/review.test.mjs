import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { test } from 'node:test';

const review = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/review.mjs');
const exec = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-background-review-test-'));
  const bin = join(root, 'bin');
  const agentDir = join(root, 'configured-agent');
  const tmuxDir = join(root, 'tmux');
  const capture = join(root, 'pi.json');
  const children = [];
  await Promise.all([mkdir(bin), mkdir(agentDir), mkdir(tmuxDir)]);
  await writeFile(join(bin, 'pi'), `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
await writeFile(process.env.FAKE_PI_CAPTURE, JSON.stringify({ args: process.argv.slice(2), agentDir: process.env.PI_CODING_AGENT_DIR }));
if (process.env.FAKE_PI_MODE === 'hold') {
  process.stdout.write('fake pi started\\n');
  setInterval(() => {}, 1000);
} else {
  await delay(75);
  process.stdout.write('review output\\n');
}
`);
  await chmod(join(bin, 'pi'), 0o755);
  t.after(async () => {
    const running = children.filter(({ child }) => child.exitCode === null && child.signalCode === null);
    for (const { child } of running) child.kill('SIGKILL');
    await Promise.all(running.map(({ closed }) => closed.catch(() => {})));
    await stopServers(tmuxDir);
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    agentDir,
    capture,
    tmuxDir,
    launch(mode) {
      const child = spawn(process.execPath, [review], {
        cwd: resolve(dirname(review), '../..'),
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          PI_CODING_AGENT_DIR: agentDir,
          TMUX_TMPDIR: tmuxDir,
          FAKE_PI_CAPTURE: capture,
          FAKE_PI_MODE: mode,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const closed = once(child, 'close');
      children.push({ child, closed });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      return { child, get stdout() { return stdout; }, get stderr() { return stderr; }, closed };
    },
  };
}

async function eventually(action, message) {
  for (let attempt = 0; attempt < 160; attempt++) {
    const value = await action();
    if (value) return value;
    await delay(25);
  }
  assert.fail(message);
}

function events(stdout) {
  return stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function closeWithin(run, milliseconds = 5000) {
  const controller = new AbortController();
  try {
    return await Promise.race([
      run.closed,
      delay(milliseconds, undefined, { signal: controller.signal }).then(() => {
        run.child.kill('SIGKILL');
        throw new Error(`Runner did not exit within ${milliseconds}ms`);
      }),
    ]);
  } finally {
    controller.abort();
  }
}

async function sockets(path) {
  const found = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const next = join(current, entry.name);
      if (entry.isDirectory()) await visit(next);
      if (entry.isSocket()) found.push(next);
    }
  }
  await visit(path);
  return found;
}

async function serversStopped(path) {
  const active = await Promise.all((await sockets(path)).map(socket => exec('tmux', ['-S', socket, 'list-sessions']).then(() => true, () => false)));
  return active.every(value => !value);
}

async function stopServers(path) {
  await Promise.all((await sockets(path)).map(socket => exec('tmux', ['-S', socket, 'kill-server']).catch(() => {})));
}

test('review runner retains configured agent data, isolates sessions, and exits after durable completion', { timeout: 10000 }, async t => {
  const current = await fixture(t);
  const run = current.launch('complete');
  const started = await eventually(() => events(run.stdout).find(event => event.type === 'started'), 'runner did not start a task');
  assert.equal(run.child.exitCode, null);
  const [code, signal] = await closeWithin(run);
  assert.equal(code, 0);
  assert.equal(signal, null);
  const result = events(run.stdout).find(event => event.type === 'result');
  assert.ok(result);
  assert.equal(result.task.status, 'succeeded');
  const record = JSON.parse(await readFile(result.task.metadataPath, 'utf8'));
  assert.equal(record.outcome.status, 'succeeded');
  assert.equal(await readFile(result.task.stdoutPath, 'utf8'), 'review output\n');
  const invocation = JSON.parse(await readFile(current.capture, 'utf8'));
  assert.equal(invocation.agentDir, current.agentDir);
  assert.equal(invocation.args.includes('--no-session'), false);
  assert.equal(invocation.args[invocation.args.indexOf('--session-dir') + 1], join(dirname(dirname(dirname(result.task.metadataPath))), 'sessions'));
  assert.equal(invocation.args[invocation.args.indexOf('--model') + 1], 'gpt-5.6-terra');
  assert.equal(invocation.args[invocation.args.indexOf('--tools') + 1], 'read,grep,find,ls');
  assert.equal(started.task.taskId, result.task.taskId);
  await eventually(() => serversStopped(current.tmuxDir), 'runner tmux server was not removed');
});

test('review runner settles on SIGTERM and removes only its isolated tmux task', { timeout: 10000 }, async t => {
  const current = await fixture(t);
  const run = current.launch('hold');
  const started = await eventually(() => events(run.stdout).find(event => event.type === 'started'), 'runner did not start a task');
  assert.equal(run.child.kill('SIGTERM'), true);
  const [code, signal] = await closeWithin(run);
  assert.equal(code, 143);
  assert.equal(signal, null);
  const record = JSON.parse(await readFile(started.task.metadataPath, 'utf8'));
  assert.equal(record.outcome.status, 'cancelled');
  await eventually(() => serversStopped(current.tmuxDir), 'runner tmux server was not removed');
  assert.match(run.stderr, /SIGTERM/);
});
