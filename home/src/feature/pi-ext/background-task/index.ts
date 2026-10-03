import { join, resolve } from 'node:path';
import { StringEnum, Type } from '@earendil-works/pi-ai';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { TaskManager, Tmux } from './manager.mjs';

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
    manager = new TaskManager({
      owner: ctx.sessionManager.getSessionId(),
      root: join(getAgentDir(), 'tasks'),
      tmux: new Tmux(String(pi.getFlag('background-task-server') ?? 'pi-tasks')),
      onEvent: event => pi.sendMessage({
        customType: 'background-task',
        content: JSON.stringify(event),
        display: true,
        details: event,
      }, { triggerTurn: false }),
      onError: report,
    });
    try { await manager.observe(); } catch (error) { report(error as Error); }
  });

  pi.on('session_shutdown', async event => {
    const current = manager;
    manager = undefined;
    if (!current) return;
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
    description: 'Run non-interactive shell commands in background tmux sessions. Start returns task ID, metadata, and stdout/stderr file paths promptly. Status inspects one task once and returns its current state. List includes stored completed tasks and task-local metadata errors. Completion and status notices do not start a model turn. Cancel removes one task pane and is best effort for descendants. Session replacement and controlled Pi exit cancel tasks; turn abort and reload preserve them. Read output using file tools.',
    parameters: Type.Object({
      action: StringEnum(['start', 'status', 'list', 'cancel', 'cancelAll'] as const),
      command: Type.Optional(Type.String({ minLength: 1 })),
      cwd: Type.Optional(Type.String()),
      taskId: Type.Optional(Type.String()),
      timeoutSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
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
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      } catch (error) {
        const details = errorPayload(error, args.action, args.taskId ?? null);
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(details) }], details };
      }
    },
  });
}
