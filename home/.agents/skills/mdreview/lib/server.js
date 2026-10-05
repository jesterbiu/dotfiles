import { createServer } from "node:http";
import { readFile, readdir, writeFile, stat, realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";

const root = new URL("../", import.meta.url);
const home = realpathSync(homedir());

const assets = {
  "/_/app.js": "public/app.js",
  "/_/anchor.js": "lib/anchor.js",
};

export async function startServer({ port = 4747, host = "127.0.0.1" } = {}) {
  const server = createServer((req, res) => handle(req, res).catch((err) => send(res, err.status ?? 500, err.message)));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { server, url: `http://localhost:${server.address().port}` };
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const path = decodeURIComponent(url.pathname);

  if (req.method === "GET" && assets[path]) {
    return send(res, 200, await readFile(new URL(assets[path], root)), "text/javascript; charset=utf-8");
  }
  if (path.startsWith("/_/api/")) return api(path.slice("/_/api/".length), await docPath(url.searchParams.get("path")), req, res);
  if (req.method === "GET" && !path.startsWith("/_/")) {
    const real = await homePath(path);
    if ((await stat(real)).isDirectory()) return send(res, 200, await listing(real), "text/html; charset=utf-8");
    await docPath(path);
    return send(res, 200, await readFile(new URL("public/index.html", root)), "text/html; charset=utf-8");
  }
  send(res, 404, "not found");
}

async function api(name, docPath, req, res) {
  const commentsPath = `${docPath}.comments.json`;
  if (req.method === "GET" && name === "doc") {
    return send(res, 200, await readFile(docPath), "text/markdown; charset=utf-8");
  }
  if (req.method === "GET" && name === "mtimes") {
    return sendJson(res, 200, { doc: await mtime(docPath), comments: await mtime(commentsPath) });
  }
  if (req.method === "GET" && name === "comments") {
    return sendJson(res, 200, await readComments(docPath));
  }
  if (req.method === "PUT" && name === "comments") {
    let incoming;
    try {
      incoming = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, "body must be JSON");
    }
    if (!Array.isArray(incoming?.comments)) return send(res, 400, "body must have a comments array");
    return sendJson(res, 200, await updateComments(docPath, (current) => replaceComments(current, incoming.comments)));
  }
  send(res, 404, "not found");
}

async function homePath(relative) {
  const path = join(home, relative ?? "");
  if (!underHome(path)) throw forbidden();
  const real = await realpath(path).catch(() => null);
  if (!real) throw httpError(404, "not found");
  if (!underHome(real)) throw forbidden();
  return real;
}

async function docPath(relative) {
  if (!relative?.endsWith(".md")) throw forbidden();
  const real = await homePath(relative);
  if (!real.endsWith(".md")) throw forbidden();
  return real;
}

function underHome(path) {
  return path === home || path.startsWith(home + sep);
}

function forbidden() {
  return httpError(403, `only markdown files and directories under ${home} are served`);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function listing(dir) {
  const names = await readdir(dir).catch(() => {
    throw httpError(403, `cannot read ${dir}`);
  });
  const entries = await Promise.all(
    names.map(async (name) => ({ name, path: join(dir, name), stats: await stat(join(dir, name)).catch(() => null) })),
  );
  const byName = (a, b) => a.name.localeCompare(b.name);
  const dirs = entries.filter((e) => e.stats?.isDirectory()).sort(byName);
  const docs = entries.filter((e) => e.stats?.isFile() && e.name.endsWith(".md")).sort(byName);
  const items = [
    ...(dir === home ? [] : [link(href(dirname(dir), true), "../")]),
    ...dirs.map((e) => link(href(e.path, true), `${e.name}/`)),
    ...(await Promise.all(docs.map(async (e) => link(href(e.path, false), e.name) + openLabel(await openCount(e.path))))),
  ];
  const heading = dir === home ? "~" : `~/${relative(home, dir)}`;
  return listingPage(heading, items);
}

function href(path, isDir) {
  const rel = relative(home, path).split(sep).map(encodeURIComponent).join("/");
  return isDir && rel ? `/${rel}/` : `/${rel}`;
}

function link(url, text) {
  return `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`;
}

async function openCount(docPath) {
  try {
    const { comments } = JSON.parse(await readFile(`${docPath}.comments.json`, "utf8"));
    return comments.filter((c) => c.status === "open").length;
  } catch {
    return 0;
  }
}

function openLabel(count) {
  return count ? ` <span class="open">${count} open</span>` : "";
}

function escapeHtml(text) {
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return text.replace(/[&<>"']/g, (c) => entities[c]);
}

function listingPage(heading, items) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading)} - mdreview</title>
<style>
:root {
  --bg: #ffffff;
  --fg: #1f2328;
  --muted: #6e7781;
  --accent: #0969da;
  --open: #d4a72c;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --fg: #e6edf3;
    --muted: #8d96a0;
    --accent: #4493f8;
    --open: #e3b341;
  }
}
body {
  margin: 0;
  padding: 24px 16px;
  background: var(--bg);
  color: var(--fg);
  font: 14px/1.7 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
main { max-width: 820px; margin: 0 auto; }
h1 { font-size: 16px; margin: 0 0 12px; color: var(--muted); overflow-wrap: anywhere; }
ul { list-style: none; margin: 0; padding: 0; }
li { overflow-wrap: anywhere; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.open { color: var(--open); margin-left: 8px; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(heading)}</h1>
<ul>
${items.map((item) => `<li>${item}</li>`).join("\n")}
</ul>
</main>
</body>
</html>
`;
}

async function readComments(docPath) {
  const empty = { doc: basename(docPath), nextId: 1, comments: [] };
  let file;
  try {
    file = JSON.parse(await readFile(`${docPath}.comments.json`, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return empty;
    throw err;
  }
  const comments = file.comments ?? [];
  return { doc: empty.doc, nextId: Math.max(file.nextId ?? 1, highestId(comments) + 1), comments };
}

async function updateComments(docPath, change) {
  const next = change(await readComments(docPath));
  await writeFile(`${docPath}.comments.json`, JSON.stringify(next, null, 2) + "\n");
  return next;
}

function replaceComments(current, incoming) {
  let nextId = Math.max(current.nextId, highestId(incoming) + 1);
  const comments = incoming.map((c) =>
    c.id ? c : { id: `c${nextId++}`, anchor: c.anchor, text: c.text, status: "open", created: now() },
  );
  return { doc: current.doc, nextId, comments };
}

function highestId(comments) {
  return Math.max(0, ...comments.map((c) => Number(/^c(\d+)$/.exec(c.id ?? "")?.[1] ?? 0)));
}

function now() {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

async function mtime(path) {
  try {
    return (await stat(path)).mtimeMs;
  } catch (err) {
    if (err.code === "ENOENT") return 0;
    throw err;
  }
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), "application/json");
}
