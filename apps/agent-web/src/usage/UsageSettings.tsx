// Adapted from t3code UsageProviderSettings and UsagePriceOverrides.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { useEffect, useState, type FormEvent } from "react";
import { WorkspaceClientError } from "@agent-workspace/client-runtime";
import type { UsageLimitSourceView, UsageSettings } from "@agent-workspace/contracts/usage";
import { SettingsNotice, SettingsSection, useSettingsGuard } from "../settings/settings-layout";
import { usageApi } from "./api";
import { settingsDraft, settingsPatch, sourceDraft, sourceInput, type SettingsDraft, type SourceDraft } from "./usage-settings-draft";
import "./usage-settings.css";

function conflict(error: unknown) { return error instanceof WorkspaceClientError && error.status === 409; }
function message(error: unknown) { return error instanceof Error ? error.message : "请求失败，请重试。"; }

function PriceSettings() {
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
      setNotice(base ? "已读取最新 revision，草稿保持不变。重试仅提交本次编辑，可能覆盖同一模型的并发修改。" : null);
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!base || !draft || revision === null || busy) return;
    setError(null); setNotice(null);
    let patch;
    try { patch = settingsPatch(base, draft, revision); } catch (reason) { setError(message(reason)); return; }
    setBusy(true);
    try { const saved = await usageApi.updateSettings(patch); setBase(saved); setRevision(saved.revision); setDraft(settingsDraft(saved)); setHasConflict(false); setNotice("用量设置已保存。"); }
    catch (reason) { setHasConflict(conflict(reason)); setError(conflict(reason) ? "设置已在其他位置更改。草稿已保留；请读取最新 revision 后检查并重试。" : message(reason)); }
    finally { setBusy(false); }
  }
  return <SettingsSection title="模型价格、别名与 Cursor" scope="service" description="自定义未知模型或覆盖公开价格；费用是 API 等价估算，不是账单。">
    {error && <SettingsNotice kind="error">{error}</SettingsNotice>}
    {notice && <SettingsNotice kind="info">{notice}</SettingsNotice>}
    {(!draft || hasConflict) && <button type="button" className="usage-settings-button" disabled={busy} onClick={() => void reloadRevision()}>{hasConflict ? "重新读取 revision（保留草稿）" : "重试读取设置"}</button>}
    {draft && <form className="usage-settings-form" onSubmit={(event) => void save(event)}>
      <fieldset disabled={busy}>
        <label className="usage-settings-check"><input type="checkbox" checked={draft.cursorKeychainUsageEnabled} onChange={(event) => setDraft({ ...draft, cursorKeychainUsageEnabled: event.target.checked })} />允许读取 Cursor Keychain 用量</label>
        <p className="usage-settings-help">仅 macOS 且 Cursor 使用默认端点、持久 CLI 登录时支持 Keychain；其他平台不可使用 Keychain，系统可能请求授权。不会自动发现或导入全局凭据。</p>
        <h3>模型价格（美元 / 百万 tokens）</h3>
        <p className="usage-settings-help">留空的缓存读取 / 写入价格使用输入价格；填写 0 表示免费。模型 ID 可以是未知模型。</p>
        {draft.prices.length === 0 && <p className="usage-settings-help">没有自定义价格。</p>}
        {draft.prices.map((row, index) => <div className="usage-settings-row" key={index}>
          {([['model', '模型 ID', 'text'], ['input', '输入价格', 'number'], ['output', '输出价格', 'number'], ['cacheRead', '缓存读取（可选）', 'number'], ['cacheWrite', '缓存写入（可选）', 'number']] as const).map(([field, label, type]) => <label key={field}>{label}<input type={type} min={type === 'number' ? 0 : undefined} step={type === 'number' ? 'any' : undefined} required={field === 'model' || field === 'input' || field === 'output'} value={row[field]} onChange={(event) => setDraft({ ...draft, prices: draft.prices.map((item, i) => i === index ? { ...item, [field]: event.target.value } : item) })} /></label>)}
          <button type="button" className="usage-settings-button" aria-label={`删除价格 ${row.model || index + 1}`} onClick={() => setDraft({ ...draft, prices: draft.prices.filter((_, i) => i !== index) })}>删除价格</button>
        </div>)}
        <button type="button" className="usage-settings-button" onClick={() => setDraft({ ...draft, prices: [...draft.prices, { model: "", input: "", output: "", cacheRead: "", cacheWrite: "" }] })}>添加模型价格</button>
        <h3>模型别名</h3><p className="usage-settings-help">将实际模型 ID 映射到定价模型 ID；循环映射会被拒绝。</p>
        {draft.aliases.length === 0 && <p className="usage-settings-help">没有模型别名。</p>}
        {draft.aliases.map((row, index) => <div className="usage-settings-row usage-settings-alias" key={index}>
          <label>模型 ID<input required value={row.model} onChange={(event) => setDraft({ ...draft, aliases: draft.aliases.map((item, i) => i === index ? { ...item, model: event.target.value } : item) })} /></label>
          <label>目标模型 ID<input required value={row.target} onChange={(event) => setDraft({ ...draft, aliases: draft.aliases.map((item, i) => i === index ? { ...item, target: event.target.value } : item) })} /></label>
          <button type="button" className="usage-settings-button" aria-label={`删除别名 ${row.model || index + 1}`} onClick={() => setDraft({ ...draft, aliases: draft.aliases.filter((_, i) => i !== index) })}>删除别名</button>
        </div>)}
        <button type="button" className="usage-settings-button" onClick={() => setDraft({ ...draft, aliases: [...draft.aliases, { model: "", target: "" }] })}>添加模型别名</button>
        <div className="usage-settings-actions"><button className="usage-settings-button usage-settings-primary" type="submit" disabled={!dirty || hasConflict}>保存用量设置</button><button className="usage-settings-button" type="button" disabled={!dirty} onClick={() => { if (base && window.confirm("放弃未保存的用量设置？")) { setDraft(settingsDraft(base)); setNotice(null); } }}>放弃更改</button></div>
      </fieldset>
    </form>}
  </SettingsSection>;
}

