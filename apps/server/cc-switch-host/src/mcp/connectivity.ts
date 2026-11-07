/** Translated from vendor/cc-switch/src-tauri/src/services/mcp_connectivity.rs. */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, extname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { homeDir, validateReadPath } from "../host-context.ts";
import type { McpServer } from "../types.ts";

// Package launchers such as npx/uvx may need time to prepare a cold start.
const CHECK_TIMEOUT_MS = 30_000;
const MAX_CONCURRENT_CHECKS = 3;
const MAX_STDIO_MESSAGE_BYTES = 10 * 1024 * 1024;
const CONNECTIVITY_CLIENT = { name: "cc-switch-connectivity", version: "4.0.25" } as const;

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface ConnectivityResult {
  serverId: string;
  connected: boolean;
}

interface ConnectionSpec {
  transport?: string;
  command?: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  url?: string;
  headers: Record<string, string>;
}

interface StdioParameters {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

interface SemaphoreWaiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Shared across batches so rows from several pages still cap at three probes. */
class CheckSemaphore {
  #available: number;
  #waiters: SemaphoreWaiter[] = [];

  constructor(limit: number) {
    this.#available = limit;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new Error("connectivity check cancelled"));
    if (this.#available > 0) {
      this.#available -= 1;
      return Promise.resolve(this.#permit());
    }
    const { promise, resolve, reject } = Promise.withResolvers<() => void>();
    const waiter: SemaphoreWaiter = { resolve, reject, signal };
    waiter.onAbort = () => {
      const index = this.#waiters.indexOf(waiter);
      if (index >= 0) this.#waiters.splice(index, 1);
      reject(new Error("connectivity check cancelled"));
    };
    signal.addEventListener("abort", waiter.onAbort, { once: true });
    this.#waiters.push(waiter);
    return promise;
  }

  #permit(): () => void {
    let used = false;
    return () => {
      if (used) return;
      used = true;
      this.#receive();
    };
  }

  #receive(): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {
      this.#available += 1;
      return;
    }
    const onAbort = waiter.onAbort;
    if (onAbort !== undefined) waiter.signal?.removeEventListener("abort", onAbort);
    waiter.resolve(this.#permit());
  }
}

const PERMITS = new CheckSemaphore(MAX_CONCURRENT_CHECKS);

class CheckBatch {
  readonly id: string;
  readonly controller = new AbortController();
  #cancelled = false;

  constructor(id: string) {
    this.id = id;
  }

  get cancelled(): boolean {
    return this.#cancelled;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  cancel(): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    this.controller.abort();
  }
}

const BATCHES = new Map<string, CheckBatch>();

/**
 * Host transport allocates the batch id before registering its event callback.
 * Results are delivered as each probe completes, never in input order.
 */
export function startChecksWithId(
  servers: McpServer[],
  batchId: string,
  onResult: (result: ConnectivityResult) => boolean,
): string {
  const batch = new CheckBatch(batchId);
  BATCHES.set(batchId, batch);
  void runBatch([...servers], batch, onResult).catch(() => undefined);
  return batchId;
}

export function cancelChecks(batchId: string): void {
  const batch = BATCHES.get(batchId);
  if (batch === undefined) return;
  BATCHES.delete(batchId);
  batch.cancel();
}

async function runBatch(
  servers: McpServer[],
  batch: CheckBatch,
  onResult: (result: ConnectivityResult) => boolean,
): Promise<void> {
  try {
    await Promise.all(servers.map((server) => checkOne(server, batch, onResult)));
  } finally {
    if (BATCHES.get(batch.id) === batch) BATCHES.delete(batch.id);
  }
}

async function checkOne(
  server: McpServer,
  batch: CheckBatch,
  onResult: (result: ConnectivityResult) => boolean,
): Promise<void> {
  if (batch.cancelled) return;
  let release: (() => void) | undefined;
  try {
    release = await PERMITS.acquire(batch.signal);
  } catch {
    return;
  }
  try {
    if (batch.cancelled) return;
    const connected = await checkServer(server.server, batch.signal);
    // A cancelled batch must not surface a late red result.
    if (batch.cancelled) return;
    let keep = true;
    try {
      keep = onResult({ serverId: server.id, connected });
    } catch {
      keep = false;
    }
    if (!keep) batch.cancel();
  } catch {
    // Never surface transport details: URLs, headers and argv can hold credentials.
  } finally {
    release?.();
  }
}

