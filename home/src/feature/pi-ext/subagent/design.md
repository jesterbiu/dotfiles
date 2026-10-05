# One-task subagent extension

## Accepted design

Each worker owns a fresh Pi session for one task. `background_task` owns process launch, observation, deadlines, and cleanup. Subagent owns admission, result publication, and delegated-work notices. There is no persistent idle worker.

```text
Parent subagent tool → nested background_task → tmux → worker → Pi SDK
          └──────────── private Unix socket ────────────┘

Worker: start → busy ← steering → agent_settled → result.json → dispose → exit
Parent: background process event → read result → one subagent completion notice
```

No second process observer, filesystem result watcher, tmux keystroke channel, or blocking wait API.

## API and configuration

The callable, read-only `model_list(query?)` tool awaits `ctx.modelRegistry.refresh()` with a 15-second timeout, then reads `ctx.modelRegistry.getAvailable()`. Use the parent `/model` all-scope chat snapshot, including Pi's authentication and provider model filters, not the scoped cycling list. Refresh can fall back to cached models. Parent-discoverable models are subagent candidates, not a guarantee of worker availability. An omitted query lists all available models; otherwise match a case-insensitive substring across provider, model ID, and display name. Return `{ models: ['provider/model-id', ...] }` sorted by exact ID, with all matches and no automatic selection. Declare `outputSchema` and return `structuredContent` for codemode callers as well as text for direct calls. No separate worker catalog, custom credential checks, aliases, fuzzy launch resolution, or provider-filter input. Worker startup remains authoritative.

The model-only `subagent` tool supports:

- `start(task, model, topic?, cwd?, thinkingLevel?, timeoutSeconds?, statusReport?)`: start a fresh task and return promptly. `topic` is a short footer label; task text is the fallback.
- `send(taskId, message, messageId?)`: steer an active task only.
- `list()`: reconcile this parent's subagents.
- `cancel(taskId)` and `cancelAll()`: cancel only this parent's subagents.

The model must be an exact `provider/model-id`. Omitted thinking level inherits the launching parent's current level, subject to Pi's model clamp. Record requested selection in the manifest and effective selection in `resolved.json` before the initial prompt.

No parent transcript copy or fork/resume input. Forking prior context into a fresh worker is selected for future continuation but deferred. Each future continuation must have its own task ID, transcript, deadline, and result artifact; direct shared-transcript resume is not selected.

Use the controlled resource set described in `README.md`. Before SDK services, initialize Pi's HTTP dispatcher from agent-directory `httpProxy`, preserving CLI environment precedence. Ignore project proxy settings. Do not copy credentials or proxy URLs into manifests.

The workspace is shared. Separate conversations are not filesystem isolation. The parent coordinates writes and reviews changes. Worktree creation, merging, locking, and rollback are outside this extension.

## Admission and settlement

Call `session.prompt()` once. Initial admission follows Pi's preflight disposition. Open the socket only after admission; sends during startup can report `not_sent`. Use `session.steer()` for later guidance, never another prompt. Acknowledgements report admission, not completed work.

Close admission synchronously on `agent_settled`, not `agent_end`. Pi can retry, recover, or process steering after a low-level run ends. Serialize durable request and result writes. Retain UUID duplicate detection for the worker lifetime; identical retries return the same outcome. A steering/settlement race can reject late guidance but must not start new work.

On settlement, write one immutable `result.json`, dispose the SDK runtime, and exit. No numbered results, accumulator reset for another task, or idle follow-up. A worker-written JSON envelope requires no provider schema support. Use authoritative assistant messages for final text and failure evidence, not the model's self-assessment.

Failed results retain available partial assistant text in the artifact only. Notices never inline answers. Keep raw failure detail in diagnostic artifacts; bounded reported errors redact selected sensitive patterns without inventing diagnoses.

## State, persistence, and output

Keep separate:

- Process outcome from background-task.
- Conversation phase from worker state, overridden by known process termination.
- Task result from `result.json`; unavailable when absent after termination, unknown when unreadable.

A successful process exit is not delegated-work success; successful work status is not proof of correctness. A hard termination can prevent finalization. Cancellation is pane-level best effort and can race a worker's graceful result write. Notices report available evidence; later list/file reads can reveal output published after the notice.

Persist private version 2 manifests and background task bindings. Pass only the manifest path to the worker command. Wait up to 30 seconds for binding before SDK initialization. Startup failures publish failed results when possible. Atomic rename prevents readers from seeing partial JSON but does not guarantee power-loss durability.

The Pi session file is the transcript. `state.json` holds usage and admitted message IDs. The child is a separate process; its usage is not added to parent totals. Artifact filenames and wire fields are documented in `README.md`.

The subagent and background_task tools return lean identity/state/recovery information and one `artifacts` root. Detailed metadata stays in files. Omit absent optional fields and empty error collections. Preserve uncertain-delivery message IDs and actual inspection errors.

## Ownership and notifications

The parent session ID owns the launch; the background task ID is the public task ID. The child Pi session ID is separate. List and cancellation must not affect unrelated shell tasks.

