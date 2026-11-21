import { getProviderModelShortName, getProviderSecretConfigKeys } from "@agent-workspace/client-runtime/providers";
import type { ProviderCapabilities, ProviderInstance, ProviderModel, ProviderOptionSelection } from "@agent-workspace/contracts/provider";
import { getStoredInstance, listStoredInstances, providerContext, providerDataDirectory, providerEnvironment, publicInstanceConfig, type StoredProviderInstance } from "./instances.ts";
import { getNativeProviderAdapter } from "./driver-registry.ts";
import type { ProviderDriverStatus } from "./driver-adapter.ts";
import { sanitizeErrorText } from "./verify.ts";
import { canonicalProviderModelId } from "./t3code/config-mapping.ts";
import { beginProviderStatus, isProviderAccountBusy } from "./auth.ts";
import { OMP_STATUS_TIMEOUT_MS } from "@t3tools/provider-omp/server/status";

type ProviderObservation = { revision: number; checkedAt: number; models: ProviderModel[]; verified: boolean } & ({ status: ProviderDriverStatus } | { error: string });
// Directory browsing alone may reuse observations; execution and explicit checks stay fresh.
export const PROVIDER_DIRECTORY_FRESHNESS_MS = 30_000;
const observations = new Map<string, ProviderObservation>();
const checks = new Map<string, { revision: number; promise: Promise<ProviderDriverStatus> }>();
const cacheKey = (instanceId: string) => `${providerDataDirectory()}\0${instanceId}`;
const portableCapabilities: ProviderCapabilities = {
  nativeResume: false, nativeFork: false, boundedFork: false,
  modelTransition: "portable", portableHandoff: true,
};

/** Account cleanup also fences an in-flight result from republishing an invalidated identity. */
export function invalidateProviderStatus(instanceId: string): void {
  const key = cacheKey(instanceId);
  observations.delete(key);
  checks.delete(key);
}

/** A failed check must not erase the last catalog: keep it for browsing while send stays blocked. */
function lastKnownModels(instance: StoredProviderInstance): ProviderModel[] {
  const previous = observations.get(cacheKey(instance.instanceId));
  // A verified result is authoritative even when empty: never resurrect a catalog it just cleared.
  if (previous?.revision === instance.revision && previous.verified) return previous.models;
  const persisted = instance.observations?.instanceRevision === instance.revision ? instance.observations.discoveredModels ?? [] : [];
  if (persisted.length > 0) return persisted;
  return previous?.revision === instance.revision ? previous.models : [];
}

function failedObservation(instance: StoredProviderInstance, error: unknown): ProviderObservation {
  const previous = observations.get(cacheKey(instance.instanceId));
  return {
    revision: instance.revision, checkedAt: Date.now(), models: lastKnownModels(instance),
    verified: previous?.revision === instance.revision && previous.verified === true,
    error: sanitizeProviderMessage(instance, error instanceof Error ? error.message : "原生 Agent 检查失败；未推断安装或登录状态。"),
  };
}
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
  const inventory = current?.revision === instance.revision ? current.models
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
  let release: () => void;
  try { release = beginProviderStatus(instanceId, insideAccountOperation); }
  catch (error) { observations.set(key, failedObservation(instance, error)); throw error; }
  const isCurrent = (): boolean => cacheKey(instanceId) === key && getStoredInstance(instanceId)?.revision === instance.revision
    && checks.get(key)?.promise === promise;
  const promise: Promise<ProviderDriverStatus> = Promise.resolve().then(() => adapter.check(providerContext(instance),
    AbortSignal.timeout(instance.driver === "omp" ? OMP_STATUS_TIMEOUT_MS : 30_000))).then(status => {
    if (!isCurrent())
      throw Object.assign(new Error("Agent configuration or account changed during status inspection."), { status: 409 });
    const safe: ProviderDriverStatus = {
      ...status,
      ...(status.message ? { message: sanitizeProviderMessage(instance, status.message) } : {}),
      installation: {
        ...status.installation,
        ...(status.installation.error ? { error: sanitizeProviderMessage(instance, status.installation.error) } : {}),
      },
    };
    // A not-ready result with no models is a failed refresh, not proof the catalog is empty.
    const previous = observations.get(key);
    const freshCatalog = safe.nativeSessionReady === true || safe.models.length > 0;
    const models = freshCatalog ? safe.models : lastKnownModels(instance);
    const observed = models === safe.models ? safe : { ...safe, models };
    observations.set(key, { revision: instance.revision, checkedAt: Date.now(), models, status: observed,
      verified: freshCatalog || (previous?.revision === instance.revision && previous.verified === true) });
    return observed;
  }).catch(error => {
    if (isCurrent()) observations.set(key, failedObservation(instance, error));
    throw error;
  }).finally(() => {
    release();
    if (checks.get(key)?.promise === promise) checks.delete(key);
  });
  checks.set(key, { revision: instance.revision, promise });
  return promise;
}

function providerInstanceSnapshot(instance: StoredProviderInstance, observation?: ProviderObservation): ProviderInstance {
  const instanceId = instance.instanceId;
  const adapter = getNativeProviderAdapter(instance.driver)!;
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
  if (observation && "status" in observation) {
    const status = observation.status;
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
      authCheckedAt: new Date(observation.checkedAt).toISOString(),
    };
  } else {
    return {
      ...common, models: getProviderModels(instanceId), authStatus: "unknown", nativeSessionReady: false, configured: false,
      credentialSource: null, canLogin: false, canLogout: false, authMethods: [],
      installation: { status: "unknown", ...(observation ? { checkedAt: new Date(observation.checkedAt).toISOString() } : {}) },
      ...(observation ? { authCheckedAt: new Date(observation.checkedAt).toISOString(), message: observation.error } : {}),
    };
  }
}

export async function probeProviderInstance(instanceId: string, insideAccountOperation = false): Promise<ProviderInstance> {
  const instance = getStoredInstance(instanceId);
  if (!instance || !getNativeProviderAdapter(instance.driver)) throw new Error("Unknown native Agent instance.");
  if (!instance.enabled) return providerInstanceSnapshot(instance);
  try {
    await readNativeProviderStatus(instanceId, insideAccountOperation);
    const observation = observations.get(cacheKey(instanceId));
    return providerInstanceSnapshot(instance, observation?.revision === instance.revision ? observation : undefined);
  } catch (error) {
    const observation = observations.get(cacheKey(instanceId));
    return providerInstanceSnapshot(instance, observation?.revision === instance.revision && "error" in observation
      ? observation : failedObservation(instance, error));
  }
}

async function readProviderDirectoryInstance(instance: StoredProviderInstance): Promise<ProviderInstance> {
  if (!instance.enabled) return providerInstanceSnapshot(instance);
  // A cached ready account is never presented as usable while credentials/installations mutate.
  if (isProviderAccountBusy(instance.instanceId))
    return { ...providerInstanceSnapshot(instance), message: "The native Agent is busy." };
  const observation = observations.get(cacheKey(instance.instanceId));
  if (observation?.revision !== instance.revision) return probeProviderInstance(instance.instanceId);
  if (Date.now() - observation.checkedAt >= PROVIDER_DIRECTORY_FRESHNESS_MS) {
    // Failure is recorded as unknown by the same fresh-check path, with the same retry window.
    void readNativeProviderStatus(instance.instanceId).catch(() => undefined);
  }
  return providerInstanceSnapshot(instance, observation);
}

export async function listProviderInstances(): Promise<ProviderInstance[]> {
  return Promise.all(listStoredInstances().filter(instance => getNativeProviderAdapter(instance.driver))
    .map(readProviderDirectoryInstance));
}
