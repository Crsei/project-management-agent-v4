export type HistoryReadingPosition = { messageId?: string; offset: number; bottom: boolean };

export function captureHistoryPosition(viewport: HTMLElement): HistoryReadingPosition {
  const top = viewport.getBoundingClientRect().top;
  let anchor: HTMLElement | undefined;
  for (const node of viewport.querySelectorAll<HTMLElement>("[data-history-message]")) {
    if (node.getBoundingClientRect().bottom > top + 1) { anchor = node; break; }
  }
  return {
    messageId: anchor?.dataset.historyMessage,
    offset: anchor ? anchor.getBoundingClientRect().top - top : 0,
    bottom: viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 48,
  };
}

export function restoreHistoryPosition(viewport: HTMLElement, position: HistoryReadingPosition) {
  if (position.bottom) { viewport.scrollTop = viewport.scrollHeight; return; }
  const node = Array.from(viewport.querySelectorAll<HTMLElement>("[data-history-message]")).find((element) => element.dataset.historyMessage === position.messageId);
  if (node) viewport.scrollTop += node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - position.offset;
}

/** Continuity reloads must not read or reposition another mounted chat surface. */
export function preserveThreadHistoryPosition(localId: string): () => void {
  const toolbar = Array.from(document.querySelectorAll<HTMLElement>("[data-history-thread]")).find((element) => element.dataset.historyThread === localId);
  const viewport = toolbar?.closest(".aui-thread-root")?.querySelector<HTMLElement>("[data-slot='aui_thread-viewport']");
  const position = viewport ? captureHistoryPosition(viewport) : undefined;
  return () => {
    if (!position) return;
    const currentToolbar = Array.from(document.querySelectorAll<HTMLElement>("[data-history-thread]")).find((element) => element.dataset.historyThread === localId);
    const currentViewport = currentToolbar?.closest(".aui-thread-root")?.querySelector<HTMLElement>("[data-slot='aui_thread-viewport']");
    if (currentViewport) restoreHistoryPosition(currentViewport, position);
  };
}
