import { appendFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, privateDirectory, uuidPattern } from './storage.mjs';
import { serve } from './protocol.mjs';

export class Worker {
  constructor({ dir, socketPath, session, dispose, exit = () => {}, onFatal = error => console.error(error) }) {
    this.dir = dir;
    this.socketPath = socketPath;
    this.session = session;
    this.dispose = dispose;
    this.exit = exit;
    this.onFatal = onFatal;
    this.queue = Promise.resolve();
    this.accepting = true;
    this.requests = new Map();
    this.order = 0;
    this.messageIds = [];
    this.lastAssistant = null;
    this.usage = {};
    this.state = { phase: 'starting', sessionId: session.sessionId, sessionFile: session.sessionFile, latestResult: null };
  }

  serial(action) {
    const next = this.queue.then(action);
    this.queue = next.catch(() => {});
    return next;
  }

  saveState() {
    return atomicJson(join(this.dir, 'state.json'), { ...this.state, updatedAt: Date.now() });
  }

  async start(initialRequest) {
    await privateDirectory(this.dir);
    await privateDirectory(join(this.dir, 'results'));
    this.unsubscribe = this.session.subscribe(event => {
      if (event.type !== 'message_end' && event.type !== 'agent_settled') return;
      void this.serial(async () => {
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          this.lastAssistant = event.message;
          for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) {
            this.usage[key] = (this.usage[key] ?? 0) + (event.message.usage?.[key] ?? 0);
          }
          this.usage.cost = (this.usage.cost ?? 0) + (event.message.usage?.cost?.total ?? 0);
        }
        if (event.type === 'agent_settled') await this.finish();
      }).catch(error => this.fatal(error));
    });
    this.state.phase = 'idle';
    await this.saveState();
    if (initialRequest) await this.handle(initialRequest);
    this.closeServer = await serve(this.socketPath, value => this.handle(value));
  }

  fatal(error) {
    this.accepting = false;
    this.onFatal(error);
  }

  handle(value) {
    if (value?.action === 'stop') return this.stop();
    if (value?.action !== 'send') return Promise.reject(new Error('Unknown subagent request'));
    return this.send(value);
  }

  async stop() {
    await this.serial(async () => {
      this.accepting = false;
      this.state.phase = 'stopping';
      await this.saveState();
    });
    setImmediate(() => void this.session.abort().then(() => this.close()).then(() => this.exit(), error => this.fatal(error)));
    return { phase: 'stopping' };
  }

  send({ message, messageId, mode = 'steer' }) {
    if (typeof message !== 'string' || !message.trim()) throw new Error('message must not be empty');
    if (!uuidPattern.test(messageId ?? '')) throw new Error('messageId must be a UUID');
    if (!['steer', 'followUp'].includes(mode)) throw new Error('Invalid send mode');
    const prior = this.requests.get(messageId);
    if (prior) {
      if (prior.message !== message || prior.mode !== mode) throw new Error('messageId reused with different input');
      return prior.outcome;
    }
    if (!this.accepting) throw new Error('Subagent is stopping');
    const record = { message, mode, outcome: this.admit(messageId, message, mode) };
    record.outcome.catch(() => {});
    this.requests.set(messageId, record);
    return record.outcome;
  }

  async admit(messageId, message, mode) {
    let acknowledged = false;
    const accepted = new Promise((resolve, reject) => {
      this.session.prompt(message, {
        streamingBehavior: mode,
        expandPromptTemplates: false,
        source: 'rpc',
        preflightResult: disposition => {
          acknowledged = true;
          resolve(disposition);
        },
      }).catch(error => {
        if (!acknowledged) reject(error);
        else void this.serial(() => this.finish(error.message)).catch(cause => this.fatal(cause));
      });
    });
    let disposition;
    try {
      disposition = await accepted;
    } catch (error) {
      if (/compaction is in progress/.test(error.message)) {
        this.requests.delete(messageId);
        throw Object.assign(new Error(error.message), { delivery: 'busy' });
      }
      throw error;
    }
    try {
      return await this.serial(async () => {
        const ack = { messageId, order: ++this.order, disposition };
        if (disposition !== 'handled') {
          ack.result = (this.state.latestResult?.sequence ?? 0) + 1;
          this.messageIds.push(messageId);
          this.state.phase = 'busy';
        }
        await appendFile(join(this.dir, 'requests.jsonl'), `${JSON.stringify({ ...ack, message, mode })}\n`, { mode: 0o600 });
        await this.saveState();
        return ack;
      });
    } catch (error) {
      this.fatal(error);
      throw Object.assign(new Error(error.message), { delivery: 'unknown' });
    }
  }

  async finish(error) {
    const sequence = (this.state.latestResult?.sequence ?? 0) + 1;
    const prefix = join(this.dir, 'results', String(sequence).padStart(6, '0'));
    const answerPath = `${prefix}.md`;
    const resultPath = `${prefix}.json`;
    const message = this.lastAssistant;
    const status = error || !message || !['stop'].includes(message.stopReason) ? 'failed' : 'succeeded';
    const answer = message?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '';
    const result = {
      sequence, status, sessionId: this.session.sessionId, sessionFile: this.session.sessionFile,
      messageIds: [...this.messageIds], answerPath, resultPath, usage: this.usage,
      error: error ?? (status === 'failed' ? message?.errorMessage ?? `No successful final answer (${message?.stopReason ?? 'missing'})` : null),
      endedAt: Date.now(),
    };
    await writeFile(answerPath, `${answer}\n`, { flag: 'wx', mode: 0o600 });
    await atomicJson(resultPath, result);
    this.state.latestResult = { sequence, status, answerPath, resultPath };
    this.state.phase = this.accepting ? 'idle' : 'stopping';
    this.messageIds = [];
    this.lastAssistant = null;
    this.usage = {};
    await this.saveState();
  }

  close() {
    if (this.closing) return this.closing;
    this.accepting = false;
    this.closing = (async () => {
      await this.closeServer?.();
      await this.serial(async () => { this.state.phase = 'stopping'; await this.saveState(); });
      try {
        await this.dispose();
      } finally {
        this.unsubscribe?.();
        await this.queue;
        this.state.phase = 'terminated';
        await this.saveState();
        await rm(this.socketPath, { force: true });
      }
    })();
    return this.closing;
  }
}
