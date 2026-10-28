// Native app-server JSON-RPC port from t3code effect-codex-app-server and
// apps/server/src/provider/CodexProvider.ts. No one-shot exec approximation.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import { codexEnvironment, codexLaunchArgs, expandNativePath, nativeFailure, validateCodexLaunchArgs } from "./codex-config.ts";

export type CodexRecord = Record<string, unknown>;
export function object(value: unknown): CodexRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as CodexRecord : {};
}
type Pending = { resolve: (value: CodexRecord) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
export class CodexRpc {
  readonly child: ChildProcessWithoutNullStreams;
  readonly initialized: Promise<CodexRecord>;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(method: string, params: CodexRecord) => void>();
  private userInputHandler?: (id: string | number, params: CodexRecord) => Promise<CodexRecord | null>;
  private incoming = new Set<string | number>();
  private closed?: Error;
  private stopTimer?: NodeJS.Timeout;
  private abort?: () => void;
  private signal?: AbortSignal;
  private stderr = "";
  private context: ProviderDriverContext;
  private constructor(context: ProviderDriverContext, env: NodeJS.ProcessEnv, signal?: AbortSignal) {
    this.context = context;
    const args = codexLaunchArgs(context);
    validateCodexLaunchArgs(args);
    this.child = spawn(expandNativePath(String(context.config.binaryPath || "codex")), ["app-server", ...args], { cwd: context.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    this.child.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      if (buffer.length > 8 * 1024 * 1024) { this.close(nativeFailure(context, "Codex RPC response exceeds the safe limit.")); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try { this.receive(object(JSON.parse(line))); }
        catch (error) { this.close(nativeFailure(context, error)); return; }
      }
    });
    const errDecoder = new StringDecoder("utf8");
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + errDecoder.write(chunk)).slice(-16_384); });
    this.child.stdin.on("error", (error) => this.close(nativeFailure(context, error)));
    this.child.once("error", (error: NodeJS.ErrnoException) => this.close(Object.assign(nativeFailure(context, error), error.code === "ENOENT" ? { code: "provider_not_configured" } : {})));
    this.child.once("close", () => {
      clearTimeout(this.stopTimer);
      this.close(nativeFailure(context, this.stderr || "Codex app-server closed before the requested protocol operation completed."));
    });
    this.signal = signal;
    this.abort = () => this.close(nativeFailure(context, "Request cancelled.", true));
    signal?.addEventListener("abort", this.abort, { once: true });
    this.initialized = this.request("initialize", { clientInfo: { name: "agent-workspace", title: "PM Agent", version: "0.1.0" }, capabilities: { experimentalApi: true } }).then((value) => { this.notify("initialized"); return value; });
    if (signal?.aborted) this.abort();
  }
  static async open(context: ProviderDriverContext, signal?: AbortSignal): Promise<CodexRpc> {
    if (signal?.aborted) throw nativeFailure(context, "Request cancelled.", true);
    const client = new CodexRpc(context, await codexEnvironment(context), signal);
    try { await client.initialized; return client; } catch (error) { client.close(); throw error; }
  }
  request(method: string, params: CodexRecord = {}, timeoutMs = 30_000): Promise<CodexRecord> {
    if (this.closed) return Promise.reject(this.closed);
    const id = ++this.sequence;
    const { promise, resolve, reject } = Promise.withResolvers<CodexRecord>();
    const timer = setTimeout(() => { this.pending.delete(id); reject(nativeFailure(this.context, `Codex ${method} request timed out.`)); }, timeoutMs);
    this.pending.set(id, { resolve, reject, timer });
    this.send({ id, method, params });
    return promise;
  }
  notify(method: string, params?: CodexRecord): void { this.send({ method, ...(params ? { params } : {}) }); }
  subscribe(listener: (method: string, params: CodexRecord) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onUserInput(handler: (id: string | number, params: CodexRecord) => Promise<CodexRecord | null>): void { this.userInputHandler = handler; }
  onClosed(listener: (error: Error) => void): () => void {
    const callback = (method: string, params: CodexRecord) => { if (method === "$closed") listener(params.error as Error); };
    this.listeners.add(callback);
    if (this.closed) queueMicrotask(() => listener(this.closed!));
    return () => { this.listeners.delete(callback); };
  }
  close(error: Error = nativeFailure(this.context, "Codex RPC connection closed.")): void {
    if (this.closed) return;
    this.closed = error;
    if (this.abort) this.signal?.removeEventListener("abort", this.abort);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.incoming.clear();
    for (const listener of this.listeners) listener("$closed", { error });
    this.listeners.clear();
    this.child.kill("SIGTERM");
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.stopTimer = setTimeout(() => this.child.kill("SIGKILL"), 1500); this.stopTimer.unref();
    }
  }
  private send(message: CodexRecord): void {
    if (!this.closed) this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  private receive(message: CodexRecord): void {
    if (message.id !== undefined && typeof message.method === "string") {
      if (message.method === "item/tool/requestUserInput" && this.userInputHandler && (typeof message.id === "string" || typeof message.id === "number")) {
        const id = message.id;
        if (this.incoming.has(id)) { this.close(nativeFailure(this.context, "Codex reused an active native request ID.")); return; }
        this.incoming.add(id);
        void Promise.resolve().then(() => this.incoming.has(id) && !this.closed ? this.userInputHandler!(id, object(message.params)) : null).then((result) => {
          if (!this.incoming.delete(id) || this.closed) return;
          if (result === null) this.send({ id, error: { code: -32800, message: "User input was cancelled." } });
          else this.send({ id, result });
        }, (error: unknown) => {
          if (!this.incoming.delete(id) || this.closed) return;
          this.close(nativeFailure(this.context, error));
        });
        return;
      }
      for (const listener of this.listeners) listener("$request", { id: message.id, method: message.method, params: object(message.params) });
      // The PM has no interactive authorization callback. Never approve commands,
      // file writes, external tools, permissions, or credential refresh requests.
      if (message.method.endsWith("requestApproval")) this.send({ id: message.id, result: { decision: "decline" } });
      else this.send({ id: message.id, error: { code: -32601, message: "This PM session does not authorize interactive native requests." } });
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(nativeFailure(this.context, object(message.error)));
      else pending.resolve(object(message.result));
    } else if (typeof message.method === "string") {
      if (message.method === "serverRequest/resolved") {
        const requestId = object(message.params).requestId;
        if (typeof requestId === "string" || typeof requestId === "number") this.incoming.delete(requestId);
      }
      for (const listener of this.listeners) listener(message.method, object(message.params));
    }
  }
}
