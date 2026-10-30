// Adapted from t3code UsageProviderSettings and UsagePriceOverrides.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { useEffect, useState, type FormEvent } from "react";
import { WorkspaceClientError } from "@agent-workspace/client-runtime";
import type { UsageLimitSourceView, UsageSettings } from "@agent-workspace/contracts/usage";
import { SettingsNotice, SettingsSection, useSettingsGuard } from "../settings/settings-layout";
import { useAgentText } from "../i18n";
import { agentText } from "../i18n-text.ts";
import { usageApi } from "./api";
import { settingsDraft, settingsPatch, sourceDraft, sourceInput, type SettingsDraft, type SourceDraft } from "./usage-settings-draft";
import "./usage-settings.css";

function conflict(error: unknown) { return error instanceof WorkspaceClientError && error.status === 409; }
function message(error: unknown) { return error instanceof Error ? error.message : agentText("请求失败，请重试。", "The request failed. Please retry."); }

function PriceSettings() {
  const t = useAgentText();
  const [base, setBase] = useState<UsageSettings | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasConflict, setHasConflict] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const { setGuard } = useSettingsGuard();
  const dirty = !!base && !!draft && JSON.stringify(settingsDraft(base)) !== JSON.stringify(draft);
  useEffect(() => { setGuard(busy ? "busy" : dirty ? "dirty" : "clean"); }, [busy, dirty, setGuard]);
  useEffect(() => { let active = true; usageApi.settings().then((value) => { if (active) { setBase(value); setRevision(value.revision); setDraft(settingsDraft(value)); } }, (reason: unknown) => { if (active) setError(message(reason)); }); return () => { active = false; }; }, []);

  async function reloadRevision() {
    setBusy(true); setError(null);
    try {
      const latest = await usageApi.settings();
      if (!base || !draft) { setBase(latest); setDraft(settingsDraft(latest)); }
      setRevision(latest.revision); setHasConflict(false);
      setNotice(base ? t("已读取最新 revision，草稿保持不变。重试仅提交本次编辑，可能覆盖同一模型的并发修改。", "Loaded the latest revision; the draft is unchanged. Retrying submits only this edit and may overwrite concurrent changes to the same model.") : null);
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!base || !draft || revision === null || busy) return;
    setError(null); setNotice(null);
    let patch;
    try { patch = settingsPatch(base, draft, revision); } catch (reason) { setError(message(reason)); return; }
    setBusy(true);
    try { const saved = await usageApi.updateSettings(patch); setBase(saved); setRevision(saved.revision); setDraft(settingsDraft(saved)); setHasConflict(false); setNotice(t("用量设置已保存。", "Usage settings saved.")); }
    catch (reason) { setHasConflict(conflict(reason)); setError(conflict(reason) ? t("设置已在其他位置更改。草稿已保留；请读取最新 revision 后检查并重试。", "Settings changed elsewhere. Your draft is kept; load the latest revision, review, and retry.") : message(reason)); }
    finally { setBusy(false); }
  }
  return <SettingsSection title={t("模型价格、别名与 Cursor", "Model pricing, aliases, and Cursor")} scope="service">
    {error && <SettingsNotice kind="error">{error}</SettingsNotice>}
    {notice && <SettingsNotice kind="info">{notice}</SettingsNotice>}
    {(!draft || hasConflict) && <button type="button" className="usage-settings-button" disabled={busy} onClick={() => void reloadRevision()}>{hasConflict ? t("重新读取 revision（保留草稿）", "Reload revision (keep draft)") : t("重试读取设置", "Retry loading settings")}</button>}
    {draft && <form className="usage-settings-form" onSubmit={(event) => void save(event)}>
      <fieldset disabled={busy}>
        <label className="usage-settings-check"><input type="checkbox" checked={draft.cursorKeychainUsageEnabled} onChange={(event) => setDraft({ ...draft, cursorKeychainUsageEnabled: event.target.checked })} />{t("允许读取 Cursor Keychain 用量", "Allow reading Cursor Keychain usage")}</label>
        <p className="usage-settings-help">{t("仅 macOS 且 Cursor 使用默认端点、持久 CLI 登录时支持 Keychain；其他平台不可使用 Keychain，系统可能请求授权。不会自动发现或导入全局凭据。", "Keychain is supported only on macOS when Cursor uses the default endpoint and a persistent CLI login; other platforms cannot use Keychain and the system may request authorization. Global credentials are never discovered or imported automatically.")}</p>
        <h3>{t("模型价格（美元 / 百万 tokens）", "Model prices (USD per million tokens)")}</h3>
        <p className="usage-settings-help">{t("留空的缓存读取 / 写入价格使用输入价格；填写 0 表示免费。模型 ID 可以是未知模型。", "Empty cache read/write prices fall back to the input price; 0 means free. Model IDs may be unknown models.")}</p>
        {draft.prices.length === 0 && <p className="usage-settings-help">{t("没有自定义价格。", "No custom prices.")}</p>}
        {draft.prices.map((row, index) => <div className="usage-settings-row" key={index}>
          {([['model', t("模型 ID", "Model ID"), 'text'], ['input', t("输入价格", "Input price"), 'number'], ['output', t("输出价格", "Output price"), 'number'], ['cacheRead', t("缓存读取（可选）", "Cache read (optional)"), 'number'], ['cacheWrite', t("缓存写入（可选）", "Cache write (optional)"), 'number']] as const).map(([field, label, type]) => <label key={field}>{label}<input type={type} min={type === 'number' ? 0 : undefined} step={type === 'number' ? 'any' : undefined} required={field === 'model' || field === 'input' || field === 'output'} value={row[field]} onChange={(event) => setDraft({ ...draft, prices: draft.prices.map((item, i) => i === index ? { ...item, [field]: event.target.value } : item) })} /></label>)}
          <button type="button" className="usage-settings-button" aria-label={t(`删除价格 ${row.model || index + 1}`, `Delete price ${row.model || index + 1}`)} onClick={() => setDraft({ ...draft, prices: draft.prices.filter((_, i) => i !== index) })}>{t("删除价格", "Delete price")}</button>
        </div>)}
        <button type="button" className="usage-settings-button" onClick={() => setDraft({ ...draft, prices: [...draft.prices, { model: "", input: "", output: "", cacheRead: "", cacheWrite: "" }] })}>{t("添加模型价格", "Add model price")}</button>
        <h3>{t("模型别名", "Model aliases")}</h3><p className="usage-settings-help">{t("将实际模型 ID 映射到定价模型 ID；循环映射会被拒绝。", "Map an actual model ID to a pricing model ID; cyclic mappings are rejected.")}</p>
        {draft.aliases.length === 0 && <p className="usage-settings-help">{t("没有模型别名。", "No model aliases.")}</p>}
        {draft.aliases.map((row, index) => <div className="usage-settings-row usage-settings-alias" key={index}>
          <label>{t("模型 ID", "Model ID")}<input required value={row.model} onChange={(event) => setDraft({ ...draft, aliases: draft.aliases.map((item, i) => i === index ? { ...item, model: event.target.value } : item) })} /></label>
          <label>{t("目标模型 ID", "Target model ID")}<input required value={row.target} onChange={(event) => setDraft({ ...draft, aliases: draft.aliases.map((item, i) => i === index ? { ...item, target: event.target.value } : item) })} /></label>
          <button type="button" className="usage-settings-button" aria-label={t(`删除别名 ${row.model || index + 1}`, `Delete alias ${row.model || index + 1}`)} onClick={() => setDraft({ ...draft, aliases: draft.aliases.filter((_, i) => i !== index) })}>{t("删除别名", "Delete alias")}</button>
        </div>)}
        <button type="button" className="usage-settings-button" onClick={() => setDraft({ ...draft, aliases: [...draft.aliases, { model: "", target: "" }] })}>{t("添加模型别名", "Add model alias")}</button>
        <div className="usage-settings-actions"><button className="usage-settings-button usage-settings-primary" type="submit" disabled={!dirty || hasConflict}>{t("保存用量设置", "Save usage settings")}</button><button className="usage-settings-button" type="button" disabled={!dirty} onClick={() => { if (base && window.confirm(t("放弃未保存的用量设置？", "Discard unsaved usage settings?"))) { setDraft(settingsDraft(base)); setNotice(null); } }}>{t("放弃更改", "Discard changes")}</button></div>
      </fieldset>
    </form>}
  </SettingsSection>;
}

