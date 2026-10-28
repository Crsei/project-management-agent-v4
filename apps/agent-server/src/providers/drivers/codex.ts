// Source: t3code CodexProvider.ts, CodexAdapterV2.ts and generated app-server v2
// schemas. Existing-CLI setup only; managed-host token brokerage is not exposed.
import type { NativeSessionRef, ProviderAuthMethod, ProviderModel } from "@agent-workspace/contracts/provider";
import type { NativeUsageUpdate } from "@agent-workspace/contracts/usage";
import type { NativeProviderAdapter, ProviderDriverContext, ProviderDriverRunOptions } from "../driver-adapter.ts";
import type { CliChatResult, CliTokenUsage } from "../../agents/cli-chat.ts";
import { nativeFailure, validateCodexConfig } from "./codex-config.ts";
import { CodexRpc, object, type CodexRecord } from "./codex-rpc.ts";
import { CodexOutput } from "./codex-output.ts";
import { CodexUsage, codexLimitUpdate } from "./codex-usage.ts";

import { codexProtocolCapabilities } from "../capabilities.ts";
const methods: ProviderAuthMethod[] = [
  { id: "device-code", name: "Sign in with ChatGPT", type: "device-code", description: "Authorize the native Codex CLI with a device code." },
  { id: "browser", name: "ChatGPT browser sign-in", type: "browser" },
  { id: "api-key", name: "Codex API key", type: "credentials", fields: [{ name: "apiKey", label: "OpenAI API key", secret: true }], description: "Native Codex account/login/start API-key authentication; not a standalone model API provider." },
];

