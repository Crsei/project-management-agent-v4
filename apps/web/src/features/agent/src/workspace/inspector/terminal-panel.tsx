import { useCallback, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import type { TerminalDescriptor, TerminalServerMessage } from "@agent-workspace/contracts/inspector";
import { WorkspaceClientError } from "@agent-workspace/client-runtime";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@agent/components/ui/button";
import { workspaceClient } from "@agent/src/network";
import { getChatBrowserPreferences, useChatBrowserPreferences } from "@agent/src/settings/browser-preferences";
import { useAgentText } from "../../i18n";
import { agentText } from "../../i18n-text.ts";
import { nextTerminalInput, reconcileTerminalInput, shouldRenderTerminalOutput, terminalClientIdentity } from "./terminal-client-state";

function readTerminalTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const color = (token: string, fallback: string) => styles.getPropertyValue(token).trim() || fallback;
  return { background: color("--background", "#111110"), foreground: color("--foreground", "#ecece8"), cursor: color("--brand", "#de9a7b"), cursorAccent: color("--background", "#111110"), brightBlack: color("--muted-foreground", "#b0b0a8") };
}

/** Only attaches to an already-created service-owned PTY. Unmount never terminates it. */
export function TerminalPanel({ terminal: descriptor, active = true, onExit }: { terminal: TerminalDescriptor; active?: boolean; onExit?: (exitCode: number, signal?: number) => void }) {
  const t = useAgentText();
  const { preferences } = useChatBrowserPreferences();
  const container = useRef<HTMLDivElement>(null);
  const xterm = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const inputReady = useRef(false);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const lastRendered = useRef(0);
  const [storage] = useState<Storage | undefined>(() => { try { return sessionStorage; } catch { return undefined; } });
  const [identity] = useState(() => terminalClientIdentity(descriptor.id, storage));
  const [status, setStatus] = useState("connecting");
  const [error, setError] = useState<string>();
  const [inputWarning, setInputWarning] = useState(false);
  const [reconnect, setReconnect] = useState(0);
  const fitTerminal = useCallback(() => {
    if (!container.current || container.current.clientWidth < 24 || container.current.clientHeight < 24 || !fit.current || !xterm.current) return;
    fit.current.fit();
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "resize", cols: xterm.current.cols, rows: xterm.current.rows }));
  }, []);

  useEffect(() => {
    if (!container.current) return;
    const term = new Terminal({ cursorBlink: true, fontSize: getChatBrowserPreferences().terminalFontSize, fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-ibm-plex-mono").trim() || 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace', scrollback: 5000, theme: readTerminalTheme() });
    const addon = new FitAddon(); term.loadAddon(addon); term.open(container.current);
    xterm.current = term; fit.current = addon; lastRendered.current = 0;
    const observer = new ResizeObserver(fitTerminal); observer.observe(container.current);
    const input = term.onData(data => {
      if (!inputReady.current || socket.current?.readyState !== WebSocket.OPEN) return;
      socket.current.send(JSON.stringify(nextTerminalInput(identity, descriptor.id, data, storage)));
    });
    fitTerminal();
    return () => { observer.disconnect(); input.dispose(); addon.dispose(); term.dispose(); xterm.current = null; fit.current = null; };
  }, [descriptor.id, fitTerminal]);

  useEffect(() => {
    let disposed = false;
    let retryTimer: number | undefined;
    let heartbeat: number | undefined;
    let connection: WebSocket | undefined;
    let ended = descriptor.status === "exited";
    let attempt = 0;
    let attaching = false;
    const controller = new AbortController();
    const connect = async () => {
      if (disposed || attaching || connection) return;
      attaching = true;
      inputReady.current = false;
      if (retryTimer !== undefined) { window.clearTimeout(retryTimer); retryTimer = undefined; }
      setStatus("connecting"); setError(undefined);
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
          try { message = JSON.parse(String(event.data)) as TerminalServerMessage; } catch { setError(agentText("终端响应无效。", "Invalid terminal response.")); return; }
          switch (message.type) {
            case "ready":
              ended = message.terminal.status === "exited";
              try {
                if (reconcileTerminalInput(identity, descriptor.id, message.acceptedInputSeq, storage).unreceivedInput) setInputWarning(true);
              } catch (cause) {
                ended = true; setStatus("unavailable"); setError(cause instanceof Error ? cause.message : String(cause)); connection?.close(); return;
              }
              inputReady.current = !ended;
              setStatus(ended ? "exited" : "connected"); attempt = 0;
              if (message.truncated) xterm.current?.write(agentText("\r\n[较早输出已超出回放上限]\r\n", "\r\n[Earlier output exceeded the replay limit]\r\n"));
              fitTerminal();
              break;
            case "output":
              if (shouldRenderTerminalOutput(lastRendered.current, message.seq)) { lastRendered.current = message.seq; xterm.current?.write(message.data); }
              break;
            case "ack": identity.acknowledgedSeq = Math.max(identity.acknowledgedSeq, message.seq); break;
            case "exit":
              ended = true; inputReady.current = false; setStatus("exited");
              xterm.current?.write(`\r\n[${agentText("进程已退出", "Process exited")}: ${message.exitCode}${message.signal === undefined ? "" : ` · signal ${message.signal}`}]\r\n`);
              onExitRef.current?.(message.exitCode, message.signal);
              break;
            case "error": ended = true; inputReady.current = false; setStatus("unavailable"); setError(message.message); break;
            case "pong": break;
          }
        };
        connection.onopen = () => { heartbeat = window.setInterval(() => { if (connection?.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: "ping" })); }, 30_000); };
        connection.onerror = () => { if (!disposed) setStatus("disconnected"); };
        connection.onclose = () => {
          inputReady.current = false;
          if (heartbeat !== undefined) window.clearInterval(heartbeat);
          if (socket.current === connection) socket.current = null;
          connection = undefined;
          if (disposed || ended) return;
          setStatus("disconnected");
          if (identity.acknowledgedSeq < identity.inputSeq) setInputWarning(true);
          retryTimer = window.setTimeout(() => void connect(), Math.min(10_000, 1000 * 2 ** attempt++));
        };
      } catch (cause) {
        if (disposed) return;
        const definitive = cause instanceof WorkspaceClientError && cause.kind === "http" && [400, 401, 403, 404, 409, 410, 412].includes(cause.status);
        ended = definitive;
        setStatus(definitive ? "unavailable" : "disconnected");
        setError(`${cause instanceof Error ? cause.message : String(cause)} · ${agentText("只能附加原终端；服务重启不会恢复进程或重放命令。", "Only the original terminal can be attached. Service restart does not restore processes or rerun commands.")}`);
        if (!definitive) retryTimer = window.setTimeout(() => void connect(), Math.min(10_000, 1000 * 2 ** attempt++));
      } finally { attaching = false; }
    };
    void connect();
    const online = () => { if (!ended && !connection) void connect(); };
    window.addEventListener("online", online);
    return () => { disposed = true; inputReady.current = false; controller.abort(); window.removeEventListener("online", online); if (retryTimer !== undefined) window.clearTimeout(retryTimer); if (heartbeat !== undefined) window.clearInterval(heartbeat); if (connection) { connection.onclose = null; connection.onmessage = null; connection.close(); } if (socket.current === connection) socket.current = null; };
  }, [descriptor.id, reconnect, fitTerminal]);

  useEffect(() => { if (!xterm.current) return; xterm.current.options.fontSize = preferences.terminalFontSize; fitTerminal(); }, [preferences.terminalFontSize, fitTerminal]);
  useEffect(() => { if (!active) return; const frame = requestAnimationFrame(() => { fitTerminal(); xterm.current?.focus(); }); return () => cancelAnimationFrame(frame); }, [active, fitTerminal]);
  const unconfirmedInput = inputWarning && <p role="alert" className="text-destructive text-xs">{t("断线前有输入未确认；不会自动重发。请核对输出后确认。", "Input was unacknowledged before disconnect and will not be resent. Inspect the output before dismissing.")}<Button size="sm" variant="ghost" onClick={() => setInputWarning(false)}>{t("已核对", "Reviewed")}</Button></p>;
  return <div className="inspector-panel inspector-panel--bare"><div className="inspector-toolbar"><span role="status">{status === "connected" ? t("已附加", "Attached") : status === "exited" ? t("进程已结束", "Process exited") : status === "unavailable" ? t("不可用", "Unavailable") : status === "connecting" ? t("正在附加", "Attaching") : t("已分离", "Detached")}</span><Button size="sm" variant="ghost" onClick={() => { xterm.current?.clear(); xterm.current?.focus(); }}>{t("清屏", "Clear")}</Button><Button size="sm" variant="ghost" disabled={status === "connecting"} onClick={() => setReconnect(value => value + 1)}>{t("重新附加（不重启）", "Reattach (no restart)")}</Button></div>{unconfirmedInput}{error && <p role="alert" className="text-destructive text-xs">{error}</p>}<div ref={container} className="inspector-terminal" data-native-context-menu /></div>;
}
