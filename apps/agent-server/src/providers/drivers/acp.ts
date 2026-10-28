// Ported from t3code packages/effect-acp/src/{client,protocol}.ts and
// packages/provider-acp/src/server/{AcpSessionRuntime,clientTerminals}.ts (MIT).
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { CliTokenUsage } from "../../agents/cli-chat.ts";
import { sanitizeErrorMessage } from "../../agents/cli-chat.ts";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import type { ProviderErrorClass, ProviderModel } from "@agent-workspace/contracts/provider";
import type { NativeInteractionRequest, NativeInteractionResponse, NativeOutputEvent } from "@agent-workspace/contracts/output";
import type { NativeUsageUpdate } from "@agent-workspace/contracts/usage";
import { AcpTurnOutput } from "./acp-output.ts";

export type AcpRecord = Record<string, unknown>;
export const acpRecord = (value: unknown): AcpRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as AcpRecord : {};
export class AcpError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly errorClass: ProviderErrorClass | undefined;
  constructor(
    message: string,
    code = -32603,
    data?: unknown,
    errorClass: ProviderErrorClass | undefined = code === -32000 ? "authentication" : code === -32003 ? "usage_limit" : code === -32601 ? "unsupported" : undefined,
  ) {
    super(sanitizeErrorMessage(message)); this.name = "AcpError";
    this.code = code; this.data = data; this.errorClass = errorClass;
  }
}
export const isAcpAuthenticationRequired = (error: unknown): boolean =>
  error instanceof AcpError && error.code === -32000;
export type AcpSpawn = { command: string; args: readonly string[]; env?: NodeJS.ProcessEnv };
export type AcpClientOptions = {
  signal?: AbortSignal;
  initializeMeta?: AcpRecord;
  clientCapabilities?: AcpRecord;
  filterStdoutLine?: (line: string) => string | null;
  onStderr?: (chunk: string) => void;
  normalizeSessionUpdate?: (params: AcpRecord) => AcpRecord;
  onUpdate?: (params: AcpRecord) => void;
  onNotification?: (method: string, params: AcpRecord) => void;
  onRequest?: (method: string, params: AcpRecord) => Promise<unknown>;
  cancelMeta?: AcpRecord;
  resumeMethod?: "load" | "resume";
  grokCompletion?: boolean;
  terminalShellCommands?: boolean;
  ownDescendantProcessGroups?: boolean;
};
type Pending = { resolve: (value: AcpRecord) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout };
type ActivePrompt = { id: string; text: string; onText?: (delta: string) => void; onRequest?: (request: NativeInteractionRequest) => Promise<NativeInteractionResponse>; onUsage?: (update: NativeUsageUpdate) => void; signal?: AbortSignal; output: AcpTurnOutput; messageKey?: string; messageText: string; messageSerial: number; resolve: (value: AcpRecord) => void; reject: (error: Error) => void };
type Terminal = { sessionId: string; child: ChildProcessWithoutNullStreams; output: Buffer[]; bytes: number; limit: number; truncated: boolean; exitStatus?: AcpRecord; exit: Promise<AcpRecord> };

function trimTerminal(terminal: Terminal, bytes: number): void {
  let remaining = Math.min(bytes, terminal.bytes);
  while (remaining > 0) {
    const first = terminal.output[0]!;
    const remove = Math.min(remaining, first.length);
    if (remove === first.length) terminal.output.shift();
    else terminal.output[0] = first.subarray(remove);
    terminal.bytes -= remove; remaining -= remove;
    terminal.truncated = true;
  }
}

const validCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function acpTurnUsage(value: unknown): NativeUsageUpdate["turn"] | undefined {
  const usage = acpRecord(value);
  const input = usage.inputTokens ?? usage.input_tokens;
  const output = usage.outputTokens ?? usage.output_tokens;
  if (!validCount(input) || !validCount(output)) return;
  const cachedValue = usage.cachedInputTokens ?? usage.cached_input_tokens;
  const writeValue = usage.cacheCreationTokens ?? usage.cache_creation_tokens;
  const reasoningValue = usage.thoughtTokens ?? usage.reasoningTokens ?? usage.reasoning_tokens;
  if (!validCount(cachedValue) || !validCount(writeValue) || !validCount(reasoningValue)) return;
  if (cachedValue > input || writeValue > input - cachedValue || reasoningValue > output) return;
  return { totals: { uncachedInputTokens: input - cachedValue - writeValue, cachedInputTokens: cachedValue, cacheCreationTokens: writeValue, outputTokens: output, reasoningTokens: reasoningValue } };
}

