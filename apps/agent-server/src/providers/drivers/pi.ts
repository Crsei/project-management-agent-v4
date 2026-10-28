// Native implementation ported from t3code/packages/provider-pi/src/{settings.ts,server/status.ts,server/adapter.ts} (MIT).
import path from "node:path";
import type { NativeSessionRef, ProviderAuthMethod, ProviderModel } from "@agent-workspace/contracts/provider";
import type { NativeUsageUpdate } from "@agent-workspace/contracts/usage";
import { CliChatError, sanitizeErrorMessage } from "../../agents/cli-chat.ts";
import type { NativeProviderAdapter, ProviderDriverContext, ProviderDriverStatus } from "../driver-adapter.ts";
import { runProviderCommand } from "../process.ts";
import { piBinary, piEnvironment, resolvePiLaunchArgs, validatePiConfig } from "./pi-config.ts";
import { openPiRpc, parsePiModelSlug, piRecord, piString } from "./pi-rpc.ts";
import { PiTurnOutput, piStateIsIdle } from "./pi-protocol.ts";
import { materializePiPermissions, PI_PERMISSION_READY } from "./pi-permissions.ts";

const methods: ProviderAuthMethod[] = [{ id: "external-login", name: "Sign in with Pi in a terminal", type: "terminal", description: "Run Pi with this instance's dedicated home and use /login, then confirm to verify its native model inventory." }];
const defaultModel: ProviderModel = { id: "default", label: "Pi default", source: "builtin", temperature: false };
const capabilities = { nativeResume: true, nativeFork: false, boundedFork: false, modelTransition: "native" as const, portableHandoff: true as const };
function launch(context: ProviderDriverContext, ephemeral: boolean, extensionPath?: string) {
  const config = validatePiConfig(context.config);
  return { binary: piBinary(context), args: ["--mode", "rpc", ...(ephemeral ? ["--no-session"] : []), ...resolvePiLaunchArgs(String(config.launchArgs)), ...(extensionPath ? ["--extension", extensionPath] : [])], cwd: context.cwd, env: piEnvironment(context) };
}

export function parsePiModels(data: unknown): ProviderModel[] {
  const inventory = piRecord(data).models;
  if (!Array.isArray(inventory)) throw new Error("Pi get_available_models returned an invalid model inventory.");
  const seen = new Set<string>();
  return inventory.flatMap((entry): ProviderModel[] => {
    const provider = piString(entry, "provider");
    const id = piString(entry, "id");
    if (!provider?.trim() || !id?.trim()) throw new Error("Pi returned an invalid model identity.");
    const slug = `${provider}/${id}`;
    if (seen.has(slug)) return [];
    seen.add(slug);
    return [{ id: slug, label: piString(entry, "name") || slug, source: "discovered", temperature: false, reasoning: piRecord(entry).reasoning === true }];
  });
}

