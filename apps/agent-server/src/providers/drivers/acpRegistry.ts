// Adapted from t3code packages/provider-acp-registry/src/server/{driver,adapter,probe}.ts (MIT).
import path from "node:path";
import type { ProviderCapabilities, ProviderModel } from "@agent-workspace/contracts/provider";
import { sanitizeErrorMessage } from "../../agents/cli-chat.ts";
import type { NativeProviderAdapter, ProviderDriverContext } from "../driver-adapter.ts";
import { acpAuthMethods, acpCredentialEnvironment, authenticateAcp, clearAcpCredentials } from "./acp-auth.ts";
import { AcpError, acpModels, acpRecord, isAcpAuthenticationRequired, openAcpClient, type AcpClientOptions, type AcpRecord } from "./acp.ts";
import { prepareAcpRegistry, resolveAcpRegistry, validateAcpRegistryConfig, type AcpRegistryResolved } from "./acp-registry-support.ts";
import { readAcpAuthenticationConfirmation, writeAcpAuthenticationConfirmation } from "./acp-auth-state.ts";

const defaultModels: ProviderModel[] = [{ id: "default", label: "Default", source: "builtin", temperature: false }];
function registryClientOptions(resolved: AcpRegistryResolved): AcpClientOptions {
  const id = resolved.agentId; const binary = path.basename(resolved.commandPath);
  const copilot = id === "github-copilot-cli" || (!id && /^copilot(?:\.exe)?$/i.test(binary));
  const devin = id === "devin";
  let delta: { text: string; kind: string; task?: string } | undefined;
  return {
    clientCapabilities: { terminal: devin, ...(devin ? { _meta: { "cognition.ai/subagentSupport": true, "cognition.ai/messageGrouping": true } } : copilot ? { _meta: { "github.com/copilot": { events: ["subagent.started", "subagent.completed", "subagent.failed", "assistant.message_delta", "assistant.reasoning_delta"] } } } : {}) },
    terminalShellCommands: devin,
    onNotification(method, params) {
      if (copilot && method === "github.com/copilot/sessionEvent" && ["assistant.message_delta", "assistant.reasoning_delta"].includes(String(params.type))) {
        const data = acpRecord(params.data); if (typeof data.deltaContent === "string") delta = { text: data.deltaContent, kind: String(params.type), ...(typeof data.parentToolCallId === "string" ? { task: data.parentToolCallId } : {}) };
      }
    },
    normalizeSessionUpdate(params) {
      const update = acpRecord(params.update);
      if (devin) {
        const meta = acpRecord(update._meta); const parent = acpRecord(meta["cognition.ai/subagent_context"]).parentAgentId;
        const messageId = meta["cognition.ai/streamingMessageId"];
        return { ...params, ...(typeof parent === "string" && parent !== "root" ? { sessionId: parent } : {}), ...(typeof messageId === "string" && ["agent_message_chunk", "agent_thought_chunk"].includes(String(update.sessionUpdate)) ? { update: { ...update, messageId } } : {}) };
      }
      if (copilot && ["agent_message_chunk", "agent_thought_chunk"].includes(String(update.sessionUpdate))) {
        const previous = delta; delta = undefined;
        const kind = update.sessionUpdate === "agent_message_chunk" ? "assistant.message_delta" : "assistant.reasoning_delta";
        if (previous?.task && previous.kind === kind && acpRecord(update.content).text === previous.text) return { ...params, sessionId: `copilot-task:${previous.task}` };
      }
      return params;
    },
    async onRequest(method) {
      // No user-question or plan-approval bypass exists in the PM execution contract.
      if (["elicitation/create", "session/elicitation", "_session/elicitation"].includes(method)) return method === "elicitation/create" ? { action: "cancel" } : { action: { action: "cancel" } };
      return undefined;
    },
  };
}
async function registrySpawn(context: ProviderDriverContext, signal?: AbortSignal): Promise<AcpRegistryResolved> {
  const resolved = await resolveAcpRegistry(context, signal);
  const claude = resolved.agentId === "claude-acp" || (!resolved.agentId && /^claude-agent-acp(?:\.exe)?$/i.test(path.basename(resolved.commandPath)));
  resolved.spawn.env = { ...resolved.spawn.env, ...await acpCredentialEnvironment(context), ...(claude ? { CLAUDE_AGENT_ACP_EXPERIMENTAL_V2: resolved.spawn.env?.CLAUDE_AGENT_ACP_EXPERIMENTAL_V2 ?? "1" } : {}) };
  return resolved;
}
function capabilities(initialized: AcpRecord): ProviderCapabilities {
  const caps = acpRecord(initialized.agentCapabilities);
  return { nativeResume: caps.loadSession === true || Boolean(acpRecord(caps.sessionCapabilities).resume), nativeFork: false, boundedFork: false, modelTransition: "native", portableHandoff: true };
}
export const acpRegistryAdapter: NativeProviderAdapter = {
  definition: {
    driver: "acpRegistry", label: "ACP Registry", description: "Agents from the official Agent Client Protocol Registry, or a local ACP command.", defaultInstance: false,
    source: "t3code/packages/provider-acp-registry", docsUrl: "https://agentclientprotocol.com/registry", models: defaultModels,
    installationAction: { label: "Prepare agent", description: "Explicitly download or install the selected official registry distribution into this provider's isolated home." },
    fields: [
      { key: "source", label: "ACP source", type: "select", defaultValue: "registry", options: [{ value: "registry", label: "ACP Registry" }, { value: "local", label: "Local command" }] },
      { key: "agentId", label: "Registry agent ID", type: "string", defaultValue: "", placeholder: "devin", clearWhenEmpty: "persist", description: "Agent identifier from the official ACP Registry." },
      { key: "commandPath", label: "Executable override", type: "string", defaultValue: "", placeholder: "Registry default", clearWhenEmpty: "omit", description: "Local executable; registry overrides retain the official distribution arguments and environment." },
      { key: "commandArgs", label: "Local command arguments", type: "string-list", defaultValue: [], description: "Passed as individual arguments, never interpreted by a shell." },
      { key: "authMethodId", label: "Authentication method", type: "string", defaultValue: "", placeholder: "auto", clearWhenEmpty: "omit", description: "Optional authentication method ID advertised by the ACP agent." },
      { key: "distribution", label: "Distribution", type: "select", defaultValue: "auto", options: ["auto", "binary", "npx", "uvx"].map((value) => ({ value, label: value })) },
    ],
  },
  validateConfig: validateAcpRegistryConfig,
  async prepare(context, signal) {
    const resolved = await prepareAcpRegistry(context, signal);
    return { message: `${resolved.agentId || "Local ACP agent"} is ready (${resolved.distribution}${resolved.version ? ` ${resolved.version}` : ""}).`, agentId: resolved.agentId, version: resolved.version, distribution: resolved.distribution, commandPath: resolved.commandPath };
  },
  async check(context, signal) {
    let resolved: AcpRegistryResolved;
    try { resolved = await registrySpawn(context, signal); } catch (error) {
      if (signal?.aborted) throw error;
      return { installation: { status: "not-installed", checkedAt: new Date().toISOString(), error: sanitizeErrorMessage(error) }, authentication: "unknown", models: defaultModels, methods: [], canLogout: false, message: sanitizeErrorMessage(error) };
    }
    const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
    const client = await openAcpClient(context, resolved.spawn, { ...registryClientOptions(resolved), signal: deadline });
    try {
      const initialized = await client.initialize(); const methods = acpAuthMethods(initialized);
      const canLogout = Boolean(acpRecord(acpRecord(initialized.agentCapabilities).auth).logout) || Object.keys(await acpCredentialEnvironment(context)).length > 0;
      const confirmedAuthentication = await readAcpAuthenticationConfirmation(context);
      const installation = { status: "installed" as const, executablePath: resolved.commandPath, ...(resolved.version ? { version: resolved.version } : {}), checkedAt: new Date().toISOString() };
      try {
        const setup = await client.start(); const models = acpModels(initialized, setup);
        return { installation, authentication: confirmedAuthentication ? "authenticated" as const : "unknown" as const, models: models.length ? models : defaultModels, methods, canLogout, capabilities: capabilities(initialized) };
      } catch (error) {
        if (signal?.aborted) throw error;
        const models = acpModels(initialized);
        if (isAcpAuthenticationRequired(error)) await writeAcpAuthenticationConfirmation(context, false);
        return { installation, authentication: isAcpAuthenticationRequired(error) ? "unauthenticated" as const : confirmedAuthentication ? "authenticated" as const : "unknown" as const, models: models.length ? models : defaultModels, methods, canLogout, capabilities: capabilities(initialized), message: sanitizeErrorMessage(error) };
      }
    } finally { client.close(); await client.waitForClose(); }
  },
  async authenticate(context, options) {
    const resolved = await registrySpawn(context, options.signal);
    await authenticateAcp(context, resolved.spawn, options, registryClientOptions(resolved));
    await writeAcpAuthenticationConfirmation(context, true);
  },
  async logout(context, signal) {
    const resolved = await registrySpawn(context, signal); const client = await openAcpClient(context, resolved.spawn, { signal });
    try {
      const initialized = await client.initialize();
      if (acpRecord(acpRecord(initialized.agentCapabilities).auth).logout) await client.logout();
      else if (!Object.keys(await acpCredentialEnvironment(context)).length) await client.logout(); // Reports the native unsupported operation honestly.
      await clearAcpCredentials(context);
      await writeAcpAuthenticationConfirmation(context, false);
    } finally { client.close(); await client.waitForClose(); }
  },
  async run(context, options) {
    const resolved = await registrySpawn(context, options.signal); const client = await openAcpClient(context, resolved.spawn, registryClientOptions(resolved));
    const abortStartup = () => client.close(); options.signal?.addEventListener("abort", abortStartup, { once: true });
    try {
      try { await client.start(options.resume?.sessionId); } catch (error) {
        if (!isAcpAuthenticationRequired(error) || (!context.config.authMethodId && !await readAcpAuthenticationConfirmation(context))) throw error;
        const methods = Array.isArray(client.initialized.authMethods) ? client.initialized.authMethods.map(acpRecord) : [];
        const configured = String(context.config.authMethodId || "");
        const method = configured ? methods.find((candidate) => candidate.id === configured) : methods.find((candidate) => candidate.type === undefined || candidate.type === "agent");
        if (!method || typeof method.id !== "string") throw error;
        // Reuse a previously verified instance account; browser/form requests still require consent and are cancelled here.
        await client.authenticate(method.id);
        await client.start(options.resume?.sessionId);
      }
      if (options.model && options.model !== "default") await client.setModel(options.model);
      if (options.signal?.aborted) throw new DOMException("ACP prompt cancelled.", "AbortError");
      options.signal?.removeEventListener("abort", abortStartup);
      const nativeSession = { providerInstanceId: context.instanceId, driver: "acpRegistry" as const, sessionId: client.sessionId, modelId: options.model, cwd: context.cwd, instanceRevision: context.revision };
      options.onSession?.(nativeSession);
      const result = await client.prompt(options.prompt, options.onText, options.signal, options.onEvent, undefined, options.onUsage);
      return { ...result, nativeSession };
    } catch (error) {
      if (resolved.agentId === "mistral-vibe" && error instanceof AcpError && error.code === -31001) throw new AcpError(error.message, error.code, error.data, "usage_limit");
      throw error;
    } finally { options.signal?.removeEventListener("abort", abortStartup); client.close(); await client.waitForClose(); }
  },
};
