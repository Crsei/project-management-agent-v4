// Ported from t3code packages/provider-cursor/src (MIT). Cursor v2 is an SDK
// provider, not the retired cursor-agent CLI integration.
import path from "node:path";
import type { NativeSessionRef, ProviderAuthMethod, ProviderConfig, ProviderModel } from "@agent-workspace/contracts/provider";
import type { SDKModel } from "@cursor/sdk";
import { CliChatError } from "../../agents/cli-chat.ts";
import type { NativeProviderAdapter, ProviderDriverContext, ProviderDriverStatus } from "../driver-adapter.ts";
import { clearCursorCredentials, parseCursorCredentials, readCursorCredentials, saveCursorCredentials } from "./cursor-credentials.ts";
import { cursorPrivateError, CursorWorkerError, invokeCursorWorker } from "./cursor-process.ts";
import type { CursorInvoker } from "./cursor-process.ts";
import { cursorAbortError } from "./cursor-sdk.ts";

const BROWSER_METHOD: ProviderAuthMethod = {
  id: "browser",
  name: "Sign in with Cursor",
  type: "browser",
  description: "Sign in on the Cursor website. A private, expiring SDK key is stored only for this provider.",
};
const CAPABILITIES = {
  nativeResume: true,
  nativeFork: false,
  boundedFork: false,
  modelTransition: "native" as const,
  portableHandoff: true as const,
};

type Access = { controller: AbortController; done: Promise<void> };
type Operation = { kind: "login" | "logout"; controller: AbortController; done: Promise<void> };
type InstanceState = { accesses: Set<Access>; operation?: Operation };

export function buildCursorDiscoveredModels(models: readonly SDKModel[]): ProviderModel[] {
  const seen = new Set<string>();
  return models.flatMap((model) => {
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    const label = typeof model?.displayName === "string" ? model.displayName.trim() : "";
    if (!id || !label || seen.has(id)) return [];
    seen.add(id);
    return [{
      id,
      label,
      source: "discovered" as const,
      temperature: false,
      ...(model.parameters?.some((parameter) => ["thinking", "reasoning", "effort"].includes(parameter.id)) ? { reasoning: true } : {}),
    }];
  });
}

