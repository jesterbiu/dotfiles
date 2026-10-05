export const clean = value => String(value ?? '').replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, '').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();

const terminal = row => (row.process != null && row.process !== 'running') || row.phase === 'terminated' || row.endedAt != null || row.observedAt != null;

export function layout({ width, workspace, context, model, thinking, rows, now, theme, truncateToWidth, visibleWidth }) {
  width = Math.max(0, Math.floor(width));
  const clip = text => truncateToWidth(text, width, width >= 3 ? '...' : '.'.repeat(width));
  const item = (text, style) => theme.style(text, style);
  const rightPlain = clip(`${clean(context)} ${clean(model)} · ${clean(thinking)}`);
  const right = truncateToWidth([
    item(clean(context), { fg: 'success' }),
    theme.fg('dim', ' '),
    item(clean(model), { fg: 'warning', bold: true }),
    theme.fg('dim', ' · '),
    item(clean(thinking), { fg: 'warning' }),
  ].join(''), width, theme.fg('dim', width >= 3 ? '...' : '.'.repeat(width)));
  const room = Math.max(0, width - visibleWidth(rightPlain) - 1);
  const leftPlain = truncateToWidth(clean(workspace), room, room >= 3 ? '...' : '');
  const left = item(leftPlain, { fg: 'accent', bold: true });
  const main = left + ' '.repeat(Math.max(0, width - visibleWidth(leftPlain) - visibleWidth(rightPlain))) + right;
  const elapsed = row => {
    const seconds = Math.max(0, Math.floor(((row.endedAt ?? now) - row.startedAt) / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
  };
  const label = row => `${clean(row.topic)} ${elapsed(row)}`;
  rows = rows.filter(row => !terminal(row));
  const workers = rows.slice(0, rows.length > 3 ? 2 : 3);
  const fields = workers.map(row => [
    clean(truncateToWidth(clean(row.topic), 30, '...')),
    elapsed(row),
    item(clean(row.model), { fg: 'warning', bold: true }) + theme.fg('dim', ' · ') + item(clean(row.thinkingLevel), { fg: 'warning' }),
  ]);
  const prefix = theme.fg('dim', '↳ ');
  const separators = ['', ' ', ' '];
  const styles = [{ fg: 'text' }, { fg: 'muted' }];
  const columns = [];
  let separatorWidth = visibleWidth(prefix);
  for (let index = 0; index < 3; index++) {
    const gap = visibleWidth(separators[index]);
    if (separatorWidth + gap + columns.length + 1 > width) break;
    separatorWidth += gap;
    columns.push(Math.min(width, Math.max(1, ...fields.map(values => visibleWidth(values[index])))));
  }
  const budget = Math.max(0, width - separatorWidth);
  while (columns.reduce((sum, value) => sum + value, 0) > budget) {
    const widest = columns.indexOf(Math.max(...columns));
    columns[widest]--;
  }
  const normal = values => {
    if (!columns.length) return truncateToWidth(theme.fg('dim', '↳'), width, '');
    return prefix + columns.map((fieldWidth, index) => {
      const text = truncateToWidth(values[index], fieldWidth, fieldWidth >= 3 ? '...' : '.'.repeat(fieldWidth));
      const padding = index === columns.length - 1 ? '' : ' '.repeat(Math.max(0, fieldWidth - visibleWidth(text)));
      return theme.fg('dim', separators[index]) + (index === 2 ? text : item(clean(text), styles[index])) + padding;
    }).join('');
  };
  return [main, ...fields.map(normal), ...(rows.length > 3 ? [clip(rows.slice(2).map(row => theme.fg('muted', label(row))).join(' | '))] : [])];
}

