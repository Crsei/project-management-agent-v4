export type CommandSpace = { id: string; width?: number; priority?: number }
export function commandWidth(action: CommandSpace) {
  return Number.isFinite(action.width) ? Math.max(44, action.width!) : 128
}
/** Stable original order; priority decides which commands retain direct access. */
export function allocateCommands<T extends CommandSpace>(
  actions: readonly T[],
  width: number,
  leadingWidth = 0,
) {
  if (new Set(actions.map((a) => a.id)).size !== actions.length)
    throw new Error("Duplicate toolbar command ID")
  const capacity = Math.max(0, width - Math.max(0, leadingWidth))
  const full = actions.reduce(
    (sum, action) => sum + commandWidth(action) + 8,
    0,
  )
  if (full <= capacity) return { visible: [...actions], overflow: [] as T[] }
  let remaining = Math.max(0, capacity - 52)
  const shown = new Set<string>()
  const ranked = actions
    .map((action, index) => ({ action, index }))
    .sort(
      (a, b) =>
        (b.action.priority ?? 0) - (a.action.priority ?? 0) ||
        a.index - b.index,
    )
  for (const { action } of ranked) {
    const required = commandWidth(action) + 8
    if (required <= remaining) {
      shown.add(action.id)
      remaining -= required
    }
  }
  return {
    visible: actions.filter((a) => shown.has(a.id)),
    overflow: actions.filter((a) => !shown.has(a.id)),
  }
}