function HubForm({ source, onSaved, onDeleted, onCancel }: { source?: UsageLimitSourceView; onSaved: (source: UsageLimitSourceView) => void; onDeleted?: (id: string) => void; onCancel?: () => void }) {
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
      setCurrent(value); setDraft(sourceDraft(value)); setHasConflict(false); onSaved(value); setNotice("Hub 已保存。管理密钥不会回显。");
    } catch (reason) { setHasConflict(conflict(reason)); setError(conflict(reason) ? "Hub 已在其他位置更改。草稿已保留，请重新读取 revision。" : "无法保存 Hub。请检查 URL、密钥和启用状态后重试；启用的 Hub 必须有管理密钥。URL 须为 HTTPS（本机回环可用 HTTP），且不能包含凭据、查询或片段。"); }
    finally { setBusy(false); }
  }
  async function reloadRevision() {
    if (!current) return;
    setBusy(true); setError(null);
    try {
      const latest = (await usageApi.sources()).find((item) => item.id === current.id);
      if (!latest) { setError("此 Hub 已被删除；草稿仍保留，请复制所需配置后取消。"); return; }
      setCurrent(latest); setHasConflict(false); setNotice("已读取最新 revision，草稿保持不变。重试将覆盖此 Hub 的并发配置更改。");
    } catch { setError("读取 Hub 失败，草稿仍保留。"); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!current || busy || !window.confirm(`删除 Hub「${current.label}」及其本机保存的密钥？不会删除远端 Hub。`)) return;
    setBusy(true); setError(null);
    try { await usageApi.deleteSource(current.id, current.revision); onDeleted?.(current.id); }
    catch (reason) { setHasConflict(conflict(reason)); setError(conflict(reason) ? "Hub 已在其他位置更改；请重新读取 revision 后再删除。" : "删除 Hub 失败，请重试。"); }
    finally { setBusy(false); }
  }
  return <form className="usage-settings-hub" onSubmit={(event) => void save(event)}>
    <h3>{current ? current.label : "添加 CLIProxyAPI Hub"}</h3>
    {error && <SettingsNotice kind="error">{error}</SettingsNotice>}{notice && <SettingsNotice kind="info">{notice}</SettingsNotice>}
    {hasConflict && <button className="usage-settings-button" type="button" disabled={busy} onClick={() => void reloadRevision()}>重新读取 revision（保留草稿）</button>}
    <fieldset disabled={busy}>
      <div className="usage-settings-hub-fields">
        <label>名称<input required maxLength={200} value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} /></label>
        <label>Hub URL<input required type="url" maxLength={2048} placeholder="https://example.com" value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} /></label>
        <label>管理密钥<input type="password" autoComplete="new-password" maxLength={16000} value={draft.managementKey} disabled={draft.clearManagementKey} onChange={(event) => setDraft({ ...draft, managementKey: event.target.value })} placeholder={current?.managementKeyConfigured ? "已配置；留空保留" : "未配置"} /></label>
      </div>
      <p className="usage-settings-help">密钥只写入，不会回显；留空保留原密钥。{current?.managementKeyConfigured ? "当前已配置密钥。" : "当前未配置密钥。"}</p>
      <label className="usage-settings-check"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />启用 Hub</label>
      {current?.managementKeyConfigured && <label className="usage-settings-check"><input type="checkbox" checked={draft.clearManagementKey} onChange={(event) => setDraft({ ...draft, clearManagementKey: event.target.checked, managementKey: event.target.checked ? "" : draft.managementKey })} />明确清除已保存的管理密钥（须先停用 Hub）</label>}
      <div className="usage-settings-actions"><button className="usage-settings-button usage-settings-primary" type="submit" disabled={hasConflict || (!!current && !dirty)}>保存 Hub</button>
        {current && <button className="usage-settings-button" type="button" disabled={hasConflict} onClick={() => void remove()}>删除 Hub</button>}
        {onCancel && <button className="usage-settings-button" type="button" onClick={() => { if (!dirty || window.confirm("放弃尚未保存的 Hub 草稿？")) onCancel(); }}>取消</button>}
      </div>
    </fieldset>
  </form>;
}

