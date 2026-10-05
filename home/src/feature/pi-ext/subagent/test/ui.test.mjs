import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { toolRenderer } from '../ui.mjs';

const packageDir = process.env.PI_PACKAGE_DIR;
const tui = await import(pathToFileURL(join(packageDir, '../pi-tui/dist/index.js')));
const { ToolExecutionComponent } = await import(pathToFileURL(join(packageDir, 'dist/modes/interactive/components/tool-execution.js')));
const { initTheme, theme } = await import(pathToFileURL(join(packageDir, 'dist/modes/interactive/theme/theme.js')));
initTheme('dark');

test('self shell removes call and result completely; toggling preserves diagnostics', async () => {
  let shown = false;
  const definition = { renderShell: 'self', renderCall: () => toolRenderer(() => shown, () => 'subagent task', theme, tui.Text), renderResult: () => toolRenderer(() => shown, () => 'failure details', theme, tui.Text) };
  const component = new ToolExecutionComponent('subagent', 'id', {}, {}, definition, { requestRender() {} }, '.');
  assert.deepEqual(component.render(40), []);
  component.updateResult({ content: [{ type: 'text', text: 'model detail' }], details: {}, isError: true });
  assert.deepEqual(component.render(40), []);
  shown = true;
  assert.match(component.render(40).join('\n'), /failure details/);
  shown = false;
  assert.deepEqual(component.render(40), []);
  const { InteractiveMode } = await import(pathToFileURL(join(packageDir, 'dist/modes/interactive/interactive-mode.js')));
  const host = { isInitialized: true, footer: { invalidate() {} }, pendingTools: new Map(), chatContainer: { addChild() { assert.fail('Nested card leaked'); } } };
  for (const type of ['tool_execution_start', 'tool_execution_update', 'tool_execution_end']) {
    await InteractiveMode.prototype.handleEvent.call(host, { type, parentToolCallId: 'parent', toolCallId: 'parent/1', toolName: 'background_task', args: {} });
  }
  assert.equal(host.pendingTools.size, 0);
});
