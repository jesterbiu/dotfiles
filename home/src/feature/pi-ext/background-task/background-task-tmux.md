# Pi background tasks through tmux

Accepted design.

## Goals

- Let a Pi agent launch non-interactive commands without holding the current turn open.
- Make task IDs, status, output files, and asynchronous notifications the agent interface. Keep tmux as an internal execution backend.
- Keep tasks owned by their Pi session. Cancel unfinished tasks on session discontinuation and controlled Pi process exit.
- Use ordinary metadata storage and best-effort pane cancellation, not a process supervisor or recovery framework.
- Own process observation for delegated workers while routing their notices through the subagent extension.

## Decisions

| Decision | Rationale and tradeoff |
| --- | --- |
| Interface: `start`, `status`, `list`, `cancel`, `cancelAll`. No `wait` API. | Completion is asynchronous. A blocking wait adds no required capability and must not drive a second polling path. |
| tmux is internal to the extension. | The agent uses task IDs and output paths, not tmux sessions, panes, or control commands. Diagnostics may identify a tmux resource when manual cleanup is needed. |
| Dedicated named tmux server, default `pi-tasks`, with `exit-empty off` and global `remain-on-exit on`, both set in the same tmux command list as each `new-session`, before the pane exists. | Isolates extension resources and avoids last-session shutdown/relaunch races. A pane that exits at once stays visible with its status. The empty server uses some idle memory. Ordinary cleanup must not kill the shared server. |
| One detached tmux session with one pane per task. | Provides a simple task creation and cancellation boundary. |
| Internal name `pi-<encoded-owner-id>-<task-id>`. | Enables owner-scoped discovery and cleanup without an in-memory task registry. Use an unambiguous tmux-safe encoding and match the complete owner prefix. |
| Pane-level best-effort cancellation. | Killing the task's tmux session is sufficient. No claim of confirmed descendant termination. |
| Cancel on `/new`, resume, fork, or controlled Pi quit, including interactive double Ctrl+C. | Avoids intentionally leaving unattended work. Abrupt process death can bypass cleanup. |
| Turn abort preserves tasks. Reload preserves execution and restarts observation. | Turn lifetime and extension-runtime lifetime are not task ownership. |
| Non-interactive commands with separate stdout/stderr files. | No attach/send-keys interface, output buffering in Pi, or automatic log injection into model context. |
| Durable per-task metadata for configuration and recorded outcomes. No terminal-result cache or duplicate in-memory task registry. | Metadata retains completion after tmux resources are removed. tmux supplies live/dead execution evidence; it is not the completed-task catalogue. |
| Write natural completion to metadata before removing its tmux session. | If persistence fails, retain the dead pane and report the affected operation's error. A recorded outcome and successful resource cleanup are distinct facts. |
| Event-driven observation: the pane wrapper writes an exit file, a filesystem watcher per running task delivers completion, and deadlines and status reports are timers registered only when requested. | No periodic poll. Terminal tasks cost nothing. The exit file is written by the pane shell without tmux and survives server loss. Server loss is noticed at the next registered event or explicit action. |
| Fail fast within the affected `{action, taskId}` operation. | A failure for B must not fail or disable a targeted operation on A. Batch operations must preserve that per-task boundary. |
| One active controller per owner session. | No cross-process locks, leases, or multi-controller reconciliation are needed for the current contract. |
| No special partial-launch state or recovery subsystem. | Ordinary setup errors need task-local cleanup and an explicit error, not another lifecycle model. |

Storage direction: one metadata file per task. SQLite has not been selected. If adopted later, one tasks table keyed by session/task identity is preferable to a table per session; transactions still cannot include tmux side effects.

## Interface

