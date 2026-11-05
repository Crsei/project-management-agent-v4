import { useCallback, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@agent/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type {
  TerminalClientMessage,
  TerminalServerMessage,
} from "@agent-workspace/contracts/inspector";
import { errorMessage } from "./api";
import { useInspectorUrl } from "./scope";
import { workspaceClient } from "@agent/src/network";
import {
  getChatBrowserPreferences,
  useChatBrowserPreferences,
} from "@agent/src/settings/browser-preferences";
import { useAgentText, type AgentText } from "../../i18n";
import { agentText } from "../../i18n-text.ts";

type TerminalStatus = "connecting" | "connected" | "disconnected" | "error";

type ReadyInfo = { cwd: string; shell: string };
type ExitInfo = { exitCode: number; signal?: number };

function statusLabels(t: AgentText): Record<TerminalStatus, string> {
  return {
    connecting: t("连接中", "Connecting"),
    connected: t("已连接", "Connected"),
    disconnected: t("已断开", "Disconnected"),
    error: t("错误", "Error"),
  };
}

const STATUS_DOT_CLASS: Record<TerminalStatus, string> = {
  connecting: "bg-warning",
  connected: "bg-success",
  disconnected: "bg-muted-foreground",
  error: "bg-destructive",
};

/** Keeps the PTY websocket alive while the panel is mounted. */
const PING_INTERVAL_MS = 30_000;

function cssColor(styles: CSSStyleDeclaration, token: string, fallback: string): string {
  const value = styles.getPropertyValue(token).trim();
  return value || fallback;
}

function readTerminalTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const background = cssColor(styles, "--background", "#111110");
  const foreground = cssColor(styles, "--foreground", "#ecece8");
  const brand = cssColor(styles, "--brand", "#de9a7b");
  const mutedForeground = cssColor(styles, "--muted-foreground", "#b0b0a8");
  return {
    background,
    foreground,
    cursor: brand,
    cursorAccent: background,
    brightBlack: mutedForeground,
  };
}

function readMonoFontFamily(): string {
  const styles = getComputedStyle(document.documentElement);
  return (
    cssColor(styles, "--font-ibm-plex-mono", "") ||
    'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace'
  );
}

type RawServerMessage = {
  type?: unknown;
  cwd?: unknown;
  shell?: unknown;
  data?: unknown;
  exitCode?: unknown;
  signal?: unknown;
  message?: unknown;
};

function parseServerMessage(raw: unknown): TerminalServerMessage | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const message = parsed as RawServerMessage;
  if (typeof message.type !== "string") return null;
  switch (message.type) {
    case "ready":
      return typeof message.cwd === "string" && typeof message.shell === "string"
        ? { type: "ready", cwd: message.cwd, shell: message.shell }
        : null;
    case "output":
      return typeof message.data === "string" ? { type: "output", data: message.data } : null;
    case "exit":
      return typeof message.exitCode === "number"
        ? {
            type: "exit",
            exitCode: message.exitCode,
            ...(typeof message.signal === "number" ? { signal: message.signal } : {}),
          }
        : null;
    case "error":
      return typeof message.message === "string"
        ? { type: "error", message: message.message }
        : null;
    case "pong":
      return { type: "pong" };
    default:
      return null;
  }
}

