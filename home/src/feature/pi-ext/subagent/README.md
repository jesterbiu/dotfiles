# Persistent Pi subagents

Local extension built on `../background-task/`. Requires Node.js, POSIX Unix sockets, tmux, and the Node-based Pi package.

## Load

Both extensions must be active. Load them explicitly from the repository root:

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

Relative package paths resolve from the settings file directory. Each `package.json` declares `pi.extensions`.

Use a dedicated tmux server, not your normal interactive server. Keep `background_task` active and callable. The subagent tool invokes it through Pi's nested tool API; it does not create another task manager. `send` checks the child's process state with the `status` action of that tool. Subagent is model-only, not callable through codemode or other tools.

Starting a child makes model requests and can incur usage costs. Loading the extension alone does not start children.

## Tool API

```json
{ "action": "start", "task": "Inspect the parser and report gaps. Do not edit files.", "timeoutSeconds": 600 }
{ "action": "send", "taskId": "...", "message": "Focus on malformed input." }
{ "action": "send", "taskId": "...", "message": "Now review the tests.", "mode": "followUp" }
{ "action": "list" }
{ "action": "cancel", "taskId": "..." }
{ "action": "cancelAll" }
```

`start` accepts optional `cwd`, exact `model: "provider/model-id"`, `timeoutSeconds`, and `statusReport: { afterSeconds, repeat? }`. The model and thinking level otherwise come from the parent at launch. Pi can clamp the thinking level for the selected model; `resolved.json` records the actual selection.

Start returns the background task ID and artifact paths before child initialization finishes. The initial task is admitted before the socket accepts follow-up messages.

There is no wait action. Read result files with normal file tools.

### Sending messages

- Busy + `steer` (default): queue guidance at a steering boundary, after active tools finish.
- Busy + `followUp`: queue work after the current run's tool and steering work.
- Idle: either mode starts another run in the same conversation.
- Stopping or terminated: reject new messages.

Steering does not interrupt a tool, undo an edit, or prove compliance.

An acknowledgement is Pi's admission decision for the message, and nothing else. It contains `messageId`, admission `order`, a disposition, and for `started` or `queued` the number of the result the message lands in:

| Disposition | Meaning | `result` |
|---|---|---|
| `started` | Pi was idle; a new run began | The next result number |
| `queued` | Pi was busy; the message joins the current run | The pending result number |
| `handled` | Pi consumed the input without a run | Absent |

Acknowledgements are not completed answers. Every settled run produces one numbered result, listing the messages that contributed. A run with no tracked message still produces a result with an empty list.

A failed send reports `delivery`:

| Value | Meaning |
|---|---|
| `not_sent` | No request reached the worker. The socket was not ready or not reachable. Retry is safe. |
| `rejected` | The worker refused the request, for example while stopping or on a `messageId` reuse with different input. |
| `busy` | Pi is compacting the conversation. Retry with the same `messageId` and input. |
| `unknown` | The request was submitted but no acknowledgement arrived in time. The worker may have accepted it. |

The client waits 5 seconds for an acknowledgement. The worker closes an idle connection after 10 seconds. A slow admission can produce `unknown` on the client while the worker still admits the message.

An optional UUID `messageId` provides duplicate detection while the worker lives. Reuse the same ID and identical message/mode after `delivery: "unknown"` or `"busy"`; the request may already have been accepted. A new ID creates new work. There is no automatic restart or replay.

Accepted operations are not tied to the parent turn's abort signal. A turn abort does not withdraw an accepted message or stop the worker.

## Lifecycle

```text
Parent tool ── background_task ── tmux ── worker ── Pi SDK session
     └──────── private Unix socket ────────┘

starting → idle ⇄ busy → stopping → terminated
                    └─ settled → numbered result + result-ready notice
```

An idle child still has a running background task. Agent errors produce failed results but leave the conversation available for follow-up. Initialization failure terminates the worker. Process status and result status are separate; neither proves the delegated work is correct.

