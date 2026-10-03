#!/usr/bin/env node
import { parseArgs } from "node:util";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startServer } from "../lib/server.js";
import { sourceLine } from "../lib/source.js";

const usage = `usage:
  mdreview serve [--port 4747]
  mdreview comments <doc.md>
  mdreview resolve <doc.md> <id>...`;

const [command, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: { port: { type: "string", default: "4747" } },
});

if (command === "serve" && positionals.length === 0) await serve(Number(values.port));
else if (command === "comments" && positionals.length === 1) listComments(docPath(positionals[0]));
else if (command === "resolve" && positionals.length >= 2) resolveComments(docPath(positionals[0]), positionals.slice(1));
else fail(usage, 2);

async function serve(port) {
  const { url } = await startServer({ port });
  console.log(`mdreview: serving ${url}`);
}

function listComments(doc) {
  const markdown = readFileSync(doc, "utf8");
  const open = (readCommentsFile(doc)?.comments ?? []).filter((c) => c.status !== "resolved");
  if (!open.length) return console.log("no open comments");
  console.log(open.map((c) => describe(c, markdown)).join("\n\n"));
}

function describe(comment, markdown) {
  const { anchor } = comment;
  const where =
    anchor.kind === "diagram"
      ? `${anchor.target}: ${anchor.id}${anchor.label ? ` "${anchor.label}"` : ""}`
      : `quote: ${truncate(anchor.quote.replace(/\s+/g, " ").trim())}`;
  return `${comment.id}  line ${sourceLine(markdown, anchor) ?? "?"}\n${where}\nnote: ${comment.text.replace(/\n/g, "\n  ")}`;
}

function truncate(text) {
  return text.length > 120 ? `${text.slice(0, 120)} ...` : text;
}

function resolveComments(doc, ids) {
  const file = readCommentsFile(doc);
  if (!file) fail(`mdreview: no comments file: ${doc}.comments.json`);
  const known = new Set(file.comments.map((c) => c.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) fail(`mdreview: unknown comment id: ${unknown.join(" ")}`);
  for (const comment of file.comments) if (ids.includes(comment.id)) comment.status = "resolved";
  writeFileSync(`${doc}.comments.json`, JSON.stringify(file, null, 2) + "\n");
  console.log(`resolved ${ids.join(" ")}`);
}

function readCommentsFile(doc) {
  const path = `${doc}.comments.json`;
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

function docPath(arg) {
  const path = resolve(arg);
  if (!existsSync(path)) fail(`mdreview: no such file: ${path}`);
  return realpathSync(path);
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}
