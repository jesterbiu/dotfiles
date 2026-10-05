# One-task Pi subagents

Local extension built on `../background-task/`. Requires Node.js, POSIX Unix sockets, tmux, and the Node-based Pi package.

## Load

Load both extensions from the repository root:

```bash
pi --no-extensions \
  --extension ./background-task/index.ts \
  --extension ./subagent/index.ts \
  --background-task-server pi-subagent-try
```

Or add both directories to `packages` in Pi settings:

```json
{ "packages": ["<path>/pi-ext/background-task", "<path>/pi-ext/subagent"] }
```

Relative package paths resolve from the settings file directory. Use a dedicated tmux server. Keep `background_task` active and callable. Subagent invokes it through Pi's nested tool API; subagent itself is model-only, not callable through codemode or other tools.

Starting a worker can incur model usage costs. Loading the extension does not start workers.

## Tool API

### Model discovery

Call the read-only `model_list` tool with `{ "query": "astra" }` to search without knowing the provider, or `{}` to list models available in the parent `/model` all scope. Query uses a case-insensitive substring match on provider, model ID, and display name. It returns `{ "models": ["provider/model-id", "..."] }` sorted by exact ID. All matches are returned; select an exact ID for `subagent.start.model`.

Discovery awaits `ctx.modelRegistry.refresh()` with a 15-second timeout, then uses `ctx.modelRegistry.getAvailable()`. This matches the available chat-model snapshot used by `/model` in its all scope, including Pi's provider authentication and model filters. Scoped cycling preferences do not restrict discovery. Refresh can fall back to cached models, as the selector does. There is no separate worker catalog. A listed model is not guaranteed to start in the worker; worker startup remains authoritative. There are no aliases, fuzzy launch resolution, or provider-filter input.

`model_list` is directly available and callable while active. It declares an output schema and returns structured data, so codemode can use `const { models } = await tools.model_list({ query: "astra" });`.

### Delegation

```json
{ "action": "start", "task": "Inspect the parser. Do not edit files.", "model": "provider/model-id", "timeoutSeconds": 600 }
{ "action": "send", "taskId": "...", "message": "Focus on malformed input." }
{ "action": "list" }
{ "action": "cancel", "taskId": "..." }
{ "action": "cancelAll" }
```

`start` requires an exact `model: "provider/model-id"`. Optional inputs are `topic`, `cwd`, `thinkingLevel`, `timeoutSeconds`, and `statusReport: { afterSeconds, repeat? }`. `topic` is a short label for the footer; task text is used when it is absent. Thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Omission inherits the launching parent's current thinking level. Pi may clamp it for the selected model; `resolved.json` records the effective selection.

Start returns promptly with `taskId`, `process`, `phase`, and one `artifacts` directory. Requested deadline/report settings are also returned. It does not wait for child initialization. Read `result.json` under `artifacts` for the answer. There is no wait action.

Each worker handles one task. There is no idle follow-up, numbered result, fork, or resume parameter. Independent work needs a fresh start with explicit context. Forking prior conversation context is selected for future continuation but deferred.

### Steering

`send` queues guidance only while the worker accepts input. It uses Pi's steering boundary after the active turn and tools. It cannot interrupt a tool or undo edits. The initial task is admitted before the control socket opens; an early send can fail with `delivery: "not_sent"`.

The acknowledgement contains `taskId`, `messageId`, and Pi's `queued` or `handled` disposition. Admission is not completion. Several guidance messages can contribute to one result. Settlement closes admission synchronously; late guidance cannot start another run.

Failed socket requests report delivery:

| Value | Meaning |
|---|---|
| `not_sent` | No request was submitted. The socket may not be ready or reachable. |
| `rejected` | The worker refused the request. |
| `unknown` | Submitted, but no acknowledgement arrived. The worker may have accepted it. |

The client timeout is 5 seconds; the server's idle-connection timeout is 10 seconds. An optional UUID `messageId` provides duplicate detection for one worker lifetime. After unknown delivery, reuse the same ID and identical text. Never replay to a new worker. There is no automatic replay or restart.

Accepted operations are not tied to the parent turn's abort signal.

## Lifecycle and notices

```text
start → initialize → busy ← steering
                      ↓ agent_settled
                 close admission
                      ↓
                 result.json
                      ↓
                 dispose → exit
                      ↓
background process observer → one subagent completion notice
```

Keep three meanings separate:

| Field | Meaning |
|---|---|
| `process` | Background process state: `running`, `succeeded`, `failed`, `cancelled`, `timed_out`, or `unknown` |
| `phase` | Conversation state: `starting`, `busy`, `stopping`, `terminated`, or `unknown` |
| `result` | Observed result status: `succeeded`, `failed`, `unavailable`, or `unknown` for unreadable output |

A clean process exit does not establish task success. Successful task status does not prove the delegated work is correct. Failure does not prove that no edits occurred. A hard kill can leave no result. Cancellation first sends stop, then uses background-task cancellation as a backstop. A worker may still finalize output after pane removal; notices report the evidence available when observed, and later list/file reads can reconcile it.

Only subagent notices reach the parent for subagent-owned tasks. They combine process evidence with the persisted result and contain no answer text. Failed notices include bounded, sanitized reported errors, not a diagnosis. Standalone background tasks retain their own notices.

A termination notice wakes an idle parent or queues follow-up work when the parent is busy (`triggerTurn: true`, `deliverAs: 'followUp'`). This can incur parent model usage. Scheduled status notices do not wake the parent. Delivery remains best effort with no replay after reload. Routine polling is unnecessary. Use `list` after interruption or a missed notice; persisted output remains available. Controlled owner cleanup remains silent.