export async function runCodexNative(context: ProviderDriverContext, options: ProviderDriverRunOptions): Promise<CliChatResult> {
  if (!options.model.trim()) throw nativeFailure(context, "A native Codex model is required.");
  if (options.signal?.aborted) throw nativeFailure(context, "Request cancelled.", true);
  if (options.resume && (options.resume.driver !== "codex" || options.resume.providerInstanceId !== context.instanceId || (options.resume.instanceRevision !== undefined && options.resume.instanceRevision !== context.revision) || (options.resume.cwd !== undefined && options.resume.cwd !== context.cwd))) throw nativeFailure(context, "Native Codex session belongs to another instance, revision or working directory.");
  const initializing = new AbortController();
  const abortInitialization = () => initializing.abort();
  options.signal?.addEventListener("abort", abortInitialization, { once: true });
  let client: CodexRpc;
  try {
    if (options.signal?.aborted) initializing.abort();
    client = await CodexRpc.open(context, initializing.signal);
  } finally {
    options.signal?.removeEventListener("abort", abortInitialization);
  }
  const terminal = Promise.withResolvers<CliChatResult>();
  // Attach a rejection handler before any awaited RPC can fail/close the channel.
  void terminal.promise.catch(() => undefined);
  let ref: NativeSessionRef | undefined;
  let turnId: string | undefined;
  let text = "";
  let usage: CliTokenUsage | undefined;
  const itemText = new Map<string, string>();
  const telemetry = new CodexUsage(options.model);
  let usageCallbackFailed = false;
  let usageCallbackError: unknown;
  const emitUsage = (update: NativeUsageUpdate | undefined) => {
    if (!update || !options.onUsage) return;
    try { options.onUsage(update); } catch (error) {
      usageCallbackFailed = true; usageCallbackError = error;
      terminal.reject(error);
      client.close(error instanceof Error ? error : new Error("Codex usage callback failed."));
    }
  };
  const output = new CodexOutput(options.onEvent);
  let acceptingInput = true;
  if (options.onRequest) client.onUserInput(async (id, params) => {
    if (!acceptingInput || options.signal?.aborted || !ref || params.threadId !== ref.sessionId || !turnId || params.turnId !== turnId) throw new Error("Codex user input request does not belong to the active turn.");
    const result = await output.userInput(id, params, options.onRequest!);
    if (!acceptingInput || options.signal?.aborted) throw nativeFailure(context, "Codex user input request is no longer active.", options.signal?.aborted);
    return result;
  });
  const publish = () => { if (ref) options.onSession?.(ref); };
  const append = (delta: string) => { if (delta) { text += delta; options.onText?.(delta); } };
  const cancelled = () => nativeFailure(context, "Request cancelled.", true);
  let abortTimer: NodeJS.Timeout | undefined;
  const abort = () => {
    if (abortTimer) return;
    if (ref && turnId) void client.request("turn/interrupt", { threadId: ref.sessionId, turnId }, 1000).catch(() => undefined);
    terminal.reject(cancelled());
    abortTimer = setTimeout(() => client.close(cancelled()), 1200); abortTimer.unref();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const unsubscribeClose = client.onClosed((error) => terminal.reject(error));
  const unsubscribe = client.subscribe((method, params) => {
    if (method === "account/rateLimits/updated") { emitUsage(codexLimitUpdate(params.rateLimits)); return; }
    const scope = method === "$request" ? object(params.params) : params;
    if (!ref || scope.threadId !== ref.sessionId) return;
    const eventTurn = object(params.turn);
    const eventTurnId = typeof params.turnId === "string" ? params.turnId : typeof eventTurn.id === "string" ? eventTurn.id : undefined;
    if (method === "turn/started" && typeof eventTurn.id === "string" && !turnId) { turnId = eventTurn.id; ref = { ...ref, turnId }; publish(); }
    if (turnId && eventTurnId && eventTurnId !== turnId) return;
    if (method === "serverRequest/resolved" && (typeof params.requestId === "string" || typeof params.requestId === "number")) output.expireRequest(params.requestId);
    if (method === "turn/completed") { acceptingInput = false; output.expireRequests(); }
    output.handle(method, params);
    if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
      const key = String(params.itemId ?? ""); itemText.set(key, (itemText.get(key) ?? "") + params.delta); append(params.delta);
    } else if (method === "item/completed") {
      const item = object(params.item);
      if (item.type === "agentMessage" && typeof item.text === "string") {
        const emitted = itemText.get(String(item.id ?? "")) ?? "";
        if (!emitted) append(item.text);
        else if (item.text.startsWith(emitted)) append(item.text.slice(emitted.length));
        else throw nativeFailure(context, "Codex returned assistant text inconsistent with its streamed deltas.");
        itemText.set(String(item.id ?? ""), item.text);
      }
    } else if (method === "thread/tokenUsage/updated") {
      const tokens = object(object(params.tokenUsage).last);
      usage = { ...(typeof tokens.inputTokens === "number" ? { inputTokens: tokens.inputTokens } : {}), ...(typeof tokens.outputTokens === "number" ? { outputTokens: tokens.outputTokens } : {}) };
      emitUsage(telemetry.update(params.tokenUsage));
    } else if (method === "error" && params.willRetry !== true) terminal.reject(nativeFailure(context, object(params.error)));
    else if (method === "turn/completed") {
      if (eventTurn.status !== "completed") terminal.reject(nativeFailure(context, eventTurn.error ?? `Codex turn ended with status ${String(eventTurn.status)}.`, eventTurn.status === "interrupted"));
      else if (!text.trim()) terminal.reject(nativeFailure(context, "Codex completed without returning assistant text."));
      else { ref = { ...ref, ...(eventTurnId ? { turnId: eventTurnId } : {}) }; publish(); terminal.resolve({ text, nativeSession: ref, ...(usage ? { usage } : {}) }); }
    }
  });
  try {
    if (options.signal?.aborted) throw cancelled();
    const thread = await client.request(options.resume ? "thread/resume" : "thread/start", {
      ...(options.resume ? { threadId: options.resume.sessionId, excludeTurns: true } : {}),
      model: options.model, cwd: context.cwd, sandbox: "workspace-write", approvalPolicy: "never", ephemeral: false,
    });
    const id = object(thread.thread).id;
    if (typeof id !== "string" || !id || (options.resume && id !== options.resume.sessionId)) throw nativeFailure(context, "Codex did not confirm the requested native thread.");
    ref = { providerInstanceId: context.instanceId, driver: "codex", sessionId: id, cwd: context.cwd, modelId: options.model, instanceRevision: context.revision };
    publish();
    if (options.signal?.aborted) throw cancelled();
    const started = await client.request("turn/start", { threadId: id, model: options.model, cwd: context.cwd, approvalPolicy: "never", sandboxPolicy: { type: "workspaceWrite", writableRoots: [context.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }, input: [{ type: "text", text: options.prompt, text_elements: [] }] });
    const nativeTurnId = object(started.turn).id;
    if (typeof nativeTurnId !== "string" || !nativeTurnId) throw nativeFailure(context, "Codex did not confirm a native turn ID.");
    if (turnId && turnId !== nativeTurnId) throw nativeFailure(context, "Codex returned inconsistent native turn IDs.");
    turnId = nativeTurnId; ref = { ...ref, turnId }; publish();
    if (options.signal?.aborted) { abort(); throw cancelled(); }
    return await terminal.promise;
  } catch (error) {
    if (usageCallbackFailed) throw usageCallbackError;
    throw error;
  } finally {
    acceptingInput = false;
    try { output.expireRequests(); }
    finally {
      options.signal?.removeEventListener("abort", abort); unsubscribe(); unsubscribeClose();
      if (options.signal?.aborted && turnId && ref) await client.request("turn/interrupt", { threadId: ref.sessionId, turnId }, 1000).catch(() => undefined);
      clearTimeout(abortTimer); client.close();
    }
  }
}

export const codexAdapter: NativeProviderAdapter = {
  definition: {
    driver: "codex", label: "Codex", description: "Native Codex app-server with instance-isolated authentication and resumable sessions.", defaultInstance: true,
    docsUrl: "https://developers.openai.com/codex/cli/", source: "t3code/packages/contracts/src/settings.ts#CodexSettings; apps/server/src/provider/{CodexProvider.ts,Drivers/CodexHomeLayout.ts}; orchestration-v2/Adapters/CodexAdapterV2.ts",
    fields: [
      { key: "binaryPath", label: "Binary path", type: "string", defaultValue: "codex", placeholder: "codex" },
      { key: "homePath", label: "CODEX_HOME path", type: "string", defaultValue: "", description: "Dedicated instance-owned Codex home. Empty uses Agent's isolated home, never the global account." },
      { key: "shadowHomePath", label: "Shadow home path", type: "string", defaultValue: "", description: "Private auth overlay; requires an explicit dedicated shared homePath." },
      { key: "launchArgs", label: "Launch arguments", type: "string", defaultValue: "", description: "Arguments passed to native app-server. Transport, homes and PM sandbox cannot be overridden." },
    ],
  },
  validateConfig: validateCodexConfig,
  async check(context, signal) {
    const checkedAt = new Date().toISOString();
    let client: CodexRpc | undefined;
    try {
      client = await CodexRpc.open(context, signal);
      const initialize = await client.initialized;
      const accountResponse = await client.request("account/read");
      const account = object(accountResponse.account);
      const authenticated = Boolean(account.type) || accountResponse.requiresOpenaiAuth === false;
      const models: ProviderModel[] = [];
      let discoveryError: string | undefined;
      if (authenticated) {
        try {
          let cursor: string | undefined;
          const seen = new Set<string>();
          do {
            const response = await client.request("model/list", cursor ? { cursor } : {});
            if (!Array.isArray(response.data)) throw new Error("Codex model/list returned invalid model data.");
            for (const entry of response.data) {
              const model = object(entry); const id = typeof model.model === "string" ? model.model : model.id;
              if (typeof id === "string" && id && model.hidden !== true && !seen.has(id)) { seen.add(id); models.push({ id, label: typeof model.displayName === "string" ? model.displayName : id, source: "discovered", temperature: false, reasoning: true }); }
            }
            const next = typeof response.nextCursor === "string" && response.nextCursor ? response.nextCursor : undefined;
            if (next && (next === cursor || seen.has(`cursor:${next}`))) throw new Error("Codex model/list repeated a pagination cursor.");
            if (next) seen.add(`cursor:${next}`); cursor = next;
          } while (cursor);
        } catch (error) { discoveryError = nativeFailure(context, error).message; }
      }
      return {
        installation: { status: "installed", checkedAt, executablePath: String(context.config.binaryPath || "codex"), ...(typeof initialize.userAgent === "string" ? { version: initialize.userAgent } : {}) },
        authentication: authenticated ? "authenticated" : "unauthenticated", methods, canLogout: Boolean(account.type) && !context.env.OPENAI_API_KEY, models,
        ...(typeof account.email === "string" ? { email: account.email } : {}),
        ...(account.type ? { authLabel: account.type === "apiKey" ? "Codex API key" : account.type === "chatgpt" ? "ChatGPT" : String(account.type) } : {}),
        ...(discoveryError ? { message: discoveryError } : {}),
        capabilities: await codexProtocolCapabilities(context, signal),
      };
    } catch (error) {
      if (signal?.aborted) throw nativeFailure(context, "Request cancelled.", true);
      const failure = nativeFailure(context, error);
      return { installation: { status: error instanceof Error && "code" in error && error.code === "provider_not_configured" ? "not-installed" : "unknown", checkedAt, error: failure.message }, authentication: "unknown", models: [], methods, canLogout: false, message: failure.message };
    } finally { client?.close(); }
  },
  async authenticate(context, options) {
    const method = options.methodId ?? "device-code";
    if (!methods.some((entry) => entry.id === method)) throw new Error("Unsupported native Codex authentication method.");
    const client = await CodexRpc.open(context, options.signal);
    let loginId: string | undefined;
    let apiKey = options.values?.apiKey;
    const completed = Promise.withResolvers<CodexRecord>();
    void completed.promise.catch(() => undefined);
    const notifications: CodexRecord[] = [];
    const unsubscribe = client.subscribe((name, params) => { if (name === "account/login/completed") { notifications.push(params); if (loginId && params.loginId === loginId) completed.resolve(params); } });
    const unsubscribeClose = client.onClosed((error) => completed.reject(error));
    try {
      if (method === "api-key" && !apiKey) {
        options.onUpdate({ phase: "waiting", interaction: { type: "credentials", id: "api-key", fields: methods[2]!.fields! } });
        const input = await options.readInput();
        try { apiKey = object(JSON.parse(input)).apiKey as string; } catch { throw new Error("API-key credentials must be provided as form values."); }
      }
      if (method === "api-key" && (typeof apiKey !== "string" || !apiKey.trim() || /[\r\n\0]/.test(apiKey))) throw new Error("A valid native Codex API key is required.");
      const result = await client.request("account/login/start", method === "api-key" ? { type: "apiKey", apiKey: apiKey!.trim() } : { type: method === "browser" ? "chatgpt" : "chatgptDeviceCode" });
      if (method !== "api-key") {
        loginId = typeof result.loginId === "string" ? result.loginId : undefined;
        const url = method === "browser" ? result.authUrl : result.verificationUrl;
        if (!loginId || typeof url !== "string" || !url.startsWith("https://")) throw new Error("Codex did not return a valid native sign-in flow.");
        options.onUpdate({ phase: "waiting", interaction: { type: method === "browser" ? "browser" : "device-code", id: loginId, url, ...(typeof result.userCode === "string" ? { userCode: result.userCode } : {}) } });
        const early = notifications.find((entry) => entry.loginId === loginId); if (early) completed.resolve(early);
        const done = await completed.promise;
        if (done.success !== true) throw nativeFailure(context, done.error || "Codex sign-in was not completed.");
      }
      options.onUpdate({ phase: "verifying", interaction: null });
      const observed = await client.request("account/read");
      if (!object(observed.account).type) throw new Error("Codex did not confirm an authenticated native account.");
    } catch (error) {
      throw nativeFailure(apiKey ? { ...context, env: { ...context.env, NATIVE_AUTH_SECRET: apiKey } } : context, error, options.signal.aborted);
    } finally {
      if (options.signal.aborted && loginId) await client.request("account/login/cancel", { loginId }, 1000).catch(() => undefined);
      unsubscribe(); unsubscribeClose(); client.close();
    }
  },
  async logout(context, signal) {
    const client = await CodexRpc.open(context, signal);
    try { await client.request("account/logout"); const observed = await client.request("account/read"); if (object(observed.account).type) throw new Error("Codex still reports an authenticated account after logout."); } finally { client.close(); }
  },
  run: runCodexNative,
};
