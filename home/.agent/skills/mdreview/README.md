# mdreview

A local review loop for markdown design docs that works with any coding agent.

You read the rendered doc in the browser and comment on a text selection or on a mermaid node or edge. Comments are saved to a JSON file next to the doc. Any coding agent (Claude Code, Codex, and others) lists them with `mdreview comments`, changes the doc, and marks them resolved with `mdreview resolve`. The page shows those changes within 2 seconds.

## Install

Requires Node 22. No npm install. The tool lives at `~/.agent/skills/mdreview`.

```sh
ln -s ~/.agent/skills/mdreview/bin/mdreview.js ~/.local/bin/mdreview
```

Server as a systemd user service, `~/.config/systemd/user/mdreview.service`:

```ini
[Unit]
Description=mdreview markdown review server

[Service]
ExecStart=/usr/bin/node %h/.agent/skills/mdreview/bin/mdreview.js serve --port 4747
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now mdreview
```

Skill for agents that read skills (`SKILL.md` in this directory):

```sh
ln -s ~/.agent/skills/mdreview ~/.claude/skills/mdreview
ln -s ~/.agent/skills/mdreview ~/.codex/skills/mdreview
```

Ignore comment files in every git repo:

```sh
git config --global core.excludesFile '~/.config/git/ignore'
echo '*.comments.json' >> ~/.config/git/ignore
```

## Commands

```sh
mdreview serve [--port 4747]
mdreview comments <doc.md>
mdreview resolve <doc.md> <id>...
```

- `serve` runs one server on 127.0.0.1, port 4747 by default. It exits if the port is taken.
- `comments` prints each open comment as a block: the id and the source line its anchor points to, the quote (cut at 120 characters) or the diagram node/edge with its label, and the note. A diagram anchor points to the line of its mermaid fence. An anchor that no longer matches prints `line ?`. With no open comments it prints `no open comments`.
- `resolve` sets `status` to `resolved` on the given ids and changes nothing else in the file. If an id does not exist, it names it, exits 1, and writes nothing.

Text anchors hold rendered text, so `comments` matches them against the source after removing markdown syntax: whitespace, `` ` ``, `*`, `_`, `~`, `#`, `>`, `<`, `|`, list markers, link and image syntax, backslash escapes, and mermaid blocks.

## Review in the browser

Open a doc by its path relative to your home directory:

```
http://localhost:4747/src/project/docs/design.md  ->  ~/src/project/docs/design.md
```

A directory path lists its subdirectories and `.md` files with the number of open comments on each doc, so you can browse from `http://localhost:4747/` (the home directory) down to a doc. The server serves only `.md` files and directories whose real path is under the home directory; other paths get 403 or 404. The only file it writes is `<doc>.md.comments.json` next to a served doc.

In the page:

- Select text, click **Comment**, write the note, click **Save** (or Ctrl/Cmd+Enter).
- Click a mermaid node or edge to comment on it.
- Open comments are highlighted. Resolved comments are muted. A comment whose anchor no longer matches the doc is listed as **orphaned**.
- Click a sidebar entry to scroll to its anchor. Each entry has Resolve/Reopen and Delete.
- The page checks the doc and comments file every 2 seconds and shows changes made by agents.

The page loads marked 18.0.14 and mermaid 11.15.0 from cdnjs.cloudflare.com. Diagram anchors depend on the DOM ids mermaid emits, so the version is pinned.

Tests: `npm test` (runs `node --test`).

## File contract

For a doc at `path/to/doc.md`, comments live at `path/to/doc.md.comments.json`. The server creates the file on the first write. The server and `mdreview resolve` write it with 2-space indent and a trailing newline.

```json
{
  "doc": "doc.md",
  "nextId": 3,
  "comments": [
    {
      "id": "c1",
      "anchor": { "kind": "text", "quote": "exact selected text", "prefix": "up to 32 chars of text before", "suffix": "up to 32 chars of text after" },
      "text": "reviewer's note",
      "status": "open",
      "created": "2026-10-02T10:00:00Z"
    },
    {
      "id": "c2",
      "anchor": { "kind": "diagram", "diagram": 0, "target": "node", "id": "A", "label": "Build and test" },
      "text": "reviewer's note",
      "status": "open",
      "created": "2026-10-02T10:01:00Z"
    }
  ]
}
```

- `anchor.kind = "text"`: `quote` is the exact selected text as it appears in the text content of the rendered page (diagrams excluded). `prefix` and `suffix` are up to 32 characters before and after it, used to tell repeated quotes apart. Works for prose, headings, tables, and code blocks. A selection across table cells or block elements includes the newlines between them.
- `anchor.kind = "diagram"`: `diagram` is the zero-based index of the mermaid fenced block in the doc. `target` is `"node"` or `"edge"`. `id` is the mermaid node id, or `"A-->B"` for an edge from node `A` to node `B`. `label` is the rendered label text, so an agent can find it in the mermaid source. Unlabeled edges have an empty `label`.
- `status` is `"open"` or `"resolved"`.
- Ids are `c<n>`, increasing, never reused. `nextId` is the number for the next new comment; the server keeps it so ids of deleted comments are not handed out again. If `nextId` is missing, the server uses the highest existing id plus one.

### Server API

Page assets and the API live under `/_/`. `path` is the doc path relative to the home directory, the same as in the page URL.

| Method | Path | Result |
| ------ | ---- | ------ |
| GET | `/<path>` | the review page for a doc, or the listing for a directory (`/` is the home directory) |
| GET | `/_/app.js`, `/_/anchor.js` | page scripts |
| GET | `/_/api/doc?path=` | raw markdown |
| GET | `/_/api/comments?path=` | comments file, or an empty one if it does not exist yet |
| PUT | `/_/api/comments?path=` | replace all comments with `{ "comments": [...] }`; entries without `id` get a new id, `status: "open"`, and `created` |
| GET | `/_/api/mtimes?path=` | `{ "doc": ms, "comments": ms }`, `0` for a missing file |

## Instructions for agents

Agents that read skills get `SKILL.md` through the symlinks above. For other agents, paste this into the instruction file:

```
After writing or updating a markdown design doc, print its review URL:
http://localhost:4747/ followed by the doc path relative to the home directory.
When asked to address comments on <doc>.md, run `mdreview comments <doc>.md`.
For each open comment, read the doc around the printed line, make the change
in the doc or report back if you disagree, then run
`mdreview resolve <doc>.md <ids>` for the ones you changed.
Never delete comments, edit their text, or renumber ids. Never call the server.
```
