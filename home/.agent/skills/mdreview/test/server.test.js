import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, copyFile, readFile, readdir, writeFile, symlink, rm, chmod } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../lib/server.js";

const fixture = new URL("./fixtures/design.md", import.meta.url);
const tmpRoot = fileURLToPath(new URL("./tmp/", import.meta.url));

test("server serves markdown and directory listings under home by home-relative path and keeps a pretty-printed comments file next to each doc", async (t) => {
  await mkdir(tmpRoot, { recursive: true });
  t.after(() => rm(tmpRoot, { recursive: true, force: true }));
  const dir = await mkdtemp(join(tmpRoot, "server-"));
  const docPath = join(dir, "design.md");
  const commentsPath = `${docPath}.comments.json`;
  const docUrlPath = `/${relative(homedir(), docPath)}`;
  await copyFile(fixture, docPath);

  const outsideDir = await mkdtemp(join(tmpdir(), "mdreview-"));
  t.after(() => rm(outsideDir, { recursive: true, force: true }));
  const outside = join(outsideDir, "outside.md");
  await writeFile(outside, "# Outside\n");
  await symlink(outside, join(dir, "escape.md"));
  await writeFile(join(dir, "notes.txt"), "not markdown\n");

  const { server, url } = await startServer({ port: 0 });
  t.after(() => server.close());
  const api = (name, path = docUrlPath) => `${url}/_/api/${name}?path=${encodeURIComponent(path)}`;
  async function putComments(comments, path) {
    const res = await fetch(api("comments", path), { method: "PUT", body: JSON.stringify({ comments }) });
    assert.equal(res.status, 200);
    return res.json();
  }

  const homeListing = await fetch(`${url}/`);
  assert.equal(homeListing.status, 200);
  assert.match(homeListing.headers.get("content-type"), /text\/html/);
  const homeHtml = await homeListing.text();
  assert.match(homeHtml, /<h1>~<\/h1>/);
  assert.doesNotMatch(homeHtml, />\.\.\/</);
  assert.doesNotMatch(homeHtml, /<script/);

  const tree = await mkdtemp(join(tmpRoot, "tree-"));
  const treeUrlPath = `/${relative(homedir(), tree)}`;
  await mkdir(join(tree, "R&D"));
  await mkdir(join(tree, ".hidden"));
  await writeFile(join(tree, "plain.md"), "# Plain\n");
  await writeFile(join(tree, "commented.md"), "# Commented\n");
  await writeFile(
    join(tree, "commented.md.comments.json"),
    JSON.stringify({ comments: [{ id: "c1", status: "open" }, { id: "c2", status: "resolved" }] }),
  );
  await writeFile(join(tree, "broken.md"), "# Broken\n");
  await writeFile(join(tree, "broken.md.comments.json"), "{");
  await writeFile(join(tree, "notes.txt"), "not markdown\n");
  const treeListing = await fetch(`${url}${treeUrlPath}/`);
  assert.equal(treeListing.status, 200);
  assert.match(treeListing.headers.get("content-type"), /text\/html/);
  const treeHtml = await treeListing.text();
  assert.match(treeHtml, new RegExp(`<h1>~${treeUrlPath}</h1>`));
  const links = [...treeHtml.matchAll(/<a href="([^"]*)">([^<]*)<\/a>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(links, [
    [`${treeUrlPath.slice(0, treeUrlPath.lastIndexOf("/"))}/`, "../"],
    [`${treeUrlPath}/.hidden/`, ".hidden/"],
    [`${treeUrlPath}/R%26D/`, "R&amp;D/"],
    [`${treeUrlPath}/broken.md`, "broken.md"],
    [`${treeUrlPath}/commented.md`, "commented.md"],
    [`${treeUrlPath}/plain.md`, "plain.md"],
  ]);
  assert.match(treeHtml, /commented\.md<\/a> <span class="open">1 open<\/span>/);
  assert.match(treeHtml, /broken\.md<\/a><\/li>/);
  assert.match(treeHtml, /plain\.md<\/a><\/li>/);
  assert.doesNotMatch(treeHtml, /notes\.txt/);
  assert.doesNotMatch(treeHtml, /<script/);
  for (const [href] of links) assert.equal((await fetch(`${url}${href}`)).status, 200, href);

  const locked = join(tree, "locked");
  await mkdir(locked);
  await chmod(locked, 0o000);
  assert.equal((await fetch(`${url}${treeUrlPath}/locked/`)).status, 403);
  await symlink(outsideDir, join(tree, "outside"));
  assert.equal((await fetch(`${url}${treeUrlPath}/outside/`)).status, 403);
  assert.equal((await fetch(`${url}/..%2F..%2F`)).status, 403);
  assert.equal((await fetch(`${url}${treeUrlPath}/missing/`)).status, 404);

  const page = await fetch(`${url}${docUrlPath}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(await page.text(), /src="\/_\/app\.js"/);
  assert.equal((await fetch(`${url}/_/app.js`)).status, 200);
  assert.equal((await fetch(`${url}/_/anchor.js`)).status, 200);

  const doc = await fetch(api("doc")).then((r) => r.text());
  assert.equal(doc, await readFile(docPath, "utf8"));
  assert.match(doc, /```mermaid/);

  assert.deepEqual(await fetch(api("comments")).then((r) => r.json()), { doc: "design.md", nextId: 1, comments: [] });
  const before = await fetch(api("mtimes")).then((r) => r.json());
  assert.ok(before.doc > 0);
  assert.equal(before.comments, 0);

  const textAnchor = { kind: "text", quote: "pipeline", prefix: "every push. The ", suffix: " must stay" };
  const diagramAnchor = { kind: "diagram", diagram: 0, target: "node", id: "A", label: "Build and test" };
  const written = await putComments([
    { anchor: textAnchor, text: "Say which pipeline." },
    { anchor: diagramAnchor, text: "Split build and test." },
  ]);
  assert.deepEqual(written.comments.map((c) => [c.id, c.status]), [["c1", "open"], ["c2", "open"]]);
  assert.match(written.comments[0].created, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);

  const raw = await readFile(commentsPath, "utf8");
  assert.equal(raw, JSON.stringify(written, null, 2) + "\n");
  assert.deepEqual(Object.keys(written.comments[1]), ["id", "anchor", "text", "status", "created"]);
  assert.deepEqual(written.comments[1].anchor, diagramAnchor);
  assert.deepEqual(await fetch(api("comments")).then((r) => r.json()), written);
  assert.ok((await fetch(api("mtimes")).then((r) => r.json())).comments > 0);

  const resolved = { ...written.comments[0], status: "resolved" };
  await putComments([resolved]);
  const afterDelete = await putComments([resolved, { anchor: textAnchor, text: "Again." }]);
  assert.deepEqual(afterDelete.comments.map((c) => [c.id, c.status]), [["c1", "resolved"], ["c3", "open"]]);

  const agentEdit = JSON.parse(await readFile(commentsPath, "utf8"));
  delete agentEdit.nextId;
  agentEdit.comments[1].status = "resolved";
  await writeFile(commentsPath, JSON.stringify(agentEdit, null, 2));
  const afterAgent = await putComments([...agentEdit.comments, { anchor: diagramAnchor, text: "New." }]);
  assert.deepEqual(afterAgent.comments.map((c) => [c.id, c.status]), [["c1", "resolved"], ["c3", "resolved"], ["c4", "open"]]);

  assert.equal((await fetch(api("comments"), { method: "PUT", body: "{" })).status, 400);
  assert.equal((await fetch(api("comments"), { method: "PUT", body: "{}" })).status, 400);
  assert.equal((await fetch(`${url}/_/nope`)).status, 404);

  const refused = [
    `/${relative(homedir(), outside)}`,
    `${docUrlPath}/../escape.md`,
    `${docUrlPath}.comments.json`,
    `/${relative(homedir(), join(dir, "notes.txt"))}`,
  ];
  for (const path of refused) {
    assert.equal((await fetch(api("doc", path))).status, 403, path);
    assert.equal((await fetch(api("comments", path), { method: "PUT", body: '{"comments":[]}' })).status, 403, path);
  }
  assert.equal((await fetch(`${url}${docUrlPath}/../escape.md`)).status, 403);
  assert.equal((await fetch(`${url}${docUrlPath.replace("design.md", "missing.md")}`)).status, 404);
  assert.deepEqual(await readdir(outsideDir), ["outside.md"]);

  await assert.rejects(startServer({ port: server.address().port }), { code: "EADDRINUSE" });
});