async function checkPi(context: ProviderDriverContext, signal?: AbortSignal): Promise<ProviderDriverStatus> {
  signal?.throwIfAborted();
  const version = await runProviderCommand(piBinary(context), ["--version"], { cwd: context.cwd, env: piEnvironment(context), signal, timeoutMs: 4_000 });
  signal?.throwIfAborted();
  const parsedVersion = `${version.stdout}\n${version.stderr}`.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  const installation: ProviderDriverStatus["installation"] = { status: version.installed ? "installed" : "not-installed", executablePath: piBinary(context), checkedAt: new Date().toISOString(), ...(parsedVersion ? { version: parsedVersion[0] } : {}) };
  const base: ProviderDriverStatus = { installation, authentication: "unknown", methods, canLogout: false, models: [defaultModel], capabilities };
  if (!version.installed) return { ...base, message: "Pi CLI was not found. Install @earendil-works/pi-coding-agent and select its binary path." };
  if (version.code !== 0) return { ...base, installation: { ...installation, error: "Pi version check failed or timed out." }, message: "Pi CLI could not complete its version check." };
  if (!parsedVersion || (Number(parsedVersion[1]) === 0 && (Number(parsedVersion[2]) < 80 || (Number(parsedVersion[2]) === 80 && Number(parsedVersion[3]) < 5))))
    return { ...base, installation: { ...installation, error: "Pi 0.80.5 or newer is required." }, message: "Pi 0.80.5 or newer is required for native turn completion." };
  const rpc = openPiRpc({ ...launch(context, true), signal });
  try {
    await rpc.request({ type: "get_state" });
    const models = parsePiModels(await rpc.request({ type: "get_available_models" }));
    return { ...base, authentication: models.length ? "authenticated" : "unauthenticated", models: [defaultModel, ...models], authLabel: models.length ? "Pi native credentials" : undefined, ...(models.length ? {} : { message: "Pi has no usable models. Use /login in Pi with this instance's dedicated home, or configure its native credentials there." }) };
  } catch (error) {
    signal?.throwIfAborted();
    return { ...base, message: `Pi is installed, but native model discovery failed: ${sanitizeErrorMessage(error)}` };
  } finally { await rpc.close(); }
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export const piAdapter: NativeProviderAdapter = {
  definition: {
    driver: "pi", label: "Pi", description: "Pi coding agent using its native RPC runtime and native provider credentials.", defaultInstance: false,
    source: "t3code/packages/provider-pi/src/settings.ts; server/{rpc,status,adapter,mcpInjection}.ts",
    docsUrl: "https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent",
    fields: [
      { key: "binaryPath", label: "Binary path", description: "Path to the Pi coding agent binary.", type: "string", defaultValue: "pi", placeholder: "pi" },
      { key: "launchArgs", label: "Launch arguments", description: "Additional arguments to pi --mode rpc. Write-only because native --api-key is supported. Session/protocol flags are controlled by Agent.", type: "password", defaultValue: "" },
    ],
    models: [defaultModel],
  },
  validateConfig: validatePiConfig,
  check: checkPi,
  async authenticate(context, options) {
    if (options.methodId && options.methodId !== "external-login") throw new Error("Unknown Pi authentication method.");
    options.signal.throwIfAborted();
    const env = piEnvironment(context);
    const command = `HOME=${shellQuote(context.homeDirectory)} PI_CODING_AGENT_DIR=${shellQuote(env.PI_CODING_AGENT_DIR!)} ${shellQuote(piBinary(context))}`;
    const output = `On this server, run:\n${command}\nUse /login in Pi (or configure its native provider API key in that dedicated directory). When finished, send any input here to verify. No global credentials will be imported.`;
    options.onUpdate({ phase: "waiting", interaction: { type: "terminal", id: `pi-login-${context.instanceId}`, output }, message: "Waiting for external Pi authentication." });
    const aborted = Promise.withResolvers<never>();
    const onAbort = () => aborted.reject(options.signal.reason ?? new Error("Pi authentication cancelled."));
    options.signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (options.signal.aborted) onAbort();
      await Promise.race([options.readInput(), aborted.promise]);
      options.onUpdate({ phase: "verifying", interaction: null });
      const status = await checkPi(context, options.signal);
      if (status.authentication !== "authenticated") throw new Error(status.message ?? "Pi native credentials could not be verified.");
    } finally { options.signal.removeEventListener("abort", onAbort); }
  },
  async logout() { throw new Error("Pi sign-out is managed externally in its native terminal using this instance's dedicated home. Agent does not delete native credentials."); },
  async run(context, options) {
    if (options.signal?.aborted) throw new CliChatError("aborted", "Pi turn cancelled.");
    const resume = options.resume;
    if (resume && (resume.driver !== "pi" || resume.providerInstanceId !== context.instanceId || (resume.instanceRevision !== undefined && resume.instanceRevision !== context.revision) || (resume.cwd && path.resolve(resume.cwd) !== path.resolve(context.cwd))))
      throw new CliChatError("provider_error", "Pi session belongs to a different provider instance, revision, or workspace.");
    const extensionPath = await materializePiPermissions(context.homeDirectory);
    const rpc = openPiRpc({ ...launch(context, false, extensionPath), signal: options.signal });
    const completion = Promise.withResolvers<void>();
    void completion.promise.catch(() => {});
    let usageCallbackFailed = false;
    let usageCallbackError: unknown;
    const onUsage = options.onUsage ? (update: NativeUsageUpdate) => {
      try { options.onUsage!(update); }
      catch (error) { usageCallbackFailed = true; usageCallbackError = error; throw error; }
    } : undefined;
    const output = new PiTurnOutput(options.onText, options.onEvent, onUsage);
    let running = false;
    let settled = false;
    let probe: ReturnType<typeof setTimeout> | undefined;
    let promptAcknowledged = false;
    let probing = false;
    let permissionGuardReady = false;
    const finishIfIdle = async () => {
      if (!running || settled || probing) return;
      clearTimeout(probe);
      probing = true;
      const generation = output.generation;
      try {
        const state = await rpc.request({ type: "get_state" }, 2_000);
        if (!running || settled) return;
        if (generation === output.generation && piStateIsIdle(state) && !output.compacting) { settled = true; completion.resolve(); }
        else probe = setTimeout(() => { void finishIfIdle(); }, 100);
      } catch (error) { completion.reject(error); }
      finally { probing = false; }
    };
    const unsubscribe = rpc.onEvent((event) => {
      if (event.type === "extension_ui_request" && event.method === "notify" && event.message === PI_PERMISSION_READY) { permissionGuardReady = true; return; }
      if (event.type === "extension_error" && event.extensionPath === extensionPath) {
        if (running) output.consume(event);
        completion.reject(new Error("Pi native permission guard failed; execution was stopped."));
        void rpc.close();
        return;
      }
      if (event.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(String(event.method))) {
        if (running) output.consume(event);
        if (typeof event.id === "string") rpc.send({ type: "extension_ui_response", id: event.id, cancelled: true, ...(event.method === "confirm" ? { confirmed: false } : {}) });
        completion.reject(new Error("Pi requested interactive approval/input. Complete the action in a native terminal; Agent did not approve it."));
        return;
      }
      if (!running) return;
      if (event.type === "response" && event.id === "agent-prompt") {
        if (event.success !== true) completion.reject(new Error(`Pi prompt failed: ${sanitizeErrorMessage(event.error)}`));
        else { promptAcknowledged = true; if (!output.activity) void finishIfIdle(); }
      }
      if (output.consume(event)) void finishIfIdle();
      else if (promptAcknowledged && !output.activity) void finishIfIdle();
    });
    try {
      if (resume) {
        const switched = await rpc.request({ type: "switch_session", sessionPath: resume.sessionId });
        if (piRecord(switched).cancelled === true) throw new Error("A Pi extension cancelled the session switch.");
      }
      const state = await rpc.request({ type: "get_state" });
      if (!permissionGuardReady) throw new Error("Pi did not activate its required native permission guard; no prompt was sent.");
      const sessionId = piString(state, "sessionFile");
      if (!sessionId) throw new Error("Pi get_state did not return a persisted sessionFile.");
      if (options.model && options.model !== "default") await rpc.request({ type: "set_model", ...parsePiModelSlug(options.model) });
      const nativeSession: NativeSessionRef = { providerInstanceId: context.instanceId, driver: "pi", sessionId, modelId: options.model, cwd: context.cwd, instanceRevision: context.revision };
      options.onSession?.(nativeSession);
      running = true;
      rpc.send({ type: "prompt", id: "agent-prompt", message: options.prompt, streamingBehavior: "steer" });
      await Promise.race([completion.promise, rpc.failed]);
      options.signal?.throwIfAborted();
      if (output.aborted) throw new CliChatError("aborted", "Pi turn was cancelled.");
      if (output.failure) throw new CliChatError("provider_error", sanitizeErrorMessage(output.failure), output.failure, context.instanceId);
      if (onUsage) {
        // Pi's session stats report the actual current context, independently
        // of the turn's cumulative token totals. Older peers may not support it.
        let stats: unknown;
        try { stats = await rpc.request({ type: "get_session_stats" }, 2_000); }
        catch { options.signal?.throwIfAborted(); }
        const contextUsage = piRecord(piRecord(stats).contextUsage);
        const used = contextUsage.tokens;
        const capacity = contextUsage.contextWindow;
        if (typeof used === "number" && Number.isSafeInteger(used) && used >= 0) {
          onUsage({ context: { usedTokens: used, updatedAt: new Date().toISOString(),
            ...(typeof capacity === "number" && Number.isSafeInteger(capacity) && capacity > 0 ? { maxTokens: capacity } : {}),
            ...(options.model && options.model !== "default" ? { model: options.model } : {}) } });
        }
      }
      return { text: output.text, usage: output.usage, nativeSession };
    } catch (error) {
      if (usageCallbackFailed) throw usageCallbackError;
      if (options.signal?.aborted) {
        try { rpc.send({ type: "abort" }); } catch { /* Cancellation may already have closed transport. */ }
        throw new CliChatError("aborted", "Pi turn cancelled.");
      }
      if (error instanceof CliChatError) throw error;
      throw new CliChatError("provider_error", sanitizeErrorMessage(error), error, context.instanceId);
    } finally { running = false; clearTimeout(probe); unsubscribe(); await rpc.close(); }
  },
};
