# Statusline

Independent Pi footer extension. Subagent execution does not depend on it, and the footer works without subagent.

## Load and controls

Load `statusline/index.ts` as a Pi extension, or load this directory as a Pi package. Keep the existing subagent and background-task entries if those tools are needed. Adding statusline does not replace either tool extension.

```text
/statusline on
/statusline off
```

The footer defaults to on when the extension loads. The toggle is runtime-only. Off restores Pi's built-in footer; on requests a current task snapshot. `/subagent-ui on|off` remains a separate subagent command for transcript cards and notices.

Pi has one footer slot. This extension does not arbitrate with other custom-footer extensions.

## Appearance

The main line shows workspace left and context usage plus `model · thinking` right. Workspace is accent-bold, context is success-colored, models are warning-bold, thinking is warning-colored and non-italic, and separators are dim. There is no background bar.

Worker rows use a compact hierarchy:

```text
↳ short topic   42s   model-a · high
↳ longer topic  2m08s longer-model · medium
```

- Topics use normal-weight body text, capped at 30 terminal columns.
- Topic and elapsed columns use widths calculated from the visible full rows. Pad on the right to align the next column.
- `model · thinking` is one left-aligned field. Do not pad model names within it.
- Prefix and middle dot are dim; elapsed is muted. Model and thinking use the same colors as the main line.
- Rows show live workers only. Remove a worker immediately on observed termination, without status text or completion retention.
- Show up to three worker lines. Above three workers, keep two full rows and combine remaining topics and elapsed times on the third.
- Sanitize controls and truncate by terminal columns. Narrow terminals may omit trailing fields. Do not fill unused terminal width.

## Data boundary

```text
subagent live-task cache ── snapshots ──► statusline footer
subagent completion ───────────────────► parent wake
```

Subagent publishes `subagent:tasks` with `{ owner, tasks }`. Statusline requests a snapshot through `subagent:tasks-request` with `{ owner, reply }`; the producer calls `reply({ owner, tasks })` synchronously. No producer means no worker rows. Owners are Pi session IDs.

Subagent owns live-task state and terminal tombstones. Statusline consumes complete snapshots and owns only presentation state. There are no statusline imports in subagent. Session changes discard old data; disposed producer generations cannot publish updates. Owner cleanup publishes an empty snapshot.

The footer timer repaints elapsed time; it does not inspect workers. Footer disposal clears the timer. Snapshot restoration supports either extension load order and off/on without replaying completion notices.

## Files and validation

- `index.ts`: footer lifecycle, snapshot consumer, and display command.
- `ui.mjs`: theme styling and terminal-width layout.
- `test/`: standalone and combined lifecycle tests plus layout contracts.

Tests need `PI_PACKAGE_DIR` pointing at the installed `@earendil-works/pi-coding-agent` package:

```bash
npm --prefix statusline test
```
