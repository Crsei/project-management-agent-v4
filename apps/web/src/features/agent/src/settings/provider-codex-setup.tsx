import { useEffect, useState } from "react";
import { Button } from "@agent/components/ui/button";
import type { ProviderInstance, ProviderInstanceUpdate } from "@agent-workspace/contracts/provider";
import { workspaceClient } from "@agent/src/network";
import { useSettingsGuard } from "./settings-layout";
import { useAgentText } from "../i18n";

type Profile = { id: string; email: string | null; active: boolean; connected: boolean };
export function ProviderCodexSetup({ provider, onBeforeAction, onBusyChange, onUpdate, onSaved, onRefresh, onAuth, onLogout }: {
  provider: ProviderInstance;
  onBeforeAction: () => boolean;
  onBusyChange: (busy: boolean) => void;
  onUpdate: (id: string, input: ProviderInstanceUpdate & { revision?: number }) => Promise<ProviderInstance>;
  onSaved: (provider: ProviderInstance) => void;
  onRefresh: () => Promise<void>;
  onAuth: (provider: ProviderInstance, methodId: string) => void;
  onLogout: (instanceId: string) => Promise<void>;
}) {
  const t = useAgentText();
  const managed = provider.config.setupMode === "managed";
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { setGuard } = useSettingsGuard();
  const path = `/api/providers/${encodeURIComponent(provider.instanceId)}/codex/profiles`;
  useEffect(() => { setGuard(busy ? "busy" : "clean"); onBusyChange(busy); return () => { setGuard("clean"); onBusyChange(false); }; }, [busy, setGuard, onBusyChange]);
  useEffect(() => { if (!managed || !provider.enabled) { setProfiles([]); setError(null); return; } let active = true; workspaceClient.json<{ profiles: Profile[] }>(path).then((data) => { if (active) { setProfiles(data.profiles); setError(null); } }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : t("无法读取 ChatGPT 账号。", "Unable to load ChatGPT accounts.")); }); return () => { active = false; }; }, [managed, path, provider.enabled, provider.revision, provider.authCheckedAt]);
  async function useExistingCli() {
    if (busy || !onBeforeAction() || provider.revision === undefined) return;
    setBusy(true); setError(null);
    try { onSaved(await onUpdate(provider.instanceId, { revision: provider.revision, enabled: true, config: { setupMode: "existing" } })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("更新 Codex 设置失败。", "Failed to update Codex settings.")); }
    finally { setBusy(false); }
  }
  async function remove(profile: Profile) {
    if (busy || !onBeforeAction() || provider.revision === undefined || !window.confirm(t(`移除 ChatGPT 账号 ${profile.email ?? profile.id}？`, `Remove the ChatGPT account ${profile.email ?? profile.id}?`))) return;
    setBusy(true); setError(null);
    try {
      const data = await workspaceClient.json<{ profiles: Profile[]; revision: number }>(`${path}/${encodeURIComponent(profile.id)}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: provider.revision }) });
      setProfiles(data.profiles);
      onSaved({ ...provider, revision: data.revision, nativeSessionReady: false, configured: false, requiresOpenaiAuth: undefined, authStatus: "unknown", email: undefined, authLabel: undefined, authCheckedAt: undefined, models: [], lastConnectionTest: undefined });
      await onRefresh();
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("移除账号失败。", "Failed to remove the account.")); }
    finally { setBusy(false); }
  }
  async function select(profile: Profile) {
    if (busy || !onBeforeAction() || provider.revision === undefined) return;
    setBusy(true); setError(null);
    try {
      const data = await workspaceClient.json<{ profiles: Profile[]; revision: number }>(`${path}/${encodeURIComponent(profile.id)}/select`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: provider.revision }) });
      setProfiles(data.profiles);
      onSaved({ ...provider, revision: data.revision, nativeSessionReady: false, configured: false, requiresOpenaiAuth: undefined, authStatus: "unknown", email: undefined, authLabel: undefined, authCheckedAt: undefined, models: [], lastConnectionTest: undefined });
      await onRefresh();
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("选择账号失败。", "Failed to select the account.")); }
    finally { setBusy(false); }
  }
  async function disconnect() {
    if (busy || !onBeforeAction() || !window.confirm(t("断开当前 ChatGPT 账号？已保存的账号资料会保留。", "Disconnect the current ChatGPT account? Saved account data is preserved."))) return;
    setBusy(true); setError(null);
    try { await onLogout(provider.instanceId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("断开账号失败。", "Failed to disconnect the account.")); }
    finally { setBusy(false); }
  }
  if (!managed) return null;
  return <div className="provider-settings-group provider-codex-setup" aria-label={t("ChatGPT 账号", "ChatGPT account")}>
    {!provider.enabled && <p>{t("启用此实例后可管理 ChatGPT 账号和运行时。", "Enable this instance to manage ChatGPT accounts and the runtime.")}</p>}
    {profiles.map((profile) => <div className="provider-codex-profile" key={profile.id}>
      <span>{profile.email ?? profile.id}{profile.active ? t(" · 当前账号", " · current account") : profile.connected ? t(" · 已连接", " · connected") : t(" · 需要重新认证", " · re-authentication required")}</span>
      {profile.connected ? <Button type="button" size="sm" variant="outline" disabled={busy || !provider.enabled || profile.active || provider.revision === undefined} onClick={() => void select(profile)}>{t("选择", "Select")}</Button> : <Button type="button" size="sm" variant="outline" disabled={busy || !provider.enabled || provider.revision === undefined} onClick={() => onAuth(provider, `chatgpt-profile:${profile.id}`)}>{t("重新认证", "Re-authenticate")}</Button>}
      <Button type="button" size="sm" variant="ghost" disabled={busy || !provider.enabled || provider.revision === undefined} onClick={() => void remove(profile)}>{t("移除", "Remove")}</Button>
    </div>)}
    <Button type="button" size="sm" variant="outline" disabled={busy || !provider.enabled || provider.revision === undefined} onClick={() => onAuth(provider, "chatgpt-new")}>{profiles.length ? t("使用其他 ChatGPT 账号", "Use another ChatGPT account") : t("继续使用 ChatGPT", "Continue with ChatGPT")}</Button>
    {provider.canLogout && <Button type="button" size="sm" variant="ghost" disabled={busy || !provider.enabled} onClick={() => void disconnect()}>{t("断开账号", "Disconnect account")}</Button>}
    {provider.authStatus !== "authenticated" && <Button type="button" size="sm" variant="ghost" disabled={busy || provider.revision === undefined} onClick={() => void useExistingCli()}>{t("使用现有 CLI", "Use existing CLI")}</Button>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
