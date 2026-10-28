import type { ProviderInstallation, ProviderTestResult } from "@agent-workspace/contracts/provider";
import { readNativeProviderStatus, sanitizeProviderMessage } from "./catalog.ts";
import { getStoredInstance, recordProviderObservations } from "./instances.ts";

/** Explicit native status inspection; never performs inference or installs an Agent. */
export async function checkProviderConnection(instanceId: string): Promise<ProviderTestResult> {
  const instance = getStoredInstance(instanceId);
  if (!instance) throw Object.assign(new Error("Unknown native Agent instance."), { status: 404 });
  if (!instance.enabled) throw Object.assign(new Error("Agent instance is disabled."), { status: 409 });
  const startedAt = Date.now();
  let installation: ProviderInstallation;
  let result: ProviderTestResult;
  try {
    const status = await readNativeProviderStatus(instanceId);
    installation = status.installation;
    const installed = installation.status === "installed" || installation.status === "not-applicable";
    const ok = installed && status.authentication === "authenticated";
    result = {
      ok, kind: "agent-status", authentication: status.authentication,
      latencyMs: Date.now() - startedAt, checkedAt: new Date().toISOString(), instanceRevision: instance.revision,
      models: status.models,
      ...(!ok ? { error: sanitizeProviderMessage(instance, status.message ?? (!installed
        ? "尚未确认 Agent 安装或服务状态。" : status.authentication === "unauthenticated"
          ? "原生 Agent 尚未登录。" : "Agent 未提供可独立核验的登录状态；未推断认证成功。")) } : {}),
    };
  } catch (error) {
    installation = { status: "unknown", checkedAt: new Date().toISOString() };
    result = {
      ok: false, kind: "agent-status", authentication: "unknown",
      latencyMs: Date.now() - startedAt, checkedAt: new Date().toISOString(), instanceRevision: instance.revision,
      error: sanitizeProviderMessage(instance, error instanceof Error ? error.message : "Native Agent status inspection failed."),
    };
  }
  const previous = instance.observations?.instanceRevision === instance.revision ? instance.observations : undefined;
  recordProviderObservations(instanceId, instance.revision, {
    installation, lastConnectionTest: result,
    ...(result.models?.length ? { discoveredModels: result.models }
      : previous?.discoveredModels ? { discoveredModels: previous.discoveredModels } : {}),
  });
  return result;
}
