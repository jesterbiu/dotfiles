import { createHash, randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { atomicJson, privateDirectory, readJson, uuidPattern } from './storage.mjs';
import { request } from './protocol.mjs';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const detail = error => ({ error: error.message, taskId: error.taskId, artifactDir: error.artifactDir, messageId: error.messageId, delivery: error.delivery, cleanupError: error.cleanupError, admission: error.admission });

export class Controller {
  constructor({ root, owner, workerPath, sdkPath, agentDir, nodePath = process.execPath, onResult = () => {}, onError = error => console.error(error) }) {
    Object.assign(this, { owner, workerPath, sdkPath, agentDir, nodePath, onResult, onError });
    this.ownerDir = join(resolve(root), createHash('sha256').update(owner).digest('hex'));
    this.watchers = new Map();
    this.pending = new Set();
    this.accepting = true;
  }

  async init() {
    await privateDirectory(this.ownerDir);
    const { records, errors } = await this.records();
    for (const error of errors) this.onError(new Error(error.error));
    for (const record of records) {
      try { await this.observe(record.dir, true); }
      catch (error) { this.onError(error); }
    }
  }

  async records() {
    const records = [];
    const errors = [];
    for (const entry of await readdir(this.ownerDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !uuidPattern.test(entry.name)) continue;
      const dir = join(this.ownerDir, entry.name);
      try {
        const manifest = await readJson(join(dir, 'manifest.json'));
        if (manifest.owner !== this.owner || manifest.launchId !== entry.name || manifest.dir !== dir) throw new Error('Invalid subagent ownership record');
        let binding;
        try { binding = await readJson(join(dir, 'binding.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (binding && (!uuidPattern.test(binding.taskId ?? '') || binding.owner !== this.owner)) throw new Error('Invalid subagent task binding');
        records.push({ dir, manifest, binding });
      } catch (error) {
        errors.push({ artifactDir: dir, error: error.message });
      }
    }
    return { records, errors };
  }

  async find(taskId) {
    if (!uuidPattern.test(taskId ?? '')) throw new Error('taskId must be a UUID');
    const { records } = await this.records();
    const record = records.find(item => item.binding?.taskId === taskId);
    if (!record) throw new Error(`Subagent ${taskId} is not owned by this session`);
    return record;
  }

  async state(dir) {
    try { return await readJson(join(dir, 'state.json')); } catch (error) {
      if (error.code === 'ENOENT') return { phase: 'starting', latestResult: null };
      throw error;
    }
  }

  async observe(dir, existing = false) {
    if (!this.accepting || this.watchers.has(dir)) return;
    const initial = existing ? await this.state(dir) : { latestResult: null };
    if (!this.accepting || initial.phase === 'terminated') return;
    let sequence = initial.latestResult?.sequence ?? 0;
    let queue = Promise.resolve();
    const watcher = watch(dir, (_event, filename) => {
      if (filename !== 'state.json') return;
      queue = queue.then(async () => {
        if (!this.accepting) return;
        const state = await this.state(dir);
        const latest = state.latestResult;
        if (latest && latest.sequence > sequence) {
          sequence = latest.sequence;
          const binding = await readJson(join(dir, 'binding.json'));
          if (binding.owner === this.owner && this.accepting) await this.onResult({ taskId: binding.taskId, sessionId: state.sessionId, ...latest });
        }
        if (state.phase === 'terminated') {
          watcher.close();
          this.watchers.delete(dir);
        }
      }).catch(error => { if (this.accepting) this.onError(error); });
    });
    watcher.on('error', error => { if (this.accepting) this.onError(error); });
    this.watchers.set(dir, watcher);
  }

  run(args, execute, context) {
    if (!this.accepting) return Promise.reject(new Error('Subagent session is not active'));
    const promise = this.dispatch(args, execute, context);
    this.pending.add(promise);
    promise.finally(() => this.pending.delete(promise)).catch(() => {});
    return promise;
  }

  async background(execute, args) {
    const outcome = await execute(args);
    const result = outcome.result;
    if (outcome.isError || result?.isError) {
      const data = result?.details;
      throw Object.assign(new Error(data?.cause ?? result?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? 'Background task failed'), { taskId: data?.taskId, backgroundError: data });
    }
    if (!result?.details) throw new Error('background_task returned no task metadata');
    return result.details;
  }

  async dispatch(args, execute, context) {
    switch (args.action) {
      case 'start': return this.start(args, execute, context);
      case 'list': return this.list(execute);
      case 'send': {
        const record = await this.find(args.taskId);
        const processTask = await this.processTask(execute, args.taskId);
        if (processTask.status !== 'running') throw new Error(`Subagent is terminated (${processTask.status})`);
        const messageId = args.messageId ?? randomUUID();
        const response = await request(record.manifest.socketPath, { action: 'send', message: args.message, mode: args.mode ?? 'steer', messageId });
        return { taskId: args.taskId, ...response };
      }
      case 'cancel': return this.cancel(await this.find(args.taskId), execute);
      case 'cancelAll': {
        const { records, errors } = await this.records();
        const results = [];
        for (const record of records.filter(item => item.binding)) {
          try { results.push(await this.cancel(record, execute)); }
          catch (error) { errors.push({ ...detail(error), taskId: record.binding.taskId }); }
        }
        return { results, errors };
      }
      default: throw new Error('Unknown subagent action');
    }
  }

  processTask(execute, taskId) {
    return this.background(execute, { action: 'status', taskId });
  }

  async start(args, execute, { cwd, model, thinkingLevel }) {
    if (typeof args.task !== 'string' || !args.task.trim()) throw new Error('task is required');
    if (!model?.provider || !model?.id) throw new Error('Select a model before starting a subagent');
    const launchId = randomUUID();
    const dir = join(this.ownerDir, launchId);
    await privateDirectory(dir);
    const socketDir = await mkdtemp(join(tmpdir(), 'pi-sa-'));
    const manifestPath = join(dir, 'manifest.json');
    const manifest = {
      version: 1, launchId, owner: this.owner, dir, socketDir, socketPath: join(socketDir, 'control.sock'),
      task: args.task, initialMessageId: randomUUID(), cwd: resolve(cwd, args.cwd ?? '.'),
      model: { provider: model.provider, id: model.id }, thinkingLevel: thinkingLevel ?? 'medium',
      sdkPath: this.sdkPath, agentDir: this.agentDir,
    };
    let task;
    try {
      await atomicJson(manifestPath, manifest);
      await this.observe(dir);
      const command = `exec ${quote(this.nodePath)} ${quote(this.workerPath)} ${quote(manifestPath)}`;
      task = await this.background(execute, { action: 'start', command, cwd: manifest.cwd, timeoutSeconds: args.timeoutSeconds, statusReport: args.statusReport });
      if (!uuidPattern.test(task.taskId ?? '')) throw new Error('background_task returned an invalid task ID');
      await atomicJson(join(dir, 'binding.json'), { owner: this.owner, ...task });
      return { ...task, phase: 'starting', artifactDir: dir, manifestPath, statePath: join(dir, 'state.json'), resultsDir: join(dir, 'results') };
    } catch (error) {
      error.artifactDir = dir;
      error.taskId ??= task?.taskId;
      await atomicJson(join(dir, 'launch-error.json'), detail(error)).catch(() => {});
      if (uuidPattern.test(error.taskId ?? '')) {
        await atomicJson(join(dir, 'binding.json'), { owner: this.owner, taskId: error.taskId, status: 'unknown' }).catch(() => {});
        try { await this.background(execute, { action: 'cancel', taskId: error.taskId }); }
        catch (cleanup) { error.cleanupError = cleanup.message; }
      }
      if (!task && !error.taskId) await rm(socketDir, { recursive: true, force: true });
      throw error;
    }
  }

  async list(execute) {
    const { records, errors } = await this.records();
    const background = await this.background(execute, { action: 'list' });
    const tasks = [];
    for (const record of records) {
      if (!record.binding) {
        errors.push({ artifactDir: record.dir, error: 'Launch has no task binding; inspect manifest.json and launch-error.json' });
        continue;
      }
      const taskId = record.binding.taskId;
      try {
        const state = await this.state(record.dir);
        const task = background.tasks.find(item => item.taskId === taskId);
        const status = task?.status ?? 'unknown';
        tasks.push({ ...state, ...task, taskId, status, phase: status === 'running' ? state.phase : status === 'unknown' ? 'unknown' : 'terminated', artifactDir: record.dir });
        if (status === 'unknown') errors.push({ taskId, error: 'Background task outcome is unknown' });
      } catch (error) { errors.push({ taskId, error: error.message }); }
    }
    for (const error of background.errors ?? []) {
      if (records.some(record => record.binding?.taskId === error.taskId)) errors.push(error);
    }
    return { tasks, errors };
  }

  async cancel(record, execute) {
    let admission;
    try { admission = await request(record.manifest.socketPath, { action: 'stop' }, { timeoutMs: 500 }); }
    catch (error) { admission = detail(error); }
    try {
      const task = await this.background(execute, { action: 'cancel', taskId: record.binding.taskId });
      return { ...task, admission };
    } catch (error) {
      error.admission = admission;
      error.taskId = record.binding.taskId;
      throw error;
    }
  }

  async dispose() {
    this.accepting = false;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    await Promise.allSettled([...this.pending]);
  }
}
