// Native SDK mechanisms ported from t3code packages/provider-cursor (MIT):
// CursorSdkCatalog.ts, CursorAgentSdk.ts, adapter.ts, auth.ts, transportFailure.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import type { AgentOptions, Run, RunResult, SDKAgent, SDKModel, SDKUser, StoredSdkCredentials } from "@cursor/sdk";
import type { NativeOutputEvent } from "@agent-workspace/contracts/output";
import { CursorOutput } from "./cursor-output.ts";
import type * as CursorSdk from "@cursor/sdk";
import type * as CursorSqlite from "@cursor/sdk/sqlite";
import type { SqliteLocalAgentStore } from "@cursor/sdk/sqlite";
import type { NativeUsageUpdate, UsageTokenTotals } from "@agent-workspace/contracts/usage";
import { ReportedTurnAccumulator } from "./reported-turn.ts";

export type CursorSdkModule = Pick<typeof CursorSdk, "Agent" | "Cursor" | "InMemoryCredentialStore">;
export type CursorSqliteModule = Pick<typeof CursorSqlite, "SqliteLocalAgentStore">;

export type CursorRequest =
  | { operation: "check"; apiKey?: string }
  | { operation: "login"; name: string }
  | { operation: "run"; apiKey: string; model: string; prompt: string; cwd: string; stateRoot: string; sessionId?: string };
export type CursorEvent =
  | { type: "login-url"; url: string }
  | { type: "text"; text: string }
  | { type: "output"; event: NativeOutputEvent }
  | { type: "session"; sessionId: string; turnId?: string }
  | { type: "usage"; update: NativeUsageUpdate };
export type CursorResult =
  | { operation: "check"; user?: SDKUser; models: SDKModel[] }
  | { operation: "login"; credentials: StoredSdkCredentials }
  | { operation: "run"; sessionId: string; text: string; result: RunResult };
export type CursorSerializedError = {
  name: string;
  message: string;
  code?: string;
  status?: number;
  dependencyMissing?: boolean;
  sdkLoaded?: boolean;
};
export type CursorWorkerMessage =
  | { type: "event"; event: CursorEvent }
  | { type: "result"; result: CursorResult }
  | { type: "error"; error: CursorSerializedError };

export function cursorAbortError(): Error {
  return Object.assign(new Error("Cursor request was cancelled."), { name: "AbortError", code: "aborted" });
}

export function serializeCursorError(error: unknown): CursorSerializedError {
  const record = typeof error === "object" && error !== null ? error as Record<string, unknown> : {};
  return {
    name: typeof record.name === "string" ? record.name : "Error",
    message: typeof record.message === "string" ? record.message : "Cursor SDK request failed.",
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    ...(typeof record.status === "number" ? { status: record.status } : {}),
    ...((record.code === "MODULE_NOT_FOUND" || record.code === "ERR_MODULE_NOT_FOUND") ? { dependencyMissing: true } : {}),
  };
}

/** Only an entire assistant message consisting of a transport dump is failure. */
export class CursorTransportFailure {
  private state = { disqualified: false, failure: undefined as string | undefined };
  private line = "";

  private consume(state: typeof this.state, line: string): void {
    if (state.disqualified) return;
    const text = line.trimEnd();
    if (/^Error: (?:RetriableError: (?!\[internal\]).+|ConnectError: \[(?:unavailable|aborted|deadline_exceeded)\].*)$/.test(text) ||
        text === "Something went wrong communicating with the server. Please try again.") {
      state.failure = text;
    } else if (text.trim() !== "" && !(state.failure && /^\s+at\s/.test(text))) {
      state.disqualified = true;
      state.failure = undefined;
    }
  }

  push(text: string): void {
    for (const [index, part] of text.split("\n").entries()) {
      if (this.state.disqualified) return;
      if (index > 0) {
        this.consume(this.state, this.line);
        this.line = "";
      }
      if (this.line.length + part.length > 4096) {
        this.state.disqualified = true;
        this.state.failure = undefined;
        this.line = "";
        return;
      }
      this.line += part;
    }
  }

  get failure(): string | undefined {
    const state = { ...this.state };
    this.consume(state, this.line);
    return state.failure;
  }
}

function isCancellation(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    if (Reflect.get(current, "name") === "AbortError") return true;
    seen.add(current);
    current = Reflect.get(current, "cause");
  }
  return false;
}

