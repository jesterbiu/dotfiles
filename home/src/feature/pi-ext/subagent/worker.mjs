import { appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, privateDirectory, uuidPattern } from './storage.mjs';
import { serve } from './protocol.mjs';
import { errorText } from '../background-task/output.mjs';

export class Worker {
  constructor({ dir, socketPath, session, dispose, exit = () => {}, onFatal = error => console.error(error) }) {
    Object.assign(this, { dir, socketPath, session, dispose, exit, onFatal });
    this.queue = Promise.resolve();
    this.accepting = false;
    this.requests = new Map();
    this.messageIds = [];
    this.usage = {};
    this.partialAnswer = '';
    this.state = { phase: 'starting', sessionId: session.sessionId, sessionFile: session.sessionFile };
  }

  serial(action) {
    const next = this.queue.then(action);
    this.queue = next.catch(() => {});
    return next;
  }

  saveState() {
    return atomicJson(join(this.dir, 'state.json'), { ...this.state, messageIds: this.messageIds, usage: this.usage, updatedAt: Date.now() });
  }

  async start(initial) {
    await privateDirectory(this.dir);
    this.unsubscribe = this.session.subscribe(event => {
      if (event.type !== 'message_end' && event.type !== 'agent_settled') return;
      if (event.type === 'agent_settled') this.accepting = false;
      void this.serial(async () => {
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          this.lastAssistant = event.message;
          const text = event.message.content?.filter(block => block.type === 'text').map(block => block.text).join('\n');
          if (text) this.partialAnswer = text;
          for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) this.usage[key] = (this.usage[key] ?? 0) + (event.message.usage?.[key] ?? 0);
          this.usage.cost = (this.usage.cost ?? 0) + (event.message.usage?.cost?.total ?? 0);
        }
        if (event.type === 'agent_settled') await this.finish();
      }).catch(error => this.fatal(error));
    });
    await this.saveState();
    try {
      await new Promise((resolve, reject) => {
        let admitted = false;
        this.session.prompt(initial.message, {
          expandPromptTemplates: false,
          source: 'rpc',
          preflightResult: disposition => {
            admitted = true;
            this.accepting = disposition === 'started';
            this.serial(async () => {
              this.state.phase = 'busy';
              await this.record(initial.messageId, initial.message, disposition);
              if (disposition !== 'started') await this.finish('Initial task did not start');
            }).then(resolve, reject);
          },
        }).catch(error => {
          this.accepting = false;
          if (!admitted) reject(error);
          else void this.serial(() => this.finish(error.message)).catch(cause => this.fatal(cause));
        });
      });
      if (this.accepting) {
        this.closeServer = await serve(this.socketPath, value => this.handle(value));
        if (!this.accepting) await this.closeServer();
      }
    } catch (error) {
      this.accepting = false;
      await this.serial(() => this.finish(error.message));
    }
  }

  fatal(error) {
    this.accepting = false;
    this.onFatal(error);
  }

  handle(value) {
    if (value?.action === 'stop') return this.stop();
    if (value?.action !== 'send') throw new Error('Unknown subagent request');
    return this.send(value);
  }

  async record(messageId, message, disposition) {
    const ack = { messageId, disposition };
    if (disposition !== 'handled') this.messageIds.push(messageId);
    await appendFile(join(this.dir, 'requests.jsonl'), `${JSON.stringify({ ...ack, message })}\n`, { mode: 0o600 });
    await this.saveState();
    return ack;
  }

  send({ message, messageId, mode }) {
    if (typeof message !== 'string' || !message.trim()) throw new Error('message must not be empty');
    if (!uuidPattern.test(messageId ?? '')) throw new Error('messageId must be a UUID');
    if (mode !== undefined && mode !== 'steer') throw new Error('Only steering is supported');
    const prior = this.requests.get(messageId);
    if (prior) {
      if (prior.message !== message) throw new Error('messageId reused with different input');
      return prior.outcome;
    }
    if (!this.accepting) throw new Error('Subagent is settled or stopping');
    const outcome = (async () => {
      const disposition = await this.session.steer(message, undefined, { source: 'rpc' });
      if (!this.accepting) throw new Error('Subagent settled before steering admission completed');
      return this.serial(() => this.record(messageId, message, disposition));
    })();
    outcome.catch(() => {});
    this.requests.set(messageId, { message, outcome });
    return outcome;
  }

  async stop() {
    this.accepting = false;
    this.stopReason = 'Cancelled';
    await this.serial(async () => { this.state.phase = 'stopping'; await this.saveState(); });
    this.end();
    return { phase: 'stopping' };
  }

  end() {
    if (this.ending) return;
    this.ending = true;
    setImmediate(() => void this.close().then(() => this.exit(), error => this.fatal(error)));
  }

  async finish(error) {
    if (this.state.result) return;
    this.accepting = false;
    const message = this.lastAssistant;
    const failure = this.stopReason ?? error ?? (message?.stopReason === 'stop' ? undefined : message?.errorMessage ?? `No successful final answer (${message?.stopReason ?? 'missing'})`);
    const result = { status: failure ? 'failed' : 'succeeded' };
    const answer = failure ? this.partialAnswer : message?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n');
    if (answer) result.answer = answer;
    if (failure) {
      result.reportedError = { source: this.stopReason ? 'worker' : 'sdk', message: errorText(failure) };
      await atomicJson(join(this.dir, 'failure.json'), { error: failure });
    }
    await atomicJson(join(this.dir, 'result.json'), result);
    this.state.result = result.status;
    this.state.phase = 'stopping';
    await this.saveState();
    this.end();
  }

  close() {
    if (this.closing) return this.closing;
    this.accepting = false;
    this.closing = (async () => {
      await this.closeServer?.();
      await this.session.abort();
      await this.serial(() => this.finish(this.stopReason ?? 'Worker stopped before task settlement'));
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