function acpReportedTurn(value: unknown): NativeUsageUpdate["reportedTurn"] | undefined {
  const usage = acpRecord(value);
  const input = usage.inputTokens ?? usage.input_tokens;
  const output = usage.outputTokens ?? usage.output_tokens;
  if (!validCount(input) || !validCount(output)) return;
  const cached = usage.cachedInputTokens ?? usage.cached_input_tokens;
  const write = usage.cacheCreationTokens ?? usage.cache_creation_tokens;
  const reasoning = usage.thoughtTokens ?? usage.reasoningTokens ?? usage.reasoning_tokens;
  return { inputTokens: input, outputTokens: output,
    ...(validCount(cached) ? { cachedInputTokens: cached } : {}),
    ...(validCount(write) ? { cacheCreationTokens: write } : {}),
    ...(validCount(reasoning) ? { reasoningTokens: reasoning } : {}) };
}

function normalizeOptions(value: unknown): AcpRecord[] {
  return Array.isArray(value) ? value.map(acpRecord).map((option) => ({ ...option, id: option.id ?? option.configId })) : [];
}
export function acpModelOption(value: unknown): AcpRecord | undefined {
  return normalizeOptions(value).find((option) => option.category === "model" || option.id === "model" || option.id === "modelId");
}
export function acpModels(...sources: unknown[]): ProviderModel[] {
  const models = new Map<string, ProviderModel>();
  const add = (id: unknown, label: unknown, meta?: unknown) => {
    if (typeof id !== "string" || !id.trim() || id.length > 256 || models.size >= 256) return;
    const extra = acpRecord(meta);
    models.set(id, { id, label: typeof label === "string" && label.trim() ? label.slice(0, 160) : id, source: "discovered", temperature: false, ...(extra.supportsReasoningEffort === true ? { reasoning: true } : {}) });
  };
  const choices = (options: unknown): void => {
    if (!Array.isArray(options)) return;
    for (const value of options) {
      const option = acpRecord(value);
      if (Array.isArray(option.options)) choices(option.options);
      else add(option.value, option.name ?? option.label, option._meta);
    }
  };
  for (const source of sources) {
    const data = acpRecord(source);
    const state = acpRecord(data.models ?? acpRecord(data._meta).modelState);
    if (Array.isArray(state.availableModels)) for (const value of state.availableModels) { const model = acpRecord(value); add(model.modelId, model.name, model._meta); }
    choices(acpModelOption(data.configOptions)?.options);
  }
  return [...models.values()];
}

function stopProcess(child: { pid?: number; kill: (signal: NodeJS.Signals) => boolean }, signal: NodeJS.Signals): Promise<void> {
  if (process.platform === "win32" && child.pid) {
    const { promise, resolve } = Promise.withResolvers<void>();
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.once("error", () => { try { child.kill(signal); } catch { /* Already exited. */ } resolve(); });
    killer.once("close", () => resolve());
    return promise;
  }
  try { if (child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already exited. */ }
  return Promise.resolve();
}

async function stopLinuxProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid) return stopProcess(child, "SIGKILL");
  const identity = async (pid: number) => {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return { pid, parent: Number(fields[1]), started: fields[19] };
    } catch { return undefined; }
  };
  const root = await identity(child.pid);
  if (!root) return stopProcess(child, "SIGKILL");
  const entries = await readdir("/proc").catch(() => [] as string[]);
  const snapshots = (await Promise.all(entries.filter((entry) => /^\d+$/.test(entry)).map((entry) => identity(Number(entry))))).filter((entry) => entry !== undefined);
  const owned = new Set([root.pid]);
  const descendants: typeof snapshots = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of snapshots) if (!owned.has(entry.pid) && owned.has(entry.parent)) { owned.add(entry.pid); descendants.push(entry); changed = true; }
  }
  // Verify start identity before touching a PID; unrelated reused PIDs are never killed.
  for (const entry of descendants.reverse()) {
    const current = await identity(entry.pid);
    if (current?.started === entry.started) try { process.kill(entry.pid, "SIGKILL"); } catch { /* Already exited. */ }
  }
  const current = await identity(root.pid);
  if (current?.started === root.started) await stopProcess(child, "SIGKILL");
}

