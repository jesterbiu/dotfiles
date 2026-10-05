import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { clean, layout } from '../ui.mjs';
import { LiveTasks } from '../../subagent/tasks.mjs';

const packageDir = process.env.PI_PACKAGE_DIR;
const tui = await import(pathToFileURL(join(packageDir, '../pi-tui/dist/index.js')));
const { initTheme, theme } = await import(pathToFileURL(join(packageDir, 'dist/modes/interactive/theme/theme.js')));
initTheme('dark');

function sgrParams(value) {
  return [...value.matchAll(/\x1b\[([0-9;]*)m/g)].map(match => match[1].split(';').filter(Boolean).map(Number));
}

function assertNoBackgroundOrInverse(value) {
  for (const params of sgrParams(value)) {
    assert.equal(params.includes(7) || params.includes(27), false, JSON.stringify(params));
    assert.equal(params[0] === 48, false, JSON.stringify(params));
    assert.equal((params[0] >= 40 && params[0] <= 47) || (params[0] >= 100 && params[0] <= 107) || params[0] === 49, false, JSON.stringify(params));
  }
}

const plain = value => value.replace(/\x1b\[[0-9;]*m/g, '');

function assertStyled(value, text, tokens) {
  assert.ok(value.includes(theme.style(text, tokens)), `${text}: ${JSON.stringify(value)}`);
}

test('footer keeps the main line unchanged and left-aligns live worker columns across updates', () => {
  assert.equal(clean('\x1b[31mx\n\x07'), 'x');
  let now = 75000;
  const rows = [
    { taskId: 'a', topic: '界short', model: 'astra', thinkingLevel: 'off', startedAt: 70000, process: 'running', phase: 'starting' },
    { taskId: 'b', topic: 'a much longer topic', model: 'model-with-a-name-longer-than-twenty', thinkingLevel: 'minimal', startedAt: 0, process: 'running', phase: 'busy' },
    { taskId: 'c', topic: '\x1b[31m🧑‍💻 é\n topic', model: '界model', thinkingLevel: 'high', startedAt: 50000, process: 'running', phase: 'idle' },
  ];
  const state = new LiveTasks();
  rows.forEach(row => state.update(row));
  const render = (width, workers = state.values()) => layout({ width, workspace: '/界/work', context: '20%/200k', model: 'test', thinking: 'high', rows: workers, now, theme, ...tui });
  const assertColumns = workers => {
    const lines = render(100, workers).slice(1);
    const fields = workers.map(row => {
      const seconds = Math.floor((now - row.startedAt) / 1000);
      return [plain(tui.truncateToWidth(clean(row.topic), 30, '...')), seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`, clean(row.model), clean(row.thinkingLevel)];
    });
    const widths = fields[0].slice(0, 2).map((_, index) => Math.max(...fields.map(values => tui.visibleWidth(values[index]))));
    for (let i = 0; i < lines.length; i++) {
      const values = fields[i];
      const padded = values.slice(0, 2).map((value, index) => value + ' '.repeat(widths[index] - tui.visibleWidth(value)));
      assert.equal(plain(lines[i]), `↳ ${padded[0]} ${padded[1]} ${values[2]} · ${values[3]}`);
      assert.ok(tui.visibleWidth(lines[i]) < 100);
      assert.equal(plain(lines[i]).endsWith(' '), false);
      assertStyled(lines[i], values[0], { fg: 'text' });
      assert.equal(lines[i].includes(theme.style(values[0], { fg: 'text', bold: true })), false);
      assert.ok(lines[i].includes(theme.fg('dim', '↳ ')));
      assertStyled(lines[i], values[1], { fg: 'muted' });
      assertStyled(lines[i], values[2], { fg: 'warning', bold: true });
      assertStyled(lines[i], values[3], { fg: 'warning' });
      assert.ok(lines[i].includes(theme.fg('dim', ' · ')));
      assert.equal(sgrParams(lines[i]).some(params => params.includes(3)), false);
    }
  };
  for (const mode of ['dark', 'light']) {
    initTheme(mode);
    const lines = render(100);
    const main = lines[0];
    const suffix = '20%/200k test · high';
    assert.equal(plain(main), '/界/work' + ' '.repeat(100 - tui.visibleWidth('/界/work') - tui.visibleWidth(suffix)) + suffix);
    assertStyled(main, '/界/work', { fg: 'accent', bold: true });
    assertStyled(main, '20%/200k', { fg: 'success' });
    assertStyled(main, 'test', { fg: 'warning', bold: true });
    assertStyled(main, 'high', { fg: 'warning' });
    assert.ok(main.includes(theme.fg('dim', ' · ')));
    assert.equal(sgrParams(main).some(params => params.includes(3)), false);
    assertColumns(state.values());
    for (let width = 0; width <= 100; width++) {
      const narrow = render(width);
      assert.equal(narrow.length, 4);
      for (const line of narrow) {
        assert.ok(tui.visibleWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
        assertNoBackgroundOrInverse(line);
      }
      if (width === 100) {
        const starts = narrow.slice(1).map((line, index) => {
          const text = plain(line);
          const model = clean(state.values()[index].model);
          return tui.visibleWidth(text.slice(0, text.indexOf(model)));
        });
        assert.equal(starts[0], starts[1]);
        assert.equal(starts[1], starts[2]);
        const dots = narrow.slice(1).map(line => {
          const text = plain(line);
          return tui.visibleWidth(text.slice(0, text.indexOf('·')));
        });
        assert.notEqual(dots[0], dots[1]);
        assert.notEqual(dots[1], dots[2]);
      }
    }
  }
  initTheme('dark');
  now = 100000;
  state.update({ taskId: 'a', topic: 'updated 界 topic that is far longer than thirty columns', model: 'a-model-name-that-is-even-longer-than-before', thinkingLevel: 'medium' });
  assertColumns(state.values());
  state.update({ ...rows[1], taskId: 'b' }, true);
  assertColumns(state.values());
  state.update({ taskId: 'd', topic: 'new', model: 'tiny', thinkingLevel: 'low', startedAt: 98000, process: 'running' });
  assertColumns(state.values());
  assert.equal(plain(render(100)[1]).startsWith('↳ updated 界 topic'), true);
  const capped = plain(tui.truncateToWidth(clean(state.values()[0].topic), 30, '...'));
  assert.ok(tui.visibleWidth(capped) <= 30);
  assert.ok(capped.endsWith('...'));
  assert.ok(plain(render(100)[1]).includes(capped));
  const styled = [];
  layout({ width: 100, workspace: '/new', context: '50%/200k', model: 'other', thinking: 'max', rows: [], now: 0, theme: { fg: (_token, text) => text, style: (text, tokens) => { styled.push(tokens); return text; } }, ...tui });
  assert.deepEqual(styled, [{ fg: 'success' }, { fg: 'warning', bold: true }, { fg: 'warning' }, { fg: 'accent', bold: true }]);
});

test('footer removes terminal rows immediately, blocks late updates, and aggregates only live rows', () => {
  let now = 1000;
  const state = new LiveTasks();
  const render = (width = 100, rows = state.values()) => layout({ width, workspace: '/work', context: '20%', model: 'test', thinking: 'high', rows, now, theme, ...tui });
  const worker = { topic: 'task', model: 'model', thinkingLevel: 'low', startedAt: 0, process: 'running', phase: 'busy' };
  const terminal = [
    { process: 'succeeded', result: 'succeeded' },
    { process: 'succeeded', result: 'failed' },
    { process: 'succeeded' },
    { process: 'failed', result: 'succeeded' },
    { process: 'cancelled' },
    { process: 'timed_out' },
    { process: 'unknown', phase: 'unknown' },
    { phase: 'terminated' },
    { endedAt: 1000 },
    { observedAt: 1000 },
  ];
  for (const [index, outcome] of terminal.entries()) {
    const taskId = `terminal-${index}`;
    state.update({ ...worker, taskId });
    assert.equal(state.values().length, 1);
    state.update({ taskId, ...outcome });
    assert.deepEqual(state.values(), []);
    assert.equal(render(100, [{ ...worker, ...outcome }]).length, 1);
    state.update({ ...worker, taskId });
    assert.deepEqual(state.values(), []);
    const restored = new LiveTasks();
    restored.update({ ...worker, ...outcome, taskId });
    restored.update({ ...worker, taskId });
    assert.deepEqual(restored.values(), []);
  }
  state.update({ ...worker, taskId: 'completion' });
  state.update({ taskId: 'completion' }, true);
  state.update({ ...worker, taskId: 'completion' });
  assert.deepEqual(state.values(), []);
  for (const phase of ['starting', 'busy', 'idle', 'stopping', 'unknown']) {
    assert.equal(plain(render(100, [{ ...worker, phase }])[1]), '↳ task 1s model · low');
  }
  for (const result of ['succeeded', 'failed', 'unknown']) {
    assert.equal(plain(render(100, [{ ...worker, result }])[1]), '↳ task 1s model · low');
  }
  for (let n = 0; n < 5; n++) state.update({ ...worker, taskId: String(n), topic: `界${n} topic` });
  state.update({ taskId: '4', model: 'hidden-model-name-that-must-not-reserve-a-column', thinkingLevel: 'minimal' });
  assert.equal(plain(render()[1]), '↳ 界0 topic 1s model · low');
  assert.equal(plain(render()[2]), '↳ 界1 topic 1s model · low');
  for (const width of [0, 1, 2, 3, 8, 40, 100]) {
    const lines = render(width);
    assert.equal(lines.length, 4);
    assert.ok(lines.every(line => tui.visibleWidth(line) <= width), JSON.stringify(lines));
  }
  assert.equal(plain(render()[3]), '界2 topic 1s | 界3 topic 1s | 界4 topic 1s');
  assert.match(plain(render(40)[3]), /\.\.\./);
  state.update({ taskId: '0', process: 'unknown' }, true);
  assert.equal(state.values().length, 4);
  assert.equal(plain(render()[3]), '界3 topic 1s | 界4 topic 1s');
  state.update({ taskId: '4', phase: 'terminated' });
  assert.equal(state.values().length, 3);
  assert.equal(render().length, 4);
  assert.equal(plain(render()[3]), '↳ 界3 topic 1s model · low');
  state.update({ ...worker, taskId: '0' });
  state.update({ ...worker, taskId: '4' });
  now = 11000;
  assert.equal(state.values().length, 3);
  assert.equal(new LiveTasks().values().length, 0);
});
