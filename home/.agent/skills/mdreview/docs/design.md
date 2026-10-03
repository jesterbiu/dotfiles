# mdreview: agent-agnostic review of markdown design docs

Status: design accepted for a first version. Built 2026-10-02. Open questions at the end.

## Problem

Current loop: an agent writes a design doc in markdown, the reviewer adds inline comments by hand, the agent is told to review again. Inline comments pollute the doc, anchoring is imprecise, and diagrams cannot be commented on by part. Claude Docs and Artifacts solve this but only for Claude, and the reviewer uses several coding agents daily.

## Decision: files are the contract

- The doc stays plain markdown with mermaid fenced blocks. Every agent can read and write it, it diffs, and mermaid node ids give diagrams stable addresses.
- Comments live in a separate file next to the doc, `<doc>.comments.json`. The doc is never modified by commenting.
- The viewer is replaceable. The file format is the durable part.

Rejected: inline markup such as CriticMarkup (pollutes the doc), GitHub PR review (needs a remote, anchors on source lines not rendered shapes), Google Docs or Claude Docs (vendor-bound, diagrams become images or Claude-only widgets).

## Comment file

```json
{
  "doc": "design.md",
  "nextId": 3,
  "comments": [
    {
      "id": "c1",
      "anchor": { "kind": "text", "quote": "exact selected text", "prefix": "text before", "suffix": "text after" },
      "text": "reviewer note",
      "status": "open",
      "created": "2026-10-02T10:00:00Z"
    },
    {
      "id": "c2",
      "anchor": { "kind": "diagram", "diagram": 0, "target": "node", "id": "A", "label": "Build and test" },
      "text": "reviewer note",
      "status": "open",
      "created": "2026-10-02T10:01:00Z"
    }
  ]
}
```

- Text anchor: `quote` is the exact selected text from the rendered page. `prefix` and `suffix` (up to 32 characters each) disambiguate repeats. Covers prose, headings, tables, and code blocks.
- Diagram anchor: `diagram` is the zero-based index of the mermaid block in the doc. `target` is `node` or `edge`. `id` is the mermaid source id. `label` is the rendered text so an agent can find it in the source.
- `status` is `open` or `resolved`. No replies or threads in the first version.
- Ids are `c<n>`, monotonically increasing, never reused. `nextId` holds the next number so a deleted highest id is not handed out again; if it is missing, the server uses the highest id plus one.
- The server assigns `id`, `status`, and `created`. The page sends new comments without them.

## Viewer

`node ~/src/mdreview/bin/mdreview.js <doc.md> [--port N]` serves one page on localhost.

- Renders markdown and mermaid blocks.
- Select text, or click a mermaid node or edge, to add a comment.
- Open comments are highlighted in place. Resolved ones are muted. Sidebar lists all comments with Resolve, Reopen, and Delete.
- A text anchor that no longer matches the doc is shown as orphaned, not dropped.
- The page polls doc and comment file mtimes every 2 seconds and re-renders, so agent edits and resolutions show up without a reload.
- Server has no npm dependencies. The page loads marked and mermaid from a CDN.

## Agent rule

Paste into any agent's instruction file:

When asked to address comments on `<doc>.md`, read `<doc>.md.comments.json`. For each comment with status `open`, locate the anchor in the doc, make the change in the doc or report back if you disagree, then set that comment's `status` to `resolved`. Never delete comments, edit their `text`, change `created`, or renumber ids.

## Rollout for daily use

Decided 2026-10-03.

- The tool is a self-contained skill directory at `~/.agent/skills/mdreview`: `SKILL.md` at the root, code in `bin/`, `lib/`, `public/`, this `docs/`. Agents that read skills get a symlink: `~/.claude/skills/mdreview`, later `~/.codex/skills/mdreview`.
- One long-lived server, `mdreview serve [--port 4747]`, run as a systemd user service. A doc is viewed at `http://localhost:4747/<path relative to home>`, so `~/src/x/design.md` is `http://localhost:4747/src/x/design.md`. The server joins the path onto the real path of home and refuses anything resolving outside it. Reads are limited to markdown under the home directory. The only write is `<doc>.comments.json` next to a served doc. Page assets and the API live under a reserved prefix.
- Agents never talk to the server. They write the doc, print its URL, and use the CLI for comments:
  - `mdreview comments <doc.md>` prints open comments with the source line each anchors to. Anchors are rendered text, so the CLI does the markdown-aware matching once instead of every agent doing it.
  - `mdreview resolve <doc.md> <id>...` sets status to resolved and nothing else.
- `*.comments.json` is ignored globally in git. Resolutions land in the doc, which is the record.
- The skill says: when writing a design doc, write it and print its review URL; when asked to address comments, run `comments`, address each open one in the doc or report disagreement, run `resolve` for the ones changed, report grouped by topic; touch only the doc and its comments file.

## Directory browsing

Added 2026-10-03. A URL whose path is a directory under home, including `/` for home itself, renders a file explorer instead of a doc: subdirectories and `.md` files, directories first, dotted entries included, a link to the parent, and for each doc the count of open comments when a `.comments.json` exists. Clicking a directory drills down, clicking a doc opens its review page. The same home restriction applies. Server-rendered HTML, no page script.

## Open questions

- Replies: should the agent be able to answer in the comment file (a `reply` field or a thread) instead of only in chat? Deferred until the flat loop has been used.
- Diagram anchors depend on the DOM ids mermaid emits, which vary by mermaid version. Pin the CDN version.
- Ordering for the agent: comments are listed in creation order, not document order. Decide whether the viewer should sort by position.
- Whether to vendor marked and mermaid for offline use. Pinned for now: marked 18.0.14, mermaid 11.15.0.
- Edge anchors depend on the `L_A_B_n` ids mermaid emits; user-defined edge ids and non-flowchart diagram types are untested.
- The page re-reads the comments file before each write. An agent writing between that read and the write loses one side. Acceptable while one human and one agent take turns.