/** A single isolated native ACP process. No global configuration or credentials are read. */
export class AcpClient {
  generation: 1 | 2 = 1;
  initialized: AcpRecord = {};
  sessionSetup: AcpRecord = {};
  sessionId = "";
  private initialization?: Promise<AcpRecord>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string | number, Pending>();
  private readonly terminals = new Map<string, Terminal>();
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private failure?: Error;
  private active?: ActivePrompt;
  private cancelTimer?: NodeJS.Timeout;
  private readonly decoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private readonly abort: () => void;
  private readonly closed = Promise.withResolvers<void>();
  private termination: Promise<void> = Promise.resolve();

  readonly context: ProviderDriverContext;
  readonly spawnInput: AcpSpawn;
  readonly options: AcpClientOptions;
  constructor(context: ProviderDriverContext, spawnInput: AcpSpawn, options: AcpClientOptions = {}) {
    this.context = context; this.spawnInput = spawnInput; this.options = options;
    if (!spawnInput.command || spawnInput.command.includes("\0") || spawnInput.args.some((arg) => arg.includes("\0"))) throw new AcpError("Invalid ACP executable or arguments.");
    this.child = spawn(spawnInput.command, [...spawnInput.args], { cwd: context.cwd, env: { ...context.env, ...spawnInput.env }, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    this.abort = () => this.fail(new DOMException("ACP operation cancelled.", "AbortError"));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stdout.on("data", (chunk: Buffer) => {
      try { this.consume(this.decoder.write(chunk)); } catch (error) { this.fail(error); }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      try { const text = this.stderrDecoder.write(chunk); this.stderr = (this.stderr + text).slice(-16 * 1024); options.onStderr?.(text); } catch (error) { this.fail(error); }
    });
    this.child.once("error", (error) => this.fail(error));
    this.child.once("close", (code, signal) => {
      void this.termination.then(() => this.closed.resolve());
      try {
        this.consume(this.decoder.end());
        if (this.buffer.trim()) throw new AcpError("ACP closed with an incomplete JSON-RPC frame.");
        this.fail(new AcpError(this.redact(`ACP process exited (${signal ?? code ?? "unknown"}). ${this.stderr}`)));
      } catch (error) { this.fail(error); }
    });
    options.signal?.addEventListener("abort", this.abort, { once: true });
    if (options.signal?.aborted) this.abort();
  }

  private redact(message: string): string {
    for (const [name, value] of Object.entries({ ...this.context.env, ...this.spawnInput.env })) {
      if (/(?:api.?key|token|secret|password|credential|auth)/i.test(name) && typeof value === "string" && value.length >= 4) message = message.split(value).join("***");
    }
    return sanitizeErrorMessage(message);
  }

  private fail(value: unknown): void {
    if (this.failure) return;
    this.failure = value instanceof Error ? value : new AcpError(String(value));
    clearTimeout(this.cancelTimer);
    this.options.signal?.removeEventListener("abort", this.abort);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.failure); }
    this.pending.clear();
    this.active?.reject(this.failure);
    this.active = undefined;
    const terminals = [...this.terminals.values()].map((terminal) => stopProcess(terminal.child, "SIGKILL"));
    this.terminals.clear();
    const nativeTermination = this.options.ownDescendantProcessGroups && process.platform === "linux" ? stopLinuxProcessTree(this.child) : stopProcess(this.child, "SIGKILL");
    this.termination = Promise.all([...terminals, nativeTermination]).then(() => {});
  }

