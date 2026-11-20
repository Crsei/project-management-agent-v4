import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { useAuiState, type ThreadMessage } from "@assistant-ui/react";
import { ChevronDown } from "lucide-react";
import { useAgentText } from "../i18n";
import { HISTORY_PAGE_SIZE } from "./history-pagination";
import { useHistoryLoadOutcome } from "./remote-adapter";
import { captureHistoryPosition, type HistoryReadingPosition } from "./history-position";
import "./history-navigation.css";
import { consumeContextSource, getContextSourceTarget, subscribeContextSource } from "./context-source-navigation";

type NavigationState = { firstVisible?: string; folded: string[]; position?: HistoryReadingPosition };
type Turn = { id: string; index: number; label: string; foldable: boolean };
type MessageLocation = { index: number; turn: Turn; startsTurn: boolean };
const EMPTY_STATE: NavigationState = { folded: [] };
const STORAGE_PREFIX = "pm.agent.history-navigation:";
const textCache = new WeakMap<ThreadMessage, string>();

function messageText(message: ThreadMessage) {
  const cached = textCache.get(message);
  if (cached !== undefined) return cached;
  const text = message.content.flatMap((part) => part.type === "text" || part.type === "reasoning" ? [part.text] : part.type === "tool-call" ? [part.toolName] : []).join("\n");
  textCache.set(message, text);
  return text;
}
function readState(id: string): NavigationState {
  try {
    const value = JSON.parse(sessionStorage.getItem(`${STORAGE_PREFIX}${id}`) ?? "null") as NavigationState | null;
    if (!value || !Array.isArray(value.folded) || !value.folded.every((item) => typeof item === "string")) return EMPTY_STATE;
    const position = value.position;
    return {
      firstVisible: typeof value.firstVisible === "string" ? value.firstVisible : undefined,
      folded: value.folded,
      position: position && typeof position.offset === "number" && Number.isFinite(position.offset) && typeof position.bottom === "boolean"
        ? { messageId: typeof position.messageId === "string" ? position.messageId : undefined, offset: position.offset, bottom: position.bottom } : undefined,
    };
  } catch { return EMPTY_STATE; }
}
function saveState(id: string, state: NavigationState) {
  try { sessionStorage.setItem(`${STORAGE_PREFIX}${id}`, JSON.stringify(state)); } catch { /* Reading navigation remains available without browser storage. */ }
}
function viewportFor(toolbar: HTMLDivElement | null) {
  return toolbar?.closest(".aui-thread-root")?.querySelector<HTMLElement>("[data-slot='aui_thread-viewport']") ?? null;
}

type NavigationContextValue = {
  state: NavigationState;
  locations: ReadonlyMap<string, MessageLocation>;
  start: number;
  toolbar: RefObject<HTMLDivElement | null>;
  earlier: () => void;
  toggleFold: (id: string) => void;
};
const Context = createContext<NavigationContextValue | null>(null);

