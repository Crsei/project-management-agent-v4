import pty, { type IPty } from "@lydell/node-pty";
import { STATUS_CODES, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { TerminalServerMessage } from "@agent-workspace/contracts/inspector";
import { resolveInspectorRoot } from "./scope.ts";
import { DurableError } from "../durable/errors.ts";
import { authorizeHeaders, sameOrigin } from "../access.ts";

const TERMINAL_PATH = "/api/terminal";
const MAX_PAYLOAD = 1024 * 1024;
const MAX_BUFFERED = 1024 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MIN_COLS = 2;
const MAX_COLS = 500;
const MIN_ROWS = 2;
const MAX_ROWS = 200;
const KILL_GRACE_MS = 3000;
const DRAIN_POLL_MS = 25;

type Disposable = { dispose(): void };

/** One attach per http server; re-attaching would duplicate upgrade handlers. */
const attachedServers = new WeakSet<Server>();

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }
  return headers;
}

/** Kill a pty with SIGTERM and escalate to SIGKILL if it survives the grace period. */
function killProcess(child: IPty): void {
  try {
    child.kill("SIGTERM");
  } catch {
    // Already exited.
  }
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }, KILL_GRACE_MS);
  timer.unref();
}

class TerminalSession {
  private readonly socket: WebSocket;
  private readonly cwd: string;
  private process: IPty | null = null;
  private dataSubscription: Disposable | null = null;
  private exitSubscription: Disposable | null = null;
  private paused = false;
  private drainTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(socket: WebSocket, cwd: string) {
    this.cwd = cwd;
    this.socket = socket;
    this.spawn();
  }