/** Injection is the controlled-protocol test seam; production always uses SDK IPC. */
export function createCursorAdapter(invoke: CursorInvoker = invokeCursorWorker): NativeProviderAdapter {
  const states = new Map<string, InstanceState>();
  const stateFor = (context: ProviderDriverContext): InstanceState => {
    let state = states.get(context.instanceId);
    if (!state) { state = { accesses: new Set() }; states.set(context.instanceId, state); }
    return state;
  };
  const withAccess = async <T>(context: ProviderDriverContext, signal: AbortSignal | undefined, task: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    signal?.throwIfAborted();
    const state = stateFor(context);
    if (state.operation) throw new Error("Cursor sign-in or sign-out is in progress. Try again after it finishes.");
    const controller = new AbortController();
    const done = Promise.withResolvers<void>();
    const access = { controller, done: done.promise };
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    state.accesses.add(access);
    try { return await task(controller.signal); }
    finally {
      state.accesses.delete(access);
      signal?.removeEventListener("abort", abort);
      done.resolve();
    }
  };
  const stopAccesses = async (state: InstanceState): Promise<void> => {
    const accesses = [...state.accesses];
    for (const access of accesses) access.controller.abort();
    await Promise.all(accesses.map((access) => access.done));
  };

  return {
    definition: {
      driver: "cursor",
      label: "Cursor",
      description: "Native Cursor Agent SDK. Sign in with Cursor, or set the private CURSOR_API_KEY environment override for this instance.",
      defaultInstance: false,
      // The source schema has no active SDK settings. Enabled/custom models are
      // instance-level; binaryPath/apiEndpoint are hidden V1 preservation only.
      fields: [],
      docsUrl: "https://cursor.com/docs/agents/sdk",
      source: "t3code/packages/provider-cursor (@cursor/sdk 1.0.35)",
    },
    validateConfig(config: ProviderConfig): ProviderConfig {
      const result: ProviderConfig = {};
      for (const [key, value] of Object.entries(config)) {
        if (key !== "binaryPath" && key !== "apiEndpoint") throw new Error(`Unsupported Cursor setting: ${key}.`);
        if (typeof value !== "string" || !value.trim() || value.includes("\0"))
          throw new Error(`Cursor ${key} must be a nonempty string.`);
        result[key] = value.trim();
      }
      return result;
    },
    async check(context, signal): Promise<ProviderDriverStatus> {
      const checkedAt = new Date().toISOString();
      const configuredKey = context.env.CURSOR_API_KEY?.trim();
      const methods = configuredKey ? [] : [BROWSER_METHOD];
      if (stateFor(context).operation) return {
        installation: { status: "unknown", checkedAt },
        authentication: "unknown", models: [], methods, canLogout: false,
        capabilities: CAPABILITIES,
        message: "Cursor sign-in or sign-out is in progress.",
      };
      let canLogout = false;
      try {
        const credentials = configuredKey ? undefined : readCursorCredentials(context.homeDirectory);
        canLogout = !!credentials;
        const apiKey = configuredKey || (credentials &&
          (credentials.apiKeyExpiresAtMs === undefined || credentials.apiKeyExpiresAtMs > Date.now()) ? credentials.apiKey : undefined);
        const result = await withAccess(context, signal, (accessSignal) => invoke(context, {
          operation: "check", ...(apiKey ? { apiKey } : {}),
        }, { signal: accessSignal, timeoutMs: 15_000 }));
        if (result.operation !== "check" || !Array.isArray(result.models)) throw new Error("Cursor returned an invalid catalog response.");
        const models = buildCursorDiscoveredModels(result.models);
        if (!apiKey || !result.user) return {
          installation: { status: "installed", checkedAt },
          authentication: "unauthenticated", models: [], methods, canLogout,
          capabilities: CAPABILITIES,
          message: "Sign in with Cursor or add CURSOR_API_KEY in provider settings.",
        };
        const email = result.user.userEmail?.trim();
        const keyName = result.user.apiKeyName?.trim();
        return {
          installation: { status: "installed", checkedAt },
          authentication: "authenticated",
          authLabel: configuredKey ? (keyName ? `Cursor API key (${keyName})` : "Cursor API key") : "Cursor account",
          ...(email ? { email } : {}),
          models, methods, canLogout: !configuredKey && canLogout,
          capabilities: CAPABILITIES,
          ...(models.length === 0 ? { message: "Cursor SDK model discovery returned no built-in models." } : {}),
        };
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw cursorAbortError();
        const authenticationFailure = error instanceof CursorWorkerError && (error.name === "AuthenticationError" || error.status === 401);
        const missing = error instanceof CursorWorkerError && error.dependencyMissing;
        const planRequired = error instanceof CursorWorkerError && error.code === "plan_required";
        return {
          installation: { status: missing ? "not-installed" : error instanceof CursorWorkerError && error.sdkLoaded ? "installed" : "unknown", checkedAt, ...(missing ? { error: "The Cursor SDK or its native platform package is not installed." } : {}) },
          authentication: authenticationFailure ? "unauthenticated" : "unknown",
          models: [], methods, canLogout: !configuredKey && canLogout,
          capabilities: CAPABILITIES,
          message: missing ? "Install @cursor/sdk 1.0.35 with its optional native platform package." :
            authenticationFailure ? (configuredKey ? "Cursor SDK authentication failed. Check CURSOR_API_KEY." : "Cursor sign-in expired or was rejected. Sign in again.") :
            planRequired ? "Cursor needs a paid plan. Upgrade the account or sign in with a different one." : cursorPrivateError(error, context),
        };
      }
    },
    async authenticate(context, options): Promise<void> {
      options.signal.throwIfAborted();
      if (context.env.CURSOR_API_KEY?.trim()) throw new Error("Remove CURSOR_API_KEY from this provider's environment before using browser sign-in.");
      if (options.methodId && options.methodId !== "browser") throw new Error("Cursor supports browser sign-in; API keys are configured in the provider environment.");
      const state = stateFor(context);
      if (state.operation) throw new Error("Cursor setup is already in progress.");
      const done = Promise.withResolvers<void>();
      const controller = new AbortController();
      const operation: Operation = { kind: "login", controller, done: done.promise };
      state.operation = operation;
      const abort = () => controller.abort();
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) controller.abort();
      try {
        await stopAccesses(state);
        controller.signal.throwIfAborted();
        const result = await invoke(context, { operation: "login", name: `Agent PM Studio - ${context.instanceId}` }, {
          signal: controller.signal,
          timeoutMs: 300_000,
          onEvent(event) {
            if (event.type !== "login-url") throw new Error("Unexpected Cursor sign-in event.");
            const url = new URL(event.url);
            if (url.username || url.password ||
                !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
              throw new Error("Cursor returned an unsafe sign-in URL.");
            options.onUpdate({ phase: "waiting", interaction: { type: "browser", id: "cursor-browser", url: url.href },
              message: "Open the Cursor sign-in page and finish signing in. This page updates automatically." });
          },
        });
        controller.signal.throwIfAborted();
        if (state.operation !== operation) throw cursorAbortError();
        if (result.operation !== "login") throw new Error("Cursor returned an invalid sign-in result.");
        const credentials = parseCursorCredentials(result.credentials);
        if (!credentials || (credentials.apiKeyExpiresAtMs !== undefined && credentials.apiKeyExpiresAtMs <= Date.now()))
          throw new Error("Cursor did not return valid, unexpired sign-in credentials.");
        options.onUpdate({ phase: "verifying", interaction: null, message: "Saving verified Cursor sign-in." });
        controller.signal.throwIfAborted();
        // The worker verified both account identity and native model catalog.
        saveCursorCredentials(context.homeDirectory, credentials);
      } catch (error) {
        if (controller.signal.aborted) throw cursorAbortError();
        throw new Error(cursorPrivateError(error, context));
      } finally {
        options.signal.removeEventListener("abort", abort);
        if (state.operation === operation) state.operation = undefined;
        done.resolve();
      }
    },
    async logout(context, signal): Promise<void> {
      signal?.throwIfAborted();
      if (context.env.CURSOR_API_KEY?.trim()) throw new Error("Remove CURSOR_API_KEY from this provider's environment to disconnect it.");
      const state = stateFor(context);
      if (state.operation?.kind === "logout") throw new Error("Cursor sign-out is already in progress.");
      const previous = state.operation;
      const done = Promise.withResolvers<void>();
      const operation: Operation = { kind: "logout", controller: new AbortController(), done: done.promise };
      state.operation = operation;
      try {
        previous?.controller.abort();
        await Promise.all([stopAccesses(state), previous?.done]);
        signal?.throwIfAborted();
        clearCursorCredentials(context.homeDirectory);
      } finally {
        if (state.operation === operation) state.operation = undefined;
        done.resolve();
      }
    },
    async run(context, options) {
      const resume = options.resume;
      const model = options.model.trim();
      if (resume && (resume.driver !== "cursor" || resume.providerInstanceId !== context.instanceId || !resume.sessionId ||
          (resume.cwd !== undefined && resume.cwd !== context.cwd) ||
          (resume.instanceRevision !== undefined && resume.instanceRevision !== context.revision)))
        throw new CliChatError("provider_error", "The Cursor session does not belong to this provider, workspace, or configuration revision.", undefined, context.instanceId);
      if (!model) throw new CliChatError("provider_error", "Choose a Cursor model.", undefined, context.instanceId);
      let usageFailure: unknown;
      let usageFailed = false;
      try {
        return await withAccess(context, options.signal, async (signal) => {
          const configuredKey = context.env.CURSOR_API_KEY?.trim();
          const credentials = configuredKey ? undefined : readCursorCredentials(context.homeDirectory);
          const apiKey = configuredKey || (credentials &&
            (credentials.apiKeyExpiresAtMs === undefined || credentials.apiKeyExpiresAtMs > Date.now()) ? credentials.apiKey : undefined);
          if (!apiKey) throw new CliChatError("provider_not_authenticated", "Sign in with Cursor or add CURSOR_API_KEY in provider settings.", undefined, context.instanceId);
          let nativeSession: NativeSessionRef | undefined;
          const result = await invoke(context, {
            operation: "run", apiKey,
            model, prompt: options.prompt,
            cwd: context.cwd, stateRoot: path.join(context.homeDirectory, ".cursor", "sdk", "state"),
            ...(resume ? { sessionId: resume.sessionId } : {}),
          }, {
            signal,
            onEvent(event) {
              if (event.type === "text") options.onText?.(event.text);
              else if (event.type === "output") options.onEvent?.(event.event);
              else if (event.type === "usage") {
                try { options.onUsage?.(event.update); } catch (error) {
                  usageFailed = true;
                  usageFailure = error;
                  throw error;
                }
              }
              else if (event.type === "session") {
                nativeSession = {
                  driver: "cursor", providerInstanceId: context.instanceId,
                  sessionId: event.sessionId, ...(event.turnId ? { turnId: event.turnId } : {}),
                  modelId: model, cwd: context.cwd, instanceRevision: context.revision,
                };
                options.onSession?.(nativeSession);
              } else throw new Error("Unexpected Cursor execution event.");
            },
          });
          signal.throwIfAborted();
          if (result.operation !== "run" || result.result.status !== "finished" || typeof result.text !== "string")
            throw new Error("Cursor did not report a successful terminal run.");
          if (!nativeSession || nativeSession.sessionId !== result.sessionId) throw new Error("Cursor returned an inconsistent native session.");
          return {
            text: result.text,
            ...(result.result.usage ? { usage: { inputTokens: result.result.usage.inputTokens, outputTokens: result.result.usage.outputTokens } } : {}),
            nativeSession,
          };
        });
      } catch (error) {
        if (usageFailed) throw usageFailure;
        if (error instanceof CliChatError) throw error;
        if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError"))
          throw new CliChatError("aborted", "Cursor request was cancelled.", { code: "aborted" }, context.instanceId);
        const authenticationFailure = error instanceof CursorWorkerError && (error.name === "AuthenticationError" || error.status === 401);
        throw new CliChatError(authenticationFailure ? "provider_not_authenticated" : "provider_error",
          cursorPrivateError(error, context), authenticationFailure ? { errorClass: "authentication" } : error, context.instanceId);
      }
    },
  };
}

export const cursorAdapter: NativeProviderAdapter = createCursorAdapter();