/** Key this provider by the local assistant-ui thread ID. It never mutates history. */
export function ThreadHistoryNavigationProvider({ children }: { children: ReactNode }) {
  const localId = useAuiState((state) => state.threads.mainThreadId);
  const messages = useAuiState((state) => state.thread.messages);
  const loading = useAuiState((state) => state.thread.isLoading);
  const historyReady = useRef(false);
  historyReady.current = !loading && messages.length > 0;
  const [state, setState] = useState(() => readState(localId));
  const toolbar = useRef<HTMLDivElement>(null);
  const readingPosition = useRef(state.position);
  const currentState = useRef(state);
  currentState.current = { ...state, position: readingPosition.current };
  const pendingJump = useRef<{ id: string; offset: number; bottom?: boolean } | null>(null);
  const restored = useRef(false);
  const frame = useRef<number | undefined>(undefined);
  const locations = useMemo(() => {
    const locations = new Map<string, MessageLocation>();
    let turn: Turn | undefined;
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]!;
      const startsTurn = !turn || message.role === "user";
      if (startsTurn) {
        turn = { id: message.id, index, label: messageText(message).replace(/\s+/g, " ").slice(0, 100), foldable: true };
      }
      if (message.role === "assistant" && (message.status.type !== "complete" || message.content.some((part) => part.type === "tool-call" && part.result === undefined))) turn!.foldable = false;
      locations.set(message.id, { index, turn: turn!, startsTurn });
    }
    // The newest turn may contain pending native requests not represented in
    // assistant-ui parts. It stays visible even if the stream is detached.
    if (turn) turn.foldable = false;
    return locations;
  }, [messages]);
  const storedStart = state.firstVisible ? locations.get(state.firstVisible)?.index : undefined;
  const initialStart = Math.max(0, messages.length - HISTORY_PAGE_SIZE);
  const start = storedStart ?? (messages[initialStart] ? locations.get(messages[initialStart]!.id)?.turn.index : undefined) ?? initialStart;

  useEffect(() => {
    if (loading || !messages.length || storedStart !== undefined) return;
    setState((current) => ({ ...current, firstVisible: messages[start]!.id }));
  }, [loading, messages, start, storedStart]);
  useEffect(() => { saveState(localId, currentState.current); }, [localId, state]);

  const capturePosition = useCallback(() => {
    if (!historyReady.current) return;
    const viewport = viewportFor(toolbar.current);
    if (!viewport) return;
    const position = captureHistoryPosition(viewport);
    readingPosition.current = position;
    currentState.current = { ...currentState.current, position };
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportFor(toolbar.current);
    if (!viewport || loading || !messages.length) return;
    const target = pendingJump.current;
    const position = !restored.current ? currentState.current.position : undefined;
    if (!target && !position) { restored.current = true; return; }
    pendingJump.current = null;
    const apply = () => {
      const id = target?.id ?? position?.messageId;
      if (target?.bottom || (!target && position?.bottom)) viewport.scrollTop = viewport.scrollHeight;
      else if (id) {
        const node = Array.from(viewport.querySelectorAll<HTMLElement>("[data-history-message]")).find((element) => element.dataset.historyMessage === id);
        if (node) viewport.scrollTop += node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - (target?.offset ?? position?.offset ?? 0);
      }
    };
    apply();
    restored.current = true;
    // assistant-ui performs its own initial bottom positioning during commit.
    // Reapply this saved anchor once, not on every streaming update.
    const restoreFrame = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(restoreFrame);
  }, [loading, messages.length, start, state.folded]);

  useEffect(() => {
    if (loading || !messages.length) return;
    const initialFrame = requestAnimationFrame(capturePosition);
    return () => cancelAnimationFrame(initialFrame);
  }, [capturePosition, loading, messages.length]);

  useEffect(() => {
    const viewport = viewportFor(toolbar.current);
    if (!viewport) return;
    let storageTimer: number | undefined;
    const onScroll = () => {
      if (frame.current !== undefined) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = undefined;
        capturePosition();
        window.clearTimeout(storageTimer);
        storageTimer = window.setTimeout(() => saveState(localId, currentState.current), 180);
      });
    };
    const persist = () => { capturePosition(); saveState(localId, currentState.current); };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", persist);
    return () => {
      viewport.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", persist);
      if (frame.current !== undefined) { cancelAnimationFrame(frame.current); frame.current = undefined; }
      window.clearTimeout(storageTimer);
      // The old viewport may already show the next thread during cleanup. Keep
      // the last captured anchor instead of reading another session's DOM.
      saveState(localId, currentState.current);
    };
  }, [capturePosition, localId]);

  const jump = useCallback((id: string) => {
    const location = locations.get(id);
    if (!location) return;
    pendingJump.current = { id, offset: 16 };
    setState((current) => ({ ...current, firstVisible: messages[Math.min(start, location.turn.index)]!.id, folded: current.folded.filter((key) => key !== location.turn.id) }));
  }, [locations, messages, start]);
  const sourceTarget = useSyncExternalStore(subscribeContextSource, getContextSourceTarget, () => null);
  const remoteId = useAuiState(value => value.threadListItem.remoteId);
  const [sourceError, setSourceError] = useState<string>();
  const openedSource = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!sourceTarget || sourceTarget.threadId !== remoteId || loading) return;
    if (openedSource.current === sourceTarget.requestId) return;
    openedSource.current = sourceTarget.requestId;
    if (locations.has(sourceTarget.messageId)) { setSourceError(undefined); jump(sourceTarget.messageId); }
    else setSourceError("The quoted source message is missing or no longer available in this session. The saved snapshot is unchanged.");
    if (!sourceTarget.itemId || !locations.has(sourceTarget.messageId)) consumeContextSource(sourceTarget.requestId);
  }, [sourceTarget, remoteId, loading, locations, jump]);
  const earlier = useCallback(() => {
    if (!start) return;
    capturePosition();
    const position = currentState.current.position;
    if (position?.messageId) pendingJump.current = { id: position.messageId, offset: position.offset };
    const next = Math.max(0, start - HISTORY_PAGE_SIZE);
    const turnStart = locations.get(messages[next]!.id)?.turn.index ?? next;
    setState((current) => ({ ...current, firstVisible: messages[turnStart]!.id }));
  }, [capturePosition, locations, messages, start]);
  const applyFolds = useCallback((folded: string[]) => {
    capturePosition();
    const position = readingPosition.current;
    if (position?.messageId) {
      const turn = locations.get(position.messageId)?.turn;
      const collapsedAnchor = turn && folded.includes(turn.id);
      const id = collapsedAnchor ? turn.id : position.messageId;
      const offset = collapsedAnchor ? 16 : position.offset;
      readingPosition.current = { ...position, messageId: id, offset };
      pendingJump.current = { id, offset, bottom: position.bottom };
    }
    setState((current) => ({ ...current, folded }));
  }, [capturePosition, locations]);
  const toggleFold = useCallback((id: string) => {
    if (!locations.get(id)?.turn.foldable) return;
    const folded = currentState.current.folded;
    applyFolds(folded.includes(id) ? folded.filter((key) => key !== id) : [...folded, id]);
  }, [applyFolds, locations]);
  const value = useMemo<NavigationContextValue>(() => ({ state, locations, start, toolbar, earlier, toggleFold }), [state, locations, start, earlier, toggleFold]);
  return <Context.Provider value={value}>{sourceError && <p role="status" className="px-3 py-1 text-xs text-destructive">{sourceError}</p>}{children}</Context.Provider>;
}

