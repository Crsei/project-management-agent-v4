import { useEffect, useState } from "react";
import { Button } from "@agent/components/ui/button";
import type { ProviderDriverDefinition, ProviderInstance, ProviderMaintenanceAction, ProviderMaintenanceState } from "@agent-workspace/contracts/provider";
import { workspaceClient } from "@agent/src/network";
import { useSettingsGuard } from "./settings-layout";
import { useAgentText } from "../i18n";

export function ProviderMaintenance({ provider, definition, onBeforeAction, onBusyChange, onRefresh }: { provider: ProviderInstance; definition?: ProviderDriverDefinition; onBeforeAction: () => boolean; onBusyChange: (busy: boolean) => void; onRefresh: () => Promise<void> }) {
  const t = useAgentText();
  const [state, setState] = useState<ProviderMaintenanceState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { setGuard } = useSettingsGuard();
  const path = `/api/providers/${encodeURIComponent(provider.instanceId)}/maintenance`;
  useEffect(() => { let active = true; workspaceClient.json<ProviderMaintenanceState>(path).then((next) => { if (active) setState(next); }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : t("无法读取维护状态。", "Could not read maintenance status.")); }); return () => { active = false; }; }, [path]);
  useEffect(() => {
    if (state?.status !== "running") return;
    let active = true, inFlight = false;
    const timer = window.setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void workspaceClient.json<ProviderMaintenanceState>(path).then((next) => { if (!active) return; setState(next); if (next.status !== "running") void onRefresh(); }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : t("无法读取维护状态。", "Could not read maintenance status.")); }).finally(() => { inFlight = false; });
    }, 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [path, state?.status, onRefresh]);
  const running = pending || state?.status === "running";
  useEffect(() => { setGuard(running ? "busy" : "clean"); onBusyChange(running); return () => { setGuard("clean"); onBusyChange(false); }; }, [running, setGuard, onBusyChange]);
  async function start(action: ProviderMaintenanceAction) {
    if (!onBeforeAction() || provider.revision === undefined) return;
    if (action === "remove" && !window.confirm(t("移除此实例的受管安装？账号目录和凭据不会删除。", "Remove the managed installation for this instance? Account directories and credentials are not deleted."))) return;
    setPending(true); setError(null);
    try {
      const next = await workspaceClient.json<ProviderMaintenanceState>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, revision: provider.revision }) });
      setState(next);
      if (next.status !== "running") await onRefresh();
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("维护操作失败。", "Maintenance action failed.")); }
    finally { setPending(false); }
  }
  async function cancel() { setPending(true); setError(null); try { setState(await workspaceClient.json<ProviderMaintenanceState>(path, { method: "DELETE" })); await onRefresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : t("取消失败。", "Cancel failed.")); } finally { setPending(false); } }
  if (provider.driver === "codex" && provider.config.setupMode !== "managed" && state?.status !== "running") return null;
  if (provider.driver === "acpRegistry" && (provider.config.source === "local" || Boolean(provider.config.commandPath)) && state?.status !== "running") return null;
  if (!definition?.installationAction && !definition?.updateAction && !definition?.removalAction && !state?.action) return null;
  const customBinary = provider.driver === "antigravity" && Boolean(provider.config.binaryPath);
  return <section className="provider-settings-section"><h3>{t("安装与维护", "Installation & maintenance")}</h3><div className="provider-settings-group provider-maintenance">
    {customBinary && <p>{t("使用自定义可执行路径时不能管理安装。请先清除该路径。", "Installation cannot be managed while a custom executable path is set. Clear it first.")}</p>}
    {provider.installation?.updateAvailable && <p>{t("发现更新", "Update available")}{provider.installation.latestVersion ? `: ${provider.installation.latestVersion}` : ""}.{provider.installation.updateSupported === false ? t("请通过原安装方式手动更新。", " Update manually using the original installation method.") : ""}</p>}
    {definition?.installationAction && <Button type="button" size="sm" variant="outline" disabled={!provider.enabled || running || customBinary || provider.revision === undefined} title={definition.installationAction.description} onClick={() => void start("install")}>{definition.installationAction.label}</Button>}
    {definition?.updateAction && <Button type="button" size="sm" variant="outline" disabled={!provider.enabled || running || customBinary || provider.revision === undefined || provider.installation?.updateSupported === false} title={definition.updateAction.description} onClick={() => void start("update")}>{definition.updateAction.label}</Button>}
    {definition?.removalAction && <Button type="button" size="sm" variant="outline" disabled={!provider.enabled || running || customBinary || provider.revision === undefined} title={definition.removalAction.description} onClick={() => void start("remove")}>{definition.removalAction.label}</Button>}
    {state?.status === "running" && <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => void cancel()}>{t("取消", "Cancel")}</Button>}
    {state && state.status !== "idle" && <p role={state.status === "failed" ? "alert" : "status"}>{state.message ?? state.status}{state.bytesDownloaded !== undefined && ` · ${state.bytesDownloaded}${state.bytesTotal !== undefined ? ` / ${state.bytesTotal}` : ""} ${t("字节", "bytes")}`}</p>}
    {state?.bytesTotal !== undefined && state.bytesDownloaded !== undefined && state.bytesTotal > 0 && <progress value={state.bytesDownloaded} max={state.bytesTotal} />}
    {error && <p role="alert">{error}</p>}
  </div></section>;
}
