"use client";

import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { Loader2, Plus, Search, Trash2, Undo2, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ProviderConfigField, ProviderConfigInput, ProviderDriver, ProviderDriverDefinition, ProviderInstance, ProviderInstanceInput, ProviderInstanceUpdate } from "@agent-workspace/contracts/provider";
import type { AcpPreparation, AcpRegistryAgent } from "@/hooks/use-providers";
import { useSettingsGuard } from "./settings-layout";

type Operations = {
  createInstance: (input: ProviderInstanceInput) => Promise<ProviderInstance>;
  updateInstance: (instanceId: string, input: ProviderInstanceUpdate & { revision?: number }) => Promise<ProviderInstance>;
  removeInstance: (instanceId: string) => Promise<void>;
  searchAcpRegistry: (query: string) => Promise<{ agents: AcpRegistryAgent[]; total: number }>;
  prepareInstance: (instanceId: string) => Promise<AcpPreparation>;
};
type FormProps = Operations & {
  drivers: ProviderDriverDefinition[];
  provider: ProviderInstance | null;
  onSaved?: (provider: ProviderInstance) => void;
  onDeleted?: () => void;
  onEditingChange?: (state: "clean" | "dirty" | "busy") => void;
};
type EnvironmentRow = { id: number; name: string; value: string };
type ConfigDraft = Record<string, string | boolean | string[] | null>;

function SettingsRow({ title, description, children, inputId }: { title: string; description?: string; children: ReactNode; inputId?: string }) {
  return <div className="provider-setting-row">
    <div>{inputId ? <label htmlFor={inputId}>{title}</label> : <span className="provider-setting-label">{title}</span>}{description && <p id={inputId ? `${inputId}-help` : undefined}>{description}</p>}</div>
    <div className="provider-setting-control">{children}</div>
  </div>;
}

