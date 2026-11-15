import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { useAuiState, type ThreadMessage } from "@assistant-ui/react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronsDownUp, ChevronsUpDown, Map as MapIcon, Search, X } from "lucide-react";
import { useAgentText } from "../i18n";
import { HISTORY_PAGE_SIZE } from "./history-pagination";
import { useHistoryLoadOutcome } from "./remote-adapter";
import { captureHistoryPosition, type HistoryReadingPosition } from "./history-position";
import "./history-navigation.css";
import { consumeContextSource, getContextSourceTarget, subscribeContextSource } from "./context-source-navigation";

type NavigationState = { firstVisible?: string; folded: string[]; query: string; position?: HistoryReadingPosition };
type Turn = { id: string; index: number; label: string; foldable: boolean };
type MessageLocation = { index: number; turn: Turn; startsTurn: boolean };
const EMPTY_STATE: NavigationState = { folded: [], query: "" };
const STORAGE_PREFIX = "pm.agent.history-navigation:";
const textCache = new WeakMap<ThreadMessage, { text: string; lower: string }>();

function messageText(message: ThreadMessage) {
  const cached = textCache.get(message);
  if (cached) return cached;
  const text = message.content.flatMap((part) => part.type === "text" || part.type === "reasoning" ? [part.text] : part.type === "tool-call" ? [part.toolName] : []).join("\n");
  const value = { text, lower: text.toLocaleLowerCase() };
  textCache.set(message, value);
  return value;
}
function readState(id: string): NavigationState {
  try {
    const value = JSON.parse(sessionStorage.getItem(`${STORAGE_PREFIX}${id}`) ?? "null") as NavigationState | null;
    if (!value || !Array.isArray(value.folded) || !value.folded.every((item) => typeof item === "string") || typeof value.query !== "string") return EMPTY_STATE;
    const position = value.position;
    return {
      firstVisible: typeof value.firstVisible === "string" ? value.firstVisible : undefined,
      folded: value.folded,
      query: value.query,
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
  turns: Turn[];
  start: number;
  total: number;
  toolbar: RefObject<HTMLDivElement | null>;
  activeTurn: string | undefined;
  setQuery: (query: string) => void;
  earlier: () => void;
  jump: (id: string) => void;
  toggleFold: (id: string) => void;
  foldAll: (fold: boolean) => void;
  results: string[];
  matchingIds: ReadonlySet<string>;
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
  const [activeTurn, setActiveTurn] = useState<string>();
  const toolbar = useRef<HTMLDivElement>(null);
  const readingPosition = useRef(state.position);
  const currentState = useRef(state);
  currentState.current = { ...state, position: readingPosition.current };
  const pendingJump = useRef<{ id: string; offset: number; bottom?: boolean } | null>(null);
  const restored = useRef(false);
  const frame = useRef<number | undefined>(undefined);
  const { locations, turns } = useMemo(() => {
    const locations = new Map<string, MessageLocation>();
    const turns: Turn[] = [];
    let turn: Turn | undefined;
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]!;
      const startsTurn = !turn || message.role === "user";
      if (startsTurn) {
        turn = { id: message.id, index, label: messageText(message).text.replace(/\s+/g, " ").slice(0, 100), foldable: true };
        turns.push(turn);
      }
      if (message.role === "assistant" && (message.status.type !== "complete" || message.content.some((part) => part.type === "tool-call" && part.result === undefined))) turn!.foldable = false;
      locations.set(message.id, { index, turn: turn!, startsTurn });
    }
    // The newest turn may contain pending native requests not represented in
    // assistant-ui parts. It stays visible even if the stream is detached.
    if (turn) turn.foldable = false;
    return { locations, turns };
  }, [messages]);
  const currentLocations = useRef(locations);
  currentLocations.current = locations;
  const storedStart = state.firstVisible ? locations.get(state.firstVisible)?.index : undefined;
  const initialStart = Math.max(0, messages.length - HISTORY_PAGE_SIZE);
  const start = storedStart ?? (messages[initialStart] ? locations.get(messages[initialStart]!.id)?.turn.index : undefined) ?? initialStart;
  const results = useMemo(() => {
    const query = state.query.trim().toLocaleLowerCase();
    return query ? messages.filter((message) => messageText(message).lower.includes(query)).map((message) => message.id) : [];
  }, [messages, state.query]);
  const matchingIds = useMemo(() => new Set(results), [results]);

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
    const turnId = position.messageId ? currentLocations.current.get(position.messageId)?.turn.id : undefined;
    if (turnId) setActiveTurn((current) => current === turnId ? current : turnId);
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
    setActiveTurn(location.turn.id);
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
  const foldAll = useCallback((fold: boolean) => {
    applyFolds(fold ? turns.filter((turn) => turn.foldable).map((turn) => turn.id) : []);
  }, [applyFolds, turns]);
  const value = useMemo<NavigationContextValue>(() => ({ state, locations, turns, start, total: messages.length, toolbar, activeTurn, results, matchingIds, setQuery: (query) => setState((current) => ({ ...current, query })), earlier, jump, toggleFold, foldAll }), [state, locations, turns, start, messages.length, activeTurn, results, matchingIds, earlier, jump, toggleFold, foldAll]);
  return <Context.Provider value={value}>{sourceError && <p role="status" className="px-3 py-1 text-xs text-destructive">{sourceError}</p>}{children}</Context.Provider>;
}

