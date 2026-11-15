import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { FileOutput, Maximize2, Minimize2, PanelRightClose } from "lucide-react";
import { useAgentText } from "../i18n";
import "../../styles/inspector.css";
import styles from "./run-execution-dock.module.css";

const MIN_WIDTH = 320;
const MAX_WIDTH = 720;

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

/** Run-owned output surface using Chat's inspector geometry, without a modal or Chat runtime. */
export function RunExecutionDock({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const t = useAgentText();
  const id = useId();
  const aside = useRef<HTMLElement>(null);
  const dragging = useRef(false);
  const [width, setWidth] = useState(540);
  const [availableWidth, setAvailableWidth] = useState(() => typeof window === "undefined" ? 1184 : window.innerWidth);
  const [maximized, setMaximized] = useState(false);
  const compact = availableWidth <= 980;
  const maxWidth = Math.max(MIN_WIDTH, Math.floor(Math.min(MAX_WIDTH, availableWidth * 0.45)));
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
    {!compact && !maximized && <div className="pm-right-panel-resizer" role="separator" aria-label={t("调整运行面板宽度", "Resize run panel")} aria-orientation="vertical" aria-controls={id} aria-valuemin={MIN_WIDTH} aria-valuemax={maxWidth} aria-valuenow={Math.round(visibleWidth)} tabIndex={0}
      onPointerDown={event => { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (dragging.current && aside.current) setWidth(clampWidth(aside.current.getBoundingClientRect().right - event.clientX)); }}
      onPointerUp={event => { dragging.current = false; event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => { dragging.current = false; }} onLostPointerCapture={() => { dragging.current = false; }}
      onKeyDown={event => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); setWidth(clampWidth(visibleWidth + (event.key === "ArrowLeft" ? 24 : -24))); }} />}
    <aside ref={aside} id={id} className={`pm-right-panel ${styles.dock}`} data-compact={compact || undefined} data-expanded={!compact && maximized || undefined} style={compact ? undefined : { width: maximized ? Math.max(MIN_WIDTH, availableWidth - 320) : visibleWidth }} aria-label={t("运行输出面板", "Run output panel")}
      onKeyDown={event => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        const target = event.target;
        if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"], [role="alertdialog"]')) return;
        event.preventDefault(); onClose();
      }}>
      <header className="pm-right-panel-tabbar">
        <div className={styles.title} title={title}><FileOutput size={14} aria-hidden="true" /><h2>{title}</h2></div>
        {!compact && <button type="button" className="pm-right-panel-control" aria-label={maximized ? t("恢复面板大小", "Restore panel size") : t("展开运行面板", "Expand run panel")} title={maximized ? t("恢复面板大小", "Restore panel size") : t("展开运行面板", "Expand run panel")} aria-pressed={maximized} onClick={() => setMaximized(value => !value)}>{maximized ? <Minimize2 /> : <Maximize2 />}</button>}
        <button type="button" className="pm-right-panel-control" aria-label={t("关闭运行面板", "Close run panel")} title={t("关闭运行面板", "Close run panel")} onClick={onClose}><PanelRightClose /></button>
      </header>
      <div className={`pm-right-panel-content ${styles.content}`}>{children}</div>
    </aside>
  </>;
}