`timeoutSeconds` limits total worker lifetime. Deadlines and status reports require an active parent observer. Turn abort and reload preserve workers. Session replacement and controlled exit cancel them through background-task. List and cancellation affect only this session's subagents, not unrelated shell tasks.

## Footer and transcript UI

The separate [statusline extension](../statusline/README.md) owns the footer. Load it explicitly to show one foreground-styled main line and at most three subagent rows. Subagent itself does not install a footer:

```text
workspace                            context usage  model · thinking
↳ first topic   2m10s model · high
↳ second topic  45s   model · medium
third topic 30s | fourth topic 12s | ...
```

With three or fewer agents, each row includes topic, model, thinking level, and elapsed time. With more than three, the first two retain full rows and the third combines topics and elapsed times for the remaining agents. Rows truncate with `...` to fit terminal display width. The main line uses foreground-only theme colors for each item and no background bar. Full rows have a dim `↳` prefix, normal-weight body-text topics capped at 30 columns, and shared left-aligned topic and elapsed columns. The final `model · thinking` field is combined, with no padding inside it. Models use warning bold; thinking uses warning without italic. Separators are dim. There is no status column or line-end fill.

Rows disappear immediately on observed termination, with no completed-row retention. Outcomes remain in notices and result artifacts. Reload restores active agents without replaying old completion notices or re-showing finished rows. Timer updates repaint the display, not poll processes.

Subagent tool cards and completion/status notices are hidden from the transcript UI by default. Their content still reaches the model and remains available in the transcript and artifacts. To show or hide detail for debugging:

```text
/subagent-ui on
/subagent-ui off
```

The switch is runtime-only, works without statusline, and does not change parent wake behavior. `/statusline on|off` independently controls the footer. Notice visibility is set when the notice is sent; switching on does not reveal earlier hidden notices. Model discovery and standalone background-task cards/notices remain visible.

## Artifacts

Stored under `<agent-dir>/subagents/<owner-hash>/<launch-id>/`:

| File | Content |
|---|---|
| `manifest.json` | Version 2 launch input, owner, topic/start time, model/thinking selection, cwd, SDK and socket paths |
| `binding.json` | Background task ID and process artifact root |
| `resolved.json` | Effective model, thinking level, tools, and child session identity; written before prompting |
| `state.json` | Conversation phase, message IDs, accumulated assistant usage, and result status |
| `requests.jsonl` | Admitted messages and acknowledgements |
| `sessions/` | Pi transcript |
| `result.json` | One immutable worker-written result |
| `failure.json` | Raw run failure detail, when present |
| `launch-error.json`, `startup-error.json` | Launch or initialization diagnostics, when present |

Successful result:

```json
{ "status": "succeeded", "answer": "Reviewed the parser." }
```

Failed result with available partial text:

```json
{ "status": "failed", "answer": "Partial findings", "reportedError": { "source": "sdk", "message": "fetch failed" } }
```

The worker serializes the envelope; the model supplies answer text. No model-output schema is enforced. Result publication uses temporary-file rename. There is no power-loss durability guarantee. Compaction and the full transcript remain in the Pi session file. Child usage is separate from parent totals.

Background-task keeps its own `metadata.json`, `stdout.log`, and `stderr.log`; find its artifact root in `binding.json` or background-task status. Returns omit empty error collections and detailed metadata. Errors retain identity, delivery uncertainty, and recovery locators where available.

## Limits

- Unreadable ownership/binding records block launch and require inspection.
- Children start fresh, with no parent transcript copy. Supply context in the task or files.
- Tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`. System prompt: Pi defaults, a fixed delegate instruction, and applicable `AGENTS.md` files. No `.pi/SYSTEM.md`, user/project extensions, skills, prompt templates, themes, or project settings. Parent permission hooks and runtime-only providers are not inherited.
- Before SDK services, read agent-directory `httpProxy` and initialize Pi's HTTP dispatcher. Existing proxy environment variables retain Pi CLI precedence. Project proxy settings are ignored; proxy URLs are not copied into launch artifacts.
- Credentials and provider definitions come from the agent directory and worker environment. The shared tmux environment can predate the parent. SDK hosts must keep `PI_CODING_AGENT_DIR` consistent with their agent directory.
- This is not a sandbox. Children share OS permissions and workspace access. Assign non-overlapping write scopes. No automatic worktrees, merge, rollback, or file locking.
- Private sockets use temporary directories to avoid long paths. Graceful exit removes them; failed launches and hard kills can leave them behind. The manifest identifies them.
- The worker waits at most 30 seconds for a durable task binding before failing without model requests. A parent failure during launch can leave an unbound task; inspect both artifact roots rather than restarting blindly.
- One controller per parent owner. No cross-process lock, automatic restart, artifact deletion, log cap, or full diagnostic redaction. Reported errors redact selected URL/credential patterns and cap text at 300 characters; artifacts can contain secrets.
- Socket frames are limited to 1 MiB. Results have no size limit.

## Tests

```bash
cd subagent
npm test
PI_PACKAGE_DIR=/path/to/node_modules/@earendil-works/pi-coding-agent npm run test:pi
```

Tests use fake sessions, isolated agent directories, local providers, and a unique tmux server. The hard-kill integration case uses Linux `/proc`. No paid model requests. See `design.md` for architecture.
