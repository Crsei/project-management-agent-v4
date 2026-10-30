import type { ProviderInstallation, ProviderTestResult } from "@agent-workspace/contracts/provider";
import { readNativeProviderStatus, sanitizeProviderMessage } from "./catalog.ts";
import { getStoredInstance, recordProviderObservations, listStoredInstances, getProviderSettings, providerDataDirectory } from "./instances.ts";
import { requireAccountIdle } from "./auth.ts";

/** Explicit native status inspection; never performs inference or installs an Agent. */
export async function checkProviderConnection(instanceId: string): Promise<ProviderTestResult> {
  const instance = getStoredInstance(instanceId);
  if (!instance) throw Object.assign(new Error("Unknown native Agent instance."), { status: 404 });
  if (!instance.enabled) throw Object.assign(new Error("Agent instance is disabled."), { status: 409 });
  requireAccountIdle(instanceId);
  const startedAt = Date.now();
  let installation: ProviderInstallation;
  let result: ProviderTestResult;
  try {
    const status = await readNativeProviderStatus(instanceId);
    installation = status.installation;
    const installed = installation.status === "installed" || installation.status === "not-applicable";
    const ok = installed && status.nativeSessionReady === true;
    result = {
      ok, kind: "agent-status", authentication: status.authentication, nativeSessionReady: ok,
      ...(instance.driver === "codex" && typeof status.requiresOpenaiAuth === "boolean" ? { requiresOpenaiAuth: status.requiresOpenaiAuth } : {}),
      latencyMs: Date.now() - startedAt, checkedAt: new Date().toISOString(), instanceRevision: instance.revision,
      models: status.models,
      ...(!ok ? { error: sanitizeProviderMessage(instance, status.message ?? (!installed
        ? "尚未确认 Agent 安装或服务状态。" : status.authentication === "unauthenticated"
          ? "原生 Agent 尚未登录。" : status.nativeSessionReady === false ? "原生 Agent 尚未就绪；未执行推理。"
          : "Agent 未提供可独立核验的登录状态；未推断认证成功。")) } : {}),
    };
  } catch (error) {
    if (getStoredInstance(instanceId)?.revision !== instance.revision
      || (error instanceof Error && "status" in error && error.status === 409))
      throw Object.assign(new Error("Provider instance changed or became busy during status inspection."), { status: 409, code: "session_mismatch" });
    installation = { status: "unknown", checkedAt: new Date().toISOString() };
    result = {
      ok: false, kind: "agent-status", authentication: "unknown", nativeSessionReady: false,
      latencyMs: Date.now() - startedAt, checkedAt: new Date().toISOString(), instanceRevision: instance.revision,
      error: sanitizeProviderMessage(instance, error instanceof Error ? error.message : "Native Agent status inspection failed."),
    };
  }
  const previous = instance.observations?.instanceRevision === instance.revision ? instance.observations : undefined;
  recordProviderObservations(instanceId, instance.revision, {
    installation, lastConnectionTest: result,
    ...(result.models !== undefined ? { discoveredModels: result.models }
      : previous?.discoveredModels ? { discoveredModels: previous.discoveredModels } : {}),
  });
  return result;
}

const refreshInitialized = new Set<string>();
export function ensureProviderHealthRefresh(): void {
  const key = providerDataDirectory();
  if (!refreshInitialized.has(key)) { refreshInitialized.add(key); scheduleProviderHealthRefresh(); }
}
const refreshTimers = new Map<string, NodeJS.Timeout>();
/** Re-arm after configuration changes; zero disables periodic health checks. */
export function scheduleProviderHealthRefresh(): void {
  const key = providerDataDirectory();
  const previous = refreshTimers.get(key);
  clearTimeout(previous);
  refreshTimers.delete(key);
  const seconds = getProviderSettings().healthRefreshIntervalSeconds;
  if (!seconds) return;
  const timer = setTimeout(async () => {
    refreshTimers.delete(key);
    try {
      await Promise.all(listStoredInstances().filter(instance => instance.enabled).map(instance => checkProviderConnection(instance.instanceId).catch(() => undefined)));
    } finally { scheduleProviderHealthRefresh(); }
  }, Math.min(seconds * 1000, 2_147_483_647));
  timer.unref();
  refreshTimers.set(key, timer);
}