async function readCatalog(sdk: CursorSdkModule, apiKey: string): Promise<{ user: SDKUser; models: SDKModel[] }> {
  const [user, models] = await Promise.all([sdk.Cursor.me({ apiKey }), sdk.Cursor.models.list({ apiKey })]);
  return { user, models };
}

// Cursor reports disjoint input, cache-read and cache-write counts for each
// internal turn; run.wait() reports their cumulative sum for the whole run.
function cursorTotals(value: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens?: number }): UsageTokenTotals | undefined {
  const counts = [value.inputTokens, value.outputTokens, value.cacheReadTokens, value.cacheWriteTokens, value.reasoningTokens];
  if (!counts.every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0) || counts[4]! > counts[1]!) return undefined;
  return {
    uncachedInputTokens: counts[0]!, cachedInputTokens: counts[2]!, cacheCreationTokens: counts[3]!,
    outputTokens: counts[1]!, reasoningTokens: counts[4]!,
  };
}

/** Runs only in an instance-isolated child; never changes the server environment. */
export async function executeCursorSdk(
  sdk: CursorSdkModule,
  loadSqlite: () => CursorSqliteModule,
  request: CursorRequest,
  signal: AbortSignal,
  emit: (event: CursorEvent) => Promise<void>,
): Promise<CursorResult> {
  signal.throwIfAborted();
  if (request.operation === "check") {
    if (!request.apiKey) return { operation: "check", models: [] };
    const catalog = await readCatalog(sdk, request.apiKey);
    signal.throwIfAborted();
    return { operation: "check", ...catalog };
  }
  if (request.operation === "login") {
    // Never give the SDK a persistent store: a cancelled late result cannot save.
    const pending = new sdk.InMemoryCredentialStore();
    let urlFailure: unknown;
    let urlCallbacks = Promise.resolve();
    await sdk.Cursor.auth.login({
      openBrowser: false,
      store: pending,
      signal,
      apiKeyName: request.name,
      onLoginUrl: (url) => {
        urlCallbacks = urlCallbacks.then(() => emit({ type: "login-url", url })).catch((error: unknown) => { urlFailure ??= error; });
      },
    });
    await urlCallbacks;
    signal.throwIfAborted();
    if (urlFailure) throw urlFailure;
    const credentials = await pending.load();
    if (!credentials || (credentials.apiKeyExpiresAtMs !== undefined && credentials.apiKeyExpiresAtMs <= Date.now()))
      throw new Error("Cursor login did not return valid, unexpired credentials.");
    await readCatalog(sdk, credentials.apiKey);
    signal.throwIfAborted();
    return { operation: "login", credentials };
  }

  let store: SqliteLocalAgentStore | undefined;
  let agent: SDKAgent | undefined;
  let run: Run | undefined;
  let cancel: Promise<void> | undefined;
  let callbackChain = Promise.resolve();
  let callbackFailure: unknown;
  let callbackFailed = false;
  let text = "";
  let inAssistantMessage = false;
  let reply = new CursorTransportFailure();
  const outputEvents: NativeOutputEvent[] = [];
  let totals: UsageTokenTotals | undefined;
  const reportedTotals = new ReportedTurnAccumulator();
  let totalsComplete = true;
  const output = new CursorOutput((event) => outputEvents.push(event));
  const flushOutput = async () => {
    for (const event of outputEvents.splice(0)) await emit({ type: "output", event });
  };
  const cancelRun = (): Promise<void> => {
    if (!run) return Promise.resolve();
    cancel ??= run.cancel().catch((error: unknown) => { if (!isCancellation(error)) throw error; });
    // The abort event cannot await, but the finally block observes this promise.
    void cancel.catch(() => undefined);
    return cancel;
  };
  const abort = () => { void cancelRun(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    store = await loadSqlite().SqliteLocalAgentStore.open({ workspaceRef: request.cwd, stateRoot: request.stateRoot });
    signal.throwIfAborted();
    const model = { id: request.model === "auto" ? "default" : request.model };
    const options: AgentOptions = {
      apiKey: request.apiKey,
      model,
      mode: "agent",
      name: "Agent PM Studio",
      local: {
        cwd: request.cwd,
        store,
        autoReview: true,
        settingSources: ["project", "user", "team", "mdm", "plugins"],
        // Match t3code's default auto policy. Never fall back to full access.
        sandboxOptions: { enabled: process.platform !== "win32" },
        enableAgentRetries: true,
      },
    };
    agent = request.sessionId
      ? await sdk.Agent.resume(request.sessionId, options)
      : await sdk.Agent.create(options);
    signal.throwIfAborted();
    await emit({ type: "session", sessionId: agent.agentId });
    const send = () => agent!.send(request.prompt, {
      model,
      mode: "agent",
      onDelta: ({ update }) => {
        callbackChain = callbackChain.then(async () => {
          if (callbackFailed || signal.aborted) return;
          output.update(update);
          await flushOutput();
          if (update.type === "turn-ended" && update.usage) {
            const usage = update.usage;
            const reportedTurn = reportedTotals.add(usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.reasoningTokens);
            const next = cursorTotals(usage);
            if (!next) totalsComplete = false;
            if (next && totalsComplete) {
              const combined = totals ? {
                uncachedInputTokens: totals.uncachedInputTokens + next.uncachedInputTokens,
                cachedInputTokens: totals.cachedInputTokens + next.cachedInputTokens,
                cacheCreationTokens: totals.cacheCreationTokens + next.cacheCreationTokens,
                outputTokens: totals.outputTokens + next.outputTokens,
                reasoningTokens: totals.reasoningTokens + next.reasoningTokens,
              } : next;
              if (Object.values(combined).every(Number.isSafeInteger)) totals = combined;
              else totalsComplete = false;
            }
            const turn = totalsComplete && totals ? { totals } : undefined;
            if (turn || reportedTurn) await emit({ type: "usage", update: { ...(turn ? { turn } : {}), ...(reportedTurn ? { reportedTurn } : {}) } });
          }
          if (update.type === "text-delta") {
            if (!inAssistantMessage) reply = new CursorTransportFailure();
            inAssistantMessage = true;
            reply.push(update.text);
            text += update.text;
            await emit({ type: "text", text: update.text });
          } else if (update.type === "thinking-delta" || update.type === "tool-call-started" ||
              update.type === "partial-tool-call" || update.type === "tool-call-completed" ||
              update.type === "step-completed" || update.type === "turn-ended") {
            inAssistantMessage = false;
          }
        }).catch((error: unknown) => { if (!callbackFailed) { callbackFailed = true; callbackFailure = error; } });
        return callbackChain;
      },
    });
    try {
      run = await send();
    } catch (error) {
      // Source recovery: only a resumed agent may contain an abandoned local run.
      if (!request.sessionId || !(error instanceof Error) || !/already has active run/i.test(error.message)) throw error;
      signal.throwIfAborted();
      const runOptions = { runtime: "local" as const, cwd: request.cwd, store };
      const latest = await sdk.Agent.listRuns(agent.agentId, { ...runOptions, limit: 1 });
      const active = latest.items.find((candidate) => candidate.status === "running");
      if (!active) throw error;
      await sdk.Agent.cancelRun(active.id, runOptions);
      signal.throwIfAborted();
      run = await send();
    }
    if (signal.aborted) {
      await cancelRun();
      throw cursorAbortError();
    }
    await emit({ type: "session", sessionId: agent.agentId, turnId: run.id });
    const result = await run.wait();
    await callbackChain;
    signal.throwIfAborted();
    if (callbackFailed) throw callbackFailure;
    if (result.status === "cancelled") throw cursorAbortError();
    if (result.status !== "finished") {
      throw Object.assign(new Error(result.error?.message || "Cursor run did not finish successfully."), {
        code: result.error?.code || "provider_error",
      });
    }
    if (result.usage) {
      const usage = result.usage;
      const finalTotals = cursorTotals(usage);
      const reportedTurn = new ReportedTurnAccumulator().add(usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.reasoningTokens);
      const turn = finalTotals ? { totals: finalTotals, ...(result.model?.id ? { model: result.model.id } : {}) } : undefined;
      if (turn || reportedTurn) await emit({ type: "usage", update: { ...(turn ? { turn } : {}), ...(reportedTurn ? { reportedTurn } : {}) } });
    }
    if (!text && result.result) {
      text = result.result;
      reply.push(text);
      output.update({ type: "text-delta", text });
      await flushOutput();
      await emit({ type: "text", text });
    }
    if (reply.failure) throw new Error(reply.failure);
    output.finish();
    await flushOutput();
    return { operation: "run", sessionId: agent.agentId, text, result };
  } finally {
    signal.removeEventListener("abort", abort);
    try {
      if (run?.status === "running") await cancelRun();
      else if (cancel) await cancel;
    } finally {
      try { await agent?.[Symbol.asyncDispose](); } finally { await store?.dispose(); }
    }
  }
}
