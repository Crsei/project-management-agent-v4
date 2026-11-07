import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionEvent, ExtensionFailure } from "@agent-workspace/contracts/extensions";
import { workspaceRoot } from "../paths.ts";

export type ExtensionErrorStatus = 400 | 401 | 403 | 404 | 409 | 412 | 413 | 415 | 500 | 502 | 503 | 504;
export type ExtensionErrorDetails = { references: Array<{ id: string; label: string; projectId: string }> };
export class ExtensionError extends Error {
  readonly status: ExtensionErrorStatus;
  readonly code: string;
  readonly details?: ExtensionErrorDetails;
  constructor(status: ExtensionErrorStatus, code: string, message: string, details?: ExtensionErrorDetails) {
    super(message);
    this.name = "ExtensionError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export type SidecarInitialization = { dataDir: string; homeDir: string; appDirs: Record<string, string>; claudeMcpFile?: string; secretKey: string };
type Pending = { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> };
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const publicError = (code: string): ExtensionError => new ExtensionError(503, code, "The configuration service could not confirm the operation. Read the authoritative state before retrying; writes are never replayed automatically.");
// Only these reviewed codes carry public meaning; never forward Rust/native diagnostic text.
const mcpErrors: Record<string, { status: ExtensionErrorStatus; message: string }> = {
  mcp_import_preview_stale: { status: 409, message: "The reviewed native configuration or library changed. Create a new import preview before applying it." },
  mcp_import_selection_invalid: { status: 400, message: "The import selection is invalid for this private preview. Review each entry and its supported resolutions." },
  mcp_import_conflict: { status: 409, message: "The selected imports conflict or cannot preserve the shared definition. Review the preview and choose a compatible import plan." },
  mcp_configuration_incompatible: { status: 412, message: "The effective MCP configuration is incompatible with a selected native target. Review its transport, definition and override before saving." },
  mcp_target_unbound: { status: 403, message: "The requested native application has no explicitly confirmed target in this context." },
};

type HostCommand = { command: string; args: string[] };

/** Resolve the reviewed host implementation. The TypeScript entry is the default; the Rust
 * executable remains available only while an operator explicitly selects it during rollback. */
async function hostCommand(): Promise<HostCommand> {
  const configuredEntry = process.env.CC_SWITCH_HOST_ENTRY?.trim();
  if (configuredEntry) {
    if (!path.isAbsolute(configuredEntry)) throw new ExtensionError(503, "sidecar_entry_invalid", "CC_SWITCH_HOST_ENTRY must be an absolute, host-configured script path.");
    await access(configuredEntry).catch(() => { throw publicError("sidecar_binary_missing"); });
    return { command: process.execPath, args: [configuredEntry] };
  }
  const implementation = process.env.CC_SWITCH_HOST_IMPLEMENTATION?.trim() || "ts";
  if (implementation === "rust") {
    const configured = process.env.CC_SWITCH_HOST_BINARY?.trim();
    if (configured) {
      if (!path.isAbsolute(configured)) throw new ExtensionError(503, "sidecar_binary_invalid", "CC_SWITCH_HOST_BINARY must be an absolute, host-configured executable path.");
      await access(configured).catch(() => { throw publicError("sidecar_binary_missing"); });
      return { command: configured, args: [] };
    }
    const executable = process.platform === "win32" ? "cc-switch-host.exe" : "cc-switch-host";
    const packageDirectory = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../../" : "./", import.meta.url));
    const packaged = path.join(packageDirectory, "cc-switch", `${process.platform}-${process.arch}`, executable);
    try { await access(packaged); return { command: packaged, args: [] }; } catch { /* source checkout */ }
    if (!import.meta.url.endsWith(".ts")) throw publicError("sidecar_binary_missing");
    const source = path.join(workspaceRoot, "apps/server/cc-switch-host/target/release", executable);
    await access(source).catch(() => { throw publicError("sidecar_binary_missing"); });
    return { command: source, args: [] };
  }
  if (implementation !== "ts") throw new ExtensionError(503, "sidecar_implementation_invalid", "CC_SWITCH_HOST_IMPLEMENTATION must be 'ts' or 'rust'.");
  const packageDirectory = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../../" : "./", import.meta.url));
  const packaged = path.join(packageDirectory, "cc-switch", "host", "main.mjs");
  try { await access(packaged); return { command: process.execPath, args: [packaged] }; } catch { /* source checkout */ }
  if (import.meta.url.endsWith(".ts")) {
    const source = path.join(workspaceRoot, "apps/server/cc-switch-host/dist/main.mjs");
    try { await access(source); return { command: process.execPath, args: [source] }; } catch { /* use strip-only source below */ }
    const sourceTs = path.join(workspaceRoot, "apps/server/cc-switch-host/src/main.ts");
    await access(sourceTs).catch(() => { throw publicError("sidecar_binary_missing"); });
    return { command: process.execPath, args: [sourceTs] };
  }
  throw publicError("sidecar_binary_missing");
}

/** Owns precisely one child and its descendants; no writes are automatically retried. */
export class ExtensionSidecar {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private termination?: Promise<void>;
  private sequence = 0;
  private pending = new Map<string, Pending>();
  private buffer = "";
  private stopping = false;
  status: "stopped" | "starting" | "ready" | "failed" = "stopped";
  lastError?: ExtensionFailure;
  private readonly initialize: () => Promise<SidecarInitialization>;
  private readonly publish: (event: ExtensionEvent) => void;
  constructor(initialize: () => Promise<SidecarInitialization>, publish: (event: ExtensionEvent) => void) {
    this.initialize = initialize;
    this.publish = publish;
  }

  private state(status: ExtensionSidecar["status"], failure?: ExtensionFailure): void {
    this.status = status;
    this.lastError = failure;
    this.publish({ event: "status", data: { status, ...(failure ? { error: failure } : {}) } });
  }
  private fail(code: string): void {
    if (this.stopping) return;
    const error = publicError(code);
    this.state("failed", { code: error.code, message: error.message });
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    this.terminate();
  }
  private terminate(): void {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    child.stdin.destroy();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.termination = promise;
    // Failure-triggered cleanup has no direct awaiter; close/reconnect still observe the original rejection.
    void promise.catch(() => undefined);
    if (child.pid && process.platform !== "win32") {
      const group = -child.pid;
      try { process.kill(group, "SIGTERM"); } catch { /* Already exited. */ }
      setTimeout(() => {
        try { process.kill(group, "SIGKILL"); } catch { /* Already exited. */ }
        resolve();
      }, 1500);
    } else if (child.pid) {
      // Fixed arguments address only this owned child's process tree, never a browser-supplied PID or shell command.
      const systemRoot = process.env.SystemRoot;
      if (!systemRoot || !path.win32.isAbsolute(systemRoot)) { child.kill(); reject(publicError("sidecar_tree_stop_unconfirmed")); return; }
      const killer = spawn(path.join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
      const deadline = setTimeout(() => { killer.kill(); child.kill(); reject(publicError("sidecar_tree_stop_unconfirmed")); }, 5000);
      killer.once("exit", code => { clearTimeout(deadline); if (code === 0) resolve(); else { child.kill(); reject(publicError("sidecar_tree_stop_unconfirmed")); } });
      killer.once("error", () => { clearTimeout(deadline); child.kill(); reject(publicError("sidecar_tree_stop_unconfirmed")); });
    } else { child.kill(); resolve(); }
  }
  private accept(line: string): void {
    let value: unknown;
    try { value = JSON.parse(line); } catch { this.fail("sidecar_protocol_invalid"); return; }
    if (!value || typeof value !== "object" || Array.isArray(value)) { this.fail("sidecar_protocol_invalid"); return; }
    const message = value as Record<string, unknown>;
    if (typeof message.event === "string") {
      if (message.event === "mcp-connectivity" && message.data && typeof message.data === "object") {
        const data = message.data as Record<string, unknown>;
        if (typeof data.serverId === "string" && typeof data.connected === "boolean") this.publish({ event: "mcp-connectivity", data: { serverId: data.serverId, connected: data.connected, ...(typeof data.batchId === "string" ? { batchId: data.batchId } : {}), ...(typeof message.requestId === "string" ? { requestId: message.requestId } : {}) }, ...(typeof message.requestId === "string" ? { requestId: message.requestId } : {}) });
      } else if (message.event === "warning" || message.event === "operation-failure" || message.event === "extension-warning") {
        // Diagnostic messages can contain credentials and native paths. Only safe state crosses the bridge.
        this.publish({ event: "warning", data: { code: "sidecar_operation_warning", message: "A native projection reported a warning. Reconcile its configuration before use." } });
      }
      return;
    }
    if (typeof message.id !== "string") { this.fail("sidecar_protocol_invalid"); return; }
    const item = this.pending.get(message.id);
    if (!item) return;
    clearTimeout(item.timer);
    this.pending.delete(message.id);
    if (message.error !== undefined) {
      // Never trust server/CLI errors not to echo headers, argv or private endpoint queries.
      const raw = message.error;
      const code = raw && typeof raw === "object" && "code" in raw && typeof raw.code === "string" ? raw.code : undefined;
      const safe = code && Object.hasOwn(mcpErrors, code) ? mcpErrors[code] : undefined;
      item.reject(safe ? new ExtensionError(safe.status, code!, safe.message) : new ExtensionError(502, "sidecar_operation_failed", "The configuration operation failed. Its raw diagnostic is withheld to protect private configuration; read the current state before retrying."));
    } else if (Object.hasOwn(message, "result")) item.resolve(message.result);
    else { item.reject(publicError("sidecar_protocol_invalid")); this.fail("sidecar_protocol_invalid"); }
  }
  private async start(): Promise<void> {
    if (this.stopping) throw publicError("sidecar_stopping");
    this.state("starting");
    try {
    await this.termination;
    if (this.stopping) throw publicError("sidecar_stopping");
      const executable = await hostCommand();
      const config = await this.initialize();
      if (this.stopping) { config.secretKey = ""; throw publicError("sidecar_stopping"); }
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: config.homeDir, USERPROFILE: config.homeDir, LANG: process.env.LANG ?? "C.UTF-8", ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}), ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) };
      // Preserve source HTTP proxy routing without inheriting the rest of the Agent environment.
      for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
      const child = spawn(executable.command, executable.args, { cwd: config.dataDir, env, stdio: "pipe", windowsHide: true, detached: process.platform !== "win32" });
      this.child = child;
      this.buffer = "";
      child.stdin.on("error", () => { if (this.child === child) this.fail("sidecar_stdin_closed"); });
      child.stdout.on("error", () => { if (this.child === child) this.fail("sidecar_stdout_closed"); });
      child.stderr.on("error", () => { if (this.child === child) this.fail("sidecar_stderr_closed"); });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (this.child !== child) return;
        this.buffer += chunk;
        if (Buffer.byteLength(this.buffer) > MAX_MESSAGE_BYTES) { this.fail("sidecar_response_too_large"); return; }
        let end: number;
        while ((end = this.buffer.indexOf("\n")) !== -1) { const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1); if (line.trim()) this.accept(line); }
      });
      // Drain stderr without logging or persisting potential secrets from third-party diagnostics.
      child.stderr.on("data", () => undefined);
      child.once("error", () => { if (this.child === child) this.fail("sidecar_start_failed"); });
      child.once("exit", () => { if (this.child === child) this.fail("sidecar_disconnected"); });
      let initialized: unknown;
      try { initialized = await this.send("host_initialize", config, 30_000); }
      finally { config.secretKey = ""; }
      if (!initialized || typeof initialized !== "object" || !("initialized" in initialized) || initialized.initialized !== true) throw publicError("sidecar_initialization_failed");
      this.state("ready");
    } catch (error) {
      this.fail(error instanceof ExtensionError ? error.code : "sidecar_initialization_failed");
      throw error instanceof ExtensionError ? error : publicError("sidecar_initialization_failed");
    }
  }
  private send(command: string, args: object, timeout: number): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(publicError("sidecar_disconnected"));
    const id = `${++this.sequence}`;
    const message = JSON.stringify({ id, command, args }) + "\n";
    if (Buffer.byteLength(message) > MAX_MESSAGE_BYTES) return Promise.reject(new ExtensionError(413, "sidecar_request_too_large", "The configuration request is too large."));
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => this.fail("sidecar_timeout_outcome_unknown"), timeout);
    timer.unref();
    this.pending.set(id, { resolve, reject, timer });
    child.stdin.write(message, error => { if (error && this.child === child) this.fail("sidecar_stdin_closed"); });
    return promise;
  }
  async invoke(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (this.status !== "ready") {
      // A subsequent, explicit request may reconnect; the failed request itself is never replayed.
      if (!this.starting) this.starting = this.start().finally(() => { this.starting = undefined; });
      await this.starting;
    }
    return this.send(command, args, 10 * 60_000);
  }
  async close(): Promise<void> {
    this.stopping = true;
    const error = publicError("sidecar_stopping");
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    this.terminate();
    await this.termination;
    this.state("stopped");
  }
}
