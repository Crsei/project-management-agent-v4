// Ported from t3code packages/provider-grok/src/{settings,server/acpSupport,
// server/status,server/xaiAcpExtension}.ts (MIT). Grok runs its native Agent, not an xAI model API.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { z } from "zod";
import type { ProviderModel } from "@agent-workspace/contracts/provider";
import { sanitizeErrorMessage } from "../../agents/cli-chat.ts";
import type { NativeProviderAdapter, ProviderDriverContext } from "../driver-adapter.ts";
import { runProviderCommand } from "../process.ts";
import { acpAuthMethods, acpCredentialEnvironment, authenticateAcp, clearAcpCredentials, saveAcpCredentials } from "./acp-auth.ts";
import { AcpError, acpModels, acpRecord, isAcpAuthenticationRequired, openAcpClient, type AcpClientOptions, type AcpSpawn } from "./acp.ts";

const builtinModels: ProviderModel[] = [{ id: "grok-build", label: "Grok Build", source: "builtin", temperature: false }];
const apiKeyMethod = { id: "xai.api_key", name: "xAI API key (Grok Agent)", type: "credentials" as const, fields: [{ name: "XAI_API_KEY", label: "xAI API key", secret: true }] };
const grokOptions: AcpClientOptions = {
  initializeMeta: { clientType: "extension" }, cancelMeta: { cancelTrigger: "ctrl_c" }, grokCompletion: true,
  async onRequest(method) {
    if (["x.ai/ask_user_question", "_x.ai/ask_user_question"].includes(method)) return { outcome: "cancelled" };
    if (["x.ai/exit_plan_mode", "_x.ai/exit_plan_mode"].includes(method)) return { outcome: "abandoned", feedback: "Stop here and wait for the user's feedback or implementation request in a later turn; this PM request has not granted plan approval." };
    if (["elicitation/create", "session/elicitation", "_session/elicitation"].includes(method)) return method === "elicitation/create" ? { action: "cancel" } : { action: { action: "cancel" } };
    return undefined;
  },
};
async function grokSpawn(context: ProviderDriverContext): Promise<AcpSpawn> {
  return { command: String(context.config.binaryPath || "grok"), args: ["--permission-mode", "default", "agent", "stdio"], env: { ...context.env, ...await acpCredentialEnvironment(context), GROK_HOME: context.homeDirectory, GROK_OAUTH2_REFERRER: "t3code", GROK_DISABLE_AUTOUPDATER: "1" } };
}
export function parseGrokModelsOutput(output: string): { authentication: "authenticated" | "unauthenticated" | "unknown"; models: ProviderModel[] } {
  const authentication = /you are logged in/i.test(output) ? "authenticated" : /not authenticated|not logged in/i.test(output) ? "unauthenticated" : "unknown";
  const models = new Map<string, ProviderModel>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*[*-]\s+(\S+)(.*)$/); if (!match?.[1]) continue;
    const id = match[1]; models.set(id, { id, label: id.split(/[-_]/).map((word) => word.toLowerCase() === "grok" ? "Grok" : word).join(" "), source: "discovered", temperature: false });
  }
  return { authentication, models: [...models.values()] };
}
export const grokAdapter: NativeProviderAdapter = {
  definition: {
    driver: "grok", label: "Grok", description: "Native Grok CLI Agent with account or native xAI API-key authentication.", defaultInstance: false,
    source: "t3code/packages/provider-grok", models: builtinModels,
    fields: [{ key: "binaryPath", label: "Binary path", description: "Path to the Grok CLI binary.", type: "string", defaultValue: "grok", placeholder: "grok", clearWhenEmpty: "omit" }],
  },
  validateConfig(config) {
    return z.object({ binaryPath: z.string().trim().refine((value) => !value.includes("\0")).transform((value) => value || "grok").default("grok") }).strict().parse(config);
  },
  async check(context, signal) {
    const spawn = await grokSpawn(context);
    const version = await runProviderCommand(spawn.command, ["--version"], { env: spawn.env, cwd: context.cwd, signal, timeoutMs: 4000, maxOutput: 64 * 1024 });
    const installation = { status: version.installed ? "installed" as const : "not-installed" as const, executablePath: spawn.command, checkedAt: new Date().toISOString(), ...(version.code === 0 ? { version: `${version.stdout}\n${version.stderr}`.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0] } : { error: sanitizeErrorMessage(version.stderr || "Grok version check failed.") }) };
    if (!version.installed || version.code !== 0) return { installation, authentication: "unknown", models: builtinModels, methods: [], canLogout: false };
    const list = () => runProviderCommand(spawn.command, ["models"], { env: spawn.env, cwd: context.cwd, signal, timeoutMs: 10_000, maxOutput: 1024 * 1024 });
    let listed = await list(); let parsed = listed.code === 0 ? parseGrokModelsOutput(`${listed.stdout}\n${listed.stderr}`) : { authentication: "unknown" as const, models: [] };
    if (parsed.authentication === "unauthenticated" && !spawn.env?.XAI_API_KEY) { listed = await list(); if (listed.code === 0) parsed = parseGrokModelsOutput(`${listed.stdout}\n${listed.stderr}`); }
    const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
    const client = await openAcpClient(context, spawn, { ...grokOptions, signal: deadline });
    try {
      const initialized = await client.initialize(); const discovered = acpModels(initialized);
      const methods = acpAuthMethods(initialized).filter((method) => method.id !== "cached_token"); if (!methods.some((method) => method.id === apiKeyMethod.id)) methods.push(apiKeyMethod);
      return { installation, authentication: spawn.env?.XAI_API_KEY?.trim() ? "authenticated" : parsed.authentication, authLabel: spawn.env?.XAI_API_KEY?.trim() ? "xAI API key" : parsed.authentication === "authenticated" ? "Grok account" : undefined, models: discovered.length ? discovered : parsed.models.length ? parsed.models : builtinModels, methods, canLogout: Boolean(acpRecord(acpRecord(initialized.agentCapabilities).auth).logout) || Boolean((await acpCredentialEnvironment(context)).XAI_API_KEY), capabilities: { nativeResume: acpRecord(initialized.agentCapabilities).loadSession === true || Boolean(acpRecord(acpRecord(initialized.agentCapabilities).sessionCapabilities).resume), nativeFork: false, boundedFork: false, modelTransition: "native", portableHandoff: true } };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { installation, authentication: spawn.env?.XAI_API_KEY?.trim() ? "authenticated" : parsed.authentication, models: parsed.models.length ? parsed.models : builtinModels, methods: [apiKeyMethod], canLogout: Boolean((await acpCredentialEnvironment(context)).XAI_API_KEY), message: sanitizeErrorMessage(error) };
    } finally { client.close(); await client.waitForClose(); }
  },
  async authenticate(context, options) {
    const spawn = await grokSpawn(context);
    if (options.methodId === "xai.api_key") {
      let values = options.values;
      if (!values?.XAI_API_KEY) {
        options.onUpdate({ phase: "waiting", interaction: { type: "credentials", id: "xai.api_key", fields: apiKeyMethod.fields } });
        try { values = acpRecord(JSON.parse(await options.readInput())) as Record<string, string>; } catch { throw new AcpError("Invalid Grok API key response."); }
      }
      const key = values.XAI_API_KEY?.trim(); if (!key) throw new AcpError("Provide an xAI API key for the native Grok Agent.");
      const client = await openAcpClient(context, { ...spawn, env: { ...spawn.env, XAI_API_KEY: key } }, { ...grokOptions, signal: options.signal });
      try { await client.authenticate("xai.api_key"); await client.start(); await saveAcpCredentials(context, { XAI_API_KEY: key }); } finally { client.close(); await client.waitForClose(); }
      return;
    }
    const discovery = await openAcpClient(context, spawn, { ...grokOptions, signal: options.signal });
    let methodId = options.methodId;
    try { const methods = acpAuthMethods(await discovery.initialize()); methodId ||= methods.find((method) => method.id === "grok.com")?.id || methods.find((method) => method.id !== "cached_token" && method.type !== "credentials")?.id; } finally { discovery.close(); await discovery.waitForClose(); }
    await authenticateAcp(context, spawn, { ...options, methodId }, grokOptions);
  },
  async logout(context, signal) {
    const spawn = await grokSpawn(context); const client = await openAcpClient(context, spawn, { ...grokOptions, signal });
    try {
      const initialized = await client.initialize();
      if (acpRecord(acpRecord(initialized.agentCapabilities).auth).logout) await client.logout();
      else if (!(await acpCredentialEnvironment(context)).XAI_API_KEY) throw new AcpError("This Grok CLI does not advertise native logout support.", -32601);
      await clearAcpCredentials(context);
    } finally { client.close(); await client.waitForClose(); }
  },
  async run(context, options) {
    const spawn = await grokSpawn(context); const client = await openAcpClient(context, spawn, { ...grokOptions, ownDescendantProcessGroups: true });
    const abort = () => client.close(); options.signal?.addEventListener("abort", abort, { once: true });
    try {
      try { await client.start(options.resume?.sessionId); } catch (error) {
        if (!isAcpAuthenticationRequired(error)) throw error;
        // Never start browser login implicitly from a model turn.
        await client.authenticate(spawn.env?.XAI_API_KEY?.trim() ? "xai.api_key" : "cached_token");
        await client.start(options.resume?.sessionId);
      }
      if (options.model && options.model !== "grok-build") await client.setModel(options.model);
      if (options.signal?.aborted) throw new DOMException("Grok prompt cancelled.", "AbortError");
      options.signal?.removeEventListener("abort", abort);
      const nativeSession = { providerInstanceId: context.instanceId, driver: "grok" as const, sessionId: client.sessionId, modelId: options.model, cwd: context.cwd, instanceRevision: context.revision };
      options.onSession?.(nativeSession);
      return { ...await client.prompt(options.prompt, options.onText, options.signal, options.onEvent, options.onRequest, options.onUsage), nativeSession };
    } finally { options.signal?.removeEventListener("abort", abort); client.close(); await client.waitForClose(); }
  },
};
