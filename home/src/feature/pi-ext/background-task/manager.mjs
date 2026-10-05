import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const encode = value => Buffer.from(value).toString('hex');
const noServer = error => error.code === 1 && /no server running|server exited unexpectedly|error connecting to .*No such file or directory/.test(error.stderr ?? '');
const missingSession = error => error.code === 1 && /can't find session:|can't find window:|no such session:|no current target/.test(error.stderr ?? '');
const taskIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const absent = pane => !pane || pane.unreachable;
const absence = pane => (pane ? 'tmux server unreachable' : 'tmux session missing');

const operationError = (action, taskId, cause, sideEffects = []) => {
  const error = new Error(`${action} failed for ${taskId ?? 'unknown'}: ${cause.message}`, { cause });
  error.action = action;
  error.taskId = taskId;
  error.sideEffects = sideEffects;
  return error;
};

const errorDetail = (error, action = 'unknown', taskId = null) => ({
  action: error.action ?? action,
  taskId: error.taskId ?? taskId,
  message: error.message,
  cause: error.cause?.message ?? error.message,
  sideEffects: error.sideEffects ?? [],
});

export class Tmux {
  constructor(server = 'pi-tasks', executable = 'tmux') {
    if (!/^[a-zA-Z0-9_-]+$/.test(server)) throw new Error('Invalid tmux server name');
    this.server = server;
    this.executable = executable;
  }

  async run(args) {
    const { stdout } = await exec(this.executable, ['-L', this.server, '-f', '/dev/null', ...args], {
      timeout: 3000,
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, TMUX: '' },
    });
    return stdout;
  }

  async inspect(tmuxSession) {
    let output;
    try {
      output = await this.run(['list-panes', '-t', `=${tmuxSession}`, '-F', '#{pane_dead}\t#{pane_dead_status}\t#{pane_dead_signal}']);
    } catch (error) {
      if (noServer(error)) return { unreachable: true };
      if (missingSession(error)) return null;
      throw error;
    }
    const [dead, code, signal] = output.trimEnd().split('\t');
    return { dead: dead === '1', exitCode: code === '' ? null : Number(code), exitSignal: signal || null };
  }

  async launch(task, command, cwd) {
    const gate = `launch-${task.taskId}`;
    const shell = `${quote(this.executable)} -L ${quote(this.server)} wait-for ${quote(gate)} && /bin/sh -c ${quote(command)} </dev/null >${quote(task.stdoutPath)} 2>${quote(task.stderrPath)}; result=$?; printf %s "$result" >${quote(`${task.exitPath}.tmp`)} && mv ${quote(`${task.exitPath}.tmp`)} ${quote(task.exitPath)}; exit "$result"`;
    try {
      await this.run(['set-option', '-s', 'exit-empty', 'off', ';', 'set-option', '-g', 'remain-on-exit', 'on', ';', 'new-session', '-d', '-s', task.tmuxSession, '-c', cwd, '/bin/sh', '-c', shell]);
      await this.run(['wait-for', '-S', gate]);
    } catch (error) {
      let cleanup;
      try {
        await this.remove(task);
      } catch (cause) {
        cleanup = cause;
      }
      if (cleanup) throw new AggregateError([error, cleanup], `Launch failed; cleanup unconfirmed for ${task.tmuxSession}: ${error.message}; ${cleanup.message}`);
      throw error;
    }
  }

  async remove(task) {
    try {
      await this.run(['kill-session', '-t', `=${task.tmuxSession}`]);
      return 'removed';
    } catch (error) {
      if (missingSession(error)) return 'missing';
      throw error;
    }
  }

  async owned(prefix) {
    let output;
    try {
      output = await this.run(['list-sessions', '-F', '#{session_name}']);
    } catch (error) {
      if (noServer(error)) return [];
      throw error;
    }
    return output.trimEnd().split('\n').filter(name => name.startsWith(prefix));
  }
}

export class TaskManager {
  constructor({ owner, root, tmux = new Tmux(), onEvent = () => {}, onError = () => {}, now = Date.now }) {
    if (!owner) throw new Error('Task owner is required');
    this.owner = owner;
    this.prefix = `pi-${encode(owner)}-`;
    this.root = resolve(root);
    this.ownerDir = join(this.root, encode(owner));
    this.tmux = tmux;
    this.onEvent = onEvent;
    this.onError = onError;
    this.now = now;
    this.accepting = true;
    this.silent = false;
    this.operations = new Map();
    this.accepted = new Set();
    this.armed = new Map();
  }

