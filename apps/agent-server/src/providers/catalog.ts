import type { ProviderCapabilities, ProviderInstance, ProviderModel } from "@agent-workspace/contracts/provider";
import { getStoredInstance, listStoredInstances, providerContext, providerDataDirectory, publicInstanceConfig, type StoredProviderInstance } from "./instances.ts";
import { getNativeProviderAdapter } from "./driver-registry.ts";
import type { ProviderDriverStatus } from "./driver-adapter.ts";
import { sanitizeErrorText } from "./verify.ts";

const observations = new Map<string, { revision: number; status: ProviderDriverStatus }>();
const checks = new Map<string, { revision: number; promise: Promise<ProviderDriverStatus> }>();
const cacheKey = (instanceId: string) => `${providerDataDirectory()}\0${instanceId}`;
const portableCapabilities: ProviderCapabilities = {
  nativeResume: false, nativeFork: false, boundedFork: false,
  modelTransition: "portable", portableHandoff: true,
};

export function getProviderDefinition(instanceId: string) {
  const instance = getStoredInstance(instanceId);
  const adapter = instance && getNativeProviderAdapter(instance.driver);
  return instance && adapter ? { ...adapter.definition, instanceId, label: instance.label } : null;
}

/** Configuration secrets never become status/log content. */
export function sanitizeProviderMessage(instance: StoredProviderInstance, text: string): string {
  let result = text;
  const fields = getNativeProviderAdapter(instance.driver)?.definition.fields ?? [];
  const secrets = [...Object.values(instance.env), ...fields.filter(field => field.type === "password")
    .map(field => instance.config[field.key]).filter((value): value is string => typeof value === "string")];
  for (const secret of secrets) if (secret.length >= 4) result = result.split(secret).join("[redacted]");
  return sanitizeErrorText(result);
}

/** Source built-ins, revision-bound discovery and explicit registrations share one selection boundary. */
export function getProviderModels(instanceId: string): ProviderModel[] {
  const instance = getStoredInstance(instanceId);
  const adapter = instance && getNativeProviderAdapter(instance.driver);
  if (!instance || !adapter || !instance.enabled) return [];
  const models = new Map<string, ProviderModel>();
  for (const model of adapter.definition.models ?? []) models.set(model.id, { ...model, source: "builtin" });
  if (instance.observations?.instanceRevision === instance.revision)
    for (const model of instance.observations.discoveredModels ?? []) models.set(model.id, { ...model, source: model.source ?? "discovered" });
  const current = observations.get(cacheKey(instanceId));
  if (current?.revision === instance.revision)
    for (const model of current.status.models) models.set(model.id, { ...model, source: model.source ?? "discovered" });
  for (const model of instance.customModels ?? []) {
    const known = models.get(model.id);
    models.set(model.id, { ...model, source: "custom", temperature: known?.temperature ?? false, reasoning: known?.reasoning ?? false });
  }
  return [...models.values()];
}

export function resolveCatalogModel(instanceId: string, modelId: string): ProviderModel {
  const instance = getStoredInstance(instanceId);
  if (!instance || !getNativeProviderAdapter(instance.driver))
    throw Object.assign(new Error("所选原生 Agent 已删除或不再受支持，请明确重新选择。"), { status: 400, code: "unknown_provider" });
  if (!instance.enabled)
    throw Object.assign(new Error("所选 Agent 已停用，请先明确启用或重新选择。"), { status: 409, code: "provider_disabled" });
  const model = getProviderModels(instanceId).find(entry => entry.id === modelId);
  if (!model)
    throw Object.assign(new Error("所选模型未登记或已移除，请在提供商设置登记或明确选择其他模型。"), { status: 400, code: "invalid_model" });
  return model;
}

export async function readNativeProviderStatus(instanceId: string): Promise<ProviderDriverStatus> {
  const instance = getStoredInstance(instanceId);
  const adapter = instance && getNativeProviderAdapter(instance.driver);
  if (!instance || !adapter) throw new Error("Unknown native Agent instance.");
  if (!instance.enabled) throw Object.assign(new Error("Agent instance is disabled."), { status: 409 });
  const key = cacheKey(instanceId);
  const pending = checks.get(key);
  if (pending?.revision === instance.revision) return pending.promise;
  const promise = adapter.check(providerContext(instance), AbortSignal.timeout(30_000)).then(status => {
    if (getStoredInstance(instanceId)?.revision !== instance.revision)
      throw Object.assign(new Error("Agent configuration changed during status inspection."), { status: 409 });
    const safe: ProviderDriverStatus = {
      ...status,
      ...(status.message ? { message: sanitizeProviderMessage(instance, status.message) } : {}),
      installation: {
        ...status.installation,
        ...(status.installation.error ? { error: sanitizeProviderMessage(instance, status.installation.error) } : {}),
      },
    };
    observations.set(key, { revision: instance.revision, status: safe });
    return safe;
  }).finally(() => {
    if (checks.get(key)?.promise === promise) checks.delete(key);
  });
  checks.set(key, { revision: instance.revision, promise });
  return promise;
}

export async function probeProviderInstance(instanceId: string): Promise<ProviderInstance> {
  const instance = getStoredInstance(instanceId);
  const adapter = instance && getNativeProviderAdapter(instance.driver);
  if (!instance || !adapter) throw new Error("Unknown native Agent instance.");
  const common = {
    ...publicInstanceConfig(instance), authMode: "agent" as const,
    modelsSource: "mixed" as const, capabilities: portableCapabilities,
    ...(adapter.definition.docsUrl ? { docsUrl: adapter.definition.docsUrl } : {}),
    ...(instance.observations?.lastConnectionTest ? { lastConnectionTest: instance.observations.lastConnectionTest } : {}),
  };
  if (!instance.enabled) return {
    ...common, models: [], authStatus: "unknown", configured: false, credentialSource: null,
    canLogin: false, canLogout: false, authMethods: [], message: "此 Agent 已停用；没有启动检查、登录或执行。",
  };
  try {
    const status = await readNativeProviderStatus(instanceId);
    const installed = status.installation.status === "installed" || status.installation.status === "not-applicable";
    return {
      ...common, models: getProviderModels(instanceId), installation: status.installation,
      authStatus: status.installation.status === "not-installed" ? "not-installed" : status.authentication,
      // Some native protocols deliberately do not expose authentication status.
      // Installed + unknown permits an explicit attempt, never claims a verified login.
      configured: installed && status.authentication !== "unauthenticated",
      credentialSource: status.authentication === "authenticated" ? "provider" : null,
      canLogin: installed && status.methods.length > 0, canLogout: status.canLogout,
      authMethods: status.methods,
      ...(status.methods[0] ? { loginMethod: status.methods[0].type } : {}),
      ...(status.authLabel ? { authLabel: status.authLabel } : {}),
      ...(status.email ? { email: status.email } : {}),
      ...(status.message ? { message: status.message } : {}),
      ...(status.capabilities ? { capabilities: status.capabilities } : {}),
      authCheckedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      ...common, models: getProviderModels(instanceId), authStatus: "unknown", configured: false,
      credentialSource: null, canLogin: false, canLogout: false, authMethods: [],
      installation: { status: "unknown", checkedAt: new Date().toISOString() },
      message: sanitizeProviderMessage(instance, error instanceof Error ? error.message : "原生 Agent 检查失败；未推断安装或登录状态。"),
    };
  }
}

export async function listProviderInstances(): Promise<ProviderInstance[]> {
  return Promise.all(listStoredInstances().filter(instance => getNativeProviderAdapter(instance.driver))
    .map(instance => probeProviderInstance(instance.instanceId)));
}
