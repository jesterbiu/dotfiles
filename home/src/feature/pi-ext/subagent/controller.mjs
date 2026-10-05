import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { atomicJson, privateDirectory, readJson, uuidPattern } from './storage.mjs';
import { request } from './protocol.mjs';
import { compactError, errorText } from '../background-task/output.mjs';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export class Controller {
  constructor({ root, owner, workerPath, sdkPath, agentDir, nodePath = process.execPath, onResult = () => {}, onChange = () => {}, onError = error => console.error(error) }) {
    Object.assign(this, { owner, workerPath, sdkPath, agentDir, nodePath, onResult, onChange, onError });
    this.ownerDir = join(resolve(root), createHash('sha256').update(owner).digest('hex'));
    this.pending = new Set();
    this.notified = new Set();
    this.accepting = true;
  }

  async init() {
    await privateDirectory(this.ownerDir);
  }

  async restore(tasks) {
    const { records } = await this.records();
    for (const record of records) {
      const task = tasks.find(item => item.taskId === record.binding?.taskId);
      if (task?.process === 'running') await this.changed(record, task);
    }
  }

  async changed(record, task, completion = false) {
    let resolved;
    try { resolved = await readJson(join(record.dir, 'resolved.json')); } catch {}
    const value = await this.view(record, task);
    if (!this.accepting) return;
    try {
      this.onChange({
        ...value,
        topic: record.manifest.topic ?? record.manifest.task.slice(0, 48),
        model: record.manifest.model.id,
        thinkingLevel: resolved?.thinkingLevel ?? record.manifest.effectiveThinkingLevel ?? record.manifest.thinkingLevel,
        startedAt: record.manifest.startedAt ?? task.startedAt ?? record.binding.startedAt ?? Date.now(),
        ...(task.endedAt != null ? { endedAt: task.endedAt } : {}),
      }, completion);
    } catch (error) { this.onError(error); }
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
        errors.push({ artifacts: dir, error: errorText(error.message) });
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
      if (error.code === 'ENOENT') return { phase: 'starting' };
      throw error;
    }
  }

  async view(record, task) {
    let state;
    let stateError;
    try { state = await this.state(record.dir); }
    catch (error) { state = { phase: 'unknown' }; stateError = errorText(`Cannot read state.json: ${error.message}`); }
    const process = task?.process ?? 'unknown';
    const value = { taskId: record.binding.taskId, process, phase: process === 'running' ? state.phase : process === 'unknown' ? 'unknown' : 'terminated', artifacts: record.dir };
    if (stateError) value.error = stateError;
    for (const key of ['exitCode', 'exitSignal', 'reason']) if (task?.[key] != null) value[key] = task[key];
    try {
      const result = await readJson(join(record.dir, 'result.json'));
      if (!['succeeded', 'failed'].includes(result.status)) throw new Error('Invalid result status');
      value.result = result.status;
      if (result.status === 'failed' && result.reportedError) value.reportedError = { source: result.reportedError.source, message: errorText(result.reportedError.message) };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        value.result = 'unknown';
        value.error = errorText(`Cannot read result.json: ${error.message}`);
      } else if (process !== 'running') value.result = 'unavailable';
    }
    return value;
  }

  async onProcess(event) {
    if (!this.accepting || event.owner !== this.owner) return;
    await Promise.allSettled([...this.pending]);
    if (!this.accepting || this.notified.has(event.task.taskId)) return;
    const record = await this.find(event.task.taskId);
    if (!this.accepting || this.notified.has(event.task.taskId)) return;
    if (event.type === 'completion') this.notified.add(event.task.taskId);
    const value = await this.view(record, event.task);
    if (this.accepting) await this.onResult({ type: `subagent-${event.type}`, ...value });
    await this.changed(record, event.task, event.type === 'completion');
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
      throw Object.assign(new Error(data?.error ?? data?.cause ?? result?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? 'Background task failed'), { taskId: data?.taskId, sideEffects: data?.sideEffects });
    }
    if (!result?.details) throw new Error('background_task returned no task metadata');
    return result.details;
  }

  async dispatch(args, execute, context) {
    switch (args.action) {
      case 'start': return this.start(args, execute, context);
      case 'list': return this.list(execute);
      case 'send': {
        if (args.mode !== undefined && args.mode !== 'steer') throw new Error('Only steering is supported');
        const record = await this.find(args.taskId);
        const task = await this.background(execute, { action: 'status', taskId: args.taskId });
        if (task.process !== 'running') throw new Error(`Subagent is terminated (${task.process})`);
        const state = await this.state(record.dir);
        if (['stopping', 'terminated'].includes(state.phase)) throw new Error('Subagent is settled or stopping');
        const messageId = args.messageId ?? randomUUID();
        return { taskId: args.taskId, ...await request(record.manifest.socketPath, { action: 'send', message: args.message, messageId }) };
      }
      case 'cancel': return this.cancel(await this.find(args.taskId), execute);
      case 'cancelAll': {
        const { records, errors } = await this.records();
        const results = [];
        for (const record of records.filter(item => item.binding)) {
          try { results.push(await this.cancel(record, execute)); }
          catch (error) { errors.push({ ...compactError(error), taskId: record.binding.taskId }); }
        }
        return { results, ...(errors.length ? { errors } : {}) };
      }
      default: throw new Error('Unknown subagent action');
    }
  }

  async start(args, execute, { cwd, model, thinkingLevel, effectiveThinkingLevel }) {
    if (typeof args.task !== 'string' || !args.task.trim()) throw new Error('task is required');
    if (typeof args.model !== 'string' || !model?.provider || !model?.id || args.model !== `${model.provider}/${model.id}`) throw new Error('An exact model is required for start: provider/model-id');
    const thinking = args.thinkingLevel ?? thinkingLevel;
    if (!levels.includes(thinking)) throw new Error('A supported thinking level or parent thinking level is required');
    const existing = await this.list(execute);
    if (existing.errors?.length) throw new Error('Resolve unreadable task records before starting workers');
    const launchId = randomUUID();
    const dir = join(this.ownerDir, launchId);
    await privateDirectory(dir);
    const socketDir = await mkdtemp(join(tmpdir(), 'pi-sa-'));
    const manifest = {
      version: 2, launchId, owner: this.owner, dir, socketDir, socketPath: join(socketDir, 'control.sock'),
      task: args.task, topic: typeof args.topic === 'string' && args.topic.trim() ? args.topic.trim().slice(0, 80) : args.task.trim().replace(/\s+/g, ' ').slice(0, 48), startedAt: Date.now(), initialMessageId: randomUUID(), cwd: resolve(cwd, args.cwd ?? '.'),
      model: { provider: model.provider, id: model.id }, thinkingLevel: thinking, effectiveThinkingLevel,
      sdkPath: this.sdkPath, agentDir: this.agentDir,
    };
    let task;
    try {
      await atomicJson(join(dir, 'manifest.json'), manifest);
      const command = `exec ${quote(this.nodePath)} ${quote(this.workerPath)} ${quote(join(dir, 'manifest.json'))}`;
      task = await this.background(execute, { action: 'start', command, cwd: manifest.cwd, timeoutSeconds: args.timeoutSeconds, statusReport: args.statusReport, notificationTarget: 'subagent' });
      if (!uuidPattern.test(task.taskId ?? '')) throw new Error('background_task returned an invalid task ID');
      await atomicJson(join(dir, 'binding.json'), { owner: this.owner, ...task });
      await this.changed({ dir, manifest, binding: task }, task);
      return { taskId: task.taskId, process: task.process, phase: 'starting', artifacts: dir, ...(task.deadline ? { deadline: task.deadline } : {}), ...(task.statusReport ? { statusReport: task.statusReport } : {}) };
    } catch (error) {
      error.artifactDir = dir;
      error.taskId ??= task?.taskId;
      await atomicJson(join(dir, 'launch-error.json'), compactError(error)).catch(() => {});
      if (uuidPattern.test(error.taskId ?? '')) {
        await atomicJson(join(dir, 'binding.json'), { owner: this.owner, taskId: error.taskId, process: 'unknown' }).catch(() => {});
        try { await this.background(execute, { action: 'cancel', taskId: error.taskId }); }
        catch (cleanup) { error.sideEffects = [errorText(`Cancellation failed: ${cleanup.message}`)]; }
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
        errors.push({ artifacts: record.dir, error: 'Launch has no task binding; inspect launch-error.json' });
        continue;
      }
      const taskId = record.binding.taskId;
      try {
        const task = background.tasks.find(item => item.taskId === taskId);
        tasks.push(await this.view(record, task));
        if (task?.error) errors.push({ taskId, error: task.error });
      } catch (error) { errors.push({ taskId, error: errorText(error.message) }); }
    }
    for (const error of background.errors ?? []) errors.push(error);
    return { tasks, ...(errors.length ? { errors } : {}) };
  }

  async cancel(record, execute) {
    let admission;
    try { await request(record.manifest.socketPath, { action: 'stop' }, { timeoutMs: 500 }); }
    catch (error) { if (!['not_sent'].includes(error.delivery)) admission = compactError(error); }
    const task = await this.background(execute, { action: 'cancel', taskId: record.binding.taskId });
    return { ...await this.view(record, task), ...(admission ? { admission } : {}) };
  }

  async dispose() {
    this.accepting = false;
    await Promise.allSettled([...this.pending]);
  }
}
