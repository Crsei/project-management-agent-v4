// Native ACP integration ported from t3code provider/Drivers/AntigravityDriver.ts,
// AntigravityAuth.ts, AntigravityProvider.ts and acp/AntigravityAcpSupport.ts (MIT).
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { NativeSessionRef, ProviderAuthMethod, ProviderModel } from "@agent-workspace/contracts/provider";
import type { NativeProviderAdapter, ProviderDriverAuthOptions, ProviderDriverContext } from "../driver-adapter.ts";
import { CliChatError, sanitizeErrorMessage } from "../../agents/cli-chat.ts";
import { AcpClient, AcpError, acpModelOption, acpRecord, isAcpAuthenticationRequired, openAcpClient } from "./acp.ts";
import {
  ANTIGRAVITY_DEFAULT_MODEL, ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
  antigravityAuthConfigIssue, antigravityAuthLabel, antigravityAuthMethods, antigravityAuthUsesBrowser,
  buildAntigravityAcpSpawnInput, forwardAntigravityCallback, makeAntigravityAuthHandlers,
  prepareAntigravityProfile, removeAntigravitySessionFiles, validateAntigravityCallbackUrl,
  validateAntigravityConfig, type AntigravityAuthorization, type AntigravitySettings,
} from "./antigravity-auth.ts";
import { installAntigravityRuntime, resolveAntigravityInstallation, type AntigravityExecutable } from "./antigravity-installation.ts";
import { handleAntigravityClientRequest } from "./antigravity-files.ts";

type Observation = { revision: number; authentication: "authenticated" | "unauthenticated"; models: ProviderModel[]; canLogout: boolean; version?: string };
type InstanceState = { exclusive: boolean; active: Map<AbortController, Promise<void>>; sweep?: Promise<void>; observation?: Observation };
const instances = new Map<string, InstanceState>();
const defaultModel: ProviderModel = { id: ANTIGRAVITY_DEFAULT_MODEL, label: "Antigravity account default", source: "builtin", temperature: false };
const capabilities = { nativeResume: true, nativeFork: false, boundedFork: false, modelTransition: "native", portableHandoff: true } as const;