async function checkServer(value: Record<string, unknown>, outer: AbortSignal): Promise<boolean> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), CHECK_TIMEOUT_MS);
  const signal = AbortSignal.any([outer, timeout.signal]);
  const aborted = Promise.withResolvers<never>();
  const onAbort = (): void => aborted.reject(new Error("connectivity check cancelled"));
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    // A transport start (notably legacy SSE) can ignore request signals, so race the deadline.
    await Promise.race([connect(value, signal), aborted.promise]);
    return true;
  } catch {
    return false;
  } finally {
    signal.removeEventListener("abort", onAbort);
    clearTimeout(timer);
  }
}

async function connect(value: Record<string, unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("connectivity check cancelled");
  const spec = parseConnectionSpec(value);
  const transport =
    spec.transport ?? (spec.url !== undefined && spec.command === undefined ? "http" : "stdio");
  switch (transport) {
    case "stdio": {
      const program = spec.command;
      if (program === undefined || program.trim().length === 0) throw new Error("Missing MCP command");
      let cwd = homeDir();
      if (spec.cwd !== undefined && spec.cwd.length > 0) {
        validateReadPath(spec.cwd);
        cwd = spec.cwd;
      }
      const env = minimalEnvironment(spec.env);
      const command = process.platform === "win32" ? resolveWindowsCommand(program, env) : program;
      await handshake(new ProbeStdioTransport({ command, args: spec.args, env, cwd }), signal);
      return;
    }
    case "http": {
      const url = requireUrl(spec.url);
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: spec.headers, redirect: "error" },
        fetch: sameOriginFetch(url, signal),
        // Never retry a failed handshake; the page asked for one red/green answer.
        reconnectionOptions: {
          maxRetries: 0,
          initialReconnectionDelay: 1000,
          maxReconnectionDelay: 1000,
          reconnectionDelayGrowFactor: 1,
        },
      });
      await handshake(transport, signal);
      return;
    }
    case "sse": {
      const url = requireUrl(spec.url);
      const transport = new SSEClientTransport(url, {
        requestInit: { headers: spec.headers, redirect: "error" },
        fetch: sameOriginFetch(url, signal),
      });
      await handshake(transport, signal);
      return;
    }
    default:
      throw new Error("Unsupported MCP transport");
  }
}

function parseConnectionSpec(value: Record<string, unknown>): ConnectionSpec {
  const spec: ConnectionSpec = { args: [], env: {}, headers: {} };
  if (value.type !== undefined) {
    if (typeof value.type !== "string") throw new Error("Invalid MCP transport");
    spec.transport = value.type;
  }
  if (value.command !== undefined) {
    if (typeof value.command !== "string") throw new Error("Invalid MCP command");
    spec.command = value.command;
  }
  if (value.args !== undefined) {
    if (!Array.isArray(value.args)) throw new Error("Invalid MCP arguments");
    spec.args = value.args.map((item) => {
      if (typeof item !== "string") throw new Error("Invalid MCP arguments");
      return item;
    });
  }
  if (value.env !== undefined) spec.env = stringRecord(value.env);
  if (value.cwd !== undefined) {
    if (typeof value.cwd !== "string") throw new Error("Invalid MCP working directory");
    spec.cwd = value.cwd;
  }
  if (value.url !== undefined) {
    if (typeof value.url !== "string") throw new Error("Invalid MCP URL");
    spec.url = value.url;
  }
  if (value.headers !== undefined) spec.headers = stringRecord(value.headers);
  return spec;
}

function stringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid MCP map");
  const record: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw new Error("Invalid MCP map");
    record[key] = item;
  }
  return record;
}

function requireUrl(value: string | undefined): URL {
  if (value === undefined) throw new Error("Missing MCP URL");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported MCP URL");
  return url;
}

/** Only the launch environment the headless host promises: PATH, HOME and the Windows system root. */
function minimalEnvironment(configured: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: homeDir() };
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot;
    if (systemRoot !== undefined) env.SystemRoot = systemRoot;
  }
  return { ...env, ...configured };
}

