import pty, { type IPty } from "@lydell/node-pty";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { STATUS_CODES, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { Hono } from "hono";
import { z } from "zod";
import { WebSocket, WebSocketServer } from "ws";
import type { TerminalDescriptor, TerminalServerMessage } from "@agent-workspace/contracts/inspector";
import { resolveAgentWorkspaceExecution } from "../agent-workspaces.ts";
import { resolveChatExecutionScope } from "../task-delivery/binding.ts";
import { getThread, validThreadId } from "../durable/threads.ts";
import { DurableError } from "../durable/errors.ts";
import { authorizeHeaders, sameOrigin } from "../access.ts";
import { InspectorPathError, resolveInsideRoot } from "./paths.ts";
import { nativeEnvironment } from "../native-environment.ts";

const MAX_REPLAY_BYTES = 1024 * 1024;
const MAX_RUNNING = 32;
const MAX_RETAINED = 128;
const MAX_DETACHED_MS = 8 * 60 * 60 * 1000;
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
const AUTH_INTERVAL_MS = 30_000;
const serviceId = randomUUID();
const createSchema = z.strictObject({
  requestId: z.uuid(), expectedServiceId: z.uuid(),
  scope: z.enum(["workspace", "session"]),
  agentWorkspaceId: z.string().min(1).max(128), agentWorkspaceRevision: z.number().int().positive(),
  threadId: z.string().min(1).max(256).optional(), relativePath: z.string().max(4096).default(""),
  cols: z.number().int().min(2).max(500).default(80), rows: z.number().int().min(2).max(200).default(24),
});
type Binding = z.infer<typeof createSchema>;
type DirectoryBinding = Pick<Binding, "scope" | "agentWorkspaceId" | "agentWorkspaceRevision" | "threadId">;
type Attachment = { socket: WebSocket; headers: Headers; clientId: string; pending: number; queue: Promise<void> };
type ManagedTerminal = {
  descriptor: TerminalDescriptor; binding: Binding; signature: string; root: string; startIdentity: string;
  headers: Headers; child: IPty | null; replay: { seq: number; data: string }[]; replayBytes: number;
  clients: Map<string, Attachment>; inputs: Map<string, number>; detachedAt: number; exitedAt?: number; checking: boolean;
  killTimer: NodeJS.Timeout | undefined; processIdentity: string | undefined;
};
const terminals = new Map<string, ManagedTerminal>();
const creations = new Map<string, { fingerprint: string; terminalId: string }>();
const attachedServers = new WeakSet<Server>();
let stopping = false;
let revalidationTimer: NodeJS.Timeout | undefined;
/** Linux start time distinguishes an owned PTY leader from a recycled PID/group. */
function processIdentity(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try { const value = readFileSync(`/proc/${pid}/stat`, "utf8"); return value.slice(value.lastIndexOf(")") + 2).split(/\s+/)[19]; }
  catch { return undefined; }
}

function send(socket: WebSocket, message: TerminalServerMessage): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > MAX_REPLAY_BYTES) { socket.close(1013, "Reconnect for bounded replay"); return; }
  socket.send(JSON.stringify(message));
}
function requireAccess(headers: Headers): void {
  if (!sameOrigin(headers)) throw new DurableError(403, "cross_origin", "Cross-origin terminal access is forbidden.");
  if (!authorizeHeaders(headers)) throw new DurableError(401, "access_required", "Agent access is required.");
}
async function resolveBinding(binding: DirectoryBinding, headers: Headers) {
  requireAccess(headers);
  let snapshot;
  if (binding.scope === "session") {
    if (!validThreadId(binding.threadId))
      throw new DurableError(400, "invalid_terminal_binding", "Session terminals require an explicit Session.");
    const thread = getThread(binding.threadId);
    if (!thread || thread.executionSelection?.agentWorkspaceId !== binding.agentWorkspaceId ||
        thread.executionSelection.agentWorkspaceRevision !== binding.agentWorkspaceRevision)
      throw new DurableError(409, "terminal_binding_changed", "Session is missing or no longer matches the terminal workspace revision.");
    snapshot = await resolveChatExecutionScope(thread, headers, "inspect");
  } else {
    if (binding.threadId !== undefined)
      throw new DurableError(400, "invalid_terminal_binding", "Workspace terminals cannot bind a Session.");
    snapshot = await resolveAgentWorkspaceExecution({
      version: 2, agentWorkspaceId: binding.agentWorkspaceId, agentWorkspaceRevision: binding.agentWorkspaceRevision,
    });
  }
  const environment = snapshot.environment;
  if (environment.agentWorkspaceId !== binding.agentWorkspaceId ||
      environment.agentWorkspaceRevision !== binding.agentWorkspaceRevision || !environment.executionPath)
    throw new DurableError(409, "terminal_binding_changed", "Terminal execution directory does not match its workspace binding.");
  const root = environment.executionPath;
  try {
    const canonical = await realpath(root);
    const info = await stat(root, { bigint: true });
    if (canonical !== root || !info.isDirectory()) throw new Error("Changed execution directory");
    return { root, environment, signature: JSON.stringify([
      environment.agentWorkspaceId, environment.agentWorkspaceRevision, environment.sourcePath,
      root, environment.worktree, `${info.dev}:${info.ino}`,
    ]) };
  } catch {
    throw new DurableError(412, "execution_unavailable", "Terminal execution directory is missing or replaced.");
  }
}
async function authorize(terminal: ManagedTerminal, headers: Headers): Promise<void> {
  const current = await resolveBinding(terminal.binding, headers);
  if (current.signature !== terminal.signature || current.root !== terminal.root)
    throw new DurableError(409, "terminal_binding_changed", "Terminal environment changed; it cannot be rebound or restored.");
  const cwd = await resolveInsideRoot(terminal.binding.relativePath, current.root);
  const info = await stat(cwd.absolute, { bigint: true });
  if (cwd.absolute !== terminal.descriptor.startCwd || !info.isDirectory() || `${info.dev}:${info.ino}` !== terminal.startIdentity)
    throw new DurableError(409, "terminal_binding_changed", "Terminal start directory is no longer available.");
}
function finish(terminal: ManagedTerminal, exitCode: number, signal?: number): void {
  clearTimeout(terminal.killTimer); terminal.killTimer = undefined;
  if (terminal.descriptor.status === "exited") return;
  terminal.child = null;
  terminal.descriptor.status = "exited";
  terminal.descriptor.exitCode = exitCode;
  terminal.descriptor.signal = signal ?? null;
  terminal.exitedAt = Date.now();
  for (const { socket } of terminal.clients.values()) send(socket, { type: "exit", exitCode, ...(signal === undefined ? {} : { signal }) });
}
function terminate(terminal: ManagedTerminal): void {
  const child = terminal.child;
  if (!child) return;
  if (terminal.killTimer) return;
  if (terminal.processIdentity && processIdentity(child.pid) !== terminal.processIdentity) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { finish(terminal, -1); } }
  terminal.killTimer = setTimeout(() => {
    terminal.killTimer = undefined;
    if (terminal.child !== child || terminal.descriptor.status !== "running" || terminal.processIdentity && processIdentity(child.pid) !== terminal.processIdentity) return;
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { finish(terminal, -1); } }
  }, 3000);
  terminal.killTimer.unref();
}
function rejectBinding(terminal: ManagedTerminal, error: unknown): void {
  for (const { socket } of terminal.clients.values()) {
    send(socket, { type: "error", code: error instanceof DurableError ? error.code : "terminal_authorization_failed", message: "Terminal authorization or directory identity expired; process is being terminated." });
    socket.close(1008, "Terminal authorization expired");
  }
  terminate(terminal);
}
function ensureLifecycle(): void {
  if (revalidationTimer) return;
  revalidationTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, terminal] of terminals) {
      if (terminal.descriptor.status === "exited") {
        if (now - (terminal.exitedAt ?? now) > MAX_LIFETIME_MS || terminals.size > MAX_RETAINED) terminals.delete(id);
        continue;
      }
      if (now - Date.parse(terminal.descriptor.createdAt) > MAX_LIFETIME_MS || !terminal.clients.size && now - terminal.detachedAt > MAX_DETACHED_MS) {
        rejectBinding(terminal, new Error("Terminal lifetime exceeded")); continue;
      }
      if (terminal.checking) continue;
      terminal.checking = true;
      void authorize(terminal, terminal.headers).catch(error => rejectBinding(terminal, error)).finally(() => { terminal.checking = false; });
    }
  }, AUTH_INTERVAL_MS);
  revalidationTimer.unref();
}
function requireTerminal(id: string): ManagedTerminal {
  const terminal = terminals.get(id);
  if (!terminal) throw new DurableError(404, "terminal_unavailable", "Terminal is unavailable in this service lifetime; commands were not restored or rerun.");
  return terminal;
}
export const terminalRoutes = new Hono();
terminalRoutes.onError((error, c) => {
  if (error instanceof DurableError) return c.json({ error: error.message, code: error.code }, error.status);
  if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof InspectorPathError) return c.json({ error: error.message, code: "invalid_terminal_request" }, 400);
  return c.json({ error: "Terminal operation failed; no automatic retry was performed.", code: "terminal_failed" }, 503);
});
terminalRoutes.post("/terminals", async c => {
  const binding = createSchema.parse(await c.req.json());
  if (stopping) throw new DurableError(503, "terminal_unavailable", "Service is stopping.");
  if (binding.expectedServiceId !== serviceId) throw new DurableError(409, "terminal_service_changed", "Service lifetime changed; the original process is unavailable and creation was not replayed.");
  const current = await resolveBinding(binding, c.req.raw.headers);
  const creationKey = binding.requestId;
  const fingerprint = createHash("sha256").update(JSON.stringify(binding)).digest("hex");
  const prior = creations.get(creationKey);
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new DurableError(409, "terminal_request_conflict", "Creation requestId already belongs to different terminal parameters.");
    const terminal = requireTerminal(prior.terminalId); await authorize(terminal, c.req.raw.headers);
    return c.json({ terminal: terminal.descriptor });
  }
  const cwd = await resolveInsideRoot(binding.relativePath, current.root);
  const startInfo = await stat(cwd.absolute, { bigint: true });
  if (!startInfo.isDirectory()) throw new DurableError(400, "invalid_terminal_directory", "Terminal cwd must be an existing directory.");
  const raced = creations.get(creationKey);
  if (raced) {
    if (raced.fingerprint !== fingerprint) throw new DurableError(409, "terminal_request_conflict", "Creation requestId already belongs to different parameters.");
    const terminal = requireTerminal(raced.terminalId); await authorize(terminal, c.req.raw.headers);
    return c.json({ terminal: terminal.descriptor });
  }
  if (creations.size >= 4096) throw new DurableError(429, "terminal_creation_limit", "Service-lifetime creation ledger is full; no dedup identity was evicted or process started.");
  if (stopping || [...terminals.values()].filter(value => value.descriptor.status === "running").length >= MAX_RUNNING)
    throw new DurableError(429, "terminal_limit", "Terminal capacity changed during authorization.");
  const terminal: ManagedTerminal = { descriptor: { id: randomUUID(), requestId: binding.requestId, serviceId, scope: binding.scope,
    agentWorkspaceId: binding.agentWorkspaceId, agentWorkspaceRevision: binding.agentWorkspaceRevision,
    threadId: binding.scope === "session" ? binding.threadId! : null, startCwd: cwd.absolute, status: "running", createdAt: new Date().toISOString(), lastSeq: 0, exitCode: null, signal: null },
    binding, signature: current.signature, root: current.root, startIdentity: `${startInfo.dev}:${startInfo.ino}`, headers: new Headers(c.req.raw.headers), child: null, replay: [], replayBytes: 0, clients: new Map(), inputs: new Map(), detachedAt: Date.now(), checking: false, killTimer: undefined, processIdentity: undefined };
  const shell = process.env.AGENT_WORKSPACE_TERMINAL_SHELL || process.env.SHELL || "/bin/bash";
  creations.set(creationKey, { fingerprint, terminalId: terminal.descriptor.id });
  terminals.set(terminal.descriptor.id, terminal);
  try {
    terminal.child = pty.spawn(shell, ["-l"], { name: "xterm-256color", cols: binding.cols, rows: binding.rows, cwd: cwd.absolute,
      env: { ...nativeEnvironment(), TERM: "xterm-256color", COLORTERM: "truecolor" } });
    terminal.processIdentity = processIdentity(terminal.child.pid);
  } catch (error) { finish(terminal, -1); throw error; }
  terminal.child.onData(data => {
    const frame = { seq: ++terminal.descriptor.lastSeq, data };
    terminal.replay.push(frame); terminal.replayBytes += Buffer.byteLength(data);
    while (terminal.replayBytes > MAX_REPLAY_BYTES && terminal.replay.length) terminal.replayBytes -= Buffer.byteLength(terminal.replay.shift()!.data);
    for (const { socket } of terminal.clients.values()) send(socket, { type: "output", ...frame });
  });
  terminal.child.onExit(({ exitCode, signal }) => finish(terminal, exitCode, signal));
  ensureLifecycle();
  return c.json({ terminal: terminal.descriptor });
});
terminalRoutes.get("/terminals", async c => {
  const query = new URL(c.req.url).searchParams;
  for (const key of query.keys()) if (query.getAll(key).length > 1)
    throw new DurableError(400, "invalid_terminal_request", "Terminal query parameters cannot repeat.");
  const input = z.strictObject({
    agentWorkspaceId: z.string().min(1).max(128), agentWorkspaceRevision: z.coerce.number().int().positive(),
    threadId: z.string().min(1).max(256).optional(), requestId: z.uuid().optional(),
  }).parse(Object.fromEntries(query));
  await resolveBinding({ ...input, scope: input.threadId ? "session" : "workspace" }, c.req.raw.headers);
  if (input.requestId) {
    const accepted = creations.get(input.requestId);
    if (accepted) requireTerminal(accepted.terminalId);
  }
  const visible: TerminalDescriptor[] = [];
  for (const terminal of terminals.values()) {
    if (terminal.descriptor.agentWorkspaceId !== input.agentWorkspaceId ||
        input.threadId && terminal.descriptor.scope === "session" && terminal.descriptor.threadId !== input.threadId ||
        input.requestId && terminal.descriptor.requestId !== input.requestId) continue;
    await authorize(terminal, c.req.raw.headers); terminal.headers = new Headers(c.req.raw.headers); visible.push(terminal.descriptor);
  }
  return c.json({ serviceId, terminals: visible });
});
terminalRoutes.get("/terminals/:id", async c => {
  const terminal = requireTerminal(c.req.param("id"));
  await authorize(terminal, c.req.raw.headers); terminal.headers = new Headers(c.req.raw.headers);
  return c.json({ terminal: terminal.descriptor });
});
terminalRoutes.delete("/terminals/:id", async c => {
  const terminal = requireTerminal(c.req.param("id"));
  await authorize(terminal, c.req.raw.headers); terminate(terminal);
  return c.json({ terminal: terminal.descriptor });
});
function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(key, value); else if (Array.isArray(value)) headers.set(key, value.join(", "));
  return headers;
}
async function handleMessage(terminal: ManagedTerminal, attachment: Attachment, raw: WebSocket.RawData, binary: boolean): Promise<void> {
  if (terminal.clients.get(attachment.clientId) !== attachment) return;
  if (binary) throw new DurableError(400, "invalid_terminal_message", "Terminal accepts JSON text only.");
  const message = z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("input"), seq: z.number().int().positive(), data: z.string().max(65536) }),
    z.strictObject({ type: z.literal("resize"), cols: z.number().int().min(2).max(500), rows: z.number().int().min(2).max(200) }),
    z.strictObject({ type: z.literal("ping") }),
  ]).parse(JSON.parse(raw.toString()));
  await authorize(terminal, attachment.headers);
  if (terminal.clients.get(attachment.clientId) !== attachment) return;
  terminal.headers = attachment.headers;
  if (message.type === "ping") { send(attachment.socket, { type: "pong" }); return; }
  if (!terminal.child) throw new DurableError(409, "terminal_ended", "Terminal process has ended; it was not rerun.");
  if (message.type === "resize") { terminal.child.resize(message.cols, message.rows); return; }
  const previous = terminal.inputs.get(attachment.clientId) ?? 0;
  if (message.seq <= previous) { send(attachment.socket, { type: "ack", seq: previous }); return; }
  if (message.seq !== previous + 1 || Buffer.byteLength(message.data) > 65536) throw new DurableError(409, "terminal_input_sequence", "Input sequence gap; do not silently replay or duplicate commands.");
  terminal.child.write(message.data);
  terminal.inputs.set(attachment.clientId, message.seq);
  send(attachment.socket, { type: "ack", seq: message.seq });
}
/** Socket lifetime is only attachment lifetime; reconnect never spawns or reruns a process. */
export function attachTerminalUpgrade(server: Server): void {
  if (attachedServers.has(server)) return;
  attachedServers.add(server);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try { url = new URL(request.url ?? "/", "http://localhost"); } catch { socket.destroy(); return; }
    if (url.pathname !== "/api/inspector/terminal") { if (server.listenerCount("upgrade") <= 1) socket.destroy(); return; }
    const headers = requestHeaders(request);
    if (!sameOrigin(headers) || !authorizeHeaders(headers)) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return; }
    const attach = async () => {
      const input = z.strictObject({ terminalId: z.string().min(1), afterSeq: z.coerce.number().int().nonnegative().default(0), clientId: z.string().min(1).max(128) }).parse(Object.fromEntries(url.searchParams));
      const terminal = requireTerminal(input.terminalId);
      await authorize(terminal, headers);
      if (input.afterSeq > terminal.descriptor.lastSeq) throw new DurableError(409, "terminal_sequence", "Replay cursor belongs to another terminal lifetime.");
      if (!terminal.inputs.has(input.clientId) && terminal.inputs.size >= 32) throw new DurableError(429, "terminal_client_limit", "Terminal attachment identity capacity reached.");
      if (socket.destroyed || !socket.writable || socket.readableEnded) return;
      wss.handleUpgrade(request, socket, head, client => {
        const previous = terminal.clients.get(input.clientId);
        previous?.socket.close(1000, "Attachment replaced");
        const attachment: Attachment = { socket: client, headers, clientId: input.clientId, pending: 0, queue: Promise.resolve() };
        terminal.clients.set(input.clientId, attachment); terminal.inputs.set(input.clientId, terminal.inputs.get(input.clientId) ?? 0); terminal.headers = headers;
        const first = terminal.replay[0]?.seq ?? terminal.descriptor.lastSeq + 1;
        send(client, { type: "ready", terminal: terminal.descriptor, acceptedInputSeq: terminal.inputs.get(input.clientId)!, replayFrom: Math.max(first, input.afterSeq + 1), truncated: input.afterSeq + 1 < first });
        for (const frame of terminal.replay) if (frame.seq > input.afterSeq) send(client, { type: "output", ...frame });
        if (terminal.descriptor.status === "exited") send(client, { type: "exit", exitCode: terminal.descriptor.exitCode ?? -1, ...(terminal.descriptor.signal === null ? {} : { signal: terminal.descriptor.signal }) });
        client.on("message", (raw, binary) => {
          if (++attachment.pending > 64) { client.close(1008, "Too many pending inputs"); return; }
          attachment.queue = attachment.queue.then(() => handleMessage(terminal, attachment, raw, binary)).catch(error => {
            send(client, { type: "error", code: error instanceof DurableError ? error.code : "invalid_terminal_message", message: error instanceof Error ? error.message : "Terminal message failed" });
            if (error instanceof DurableError && [401, 403, 404, 409, 412, 503].includes(error.status)) rejectBinding(terminal, error);
          }).finally(() => { attachment.pending--; });
        });
        const detach = () => {
          if (terminal.clients.get(input.clientId) === attachment) terminal.clients.delete(input.clientId);
          if (!terminal.clients.size) terminal.detachedAt = Date.now();
        };
        client.on("close", detach); client.on("error", detach);
      });
    };
    void attach().catch((error: unknown) => {
      if (socket.destroyed) return;
      const status = error instanceof DurableError ? error.status : error instanceof z.ZodError ? 400 : 503;
      const body = JSON.stringify({ error: error instanceof DurableError ? error.message : "Invalid or unavailable terminal attachment.", code: error instanceof DurableError ? error.code : "terminal_unavailable" });
      socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Error"}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    });
  });
}
export function terminateSessionTerminals(threadId: string): void {
  for (const terminal of terminals.values()) if (terminal.descriptor.threadId === threadId) terminate(terminal);
}
export async function stopTerminals(): Promise<void> {
  stopping = true;
  clearInterval(revalidationTimer);
  revalidationTimer = undefined;
  const children = [...terminals.values()].flatMap(terminal => terminal.child ? [terminal.child] : []);
  for (const terminal of terminals.values()) {
    for (const { socket } of terminal.clients.values()) socket.close(1001, "Service stopped; process will not be restored");
    terminate(terminal);
  }
  if (children.length) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 3100);
    await promise;
  }
  for (const terminal of terminals.values()) {
    const child = terminal.child;
    if (child && terminal.descriptor.status === "running" && (!terminal.processIdentity || processIdentity(child.pid) === terminal.processIdentity)) try { child.kill("SIGKILL"); } catch { /* Already exited. */ }
    clearTimeout(terminal.killTimer);
  }
  terminals.clear();
  creations.clear();
}