export function ProviderInstanceForm({ provider, drivers, createInstance, updateInstance, removeInstance, searchAcpRegistry, prepareInstance, onSaved, onDeleted, onEditingChange }: FormProps) {
  const id = useId();
  const [baseline, setBaseline] = useState(provider);
  const initialDriver = provider?.driver ?? drivers[0]?.driver ?? "codex";
  const [driver, setDriver] = useState<ProviderDriver>(initialDriver);
  const definition = drivers.find((entry) => entry.driver === driver);
  const defaultLabel = drivers.find((entry) => entry.driver === initialDriver)?.label ?? "";
  const [label, setLabel] = useState(provider?.label ?? defaultLabel);
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [accentColor, setAccentColor] = useState(provider?.accentColor ?? "");
  const [configDraft, setConfigDraft] = useState<ConfigDraft>({});
  const [customModels, setCustomModels] = useState(provider?.customModels ?? []);
  const [environment, setEnvironment] = useState<EnvironmentRow[]>([]);
  const [removeEnv, setRemoveEnv] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [registryQuery, setRegistryQuery] = useState("");
  const [registryResults, setRegistryResults] = useState<{ agents: AcpRegistryAgent[]; total: number } | null>(null);
  const [preparation, setPreparation] = useState<AcpPreparation | null>(null);
  const { setGuard } = useSettingsGuard();
  const dirty = driver !== initialDriver || label !== (baseline?.label ?? defaultLabel) || enabled !== (baseline?.enabled ?? true) || accentColor !== (baseline?.accentColor ?? "") ||
    Object.keys(configDraft).length > 0 || environment.length > 0 || removeEnv.length > 0 || JSON.stringify(customModels) !== JSON.stringify(baseline?.customModels ?? []);

  function reset(next: ProviderInstance | null) {
    setBaseline(next);
    setDriver(next?.driver ?? initialDriver);
    setLabel(next?.label ?? defaultLabel);
    setEnabled(next?.enabled ?? true);
    setAccentColor(next?.accentColor ?? "");
    setConfigDraft({});
    setCustomModels(next?.customModels ?? []);
    setEnvironment([]);
    setRemoveEnv([]);
    setError(null);
    setConfirmDelete(false);
    setPreparation(null);
  }

  // Catalog refreshes may update a clean form, never a dirty draft's revision.
  useEffect(() => { if (baseline !== provider && !dirty && !busy) reset(provider); }, [provider, baseline, dirty, busy]);
  useEffect(() => {
    onEditingChange?.(busy ? "busy" : dirty ? "dirty" : "clean");
    return () => onEditingChange?.("clean");
  }, [dirty, busy, onEditingChange]);
  useEffect(() => {
    setGuard(busy ? "busy" : dirty ? "dirty" : "clean");
    return () => setGuard("clean");
  }, [busy, dirty, setGuard]);

  function fieldValue(field: ProviderConfigField): string | boolean | string[] {
    const value = Object.hasOwn(configDraft, field.key) ? configDraft[field.key] : baseline?.config[field.key];
    const effective = value ?? field.defaultValue;
    if (field.type === "boolean") return effective === true;
    if (field.type === "string-list") return Array.isArray(effective) ? effective : [];
    return typeof effective === "string" || typeof effective === "number" ? String(effective) : "";
  }

  function changeField(field: ProviderConfigField, value: string | boolean | string[] | null) {
    setConfigDraft((current) => {
      const next = { ...current };
      // A blank secret editor is deliberately not a deletion. Clearing is explicit.
      if (field.type === "password" && value === "") delete next[field.key];
      else {
        const empty = value === "" || (field.type === "boolean" && value === (field.defaultValue ?? false));
        const normalized = empty && field.clearWhenEmpty !== "persist" ? null : value;
        const original = baseline?.config[field.key] ?? null;
        if (!(field.type === "password" && value === null && baseline?.secretConfigKeys.includes(field.key)) && JSON.stringify(normalized) === JSON.stringify(original)) delete next[field.key];
        else next[field.key] = normalized;
      }
      return next;
    });
    setSaved(false);
    setPreparation(null);
  }

  const sourceField = definition?.fields.find((entry) => entry.key === "source");
  const localAcp = driver === "acpRegistry" && sourceField && fieldValue(sourceField) === "local";
  const fields = definition?.fields.filter((entry) => driver !== "acpRegistry" || (localAcp
    ? ["source", "commandPath", "commandArgs"].includes(entry.key)
    : entry.key !== "commandArgs")) ?? [];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !definition) return;
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      const env: Record<string, string | null> = Object.create(null);
      for (const key of removeEnv) env[key] = null;
      const names = new Set<string>();
      for (const row of environment) {
        const name = row.name.trim();
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error("环境变量名只能包含字母、数字和下划线，且不能以数字开头。");
        if (names.has(name)) throw new Error(`环境变量 ${name} 重复，请合并后保存。`);
        names.add(name);
        env[name] = row.value;
      }
      const config: ProviderConfigInput = {};
      for (const field of fields) {
        const value = configDraft[field.key];
        if (value === undefined) continue;
        if (field.type === "number" && value !== null) {
          const number = Number(value);
          if (typeof value !== "string" || !value.trim() || !Number.isFinite(number) || (field.min !== undefined && number < field.min) || (field.max !== undefined && number > field.max)) throw new Error(`${field.label} 必须是有效数值。`);
          config[field.key] = number;
        } else config[field.key] = value;
      }
      const input = { label, enabled, accentColor, config, env, customModels };
      const next = provider
        ? await updateInstance(provider.instanceId, { ...input, revision: baseline?.revision })
        : await createInstance({ ...input, driver });
      reset(next);
      setSaved(true);
      onSaved?.(next);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存实例失败。"); }
    finally { setBusy(false); }
  }

  async function deleteInstance() {
    if (!provider || busy) return;
    setError(null);
    setBusy(true);
    try { await removeInstance(provider.instanceId); setEnvironment([]); onDeleted?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "删除实例失败。"); }
    finally { setBusy(false); }
  }

  async function searchRegistry() {
    setBusy(true);
    setError(null);
    try { setRegistryResults(await searchAcpRegistry(registryQuery)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取 ACP Registry。"); }
    finally { setBusy(false); }
  }

  async function prepare() {
    if (!provider || dirty) return;
    setBusy(true);
    setError(null);
    setPreparation(null);
    try { setPreparation(await prepareInstance(provider.instanceId)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "准备原生 Agent 失败。"); }
    finally { setBusy(false); }
  }

  return <form onSubmit={submit} className="provider-instance-form" autoComplete="off">
    <fieldset disabled={busy} className="provider-form-fields">
      <section className="provider-settings-section" aria-label="基本信息">
        <div className="provider-settings-group">
          {!provider && <SettingsRow title="提供商类型" description="来自服务端的原生 Agent 驱动，不创建独立模型 API 提供商。" inputId={`${id}-driver`}>
            <select id={`${id}-driver`} value={driver} onChange={(event) => {
              const next = drivers.find((entry) => entry.driver === event.target.value);
              if (!next || (dirty && !window.confirm("更换类型将放弃当前提供商草稿，继续？"))) return;
              setDriver(next.driver); setLabel(next.label); setConfigDraft({}); setEnvironment([]); setRemoveEnv([]); setCustomModels([]); setEnabled(true); setAccentColor(""); setError(null); setRegistryResults(null); setPreparation(null);
            }}>{drivers.map((entry) => <option key={entry.driver} value={entry.driver}>{entry.label}</option>)}</select>
          </SettingsRow>}
          <SettingsRow title="启用" description="停用后不能用于新的执行；历史记录与实例登录保留。" inputId={`${id}-enabled`}><input id={`${id}-enabled`} type="checkbox" role="switch" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /></SettingsRow>
          <SettingsRow title="显示名称" description="在提供商列表和对话模型选择器中显示。" inputId={`${id}-label`}><Input id={`${id}-label`} required maxLength={120} value={label} onChange={(event) => { setLabel(event.target.value); setSaved(false); }} /></SettingsRow>
          <SettingsRow title="强调色" description="留空使用驱动默认颜色。" inputId={`${id}-accent`}><div className="provider-accent-control"><Input id={`${id}-accent`} value={accentColor} onChange={(event) => setAccentColor(event.target.value)} placeholder="#RRGGBB" pattern="#[a-fA-F0-9]{6}" maxLength={7} /><input aria-label="选择强调色" type="color" value={/^#[a-f\d]{6}$/i.test(accentColor) ? accentColor : "#6b7280"} onChange={(event) => setAccentColor(event.target.value)} /><Button type="button" size="sm" variant="ghost" disabled={!accentColor} onClick={() => setAccentColor("")}>重置</Button></div></SettingsRow>
        </div>
      </section>
      <section className="provider-settings-section" aria-label="驱动配置">
        <h3>{definition?.label ?? driver} 配置</h3>
        {definition && <p className="provider-section-note">{definition.description}{definition.docsUrl && <> <a href={definition.docsUrl} target="_blank" rel="noreferrer noopener" className="underline">配置文档</a></>}</p>}
        {!definition && <p role="alert" className="provider-feedback provider-feedback-error">驱动配置元数据不可用，请重新读取提供商。</p>}
        {driver === "acpRegistry" && !localAcp && <div className="provider-registry-search">
          <label htmlFor={`${id}-registry`}>ACP Registry</label>
          <div><Input id={`${id}-registry`} value={registryQuery} onChange={(event) => setRegistryQuery(event.target.value)} placeholder="搜索注册的 ACP Agent" /><Button type="button" size="sm" variant="outline" onClick={() => void searchRegistry()}><Search aria-hidden="true" />搜索</Button></div>
          {registryResults && <div className="provider-registry-results" aria-label="ACP 搜索结果"><p role="status">共 {registryResults.total} 个匹配，显示 {registryResults.agents.length} 个。</p>{registryResults.agents.map((agent) => <button type="button" key={agent.id} onClick={() => {
            const agentId = definition?.fields.find((entry) => entry.key === "agentId");
            if (agentId) changeField(agentId, agent.id);
            if (!provider && (label === definition?.label || !label.trim())) setLabel(agent.name);
          }}><strong>{agent.name}</strong><code>{agent.id} · {agent.version}</code><span>{agent.description}</span><small>{agent.distributions.join(" / ")}</small></button>)}</div>}
          <p>选择仅填写配置。保存后点击“准备 ACP”才会在服务端下载或安装所选发行版。</p>
        </div>}
        {fields.length > 0 && <div className="provider-settings-group">{fields.map((entry) => {
          const inputId = `${id}-config-${entry.key}`;
          const value = fieldValue(entry);
          const storedSecret = baseline?.secretConfigKeys.includes(entry.key) === true;
          return <SettingsRow key={entry.key} title={entry.label} description={entry.description} inputId={inputId}>
            {entry.type === "boolean" ? <input id={inputId} type="checkbox" role="switch" checked={value === true} onChange={(event) => changeField(entry, event.target.checked)} /> : entry.type === "select" ? <select id={inputId} value={String(value)} required={entry.required} onChange={(event) => changeField(entry, event.target.value)}>
              {entry.defaultValue === undefined && <option value="">{entry.required ? "请选择" : "使用默认值"}</option>}
              {String(value) && !entry.options?.some((option) => option.value === value) && <option value={String(value)}>{String(value)}（当前配置）</option>}
              {entry.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select> : entry.type === "string-list" ? <div className="provider-string-list">
              <p>每行是一个字面量值，按顺序传递；不会拆分空格或展开 shell。</p>
              {(Array.isArray(value) ? value : []).map((item, index, items) => <div key={index}><Input aria-label={`${entry.label} ${index + 1}`} value={item} autoComplete="off" onChange={(event) => changeField(entry, items.map((current, row) => row === index ? event.target.value : current))} /><Button type="button" size="icon-sm" variant="ghost" aria-label={`移除${entry.label} ${index + 1}`} onClick={() => changeField(entry, items.filter((_, row) => row !== index))}><X aria-hidden="true" /></Button></div>)}
              <Button type="button" size="sm" variant="outline" onClick={() => changeField(entry, [...(Array.isArray(value) ? value : []), ""])}><Plus aria-hidden="true" />添加</Button>
            </div> : <Input id={inputId} aria-describedby={entry.description ? `${inputId}-help` : undefined} type={entry.type === "password" ? "password" : entry.type === "number" ? "number" : "text"} required={entry.required && !(entry.type === "password" && storedSecret && configDraft[entry.key] !== null)} min={entry.min} max={entry.max} step={entry.type === "number" ? "any" : undefined} value={String(value)} autoComplete={entry.type === "password" ? "new-password" : "off"} spellCheck={false} placeholder={entry.type === "password" && storedSecret ? "已保存 · 留空保留现有值" : entry.placeholder} onChange={(event) => changeField(entry, event.target.value)} />}
            {entry.type === "password" && storedSecret && <label className="provider-secret-clear"><input type="checkbox" checked={configDraft[entry.key] === null} onChange={(event) => {
              if (event.target.checked) changeField(entry, null);
              else setConfigDraft((current) => { const next = { ...current }; delete next[entry.key]; return next; });
            }} />保存时清除现有值</label>}
          </SettingsRow>;
        })}</div>}
        {definition?.installationAction && provider && !localAcp && <div className="provider-acp-prepare">
          <Button type="button" size="sm" variant="outline" disabled={busy || dirty} onClick={() => void prepare()}>{definition.installationAction.label}</Button>
          <p>{definition.installationAction.description}{dirty ? " 请先保存配置。" : ""}</p>
          {preparation && <p role="status">{preparation.message}{preparation.agentId && <span> · {preparation.agentId}</span>}{preparation.version && <span> · {preparation.version}</span>}{preparation.distribution && <span> · {preparation.distribution}</span>}{preparation.commandPath && <code>{preparation.commandPath}</code>}</p>}
        </div>}
        <p className="provider-section-note">登录与原生配置使用此实例的独立目录，不自动读取全局账号。工作目录由当前项目 / 工作区权限快照决定。</p>
      </section>
      <section className="provider-settings-section" aria-label="环境变量">
        <h3>环境变量</h3>
        <div className="provider-settings-group">
          <div className="provider-setting-row"><div><span className="provider-setting-label">实例变量</span><p>值仅写入本机服务端，不回传浏览器；不编辑则保持原值。</p></div><Button type="button" variant="outline" size="sm" onClick={() => setEnvironment((rows) => [...rows, { id: (rows.at(-1)?.id ?? 0) + 1, name: "", value: "" }])}><Plus aria-hidden="true" />添加变量</Button></div>
          {baseline?.envKeys?.map((key) => <div className="provider-environment-saved" key={key}><code className={removeEnv.includes(key) ? "line-through text-muted-foreground" : ""}>{key}</code><span>{removeEnv.includes(key) ? "保存后删除" : "已保存 · 值已隐藏"}</span><Button type="button" variant="ghost" size="icon-sm" aria-label={`${removeEnv.includes(key) ? "保留" : "删除"}变量 ${key}`} onClick={() => setRemoveEnv((keys) => keys.includes(key) ? keys.filter((name) => name !== key) : [...keys, key])}>{removeEnv.includes(key) ? <Undo2 aria-hidden="true" /> : <Trash2 aria-hidden="true" />}</Button></div>)}
          {environment.map((row, index) => <div className="provider-environment-draft" key={row.id}><Input aria-label={`变量名 ${index + 1}`} placeholder="VARIABLE_NAME" required value={row.name} spellCheck={false} autoComplete="off" onChange={(event) => setEnvironment((rows) => rows.map((item) => item.id === row.id ? { ...item, name: event.target.value } : item))} /><Input aria-label={`变量值 ${index + 1}`} type="password" placeholder="输入新值（仅写入）" value={row.value} autoComplete="new-password" onChange={(event) => setEnvironment((rows) => rows.map((item) => item.id === row.id ? { ...item, value: event.target.value } : item))} /><Button type="button" variant="ghost" size="icon-sm" aria-label={`移除新变量 ${index + 1}`} onClick={() => setEnvironment((rows) => rows.filter((item) => item.id !== row.id))}><X aria-hidden="true" /></Button></div>)}
        </div>
      </section>
      <section className="provider-settings-section" aria-label="登记自定义模型">
        <h3>自定义模型</h3>
        <div className="provider-settings-group">
          <div className="provider-setting-row"><div><span className="provider-setting-label">显式登记模型 ID</span><p>使用此 Agent 的真实模型 ID。登记不代表可调用；未知能力默认不支持温度或可调推理。</p></div><Button type="button" variant="outline" size="sm" disabled={customModels.length >= 100} onClick={() => setCustomModels((models) => [...models, { id: "", label: "" }])}><Plus aria-hidden="true" />添加模型</Button></div>
          {customModels.map((model, index) => <div className="provider-environment-draft" key={index}><Input aria-label={`自定义模型 ID ${index + 1}`} placeholder="模型 ID" maxLength={200} required value={model.id} spellCheck={false} onChange={(event) => setCustomModels((models) => models.map((entry, row) => row === index ? { ...entry, id: event.target.value } : entry))} /><Input aria-label={`自定义模型名称 ${index + 1}`} placeholder="显示名称" maxLength={120} required value={model.label} onChange={(event) => setCustomModels((models) => models.map((entry, row) => row === index ? { ...entry, label: event.target.value } : entry))} /><Button type="button" variant="ghost" size="icon-sm" aria-label={`移除自定义模型 ${index + 1}`} onClick={() => {
            if ((baseline?.customModels ?? []).some((entry) => entry.id === model.id) && !window.confirm("保存后移除此模型；引用它的默认设置和会话将提示重新选择，不会自动切换。确认移除？")) return;
            setCustomModels((models) => models.filter((_, row) => row !== index));
          }}><Trash2 aria-hidden="true" /></Button></div>)}
        </div>
        <p className="provider-section-note">内置、实际发现和自定义模型保持来源标识；不会用其他模型静默替换失效选择。</p>
      </section>
    </fieldset>
    {error && <p role="alert" className="provider-feedback provider-feedback-error">{error}</p>}
    {provider && dirty && baseline?.revision !== provider.revision && <p role="alert" className="provider-feedback">服务器配置已更新，当前草稿保留原版本。请放弃修改以载入最新配置，再重新编辑。</p>}
    <div className="provider-form-actions"><span role="status">{busy ? "正在处理…" : dirty ? "有未保存的修改" : saved ? "配置已保存" : ""}</span>{provider && <Button type="button" variant="ghost" size="sm" disabled={busy || !dirty} onClick={() => { reset(provider); setSaved(false); }}>放弃修改</Button>}<Button type="submit" size="sm" disabled={busy || !definition || !label.trim() || (Boolean(provider) && !dirty) || confirmDelete}>{busy && <Loader2 aria-hidden="true" className="animate-spin" />}保存配置</Button></div>
    {provider && <section className="provider-danger-zone"><div><span className="provider-setting-label">删除实例</span><p>保留历史运行与原生登录目录，不退出全局账号。</p></div><Button type="button" variant="ghost" size="sm" className="text-destructive" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 aria-hidden="true" />删除实例</Button>{confirmDelete && <div className="provider-delete-confirm" role="alert"><p>确认删除“{provider.label}”？后续对话将无法使用此实例。</p><div><Button type="button" variant="destructive" size="sm" disabled={busy} onClick={() => void deleteInstance()}>确认删除实例</Button><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmDelete(false)}>保留实例</Button></div></div>}</section>}
  </form>;
}

export function ProviderInstanceDialog({ open, onOpenChange, onCreated, drivers, ...operations }: Operations & { drivers: ProviderDriverDefinition[]; open: boolean; onOpenChange: (open: boolean) => void; onCreated: (provider: ProviderInstance) => void }) {
  const [editing, setEditing] = useState<"clean" | "dirty" | "busy">("clean");
  return <Dialog open={open} onOpenChange={(next) => {
    if (editing === "busy" || (!next && editing === "dirty" && !window.confirm("放弃尚未保存的实例配置？"))) return;
    onOpenChange(next);
  }}><DialogContent className="provider-create-dialog max-h-[90dvh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>添加提供商</DialogTitle><DialogDescription>创建原生 Agent 独立实例。配置字段与认证方式来自真实驱动；保存不执行计费推理。</DialogDescription></DialogHeader>{open && <ProviderInstanceForm provider={null} drivers={drivers} {...operations} onEditingChange={setEditing} onSaved={(provider) => { onCreated(provider); onOpenChange(false); }} />}</DialogContent></Dialog>;
}
