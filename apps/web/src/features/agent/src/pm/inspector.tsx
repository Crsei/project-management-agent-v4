import { lazy, Suspense, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Files, GitBranch, Globe, PanelRightClose, TerminalSquare } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@agent/components/ui/sheet";
import { InspectorScopeProvider } from "../workspace/inspector/scope";
import type { AgentScope } from "./state";
import { useAgentText } from "../i18n";
import "../../styles/inspector.css";

const FilesPanel = lazy(() => import("../workspace/inspector/files-panel").then((module) => ({ default: module.FilesPanel })));
const GitPanel = lazy(() => import("../workspace/inspector/git-panel").then((module) => ({ default: module.GitPanel })));
const TerminalPanel = lazy(() => import("../workspace/inspector/terminal-panel").then((module) => ({ default: module.TerminalPanel })));
const BrowserPanel = lazy(() => import("../workspace/inspector/browser-panel").then((module) => ({ default: module.BrowserPanel })));
const panels = [
  { id: "files", label: "Files", Icon: Files, Component: FilesPanel },
  { id: "git", label: "Git", Icon: GitBranch, Component: GitPanel },
  { id: "terminal", label: "Terminal", Icon: TerminalSquare, Component: TerminalPanel },
  { id: "browser", label: "Browser", Icon: Globe, Component: BrowserPanel },
] as const;
type Panel = typeof panels[number]["id"];
export type InspectorPanel = Panel;
export const DEFAULT_INSPECTOR_PANEL: InspectorPanel = "files";
const COMPACT_WIDTH = 1100;

/** The chat shell keys this component by scope, thread and directory identity. */
export function PmInspector({ scope, threadId, path, disabled, panel, onPanelChange }: {
  scope?: AgentScope; threadId?: string; path?: string | null; disabled: boolean; panel: InspectorPanel | null; onPanelChange: (panel: InspectorPanel | null) => void;
}) {
  const t = useAgentText();
  const marker = useRef<HTMLSpanElement>(null);
  const [availableWidth, setAvailableWidth] = useState(() => typeof window === "undefined" ? 0 : window.innerWidth);
  const compact = availableWidth <= COMPACT_WIDTH;
  const [width, setWidth] = useState(440);
  const aside = useRef<HTMLElement>(null);
  const dragging = useRef(false);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const id = useId();
  const current = !disabled && scope ? panels.find((item) => item.id === panel) : undefined;
  const maxWidth = Math.floor(Math.max(320, Math.min(720, availableWidth * 0.45)));
  const visibleWidth = Math.max(320, Math.min(maxWidth, width));
  const clampWidth = (next: number) => Math.max(320, Math.min(maxWidth, next));

  useEffect(() => {
    const shell = marker.current?.parentElement;
    if (!shell) return;
    const measure = () => {
      const shellWidth = shell.getBoundingClientRect().width;
      setAvailableWidth(shellWidth > 0 ? Math.min(window.innerWidth, shellWidth) : window.innerWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const next = event.key === "ArrowRight" ? (index + 1) % panels.length
      : event.key === "ArrowLeft" ? (index + panels.length - 1) % panels.length
      : event.key === "Home" ? 0
      : event.key === "End" ? panels.length - 1
      : null;
    if (next === null) return;
    event.preventDefault();
    tabRefs.current[next]?.focus();
  };

  const tabs = <div className="pm-agent-inspector-tabs" role="tablist" aria-label={t("当前上下文工具", "Context tools")}>
    {panels.map(({ id: panelId, label, Icon }, index) => <button
      key={panelId}
      ref={(element) => { tabRefs.current[index] = element; }}
      type="button"
      className="pm-agent-inspector-tab"
      role="tab"
      id={`${id}-tab-${panelId}`}
      aria-controls={`${id}-panel-${panelId}`}
      aria-selected={current?.id === panelId}
      tabIndex={current?.id === panelId ? 0 : -1}
      disabled={disabled || !scope}
      onClick={() => onPanelChange(panelId)}
      onKeyDown={(event) => handleTabKey(event, index)}
    ><Icon aria-hidden="true" /><span>{label}</span></button>)}
  </div>;
  const close = <button type="button" className="pm-agent-inspector-close" aria-label={t("关闭检查器", "Close inspector")} title={t("关闭检查器", "Close inspector")} onClick={() => onPanelChange(null)}><PanelRightClose aria-hidden="true" /></button>;
  const content = current && scope ? <InspectorScopeProvider scope={{ ...scope, threadId }}>
    {panels.map(({ id: panelId, Component }) => <section
      key={panelId}
      className="pm-agent-inspector-body"
      role="tabpanel"
      id={`${id}-panel-${panelId}`}
      aria-labelledby={`${id}-tab-${panelId}`}
      hidden={current.id !== panelId}
      tabIndex={0}
    >{current.id === panelId && <Suspense fallback={<p role="status">{t("正在加载面板…", "Loading panel…")}</p>}><Component active /></Suspense>}</section>)}
  </InspectorScopeProvider> : null;
  return <>
    <span ref={marker} hidden aria-hidden="true" />
    {!compact && current && <>
      <div className="pm-agent-inspector-resizer" role="separator" aria-label={t("调整检查器宽度", "Resize inspector")} aria-orientation="vertical" aria-controls={`${id}-inspector`} aria-valuemin={320} aria-valuemax={Math.floor(maxWidth)} aria-valuenow={Math.round(visibleWidth)} tabIndex={0}
        onPointerDown={(event) => { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={(event) => { if (dragging.current && aside.current) setWidth(clampWidth(aside.current.getBoundingClientRect().right - event.clientX)); }}
        onPointerUp={(event) => { dragging.current = false; event.currentTarget.releasePointerCapture(event.pointerId); }}
        onPointerCancel={() => { dragging.current = false; }}
        onLostPointerCapture={() => { dragging.current = false; }}
        onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setWidth(clampWidth(visibleWidth + (event.key === "ArrowLeft" ? 24 : -24))); } }} />
      <aside id={`${id}-inspector`} ref={aside} className="pm-agent-inspector" style={{ width: visibleWidth }} aria-label={t("上下文工具", "Context tools")}>
        <header className="pm-agent-inspector-header">{tabs}{close}</header>
        <code className="pm-agent-inspector-path" title={path ?? undefined}>{path ?? t("未提供目录", "No directory provided")}</code>{content}
      </aside>
    </>}
    {compact && <Sheet open={!!current} onOpenChange={(open) => { if (!open) onPanelChange(null); }}><SheetContent side="right" showCloseButton={false} className="pm-agent-inspector-sheet">
      <SheetHeader className="pm-agent-inspector-header"><SheetTitle className="sr-only">{t("上下文工具", "Context tools")}</SheetTitle>{tabs}{close}</SheetHeader>
      <code className="pm-agent-inspector-path" title={path ?? undefined}>{path ?? t("未提供目录", "No directory provided")}</code>{content}
    </SheetContent></Sheet>}
  </>;
}
