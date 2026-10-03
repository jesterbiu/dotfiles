import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringEnum, Type } from '@earendil-works/pi-ai';
import { getAgentDir, getPackageDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Controller } from './controller.mjs';

export default function subagent(pi: ExtensionAPI) {
  let controller: Controller | undefined;

  pi.on('session_start', async (_event, ctx) => {
    await controller?.dispose();
    controller = new Controller({
      owner: ctx.sessionManager.getSessionId(),
      root: join(getAgentDir(), 'subagents'),
      agentDir: getAgentDir(),
      sdkPath: join(getPackageDir(), 'dist/index.js'),
      workerPath: join(dirname(fileURLToPath(import.meta.url)), 'launch.mjs'),
      onResult: result => pi.sendMessage({
        customType: 'subagent-result',
        content: JSON.stringify({ type: 'result-ready', ...result }),
        display: true,
        details: result,
      }, { triggerTurn: false }),
      onError: error => {
        const message = `Subagent: ${error.message}`;
        if (ctx.hasUI) ctx.ui.notify(message, 'error');
        else console.error(message);
      },
    });
    await controller.init();
  });

  pi.on('session_shutdown', async () => {
    const current = controller;
    controller = undefined;
    await current?.dispose();
  });

  pi.registerTool({
    name: 'subagent',
    label: 'Subagent',
    exposure: 'model-only',
    description: 'Delegate to persistent Pi conversations through background_task. Start returns promptly with task ID and artifact paths. Send steers a busy child or starts another run when idle; followUp queues after current work. Acknowledgement is not completion. Read numbered answers with file tools. List and cancellation affect only this session’s subagents. Turn abort and reload preserve children; parent session replacement and controlled exit cancel them. Children share the workspace and have read, bash, edit, write, grep, find, and ls tools, without parent extensions or permission hooks. Assign non-overlapping write scopes. Requires an active, callable background_task tool. timeoutSeconds limits total worker lifetime.',
    parameters: Type.Object({
      action: StringEnum(['start', 'send', 'list', 'cancel', 'cancelAll'] as const),
      task: Type.Optional(Type.String({ minLength: 1 })),
      cwd: Type.Optional(Type.String()),
      model: Type.Optional(Type.String({ minLength: 1, description: 'Exact provider/model-id; defaults to the parent model.' })),
      timeoutSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
      statusReport: Type.Optional(Type.Object({
        afterSeconds: Type.Number({ exclusiveMinimum: 0 }),
        repeat: Type.Optional(Type.Boolean()),
      })),
      taskId: Type.Optional(Type.String()),
      message: Type.Optional(Type.String({ minLength: 1 })),
      mode: Type.Optional(StringEnum(['steer', 'followUp'] as const)),
      messageId: Type.Optional(Type.String({ description: 'Optional UUID for duplicate detection. Reuse this ID and identical input after delivery-unknown errors; never replay to a restarted worker.' })),
    }),
    async execute(_id, args, signal, _onUpdate, ctx) {
      try {
        signal?.throwIfAborted();
        const current = controller;
        if (!current) throw new Error('Subagent session is not active');
        let model = ctx.model;
        if (args.action === 'start' && args.model) {
          const boundary = args.model.indexOf('/');
          if (boundary < 1) throw new Error('model must be provider/model-id');
          model = ctx.modelRegistry.find(args.model.slice(0, boundary), args.model.slice(boundary + 1));
          if (!model) throw new Error(`Unknown model: ${args.model}`);
        }
        const acceptedSignal = new AbortController().signal;
        const details = await current.run(args, input => ctx.executeTool('background_task', input, { signal: acceptedSignal }), {
          cwd: ctx.cwd, model, thinkingLevel: pi.getThinkingLevel(),
        });
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
      } catch (error) {
        const value = error as Error & { taskId?: string; artifactDir?: string; messageId?: string; delivery?: string; cleanupError?: string; backgroundError?: unknown; admission?: unknown };
        const details = {
          action: args.action, error: value.message, taskId: value.taskId ?? args.taskId,
          artifactDir: value.artifactDir, messageId: value.messageId, delivery: value.delivery,
          cleanupError: value.cleanupError, backgroundError: value.backgroundError, admission: value.admission,
        };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(details) }], details };
      }
    },
  });
}
