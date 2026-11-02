const defaultLabels: Record<string, readonly [en: string, zh: string]> = {
  draft: ['Draft', '草稿'],
  ready: ['Ready', '就绪'],
  todo: ['To do', '待办'],
  in_progress: ['In progress', '进行中'],
  in_review: ['In review', '审核中'],
  review: ['Awaiting review', '待审核'],
  done: ['Completed', '已完成'],
  canceled: ['Canceled', '已取消'],
};

/** Localize the generated default labels only; labels authored in .pm/config.yaml stay as written. */
export function taskStateLabel(state: { id: string; label: string }, en: boolean): string {
  const localized = defaultLabels[state.id];
  return localized && state.label === state.id.replaceAll('_', ' ') ? localized[en ? 0 : 1] : state.label;
}
