---
name: mdreview
description: Use when writing or updating a markdown design doc, or when asked to address review comments on a markdown doc.
---

# mdreview

The reviewer reads markdown docs in a browser at `http://localhost:4747/<path relative to home>` and leaves comments in `<doc>.md.comments.json` next to the doc. The `mdreview` command lists and resolves those comments.

## After writing or updating a design doc

Print the doc's review URL: `http://localhost:4747/` followed by the doc path relative to the home directory.

```sh
echo "http://localhost:4747/$(realpath --relative-to="$HOME" docs/design.md)"
```

## When asked to address comments on a doc

1. Run `mdreview comments <doc.md>`. Each open comment prints its id, the source line its anchor points to (`line ?` when the anchor no longer matches), the quoted text or diagram node/edge, and the reviewer's note.
2. For each open comment, read the doc around that line. Make the change in the doc, or note why you disagree.
3. Run `mdreview resolve <doc.md> <id>...` for the comments you addressed with a change. Leave the ones you disagree with open.
4. Report back grouped by topic: what changed, and what you disagree with and why.

Rules:

- Touch only the doc and its `.comments.json`, and change the comments file only through `mdreview resolve`.
- Never delete comments, edit their text, or renumber ids.
- Never call the server.

## Comment file

`<doc>.md.comments.json` holds `{ "doc", "nextId", "comments": [...] }`. Each comment has `id` (`c<n>`), `anchor`, `text`, `status` (`open` or `resolved`), and `created`. A text anchor has `quote`, `prefix`, and `suffix` taken from the rendered page, so markdown syntax such as backticks and `**` is missing from them. A diagram anchor has the zero-based mermaid block index `diagram`, `target` (`node` or `edge`), the mermaid `id` (`A-->B` for an edge), and `label`. See `README.md` in this directory for the full format.