function HubForm({ source, onSaved, onDeleted, onCancel }: { source?: UsageLimitSourceView; onSaved: (source: UsageLimitSourceView) => void; onDeleted?: (id: string) => void; onCancel?: () => void }) {
  const t = useAgentText();
  const [current, setCurrent] = useState(source);
  const [draft, setDraft] = useState<SourceDraft>(() => sourceDraft(source));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasConflict, setHasConflict] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const { setGuard } = useSettingsGuard();
  const dirty = JSON.stringify(draft) !== JSON.stringify(sourceDraft(source));
  useEffect(() => { setGuard(busy ? "busy" : dirty ? "dirty" : "clean"); }, [busy, dirty, setGuard]);
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const value = current ? await usageApi.updateSource(current.id, sourceInput(draft, current.revision)) : await usageApi.createSource(sourceInput(draft));
      setCurrent(value); setDraft(sourceDraft(value)); setHasConflict(false); onSaved(value); setNotice(t("Hub 已保存。管理密钥不会回显。", "Hub saved. The management key is never echoed."));
    } catch (reason) { setHasConflict(conflict(reason)); setError(conflict(reason) ? t("Hub 已在其他位置更改。草稿已保留，请重新读取 revision。", "The Hub changed elsewhere. Your draft is kept; reload the revision.") : t("无法保存 Hub。请检查 URL、密钥和启用状态后重试；启用的 Hub 必须有管理密钥。URL 须为 HTTPS（本机回环可用 HTTP），且不能包含凭据、查询或片段。", "Could not save the Hub. Check the URL, key, and enabled state and retry; an enabled Hub requires a management key. The URL must be HTTPS (HTTP is allowed for local loopback) and must not contain credentials, a query, or a fragment.")); }
    finally { setBusy(false); }
  }
  async function reloadRevision() {
    if (!current) return;
    setBusy(true); setError(null);
    try {
      const latest = (await usageApi.sources()).find((item) => item.id === current.id);
      if (!latest) { setError(t("此 Hub 已被删除；草稿仍保留，请复制所需配置后取消。", "This Hub has been deleted; the draft is kept. Copy any needed configuration, then cancel.")); return; }
      setCurrent(latest); setHasConflict(false); setNotice(t("已读取最新 revision，草稿保持不变。重试将覆盖此 Hub 的并发配置更改。", "Loaded the latest revision; the draft is unchanged. Retrying will overwrite concurrent configuration changes to this Hub."));
    } catch { setError(t("读取 Hub 失败，草稿仍保留。", "Failed to load the Hub; the draft is kept.")); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!current || busy || !window.confirm(t(`删除 Hub「${current.label}」及其本机保存的密钥？不会删除远端 Hub。`, `Delete Hub "${current.label}" and its locally saved key? The remote Hub is not deleted.`))) return;
    setBusy(true); setError(null);
    try { await usageApi.deleteSource(current.id, current.revision); onDeleted?.(current.id); }
    catch (reason) { setHasConflict(conflict(reason)); setError(conflict(reason) ? t("Hub 已在其他位置更改；请重新读取 revision 后再删除。", "The Hub changed elsewhere; reload the revision before deleting.") : t("删除 Hub 失败，请重试。", "Failed to delete the Hub. Please retry.")); }
    finally { setBusy(false); }
  }
  return <form className="usage-settings-hub" onSubmit={(event) => void save(event)}>
    <h3>{current ? current.label : t("添加 CLIProxyAPI Hub", "Add CLIProxyAPI Hub")}</h3>
    {error && <SettingsNotice kind="error">{error}</SettingsNotice>}{notice && <SettingsNotice kind="info">{notice}</SettingsNotice>}
    {hasConflict && <button className="usage-settings-button" type="button" disabled={busy} onClick={() => void reloadRevision()}>{t("重新读取 revision（保留草稿）", "Reload revision (keep draft)")}</button>}
    <fieldset disabled={busy}>
      <div className="usage-settings-hub-fields">
        <label>{t("名称", "Name")}<input required maxLength={200} value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} /></label>
        <label>Hub URL<input required type="url" maxLength={2048} placeholder="https://example.com" value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} /></label>
        <label>{t("管理密钥", "Management key")}<input type="password" autoComplete="new-password" maxLength={16000} value={draft.managementKey} disabled={draft.clearManagementKey} onChange={(event) => setDraft({ ...draft, managementKey: event.target.value })} placeholder={current?.managementKeyConfigured ? t("已配置；留空保留", "Configured; leave empty to keep") : t("未配置", "Not configured")} /></label>
      </div>
      <p className="usage-settings-help">{t("密钥只写入，不会回显；留空保留原密钥。", "The key is write-only and never echoed; leave it empty to keep the current key.")}{current?.managementKeyConfigured ? t("当前已配置密钥。", "A key is currently configured.") : t("当前未配置密钥。", "No key is currently configured.")}</p>
      <label className="usage-settings-check"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />{t("启用 Hub", "Enable Hub")}</label>
      {current?.managementKeyConfigured && <label className="usage-settings-check"><input type="checkbox" checked={draft.clearManagementKey} onChange={(event) => setDraft({ ...draft, clearManagementKey: event.target.checked, managementKey: event.target.checked ? "" : draft.managementKey })} />{t("明确清除已保存的管理密钥（须先停用 Hub）", "Explicitly clear the saved management key (disable the Hub first)")}</label>}
      <div className="usage-settings-actions"><button className="usage-settings-button usage-settings-primary" type="submit" disabled={hasConflict || (!!current && !dirty)}>{t("保存 Hub", "Save Hub")}</button>
        {current && <button className="usage-settings-button" type="button" disabled={hasConflict} onClick={() => void remove()}>{t("删除 Hub", "Delete Hub")}</button>}
        {onCancel && <button className="usage-settings-button" type="button" onClick={() => { if (!dirty || window.confirm(t("放弃尚未保存的 Hub 草稿？", "Discard the unsaved Hub draft?"))) onCancel(); }}>{t("取消", "Cancel")}</button>}
      </div>
    </fieldset>
  </form>;
}

