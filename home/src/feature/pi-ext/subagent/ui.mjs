export function toolRenderer(visible, text, theme, Text) {
  return { invalidate() {}, render(width) { return visible() ? new Text(theme.fg('toolOutput', text()), 0, 0).render(width) : []; } };
}