  private send(message: TerminalServerMessage): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
    this.pauseIfBackedUp();
  }

  private spawn(): void {
    const shell = process.env.AGENT_WORKSPACE_TERMINAL_SHELL || process.env.SHELL || "/bin/bash";
    const cwd = this.cwd;
    let child: IPty;
    try {
      child = pty.spawn(shell, ["-l"], {
        name: "xterm-256color",
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        cwd,
        env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
      });
    } catch (error) {
      this.send({
        type: "error",
        message: `无法启动终端：${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }

    this.process = child;
    this.dataSubscription = child.onData((data) => {
      if (this.closed || this.socket.readyState !== WebSocket.OPEN) return;
      this.socket.send(JSON.stringify({ type: "output", data } satisfies TerminalServerMessage));
      this.pauseIfBackedUp();
    });
    this.exitSubscription = child.onExit(({ exitCode, signal }) => {
      this.releaseProcess();
      this.process = null;
      this.send({ type: "exit", exitCode, signal });
      this.closed = true;
      try {
        this.socket.close();
      } catch {
        // Socket already gone.
      }
    });

    this.send({ type: "ready", cwd, shell });
  }

  /** Drop listeners and terminate the current pty without messaging the client. */
  private stopProcess(): void {
    this.releaseProcess();
    const child = this.process;
    this.process = null;
    if (child) killProcess(child);
  }

  private releaseProcess(): void {
    this.dataSubscription?.dispose();
    this.exitSubscription?.dispose();
    this.dataSubscription = null;
    this.exitSubscription = null;
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    this.paused = false;
  }

  private pauseIfBackedUp(): void {
    const child = this.process;
    if (!child || this.paused) return;
    if (this.socket.bufferedAmount <= MAX_BUFFERED) return;
    if (typeof child.pause !== "function") return;
    child.pause();
    this.paused = true;
    this.scheduleDrainCheck();
  }

  private scheduleDrainCheck(): void {
    if (this.closed || this.drainTimer) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      const child = this.process;
      if (this.closed || !child || !this.paused) return;
      if (this.socket.bufferedAmount > MAX_BUFFERED) {
        this.scheduleDrainCheck();
        return;
      }
      this.paused = false;
      if (typeof child.resume === "function") child.resume();
    }, DRAIN_POLL_MS);
    this.drainTimer.unref();
  }

  handleMessage(raw: WebSocket.RawData, isBinary: boolean): void {
    if (this.closed) return;
    if (isBinary) {
      this.send({ type: "error", message: "终端只接受 JSON 文本消息。" });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      this.send({ type: "error", message: "无法解析终端消息。" });
      return;
    }

    if (typeof parsed !== "object" || parsed === null) {
      this.send({ type: "error", message: "终端消息格式无效。" });
      return;
    }

    const message = parsed as {
      type?: unknown;
      data?: unknown;
      cols?: unknown;
      rows?: unknown;
    };
    switch (message.type) {
      case "input": {
        const data = message.data;
        if (typeof data !== "string") {
          this.send({ type: "error", message: "input 消息缺少字符串 data。" });
          return;
        }
        if (Buffer.byteLength(data, "utf8") > MAX_INPUT_BYTES) {
          this.send({ type: "error", message: "输入内容超过 64 KiB 上限。" });
          return;
        }
        this.process?.write(data);
        return;
      }
      case "resize": {
        const cols = message.cols;
        const rows = message.rows;
        if (
          typeof cols !== "number" ||
          typeof rows !== "number" ||
          !Number.isInteger(cols) ||
          !Number.isInteger(rows) ||
          cols < MIN_COLS ||
          cols > MAX_COLS ||
          rows < MIN_ROWS ||
          rows > MAX_ROWS
        ) {
          this.send({ type: "error", message: "终端尺寸无效。" });
          return;
        }
        try {
          this.process?.resize(cols, rows);
        } catch {
          this.send({ type: "error", message: "无法调整终端尺寸。" });
        }
        return;
      }
      case "restart":
        this.stopProcess();
        this.spawn();
        return;
      case "ping":
        this.send({ type: "pong" });
        return;
      default:
        this.send({ type: "error", message: "未知的终端消息类型。" });
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopProcess();
  }
}

/**
 * Handle WebSocket upgrades on `server` for `/api/terminal`. Each connection owns
 * one login-shell PTY rooted at the connection's resolved PM directory snapshot.
 * Returns immediately for other pathnames so other upgrade listeners (Vite HMR) keep working; when nobody
 * else is listening the socket is closed instead of left hanging.
 */
export function attachTerminalUpgrade(server: Server): void {
  if (attachedServers.has(server)) return;
  attachedServers.add(server);

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      socket.destroy();
      return;
    }

    if (url.pathname !== TERMINAL_PATH) {
      if (server.listenerCount("upgrade") <= 1) socket.destroy();
      return;
    }

    const headers = requestHeaders(request);
    if (!sameOrigin(headers) || !authorizeHeaders(headers)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }

    // The peer may disappear while PM authentication is in flight. Never create
    // a shell for a closed connection, including a TCP half-close.
    let disconnected = false;
    const onDisconnect = () => {
      disconnected = true;
      socket.destroy();
    };
    socket.once("end", onDisconnect);
    socket.once("close", onDisconnect);
    socket.once("error", onDisconnect);
    // Consume the stream so a FIN is observed even before the upgrade finishes.
    // WebSocket clients must wait for the handshake before sending frames.
    socket.resume();
    void resolveInspectorRoot(url, headers).then((cwd) => {
      if (disconnected || socket.destroyed || !socket.writable || socket.readableEnded) return;
      wss.handleUpgrade(request, socket, head, (client) => {
        const session = new TerminalSession(client, cwd);
        client.on("message", (data, isBinary) => session.handleMessage(data, isBinary));
        client.on("close", () => session.dispose());
        client.on("error", () => session.dispose());
      });
    }).catch((error: unknown) => {
      if (disconnected || socket.destroyed) return;
      const status = error instanceof DurableError ? error.status : 500;
      const body = JSON.stringify({
        error: error instanceof DurableError ? error.message : "无法解析终端文件区域。",
        code: error instanceof DurableError ? error.code : "internal_error",
      });
      socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    });
  });
}
