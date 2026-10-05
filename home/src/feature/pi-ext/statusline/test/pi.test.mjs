import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const packageDir = process.env.PI_PACKAGE_DIR;
if (!packageDir) throw new Error('Set PI_PACKAGE_DIR to the installed Pi package directory');
const sdk = await import(pathToFileURL(join(packageDir, 'dist/index.js')));
const { loadExtensions } = await import(pathToFileURL(join(packageDir, 'dist/core/extensions/loader.js')));
const { createEventBus } = await import(pathToFileURL(join(packageDir, 'dist/core/event-bus.js')));
const themeModule = await import(pathToFileURL(join(packageDir, 'dist/modes/interactive/theme/theme.js')));
const { ToolExecutionComponent } = await import(pathToFileURL(join(packageDir, 'dist/modes/interactive/components/tool-execution.js')));
themeModule.initTheme('dark');
const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const plain = text => text.replace(/\x1b\[[0-9;]*m/g, '');

async function fixture(t, names, mode = 'tui') {
  const root = await mkdtemp(join(tmpdir(), 'pi-statusline-'));
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const events = createEventBus();
  const loaded = await loadExtensions(names.map(name => join(source, name, 'index.ts')), root, events);
  assert.deepEqual(loaded.errors, []);
  const notices = [];
  loaded.runtime.sendMessage = (message, options) => notices.push({ message, options });
  loaded.runtime.getThinkingLevel = () => 'high';
  const footers = [];
  const errors = [];
  let footer;
  let paints = 0;
  const ui = {
    get theme() { return themeModule.theme; },
    notify(message, type) { if (type === 'error') errors.push(message); },
    setFooter(factory) {
      footer?.dispose?.();
      footer = factory?.({ requestRender() { paints++; } }, themeModule.theme, {});
      footers.push(footer);
    },
  };
  const owner = randomUUID();
  const ctx = {
    mode, hasUI: mode === 'tui' || mode === 'rpc', ui, cwd: root,
    sessionManager: { getSessionId: () => owner },
    model: { id: 'parent', contextWindow: 65536 },
    getContextUsage: () => ({ percent: 12.5, contextWindow: 65536 }),
    modelRegistry: { find: () => ({ provider: 'test', id: 'model', reasoning: false }) },
  };
  const dispatch = async (name, event = {}, context = ctx) => {
    for (const extension of loaded.extensions) {
      for (const handler of extension.handlers.get(name) ?? []) await handler(event, context);
    }
  };
  const command = async (name, args) => {
    const command = loaded.extensions.flatMap(extension => [...extension.commands.values()]).find(command => command.name === name);
    assert.ok(command, name);
    await command.handler(args, ctx);
  };
  const tool = loaded.extensions.flatMap(extension => [...extension.tools.values()]).find(tool => tool.definition.name === 'subagent')?.definition;
  const processes = new Map();
  const socketDirs = [];
  const call = async args => {
    const result = await tool.execute(randomUUID(), args, new AbortController().signal, undefined, {
      ...ctx,
      executeTool: async (_name, input) => {
        let details;
        if (input.action === 'list') details = { tasks: [...processes.values()] };
        else if (input.action === 'start') {
          details = { taskId: randomUUID(), process: 'running' };
          processes.set(details.taskId, details);
        } else assert.fail(input.action);
        return { result: { details } };
      },
    });
    if (args.action === 'start' && !result.isError) {
      socketDirs.push(JSON.parse(await readFile(join(result.details.artifacts, 'manifest.json'), 'utf8')).socketDir);
    }
    return result;
  };
  t.after(async () => {
    await dispatch('session_shutdown', { reason: 'reload' });
    loaded.runtime.invalidate();
    events.clear();
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
    await rm(root, { recursive: true, force: true });
    for (const dir of socketDirs) await rm(dir, { recursive: true, force: true });
  });
  return { root, owner, ctx, events, tool, call, command, dispatch, footers, errors, notices, footer: () => footer, paints: () => paints };
}

test('local packages load independently and together through installed Pi discovery', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'pi-statusline-packages-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  for (const names of [['statusline'], ['subagent'], ['statusline', 'subagent'], ['subagent', 'statusline']]) {
    const loader = new sdk.DefaultResourceLoader({
      cwd: source, agentDir,
      settingsManager: sdk.SettingsManager.inMemory({ packages: names.map(name => join(source, name)) }),
      noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    });
    await loader.reload();
    const result = loader.getExtensions();
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.extensions.map(extension => extension.resolvedPath).sort(), names.map(name => join(source, name, 'index.ts')).sort());
    result.runtime.invalidate();
  }
});

