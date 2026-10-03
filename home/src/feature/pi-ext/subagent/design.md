# Subagent extension

## Accepted design

A subagent is a persistent Pi conversation hosted by a worker process. The existing `background_task` tool owns the worker's process lifecycle. The subagent extension owns delegation and result discovery. The worker owns the Pi session and a private Unix socket.

```text
Parent Pi
  ├─ subagent tool ── background_task ── tmux ── worker
  └─ subagent tool ── private Unix socket ────────┤
                                                └─ Pi SDK session
```

Do not add another task manager or tmux observer. Invoke `background_task` through `ctx.executeTool()`. Do not inject tmux keystrokes or use logs as a command channel.

## API

One tool named `subagent` exposes these actions:

- `start(task, cwd?, model?, timeoutSeconds?, statusReport?)`: create a fresh child conversation and return promptly with the background task ID and artifact paths.
- `send(taskId, message, mode = "steer", messageId?)`: submit guidance or more work to the same conversation. An optional UUID supports duplicate detection after uncertain delivery.
- `list()`: show only this parent session's subagents, with process and conversation state.
- `cancel(taskId)` and `cancelAll()`: cancel only this parent session's subagents.

There is no blocking wait action. Use file tools to read answers and logs.

| Conversation state | steer | followUp |
|---|---|---|
| Busy | Queue at the next steering boundary | Queue after the current run |
| Idle | Start a new run | Start a new run |
| Starting | Not reachable: socket connect fails with `delivery: not_sent`; caller retries when ready | Same |
| Stopping or terminated | Reject | Reject |

Steering is cooperative. It does not interrupt active tools or reverse edits. Acknowledgements include a message ID and `started`, `queued`, or `handled`; they are not completed answers. The worker serializes admission and assigns request order. Multiple messages can contribute to one settled result.

## Context and configuration

Children start with an explicit task, not a copy of the parent transcript. Resolve the model and thinking level at launch, inheriting the parent's current selection unless overridden. Load applicable workspace instructions but use a controlled resource and tool set. Do not load arbitrary child extensions or either orchestration tool.

Persist a private launch manifest. Pass only its path to the worker command. Resolve executable and SDK paths explicitly rather than relying on the tmux server's environment. Do not persist credentials in the manifest.

The default workspace is shared. Separate conversations are not filesystem isolation. The parent coordinates non-overlapping writes and reviews changes. Automatic worktrees, merging, locking, and rollback are out of scope.

## State and artifacts

```text
starting → idle ⇄ busy → stopping → terminated
                    └─ agent_settled → numbered result
```

An idle conversation still has a running background task. Each settled run saves an immutable numbered answer and result metadata. Keep the Pi transcript, diagnostics, resolved launch configuration, usage, child session ID, and request IDs. The Pi session file is the only transcript; the worker writes no event log. Publish finalized result metadata atomically. Process success alone does not establish agent success or task correctness.

Use a private local socket for requests. The worker survives parent extension reload. Reconnect through stored metadata; do not restart or replay work automatically.

## Ownership, delivery, and lifecycle

The parent session ID owns the child. The background task ID is its public run ID; the child Pi session ID is distinct. Store the relationship durably. List and cancellation must not affect unrelated shell tasks.

A request timeout after submission means delivery is unknown. Message IDs permit duplicate detection while the worker lives.

Children stay available until cancellation, total worker lifetime timeout, or parent cleanup. Turn abort and extension reload preserve children. Session replacement and controlled parent exit use background-task cleanup. Cancellation sends stop over the socket first, then calls background-task cancellation. On stop the worker closes admission, aborts the session, lets the settled run write its final result, and exits on its own. Background-task cancellation is the backstop, not the only exit path. Cancellation is best effort for descendants. SDK worker shutdown disposes the runtime, not only the session.

Admission follows Pi's `prompt()` contract: the acknowledgement is the `preflightResult` disposition, a rejection is a thrown `prompt()`. The worker adds no third outcome. A `prompt()` that returns before preflight is deferred by Pi and acknowledged when Pi replays it. Compaction in progress is reported as `delivery: busy`, retryable with the same message ID.

Worker state follows Pi events, not worker bookkeeping. `started` and `queued` set phase busy. `agent_settled` always writes the next numbered result, including an empty request list when no tracked message contributed, resets usage accumulators, and sets phase idle. The acknowledgement carries the result number the message lands in: the next number for `started`, the pending number for `queued`.

Result-ready notices use filesystem events on the worker's state file, not another process observer. They contain IDs and paths, not transcripts, and do not trigger model turns. Background-task notices remain responsible for process completion and status. Result notification delivery is best effort, may coalesce, and does not replay on reload. Persisted results are authoritative.

The existing `timeoutSeconds` applies to total worker lifetime, not individual messages.

## Validation

Use a fake session to test admission, steering, follow-up, duplicate requests, settled results, error outcomes, socket reconnect, and shutdown without model requests. Test the extension contract with a fake background tool. Add an installed-SDK integration check for resource configuration, lifecycle, and persistence without paid model requests.

Primary vertical slice: start → steer while busy → settled answer → parent reload/reconnect → follow-up in the same child conversation.

## Implementation boundaries

- `index.ts`: Pi tool and lifecycle integration. Subagent is model-only; background-task remains callable through nested tool dispatch.
- `controller.mjs`: owner-scoped launch records, background-tool calls, socket client, and result notices.
- `launch.mjs`: process entry point, task binding, startup diagnostics, and signal cleanup.
- `worker.mjs`: serialized admission, duplicate detection, conversation events, and numbered results.
- `pi-session.mjs`: controlled SDK runtime. Use `prompt()` with `streamingBehavior` and `preflightResult` for atomic busy/idle routing and prompt acknowledgement.
- `protocol.mjs` and `storage.mjs`: bounded socket framing and private atomic metadata writes.

The worker waits for a durable task binding before initializing the conversation. It admits the initial task before opening the socket. A missing binding fails after 30 seconds without model work. There is no recovery or automatic replay across worker processes.

Child resources include Pi's default system prompt, a fixed delegate instruction, workspace context files, and an explicit built-in tool set, not `.pi/SYSTEM.md`, parent extensions, permission hooks, or runtime-only providers. This is not a sandbox. The child runs in a separate process, so its usage stays in its result ledger rather than the parent session totals.

See `README.md` for loading, artifacts, and operational limits. Tests do not require paid model requests.

## Recommendations

Not yet decisions.

- No idle timeout in the first version. Lifetime timeout and explicit cancel bound the child.
- An explicit `cwd` can select an existing worktree. Worktree creation stays with the parent.
- Duplicate detection covers one worker lifetime only. No cross-worker exactly-once guarantee.

## Open questions

None.
