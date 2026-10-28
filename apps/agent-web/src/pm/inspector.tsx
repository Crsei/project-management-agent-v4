import { lazy, Suspense, useRef, useState, useSyncExternalStore } from "react";
import { Files, GitBranch, Globe, PanelRightClose, TerminalSquare } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { InspectorScopeProvider } from "../workspace/inspector/scope";
import type { AgentScope } from "./state";
import "../../styles/inspector.css";

const FilesPanel = lazy(() => import("../workspace/inspector/files-panel").then((module) => ({ default: module.FilesPanel })));
const GitPanel = lazy(() => import("../workspace/inspector/git-panel").then((module) => ({ default: module.GitPanel })));
const TerminalPanel = lazy(() => import("../workspace/inspector/terminal-panel").then((module) => ({ default: module.TerminalPanel })));
const BrowserPanel = lazy(() => import("../workspace/inspector/browser-panel").then((module) => ({ default: module.BrowserPanel })));
const panels = [
  { id: "files", label: "Files", hint: "当前文件区域 · 只读浏览", Icon: Files, Component: FilesPanel },
  { id: "git", label: "Git", hint: "当前文件区域 · 状态与差异", Icon: GitBranch, Component: GitPanel },
  { id: "terminal", label: "Terminal", hint: "当前文件区域 · 关闭或切换即断开 PTY", Icon: TerminalSquare, Component: TerminalPanel },
  { id: "browser", label: "Browser", hint: "沙箱网页预览 · 不代表服务已启动", Icon: Globe, Component: BrowserPanel },
] as const;
type Panel = typeof panels[number]["id"];
export type InspectorPanel = Panel;
export const DEFAULT_INSPECTOR_PANEL: InspectorPanel = "files";
const subscribe = (notify: () => void) => {
  const media = window.matchMedia("(max-width: 1100px)");
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};

/** The chat shell keys this component by scope, thread and directory identity. */
export function PmInspector({ scope, threadId, path, disabled, panel, onPanelChange }: {
  scope?: AgentScope; threadId?: string; path?: string | null; disabled: boolean; panel: InspectorPanel | null; onPanelChange: (panel: InspectorPanel | null) => void;
}) {
  const compact = useSyncExternalStore(subscribe, () => window.innerWidth <= 1100, () => false);
  const [width, setWidth] = useState(440);
  const aside = useRef<HTMLElement>(null);
  const dragging = useRef(false);
  const current = !disabled && scope ? panels.find((item) => item.id === panel) : undefined;
  const clampWidth = (next: number) => Math.max(320, Math.min(720, window.innerWidth * 0.45, next));
  const content = current && scope ? <InspectorScopeProvider scope={{ ...scope, threadId }}>
    <div className="pm-agent-inspector-body" key={current.id}><Suspense fallback={<p role="status">正在加载面板…</p>}><current.Component active /></Suspense></div>
  </InspectorScopeProvider> : null;
  return <>
    {!compact && current && <>
      <div className="pm-agent-inspector-resizer" role="separator" aria-label="调整检查器宽度" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={720} aria-valuenow={Math.round(width)} tabIndex={0}
        onPointerDown={(event) => { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={(event) => { if (dragging.current && aside.current) setWidth(clampWidth(aside.current.getBoundingClientRect().right - event.clientX)); }}
        onPointerUp={(event) => { dragging.current = false; event.currentTarget.releasePointerCapture(event.pointerId); }}
        onPointerCancel={() => { dragging.current = false; }}
        onLostPointerCapture={() => { dragging.current = false; }}
        onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setWidth((value) => clampWidth(value + (event.key === "ArrowLeft" ? 24 : -24))); } }} />
      <aside ref={aside} className="pm-agent-inspector" style={{ width }} aria-label={`${current.label} 检查器`}>
        <header><div><h2>{current.label}</h2><p>{current.hint}</p></div><button type="button" className="pm-agent-icon" aria-label="关闭检查器" onClick={() => onPanelChange(null)}><PanelRightClose /></button></header>
        <code className="pm-agent-inspector-path" title={path ?? undefined}>{path}</code>{content}
      </aside>
    </>}
    <nav className="pm-agent-inspector-rail" aria-label="当前上下文工具">
      {panels.map(({ id, label, Icon }) => <button key={id} type="button" className="pm-agent-icon" aria-label={label} aria-pressed={current?.id === id} disabled={disabled || !scope} title={disabled || !scope ? `${label} · 请先选择可用文件区域` : label} onClick={() => onPanelChange(panel === id ? null : id)}><Icon /></button>)}
      {current && <button type="button" className="pm-agent-icon" aria-label="隐藏检查器" title="隐藏检查器" onClick={() => onPanelChange(null)}><PanelRightClose /></button>}
    </nav>
    {compact && <Sheet open={!!current} onOpenChange={(open) => { if (!open) onPanelChange(null); }}><SheetContent side="right" className="pm-agent-inspector-sheet">
      <SheetHeader><SheetTitle>{current?.label ?? "上下文工具"}</SheetTitle><SheetDescription>{current?.hint}。切换工作区或目录后请重新打开工具。</SheetDescription></SheetHeader>
      <code className="pm-agent-inspector-path" title={path ?? undefined}>{path}</code>{content}
    </SheetContent></Sheet>}
  </>;
}