test('statusline alone replaces snapshots, controls one footer, and disposes timers and subscriptions', async t => {
  const f = await fixture(t, ['statusline']);
  await f.dispatch('session_start');
  assert.equal(f.footer().render(100).length, 1);
  assert.match(plain(f.footer().render(100)[0]), /12.5%\/66k parent · high$/);
  const task = { taskId: 'a', process: 'running', topic: 'Visible worker', model: 'model', thinkingLevel: 'off', startedAt: Date.now() };
  f.events.emit('subagent:tasks', { owner: 'foreign', tasks: [task] });
  assert.equal(f.footer().render(100).length, 1);
  f.events.emit('subagent:tasks', { owner: f.owner, tasks: [task] });
  assert.equal(f.footer().render(100).length, 2);
  const old = f.footer();
  let requests = 0;
  const unsub = f.events.on('subagent:tasks-request', request => {
    assert.equal(request.owner, f.owner);
    requests++;
    request.reply({ owner: f.owner, tasks: [{ ...task, topic: 'Fresh snapshot' }] });
  });
  await f.command('statusline', 'off');
  assert.equal(f.footer(), undefined);
  const paints = f.paints();
  await delay(1050);
  assert.equal(f.paints(), paints);
  f.events.emit('subagent:tasks', { owner: f.owner, tasks: [] });
  await f.command('statusline', 'on');
  assert.equal(requests, 1);
  assert.ok(f.footer().render(100).some(line => line.includes('Fresh snapshot')));
  await f.command('statusline', 'on');
  assert.equal(requests, 2);
  assert.notEqual(f.footer(), old);
  await f.command('statusline', 'invalid');
  assert.deepEqual(f.errors, ['Usage: /statusline on|off']);
  f.events.emit('subagent:tasks', { owner: f.owner, tasks: [] });
  assert.equal(f.footer().render(100).length, 1);
  const active = f.footer();
  await f.dispatch('session_shutdown', { reason: 'reload' });
  assert.equal(f.footer(), undefined);
  const after = f.paints();
  f.events.emit('subagent:tasks', { owner: f.owner, tasks: [task] });
  await delay(1050);
  assert.equal(f.paints(), after);
  assert.equal(active.render(100).length, 1);
  unsub();
});