- `start(command, cwd, timeoutSeconds?, statusReport?, notificationTarget?)`: launch and return promptly with `taskId`, `process`, one `artifacts` root, and requested deadline/report settings. `notificationTarget: 'subagent'` is reserved for delegated workers.
- `status(id)`: inspect one task once, record a completion found on disk or in tmux, and return its current state.
- `list()`: list this owner's stored tasks, including completed tasks. Query tmux for current execution evidence where needed. Report unreadable records individually inside `tasks`, with identity, artifact root, unknown process state, and an error. Reserve `errors` for task discovery failures; omit it when empty.
- `cancel(id)`: request removal of the target task's tmux session and record the result. Return a task-local result or an identified error.
- `cancelAll()`: attempt cancellation of all owner tasks; return per-task results and errors.

There is no `wait` operation, wait timeout, or waiter registry. The agent receives asynchronous completion/status notifications and can use `list` or existing file tools for inspection.

Timeout support is an optional launch-time deadline for total task lifetime. Optional status reports use a configured interval and one-shot or repeat behavior; they are process notices, not model callbacks. Deadline updates are deferred. No automatic retry of commands.

Both tool content and details use compact output helpers. Keep full manager records in files and retain the internal manager API shape. Return identity, actionable state, recovery information, and one artifact root; omit empty errors and absent optional fields. `process` is separate from delegated-work success. Reported errors redact selected URL/credential patterns and control characters and cap text at 300 characters; raw diagnostics are not fully redacted.

## Storage and execution

```text
<configured-agent-data-dir>/tasks/<encoded-owner-id>/<task-id>/
  metadata.json
  stdout.log
  stderr.log
  exit
```

The pane wrapper writes the command's exit code to `exit` through a temporary file and rename before the pane dies. It is authoritative for natural completion. A dead pane without an exit file is recorded from tmux pane status.

Metadata records task identity, ownership, launch specification/result, output paths, timing, deadline/report settings, terminal outcome, and relevant operation errors. tmux user options must not hold another authoritative copy of these settings.

Write metadata at task creation, then record the launch result. Completion and cancellation update the same record. Persist report scheduling changes when needed. Do not create a fallback result cache if a write fails.

Recommended write method: temporary file plus rename, so readers do not see partially overwritten JSON. This is not a claim of power-loss durability. No journal, notification replay, automatic metadata repair, or crash-recovery workflow.

```text
start
  → create task files and metadata
  → create gated tmux pane
  → configure exit retention
  → release command
  → record launch result

command exits
  → tmux retains dead pane and exit evidence
  → exit-file watcher observes this task
  → write terminal metadata
  → attempt removal of task's tmux session
  → emit best-effort completion notice

list / file reads → metadata and output
                 → tmux when live evidence is needed
```

Use a waiting shell and a unique tmux `wait-for` launch gate so the command starts only after metadata records the launch. `remain-on-exit` is already set when the pane is created, so a pane whose gate command fails at once is still observed as a dead pane. This tmux synchronization primitive is internal and is not an agent-facing wait API.

The waiting shell keeps the PTY open while `/bin/sh -c <command>` uses `/dev/null` for stdin and plain output files. It exits with the command's shell status. Redirecting every pane-shell descriptor and replacing that shell can close the PTY and cause SIGHUP. Command signals may appear as shell exit codes rather than exact signal fields.

Commands currently inherit the shared tmux server's environment, which can be older than the launching Pi process's environment. The working directory is explicit. Per-task environment overrides are deferred; commands can set required variables. Do not copy the full Pi environment, including credentials, into visible command arguments.

## Error boundaries and coordination

