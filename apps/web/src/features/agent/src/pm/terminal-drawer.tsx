import { useRef, type ReactNode } from "react";
import { useAgentText } from "../i18n";
import "../../styles/inspector.css";


export const TERMINAL_DRAWER_MIN_HEIGHT = 300;
const clampHeight = (height: number) => Math.max(TERMINAL_DRAWER_MIN_HEIGHT, Math.min(720, window.innerHeight * 0.7, height));

/** A resizable dock for the shared terminal view; hiding only detaches it. */
export function TerminalDrawer({ children, height, onHeightChange }: {
  children: ReactNode;
  height: number;
  onHeightChange: (height: number) => void;
}) {
  const t = useAgentText();
  const drag = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  return <section className="pm-agent-terminal-drawer" style={{ height }} aria-label={t("终端抽屉", "Terminal drawer")} data-terminal-drawer>
    <div className="pm-agent-terminal-resizer" role="separator" aria-label={t("调整终端抽屉高度", "Resize terminal drawer")} aria-orientation="horizontal" aria-valuemin={TERMINAL_DRAWER_MIN_HEIGHT} aria-valuemax={Math.round(Math.min(720, window.innerHeight * 0.7))} aria-valuenow={Math.round(height)} tabIndex={0}
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
    <div className="pm-agent-terminal-body">
      {children}
    </div>
  </section>;
}
