import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson, readJson } from './storage.mjs';
import { Worker } from './worker.mjs';
import { createPiRuntime } from './pi-session.mjs';

process.umask(0o077);
let manifest;
let runtime;
let worker;
let stopping = false;
let shutdownPromise;
const startup = new AbortController();

function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  startup.abort();
  shutdownPromise = (async () => {
    const deadline = setTimeout(() => process.exit(process.exitCode || 1), 5000);
    deadline.unref();
    try {
      if (worker) await worker.close();
      else if (runtime) await runtime.dispose();
      if (manifest) await rm(manifest.socketDir, { recursive: true, force: true });
    } finally {
      clearTimeout(deadline);
    }
  })();
  return shutdownPromise;
}

const exit = () => void shutdown().then(() => process.exit(process.exitCode || 0), error => { console.error(error); process.exit(1); });
for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.once(signal, exit);

try {
  manifest = await readJson(process.argv[2]);
  if (manifest.version !== 1) throw new Error('Unsupported subagent manifest version');
  process.env.PI_CODING_AGENT_DIR = manifest.agentDir;
  delete process.env.PI_SESSION_ID;
  delete process.env.PI_SESSION_FILE;
  const deadline = Date.now() + 30000;
  while (true) {
    startup.signal.throwIfAborted();
    try {
      const binding = await readJson(join(manifest.dir, 'binding.json'));
      if (binding.owner !== manifest.owner || !binding.taskId || binding.status !== 'running') throw new Error('Invalid task binding');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT' || Date.now() >= deadline) throw error;
      await delay(50, undefined, { signal: startup.signal });
    }
  }
  runtime = await createPiRuntime(manifest);
  if (stopping) {
    await runtime.dispose();
  } else {
    worker = new Worker({
      dir: manifest.dir,
      socketPath: manifest.socketPath,
      session: runtime.session,
      dispose: async () => { await runtime.session.abort(); await runtime.dispose(); },
      exit,
      onFatal: error => {
        console.error(error);
        process.exitCode = 1;
        void shutdown().catch(cause => { console.error(cause); process.exit(1); });
      },
    });
    await worker.start({ action: 'send', messageId: manifest.initialMessageId, message: manifest.task, mode: 'steer' });
    await atomicJson(join(manifest.dir, 'resolved.json'), {
      model: { provider: runtime.session.model.provider, id: runtime.session.model.id },
      thinkingLevel: runtime.session.thinkingLevel,
      tools: runtime.session.getActiveToolNames(),
      sessionId: runtime.session.sessionId,
      sessionFile: runtime.session.sessionFile,
    });
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  if (manifest) {
    await atomicJson(join(manifest.dir, 'startup-error.json'), { error: error.message, at: Date.now() }).catch(() => {});
    if (!worker) await atomicJson(join(manifest.dir, 'state.json'), { phase: 'terminated', error: error.message, latestResult: null }).catch(() => {});
  }
  await shutdown().catch(cause => { console.error(cause); process.exit(1); });
}
