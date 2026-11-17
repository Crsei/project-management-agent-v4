import { useCallback, useEffect, useRef, useState } from "react";
import { useAgentText } from "../i18n";
import { resolveActiveMinimapIndex } from "./thread-minimap-model";
import "./thread-minimap.css";

type MinimapItem = { id: string; element: HTMLElement; top: number; label: string };
const MESSAGE_SELECTOR = '[data-slot="aui_user-message-root"], [data-slot="aui_assistant-message-root"]';
const MIN_ITEMS = 6;

/** Compact vertical transcript map. Hidden on narrow layouts; ticks scroll, never mutate messages. */
export function ThreadMinimap() {
  const t = useAgentText();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState<MinimapItem[]>([]);
  const itemsRef = useRef<MinimapItem[]>([]);
  const [active, setActive] = useState(-1);

  const measure = useCallback(() => {
    const root = wrapperRef.current?.closest(".aui-thread-root");
    const viewport = root?.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
    const group = root?.querySelector<HTMLElement>('[data-slot="aui_message-group"]');
    if (!viewport || !group) { setItems([]); setActive(-1); return; }
    const viewportTop = viewport.getBoundingClientRect().top;
    const scrollHeight = Math.max(1, viewport.scrollHeight);
    const next = [...group.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR)].map((element, index) => {
      const rect = element.getBoundingClientRect();
      return {
        id: element.getAttribute("data-slot") + ":" + index,
        element,
        top: Math.min(100, Math.max(0, ((rect.top - viewportTop + viewport.scrollTop) / scrollHeight) * 100)),
        label: (element.textContent ?? "").replace(/\s+/gu, " ").trim().slice(0, 80),
      };
    });
    itemsRef.current = next;
    setItems(next);
    setActive(resolveActiveMinimapIndex(next, viewport.scrollTop, scrollHeight));
  }, []);

  useEffect(() => {
    const root = wrapperRef.current?.closest(".aui-thread-root");
    const viewport = root?.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
    const group = root?.querySelector<HTMLElement>('[data-slot="aui_message-group"]');
    if (!root || !viewport || !group) return;
    measure();
    const mutation = new MutationObserver(() => measure());
    mutation.observe(group, { childList: true, subtree: true, characterData: true });
    const resize = new ResizeObserver(() => measure());
    resize.observe(viewport); resize.observe(group);
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setActive(resolveActiveMinimapIndex(itemsRef.current, viewport.scrollTop, viewport.scrollHeight));
      });
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => { mutation.disconnect(); resize.disconnect(); viewport.removeEventListener("scroll", onScroll); if (frame) cancelAnimationFrame(frame); };
  }, [measure]);

  return <nav ref={wrapperRef} className="thread-minimap" data-empty={items.length < MIN_ITEMS || undefined} aria-label={t("会话消息地图", "Conversation message map")}>
    {items.length >= MIN_ITEMS && items.map((item, index) => <button key={item.id} type="button" style={{ top: `${item.top}%` }} data-active={index === active || undefined}
      title={item.label || t(`消息 ${index + 1}`, `Message ${index + 1}`)} aria-label={t(`跳转到消息 ${index + 1}`, `Jump to message ${index + 1}`)}
      onClick={() => item.element.scrollIntoView({ block: "start", behavior: "smooth" })} />)}
  </nav>;
}