Children stay alive until cancellation, total lifetime timeout, or owner cleanup. `timeoutSeconds` is not a per-message timeout. Turn abort and extension reload preserve children. Session replacement and controlled exit use background-task cleanup.

Cancellation first sends stop over the socket, then invokes background-task cancellation. On stop the worker closes admission, aborts the current run, writes its final result, and exits on its own; `stopping` lasts as long as the abort. Background-task cancellation is the backstop for a worker that does not exit. Descendant termination remains best effort.

`list` and `cancelAll` include only the current parent session's subagents, not unrelated shell tasks. Result-ready notices use filesystem events and `triggerTurn: false`; they neither poll tmux nor start a model turn. A launch's watcher ends when its state reads `terminated`, and terminated launches are not watched after reload. Notices are best effort, can coalesce, and do not replay on reload. List and persisted result files remain available.

## Artifacts

Stored under `<agent-dir>/subagents/<owner-hash>/<launch-id>/`:

| File | Content |
|---|---|
| `manifest.json` | Task, parent owner, requested model, cwd, SDK path, socket location |
| `binding.json` | Background task ID and process artifact paths |
| `resolved.json` | Child session identity, effective tools/model/thinking level |
| `state.json` | Last persisted conversation phase and latest result pointer |
| `requests.jsonl` | Accepted messages and acknowledgements |
| `sessions/` | Persistent Pi conversation |
| `results/000001.md` | Final assistant text for one settled run |
| `results/000001.json` | Result status, request IDs, usage, and answer path |
| `launch-error.json`, `startup-error.json` | Launch or initialization failure, when present |

The worker publishes result metadata before updating the state pointer. Prior results are not overwritten. Assistant-message usage is recorded per result, including intermediate responses. Compaction and the full transcript are in the Pi session file under `sessions/`. The child runs in a separate process, so its usage is not added to the parent's Pi totals.

Background-task retains its own metadata and stdout/stderr. Its process status overrides stale conversation state after termination. Unknown process outcomes remain unknown, not success. A hard kill can leave incomplete files without a final result.

## Configuration and limits

- Fresh conversation: no parent transcript copy. Supply the required context in the task or messages.
- Child tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`.
- System prompt: Pi's default system prompt, plus a fixed delegate instruction, plus applicable `AGENTS.md` context files. `.pi/SYSTEM.md`, user/project extensions, skills, prompt templates, themes, and project settings do not load. Parent permission hooks and runtime-only provider registrations are not inherited.
- Credentials and provider definitions come from the agent directory and the worker environment. Credentials are not copied into launch manifests. The shared tmux environment can predate the parent; prefer saved credentials over assuming new environment variables propagate. SDK hosts must keep `PI_CODING_AGENT_DIR` consistent with their agent directory.
- Conversations and private sockets are not sandboxes. Children have the same OS permissions and can use bash. The parent must coordinate writes. No automatic worktrees, merge, rollback, or file locking.
- Private Unix sockets use temporary directories to avoid long artifact paths. Graceful worker shutdown removes them; failed launches and hard kills can leave them behind. The socket location is in the manifest.
- A parent failure between background launch and binding can leave an unbound task. The worker waits at most 30 seconds for its binding before failing, without making model requests. Background-task remains its lifecycle owner.
- No idle timeout, automatic restart, cross-process controller lock, log rotation, redaction, or artifact deletion. Logs and transcripts can contain sensitive content. One controller per parent owner is supported.
- Requests and responses are limited to 1 MiB. Result files have no size limit. Delegated text is literal input, not a slash command.

## Tests

```bash
cd subagent
npm test
PI_PACKAGE_DIR=/path/to/node_modules/@earendil-works/pi-coding-agent npm run test:pi
```

Unit tests use fake sessions and background-tool outcomes. SDK tests use a stub stream and a loopback-only test provider, isolated agent directories, and a unique tmux server. They make no paid model requests.

See `design.md` for accepted design decisions, recommendations, and open questions.
