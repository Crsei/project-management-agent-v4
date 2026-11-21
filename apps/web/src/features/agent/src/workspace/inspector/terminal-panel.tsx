import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalDescriptor, TerminalServerMessage } from "@agent-workspace/contracts/inspector";
import { WorkspaceClientError } from "@agent-workspace/client-runtime";
import { workspaceClient } from "@agent/src/network";
import { useChatBrowserPreferences } from "@agent/src/settings/browser-preferences";
import { useTheme } from "@agent/hooks/use-theme";
import { GhosttyTerminalSurface } from "@/terminal/ghostty/surface";
import type { GhosttyColor, GhosttyTheme } from "@/terminal/ghostty/core";
import { agentText } from "../../i18n-text.ts";
import { nextTerminalInput, reconcileTerminalInput, shouldRenderTerminalOutput, terminalClientIdentity } from "./terminal-client-state";
import { ContextMenu, ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu";
import { useMessageContextDraft } from "../../chat/message-context";
import { terminalSelectionSnapshot } from "./context-selection";

function resolveThemeColor(value: string, fallback: GhosttyColor): GhosttyColor {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return fallback;
  context.fillStyle = "#000000";
  context.fillStyle = value.trim();
  const resolved = context.fillStyle;
  const match = /^#([0-9a-f]{6})$/i.exec(resolved);
  if (!match) return fallback;
  const rgb = Number.parseInt(match[1]!, 16);
  return { r: (rgb >> 16) & 255, g: (rgb >> 8) & 255, b: rgb & 255 };
}

/** Canvas colors cannot use CSS variables directly; read the live theme once per toggle. */
function readGhosttyTheme(): GhosttyTheme {
  const styles = getComputedStyle(document.documentElement);
  const color = (token: string, fallback: GhosttyColor) => resolveThemeColor(styles.getPropertyValue(token), fallback);
  return {
    background: color("--background", { r: 17, g: 17, b: 16 }),
    foreground: color("--foreground", { r: 236, g: 236, b: 232 }),
    cursor: color("--accent", { r: 222, g: 154, b: 123 }),
  };
}

/** Only attaches to an already-created service-owned PTY. Unmount never terminates it. */
export function TerminalPanel({ terminal: descriptor, active = true, onExit }: { terminal: TerminalDescriptor; active?: boolean; onExit?: (exitCode: number, signal?: number) => void }) {
  const { preferences } = useChatBrowserPreferences();
  const { theme } = useTheme();
  const context = useMessageContextDraft();
  const [selectionMenu, setSelectionMenu] = useState<{ text: string; targetKey: string | undefined; terminalId: string; serviceId: string } | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const [contextError, setContextError] = useState<string>();
  const [surfaceError, setSurfaceError] = useState<string>();
  const [surface, setSurface] = useState<GhosttyTerminalSurface | null>(null);
  const [contextPending, setContextPending] = useState(false);
  const contextBusy = useRef(false);
  const contextAlive = useRef(false);
  useEffect(() => { contextAlive.current = true; return () => { contextAlive.current = false; }; }, []);
  useEffect(() => { setSelectionMenu(null); setMenuAnchor(null); setContextError(undefined); }, [context.targetKey]);
  const container = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<GhosttyTerminalSurface | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const inputReady = useRef(false);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const lastRendered = useRef(0);
  const [storage] = useState<Storage | undefined>(() => { try { return sessionStorage; } catch { return undefined; } });
  const [identity] = useState(() => terminalClientIdentity(descriptor.id, storage));
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const descriptorRef = useRef(descriptor);
  descriptorRef.current = descriptor;
  const contextRef = useRef(context);
  contextRef.current = context;
  const activeRef = useRef(active);
  activeRef.current = active;

  const openTerminalMenu = useCallback((event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const currentSurface = surfaceRef.current;
    const currentDescriptor = descriptorRef.current;
    const currentContext = contextRef.current;
    const snapshot = currentSurface && terminalSelectionSnapshot(currentSurface);
    setSelectionMenu(snapshot ? { text: snapshot.text, targetKey: currentContext.targetKey, terminalId: currentDescriptor.id, serviceId: currentDescriptor.serviceId } : null);
    const box = container.current?.getBoundingClientRect();
    setMenuAnchor({ x: event.clientX || (box ? box.left + 8 : 8), y: event.clientY || (box ? box.bottom : 8) });
  }, []);

  async function addSelectedOutput() {
    if (contextBusy.current || !selectionMenu) return;
    const current = surfaceRef.current;
    const snapshot = current && terminalSelectionSnapshot(current);
    if (!snapshot || snapshot.text !== selectionMenu.text || selectionMenu.targetKey !== context.targetKey || selectionMenu.terminalId !== descriptor.id || selectionMenu.serviceId !== descriptor.serviceId) {
      setContextError(agentText("所选输出、终端或会话已变化，请重新选择。", "The selected output, terminal, or session changed. Select the output again."));
      return;
    }
    if (snapshot.text.length > 16000) {
      setContextError(agentText("所选输出超过 16000 字符，请选择较短片段；未截断或添加。", "The selected output exceeds 16,000 characters. Select a shorter excerpt; nothing was truncated or added."));
      return;
    }
    contextBusy.current = true;
    setContextPending(true);
    setContextError(undefined);
    try {
      await context.add({
        contextId: crypto.randomUUID(), kind: "terminal",
        source: { type: "terminal", terminalId: descriptor.id, serviceId: descriptor.serviceId },
        terminalLabel: `${descriptor.scope === "session" ? "Session" : "Workspace"} ${descriptor.id}`,
        text: snapshot.text, selection: snapshot.selection,
      });
      if (contextAlive.current && context.isCurrent() && surfaceRef.current === current && current.getSelection() === snapshot.text) current.clearSelection();
    } catch (cause) {
      if (contextAlive.current && context.isCurrent()) setContextError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      contextBusy.current = false;
      if (contextAlive.current) setContextPending(false);
    }
  }

  useEffect(() => {
    const mount = container.current;
    if (!mount) return;
    let cancelled = false;
    setSurfaceError(undefined);
    void GhosttyTerminalSurface.create(mount, {
      theme: readGhosttyTheme(),
      font: { size: preferencesRef.current.terminalFontSize },
      visible: activeRef.current,
      onData: data => {
        if (!inputReady.current || socket.current?.readyState !== WebSocket.OPEN) return;
        socket.current.send(JSON.stringify(nextTerminalInput(identity, descriptorRef.current.id, data, storage)));
      },
      onResize: (cols, rows) => {
        if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "resize", cols, rows }));
      },
      onSelectionChange: () => {},
      beforeKey: () => false,
      canActivateLink: () => false,
      onLinkActivate: () => {},
      onContextMenu: openTerminalMenu,
    }).then(created => {
      if (cancelled) { created.dispose(); return; }
      created.input.setAttribute("aria-label", agentText("终端输入", "Terminal input"));
      created.scrollbar.setAttribute("aria-label", agentText("终端回滚", "Terminal scrollback"));
      created.setTheme(readGhosttyTheme());
      void created.setFont({ size: preferencesRef.current.terminalFontSize });
      surfaceRef.current = created;
      setSurface(created);
      created.setVisible(activeRef.current);
      if (activeRef.current) created.focus();
    }).catch((cause: unknown) => {
      if (!cancelled) setSurfaceError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      cancelled = true;
      surfaceRef.current?.dispose();
      surfaceRef.current = null;
      setSurface(null);
      mount.replaceChildren();
    };
  }, [descriptor.id, identity, openTerminalMenu, storage]);

  useEffect(() => {
    if (!surface) return;
    let disposed = false;
    let retryTimer: number | undefined;
    let heartbeat: number | undefined;
    let connection: WebSocket | undefined;
    let ended = descriptor.status === "exited";
    let attempt = 0;
    let attaching = false;
    let unconfirmedNotified = false;
    let failureNotified = false;
    const controller = new AbortController();
    const notice = (message: string) => { surface.write(`\r\n[${message}]\r\n`); };
    const notifyUnconfirmed = () => {
      if (unconfirmedNotified) return;
      unconfirmedNotified = true;
      notice(agentText("断线前有输入未确认；不会自动重发。请核对输出。", "Input was unacknowledged before disconnect and will not be resent. Inspect the output."));
    };
    const notifyFailure = (message: string) => {
      if (failureNotified) return;
      failureNotified = true;
      notice(message);
    };
    const connect = async () => {
      if (disposed || attaching || connection) return;
      attaching = true;
      inputReady.current = false;
      if (retryTimer !== undefined) { window.clearTimeout(retryTimer); retryTimer = undefined; }
      try {
        const { terminal } = await workspaceClient.json<{ terminal: TerminalDescriptor }>(`/api/inspector/terminals/${encodeURIComponent(descriptor.id)}`, { signal: controller.signal });
        if (disposed) return;
        ended = terminal.status === "exited";
        const query = new URLSearchParams({ terminalId: terminal.id, afterSeq: String(lastRendered.current), clientId: identity.clientId });
        connection = new WebSocket(workspaceClient.webSocketUrl(`/api/inspector/terminal?${query}`));
        socket.current = connection;
        connection.onmessage = event => {
          if (disposed) return;
          let message: TerminalServerMessage;
          try { message = JSON.parse(String(event.data)) as TerminalServerMessage; } catch { notifyFailure(agentText("终端响应无效。", "Invalid terminal response.")); return; }
          switch (message.type) {
            case "ready":
              ended = message.terminal.status === "exited";
              try {
                if (reconcileTerminalInput(identity, descriptor.id, message.acceptedInputSeq, storage).unreceivedInput) notifyUnconfirmed();
                else unconfirmedNotified = false;
              } catch (cause) {
                ended = true; notifyFailure(cause instanceof Error ? cause.message : String(cause)); connection?.close(); return;
              }
              inputReady.current = !ended;
              attempt = 0; failureNotified = false;
              if (message.truncated) surface.write(agentText("\r\n[较早输出已超出回放上限]\r\n", "\r\n[Earlier output exceeded the replay limit]\r\n"));
              surface.resendSize();
              break;
            case "output":
              if (shouldRenderTerminalOutput(lastRendered.current, message.seq)) { lastRendered.current = message.seq; surface.write(message.data); }
              break;
            case "ack": identity.acknowledgedSeq = Math.max(identity.acknowledgedSeq, message.seq); break;
            case "exit":
              ended = true; inputReady.current = false;
              surface.write(`\r\n[${agentText("进程已退出", "Process exited")}: ${message.exitCode}${message.signal === undefined ? "" : ` · signal ${message.signal}`}]\r\n`);
              onExitRef.current?.(message.exitCode, message.signal);
              break;
            case "error": ended = true; inputReady.current = false; notifyFailure(message.message); break;
            case "pong": break;
          }
        };
        connection.onopen = () => { heartbeat = window.setInterval(() => { if (connection?.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: "ping" })); }, 30_000); };
        connection.onclose = () => {
          inputReady.current = false;
          if (heartbeat !== undefined) window.clearInterval(heartbeat);
          if (socket.current === connection) socket.current = null;
          connection = undefined;
          if (disposed || ended) return;
          if (identity.acknowledgedSeq < identity.inputSeq) notifyUnconfirmed();
          retryTimer = window.setTimeout(() => void connect(), Math.min(10_000, 1000 * 2 ** attempt++));
        };
      } catch (cause) {
        if (disposed) return;
        const definitive = cause instanceof WorkspaceClientError && cause.kind === "http" && [400, 401, 403, 404, 409, 410, 412].includes(cause.status);
        ended = definitive;
        if (definitive) notifyFailure(`${cause instanceof Error ? cause.message : String(cause)} · ${agentText("只能附加原终端；服务重启不会恢复进程或重放命令。", "Only the original terminal can be attached. Service restart does not restore processes or rerun commands.")}`);
        else retryTimer = window.setTimeout(() => void connect(), Math.min(10_000, 1000 * 2 ** attempt++));
      } finally { attaching = false; }
    };
    void connect();
    const online = () => { if (!ended && !connection) void connect(); };
    window.addEventListener("online", online);
    return () => { disposed = true; inputReady.current = false; controller.abort(); window.removeEventListener("online", online); if (retryTimer !== undefined) window.clearTimeout(retryTimer); if (heartbeat !== undefined) window.clearInterval(heartbeat); if (connection) { connection.onclose = null; connection.onmessage = null; connection.close(); } if (socket.current === connection) socket.current = null; };
  }, [descriptor.id, descriptor.status, identity, storage, surface]);

  useEffect(() => { void surfaceRef.current?.setFont({ size: preferences.terminalFontSize }); }, [preferences.terminalFontSize]);
  useEffect(() => { surfaceRef.current?.setTheme(readGhosttyTheme()); }, [theme]);
  useEffect(() => {
    const current = surfaceRef.current;
    if (!current) return;
    current.setVisible(active);
    if (!active) return;
    const frame = requestAnimationFrame(() => { current.fit(); current.focus(); });
    return () => cancelAnimationFrame(frame);
  }, [active, surface]);

  return <div className="inspector-panel inspector-panel--bare relative">
    {surfaceError && <p role="alert" className="absolute inset-x-2 top-2 z-10 rounded border border-border bg-background p-2 text-sm">{agentText("终端渲染加载失败：", "Terminal renderer failed to load: ")}{surfaceError}</p>}
    {contextError && <p role="alert" className="absolute inset-x-2 top-2 z-10 rounded border border-border bg-background p-2 text-sm">{contextError}</p>}
    <ContextMenu open={menuAnchor !== null} {...(menuAnchor ? { anchor: menuAnchor } : {})} onOpenChange={open => { if (!open) setMenuAnchor(null); }}>
      <div ref={container} className="inspector-terminal" data-terminal-surface data-native-context-menu />
      <ContextMenuContent onCloseAutoFocus={event => { event.preventDefault(); surfaceRef.current?.focus(); }}>
        {selectionMenu && context.available && <ContextMenuItem disabled={contextPending} onSelect={() => void addSelectedOutput()}>{agentText("添加到对话", "Add to chat")}</ContextMenuItem>}
        {selectionMenu && <ContextMenuItem onSelect={() => {
          void Promise.resolve().then(() => navigator.clipboard.writeText(selectionMenu.text)).catch(cause => { if (contextAlive.current && context.isCurrent()) setContextError(cause instanceof Error ? cause.message : String(cause)); });
        }}>{agentText("复制所选输出", "Copy selected output")}</ContextMenuItem>}
        <ContextMenuItem onSelect={() => surfaceRef.current?.selectAll()}>{agentText("全选", "Select all")}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  </div>;
}