  taskDir(taskId) {
    if (!taskIdPattern.test(taskId)) throw new Error(`Invalid task ID: ${taskId}`);
    return join(this.ownerDir, taskId);
  }

  metadataPath(taskId) {
    return join(this.taskDir(taskId), 'metadata.json');
  }

  validate(record, expectedTaskId) {
    const taskId = record?.taskId;
    if (!taskIdPattern.test(taskId ?? '') || (expectedTaskId && taskId !== expectedTaskId) || record.owner !== this.owner || record.tmuxSession !== `${this.prefix}${taskId}`) throw new Error('Invalid task identity');
    const taskDir = this.taskDir(taskId);
    if (record.taskDir !== taskDir || record.metadataPath !== this.metadataPath(taskId) || record.stdoutPath !== join(taskDir, 'stdout.log') || record.stderrPath !== join(taskDir, 'stderr.log') || record.exitPath !== join(taskDir, 'exit')) throw new Error('Invalid task paths');
    if (record.notificationTarget !== undefined && record.notificationTarget !== 'subagent') throw new Error('Invalid notification target');
    if (typeof record.command !== 'string' || typeof record.cwd !== 'string' || !Number.isFinite(record.startedAt)) throw new Error('Invalid task launch record');
    if (record.deadline !== null && !Number.isFinite(record.deadline)) throw new Error('Invalid task deadline');
    if (record.reportIntervalMs !== null && (!Number.isFinite(record.reportIntervalMs) || record.reportIntervalMs <= 0)) throw new Error('Invalid task report interval');
    if (typeof record.repeatReport !== 'boolean' || (record.nextReportAt !== null && !Number.isFinite(record.nextReportAt))) throw new Error('Invalid task report schedule');
    if (record.reportIntervalMs === null && (record.nextReportAt !== null || record.repeatReport)) throw new Error('Invalid task report settings');
    if (!record.launch || !['created', 'started', 'failed'].includes(record.launch.status)) throw new Error('Invalid task launch state');
    if (record.outcome !== null && (!['succeeded', 'failed', 'cancelled', 'timed_out', 'unknown'].includes(record.outcome.status) || !Number.isFinite(record.outcome.endedAt) || (record.outcome.exitCode !== null && !Number.isFinite(record.outcome.exitCode)) || (record.outcome.exitSignal !== null && typeof record.outcome.exitSignal !== 'string'))) throw new Error('Invalid task outcome');
    return record;
  }

  track(promise) {
    this.accepted.add(promise);
    promise.finally(() => this.accepted.delete(promise)).catch(() => {});
    return promise;
  }

