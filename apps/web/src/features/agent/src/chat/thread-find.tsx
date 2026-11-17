import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { useAgentText } from "../i18n";
import { findMatchRanges, nextMatchIndex } from "./thread-find-model";
import "./thread-find.css";

type Match = { range: Range; text: Text; start: number; end: number };
type HighlightRegistry = { set(name: string, value: unknown): void; delete(name: string): void };
const highlightRegistry = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
const HighlightCtor = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;

function messageGroup(root: Element | null): HTMLElement | null {
  return root?.querySelector<HTMLElement>('[data-slot="aui_message-group"]') ?? null;
}

function textNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest("script, style, textarea, input, select, [contenteditable=true], [data-thread-find-ignore], .sr-only")) return NodeFilter.FILTER_REJECT;
      if (parent.getClientRects().length === 0) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return nodes;
}

function paint(matches: readonly Match[], active: number) {
  if (!highlightRegistry || !HighlightCtor) return;
  highlightRegistry.delete("thread-find");
  highlightRegistry.delete("thread-find-active");
  if (!matches.length) return;
  highlightRegistry.set("thread-find", new HighlightCtor(...matches.map(match => match.range)));
  const current = matches[active];
  if (current) highlightRegistry.set("thread-find-active", new HighlightCtor(current.range));
}

/** In-thread literal search over rendered text; hidden or collapsed rows are not searched. */
export function ThreadFind() {
  const t = useAgentText();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [count, setCount] = useState(0);
  const [active, setActive] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const matchesRef = useRef<Match[]>([]);
  const rootRef = useRef<Element | null>(null);
  const mutationTimer = useRef<number | undefined>(undefined);

  const collect = useCallback((nextQuery: string) => {
    const group = messageGroup(rootRef.current);
    if (!group || !nextQuery.trim()) {
      matchesRef.current = [];
      setCount(0); setActive(-1); paint([], -1);
      return;
    }
    const nodes = textNodes(group);
    const ranges = findMatchRanges(nodes.map(node => node.nodeValue ?? ""), nextQuery);
    const matches: Match[] = [];
    for (const entry of ranges) {
      const node = nodes[entry.textIndex];
      if (!node) continue;
      const range = document.createRange();
      range.setStart(node, entry.start);
      range.setEnd(node, entry.end);
      matches.push({ range, text: node, start: entry.start, end: entry.end });
    }
    matchesRef.current = matches;
    setCount(matches.length);
    setActive(matches.length ? 0 : -1);
    paint(matches, matches.length ? 0 : -1);
  }, []);

  useEffect(() => {
    rootRef.current = wrapperRef.current?.closest(".aui-thread-root") ?? null;
    if (!open) return;
    const timer = window.setTimeout(() => collect(query), 120);
    return () => window.clearTimeout(timer);
  }, [open, query, collect]);

  useEffect(() => {
    if (!open) return;
    const group = messageGroup(rootRef.current);
    if (!group) return;
    const observer = new MutationObserver(() => {
      if (mutationTimer.current) window.clearTimeout(mutationTimer.current);
      mutationTimer.current = window.setTimeout(() => collect(query), 150);
    });
    observer.observe(group, { childList: true, characterData: true, subtree: true });
    return () => { observer.disconnect(); if (mutationTimer.current) window.clearTimeout(mutationTimer.current); };
  }, [open, query, collect]);

  useEffect(() => {
    if (!open) { paint([], -1); return; }
    paint(matchesRef.current, active);
    const current = matchesRef.current[active];
    current?.range.startContainer.parentElement?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [active, open]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setOpen(true);
        return;
      }
      if (event.key === "Escape" && open) {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  useEffect(() => () => paint([], -1), []);

  const close = () => { setOpen(false); setQuery(""); matchesRef.current = []; setCount(0); setActive(-1); paint([], -1); };
  const move = (delta: 1 | -1) => setActive(index => nextMatchIndex(index, matchesRef.current.length, delta));
  return <div ref={wrapperRef}>{open && <div className="thread-find" role="search" aria-label={t("在会话中查找", "Find in conversation")} data-thread-find-ignore>
    <Search aria-hidden="true" className="thread-find-icon" />
    <input ref={inputRef} value={query} onChange={event => setQuery(event.target.value)} placeholder={t("查找消息", "Find in messages")} aria-label={t("查找消息", "Find in messages")}
      onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); move(event.shiftKey ? -1 : 1); } if (event.key === "Escape") { event.preventDefault(); close(); } }} />
    <span className="thread-find-count" aria-live="polite">{count ? `${active + 1}/${count}` : `0/${count}`}</span>
    <button type="button" disabled={!count} aria-label={t("上一个匹配", "Previous match")} onClick={() => move(-1)}><ChevronUp aria-hidden="true" /></button>
    <button type="button" disabled={!count} aria-label={t("下一个匹配", "Next match")} onClick={() => move(1)}><ChevronDown aria-hidden="true" /></button>
    <button type="button" aria-label={t("关闭查找", "Close find")} onClick={close}><X aria-hidden="true" /></button>
  </div>}</div>;
}