export function TerminalPanel({ active = true }: { active?: boolean }) {
  const t = useAgentText();
  const inspectUrl = useInspectorUrl();
  const { preferences } = useChatBrowserPreferences();
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const pingTimerRef = useRef<number | null>(null);
  const connectionIdRef = useRef(0);
  const disposedRef = useRef(false);
  const exitedRef = useRef(false);
  const menuActionSelected = useRef(false);

  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const [readyInfo, setReadyInfo] = useState<ReadyInfo | null>(null);
  const [exitInfo, setExitInfo] = useState<ExitInfo | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const sendClientMessage = useCallback((message: TerminalClientMessage) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);

  const fitTerminal = useCallback(() => {
    const container = containerRef.current;
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!container || !terminal || !fitAddon) return;
    // Hidden panels (and the mobile sheet before it opens) report a zero box.
    if (container.clientWidth < 24 || container.clientHeight < 24) return;
    try {
      fitAddon.fit();
    } catch {
      // Keep the current dimensions; still tell the PTY about them.
    }
    if (terminal.cols > 0 && terminal.rows > 0) {
      sendClientMessage({ type: "resize", cols: terminal.cols, rows: terminal.rows });
    }
  }, [sendClientMessage]);

  const clearPingTimer = useCallback(() => {
    if (pingTimerRef.current !== null) {
      window.clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
  }, []);

  const startPingTimer = useCallback(
    (connectionId: number) => {
      clearPingTimer();
      pingTimerRef.current = window.setInterval(() => {
        if (disposedRef.current || connectionIdRef.current !== connectionId) {
          clearPingTimer();
          return;
        }
        sendClientMessage({ type: "ping" });
      }, PING_INTERVAL_MS);
    },
    [clearPingTimer, sendClientMessage],
  );

  const handleServerMessage = useCallback((raw: unknown) => {
    const message = parseServerMessage(raw);
    if (!message) return;
    const terminal = terminalRef.current;
    switch (message.type) {
      case "output":
        terminal?.write(message.data);
        return;
      case "ready":
        setReadyInfo({ cwd: message.cwd, shell: message.shell });
        setStatus("connected");
        setExitInfo(null);
        setErrorText(null);
        exitedRef.current = false;
        terminal?.write(
          agentText(
            `\r\n\x1b[2m[已连接 ${message.shell} · ${message.cwd}]\x1b[0m\r\n`,
            `\r\n\x1b[2m[Connected ${message.shell} · ${message.cwd}]\x1b[0m\r\n`,
          ),
        );
        return;
      case "exit": {
        exitedRef.current = true;
        setExitInfo({ exitCode: message.exitCode, signal: message.signal });
        setStatus("disconnected");
        const signalText =
          message.signal !== undefined
            ? agentText(`，信号 ${message.signal}`, `, signal ${message.signal}`)
            : "";
        terminal?.write(
          agentText(
            `\r\n\x1b[33m[终端进程已退出，退出码 ${message.exitCode}${signalText}]\x1b[0m\r\n`,
            `\r\n\x1b[33m[Terminal process exited with code ${message.exitCode}${signalText}]\x1b[0m\r\n`,
          ),
        );
        return;
      }
      case "error":
        setStatus("error");
        setErrorText(message.message);
        terminal?.write(
          agentText(
            `\r\n\x1b[31m[错误] ${message.message}\x1b[0m\r\n`,
            `\r\n\x1b[31m[Error] ${message.message}\x1b[0m\r\n`,
          ),
        );
        return;
      case "pong":
        return;
    }
  }, []);

  const openConnection = useCallback(() => {
    if (disposedRef.current) return;
    const terminal = terminalRef.current;
    if (!terminal) return;

    const connectionId = connectionIdRef.current + 1;
    connectionIdRef.current = connectionId;
    clearPingTimer();

    // Detach the previous socket first so its events cannot touch this connection.
    const previous = socketRef.current;
    socketRef.current = null;
    if (previous) {
      previous.onopen = null;
      previous.onmessage = null;
      previous.onerror = null;
      previous.onclose = null;
      previous.close();
    }

    setStatus("connecting");
    setReadyInfo(null);
    setExitInfo(null);
    setErrorText(null);
    exitedRef.current = false;

    let socket: WebSocket;
    try {
      socket = new WebSocket(workspaceClient.webSocketUrl(inspectUrl("/api/terminal")));
    } catch (error) {
      setStatus("error");
      setErrorText(errorMessage(error));
      return;
    }
    socketRef.current = socket;

    socket.onopen = () => {
      if (disposedRef.current || connectionIdRef.current !== connectionId) return;
      setStatus("connected");
      fitTerminal();
      startPingTimer(connectionId);
    };
    socket.onmessage = (event) => {
      if (disposedRef.current || connectionIdRef.current !== connectionId) return;
      handleServerMessage(event.data);
    };
    socket.onerror = () => {
      if (disposedRef.current || connectionIdRef.current !== connectionId) return;
      setStatus("error");
      setErrorText(agentText("终端连接发生错误。", "The terminal connection failed."));
    };
    socket.onclose = (event) => {
      if (disposedRef.current || connectionIdRef.current !== connectionId) return;
      clearPingTimer();
      socketRef.current = null;
      setReadyInfo(null);
      setStatus((current) => (current === "error" ? "error" : "disconnected"));
      if (!exitedRef.current && event.code !== 1000 && event.reason.trim()) {
        setErrorText(
          agentText(
            `连接已关闭：${event.reason.trim()}`,
            `Connection closed: ${event.reason.trim()}`,
          ),
        );
      }
    };
  }, [clearPingTimer, fitTerminal, handleServerMessage, startPingTimer, inspectUrl]);

  useEffect(() => {
    disposedRef.current = false;
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: getChatBrowserPreferences().terminalFontSize,
      fontFamily: readMonoFontFamily(),
      scrollback: 5000,
      theme: readTerminalTheme(),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    fitTerminal();

    const dataSubscription = terminal.onData((data) => {
      sendClientMessage({ type: "input", data });
    });
    const observer = new ResizeObserver(() => fitTerminal());
    observer.observe(container);

    openConnection();

    return () => {
      disposedRef.current = true;
      connectionIdRef.current += 1;
      clearPingTimer();
      observer.disconnect();
      dataSubscription.dispose();

      const socket = socketRef.current;
      socketRef.current = null;
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
      }

      fitAddon.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [clearPingTimer, fitTerminal, openConnection, sendClientMessage]);

  // Live preference updates: keep the session and socket, only restyle and refit.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || terminal.options.fontSize === preferences.terminalFontSize) return;
    terminal.options.fontSize = preferences.terminalFontSize;
    fitTerminal();
  }, [preferences.terminalFontSize, fitTerminal]);

  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      fitTerminal();
      terminalRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, fitTerminal]);

  const handleClear = () => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.clear();
    terminal.focus();
  };

  const handleRestart = () => {
    const terminal = terminalRef.current;
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      setStatus("connecting");
      setReadyInfo(null);
      setExitInfo(null);
      setErrorText(null);
      exitedRef.current = false;
      terminal?.write(
        agentText(
          "\r\n\x1b[2m[正在重启终端…]\x1b[0m\r\n",
          "\r\n\x1b[2m[Restarting terminal…]\x1b[0m\r\n",
        ),
      );
      sendClientMessage({ type: "restart" });
      terminal?.focus();
      return;
    }
    openConnection();
    terminal?.focus();
  };

  const handleReconnect = () => {
    terminalRef.current?.write(
      agentText(
        "\r\n\x1b[2m[重新连接终端…]\x1b[0m\r\n",
        "\r\n\x1b[2m[Reconnecting terminal…]\x1b[0m\r\n",
      ),
    );
    openConnection();
    terminalRef.current?.focus();
  };

  const terminalActions = [
    { id: "clear", label: t("清屏", "Clear"), description: t("仅清除本地终端显示，不发送命令。", "Clears the local terminal display without sending a command."), onSelect: handleClear },
    { id: "restart", label: t("重启 Shell", "Restart shell"), description: t("结束当前终端 Shell 并启动新 Shell；正在运行的工作可能中断。", "Terminates the current terminal shell and starts a new shell; running work may be interrupted."), onSelect: handleRestart },
    { id: "reconnect", label: t("重新连接", "Reconnect"), description: t("重新建立连接并启动新 Shell，不会恢复旧 Shell。当前 Shell 可能被结束。", "Reconnects with a new shell, not the old shell. The current shell may be terminated."), onSelect: handleReconnect },
  ];

  return (
    <div className="inspector-panel">
      <ContextMenu onOpenChange={(isOpen) => { if (isOpen) menuActionSelected.current = false; }}>
        <ContextMenuTrigger asChild>
      <div className="inspector-toolbar" tabIndex={0} aria-label={t("终端工具", "Terminal tools")}>
        <span
          className="flex shrink-0 items-center gap-1.5 text-xs"
          role="status"
          aria-live="polite"
        >
          <span className={`size-2 rounded-full ${STATUS_DOT_CLASS[status]}`} aria-hidden="true" />
          {statusLabels(t)[status]}
        </span>
        {readyInfo && (
          <span
            className="inspector-muted inspector-mono min-w-0 truncate"
            title={`${readyInfo.shell} · ${readyInfo.cwd}`}
          >
            {readyInfo.shell} · {readyInfo.cwd}
          </span>
        )}
        <span className="inspector-toolbar-spacer" />
        {terminalActions.map((action) => (
          <Button key={action.id} type="button" variant="ghost" size="sm" title={action.description} onClick={action.onSelect}>
            {action.label}
          </Button>
        ))}
      </div>
        </ContextMenuTrigger>
        <ContextMenuContent onCloseAutoFocus={(event) => {
          if (menuActionSelected.current) event.preventDefault();
        }}>
          <ContextMenuLabel className="max-w-72 whitespace-normal px-3 py-1.5 text-xs text-muted-foreground">
            {t("重启或重新连接会启动新 Shell，可能中断当前工作。", "Restarting or reconnecting starts a new shell and may interrupt current work.")}
          </ContextMenuLabel>
          {terminalActions.map((action) => (
            <ContextMenuItem key={action.id} title={action.description} onSelect={() => {
              menuActionSelected.current = true;
              action.onSelect();
            }}>
              {action.label}
            </ContextMenuItem>
          ))}
        </ContextMenuContent>
      </ContextMenu>
      {errorText && (
        <p className="text-xs text-destructive" role="alert">
          {errorText}
        </p>
      )}
      {exitInfo && (
        <p className="text-xs text-muted-foreground" role="status">
          {t(
            `终端进程已退出（退出码 ${exitInfo.exitCode}${
              exitInfo.signal !== undefined ? ` · 信号 ${exitInfo.signal}` : ""
            }）。`,
            `The terminal process exited (code ${exitInfo.exitCode}${
              exitInfo.signal !== undefined ? ` · signal ${exitInfo.signal}` : ""
            }).`,
          )}
        </p>
      )}
      <div ref={containerRef} className="inspector-terminal" data-native-context-menu />
    </div>
  );
}
