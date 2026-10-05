import { join, resolve } from 'node:path';
import { StringEnum, Type } from '@earendil-works/pi-ai';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { TaskManager, Tmux } from './manager.mjs';
import { compactError, compactResponse, compactTask } from './output.mjs';

const errorPayload = (error: unknown, action: string, taskId: string | null = null) => {
  const value = error as { action?: unknown; taskId?: unknown; cause?: unknown; sideEffects?: unknown; message?: unknown };
  const cause = value?.cause instanceof Error ? value.cause.message : typeof value?.message === 'string' ? value.message : String(error);
  return {
    action: typeof value?.action === 'string' ? value.action : action,
    taskId: typeof value?.taskId === 'string' ? value.taskId : taskId,
    cause,
    sideEffects: Array.isArray(value?.sideEffects) ? value.sideEffects.map(String) : [],
  };
};

export default function backgroundTask(pi: ExtensionAPI) {
  let manager: TaskManager | undefined;

  pi.events.on('background-task:snapshot', (request: { owner: string; reply: (tasks: Promise<unknown[]>) => void }) => {
    const current = manager;
    if (current?.owner === request.owner) request.reply(current.snapshot().then(tasks => tasks.filter(task => task.notificationTarget === 'subagent').map(task => ({ ...compactTask(task), startedAt: task.startedAt, endedAt: task.endedAt }))));
  });

  pi.registerFlag('background-task-server', {
    description: 'Named tmux server for background tasks',
    type: 'string',
    default: 'pi-tasks',
  });

  pi.on('session_start', async (_event, ctx) => {
    await manager?.dispose();
    const report = (error: Error) => {
      const message = `Background tasks: ${error.message}`;
      if (ctx.hasUI) ctx.ui.notify(message, 'error');
      else console.error(message);
    };
    let initializing = true;
    manager = new TaskManager({
      owner: ctx.sessionManager.getSessionId(),
      root: join(getAgentDir(), 'tasks'),
      tmux: new Tmux(String(pi.getFlag('background-task-server') ?? 'pi-tasks')),
      onEvent: event => {
        if (event.task.notificationTarget === 'subagent') {
          if (!initializing) pi.events.emit('background-task:subagent', { owner: event.task.owner, type: event.type, task: { ...compactTask(event.task), startedAt: event.task.startedAt, endedAt: event.task.endedAt } });
          return;
        }
        const notice = { type: `background-task-${event.type}`, ...compactTask(event.task) };
        pi.sendMessage({ customType: 'background-task', content: JSON.stringify(notice), display: true, details: notice }, { triggerTurn: false });
      },
      onError: report,
    });
    try { await manager.observe(); } catch (error) { report(error as Error); }
    initializing = false;
    pi.events.emit('background-task:ready', { owner: manager.owner });
  });

  pi.on('session_shutdown', async event => {
    const current = manager;
    manager = undefined;
    if (!current) return;
    pi.events.emit('background-task:owner-cleanup', { owner: current.owner });
    try {
      if (event.reason !== 'reload') {
        const cleanup = await current.close();
        for (const detail of cleanup.errors) current.reportError(Object.assign(new Error(detail.message), detail));
      }
    } finally {
      await current.dispose();
    }
  });

  pi.registerTool({
    name: 'background_task',
    label: 'Background task',
    description: 'Run shell commands in background tmux sessions. Start returns promptly. Read stdout.log, stderr.log, and metadata.json under artifacts. Observed completion sends an automatic best-effort notice; routine polling is unnecessary. Notices do not wake the model or replay after reload; use status/list to reconcile missed notices. timeoutSeconds is total task lifetime; statusReport schedules process notices, not model callbacks. Timers require an active parent observer. Process success does not prove work correctness. Cancel is best effort for descendants. Session replacement and controlled exit cancel tasks; turn abort and reload preserve them.',
    parameters: Type.Object({
      action: StringEnum(['start', 'status', 'list', 'cancel', 'cancelAll'] as const),
      command: Type.Optional(Type.String({ minLength: 1 })),
      cwd: Type.Optional(Type.String()),
      taskId: Type.Optional(Type.String()),
      timeoutSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
      notificationTarget: Type.Optional(Type.Literal('subagent', { description: 'Reserved for subagent-owned workers; omit for standalone commands.' })),
      statusReport: Type.Optional(Type.Object({
        afterSeconds: Type.Number({ exclusiveMinimum: 0 }),
        repeat: Type.Optional(Type.Boolean()),
      })),
    }),
    async execute(_id, args, signal, _onUpdate, ctx) {
      try {
        const current = manager;
        if (!current) throw new Error('Background task session is not active');
        let result;
        switch (args.action) {
          case 'start':
            signal?.throwIfAborted();
            if (!args.command) throw new Error('command is required for start');
            result = await current.start({
              command: args.command,
              cwd: resolve(ctx.cwd, args.cwd ?? '.'),
              timeoutSeconds: args.timeoutSeconds,
              statusReport: args.statusReport,
              notificationTarget: args.notificationTarget,
            });
            break;
          case 'status':
            if (!args.taskId) throw new Error('taskId is required');
            result = await current.observe(args.taskId);
            break;
          case 'list':
            result = await current.list();
            break;
          case 'cancel':
            if (!args.taskId) throw new Error('taskId is required');
            result = await current.cancel(args.taskId);
            break;
          case 'cancelAll':
            result = await current.cancelAll();
            break;
        }
        const details = compactResponse(result);
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
      } catch (error) {
        const details = compactError(errorPayload(error, args.action, args.taskId ?? null));
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(details) }], details };
      }
    },
  });
}