  withTask(taskId, action) {
    const previous = this.operations.get(taskId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(action);
    this.operations.set(taskId, result);
    result.finally(() => {
      if (this.operations.get(taskId) === result) this.operations.delete(taskId);
    }).catch(() => {});
    return this.track(result);
  }

  async settleAccepted() {
    while (this.accepted.size) await Promise.allSettled([...this.accepted]);
  }

  async readMetadata(taskId) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(this.metadataPath(taskId), 'utf8'));
    } catch (cause) {
      throw operationError('read', taskId, cause);
    }
    try {
      return this.validate(parsed, taskId);
    } catch (cause) {
      throw operationError('read', taskId, cause);
    }
  }

  async writeMetadata(record) {
    const valid = this.validate(record);
    const path = valid.metadataPath;
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(valid)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    } catch (cause) {
      let cleanup;
      try {
        await rm(temporary, { force: true });
      } catch (error) {
        cleanup = error;
      }
      if (cleanup) throw new AggregateError([cause, cleanup], `Metadata write failed: ${cause.message}; temporary cleanup failed: ${cleanup.message}`);
      throw cause;
    }
  }

  async taskIds() {
    try {
      const entries = await readdir(this.ownerDir, { withFileTypes: true });
      return entries.filter(entry => entry.isDirectory() && taskIdPattern.test(entry.name)).map(entry => entry.name);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  reportError(error) {
    try {
      const result = this.onError(error);
      Promise.resolve(result).catch(() => {});
    } catch {}
  }

  notify(type, task) {
    if (this.silent) return;
    try {
      Promise.resolve(this.onEvent({ type, task: { ...task }, elapsedSeconds: Math.max(0, (this.now() - task.startedAt) / 1000) })).catch(cause => this.reportError(operationError('notify', task.taskId, cause)));
    } catch (cause) {
      this.reportError(operationError('notify', task.taskId, cause));
    }
  }

  publicTask(record, status = record.outcome?.status ?? 'running') {
    const outcome = record.outcome;
    return {
      taskId: record.taskId,
      owner: record.owner,
      metadataPath: record.metadataPath,
      stdoutPath: record.stdoutPath,
      stderrPath: record.stderrPath,
      exitPath: record.exitPath,
      startedAt: record.startedAt,
      status,
      endedAt: outcome?.endedAt,
      exitCode: outcome?.exitCode ?? null,
      exitSignal: outcome?.exitSignal ?? null,
      reason: outcome?.reason,
      notificationTarget: record.notificationTarget,
      deadline: record.deadline,
      statusReport: record.reportIntervalMs === null ? undefined : { afterSeconds: record.reportIntervalMs / 1000, repeat: record.repeatReport },
    };
  }

  async persistOutcome(record, outcome, action, sideEffects = []) {
    const next = { ...record, outcome };
    try {
      await this.writeMetadata(next);
    } catch (cause) {
      throw operationError(action, record.taskId, cause, sideEffects);
    }
    this.disarm(record.taskId);
    return next;
  }

  async readExit(record) {
    let text;
    try {
      text = await readFile(record.exitPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const code = Number(text.trim());
    return Number.isInteger(code) ? code : null;
  }

  schedule(at, callback) {
    const timer = setTimeout(callback, Math.max(0, at - this.now()));
    timer.unref();
    return timer;
  }

  arm(record) {
    if (this.disposed) return;
    const taskId = record.taskId;
    const entry = this.armed.get(taskId) ?? {};
    if (!entry.watcher) {
      entry.watcher = watch(record.taskDir, (_event, filename) => { if (filename === 'exit') this.react(taskId, 'observe'); });
      entry.watcher.on('error', error => this.reportError(operationError('observe', taskId, error)));
    }
    if (record.deadline !== null && !entry.deadline) entry.deadline = this.schedule(record.deadline, () => this.react(taskId, 'expire'));
    if (record.nextReportAt !== null) {
      clearTimeout(entry.report);
      entry.report = this.schedule(record.nextReportAt, () => this.react(taskId, 'report'));
    }
    this.armed.set(taskId, entry);
  }

  disarm(taskId) {
    const entry = this.armed.get(taskId);
    if (!entry) return;
    entry.watcher?.close();
    clearTimeout(entry.deadline);
    clearTimeout(entry.report);
    this.armed.delete(taskId);
  }

  react(taskId, kind) {
    if (this.disposed) return;
    void this.withTask(taskId, async () => this.handle(await this.readMetadata(taskId), kind)).catch(error => this.reportError(error));
  }

  async removeCompleted(record, action) {
    try {
      await this.tmux.remove(record);
    } catch (cause) {
      const error = operationError(action, record.taskId, cause, ['terminal outcome recorded', `tmux session ${record.tmuxSession} cleanup unconfirmed`]);
      try {
        await this.writeMetadata({ ...record, operationErrors: [...record.operationErrors, errorDetail(error)] });
      } catch (persistence) {
        throw operationError(action, record.taskId, new AggregateError([cause, persistence], `${cause.message}; cleanup error persistence failed: ${persistence.message}`), error.sideEffects);
      }
      throw error;
    }
  }

  async finishNatural(record, pane, action = 'observe') {
    const status = pane.exitSignal || pane.exitCode !== 0 ? 'failed' : 'succeeded';
    const completed = await this.persistOutcome(record, { status, endedAt: this.now(), exitCode: pane.exitCode, exitSignal: pane.exitSignal }, action);
    try {
      await this.removeCompleted(completed, action);
    } finally {
      this.notify('completion', this.publicTask(completed));
    }
    return this.publicTask(completed);
  }

  async settle(record, action) {
    let code;
    let pane;
    try {
      code = await this.readExit(record);
      if (code === null) pane = await this.tmux.inspect(record.tmuxSession);
    } catch (cause) {
      throw operationError(action, record.taskId, cause);
    }
    if (code !== null) return this.finishNatural(record, { exitCode: code, exitSignal: null }, action);
    if (absent(pane)) {
      const completed = await this.persistOutcome(record, { status: 'unknown', endedAt: this.now(), exitCode: null, exitSignal: null, reason: absence(pane) }, action, [absence(pane)]);
      if (action !== 'cancel' || record.notificationTarget === 'subagent') this.notify('completion', this.publicTask(completed));
      return this.publicTask(completed);
    }
    if (pane.dead) return this.finishNatural(record, pane, action);
    return null;
  }

  async handle(record, kind) {
    if (record.outcome) {
      this.disarm(record.taskId);
      return this.publicTask(record);
    }
    const done = await this.settle(record, 'observe');
    if (done) return done;
    if (kind === 'expire') {
      let removed;
      try {
        removed = await this.tmux.remove(record);
      } catch (cause) {
        throw operationError('observe', record.taskId, cause);
      }
      const status = removed === 'removed' ? 'timed_out' : 'unknown';
      const reason = removed === 'removed' ? undefined : 'tmux session missing after inspection';
      const completed = await this.persistOutcome(record, { status, endedAt: this.now(), exitCode: null, exitSignal: null, reason }, 'observe', removed === 'removed' ? ['tmux session removed'] : [reason]);
      this.notify('completion', this.publicTask(completed));
      return this.publicTask(completed);
    }
    if (kind === 'report') {
      const next = { ...record, nextReportAt: record.repeatReport ? this.now() + record.reportIntervalMs : null };
      try {
        await this.writeMetadata(next);
      } catch (cause) {
        throw operationError('observe', record.taskId, cause);
      }
      this.arm(next);
      this.notify('status', this.publicTask(next));
      return this.publicTask(next);
    }
    return this.publicTask(record);
  }

  async observeRecord(record) {
    if (record.outcome) {
      this.disarm(record.taskId);
      return this.publicTask(record);
    }
    this.arm(record);
    return (await this.settle(record, 'observe')) ?? this.publicTask(record);
  }

  observe(taskId) {
    if (taskId === undefined) return this.track(this.observeAll());
    return this.withTask(taskId, async () => {
      try {
        return await this.observeRecord(await this.readMetadata(taskId));
      } catch (cause) {
        if (cause.action === 'observe') throw cause;
        throw operationError('observe', taskId, cause);
      }
    });
  }

  async observeAll() {
    let ids;
    try {
      ids = await this.taskIds();
    } catch (cause) {
      throw operationError('observe', null, cause);
    }
    const settled = await Promise.allSettled(ids.map(taskId => this.observe(taskId)));
    const tasks = [];
    for (const result of settled) {
      if (result.status === 'fulfilled') tasks.push(result.value);
      else this.reportError(result.reason);
    }
    return tasks;
  }

  async snapshot() {
    const tasks = await Promise.all((await this.taskIds()).map(async taskId => {
      try {
        return await this.withTask(taskId, async () => this.publicTask(await this.readMetadata(taskId)));
      } catch (cause) {
        this.reportError(operationError('snapshot', taskId, cause));
        return undefined;
      }
    }));
    return tasks.filter(task => task !== undefined);
  }

  async list() {
    let ids;
    try {
      ids = await this.taskIds();
    } catch (cause) {
      return { tasks: [], errors: [errorDetail(operationError('list', null, cause))] };
    }
    const tasks = await Promise.all(ids.map(async taskId => {
      try {
        return await this.withTask(taskId, async () => {
          const record = await this.readMetadata(taskId);
          if (record.outcome) return this.publicTask(record);
          const pane = await this.tmux.inspect(record.tmuxSession);
          if (absent(pane)) return this.publicTask(record, 'unknown');
          return this.publicTask(record, pane.dead ? (pane.exitSignal || pane.exitCode !== 0 ? 'failed' : 'succeeded') : 'running');
        });
      } catch (cause) {
        return { taskId, metadataPath: this.metadataPath(taskId), error: errorDetail(operationError('list', taskId, cause)) };
      }
    }));
    return { tasks, errors: [] };
  }

  start(options) {
    if (!this.accepting) return Promise.reject(operationError('start', null, new Error('Task manager is closed')));
    const taskId = randomUUID();
    return this.withTask(taskId, () => this.startTask(taskId, options));
  }

  async startTask(taskId, { command, cwd, timeoutSeconds, statusReport, notificationTarget }) {
    if (notificationTarget !== undefined && notificationTarget !== 'subagent') throw operationError('start', taskId, new Error('Invalid notification target'));
    if (typeof command !== 'string' || !command.trim()) throw operationError('start', taskId, new Error('Command is required'));
    for (const value of [timeoutSeconds, statusReport?.afterSeconds]) if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw operationError('start', taskId, new Error('Intervals must be positive finite numbers'));
    if (statusReport && statusReport.afterSeconds === undefined) throw operationError('start', taskId, new Error('Report interval is required'));
    const resolvedCwd = resolve(cwd);
    try {
      if (!(await stat(resolvedCwd)).isDirectory()) throw new Error('Working directory must be a directory');
    } catch (cause) {
      throw operationError('start', taskId, cause);
    }
    const taskDir = this.taskDir(taskId);
    try {
      await mkdir(taskDir, { recursive: true, mode: 0o700 });
      for (const path of [join(taskDir, 'stdout.log'), join(taskDir, 'stderr.log')]) {
        const file = await open(path, 'wx', 0o600);
        await file.close();
      }
    } catch (cause) {
      let cleanup;
      try { await rm(taskDir, { recursive: true, force: true }); } catch (error) { cleanup = error; }
      if (cleanup) throw operationError('start', taskId, new AggregateError([cause, cleanup], `${cause.message}; task cleanup failed: ${cleanup.message}`), ['task-local cleanup failed']);
      throw operationError('start', taskId, cause, ['task-local cleanup attempted']);
    }
    const startedAt = this.now();
    let record = {
      taskId, owner: this.owner, tmuxSession: `${this.prefix}${taskId}`, taskDir, metadataPath: this.metadataPath(taskId), stdoutPath: join(taskDir, 'stdout.log'), stderrPath: join(taskDir, 'stderr.log'), exitPath: join(taskDir, 'exit'), command, cwd: resolvedCwd, startedAt,
      deadline: timeoutSeconds === undefined ? null : startedAt + timeoutSeconds * 1000,
      reportIntervalMs: statusReport ? statusReport.afterSeconds * 1000 : null,
      repeatReport: statusReport?.repeat === true,
      nextReportAt: statusReport ? startedAt + statusReport.afterSeconds * 1000 : null,
      launch: { status: 'created', createdAt: startedAt }, outcome: null, operationErrors: [], notificationTarget,
    };
    try {
      await this.writeMetadata(record);
      this.arm(record);
    } catch (cause) {
      this.disarm(taskId);
      let cleanup;
      try { await rm(taskDir, { recursive: true, force: true }); } catch (error) { cleanup = error; }
      const primary = operationError('start', taskId, cause, ['task-local cleanup attempted']);
      if (!cleanup) throw primary;
      const aggregate = new AggregateError([primary, operationError('start', taskId, cleanup, ['task-local cleanup failed'])], `start failed for ${taskId}: ${cause.message}; task cleanup failed: ${cleanup.message}`);
      aggregate.action = 'start';
      aggregate.taskId = taskId;
      aggregate.sideEffects = ['task-local cleanup failed'];
      throw aggregate;
    }
    try {
      await this.tmux.launch(record, command, resolvedCwd);
      record = { ...record, launch: { status: 'started', createdAt: startedAt, startedAt: this.now() } };
      await this.writeMetadata(record);
    } catch (cause) {
      this.disarm(taskId);
      const sideEffects = ['metadata created', 'gate release may be ambiguous'];
      const failures = [cause];
      try {
        const removed = await this.tmux.remove(record);
        sideEffects.push(removed === 'removed' ? 'tmux session removed' : 'tmux session missing');
      } catch (cleanup) {
        failures.push(cleanup);
        sideEffects.push(`tmux session ${record.tmuxSession} cleanup unconfirmed`);
      }
      const failed = { ...record, launch: { status: 'failed', createdAt: startedAt, failedAt: this.now(), error: cause.message }, outcome: { status: 'unknown', endedAt: this.now(), exitCode: null, exitSignal: null } };
      try {
        await this.writeMetadata(failed);
        sideEffects.push('failed launch recorded');
      } catch (persistence) {
        failures.push(persistence);
        sideEffects.push('failed launch persistence failed');
      }
      const primary = operationError('start', taskId, cause, sideEffects);
      if (failures.length === 1) throw primary;
      const aggregate = new AggregateError([primary, ...failures.slice(1)], `start failed for ${taskId}: ${failures.map(error => error.message).join('; ')}`);
      aggregate.action = 'start';
      aggregate.taskId = taskId;
      aggregate.sideEffects = sideEffects;
      throw aggregate;
    }
    return this.publicTask(record);
  }

  async cancelTask(taskId, tmuxSession) {
    let record;
    try {
      record = await this.readMetadata(taskId);
    } catch (cause) {
      if (!tmuxSession) throw operationError('cancel', taskId, cause);
      try {
        const removed = await this.tmux.remove({ tmuxSession });
        throw operationError('cancel', taskId, cause, [removed === 'removed' ? 'tmux session removed' : 'tmux session missing', `tmux session ${tmuxSession}`]);
      } catch (error) {
        if (error.action === 'cancel') throw error;
        throw operationError('cancel', taskId, error, [`tmux session ${tmuxSession} cleanup unconfirmed`]);
      }
    }
    if (record.outcome) {
      let pane;
      try {
        pane = await this.tmux.inspect(record.tmuxSession);
      } catch (cause) {
        throw operationError('cancel', taskId, cause);
      }
      if (!absent(pane)) await this.removeCompleted(record, 'cancel');
      return this.publicTask(record);
    }
    const done = await this.settle(record, 'cancel');
    if (done) return done;
    let removed;
    try {
      removed = await this.tmux.remove(record);
    } catch (cause) {
      throw operationError('cancel', taskId, cause);
    }
    const status = removed === 'removed' ? 'cancelled' : 'unknown';
    const reason = removed === 'removed' ? undefined : 'tmux session missing after inspection';
    const completed = await this.persistOutcome(record, { status, endedAt: this.now(), exitCode: null, exitSignal: null, reason }, 'cancel', removed === 'removed' ? ['tmux session removed'] : [reason]);
    this.notify('completion', this.publicTask(completed));
    return this.publicTask(completed);
  }

  cancel(taskId) {
    return this.withTask(taskId, () => this.cancelTask(taskId));
  }

  cancelAll() {
    return this.track(this.cancelAllInternal());
  }

  async cancelAllInternal() {
    const [stored, owned] = await Promise.allSettled([this.taskIds(), this.tmux.owned(this.prefix)]);
    const errors = [];
    if (stored.status === 'rejected') errors.push(errorDetail(operationError('cancelAll', null, stored.reason)));
    if (owned.status === 'rejected') errors.push(errorDetail(operationError('cancelAll', null, owned.reason)));
    const resources = new Map();
    if (owned.status === 'fulfilled') for (const tmuxSession of owned.value) {
      const taskId = tmuxSession.slice(this.prefix.length);
      if (taskIdPattern.test(taskId)) resources.set(taskId, tmuxSession);
    }
    const ids = new Set([...(stored.status === 'fulfilled' ? stored.value : []), ...resources.keys()]);
    const settled = await Promise.allSettled([...ids].map(taskId => this.withTask(taskId, () => this.cancelTask(taskId, resources.get(taskId)))));
    const results = [];
    for (const result of settled) {
      if (result.status === 'fulfilled') results.push(result.value);
      else errors.push(errorDetail(result.reason, 'cancel', null));
    }
    return { results, errors };
  }

  async close() {
    this.accepting = false;
    this.silent = true;
    await this.settleAccepted();
    return this.cancelAll();
  }

  async dispose() {
    this.disposed = true;
    this.accepting = false;
    this.silent = true;
    for (const taskId of [...this.armed.keys()]) this.disarm(taskId);
    await this.settleAccepted();
  }
}
