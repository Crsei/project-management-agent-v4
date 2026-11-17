/** Active tick follows the last message whose top has reached the reading line. */
export function resolveActiveMinimapIndex(items: readonly { top: number }[], scrollTop: number, scrollHeight: number): number {
  if (!items.length) return -1;
  const current = (scrollTop / Math.max(1, scrollHeight)) * 100;
  let active = 0;
  for (let index = 0; index < items.length; index++) if (items[index]!.top <= current + 4) active = index;
  return active;
}
