// Store only geometry, never page URLs, form values or workspace state.
export function restoredWindowBounds(saved, defaults, displays) {
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite))
    return { ...defaults };
  const area = displays.map(display => display.workArea).find(area =>
    saved.x < area.x + area.width && saved.x + saved.width > area.x &&
    saved.y < area.y + area.height && saved.y + saved.height > area.y);
  if (!area) return { ...defaults };
  const width = Math.min(Math.max(defaults.minWidth, Math.round(saved.width)), area.width);
  const height = Math.min(Math.max(defaults.minHeight, Math.round(saved.height)), area.height);
  return {
    ...defaults,
    width,
    height,
    x: Math.max(area.x, Math.min(Math.round(saved.x), area.x + area.width - width)),
    y: Math.max(area.y, Math.min(Math.round(saved.y), area.y + area.height - height)),
  };
}

export function captureWindowState(window) {
  if (window.isDestroyed()) return undefined;
  const { x, y, width, height } = window.getNormalBounds();
  return { x, y, width, height, maximized: window.isMaximized() };
}
