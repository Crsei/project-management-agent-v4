// Protocol/lifecycle port: t3code packages/provider-opencode/src/server/{OpenCodeRuntime,versionProbe,v2/OpenCode2Server,v2/OpenCode2Client}.ts (MIT).
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ReadableStreamReadResult } from "node:stream/web";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import { runProviderCommand } from "../process.ts";

export type OpenCodeGeneration = "v1" | "v2";
type OpenCodeRequestOptions = {
  method?: string; body?: unknown; signal?: AbortSignal; stream?: boolean;
  timeoutMs?: number; location?: boolean; allowProbeMiss?: boolean;
};
export class OpenCodeError extends Error {
  readonly errorClass?: "usage_limit" | "authentication";
  readonly statusCode?: number;
  readonly code?: string;
  constructor(message: string, statusCode?: number, code?: string) {
    super(message); this.statusCode = statusCode; this.code = code;
    this.name = code === "aborted" ? "AbortError" : "OpenCodeError";
    if ((code === "provider.quota" && statusCode !== 402) || code === "provider.rate-limit") this.errorClass = "usage_limit";
    if (code === "ProviderAuthError" || code === "provider.auth") this.errorClass = "authentication";
  }
}
export function aborted(): OpenCodeError { return new OpenCodeError("OpenCode operation cancelled.", undefined, "aborted"); }
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function array(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(object) : []; }
export function string(value: unknown): string { return typeof value === "string" ? value : ""; }
export function data(value: unknown): unknown { return object(value).data ?? value; }
function generation(version: string): OpenCodeGeneration {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) throw new OpenCodeError("The server returned an invalid OpenCode version.");
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major === 0 || (major === 1 && (minor! < 14 || (minor === 14 && patch! < 19)))) {
    throw new OpenCodeError("OpenCode 1.14.19 or newer is required.");
  }
  return major! >= 2 ? "v2" : "v1";
}
export function openCodeEnvironment(context: ProviderDriverContext): NodeJS.ProcessEnv {
  return {
    ...context.env,
    HOME: context.homeDirectory,
    USERPROFILE: context.homeDirectory,
    XDG_CONFIG_HOME: path.join(context.homeDirectory, ".config"),
    XDG_DATA_HOME: path.join(context.homeDirectory, ".local", "share"),
    XDG_CACHE_HOME: path.join(context.homeDirectory, ".cache"),
    XDG_STATE_HOME: path.join(context.homeDirectory, ".local", "state"),
    OPENCODE_CONFIG_CONTENT: context.env.OPENCODE_CONFIG_CONTENT ?? "{}",
  };
}