  close(): void { this.fail(new AcpError("ACP connection closed.")); }
  waitForClose(): Promise<void> { return this.closed.promise; }
  private send(message: AcpRecord): void {
    if (this.failure) throw this.failure;
    this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => { if (error) this.fail(error); });
  }
  request(method: string, params: AcpRecord = {}, timeoutMs = 60_000): Promise<AcpRecord> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= 256) return Promise.reject(new AcpError("Too many pending ACP requests."));
    const id = this.nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<AcpRecord>();
    const timer = timeoutMs > 0 ? setTimeout(() => this.fail(new AcpError(`ACP ${method} timed out.`)), timeoutMs) : undefined;
    this.pending.set(id, { resolve, reject, timer });
    try { this.send({ jsonrpc: "2.0", id, method, params }); } catch (error) { this.fail(error); }
    return promise;
  }
  notify(method: string, params: AcpRecord = {}): void { this.send({ jsonrpc: "2.0", method, params }); }

  private consume(text: string): void {
    this.buffer += text;
    if (Buffer.byteLength(this.buffer) > 16 * 1024 * 1024) throw new AcpError("ACP frame exceeds the transport limit.");
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      let line: string | null = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (this.options.filterStdoutLine) line = this.options.filterStdoutLine(line);
      if (!line?.trim()) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { throw new AcpError("ACP emitted a malformed JSON-RPC frame."); }
      const message = acpRecord(value);
      if (message.jsonrpc !== "2.0") throw new AcpError("ACP emitted an invalid JSON-RPC version.");
      if (typeof message.method === "string") {
        const params = acpRecord(message.params);
        if (typeof message.id === "string" || typeof message.id === "number") {
          const id = message.id;
          const question = this.options.grokCompletion && ["x.ai/ask_user_question", "_x.ai/ask_user_question"].includes(message.method) && this.active?.onRequest;
          if (!question && this.active && (params.sessionId === undefined || params.sessionId === this.sessionId)) this.active.output.rejectedRequest(message.method, params);
          void this.handleRequest(message.method, params).then((result) => {
            if (!this.failure) this.send({ jsonrpc: "2.0", id, result });
          }, (error: unknown) => {
            if (!this.failure) this.send({ jsonrpc: "2.0", id, error: { code: error instanceof AcpError ? error.code : -32603, message: this.redact(error instanceof Error ? error.message : String(error)) } });
          }).catch((error) => this.fail(error));
        } else this.notification(message.method, params);
      } else if (typeof message.id === "string" || typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error !== undefined) { const error = acpRecord(message.error); pending.reject(new AcpError(this.redact(String(error.message ?? "ACP request failed.")), typeof error.code === "number" ? error.code : -32603, error.data)); }
        else if ("result" in message) pending.resolve(acpRecord(message.result));
        else pending.reject(new AcpError("ACP response omitted result and error."));
      } else throw new AcpError("ACP emitted an invalid JSON-RPC envelope.");
    }
  }

  private notification(method: string, params: AcpRecord): void {
    this.options.onNotification?.(method, params);
    if (this.active && params.sessionId === this.sessionId) this.active.output.notification(method, params);
    if (method === "session/update") {
      const sourceSessionId = params.sessionId;
      params = this.options.normalizeSessionUpdate?.(params) ?? params;
      this.options.onUpdate?.(params);
      const update = acpRecord(params.update);
      if (Array.isArray(update.configOptions)) this.sessionSetup.configOptions = normalizeOptions(update.configOptions);
      if (!this.active) return;
      if (params.sessionId !== this.sessionId) {
        if (sourceSessionId === this.sessionId && typeof params.sessionId === "string") this.active.output.consumeChild(update, params.sessionId);
        return;
      }
      const promptId = acpRecord(params._meta).promptId;
      if (this.options.grokCompletion && typeof promptId === "string" && (promptId.startsWith("task-completed-") || promptId !== this.active.id)) return;
      if (update.sessionUpdate === "usage_update" && validCount(update.used)) {
        this.active.onUsage?.({ context: { usedTokens: update.used, ...(validCount(update.size) && update.size > 0 ? { maxTokens: update.size } : {}), updatedAt: new Date().toISOString() } });
      } else if (update.sessionUpdate === "state_update" && update.state === "idle") {
        const usage = acpRecord(update.usage);
        if (validCount(usage.totalTokens)) this.active.onUsage?.({ context: { usedTokens: usage.totalTokens, updatedAt: new Date().toISOString() } });
      }
      this.active.output.consume(update);
      if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_message") {
        const native = typeof update.messageId === "string" ? update.messageId : undefined;
        const key = native ?? this.active.messageKey ?? `anonymous:${++this.active.messageSerial}`;
        if (this.active.messageKey !== key) {
          if (this.active.text) this.appendText("\n\n");
          this.active.messageKey = key; this.active.messageText = "";
        }
        const blocks = Array.isArray(update.content) ? update.content : [update.content];
        const text = blocks.map(acpRecord).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => String(block.text)).join("");
        if (update.sessionUpdate === "agent_message_chunk") {
          this.active.messageText += text; this.appendText(text);
        } else {
          if (text.startsWith(this.active.messageText)) this.appendText(text.slice(this.active.messageText.length));
          this.active.messageText = text; this.active.messageKey = undefined;
        }
      } else {
        if (update.sessionUpdate !== "state_update") this.active.messageKey = undefined;
        if (this.generation === 2 && update.sessionUpdate === "state_update" && update.state === "idle") this.complete(update);
      }
    }
    if (this.options.grokCompletion && this.active && params.sessionId === this.sessionId) {
      let completion: AcpRecord | undefined;
      if (method === "x.ai/session/prompt_complete" || method === "_x.ai/session/prompt_complete") completion = params;
      if (["x.ai/session_notification", "_x.ai/session_notification", "_x.ai/session/update"].includes(method)) {
        const update = acpRecord(params.update);
        if (update.sessionUpdate === "turn_completed") completion = { ...update, promptId: update.prompt_id ?? update.promptId, stopReason: update.stop_reason ?? update.stopReason, agentResult: update.agent_result ?? update.agentResult };
      }
      if (completion && (completion.promptId === this.active.id || (completion.promptId === undefined && !method.endsWith("session_notification") && !method.endsWith("session/update")))) this.complete(completion);
    }
  }
  private appendText(delta: string): void {
    if (!this.active) return;
    this.active.text += delta;
    this.active.onText?.(delta);
  }
  private complete(result: AcpRecord): void {
    if (!this.active) return;
    const reason = result.stopReason ?? "end_turn";
    if (result.error || reason === "error" || reason === "rate_limit") {
      const message = this.redact(String(acpRecord(result.error).message ?? result.agentResult ?? (reason === "rate_limit" ? "Grok usage limit reached." : "ACP prompt failed.")));
      this.active.output.error(message);
      this.active.reject(new AcpError(message, reason === "rate_limit" ? -32003 : -32603));
    } else this.active.resolve({ ...result, stopReason: reason });
  }

  initialize(): Promise<AcpRecord> {
    return this.initialization ??= this.request("initialize", {
      protocolVersion: 2, info: { name: "pm-agent", version: "3" }, clientInfo: { name: "pm-agent", version: "3" },
      capabilities: { auth: { terminal: {} }, elicitation: { form: {}, url: {} } },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: true }, elicitation: { form: {}, url: {} }, ...this.options.clientCapabilities },
      ...(this.options.initializeMeta ? { _meta: this.options.initializeMeta } : {}),
    }).then((result) => {
      this.generation = "info" in result ? 2 : 1;
      if (this.generation === 2) {
        const caps = acpRecord(result.capabilities); const session = acpRecord(caps.session);
        result.agentInfo = result.info;
        result.agentCapabilities = { loadSession: Boolean(caps.session), sessionCapabilities: { ...(caps.session ? { resume: {}, list: {}, close: {} } : {}), ...(session.fork ? { fork: {} } : {}) }, ...(Array.isArray(result.authMethods) && result.authMethods.length ? { auth: { logout: {} } } : {}) };
      }
      if (Array.isArray(result.authMethods)) result.authMethods = result.authMethods.map(acpRecord).map((method) => ({ ...method, id: method.id ?? method.methodId }));
      this.initialized = result; return result;
    });
  }
  async authenticate(methodId: string, extra: AcpRecord = {}): Promise<AcpRecord> { await this.initialize(); return this.request(this.generation === 2 ? "auth/login" : "authenticate", { ...extra, methodId }, 10 * 60_000); }
  async logout(): Promise<void> {
    await this.initialize();
    if (!acpRecord(acpRecord(this.initialized.agentCapabilities).auth).logout) throw new AcpError("This ACP agent does not advertise logout support.", -32601);
    await this.request(this.generation === 2 ? "auth/logout" : "logout", {});
  }
  async start(sessionId?: string): Promise<AcpRecord> {
    await this.initialize();
    const caps = acpRecord(this.initialized.agentCapabilities);
    let method = "session/new";
    if (sessionId) {
      if (this.generation === 2 || this.options.resumeMethod === "resume" || caps.loadSession !== true) {
        if (this.generation === 1 && !acpRecord(caps.sessionCapabilities).resume) throw new AcpError("ACP agent does not support native session resume.", -32601);
        method = "session/resume";
      } else method = "session/load";
    }
    // Set before load so replay notifications cannot become a new assistant reply.
    this.sessionId = sessionId ?? "";
    const setup = await this.request(method, { cwd: this.context.cwd, mcpServers: [], ...(sessionId ? { sessionId } : {}) });
    this.sessionId = sessionId ?? (typeof setup.sessionId === "string" ? setup.sessionId : "");
    if (!this.sessionId) throw new AcpError("ACP agent omitted its native session ID.");
    this.sessionSetup = { ...setup, configOptions: normalizeOptions(setup.configOptions) };
    return this.sessionSetup;
  }
  async setModel(model: string): Promise<void> {
    if (!this.sessionId) throw new AcpError("ACP session has not started.");
    const option = acpModelOption(this.sessionSetup.configOptions);
    if (option) {
      if (option.currentValue === model) return;
      const result = await this.request("session/set_config_option", { sessionId: this.sessionId, configId: option.id, value: model, ...(this.generation === 2 ? { type: "id" } : {}) });
      if (result.configOptions) this.sessionSetup.configOptions = normalizeOptions(result.configOptions);
      return;
    }
    if (acpRecord(this.sessionSetup.models).currentModelId === model) return;
    if (this.generation === 2) throw new AcpError("ACP agent did not advertise a model configuration option.", -32601);
    await this.request("session/set_model", { sessionId: this.sessionId, modelId: model });
  }
  cancel(): void {
    if (!this.sessionId || !this.active || this.failure || this.cancelTimer) return;
    this.notify("session/cancel", { sessionId: this.sessionId, ...(this.options.cancelMeta ? { _meta: this.options.cancelMeta } : {}) });
    this.cancelTimer = setTimeout(() => this.fail(new DOMException("ACP agent did not finish cancellation.", "AbortError")), 5_000);
  }
  async prompt(prompt: string, onText?: (delta: string) => void, signal?: AbortSignal, onEvent?: (event: NativeOutputEvent) => void, onRequest?: (request: NativeInteractionRequest) => Promise<NativeInteractionResponse>, onUsage?: (update: NativeUsageUpdate) => void): Promise<{ text: string; usage?: CliTokenUsage }> {
    if (!this.sessionId || this.active) throw new AcpError("ACP prompt requires one idle native session.");
    if (signal?.aborted) throw new DOMException("ACP prompt cancelled.", "AbortError");
    const { promise: completion, resolve, reject } = Promise.withResolvers<AcpRecord>();
    let usageCallbackFailed = false; let usageCallbackError: unknown;
    const reportUsage = onUsage && ((update: NativeUsageUpdate) => { try { onUsage(update); } catch (error) { usageCallbackFailed = true; usageCallbackError = error; throw error; } });
    const active: ActivePrompt = { id: `pm-acp-${randomUUID()}`, text: "", messageText: "", messageSerial: 0, onText, onRequest, onUsage: reportUsage, signal, output: new AcpTurnOutput(onEvent, this.options.grokCompletion), resolve, reject };
    this.active = active;
    const abort = () => this.cancel();
    signal?.addEventListener("abort", abort, { once: true });
    const request = this.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text: prompt }], ...(this.options.grokCompletion ? { _meta: { promptId: active.id, requestId: active.id } } : {}) }, 0);
    void request.then((result) => {
      if (this.active !== active) return;
      if (this.generation === 1 && typeof result.stopReason !== "string") reject(new AcpError("ACP prompt response omitted its terminal stop reason."));
      else if (this.generation === 1 || typeof result.stopReason === "string") this.complete(result);
    }, reject).catch((error: unknown) => this.fail(error));
    try {
      const result = await completion;
      if (signal?.aborted || result.stopReason === "cancelled") throw new DOMException("ACP prompt cancelled.", "AbortError");
      if (result.stopReason !== "end_turn") throw new AcpError(`ACP prompt did not complete: ${String(result.stopReason)}.`);
      active.output.finish();
      const turn = acpTurnUsage(result.usage);
      const reportedTurn = acpReportedTurn(result.usage);
      if (turn || reportedTurn) reportUsage?.({ ...(turn ? { turn } : {}), ...(reportedTurn ? { reportedTurn } : {}) });
      const usage = acpRecord(result.usage);
      const inputTokens = typeof usage.inputTokens === "number" ? usage.inputTokens : typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
      const outputTokens = typeof usage.outputTokens === "number" ? usage.outputTokens : typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
      return { text: active.text, ...(inputTokens !== undefined || outputTokens !== undefined ? { usage: { inputTokens, outputTokens } } : {}) };
    } catch (error) { if (usageCallbackFailed) throw usageCallbackError; throw error; }
    finally { signal?.removeEventListener("abort", abort); clearTimeout(this.cancelTimer); this.cancelTimer = undefined; if (this.active === active) this.active = undefined; }
  }

  private async scopedCwd(value: unknown): Promise<string> {
    const root = await realpath(this.context.cwd);
    const cwd = await realpath(typeof value === "string" ? path.resolve(root, value) : root);
    const relative = path.relative(root, cwd);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new AcpError("ACP terminal directory is outside the bound project scope.");
    return cwd;
  }
  private async handleRequest(method: string, params: AcpRecord): Promise<unknown> {
    if (this.options.grokCompletion && ["x.ai/ask_user_question", "_x.ai/ask_user_question"].includes(method) && this.active?.onRequest) {
      const source = Object.keys(acpRecord(params.params)).length ? acpRecord(params.params) : params;
      if (source.sessionId !== this.sessionId) throw new AcpError("Grok question belongs to a different session.");
      try { return await this.active.output.grokQuestion(params, this.active.onRequest, this.active.signal); }
      catch (error) { this.fail(error); throw error; }
    }
    if (this.options.onRequest) {
      const result = await this.options.onRequest(method, params);
      if (result !== undefined) return result;
    }
    if (method === "session/request_permission") {
      const options = Array.isArray(params.options) ? params.options.map(acpRecord) : [];
      const denied = options.find((option) => option.kind === "reject_once");
      return { outcome: denied ? { outcome: "selected", optionId: denied.optionId } : { outcome: "cancelled" } };
    }
    if (method === "terminal/create" && this.options.clientCapabilities?.terminal === true) {
      if (params.sessionId !== this.sessionId || this.terminals.size >= 64 || [...this.terminals.values()].filter((terminal) => !terminal.exitStatus).length >= 16) throw new AcpError("Invalid ACP terminal session or terminal limit reached.");
      if (typeof params.command !== "string" || !params.command || params.command.includes("\0")) throw new AcpError("Invalid ACP terminal command.");
      const args = Array.isArray(params.args) && params.args.every((arg) => typeof arg === "string") ? params.args as string[] : [];
      const env = { ...this.context.env, ...this.spawnInput.env };
      if (Array.isArray(params.env)) for (const variable of params.env) { const item = acpRecord(variable); if (typeof item.name === "string" && typeof item.value === "string" && !["HOME", "GROK_HOME", "USERPROFILE", "XDG_CONFIG_HOME"].includes(item.name)) env[item.name] = item.value; }
      const child = spawn(params.command, args, { cwd: await this.scopedCwd(params.cwd), env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], shell: this.options.terminalShellCommands === true && args.length === 0 });
      const terminalId = `pm-term-${randomUUID()}`;
      const { promise: exit, resolve: finish } = Promise.withResolvers<AcpRecord>();
      const terminal: Terminal = { sessionId: this.sessionId, child, output: [], bytes: 0, truncated: false, limit: Math.max(1, Math.min(typeof params.outputByteLimit === "number" ? params.outputByteLimit : 4 * 1024 * 1024, 8 * 1024 * 1024)), exit };
      const prompt = this.active;
      const stdoutDecoder = new StringDecoder("utf8"); const stderrDecoder = new StringDecoder("utf8");
      const append = (chunk: Buffer) => {
        terminal.output.push(chunk); terminal.bytes += chunk.byteLength;
        if (terminal.bytes > terminal.limit) trimTerminal(terminal, terminal.bytes - terminal.limit);
        let excess = [...this.terminals.values()].reduce((sum, item) => sum + item.bytes, 0) - 16 * 1024 * 1024;
        for (const item of this.terminals.values()) if (excess > 0) {
          const before = item.bytes; trimTerminal(item, excess); excess -= before - item.bytes;
        }
      };
      const forward = (chunk: Buffer, decoder: StringDecoder) => {
        append(chunk);
        try { const data = decoder.write(chunk); if (data && prompt && this.active === prompt) prompt.output.consume({ sessionUpdate: "terminal_output_chunk", terminalId, data }); } catch (error) { this.fail(error); }
      };
      child.stdout.on("data", (chunk: Buffer) => forward(chunk, stdoutDecoder)); child.stderr.on("data", (chunk: Buffer) => forward(chunk, stderrDecoder));
      child.once("error", (error) => { append(Buffer.from(sanitizeErrorMessage(error))); terminal.exitStatus = { exitCode: 1 }; finish(terminal.exitStatus); });
      child.once("close", (exitCode, signal) => {
        terminal.exitStatus ??= { exitCode, signal };
        try {
          if (prompt && this.active === prompt) {
            for (const data of [stdoutDecoder.end(), stderrDecoder.end()]) if (data) prompt.output.consume({ sessionUpdate: "terminal_output_chunk", terminalId, data });
            prompt.output.consume({ sessionUpdate: "terminal_update", terminalId, exitStatus: terminal.exitStatus });
          }
        } catch (error) { this.fail(error); }
        finish(terminal.exitStatus);
      });
      this.terminals.set(terminalId, terminal);
      try { if (prompt && this.active === prompt) prompt.output.consume({ sessionUpdate: "terminal_update", terminalId, command: [params.command, ...args].join(" ") }); } catch (error) { this.fail(error); throw error; }
      child.stdin.end();
      return { terminalId };
    }
    if (method.startsWith("terminal/")) {
      const terminal = typeof params.terminalId === "string" ? this.terminals.get(params.terminalId) : undefined;
      if (!terminal || terminal.sessionId !== params.sessionId) throw new AcpError("Unknown ACP terminal.");
      if (method === "terminal/output") {
        const output = Buffer.concat(terminal.output, terminal.bytes); let start = 0;
        while (start < output.length && (output[start]! & 0xc0) === 0x80) start++;
        return { output: output.subarray(start).toString("utf8"), truncated: terminal.truncated, ...(terminal.exitStatus ? { exitStatus: terminal.exitStatus } : {}) };
      }
      if (method === "terminal/wait_for_exit") return terminal.exit;
      if (method === "terminal/kill") { await stopProcess(terminal.child, "SIGKILL"); return {}; }
      if (method === "terminal/release") { await stopProcess(terminal.child, "SIGKILL"); this.terminals.delete(String(params.terminalId)); return {}; }
    }
    throw new AcpError(`ACP client method is unavailable: ${method}.`, -32601);
  }
}

export async function openAcpClient(context: ProviderDriverContext, spawnInput: AcpSpawn, options: AcpClientOptions = {}): Promise<AcpClient> {
  return new AcpClient(context, spawnInput, options);
}