Persist `notificationTarget: 'subagent'` on delegated background tasks. Background-task emits their compact process events on `background-task:subagent` with the owner ID instead of sending a parent custom message. Standalone tasks keep background-task notices. Subagent filters owner, waits for pending binding publication, reads the result, and deduplicates completion in memory before delivery. Async event listeners catch their own failures because Pi's event bus does not await them.

Termination notices use `triggerTurn: true` and `deliverAs: 'followUp'`: an idle parent starts a turn; a busy parent queues follow-up work instead of interrupting the active turn. Periodic status does not wake the parent. Notices remain best effort and do not replay after reload. List and artifacts remain authoritative after a missed event. Routine polling is unnecessary. Scheduled reports describe process state, not model progress. Controlled owner cleanup stays silent; standalone background-task notices keep their non-waking behavior.

Turn abort and reload preserve workers. Session replacement and controlled exit use background-task cleanup. Cancellation closes admission and asks the worker to stop, then uses background cancellation as a backstop. Dispose the complete SDK runtime, not only the session. `timeoutSeconds` limits total worker lifetime; deadlines and reports need an active parent observer.

## Footer and transcript UI

The separate [statusline extension](../statusline/README.md) owns the supported custom footer. Subagent only publishes owner-scoped live-task snapshots and never calls `setFooter()`. The first line shows workspace left and context usage plus `model · thinking` right, highlighted with active theme colors. Up to three further rows show this parent's subagents:

```text
workspace                            context usage  model · thinking
↳ first topic   2m10s model · high
↳ second topic  45s   model · medium
third topic 30s | fourth topic 12s | ...
```

With three or fewer agents, render one full row per agent. With more than three, the first two keep model/thinking; the third combines topics and elapsed times for agents 3..N. The main line uses foreground-only theme colors per item and no background bar. Full rows have a dim `↳` prefix, normal-weight body-text topics capped at 30 columns, and shared left-aligned topic and elapsed columns. The final `model · thinking` field is combined, with no padding inside it. Models use warning bold; thinking uses warning without italic. Separators are dim. There is no status column or line-end fill. Sanitize controls and truncate by terminal columns with `...`; never exceed the supplied width, including on Unicode or narrow terminals.

Persist topic and start time. Compute the initial thinking label with Pi's clamp against the selected parent model, then prefer worker-resolved configuration when available during an update. Remove the row immediately on observed termination, without completed-row retention. Keep outcomes in notices and result artifacts, not footer status fields. Timer ticks repaint elapsed time; they do not inspect tmux.

Restore active rows from a metadata-only background-task snapshot, read under its existing per-task locks. Skip and report unreadable records without losing healthy rows or preventing footer installation. An observer-ready event supports either extension load order. Suppress delegated events from startup reconciliation so reload does not wake the parent or re-show old completions. Publish `subagent:tasks` with `{ owner, tasks }` and reply synchronously to `subagent:tasks-request` with the same snapshot. Clear the live-task cache on owner cleanup and reject callbacks from disposed controllers. Statusline owns footer state and timers. Publish completion independently of optional display listeners.

Hide subagent call/result cards and completion/status notices from the UI by default, while preserving their model-visible content, tool details, and diagnostic artifacts. `/subagent-ui on|off` switches transcript detail at runtime, not parent wake. When loaded, statusline supplies the footer. `/subagent-ui` invalidates tool renderers independently of that extension. Model discovery and standalone background-task UI are not hidden.

## Unreadable records

Unreadable ownership or binding records block launch. They need explicit inspection; do not infer safe cleanup from missing evidence.

## Implementation boundaries

- `index.ts`: callable model discovery, model-only subagent schema, exact model resolution, lifecycle hooks, and event-bus listener.
- `controller.mjs`: owner-scoped records, nested background-tool calls, socket client, compact views, footer snapshots/updates, and notices.
- `tasks.mjs`: presentation-neutral live-task cache and terminal tombstones.
- `ui.mjs`: switchable tool-card rendering.
- `../statusline/`: independent footer ownership, controls, and terminal-width layout.
- `launch.mjs`: binding gate, effective configuration, startup failure, and signal cleanup.
- `worker.mjs`: one initial prompt, steering, duplicate detection, settlement, result publication, and exit.
- `pi-session.mjs`: controlled SDK services and proxy setup.
- `protocol.mjs`, `storage.mjs`: bounded socket framing, private files, and atomic metadata writes.
- `../background-task/output.mjs`: compact response and reported-error formatting shared by both tools.

## Regression contract

Primary slice: discover candidates → select exact model → start → steer → reload while busy → one result → worker exit → one subagent completion, without a background completion for that worker.

Cover omitted discovery query, case-insensitive provider/ID/name matches, no matches, multiple matches, structured codemode output, mandatory exact model selection, thinking inheritance/override/clamp, proxy traffic and precedence, controlled resources, duplicate steering, late rejection, startup and settled failure, retained partial answers, cancellation, hard-kill output unavailability, timeout, unreadable artifacts, standalone notices, and owner cleanup. Use fake or loopback providers; no paid model requests.

## Design limits

One controller per owner; no cross-process exactly-once guarantee, automatic restart, notification replay, or full diagnostic redaction. Descendant cleanup and notification delivery are best effort. Parent termination wakes can incur model usage. Private sockets and controlled resources are not a sandbox.

See `README.md` for loading and operational limits.
