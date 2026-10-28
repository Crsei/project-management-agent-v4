import { lazy, Suspense, useRef } from "react";
import { PanelBottom, XIcon } from "lucide-react";
import { InspectorScopeProvider } from "../workspace/inspector/scope";
import type { AgentScope } from "./state";
import "../../styles/inspector.css";

const TerminalPanel = lazy(() => import("../workspace/inspector/terminal-panel").then((module) => ({ default: module.TerminalPanel })));

export const TERMINAL_DRAWER_MIN_HEIGHT = 300;
const clampHeight = (height: number) => Math.max(TERMINAL_DRAWER_MIN_HEIGHT, Math.min(720, window.innerHeight * 0.7, height));

/** Bottom terminal drawer. Closing unmounts the panel, which disconnects the PTY. */
export function TerminalDrawer({ scope, threadId, path, height, onHeightChange, onClose }: {
  scope: AgentScope;
  threadId?: string;
  path?: string | null;
  height: number;
  onHeightChange: (height: number) => void;
  onClose: () => void;
}) {
  const drag = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  return <section className="pm-agent-terminal-drawer" style={{ height }} aria-label="终端抽屉" data-terminal-drawer>
    <div className="pm-agent-terminal-resizer" role="separator" aria-label="调整终端抽屉高度" aria-orientation="horizontal" aria-valuemin={TERMINAL_DRAWER_MIN_HEIGHT} aria-valuemax={Math.round(Math.min(720, window.innerHeight * 0.7))} aria-valuenow={Math.round(height)} tabIndex={0}
      onPointerDown={(event) => {
        drag.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: height };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!drag.current || drag.current.pointerId !== event.pointerId) return;
        onHeightChange(clampHeight(drag.current.startHeight + drag.current.startY - event.clientY));
      }}
      onPointerUp={(event) => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => { drag.current = null; }}
      onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        onHeightChange(clampHeight(height + (event.key === "ArrowUp" ? 24 : -24)));
      }} />
    <header>
      <PanelBottom aria-hidden="true" />
      <strong>终端</strong>
      <small>当前文件区域 · 关闭即断开 PTY</small>
      <button type="button" className="pm-agent-icon" aria-label="关闭终端抽屉" title="关闭终端抽屉" onClick={onClose}><XIcon /></button>
    </header>
    <code className="pm-agent-inspector-path" title={path ?? undefined}>{path ?? "未配置目录"}</code>
    <div className="pm-agent-terminal-body">
      <InspectorScopeProvider scope={{ ...scope, threadId }}>
        <Suspense fallback={<p role="status">正在加载终端…</p>}><TerminalPanel active /></Suspense>
      </InspectorScopeProvider>
    </div>
  </section>;
}