function resolveWindowsCommand(program: string, env: Record<string, string>): string {
  if (extname(program) !== "") return program;
  const directories = /[\\/]/.test(program)
    ? [""]
    : (env.PATH ?? process.env.PATH ?? "").split(delimiter).filter((directory) => directory.length > 0);
  for (const directory of directories) {
    for (const extension of [".exe", ".cmd", ".bat", ".com"]) {
      const candidate = join(directory, `${program}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return program;
}

/** A legacy SSE message endpoint must not receive configured credentials on another host. */
function sameOriginFetch(base: URL, outer: AbortSignal): FetchLike {
  return async (input, init) => {
    const target = input instanceof URL ? input : new URL(input);
    if (target.protocol !== base.protocol || target.host !== base.host) {
      throw new Error("Cross-origin MCP message endpoint");
    }
    const inherited = init?.signal;
    const signal = inherited === undefined || inherited === null ? outer : AbortSignal.any([outer, inherited]);
    // redirect: "error" refuses every redirect instead of following same-origin hops.
    return fetch(target, { ...init, redirect: "error", signal });
  };
}

async function handshake(transport: Transport, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    await transport.close().catch(() => undefined);
    throw new Error("connectivity check cancelled");
  }
  const client = new Client({ ...CONNECTIVITY_CLIENT }, { capabilities: {} });
  const closeOnAbort = (): void => {
    void client.close().catch(() => undefined);
  };
  signal.addEventListener("abort", closeOnAbort, { once: true });
  try {
    // connect() performs initialize + notifications/initialized only. No tools are called.
    await client.connect(transport, { signal });
  } finally {
    signal.removeEventListener("abort", closeOnAbort);
    // Drop the transport even after a successful handshake: launchers may leave children.
    await client.close().catch(() => undefined);
  }
}

/**
 * The SDK stdio transport spawns an undetached child with an inherited environment.
 * This port keeps the same newline-delimited JSON-RPC framing but owns the spawn so
 * the host can pass a minimal environment and kill the whole process group/job.
 */
class ProbeStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  #parameters: StdioParameters;
  #child: ChildProcess | undefined;
  #buffer = "";
  #started = false;
  #closed = false;
  #closeNotified = false;

  constructor(parameters: StdioParameters) {
    this.#parameters = parameters;
  }

  start(): Promise<void> {
    if (this.#started) return Promise.reject(new Error("MCP stdio transport already started"));
    this.#started = true;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    let spawned = false;
    let child: ChildProcess;
    try {
      child = spawn(this.#parameters.command, this.#parameters.args, {
        cwd: this.#parameters.cwd,
        env: this.#parameters.env,
        stdio: ["pipe", "pipe", "ignore"],
        // A separate process group lets a timeout or cancel kill npx/uvx children too.
        detached: process.platform !== "win32",
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      this.#closed = true;
      reject(error instanceof Error ? error : new Error("MCP transport failure"));
      return promise;
    }
    this.#child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: Buffer | string) => this.#receive(chunk.toString()));
    child.stdin?.on("error", (error: Error) => this.onerror?.(error));
    child.on("error", (error: Error) => {
      this.#closed = true;
      if (!spawned) reject(error);
      else this.onerror?.(error);
      this.#notifyClose();
    });
    child.on("exit", () => {
      this.#closed = true;
      this.#notifyClose();
    });
    child.on("spawn", () => {
      spawned = true;
      resolve();
    });
    return promise;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.#child?.stdin;
    if (this.#closed || stdin === undefined || stdin === null) {
      throw new Error("MCP stdio transport is closed");
    }
    const payload = `${JSON.stringify(message)}\n`;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    try {
      stdin.write(payload, (error?: Error | null) => {
        if (error === undefined || error === null) resolve();
        else reject(error);
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error("MCP transport failure"));
    }
    await promise;
  }

  async close(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    this.#closed = true;
    if (child !== undefined) {
      terminateProcessTree(child);
      child.stdin?.destroy();
      child.stdout?.destroy();
    }
    this.#notifyClose();
  }

  #receive(chunk: string): void {
    if (this.#closed) return;
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_STDIO_MESSAGE_BYTES) {
      this.#fail(new Error("MCP message is too large"));
      return;
    }
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length > 0) {
        try {
          this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
        } catch (error) {
          this.#fail(error instanceof Error ? error : new Error("MCP transport failure"));
          return;
        }
      }
      newline = this.#buffer.indexOf("\n");
    }
  }

  #fail(error: Error): void {
    this.onerror?.(error);
    void this.close();
  }

  #notifyClose(): void {
    if (this.#closeNotified) return;
    this.#closeNotified = true;
    this.onclose?.();
  }
}

/** Always terminate the whole process group/job, even after a successful handshake. */
function terminateProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      });
      killer.on("error", () => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already exited.
        }
      });
      killer.unref();
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }
}