export class OpenCodeConnection {
  readonly baseUrl: string;
  readonly password: string;
  readonly cwd: string;
  generation: OpenCodeGeneration;
  version: string;
  constructor(baseUrl: string, password: string, cwd: string, generation: OpenCodeGeneration = "v1", version = "") {
    this.baseUrl = baseUrl; this.password = password; this.cwd = cwd;
    this.generation = generation; this.version = version;
  }
  url(endpoint: string, location = true): URL {
    const url = new URL(this.baseUrl);
    url.pathname = url.pathname.replace(/\/+$/, "") + endpoint;
    if (location) url.searchParams.set(this.generation === "v2" ? "location[directory]" : "directory", this.cwd);
    return url;
  }
  async response(endpoint: string, options: OpenCodeRequestOptions = {}): Promise<Response> {
    if (options.signal?.aborted) throw aborted();
    const headersController = new AbortController();
    const headersTimer = options.stream ? setTimeout(() => headersController.abort(), options.timeoutMs ?? 15_000) : undefined;
    const timeout = options.stream ? headersController.signal : AbortSignal.timeout(options.timeoutMs ?? 15_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const headers: Record<string, string> = { accept: options.stream ? "text/event-stream" : "application/json" };
    if (this.password) headers.authorization = `Basic ${Buffer.from(`opencode:${this.password}`, "utf8").toString("base64")}`;
    if (this.generation === "v1") headers["x-opencode-directory"] = encodeURIComponent(this.cwd);
    if (options.body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await fetch(this.url(endpoint, options.location ?? true), {
        method: options.method ?? "GET", headers, signal, redirect: "error",
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch {
      if (options.signal?.aborted) throw aborted();
      throw new OpenCodeError(timeout.aborted ? "Timed out waiting for the OpenCode server." : "Could not reach the OpenCode server.");
    } finally { clearTimeout(headersTimer); }
    if (!response.ok && !(options.allowProbeMiss && ![401, 403].includes(response.status))) {
      await response.body?.cancel();
      throw new OpenCodeError([401, 403].includes(response.status)
        ? "OpenCode rejected authentication. Check the server password or provider login."
        : `OpenCode returned HTTP ${response.status}.`, response.status);
    }
    if (options.stream && !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
      await response.body?.cancel();
      throw new OpenCodeError("OpenCode did not accept the event subscription.");
    }
    return response;
  }
  async request(endpoint: string, options: OpenCodeRequestOptions = {}): Promise<unknown> {
    const response = await this.response(endpoint, options);
    if (response.status === 204) return undefined;
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      await response.body?.cancel();
      throw new OpenCodeError("The server did not return an OpenCode JSON response.");
    }
    try { return await response.json(); }
    catch {
      if (options.signal?.aborted) throw aborted();
      throw new OpenCodeError("The server returned an unreadable OpenCode response.");
    }
  }
  async probe(signal?: AbortSignal): Promise<void> {
    // Both generations return a 200 HTML SPA on each other's endpoint: JSON identity is required.
    for (const endpoint of ["/api/info", "/global/health"]) {
      const response = await this.response(endpoint, { signal, timeoutMs: 5_000, location: false, allowProbeMiss: true });
      if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
        await response.body?.cancel();
        continue;
      }
      let info: Record<string, unknown>;
      try { info = object(await response.json()); } catch { continue; }
      if ((endpoint === "/api/info" ? Number.isInteger(info.pid) : info.healthy === true) && typeof info.version === "string") {
        const selected = generation(info.version);
        if ((endpoint === "/api/info") !== (selected === "v2")) continue;
        this.generation = selected;
        this.version = info.version;
        return;
      }
    }
    throw new OpenCodeError("The server did not identify itself as a supported OpenCode server.");
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  const closing = Promise.withResolvers<void>();
  server.close((error) => error ? closing.reject(error) : closing.resolve());
  await closing.promise;
  if (!address || typeof address === "string") throw new OpenCodeError("Could not allocate an OpenCode server port.");
  return address.port;
}
function killOwned(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch { /* The owned process group may already have exited. */ }
}

export async function withOpenCode<T>(context: ProviderDriverContext, use: (connection: OpenCodeConnection) => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw aborted();
  const serverUrl = string(context.config.serverUrl).trim();
  const configuredPassword = string(context.config.serverPassword).trim();
  if (serverUrl) {
    const connection = new OpenCodeConnection(serverUrl, configuredPassword, context.cwd);
    await connection.probe(signal);
    return use(connection); // External servers are never disposed, reconfigured or terminated.
  }
  const env = openCodeEnvironment(context);
  await Promise.all([env.HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME]
    .map((directory) => mkdir(directory!, { recursive: true, mode: 0o700 })));
  const binary = string(context.config.binaryPath).trim() || "opencode";
  const versionResult = await runProviderCommand(binary, ["--version"], { cwd: context.cwd, env, signal, timeoutMs: 10_000, maxOutput: 4096 });
  if (signal?.aborted) throw aborted();
  if (!versionResult.installed) throw new OpenCodeError("OpenCode CLI is not installed or not on PATH.", undefined, "not-installed");
  if (versionResult.code !== 0) throw new OpenCodeError("The OpenCode CLI version probe failed.");
  const version = /\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/.exec(versionResult.stdout)?.[1];
  if (!version) throw new OpenCodeError("Could not determine the OpenCode CLI version.");
  const selected = generation(version);
  const password = configuredPassword || randomBytes(32).toString("base64url");
  delete env.OPENCODE_SERVER_PASSWORD;
  delete env.OPENCODE_PASSWORD;
  env[selected === "v2" ? "OPENCODE_PASSWORD" : "OPENCODE_SERVER_PASSWORD"] = password;
  const port = await availablePort();
  if (signal?.aborted) throw aborted();
  const child = spawn(binary, ["serve", "--hostname=127.0.0.1", `--port=${port}`], {
    cwd: context.cwd, env, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  let exited = false;
  const closeGate = Promise.withResolvers<void>();
  child.once("close", () => { exited = true; closeGate.resolve(); });
  const closed = closeGate.promise;
  child.stderr?.resume();
  const exitHook = () => killOwned(child, "SIGKILL");
  process.once("exit", exitHook);
  try {
    const startup = Promise.withResolvers<void>();
    let output = "";
    const finish = (failure?: Error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        child.stdout?.removeListener("data", stdout);
        child.removeListener("error", error);
        child.removeListener("close", close);
        if (failure) startup.reject(failure); else startup.resolve();
      };
      const cancel = () => finish(aborted());
      const close = () => finish(new OpenCodeError("OpenCode server exited before startup completed."));
      const error = () => finish(new OpenCodeError("Failed to spawn the OpenCode server."));
      const stdout = (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(-65536);
        const announced = /server listening on\s+(https?:\/\/[^\s]+)/i.exec(output)?.[1];
        if (!announced) return;
        // Do not probe a pre-existing listener if our process failed to bind its allocated port.
        if (announced.replace(/\/$/, "") !== `http://127.0.0.1:${port}`) {
          finish(new OpenCodeError("OpenCode announced an unexpected server address."));
        } else finish();
      };
      const timer = setTimeout(() => finish(new OpenCodeError("Timed out waiting for the OpenCode server to start.")), 30_000);
      child.stdout?.on("data", stdout);
      child.once("error", error);
      child.once("close", close);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    await startup.promise;
    // Drain both pipes; never surface native startup output (2.x prints its password).
    child.stdout?.resume();
    child.stderr?.resume();
    const connection = new OpenCodeConnection(`http://127.0.0.1:${port}`, password, context.cwd, selected, version);
    await connection.probe(signal);
    return await use(connection);
  } finally {
    killOwned(child, "SIGTERM");
    await Promise.race([closed, delay(1000)]);
    if (!exited) { killOwned(child, "SIGKILL"); await Promise.race([closed, delay(1000)]); }
    process.removeListener("exit", exitHook);
  }
}

/** An SSE disconnect is an error, never an implicit successful model turn. */
export async function* openCodeEvents(response: Response, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    await response.body?.cancel();
    throw new OpenCodeError("OpenCode did not accept the event subscription.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      if (signal?.aborted) throw aborted();
      let timer: NodeJS.Timeout | undefined;
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        const silent = Promise.withResolvers<never>();
        timer = setTimeout(() => silent.reject(new OpenCodeError("The OpenCode server stopped sending events.")), 45_000);
        read = await Promise.race([reader.read(), silent.promise]);
      } finally { clearTimeout(timer); }
      if (read.done) throw new OpenCodeError("OpenCode event stream ended before the turn completed.");
      pending = (pending + decoder.decode(read.value, { stream: true })).replace(/\r\n/g, "\n");
      if (pending.length > 8 * 1024 * 1024) throw new OpenCodeError("OpenCode event frame is too large.");
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) !== -1) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const payload = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        if (!payload) continue;
        let event: unknown;
        try { event = JSON.parse(payload); }
        catch { throw new OpenCodeError("OpenCode sent an unreadable event frame."); }
        yield object(event);
      }
    }
  } catch (error) {
    if (signal?.aborted) throw aborted();
    if (error instanceof OpenCodeError) throw error;
    throw new OpenCodeError("OpenCode event stream failed before the turn completed.");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