export function ThreadHistoryNavigation() {
  const navigation = useContext(Context);
  const t = useAgentText();
  const localId = useAuiState((state) => state.threads.mainThreadId);
  const history = useHistoryLoadOutcome(localId);
  if (!navigation) return null;
  // This element also anchors viewport lookups for reading-position capture, so
  // it stays mounted even when there is no control to show.
  const restoring = history.status === "loading" && history.loadedCount !== undefined;
  return <div ref={navigation.toolbar} data-history-thread={localId} className="chat-history-navigation">
    {navigation.start > 0 && <button type="button" onClick={navigation.earlier}>{t("载入更早消息", "Load earlier messages")} <span>{navigation.start}</span></button>}
    {restoring && <p role="status">{t(`正在恢复完整上下文 ${history.loadedCount}/${history.totalCount ?? "…"}`, `Restoring full context ${history.loadedCount}/${history.totalCount ?? "…"}`)}</p>}
  </div>;
}

/** Hidden/folded turns do not mount Markdown, timelines, or network subscribers. */
export function ThreadHistoryMessage({ children }: { children: ReactNode }) {
  const navigation = useContext(Context);
  const id = useAuiState((state) => state.message.id);
  const t = useAgentText();
  if (!navigation) return <>{children}</>;
  const location = navigation.locations.get(id);
  if (!location || location.index < navigation.start) return null;
  const folded = location.turn.foldable && navigation.state.folded.includes(location.turn.id);
  if (folded && !location.startsTurn) return null;
  return <div data-history-message={id} className="chat-history-message" data-folded={folded || undefined}>
    {location.startsTurn && location.turn.foldable && <button type="button" className="chat-history-fold" aria-expanded={!folded} onClick={() => navigation.toggleFold(location.turn.id)}><ChevronDown aria-hidden="true" /><span>{folded ? location.turn.label || t("展开此轮对话", "Expand this turn") : t("折叠此轮对话", "Fold this turn")}</span></button>}
    {!folded && children}
  </div>;
}