function stateFor(context: ProviderDriverContext): InstanceState {
  let state = instances.get(context.homeDirectory);
  if (!state) { state = { exclusive: false, active: new Map() }; instances.set(context.homeDirectory, state); }
  return state;
}
function authMethods(config: AntigravitySettings): ProviderAuthMethod[] {
  return [{ id: config.authMethod, name: antigravityAuthLabel(config.authMethod), type: antigravityAuthUsesBrowser(config.authMethod) ? "browser" : "terminal", description: antigravityAuthUsesBrowser(config.authMethod) ? "Sign in with Google; remote clients can paste the complete redirect URL." : "Verify the native credentials configured in this provider's settings." }];
}
export function buildAntigravityModelsFromSession(setup: Record<string, unknown>): ProviderModel[] {
  const config = acpModelOption(setup.configOptions);
  const entries: Record<string, unknown>[] = [];
  if (config?.type === "select" && Array.isArray(config.options)) {
    for (const value of config.options) {
      const option = acpRecord(value);
      if ("value" in option) entries.push(option);
      else if (Array.isArray(option.options)) entries.push(...option.options.map(acpRecord));
    }
  } else if (!config) {
    const models = acpRecord(setup.models);
    if (Array.isArray(models.availableModels)) for (const value of models.availableModels) { const model = acpRecord(value); entries.push({ value: model.modelId, name: model.name }); }
  }
  const seen = new Set<string>();
  return entries.flatMap((entry): ProviderModel[] => {
    if (typeof entry.value !== "string" || !entry.value.trim() || seen.has(entry.value)) return [];
    seen.add(entry.value);
    return [{ id: entry.value, label: typeof entry.name === "string" && entry.name.trim() ? entry.name : entry.value, source: "discovered", temperature: false }];
  });
}
function observe(context: ProviderDriverContext, runtime: AcpClient): void {
  const version = acpRecord(runtime.initialized.agentInfo).version;
  stateFor(context).observation = {
    revision: context.revision, authentication: "authenticated", models: buildAntigravityModelsFromSession(runtime.sessionSetup),
    canLogout: Boolean(acpRecord(acpRecord(runtime.initialized.agentCapabilities).auth).logout),
    ...(typeof version === "string" ? { version } : {}),
  };
}
function markAuthenticationFailure(context: ProviderDriverContext, error: unknown): void {
  if (isAcpAuthenticationRequired(error) || (error instanceof Error && error.message === ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE)) {
    const state = stateFor(context);
    state.observation = { revision: context.revision, authentication: "unauthenticated", models: [], canLogout: state.observation?.canLogout ?? false };
  }
}
async function startAntigravitySession(runtime: AcpClient, method: string, sessionId?: string): Promise<void> {
  // Antigravity accepts native key/Vertex methods it does not advertise in initialize.
  await runtime.authenticate(method);
  try { await runtime.start(sessionId); }
  catch (error) {
    if (!isAcpAuthenticationRequired(error)) throw error;
    // The source ACP runtime reauthenticates once if setup itself reports auth-required.
    await runtime.authenticate(method); await runtime.start(sessionId);
  }
}
async function withExclusive<T>(context: ProviderDriverContext, task: () => Promise<T>): Promise<T> {
  const state = stateFor(context);
  if (state.exclusive) throw new Error("Antigravity setup is already in progress.");
  state.exclusive = true;
  try {
    const operations = [...state.active.entries()];
    for (const [controller] of operations) controller.abort(new DOMException("Antigravity session stopped for account setup.", "AbortError"));
    await Promise.all(operations.map(([, done]) => done));
    return await task();
  } finally { state.exclusive = false; }
}
async function withRuntime<T>(context: ProviderDriverContext, signal: AbortSignal | undefined, task: (runtime: AcpClient, detachStartupAbort: () => void) => Promise<T>, options: { exclusive?: boolean; disposable?: boolean; onAuthorizationUrl?: (authorization: AntigravityAuthorization) => void; installation?: AntigravityExecutable; initializeOnly?: boolean } = {}): Promise<T> {
  const state = stateFor(context);
  if (state.exclusive && !options.exclusive) throw new Error("Antigravity sign-in or sign-out is in progress. Try again after it finishes.");
  const controller = new AbortController(); const done = Promise.withResolvers<void>(); state.active.set(controller, done.promise);
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  let runtime: AcpClient | undefined; let runtimeTemp: string | undefined; let workspace: string | undefined;
  try {
    controller.signal.throwIfAborted();
    const config = validateAntigravityConfig(context.config);
    const issue = options.initializeOnly ? null : antigravityAuthConfigIssue(config); if (issue) throw new Error(issue);
    const installation = options.installation ?? await resolveAntigravityInstallation(context, config.binaryPath);
    const profile = await prepareAntigravityProfile(context, config, controller.signal);
    // Only the first runtime in this server lifetime sweeps abandoned unpack directories.
    // Sharing the promise prevents concurrent sessions from sweeping each other's new files.
    state.sweep ??= rm(profile.tempDirectory, { recursive: true, force: true }).catch(() => {}).then(() => mkdir(profile.tempDirectory, { recursive: true, mode: 0o700 })).then(() => undefined);
    await state.sweep;
    runtimeTemp = await mkdtemp(join(profile.tempDirectory, "run-"));
    if (options.disposable) workspace = await mkdtemp(join(profile.acpDirectory, "setup-"));
    controller.signal.throwIfAborted();
    const spawn = buildAntigravityAcpSpawnInput(context, installation, profile, config, runtimeTemp);
    const processContext = { ...context, cwd: workspace ?? context.cwd, env: spawn.env };
    const clientFileSystem = !options.disposable && !options.initializeOnly;
    runtime = await openAcpClient(processContext, spawn, {
      signal: controller.signal, resumeMethod: "resume", clientCapabilities: { fs: { readTextFile: clientFileSystem, writeTextFile: clientFileSystem }, terminal: false },
      ...(clientFileSystem ? { onRequest: (method: string, params: Record<string, unknown>) => handleAntigravityClientRequest(method, params, context.cwd, runtime?.sessionId ?? "") } : {}),
      ...makeAntigravityAuthHandlers(options.onAuthorizationUrl),
    });
    return await task(runtime, () => signal?.removeEventListener("abort", abort));
  } catch (error) { markAuthenticationFailure(context, error); throw error; }
  finally {
    signal?.removeEventListener("abort", abort);
    try {
      if (runtime) { runtime.close(); await runtime.waitForClose(); }
      if (workspace) { await removeAntigravitySessionFiles(context.homeDirectory, runtime?.sessionId, workspace); await rm(workspace, { recursive: true, force: true }).catch(() => {}); }
      if (runtimeTemp) await rm(runtimeTemp, { recursive: true, force: true }).catch(() => {});
    } finally { state.active.delete(controller); done.resolve(); }
  }
}
async function authenticate(context: ProviderDriverContext, options: ProviderDriverAuthOptions): Promise<void> {
  const config = validateAntigravityConfig(context.config);
  if (options.methodId && options.methodId !== config.authMethod) throw new Error("Select the Antigravity sign-in method in provider settings before connecting.");
  const issue = antigravityAuthConfigIssue(config); if (issue) throw new Error(issue);
  const finished = new AbortController();
  const signal = AbortSignal.any([options.signal, finished.signal, AbortSignal.timeout(300_000)]);
  const failures = Promise.withResolvers<never>();
  let pending: AntigravityAuthorization | undefined; let callbackSent = false;
  const receiveAuthorization = (authorization: AntigravityAuthorization) => {
    if (pending) { if (pending.authorizationUrl !== authorization.authorizationUrl) throw new Error("Antigravity started more than one Google sign-in request."); return; }
    pending = authorization;
    options.onUpdate({ phase: "waiting", interaction: { type: "browser", id: "antigravity-google", url: authorization.authorizationUrl, acceptsCallback: true }, message: "Open the Google sign-in link. If you are remote, paste the complete redirect URL here." });
    const input = async () => {
      while (!finished.signal.aborted && !signal.aborted && !callbackSent) {
        const value = await options.readInput();
        if (finished.signal.aborted || signal.aborted) return;
        let callback: URL;
        try { callback = validateAntigravityCallbackUrl(authorization, value.trim()); }
        catch (error) { options.onUpdate({ message: sanitizeErrorMessage(error) }); continue; }
        callbackSent = true;
        options.onUpdate({ phase: "verifying", interaction: null, message: "Waiting for Google to finish sign-in." });
        await forwardAntigravityCallback(callback, signal);
      }
    };
    void input().catch((error: unknown) => { if (!finished.signal.aborted) failures.reject(error); });
  };
  try {
    await withExclusive(context, async () => {
      options.onUpdate({ phase: "starting", interaction: null, message: antigravityAuthUsesBrowser(config.authMethod) ? "Starting Google sign-in." : "Checking configured Antigravity credentials." });
      const native = withRuntime(context, signal, async (runtime) => {
        await startAntigravitySession(runtime, config.authMethod);
        options.onUpdate({ phase: "verifying", interaction: null, message: "Checking Antigravity access and models." }); observe(context, runtime);
      }, { exclusive: true, disposable: true, onAuthorizationUrl: receiveAuthorization });
      try { await Promise.race([native, failures.promise]); }
      catch (error) { finished.abort(); await native.catch(() => {}); throw error; }
    });
    options.onUpdate({ interaction: null, message: antigravityAuthUsesBrowser(config.authMethod) ? "Signed in with Google." : "Connected to Antigravity." });
  } catch (error) {
    if (options.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
    if (error instanceof AcpError) {
      if (error.message.includes("SUBSCRIPTION_REQUIRED")) throw new Error("Google requires an eligible Antigravity subscription for this account.");
      if (/access_denied|denied access|cancelled/i.test(error.message)) throw new Error("Google sign-in was not approved. Start sign-in again.");
      if (!antigravityAuthUsesBrowser(config.authMethod) && error.code === -32602) throw new Error("Antigravity rejected the configured credentials. Check the provider settings.");
      throw new Error(antigravityAuthUsesBrowser(config.authMethod) ? "Google sign-in failed. Start sign-in again." : "Antigravity could not authenticate with the configured credentials.");
    }
    throw error;
  } finally { finished.abort(); }
}

export const antigravityAdapter: NativeProviderAdapter = {
  definition: {
    driver: "antigravity", label: "Antigravity", description: "Google Antigravity's native ACP agent with isolated Google, Gemini API key, or Vertex AI authentication.", defaultInstance: false,
    source: "t3code/apps/server/src/provider/Drivers/AntigravityDriver.ts", docsUrl: "https://antigravity.google/", models: [defaultModel],
    installationAction: { label: "Install Antigravity runtime", description: "Explicitly download and verify Google's pinned native ACP executable and harness for this host. Required disk space is checked before downloading." },
    fields: [
      { key: "authMethod", label: "Sign-in method", description: "Google accounts use your subscription; API keys and Agent Platform bill usage.", type: "select", defaultValue: "oauth-personal", options: antigravityAuthMethods.map(({ value, label }) => ({ value, label })) },
      { key: "apiKey", label: "API key", type: "password", defaultValue: "", description: "Gemini or Vertex AI express key. Stored separately on the host." },
      { key: "gcpProject", label: "GCP project", type: "string", defaultValue: "", placeholder: "my-project-id", description: "Required for Gemini Enterprise. Agent Platform uses it when no API key is set." },
      { key: "gcpLocation", label: "GCP location", type: "string", defaultValue: "", placeholder: "us-central1", description: "Region for Gemini Enterprise or Agent Platform." },
      { key: "binaryPath", label: "Binary path", type: "string", defaultValue: "", placeholder: "Automatic", clearWhenEmpty: "persist", description: "Custom native ACP executable; its localharness_external sibling is required. Empty selects the verified managed runtime or an explicit PATH installation." },
    ],
  },
  validateConfig: (config) => ({ ...validateAntigravityConfig(config) }),
  check: async (context, signal) => {
    signal?.throwIfAborted();
    const config = validateAntigravityConfig(context.config); const issue = antigravityAuthConfigIssue(config);
    const observation = stateFor(context).observation;
    const current = observation?.revision === context.revision ? observation : undefined;
    let installation: AntigravityExecutable;
    try { installation = await resolveAntigravityInstallation(context, config.binaryPath); }
    catch (error) { return { installation: { status: "not-installed", checkedAt: new Date().toISOString(), error: sanitizeErrorMessage(error) }, authentication: "unknown", methods: authMethods(config), models: [defaultModel], canLogout: false, message: sanitizeErrorMessage(error), capabilities }; }
    // Source health probes must not spawn the one-file Python bundle: each launch unpacks ~1 GB.
    return {
      installation: { status: "installed", checkedAt: new Date().toISOString(), executablePath: installation.executablePath, ...(installation.version ?? current?.version ? { version: installation.version ?? current?.version } : {}) },
      authentication: issue ? "unknown" : current?.authentication ?? "unknown", authLabel: antigravityAuthLabel(config.authMethod), methods: authMethods(config),
      models: [defaultModel, ...(current?.models ?? [])], canLogout: current?.canLogout ?? false, capabilities,
      ...(issue ? { message: issue } : !current ? { message: "Antigravity is installed. Account access is not checked yet; connect to verify access and load models." } : current.authentication === "unauthenticated" ? { message: ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE } : {}),
    };
  },
  authenticate,
  logout: async (context, signal) => withExclusive(context, async () => {
    await withRuntime(context, AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(90_000)]), async (runtime) => {
      await runtime.initialize(); await runtime.logout();
      stateFor(context).observation = { revision: context.revision, authentication: "unauthenticated", models: [], canLogout: true };
    }, { exclusive: true, disposable: true, initializeOnly: true });
  }),
  run: async (context, options) => {
    const config = validateAntigravityConfig(context.config);
    if (options.resume && (options.resume.driver !== "antigravity" || options.resume.providerInstanceId !== context.instanceId || (options.resume.cwd !== undefined && options.resume.cwd !== context.cwd) || (options.resume.instanceRevision !== undefined && options.resume.instanceRevision !== context.revision))) throw new CliChatError("provider_error", "The Antigravity session belongs to a different provider instance, revision, or workspace.", undefined, context.instanceId);
    let usageCallbackFailed = false; let usageCallbackError: unknown;
    const onUsage = options.onUsage && ((update: Parameters<NonNullable<typeof options.onUsage>>[0]) => { try { options.onUsage?.(update); } catch (error) { usageCallbackFailed = true; usageCallbackError = error; throw error; } });
    try {
      return await withRuntime(context, options.signal, async (runtime, detachStartupAbort) => {
        await startAntigravitySession(runtime, config.authMethod, options.resume?.sessionId);
        const models = buildAntigravityModelsFromSession(runtime.sessionSetup);
        let modelId = options.model;
        if (!modelId || modelId === ANTIGRAVITY_DEFAULT_MODEL) {
          const selected = acpModelOption(runtime.sessionSetup.configOptions)?.currentValue ?? acpRecord(runtime.sessionSetup.models).currentModelId;
          modelId = typeof selected === "string" ? selected : ANTIGRAVITY_DEFAULT_MODEL;
        } else {
          if (!models.some((model) => model.id === modelId)) throw new Error(`Antigravity model '${modelId}' is unavailable for this Google account. Select an available model.`);
          await runtime.setModel(modelId);
        }
        observe(context, runtime);
        const nativeSession: NativeSessionRef = { driver: "antigravity", providerInstanceId: context.instanceId, sessionId: runtime.sessionId, cwd: context.cwd, instanceRevision: context.revision, modelId };
        options.onSession?.(nativeSession); options.signal?.throwIfAborted(); detachStartupAbort();
        const result = await runtime.prompt(options.prompt, options.onText, options.signal, options.onEvent, undefined, onUsage); observe(context, runtime);
        return { ...result, nativeSession };
      });
    } catch (error) {
      if (usageCallbackFailed) throw usageCallbackError;
      if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw new CliChatError("aborted", "Antigravity request cancelled.", error, context.instanceId);
      if (isAcpAuthenticationRequired(error) || (error instanceof Error && error.message === ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE)) throw new CliChatError("provider_not_authenticated", ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE, error, context.instanceId);
      const message = sanitizeErrorMessage(config.apiKey && error instanceof Error ? error.message.replaceAll(config.apiKey, "***") : error, "Antigravity native execution failed.");
      throw new CliChatError("provider_error", message, { message, ...(error instanceof AcpError ? { code: error.code } : {}) }, context.instanceId);
    }
  },
  prepare: async (context, signal) => installAntigravityRuntime(context, async (installation, version, validationSignal) => {
    await mkdir(context.homeDirectory, { recursive: true, mode: 0o700 });
    const validationHome = await mkdtemp(join(context.homeDirectory, ".antigravity-validate-"));
    const validationContext: ProviderDriverContext = { ...context, homeDirectory: validationHome, cwd: validationHome, config: {}, env: { ...context.env, HOME: validationHome, USERPROFILE: validationHome } };
    try {
      await withRuntime(validationContext, validationSignal, async (runtime) => {
        const initialized = await runtime.initialize(); const agent = acpRecord(initialized.agentInfo); const caps = acpRecord(initialized.agentCapabilities);
        if (agent.name !== "antigravity-acp" || agent.version !== version || ![1, 2].includes(Number(initialized.protocolVersion)) || caps.loadSession !== true || !acpRecord(caps.sessionCapabilities).resume || !acpRecord(caps.auth).logout || !Array.isArray(initialized.authMethods) || !initialized.authMethods.some((method: unknown) => acpRecord(method).id === "oauth-personal")) throw new Error("The downloaded runtime did not identify as the expected Google Antigravity release.");
      }, { installation, initializeOnly: true });
    } catch (error) {
      if (error instanceof Error && /\b(?:AF_INET6|enforce_kernel_ipv6_support)\b/.test(error.message)) throw new Error("Antigravity requires IPv6 socket support. Enable IPv6 in this environment. On WSL, remove ipv6.disable=1 from .wslconfig and run wsl --shutdown.");
      throw error;
    } finally { instances.delete(validationHome); await rm(validationHome, { recursive: true, force: true }); }
  }, signal),
};
