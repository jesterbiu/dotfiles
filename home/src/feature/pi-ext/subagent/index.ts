import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringEnum, Type } from '@earendil-works/pi-ai';
import { clampThinkingLevel } from '@earendil-works/pi-ai/compat';
import { getAgentDir, getPackageDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { toolRenderer } from './ui.mjs';
import { LiveTasks } from './tasks.mjs';
import { Controller } from './controller.mjs';
import { compactError, errorText } from '../background-task/output.mjs';

export default function subagent(pi: ExtensionAPI) {
  let controller: Controller | undefined;
  let shown = false;
  let tasks = new LiveTasks();
  const renderers = new Map<string, () => void>();
  const snapshot = (owner: string) => ({ owner, tasks: tasks.values() });
  const publish = (owner: string) => {
    try { pi.events.emit('subagent:tasks', snapshot(owner)); }
    catch (error) { console.error('Subagent task snapshot:', error); }
  };
  const unsubscribeSnapshot = pi.events.on('subagent:tasks-request', (request: { owner: string; reply: (value: { owner: string; tasks: any[] }) => void }) => {
    if (controller?.owner === request.owner) request.reply(snapshot(request.owner));
  });

  pi.registerCommand('subagent-ui', {
    description: 'Show or hide subagent cards and future notices: on|off',
    handler: async (args, ctx) => {
      if (!['on', 'off'].includes(args.trim())) {
        ctx.ui.notify('Usage: /subagent-ui on|off', 'error');
        return;
      }
      shown = args.trim() === 'on';
      for (const invalidate of [...renderers.values()]) invalidate();
    },
  });

  const restore = async () => {
    const current = controller;
    if (!current) return;
    let snapshot: Promise<any[]> = Promise.resolve([]);
    pi.events.emit('background-task:snapshot', { owner: current.owner, reply: (tasks: Promise<any[]>) => { snapshot = tasks; } });
    const tasks = await snapshot;
    if (controller === current && current.accepting) await current.restore(tasks);
  };

  const unsubscribeReady = pi.events.on('background-task:ready', (event: { owner: string }) => {
    const current = controller;
    if (current?.accepting && current.owner === event.owner) void restore().catch(error => { if (controller === current && current.accepting) current.onError(error); });
  });

  const unsubscribeCleanup = pi.events.on('background-task:owner-cleanup', (event: { owner: string }) => {
    const current = controller;
    if (current?.owner !== event.owner) return;
    void current.dispose();
    tasks = new LiveTasks();
    publish(current.owner);
  });

  const unsubscribeProcess = pi.events.on('background-task:subagent', event => {
    const current = controller;
    if (!current?.accepting || current.owner !== event.owner) return;
    if (event.type === 'completion' || event.task.process !== 'running' || event.task.endedAt != null) {
      if (tasks.update(event.task, event.type === 'completion')) publish(current.owner);
    }
    void current.onProcess(event).catch(error => { if (controller === current && current.accepting) current.onError(error); });
  });

  pi.on('session_start', async (_event, ctx) => {
    await controller?.dispose();
    tasks = new LiveTasks();
    renderers.clear();
    const current = new Controller({
      owner: ctx.sessionManager.getSessionId(),
      root: join(getAgentDir(), 'subagents'),
      agentDir: getAgentDir(),
      sdkPath: join(getPackageDir(), 'dist/index.js'),
      workerPath: join(dirname(fileURLToPath(import.meta.url)), 'launch.mjs'),
      onResult: result => {
        if (controller !== current || !current.accepting) return;
        pi.sendMessage({
          customType: 'subagent',
          content: JSON.stringify(result),
          display: shown,
          details: result,
        }, { triggerTurn: result.type === 'subagent-completion', deliverAs: 'followUp' });
      },
      onChange: (task, completion) => {
        if (controller === current && current.accepting && tasks.update(task, completion)) publish(current.owner);
      },
      onError: error => {
        if (controller !== current || !current.accepting) return;
        const message = `Subagent: ${errorText(error.message)}`;
        if (ctx.hasUI) ctx.ui.notify(message, 'error');
        else console.error(message);
      },
    });
    controller = current;
    publish(current.owner);
    try {
      await current.init();
      if (controller === current && current.accepting) await restore();
    } catch (error) { if (controller === current && current.accepting) current.onError(error); }
  });

  pi.on('session_shutdown', async () => {
    const current = controller;
    controller = undefined;
    tasks = new LiveTasks();
    renderers.clear();
    if (current) publish(current.owner);
    unsubscribeSnapshot();
    unsubscribeReady();
    unsubscribeCleanup();
    unsubscribeProcess();
    await current?.dispose();
  });

  pi.registerTool({
    name: 'model_list',
    label: 'Model list',
    description: 'List models available in the parent /model all scope as subagent candidates. Optional query matches provider, model ID, or display name by case-insensitive substring. Returns all matching exact provider/model-id values; worker startup remains authoritative for availability.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    parameters: Type.Object({ query: Type.Optional(Type.String()) }),
    outputSchema: Type.Object({ models: Type.Array(Type.String()) }),
    async execute(_id, args, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const refreshSignal = AbortSignal.timeout(15_000);
      await ctx.modelRegistry.refresh({ signal: signal ? AbortSignal.any([signal, refreshSignal]) : refreshSignal });
      signal?.throwIfAborted();
      const query = (args.query ?? '').toLowerCase();
      const models = ctx.modelRegistry.getAvailable()
        .filter(model => [model.provider, model.id, model.name].some(value => value.toLowerCase().includes(query)))
        .map(model => `${model.provider}/${model.id}`)
        .sort();
      const result = { models };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result, structuredContent: result };
    },
  });

  pi.registerTool({
    name: 'subagent',
    label: 'Subagent',
    renderShell: 'self',
    renderCall: (args, theme, context) => {
      renderers.set(context.toolCallId, context.invalidate);
      return toolRenderer(() => shown, () => `subagent ${JSON.stringify(args)}`, theme, Text);
    },
    renderResult: (result, _options, theme, context) => {
      renderers.set(context.toolCallId, context.invalidate);
      return toolRenderer(() => shown, () => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n'), theme, Text);
    },
    exposure: 'model-only',
    description: 'Delegate one task to a fresh Pi worker through active, callable background_task. Use model_list with query (for example astra) to discover candidates without knowing the provider. Start requires exact model provider/model-id; thinkingLevel defaults to the parent level and Pi may clamp it. Send steers only while busy; acknowledgement is not completion. The worker writes result.json under artifacts, then exits. Automatic subagent completion notices wake the parent or queue a follow-up when busy, and do not replay after reload; routine polling is unnecessary. Use list to reconcile missed notices. Process success does not prove task success. List and cancellation are session-scoped. Turn abort and reload preserve workers; session replacement and controlled exit cancel them. Children share the workspace and have read, bash, edit, write, grep, find, and ls, without parent extensions or permission hooks. Assign non-overlapping write scopes. timeoutSeconds is total worker lifetime; deadlines and status reports require an active parent observer. Hard termination may leave no result.',
    parameters: Type.Object({
      action: StringEnum(['start', 'send', 'list', 'cancel', 'cancelAll'] as const),
      task: Type.Optional(Type.String({ minLength: 1 })),
      topic: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: 'Concise footer topic; defaults to short task text.' })),
      cwd: Type.Optional(Type.String()),
      model: Type.Optional(Type.String({ minLength: 1, description: 'Required for start: exact provider/model-id.' })),
      thinkingLevel: Type.Optional(StringEnum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const)),
      timeoutSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
      statusReport: Type.Optional(Type.Object({
        afterSeconds: Type.Number({ exclusiveMinimum: 0 }),
        repeat: Type.Optional(Type.Boolean()),
      })),
      taskId: Type.Optional(Type.String()),
      message: Type.Optional(Type.String({ minLength: 1 })),
      messageId: Type.Optional(Type.String({ description: 'Optional UUID for duplicate detection. Reuse this ID and identical input after delivery-unknown errors; never replay to a restarted worker.' })),
    }),
    async execute(_id, args, signal, _onUpdate, ctx) {
      try {
        signal?.throwIfAborted();
        const current = controller;
        if (!current) throw new Error('Subagent session is not active');
        let model;
        if (args.action === 'start') {
          if (!args.model) throw new Error('model is required for start: provider/model-id');
          const boundary = args.model.indexOf('/');
          if (boundary < 1 || boundary === args.model.length - 1) throw new Error('model must be provider/model-id');
          model = ctx.modelRegistry.find(args.model.slice(0, boundary), args.model.slice(boundary + 1));
          if (!model) throw new Error(`Unknown model: ${args.model}`);
        }
        const acceptedSignal = new AbortController().signal;
        const details = await current.run(args, input => ctx.executeTool('background_task', input, { signal: acceptedSignal }), {
          cwd: ctx.cwd, model, thinkingLevel: pi.getThinkingLevel(), effectiveThinkingLevel: model ? clampThinkingLevel(model, args.thinkingLevel ?? pi.getThinkingLevel()) : undefined,
        });
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
      } catch (error) {
        const value = error as Error & { taskId?: string };
        const details = { action: args.action, ...compactError(value), ...(value.taskId ?? args.taskId ? { taskId: value.taskId ?? args.taskId } : {}) };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(details) }], details };
      }
    },
  });
}
