import { createConnection, createServer } from 'node:net';
import { chmod } from 'node:fs/promises';

const maxBytes = 1024 * 1024;

export function request(socketPath, payload, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const frame = `${JSON.stringify(payload)}\n`;
    let submitted = false;
    let finished = false;
    let buffer = '';
    let bytes = 0;
    const fail = cause => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      reject(Object.assign(new Error(cause.message), { delivery: submitted ? 'unknown' : 'not_sent', messageId: payload.messageId }));
    };
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => fail(new Error('Subagent request timed out')), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      if (Buffer.byteLength(frame) > maxBytes) return fail(new Error('Subagent request exceeds 1 MiB'));
      submitted = true;
      socket.write(frame);
    });
    socket.on('error', fail);
    socket.on('close', () => fail(new Error('Subagent connection closed without acknowledgement')));
    socket.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      buffer += chunk;
      if (bytes > maxBytes) return fail(new Error('Subagent response exceeds 1 MiB'));
      const boundary = buffer.indexOf('\n');
      if (boundary < 0) return;
      let response;
      try { response = JSON.parse(buffer.slice(0, boundary)); } catch (error) { return fail(error); }
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (response.ok) resolve(response.value);
      else reject(Object.assign(new Error(response.error), { delivery: response.delivery ?? 'rejected', messageId: payload.messageId }));
    });
  });
}

export async function serve(socketPath, handle) {
  const connections = new Set();
  const server = createServer(socket => {
    connections.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => connections.delete(socket));
    socket.setTimeout(10000, () => socket.destroy());
    socket.setEncoding('utf8');
    let buffer = '';
    let bytes = 0;
    let received = false;
    socket.on('data', chunk => {
      if (received) return;
      buffer += chunk;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) { socket.destroy(); return; }
      const boundary = buffer.indexOf('\n');
      if (boundary < 0) return;
      received = true;
      Promise.resolve().then(() => handle(JSON.parse(buffer.slice(0, boundary))))
        .then(value => socket.end(`${JSON.stringify({ ok: true, value })}\n`), error => socket.end(`${JSON.stringify({ ok: false, error: error.message, delivery: error.delivery })}\n`));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  return async () => {
    for (const socket of connections) socket.end();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
}
