import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { layout } from './ui.mjs';

type Task = { taskId: string; topic: string; model: string; thinkingLevel: string; startedAt: number; process?: string; phase?: string; endedAt?: number; observedAt?: number };
type Snapshot = { owner: string; tasks: Task[] };

export default function statusline(pi: ExtensionAPI) {
  let enabled = true;
  let context: ExtensionContext | undefined;
  let tasks: Task[] = [];
  let repaint = () => {};
  let disposeFooter = () => {};

  const accept = (snapshot: Snapshot) => {
    if (!context || snapshot.owner !== context.sessionManager.getSessionId()) return;
    tasks = snapshot.tasks.map(task => ({ ...task }));
    repaint();
  };
  const unsubscribe = pi.events.on('subagent:tasks', accept);
  const snapshot = () => {
    const current = context;
    if (!current) return;
    tasks = [];
    pi.events.emit('subagent:tasks-request', {
      owner: current.sessionManager.getSessionId(),
      reply: (value: Snapshot) => { if (context === current) accept(value); },
    });
    repaint();
  };
  const install = (ctx: ExtensionContext) => {
    if (ctx.mode !== 'tui') return;
    ctx.ui.setFooter(tui => {
      let disposed = false;
      const paint = () => { if (!disposed) tui.requestRender(); };
      repaint = paint;
      const timer = setInterval(paint, 1000);
      timer.unref();
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        clearInterval(timer);
        if (repaint === paint) repaint = () => {};
      };
      disposeFooter = dispose;
      return {
        dispose,
        invalidate() {},
        render(width) {
          const usage = ctx.getContextUsage();
          const percent = usage?.percent == null ? '?%' : `${usage.percent.toFixed(1)}%`;
          const capacity = usage?.contextWindow ?? ctx.model?.contextWindow;
          const context = `${percent}/${capacity == null ? '?' : capacity >= 1000 ? `${Math.round(capacity / 1000)}k` : capacity}`;
          return layout({ width, workspace: ctx.cwd, context, model: ctx.model?.id ?? 'no-model', thinking: pi.getThinkingLevel(), rows: tasks, now: Date.now(), theme: ctx.ui.theme, truncateToWidth, visibleWidth });
        },
      };
    });
  };

  pi.registerCommand('statusline', {
    description: 'Show or hide the custom footer: on|off',
    handler: async (args, ctx) => {
      if (!['on', 'off'].includes(args.trim())) {
        ctx.ui.notify('Usage: /statusline on|off', 'error');
        return;
      }
      enabled = args.trim() === 'on';
      if (!context) return;
      if (enabled) {
        snapshot();
        install(ctx);
      } else {
        disposeFooter();
        if (ctx.mode === 'tui') ctx.ui.setFooter(undefined);
      }
    },
  });

  pi.on('session_start', (_event, ctx) => {
    disposeFooter();
    context = ctx;
    tasks = [];
    snapshot();
    if (enabled) install(ctx);
  });

  pi.on('session_shutdown', () => {
    const current = context;
    context = undefined;
    tasks = [];
    unsubscribe();
    disposeFooter();
    if (current?.mode === 'tui') current.ui.setFooter(undefined);
  });
}