export function ThreadHistoryNavigation() {
  const navigation = useContext(Context);
  const t = useAgentText();
  const localId = useAuiState((state) => state.threads.mainThreadId);
  const history = useHistoryLoadOutcome(localId);
  const [minimap, setMinimap] = useState(false);
  const [resultId, setResultId] = useState<string>();
  if (!navigation) return null;
  const { state, results, turns } = navigation;
  const resultIndex = resultId ? results.indexOf(resultId) : -1;
  const activeIndex = Math.max(0, turns.findIndex((turn) => turn.id === navigation.activeTurn));
  const moveResult = (delta: number) => {
    if (!results.length) return;
    const index = resultIndex < 0 ? delta > 0 ? 0 : results.length - 1 : (resultIndex + delta + results.length) % results.length;
    const id = results[index]!;
    setResultId(id);
    navigation.jump(id);
  };
  return <div ref={navigation.toolbar} data-history-thread={localId} className="chat-history-navigation" aria-label={t("会话历史导航", "Conversation history navigation")}>
    <div className="chat-history-navigation-row">
      {navigation.start > 0 && <button type="button" onClick={navigation.earlier}>{t("载入更早消息", "Load earlier messages")} <span>{navigation.start}</span></button>}
      <label className="chat-history-search"><Search aria-hidden="true" /><input type="search" value={state.query} placeholder={t("搜索当前会话", "Search this conversation")} aria-label={t("搜索当前会话全部历史", "Search all history in this conversation")} onChange={(event) => { navigation.setQuery(event.target.value); setResultId(undefined); }} onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === "Enter") { event.preventDefault(); moveResult(event.shiftKey ? -1 : 1); } if (event.key === "Escape") navigation.setQuery(""); }} /></label>
      {state.query && <><span role="status" aria-live="polite">{results.length ? resultIndex < 0 ? t(`${results.length} 个匹配`, `${results.length} matches`) : `${resultIndex + 1}/${results.length}` : t("无结果", "No matches")}</span><button type="button" disabled={!results.length} aria-label={t("上一个匹配", "Previous match")} onClick={() => moveResult(-1)}><ChevronLeft /></button><button type="button" disabled={!results.length} aria-label={t("下一个匹配", "Next match")} onClick={() => moveResult(1)}><ChevronRight /></button><button type="button" aria-label={t("清除搜索", "Clear search")} onClick={() => navigation.setQuery("")}><X /></button></>}
      {!!turns.length && <><button type="button" aria-label={t("折叠已完成轮次", "Fold completed turns")} title={t("折叠已完成轮次", "Fold completed turns")} onClick={() => navigation.foldAll(true)}><ChevronsDownUp /></button><button type="button" aria-label={t("展开所有轮次", "Expand all turns")} title={t("展开所有轮次", "Expand all turns")} onClick={() => navigation.foldAll(false)}><ChevronsUpDown /></button><button type="button" aria-expanded={minimap} aria-label={t("会话轮次地图", "Conversation turn map")} onClick={() => setMinimap((open) => !open)}><MapIcon /></button></>}
    </div>
    {history.status === "loading" && history.loadedCount !== undefined && <p role="status">{t(`正在恢复完整上下文 ${history.loadedCount}/${history.totalCount ?? "…"}`, `Restoring full context ${history.loadedCount}/${history.totalCount ?? "…"}`)}</p>}
    {minimap && !!turns.length && <nav className="chat-history-minimap" aria-label={t("轮次地图", "Turn map")}><button type="button" disabled={activeIndex === 0} aria-label={t("上一轮", "Previous turn")} onClick={() => navigation.jump(turns[activeIndex - 1]!.id)}><ChevronLeft /></button><input type="range" min={1} max={turns.length} value={activeIndex + 1} aria-label={t("跳转会话轮次", "Jump to conversation turn")} aria-valuetext={`${activeIndex + 1}/${turns.length}: ${turns[activeIndex]?.label ?? ""}`} onChange={(event) => navigation.jump(turns[Number(event.target.value) - 1]!.id)} /><button type="button" disabled={activeIndex >= turns.length - 1} aria-label={t("下一轮", "Next turn")} onClick={() => navigation.jump(turns[activeIndex + 1]!.id)}><ChevronRight /></button><span>{activeIndex + 1}/{turns.length} · {turns[activeIndex]?.label || t("会话轮次", "Conversation turn")}</span></nav>}
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
  return <div data-history-message={id} className="chat-history-message" data-folded={folded || undefined} data-history-match={navigation.matchingIds.has(id) || undefined}>
    {location.startsTurn && location.turn.foldable && <button type="button" className="chat-history-fold" aria-expanded={!folded} onClick={() => navigation.toggleFold(location.turn.id)}><ChevronDown aria-hidden="true" /><span>{folded ? location.turn.label || t("展开此轮对话", "Expand this turn") : t("折叠此轮对话", "Fold this turn")}</span></button>}
    {!folded && children}
  </div>;
}