function HubSettings() {
  const [sources, setSources] = useState<UsageLimitSourceView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  async function load() { setError(null); try { setSources(await usageApi.sources()); } catch { setError("无法读取用量 Hub，请重试。"); } }
  useEffect(() => { void load(); }, []);
  function saved(value: UsageLimitSourceView) { setSources((old) => [...(old ?? []).filter((item) => item.id !== value.id), value]); setAdding(false); }
  return <SettingsSection title="Usage providers · CLIProxyAPI hubs" scope="service" description="Hub 仅用于读取额度；管理密钥由本机服务保存，删除不会修改远端服务。">
    {error && <SettingsNotice kind="error" onRetry={() => void load()}>{error}</SettingsNotice>}
    {!sources && !error && <SettingsNotice kind="loading">正在读取 Hub。</SettingsNotice>}
    {sources && <>{sources.length === 0 && <p className="usage-settings-help">尚未配置 Hub。</p>}{sources.map((source) => <HubForm key={source.id} source={source} onSaved={saved} onDeleted={(id) => setSources((old) => old?.filter((item) => item.id !== id) ?? [])} />)}
      {adding ? <HubForm onSaved={saved} onCancel={() => setAdding(false)} /> : <button type="button" className="usage-settings-button" onClick={() => setAdding(true)}>添加 Hub</button>}</>}
  </SettingsSection>;
}

export default function UsageSettings() { return <div className="usage-settings"><HubSettings /><PriceSettings /></div>; }
