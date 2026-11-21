import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Maximize2, MessageSquare, Minimize2, PanelRightClose } from "lucide-react";
import { useAgentText } from "../i18n";
import "../../styles/inspector.css";
import styles from "./run-execution-dock.module.css";

const MIN_WIDTH = 420;
const MAX_WIDTH = 820;
const DEFAULT_WIDTH = 600;

/** Keep the selected card in view when the dock changes the board's available width. */
export function useKeepRunCardVisible(containerRef: RefObject<HTMLElement | null>, selectedId: string | null) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !selectedId) return;
    const observer = new ResizeObserver(() => {
      container.querySelector<HTMLElement>(`[data-agent-run="${CSS.escape(selectedId)}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef, selectedId]);
}

/** Run-owned session surface using Chat's panel geometry, without a modal. */
export function RunExecutionDock({ title, onClose, children, chat }: { title: string; onClose: () => void; children: ReactNode; chat?: boolean }) {
  const t = useAgentText();
  const id = useId();
  const aside = useRef<HTMLElement>(null);
  const dragging = useRef(false);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [availableWidth, setAvailableWidth] = useState(() => typeof window === "undefined" ? 1184 : window.innerWidth);
  const [fullscreen, setFullscreen] = useState(false);
  const compact = availableWidth <= 900;
  const maxWidth = Math.max(MIN_WIDTH, Math.floor(Math.min(MAX_WIDTH, availableWidth * 0.55)));
  const visibleWidth = Math.max(MIN_WIDTH, Math.min(maxWidth, width));
  const clampWidth = (next: number) => Math.max(MIN_WIDTH, Math.min(maxWidth, next));
  useEffect(() => {
    const workspace = aside.current?.parentElement;
    if (!workspace) return;
    const measure = () => setAvailableWidth(workspace.getBoundingClientRect().width || window.innerWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);
  return <>
    {!compact && !fullscreen && <div className="pm-right-panel-resizer" role="separator" aria-label={t("调整运行面板宽度", "Resize run panel")} aria-orientation="vertical" aria-controls={id} aria-valuemin={MIN_WIDTH} aria-valuemax={maxWidth} aria-valuenow={Math.round(visibleWidth)} tabIndex={0}
      onPointerDown={event => { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (dragging.current && aside.current) setWidth(clampWidth(aside.current.getBoundingClientRect().right - event.clientX)); }}
      onPointerUp={event => { dragging.current = false; event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => { dragging.current = false; }} onLostPointerCapture={() => { dragging.current = false; }}
      onKeyDown={event => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); setWidth(clampWidth(visibleWidth + (event.key === "ArrowLeft" ? 24 : -24))); }} />}
    <aside ref={aside} id={id} className={`pm-right-panel ${styles.dock}`} data-compact={compact || undefined} data-fullscreen={fullscreen || undefined} style={compact || fullscreen ? undefined : { width: visibleWidth }} aria-label={t("会话运行面板", "Session run panel")}
      onKeyDown={event => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        const target = event.target;
        if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"], [role="alertdialog"]')) return;
        event.preventDefault();
        if (fullscreen) { setFullscreen(false); return; }
        onClose();
      }}>
      <header className="pm-right-panel-tabbar">
        <div className={styles.title} title={title}><MessageSquare size={14} aria-hidden="true" /><h2>{title}</h2></div>
        {!compact && <button type="button" className="pm-right-panel-control" aria-label={fullscreen ? t("退出全屏", "Exit full screen") : t("全屏显示运行面板", "Show run panel full screen")} title={fullscreen ? t("退出全屏", "Exit full screen") : t("全屏显示运行面板", "Show run panel full screen")} aria-pressed={fullscreen} onClick={() => setFullscreen(value => !value)}>{fullscreen ? <Minimize2 /> : <Maximize2 />}</button>}
        <button type="button" className="pm-right-panel-control" aria-label={t("关闭运行面板", "Close run panel")} title={t("关闭运行面板", "Close run panel")} onClick={onClose}><PanelRightClose /></button>
      </header>
      <div className={`pm-right-panel-content ${chat ? styles.chatContent : styles.content}`}>{children}</div>
    </aside>
  </>;
}