function HubSettings() {
  const t = useAgentText();
  const [sources, setSources] = useState<UsageLimitSourceView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  async function load() { setError(null); try { setSources(await usageApi.sources()); } catch { setError(t("无法读取用量 Hub，请重试。", "Could not load usage Hubs. Please retry.")); } }
  useEffect(() => { void load(); }, []);
  function saved(value: UsageLimitSourceView) { setSources((old) => [...(old ?? []).filter((item) => item.id !== value.id), value]); setAdding(false); }
  return <SettingsSection title={t("Usage providers · CLIProxyAPI hubs", "Usage providers · CLIProxyAPI hubs")} scope="service">
    {error && <SettingsNotice kind="error" onRetry={() => void load()}>{error}</SettingsNotice>}
    {!sources && !error && <SettingsNotice kind="loading">{t("正在读取 Hub。", "Loading Hubs.")}</SettingsNotice>}
    {sources && <>{sources.length === 0 && <p className="usage-settings-help">{t("尚未配置 Hub。", "No Hubs configured yet.")}</p>}{sources.map((source) => <HubForm key={source.id} source={source} onSaved={saved} onDeleted={(id) => setSources((old) => old?.filter((item) => item.id !== id) ?? [])} />)}
      {adding ? <HubForm onSaved={saved} onCancel={() => setAdding(false)} /> : <button type="button" className="usage-settings-button" onClick={() => setAdding(true)}>{t("添加 Hub", "Add Hub")}</button>}</>}
  </SettingsSection>;
}

export default function UsageSettings() { return <div className="usage-settings"><HubSettings /><PriceSettings /></div>; }