- Targeted operations read or change only the target task's state. They must not depend on successful parsing or collection of every owner's task.
- Return compact errors with `{action, taskId, error}` and identify side effects that already occurred. Preserve actionable fields in serialized tool and batch results. Internal manager errors retain their full cause. Failure does not imply rollback.
- Each watcher event observes one task. A failure ends that task's observation, not the observation of another task or another API call.
- `list`, `cancelAll`, and owner cleanup report per-task failures while continuing healthy tasks. Cleanup discovers owned tmux resources independently of metadata parsing.
- An unreachable tmux server means every owned pane is gone: observation and cancellation record `unknown` with reason `tmux server unreachable` for tasks without an outcome, and owner cleanup succeeds with no sessions to remove. Transport, timeout, and permission errors stay errors; do not reinterpret them as an empty successful listing.
- Notifications are separate best-effort effects. A delivery or diagnostic-reporting failure must not fail task control or stop other tasks. Do not globally suppress errors solely because their messages match.
- Serialize every read and write of one task on one per-task lock: launch from its first visible metadata through its recorded result, observation, cancellation, and `list` or `status` reads. A read never interleaves with a completion, so it reports either the live pane or the recorded outcome, never a vanished pane. Avoid an owner-wide operation queue that makes unrelated targeted calls depend on one task's work. Disposal must settle accepted operations before a replacement controller observes those records.
- Before owner cleanup, reject new launches and settle accepted launch attempts so cleanup cannot miss a just-created resource. This is operation coordination, not a second task database.

For natural completion, a metadata write failure leaves the dead pane available, including during batch cancellation or owner cleanup. An unconditional resource sweep must not bypass that failure. Once the outcome is recorded, a later pane-removal failure is a cleanup error, not a loss of the command result. Persist that error in the task record; if this write also fails, report both failures. Metadata alone does not prove that the resource was removed. Observation need not retry cleanup of terminal tasks; explicit cancellation or owner cleanup can attempt it again.

Cancellation removes the pane before recording its terminal outcome. If that write fails, report that removal occurred but persistence failed. Do not pretend cancellation was rolled back or invent a reliable outcome after restart.

A setup failure can leave files or a waiting pane. Attempt task-local cleanup and return the original error plus any cleanup error/resource identity. If gate release may already have happened, do not assume the command never ran and do not relaunch automatically. Incorrect tmux syntax is an implementation bug, not evidence that a recovery subsystem is required.

## Timer and outcomes

```text
start / session_start → arm(task)
  fs.watch(task dir)              → exit file → record completion → remove pane → notice
  setTimeout(deadline - now)      → remove pane → timed_out        (only when requested)
  setTimeout(nextReportAt - now)  → status notice → re-arm if repeat (only when requested)

session_start → for each stored task without an outcome:
  arm, then settle once: exit file → completion; pane dead → completion;
  server unreachable or session missing → unknown; alive → stay armed
```

Each event handler runs inside the task's serialized operation chain. A terminal outcome, cancellation, or disposal clears the task's watcher and timers. Timers are unreferenced so they do not keep Pi alive on their own; a missed deadline or report fires once at the next session start. No deadline enforcement while Pi is absent.

Every event handler reads the exit file before acting on the deadline for that task. An already-observed exit keeps its actual outcome. Deadline cancellation applies to work still observed as running.

Task outcomes are `succeeded`, `failed`, `cancelled`, `timed_out`, or `unknown`. Cancellation outcomes describe pane-level removal, not confirmed descendant cleanup. Missing live resources without a recorded terminal outcome must not become false success. Preserve recorded exit evidence after resource removal; do not restart commands.

## Lifecycle and notifications

| Event | Behavior |
| --- | --- |
| Current turn aborts | Keep tasks running. |
| `/new`, resume, fork, or controlled quit | Reject launches and attempt owner-task cleanup. Retain metadata/output. |
| Reload | Stop the old watchers and timers without cancellation; the new observer reconciles each stored task once from metadata, exit file, and tmux, then re-arms. |
| Abrupt Pi death | No cleanup guarantee. Prefixed resources permit explicit manual cleanup. |
| tmux failure | Report errors or unknown outcomes where justified; never restart commands automatically. |

Emit compact completion/status notices with task identity, process state, and one artifact root. Suppress notices during owner discontinuation. Delivery is best effort; no exactly-once processing or replay guarantee. Automatic notices make routine polling unnecessary; status/list can reconcile after interruption.

Persist optional `notificationTarget: 'subagent'` in task metadata. For those tasks only, emit `{ owner, type, task }` on Pi's `background-task:subagent` event bus instead of sending a background-task custom message. The routed task includes start/end timing for the footer, without adding it to public tool returns. The subagent extension combines that process evidence with its result artifact and delivers the notice. Background-task remains lifecycle owner and observer. Standalone task notices are unchanged in ownership, but use the compact payload shape. No second observer or replay queue.

