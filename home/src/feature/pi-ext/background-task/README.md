# Background tasks for Pi

Local extension. Requires Node.js, POSIX `/bin/sh`, and tmux.

## Load

For one session:

```bash
pi --no-extensions --extension ./index.ts --background-task-server pi-task-try
```

For every session, add this directory to `packages` in a Pi settings file. A relative path resolves from the directory of that settings file. `package.json` declares `pi.extensions`, so directory discovery finds `index.ts`.

The default server is `pi-tasks`. Do not use a normal tmux server. The extension sets `exit-empty off`; ordinary cleanup removes task sessions, never the shared server.

```json
{ "action": "start", "command": "npm test", "timeoutSeconds": 300, "statusReport": { "afterSeconds": 60, "repeat": true } }
{ "action": "status", "taskId": "..." }
{ "action": "list" }
{ "action": "cancel", "taskId": "..." }
{ "action": "cancelAll" }
```

There is no `wait` action. Launch returns promptly with `taskId`, `process`, and one `artifacts` directory, plus deadline/report settings when requested. Read `stdout.log`, `stderr.log`, `metadata.json`, and `exit` under that root. `status` inspects one task once. `list` returns `{ "tasks": [...] }`, adding `errors` only for discovery failures. Unreadable records appear in `tasks` with identity, artifact root, `process: "unknown"`, and an error. `cancelAll` returns independent results and nonempty errors. Full manager metadata stays in files; tmux resource names are internal.

Process states are `running`, `succeeded`, `failed`, `cancelled`, `timed_out`, and `unknown`. Process success does not prove work correctness. Errors retain actionable identity and side effects, omit empty fields, redact selected URL/credential patterns, and cap reported text at 300 characters. This is not full artifact redaction.

## Behavior

```text
start    → metadata → watcher + registered timers → gated pane → /bin/sh command
exit     → exit file → watcher → terminal metadata → pane removal → notice
deadline → timer → pane removal → timed_out
report   → timer → status notice → re-armed when repeat
shutdown → owner cleanup
reload   → old watchers and timers stop → new observer reconciles each task once
```

Commands run through `/bin/sh -c`, with null stdin and separate plain stdout/stderr files. The wrapper writes the command's exit code to `exit` in the task directory before the pane dies. Observation is event driven: a filesystem watcher per running task delivers completion, and deadlines and status reports are timers registered only when requested. There is no periodic poll. On session start the observer reconciles each stored task once from metadata, the exit file, and tmux, then re-arms. Optional `cwd` resolves from Pi's working directory. Read output with file tools; logs are not injected into the conversation. Metadata and logs remain under `<agent-data-dir>/tasks/<encoded-owner>/<task-id>/`; no automatic deletion occurs.

Natural completion is recorded before pane removal. A failed terminal write retains the dead pane, including during owner cleanup. Errors identify the action, task, cause, and completed side effects. Cleanup on controlled quit is silent: its errors are not shown.

Observed completion sends an automatic notice; routine polling is unnecessary. Completion and status notices use `triggerTurn: false`, with the same compact task shape and a `type` field. Pi defers notices until the current turn ends and appends idle notices without a model call. Notices are best effort and do not replay; use status/list to reconcile missed notices.

`notificationTarget: "subagent"` is reserved for delegated workers. Their events route to the subagent extension instead of producing duplicate background-task notices. Subagent termination can wake the parent; standalone background-task notices remain non-waking. Background-task still owns process observation and cleanup. Omit this field for standalone commands. `timeoutSeconds` is total task lifetime; reports describe process state, not model callbacks.

`/new`, resume, fork, and controlled quit reject new launches and attempt owner cleanup. Turn abort and reload preserve tasks. Interactive double Ctrl+C within 500 ms follows controlled runtime disposal; a single Ctrl+C clears the editor. The SDK test does not simulate raw TUI keys. SDK hosts need `AgentSessionRuntime.dispose()` for quit cleanup; plain `AgentSession.dispose()` does not emit `session_shutdown`.

## Limits

- Cancellation kills one tmux session. Descendant termination is best effort.
- Each tmux control call has a three-second limit. Permissions failures, abrupt exit, and emergency terminal exit can leave work or incomplete output.
- Missing resources without a recorded outcome become `unknown`, not success. An unreachable tmux server counts as every pane missing: tasks without an outcome become `unknown` with reason `tmux server unreachable`, and owner cleanup succeeds. Partial stdout and stderr files remain readable.
- The shared tmux server environment can predate Pi. Set required variables in the command. No Pi environment snapshot is copied into arguments.
- Deadlines and reports run only while Pi observes tasks. A deadline or report missed while Pi was away fires once at the next session start. Logs have no size cap or redaction.
- Server loss is noticed at the next registered timer, `status`, `list`, `cancel`, or session start, not within a fixed interval.
- One active controller per owner is supported. There is no cross-process lock, recovery workflow, command retry, notification replay, or command environment capture.
- Storage uses `getAgentDir()`. SDK hosts with a custom `agentDir` must keep `PI_CODING_AGENT_DIR` consistent.

## Tests

```bash
npm test
PI_PACKAGE_DIR=/path/to/node_modules/@earendil-works/pi-coding-agent npm run test:pi
```

Tests use temporary directories and unique tmux servers. They do not enable the extension or make model requests. The optional review runner uses an isolated Pi session with the configured model credentials and `gpt-5.6-terra`; it incurs model usage costs:

```bash
node scripts/review.mjs
```
