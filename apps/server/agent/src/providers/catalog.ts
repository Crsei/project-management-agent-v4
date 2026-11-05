import { getProviderModelShortName, getProviderSecretConfigKeys } from "@agent-workspace/client-runtime/providers";
import type { ProviderCapabilities, ProviderInstance, ProviderModel, ProviderOptionSelection } from "@agent-workspace/contracts/provider";
import { getStoredInstance, listStoredInstances, providerContext, providerDataDirectory, providerEnvironment, publicInstanceConfig, type StoredProviderInstance } from "./instances.ts";
import { getNativeProviderAdapter } from "./driver-registry.ts";
import type { ProviderDriverStatus } from "./driver-adapter.ts";
import { sanitizeErrorText } from "./verify.ts";
import { canonicalProviderModelId } from "./t3code/config-mapping.ts";
import { beginProviderStatus } from "./auth.ts";
import { OMP_STATUS_TIMEOUT_MS } from "@t3tools/provider-omp/server/status";

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
  return instance && adapter ? { ...adapter.definition, instanceId, label: instance.label || adapter.definition.label } : null;
}

/** Configuration secrets never become status/log content. */
export function sanitizeProviderMessage(instance: StoredProviderInstance, text: string): string {
  let result = text;
  const secretConfigKeys = new Set(getProviderSecretConfigKeys(instance.driver));
  const secrets = [...Object.entries(providerEnvironment(instance)).filter(([name]) => /KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i.test(name) || (Object.hasOwn(instance.env, name) && instance.envSensitivity?.[name] !== false)).map(([, value]) => value).filter((value): value is string => typeof value === "string"), ...Object.entries(instance.config).filter(([key]) => secretConfigKeys.has(key))
    .map(([, value]) => value).filter((value): value is string => typeof value === "string")];
  for (const secret of secrets) if (secret.length > 0) result = result.split(secret).join("[redacted]");
  return sanitizeErrorText(result);
}

/** Original revision-bound inventories and explicit registrations share one selection boundary. */
export function getProviderModels(instanceId: string): ProviderModel[] {
  const instance = getStoredInstance(instanceId);
  const adapter = instance && getNativeProviderAdapter(instance.driver);
  if (!instance || !adapter) return [];
  const models = new Map<string, ProviderModel>();
  const current = observations.get(cacheKey(instanceId));
  // A fresh original inventory, even an empty one, supersedes persisted discovery.
  const inventory = current?.revision === instance.revision ? current.status.models
    : instance.observations?.instanceRevision === instance.revision ? instance.observations.discoveredModels ?? [] : [];
  for (const model of inventory) models.set(model.id, { ...model, source: model.source ?? "discovered" });
  for (const model of adapter.definition.supportsCustomModels === false ? [] : instance.customModels ?? []) {
    const known = models.get(model.id);
    const capabilities = model.capabilities ?? known?.capabilities;
    models.set(model.id, { ...model, source: "custom", temperature: known?.temperature ?? false, reasoning: known?.reasoning ?? false,
      ...(capabilities === undefined ? {} : { capabilities }) });
  }
  return [...models.values()].map(model => {
    const shortName = getProviderModelShortName(instance.driver, model);
    return shortName ? { ...model, shortName } : model;
  });
}

export function resolveCatalogModel(instanceId: string, modelId: string): ProviderModel {
  const instance = getStoredInstance(instanceId);
  if (!instance || !getNativeProviderAdapter(instance.driver))
    throw Object.assign(new Error("所选原生 Agent 已删除或不再受支持，请明确重新选择。"), { status: 400, code: "unknown_provider" });
  if (!instance.enabled)
    throw Object.assign(new Error("所选 Agent 已停用，请先明确启用或重新选择。"), { status: 409, code: "provider_disabled" });
  const canonicalId = canonicalProviderModelId(instance.driver, modelId);
  const models = getProviderModels(instanceId);
  const model = models.find(entry => entry.id === modelId) ?? models.find(entry => entry.aliases?.includes(modelId) || entry.id === canonicalId);
  if (!model)
    throw Object.assign(new Error("所选模型未登记或已移除，请在提供商设置登记或明确选择其他模型。"), { status: 400, code: "invalid_model" });
  return model;
}