for (const names of [['subagent'], ['subagent', 'statusline'], ['statusline', 'subagent']]) {
  test(`${names.join(' + ')} scopes snapshots, redraws cards, and removes failed observations without affecting wake`, async t => {
    const f = await fixture(t, names);
    const snapshots = [];
    f.events.on('subagent:tasks', event => snapshots.push(event));
    await f.dispatch('session_start');
    if (names.length === 1) assert.equal(f.footers.length, 0);
    const tool = new ToolExecutionComponent('subagent', 'card', {}, {}, f.tool, { requestRender() { cardPaints++; } }, f.root);
    let cardPaints = 0;
    tool.updateResult({ content: [{ type: 'text', text: 'Diagnostics' }], details: {}, isError: true });
    assert.deepEqual(tool.render(100), []);
    await f.command('subagent-ui', 'on');
    assert.ok(cardPaints > 0);
    assert.match(plain(tool.render(100).join('\n')), /Diagnostics/);
    await f.command('subagent-ui', 'off');
    assert.deepEqual(tool.render(100), []);
    const task = (await f.call({ action: 'start', task: 'No model request', model: 'test/model', topic: 'Live task' })).details;
    let snapshot;
    f.events.emit('subagent:tasks-request', { owner: f.owner, reply: value => { snapshot = value; } });
    assert.equal(snapshot.owner, f.owner);
    assert.equal(snapshot.tasks.length, 1);
    assert.equal(snapshot.tasks[0].taskId, task.taskId);
    const live = snapshot.tasks[0];
    f.events.emit('subagent:tasks-request', { owner: 'foreign', reply: () => assert.fail('Foreign snapshot answered') });
    f.events.emit('background-task:subagent', { owner: 'foreign', type: 'completion', task: { taskId: task.taskId, process: 'failed' } });
    assert.equal(snapshots.at(-1).tasks.length, 1);
    if (f.footer()) assert.equal(f.footer().render(100).length, 2);
    const originalBinding = await readFile(join(task.artifacts, 'binding.json'), 'utf8');
    await writeFile(join(task.artifacts, 'binding.json'), '{broken');
    f.events.emit('background-task:subagent', { owner: f.owner, type: 'completion', task: { taskId: task.taskId, process: 'failed' } });
    assert.deepEqual(snapshots.at(-1), { owner: f.owner, tasks: [] });
    if (f.footer()) assert.equal(f.footer().render(100).length, 1);
    await delay(50);
    assert.ok(f.errors.some(message => message.startsWith('Subagent:')));
    await writeFile(join(task.artifacts, 'binding.json'), originalBinding);
    f.events.emit('background-task:subagent', { owner: f.owner, type: 'status', task: { taskId: task.taskId, process: 'running' } });
    await delay(50);
    assert.equal(snapshots.at(-1).tasks.length, 0);
    const next = (await f.call({ action: 'start', task: 'Completion task', model: 'test/model' })).details;
    const savedError = console.error;
    const listenerErrors = [];
    console.error = (...args) => listenerErrors.push(args);
    const unsub = f.events.on('subagent:tasks', () => { throw new Error('Display listener failure'); });
    try {
      f.events.emit('background-task:subagent', { owner: f.owner, type: 'completion', task: { taskId: next.taskId, process: 'succeeded' } });
      await delay(100);
      assert.ok(listenerErrors.length > 0);
      assert.equal(f.notices.filter(item => item.message.details.taskId === next.taskId && item.message.details.type === 'subagent-completion').length, 1);
      assert.deepEqual(f.notices.at(-1).options, { triggerTurn: true, deliverAs: 'followUp' });
    } finally { unsub(); console.error = savedError; }
    f.events.emit('background-task:owner-cleanup', { owner: f.owner });
    assert.deepEqual(snapshots.at(-1), { owner: f.owner, tasks: [] });
    f.events.emit('background-task:subagent', { owner: f.owner, type: 'status', task: live });
    await delay(50);
    assert.equal(snapshots.at(-1).tasks.length, 0);
  });
}

test('replacement rejects delayed restoration from an old controller even when the owner ID is unchanged', async t => {
  const f = await fixture(t, ['statusline', 'subagent']);
  await f.dispatch('session_start');
  const task = (await f.call({ action: 'start', task: 'Old generation', model: 'test/model', topic: 'Old generation' })).details;
  let resolveSnapshot;
  const unsub = f.events.on('background-task:snapshot', request => {
    request.reply(new Promise(resolve => { resolveSnapshot = resolve; }));
  });
  f.events.emit('background-task:ready', { owner: f.owner });
  assert.equal(typeof resolveSnapshot, 'function');
  unsub();
  await f.dispatch('session_start');
  assert.equal(f.footer().render(100).length, 1);
  resolveSnapshot([{ taskId: task.taskId, process: 'running' }]);
  await delay(100);
  let snapshot;
  f.events.emit('subagent:tasks-request', { owner: f.owner, reply: value => { snapshot = value; } });
  assert.deepEqual(snapshot, { owner: f.owner, tasks: [] });
  assert.equal(f.footer().render(100).length, 1);
  assert.deepEqual(f.notices, []);
  const nextOwner = randomUUID();
  const nextContext = { ...f.ctx, sessionManager: { getSessionId: () => nextOwner } };
  await f.dispatch('session_start', {}, nextContext);
  f.events.emit('subagent:tasks', { owner: f.owner, tasks: [{ taskId: task.taskId, topic: 'Old generation', startedAt: 0 }] });
  f.events.emit('background-task:subagent', { owner: f.owner, type: 'completion', task: { taskId: task.taskId, process: 'failed' } });
  assert.equal(f.footer().render(100).length, 1);
  await f.dispatch('session_shutdown', { reason: 'reload' });
  f.events.emit('subagent:tasks-request', { owner: nextOwner, reply: () => assert.fail('Disposed producer answered') });
  assert.deepEqual(f.errors, []);
});

test('non-terminal modes install no footer or repaint timer', async t => {
  for (const mode of ['rpc', 'json', 'print']) {
    const f = await fixture(t, ['statusline'], mode);
    await f.dispatch('session_start');
    await f.command('statusline', 'off');
    await f.command('statusline', 'on');
    assert.equal(f.footers.length, 0);
  }
});