A metadata-only `background-task:snapshot` request supports footer restoration. Read each record under the existing task lock; report and skip invalid records independently. Do not inspect tmux or reconcile outcomes through this UI snapshot. Emit `background-task:ready` after initial observation, and suppress delegated startup-reconciliation events to prevent completion replay regardless of extension load order. Emit `background-task:owner-cleanup` before manager shutdown so subagent callbacks cannot wake the old owner during cleanup. Reload still preserves processes.

Standalone background-task delivery is notify-only through `pi.sendMessage` with `triggerTurn: false`. Pi defers busy-session messages until the current turn ends and appends idle-session messages without a model call. Delegated events use the subagent route; that extension wakes the parent on termination and owns its footer/transcript presentation. Background-task itself does not wake the model.

## Integration and limits

- Pi 1.0.0 awaits `session_shutdown` with reasons new/resume/fork/quit/reload. Use this instead of pre-switch cleanup, which could cancel tasks before another extension vetoes the switch.
- Shutdown errors are reported, not a lifecycle veto. Cleanup failure can leave task resources behind.
- Interactive double Ctrl+C within 500 ms follows controlled runtime disposal; a single Ctrl+C clears the editor. Emergency terminal exit and abrupt signals can bypass cleanup. SDK lifecycle coverage is not an automated raw-TUI key test.
- SDK hosts must dispose through `AgentSessionRuntime` for quit cleanup. Plain `AgentSession.dispose()` invalidates extension contexts but does not emit `session_shutdown`.
- Ownership uses `ctx.sessionManager.getSessionId()`. Storage uses exported `getAgentDir()`. SDK hosts with a custom `agentDir` must keep `PI_CODING_AGENT_DIR` consistent.
- Structured tool failures use `isError: true` with JSON-safe error fields in `content` and `details`. Pi preserves these fields; throwing alone discards structured tool-error details.
- Target platform: Linux, Node 22, tmux 3.6, Pi 1.0.0. Older tmux versions are not supported.
- No log caps, automatic deletion, redaction, sandboxing, or arbitrary artifact collection. Logs may fill disk or retain secrets. Output completeness is not guaranteed.

## Implementation and regression contract

- `background-task/manager.mjs`: metadata, tmux execution, task-local coordination, and observation.
- `background-task/index.ts`: tool schema, structured errors, notice routing, and Pi lifecycle hooks.
- `background-task/output.mjs`: compact task/error responses and bounded reported-error sanitization.
- `npm test`: manager, output-contract, and review-runner tests. `npm run test:pi`: Pi SDK lifecycle test.
- `scripts/review.mjs`: event-driven review runner on an isolated Pi session.

The regression contract:

- Launch returns promptly; non-interactive stdout/stderr reach the expected files.
- Fast success/failure produces a notification and durable outcome; completed tasks remain discoverable after component replacement.
- Terminal-write failure retains exit evidence; resource-removal failure does not erase the recorded result or masquerade as successful cleanup.
- Target A remains usable when B has malformed metadata, report-write failure, cleanup failure, or notification failure.
- Per-task errors contain operation and identity; batch operations continue other tasks.
- Cancellation/deadlines affect only the target; owner cleanup leaves other owners untouched.
- Pending launches are covered by discontinuation cleanup; turn abort and reload preserve execution.
- Completion arrives without polling; observed completion wins over deadline expiry; registered timers fire only for tasks that requested them; disposal leaves no watchers or timers.
- An exit file written while Pi was away is recorded at the next session start.
- Setup failures attempt local cleanup and report failures without command retries or special recovery states.
- Missing tmux, server loss, and external deletion do not produce false success.
- Commands, paths, and IDs with shell metacharacters cannot alter tmux control arguments or unrelated resources.
- The exposed tool schema has no `wait` action or wait-only parameters.
