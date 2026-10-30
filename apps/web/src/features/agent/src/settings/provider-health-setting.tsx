import { useEffect, useState } from "react";
import { Button } from "@agent/components/ui/button";
import { Input } from "@agent/components/ui/input";
import type { ProviderSettings } from "@agent-workspace/contracts/provider";
import { workspaceClient } from "@agent/src/network";
import { useSettingsGuard } from "./settings-layout";
import { useAgentText } from "../i18n";

export function ProviderHealthSetting() {
  const t = useAgentText();
  const [settings, setSettings] = useState<ProviderSettings | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { setGuard } = useSettingsGuard();
  const dirty = settings !== null && value !== String(settings.healthRefreshIntervalSeconds);
  useEffect(() => { let active = true; workspaceClient.json<ProviderSettings>("/api/providers/settings").then((next) => { if (active) { setSettings(next); setValue(String(next.healthRefreshIntervalSeconds)); } }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : t("无法读取健康检查间隔。", "Could not read the health check interval.")); }); return () => { active = false; }; }, []);
  useEffect(() => { setGuard(busy ? "busy" : dirty ? "dirty" : "clean"); return () => setGuard("clean"); }, [busy, dirty, setGuard]);
  async function reload() {
    if (dirty && !window.confirm(t("放弃健康检查间隔草稿并重新读取？", "Discard the health check interval draft and reload?"))) return;
    setBusy(true); setError(null);
    try { const next = await workspaceClient.json<ProviderSettings>("/api/providers/settings"); setSettings(next); setValue(String(next.healthRefreshIntervalSeconds)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("无法读取健康检查间隔。", "Could not read the health check interval.")); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!settings || !Number.isInteger(Number(value)) || value.trim() === "" || Number(value) < 0) { setError(t("请输入非负整数秒数。", "Enter a non-negative whole number of seconds.")); return; }
    setBusy(true); setError(null);
    try { const next = await workspaceClient.json<ProviderSettings>("/api/providers/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: settings.revision, healthRefreshIntervalSeconds: Number(value) }) }); setSettings(next); setValue(String(next.healthRefreshIntervalSeconds)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("保存失败。", "Save failed.")); }
    finally { setBusy(false); }
  }
  return <div className="provider-health-setting"><label htmlFor="provider-health-interval">{t("健康检查间隔（秒）", "Health check interval (seconds)")}</label><span>{t("自动刷新可用性、版本和认证状态；0 为关闭。", "Automatically refresh availability, version and authentication; 0 disables it.")}</span><Input id="provider-health-interval" type="number" min={0} step={1} value={value} disabled={!settings || busy} onChange={(event) => setValue(event.target.value)} /><Button type="button" size="sm" variant="outline" disabled={!dirty || busy} onClick={() => void save()}>{t("保存", "Save")}</Button>{dirty && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setValue(String(settings?.healthRefreshIntervalSeconds ?? 0)); setError(null); }}>{t("放弃", "Discard")}</Button>}{error && <p role="alert">{error} <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void reload()}>重新读取</Button></p>}</div>;
}
