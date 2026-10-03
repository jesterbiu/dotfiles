import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/mdreview.js", import.meta.url));
const fixture = new URL("./fixtures/design.md", import.meta.url);

function run(...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
  });
}

function comment(id, anchor, text, status = "open") {
  return { id, anchor, text, status, created: "2026-10-03T09:00:00Z" };
}

test("comments lists open comments at their source lines and resolve flips only the named ids", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mdreview-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const docPath = join(dir, "design.md");
  const commentsPath = `${docPath}.comments.json`;
  await copyFile(fixture, docPath);

  assert.deepEqual(await run("comments", docPath), { code: 0, stdout: "no open comments\n", stderr: "" });

  const longQuote = "The pipeline runs on every push. The pipeline must stay under ten minutes.\nStages\n\nStage\nOwner\nBudget\n\n\nBuild\ninfra\n3 min\n\n\nTest\ndev\n6 min\n\n\n\nmake build && make test";
  const file = {
    doc: "design.md",
    nextId: 7,
    comments: [
      comment("c1", { kind: "text", quote: "git tag once both stages\npass", prefix: "Release\nTag the build with ", suffix: ", then run make release." }, "Which tag?"),
      comment("c2", { kind: "text", quote: "Deploys are blocked when the", prefix: "Notify author\n", suffix: " tag is missing." }, "Blocked by what?\nSay which check."),
      comment("c3", { kind: "diagram", diagram: 0, target: "edge", id: "B-->C", label: "yes" }, "Who approves?"),
      comment("c4", { kind: "text", quote: longQuote, prefix: "Release pipeline\n", suffix: "\n\n\nDeploys are blocked when the pi" }, "Too long.", "resolved"),
      comment("c5", { kind: "text", quote: longQuote, prefix: "Release pipeline\n", suffix: "\n\n\nDeploys are blocked when the pi" }, "Split this."),
      comment("c6", { kind: "text", quote: "no longer in the doc", prefix: "", suffix: "" }, "Gone."),
    ],
  };
  await writeFile(commentsPath, JSON.stringify(file, null, 2) + "\n");

  const listed = await run("comments", docPath);
  assert.equal(listed.code, 0);
  assert.equal(
    listed.stdout,
    [
      "c1  line 27",
      "quote: git tag once both stages pass",
      "note: Which tag?",
      "",
      "c2  line 30",
      "quote: Deploys are blocked when the",
      "note: Blocked by what?",
      "  Say which check.",
      "",
      "c3  line 16",
      'edge: B-->C "yes"',
      "note: Who approves?",
      "",
      "c5  line 3",
      `quote: ${longQuote.replace(/\s+/g, " ").slice(0, 120)} ...`,
      "note: Split this.",
      "",
      "c6  line ?",
      "quote: no longer in the doc",
      "note: Gone.",
      "",
    ].join("\n"),
  );

  const before = await readFile(commentsPath, "utf8");
  const unknown = await run("resolve", docPath, "c1", "c9");
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /unknown comment id: c9/);
  assert.equal(await readFile(commentsPath, "utf8"), before);

  assert.equal((await run("resolve", docPath, "c1", "c3")).code, 0);
  file.comments[0].status = "resolved";
  file.comments[2].status = "resolved";
  assert.equal(await readFile(commentsPath, "utf8"), JSON.stringify(file, null, 2) + "\n");
  assert.match((await run("comments", docPath)).stdout, /^c2 {2}line 30\n/);

  assert.equal((await run("resolve", docPath, "c2", "c5", "c6")).code, 0);
  assert.equal((await run("comments", docPath)).stdout, "no open comments\n");
});