/** Explicit selections replace persisted preferences; omitted selections use them. */
export function resolveProviderModelOptions(instanceId: string, modelId: string, selections?: ProviderOptionSelection[]): ProviderOptionSelection[] {
  const model = resolveCatalogModel(instanceId, modelId);
  if (model.disabledReason) throw Object.assign(new Error(model.disabledReason), { status: 400 });
  const selected = selections ?? getStoredInstance(instanceId)?.modelPreferences?.options[modelId] ?? [];
  if (!Array.isArray(selected)) throw Object.assign(new Error("Invalid model options."), { status: 400 });
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  const seen = new Set<string>();
  return selected.map(selection => {
    if (!selection || typeof selection.id !== "string" || seen.has(selection.id)) throw Object.assign(new Error("Invalid or duplicate model option."), { status: 400 });
    seen.add(selection.id);
    const descriptor = descriptors.find(option => option.id === selection.id);
    if (!descriptor || (descriptor.type === "boolean" ? typeof selection.value !== "boolean" : typeof selection.value !== "string" || !descriptor.options.some(option => option.id === selection.value)))
      throw Object.assign(new Error(`Unsupported model option: ${selection.id}.`), { status: 400 });
    return { id: selection.id, value: selection.value };
  });
}

export async function readNativeProviderStatus(instanceId: string, insideAccountOperation = false): Promise<ProviderDriverStatus> {
  const instance = getStoredInstance(instanceId);
  const adapter = instance && getNativeProviderAdapter(instance.driver);
  if (!instance || !adapter) throw new Error("Unknown native Agent instance.");
  if (!instance.enabled) throw Object.assign(new Error("Agent instance is disabled."), { status: 409 });
  const key = cacheKey(instanceId);
  const pending = checks.get(key);
  if (pending?.revision === instance.revision) return pending.promise;
  const release = beginProviderStatus(instanceId, insideAccountOperation);
  const promise = Promise.resolve().then(() => adapter.check(providerContext(instance),
    AbortSignal.timeout(instance.driver === "omp" ? OMP_STATUS_TIMEOUT_MS : 30_000))).then(status => {
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
    release();
    if (checks.get(key)?.promise === promise) checks.delete(key);
  });
  checks.set(key, { revision: instance.revision, promise });
  return promise;
}

export async function probeProviderInstance(instanceId: string, insideAccountOperation = false): Promise<ProviderInstance> {
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
    ...common, models: getProviderModels(instanceId), authStatus: "unknown", nativeSessionReady: false, configured: false, credentialSource: null,
    canLogin: false, canLogout: false, authMethods: [], message: "此 Agent 已停用；没有启动检查、登录或执行。",
  };
  try {
    const status = await readNativeProviderStatus(instanceId, insideAccountOperation);
    const installed = status.installation.status === "installed" || status.installation.status === "not-applicable";
    return {
      ...common, models: getProviderModels(instanceId), installation: status.installation,
      ...(status.updateRequiredModels ? { updateRequiredModels: status.updateRequiredModels } : {}),
      authStatus: status.installation.status === "not-installed" ? "not-installed" : status.authentication,
      ...(instance.driver === "codex" && typeof status.requiresOpenaiAuth === "boolean" ? { requiresOpenaiAuth: status.requiresOpenaiAuth } : {}),
      nativeSessionReady: installed && status.nativeSessionReady === true,
      configured: installed && status.nativeSessionReady === true,
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
      ...common, models: getProviderModels(instanceId), authStatus: "unknown", nativeSessionReady: false, configured: false,
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
