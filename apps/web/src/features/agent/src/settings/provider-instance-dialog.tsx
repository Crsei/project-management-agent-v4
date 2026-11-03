"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Loader2, Plus, Search, Trash2, Undo2, X } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@agent/components/ui/dialog";
import { Button } from "@agent/components/ui/button";
import { Input } from "@agent/components/ui/input";
import type { ProviderConfig, ProviderConfigField, ProviderConfigInput, ProviderDriver, ProviderDriverDefinition, ProviderEnvironmentEntry, ProviderInstance, ProviderInstanceInput, ProviderInstanceUpdate, ProviderModelPreferences } from "@agent-workspace/contracts/provider";
import { getProviderClient, getProviderSettingsFields, normalizeProviderAccentColor } from "@agent-workspace/client-runtime/providers";
import type { AcpPreparation, AcpRegistryAgent } from "@agent/hooks/use-providers";
import { workspaceClient } from "@agent/src/network";
import { useAgentText } from "../i18n";
import { useSettingsGuard } from "./settings-layout";
import { ProviderGlyph } from "./provider-card";
import { ProviderModelSettings, emptyModelPreferences } from "./provider-model-settings";
import { RadixSelect } from "@/components/ui/radix-select"

type Operations = {
  createInstance: (input: ProviderInstanceInput) => Promise<ProviderInstance>;
  updateInstance: (instanceId: string, input: ProviderInstanceUpdate & { revision?: number }) => Promise<ProviderInstance>;
  removeInstance: (instanceId: string) => Promise<void>;
  searchAcpRegistry: (query: string) => Promise<{ agents: AcpRegistryAgent[]; total: number }>;
};
type FormProps = Operations & {
  drivers: ProviderDriverDefinition[];
  providers?: ProviderInstance[];
  provider: ProviderInstance | null;
  onSaved?: (provider: ProviderInstance) => void;
  onDeleted?: () => void;
  onEditingChange?: (state: "clean" | "dirty" | "busy") => void;
  defaultDriver?: ProviderDriverDefinition;
  defaultInstanceId?: string;
  identityStatus?: ReactNode;
  setup?: ReactNode;
  runtime?: ReactNode;
  wizard?: boolean;
  onWizardCancel?: () => void;
};
type EnvironmentRow = ProviderEnvironmentEntry & { id: number };
type ConfigDraft = Record<string, string | boolean | string[] | null>;
type SaveScope = "all" | "label" | "accentColor" | "config" | "environment" | "models" | `config:${string}`;
type WizardDraft = {
  label: string;
  instanceId: string | null;
  accentColor: string;
  config: ConfigDraft;
  customModels: NonNullable<ProviderInstance["customModels"]>;
  modelPreferences: ProviderModelPreferences;
  environment: EnvironmentRow[];
};

function SettingsRow({ title, description, status, children, inputId }: { title: string; description?: string; status?: ReactNode; children: ReactNode; inputId?: string }) {
  return <div className="provider-setting-row">
    <div>{inputId ? <label htmlFor={inputId}>{title}</label> : <span className="provider-setting-label">{title}</span>}{description && <p id={inputId ? `${inputId}-help` : undefined}>{description}</p>}{status}</div>
    <div className="provider-setting-control">{children}</div>
  </div>;
}

export function ProviderInstanceForm({ provider, providers, drivers, createInstance, updateInstance, removeInstance, searchAcpRegistry, onSaved, onDeleted, onEditingChange, defaultDriver, defaultInstanceId, identityStatus, setup, runtime, wizard = false, onWizardCancel }: FormProps) {
  const t = useAgentText();
  const id = useId();
  const [baseline, setBaseline] = useState(provider);
  const initialDriver = provider?.driver ?? defaultDriver?.driver ?? drivers[0]?.driver ?? "codex";
  const [driver, setDriver] = useState<ProviderDriver>(initialDriver);
  const definition = drivers.find((entry) => entry.driver === driver) ?? (defaultDriver?.driver === driver ? defaultDriver : undefined);
  const defaultLabel = definition?.label ?? "";
  const [label, setLabel] = useState(provider?.label ?? defaultLabel);
  const [accentColor, setAccentColor] = useState(provider?.accentColor ?? "");
  const [configDraft, setConfigDraft] = useState<ConfigDraft>({});
  const [customModels, setCustomModels] = useState(provider?.customModels ?? []);
  const [modelPreferences, setModelPreferences] = useState<ProviderModelPreferences>(provider?.modelPreferences ?? emptyModelPreferences());
  const [environment, setEnvironment] = useState<EnvironmentRow[]>(() => (provider?.environment ?? []).map((entry, id) => ({ ...entry, id })));
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [registryQuery, setRegistryQuery] = useState("");
  const [registryResults, setRegistryResults] = useState<{ agents: AcpRegistryAgent[]; total: number } | null>(null);
  const [preparation, setPreparation] = useState<AcpPreparation | null>(null);
  const [step, setStep] = useState(0);
  const [showMore, setShowMore] = useState(false);
  const [registrySelection, setRegistrySelection] = useState<AcpRegistryAgent | null>(null);
  const [wizardDrafts, setWizardDrafts] = useState<Partial<Record<ProviderDriver, WizardDraft>>>({});
  const [instanceIdOverride, setInstanceIdOverride] = useState<string | null>(null);
  const creationAttempt = useRef<string | null>(null);
  let generatedId = "";
  if (wizard) {
    const base = `${driver}_${label.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "instance"}`.slice(0, 58);
    const existing = new Set(providers?.map((entry) => entry.instanceId));
    generatedId = base;
    for (let suffix = 2; existing.has(generatedId); suffix++) generatedId = `${base}_${suffix}`;
  }
  const creationId = creationAttempt.current ?? instanceIdOverride ?? generatedId;
  const idError = !wizard ? null : !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(creationId)
    ? t("实例 ID 必须以字母开头，仅包含字母、数字、连字符或下划线，最多64个字符。", "The instance ID must start with a letter and contain only letters, digits, hyphens, or underscores, up to 64 characters.")
    : !creationAttempt.current && providers?.some((entry) => entry.instanceId === creationId) ? t("此实例 ID 已存在。", "This instance ID already exists.") : null;
  const [failedScope, setFailedScope] = useState<SaveScope | null>(null);
  const busyRef = useRef(false);
  const baselineRef = useRef(provider);
  const { setGuard } = useSettingsGuard();
  const environmentDirty = JSON.stringify(environment.map(({ id: _id, ...entry }) => entry)) !== JSON.stringify(baseline?.environment ?? []);
  const modelsDirty = JSON.stringify(customModels) !== JSON.stringify(baseline?.customModels ?? []) || JSON.stringify(modelPreferences) !== JSON.stringify(baseline?.modelPreferences ?? emptyModelPreferences());
  const dirty = label !== (baseline?.label ?? defaultLabel) || accentColor !== (baseline?.accentColor ?? "") ||
    Object.keys(configDraft).length > 0 || environmentDirty || modelsDirty || failedScope !== null || (wizard && (step > 0 || Object.keys(wizardDrafts).length > 0));

  function reset(next: ProviderInstance | null) {
    baselineRef.current = next;
    setBaseline(next);
    setDriver(next?.driver ?? initialDriver);
    setLabel(next?.label ?? defaultLabel);
    setAccentColor(next?.accentColor ?? "");
    setConfigDraft({});
    setCustomModels(next?.customModels ?? []);
    setModelPreferences(next?.modelPreferences ?? emptyModelPreferences());
    setEnvironment((next?.environment ?? []).map((entry, id) => ({ ...entry, id })));
    setError(null);
    setFailedScope(null);
    setConfirmDelete(false);
    setPreparation(null);
  }

  // Catalog refreshes may update a clean form, never a dirty draft's revision.
  useEffect(() => {
    if (!provider || dirty || busy) return;
    if (!baseline || provider.instanceId !== baseline.instanceId || (provider !== baseline && (provider.revision ?? -1) >= (baseline.revision ?? -1))) reset(provider);
  }, [provider, baseline, dirty, busy]);
  useEffect(() => {
    onEditingChange?.(busy ? "busy" : dirty ? "dirty" : "clean");
    return () => onEditingChange?.("clean");
  }, [dirty, busy, onEditingChange]);
  useEffect(() => {
    setGuard(busy ? "busy" : dirty ? "dirty" : "clean");
    return () => setGuard("clean");
  }, [busy, dirty, setGuard]);

  function fieldValue(field: ProviderConfigField): string | boolean | string[] {
    const secret = field.secret || field.type === "password" || field.control === "password";
    const value = Object.hasOwn(configDraft, field.key) ? configDraft[field.key] : secret ? undefined : baseline?.config[field.key];
    const effective = value ?? field.defaultValue;
    if (field.type === "boolean") return effective === true;
    if (field.type === "string-list") return Array.isArray(effective) ? effective : [];
    return typeof effective === "string" || typeof effective === "number" ? String(effective) : "";
  }

  function changeField(field: ProviderConfigField, value: string | boolean | string[] | null) {
    const next = { ...configDraft };
    // A blank secret editor is deliberately not a deletion. Clearing is explicit.
    if ((field.secret || field.type === "password" || field.control === "password") && value === "") delete next[field.key];
    else {
      const empty = value === "" || (field.type === "boolean" && value === (field.defaultValue ?? false));
      const normalized = empty && field.clearWhenEmpty !== "persist" ? null : value;
      const original = baseline?.config[field.key] ?? null;
      if (!((field.secret || field.type === "password" || field.control === "password") && value === null && baseline?.secretConfigKeys.includes(field.key)) && JSON.stringify(normalized) === JSON.stringify(original)) delete next[field.key];
      else next[field.key] = normalized;
    }
    setConfigDraft(next);
    setSaved(false);
    setPreparation(null);
    return next;
  }

  const client = getProviderClient(driver);
  const draftConfig: ProviderConfig = { ...baseline?.config };
  for (const [key, value] of Object.entries(configDraft)) {
    if (value === null) delete draftConfig[key];
    else draftConfig[key] = value;
  }
  const schemaFields = getProviderSettingsFields(driver, draftConfig);
  const sourceField = schemaFields.find((entry) => entry.key === "source");
  const localAcp = driver === "acpRegistry" && draftConfig.source === "local";
  const managedCodex = driver === "codex" && draftConfig.setupMode === "managed";
  const cursorKey = driver === "cursor" && environment.some((row) => row.name === "CURSOR_API_KEY" && (row.valueRedacted || row.value.trim()));
  const RuntimeSection = managedCodex ? "details" : "section";
  const fields = managedCodex ? [] : schemaFields.filter((entry) => !(wizard && driver === "acpRegistry" && ["source", "agentId"].includes(entry.key)));
  const commandArgs = Array.isArray(draftConfig.commandArgs) ? draftConfig.commandArgs : [];
  const environmentFields = client?.environmentFields ?? [];

  function changeCommandArgs(next: string[]) {
    setConfigDraft((draft) => {
      const updated = { ...draft };
      if (JSON.stringify(next) === JSON.stringify(baseline?.config.commandArgs ?? [])) delete updated.commandArgs;
      else updated.commandArgs = next;
      return updated;
    });
    setSaved(false);
  }

  async function save(scope: SaveScope, retry = false, draftOverride?: ConfigDraft, color = accentColor) {
    if (busyRef.current || !definition || (failedScope && !retry)) return;
    const current = baselineRef.current;
    const configToSave = draftOverride ?? configDraft;
    if (!retry && scope === "label" && label === (current?.label ?? defaultLabel)) return;
    if (!retry && scope === "accentColor" && color === (current?.accentColor ?? "")) return;
    if (!retry && scope.startsWith("config:") && configToSave[scope.slice(7)] === undefined) return;
    busyRef.current = true;
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      if ((scope === "all" || scope === "accentColor") && color && !normalizeProviderAccentColor(color)) throw new Error(t("强调色必须是 #RRGGBB 格式。", "The accent color must use the #RRGGBB format."));
      const patch: ProviderInstanceUpdate = {};
      if (wizard && driver === "acpRegistry" && !localAcp && registrySelection?.icon?.startsWith("https://")) patch.registryIconUrl = registrySelection.icon;
      if (scope === "all" || scope === "label") patch.label = label;
      if (scope === "all" || scope === "accentColor") patch.accentColor = color;
      if (scope === "all" || scope === "environment") {
        const names = new Set<string>();
        patch.environment = environment.map(({ id: _id, ...row }) => {
          const name = row.name.trim();
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error(t("环境变量名只能包含字母、数字和下划线，且不能以数字开头。", "Environment variable names may only contain letters, digits, and underscores, and cannot start with a digit."));
          if (names.has(name)) throw new Error(t(`环境变量 ${name} 重复，请合并后保存。`, `Environment variable ${name} is duplicated; merge it before saving.`));
          names.add(name);
          return { ...row, name };
        });
      }
      if (scope === "all" || scope === "models") { patch.customModels = customModels; patch.modelPreferences = modelPreferences; }
      const config: ProviderConfigInput = {};
      for (const [key, value] of Object.entries(configToSave)) {
        if (managedCodex || !client || !Object.hasOwn(client.settingsSchema.fields, key)) continue;
        if (scope !== "all" && scope !== "config" && scope !== `config:${key}`) continue;
        const field = schemaFields.find((entry) => entry.key === key);
        if (field?.type === "number" && value !== null) {
          const number = Number(value);
          if (typeof value !== "string" || !value.trim() || !Number.isFinite(number) || (field.min !== undefined && number < field.min) || (field.max !== undefined && number > field.max)) throw new Error(t(`${field.label} 必须是有效数值。`, `${field.label} must be a valid number.`));
          config[key] = number;
        } else config[key] = value;
      }
      if (driver === "codex" && wizard) config.setupMode = managedCodex ? "managed" : "existing";
      if (Object.keys(config).length) patch.config = config;
      let latest = current;
      if (wizard && !current) {
        if (idError) throw new Error(idError);
        if (retry && creationAttempt.current) {
          const catalog = await workspaceClient.json<{ providers: ProviderInstance[] }>("/api/providers");
          if (catalog.providers.some((entry) => entry.instanceId === creationAttempt.current))
            throw new Error(t("此实例 ID 已存在，请关闭向导并刷新列表核对创建结果。不会覆盖或重复创建。", "This instance ID already exists. Close the wizard and refresh the list to verify the creation result. Nothing will be overwritten or created twice."));
        }
        creationAttempt.current = creationId;
      }
      if (retry && (current || defaultDriver)) {
        const catalog = await workspaceClient.json<{ providers: ProviderInstance[] }>("/api/providers");
        const idToFind = current?.instanceId ?? defaultInstanceId ?? defaultDriver?.driver;
        const refreshed = catalog.providers.find((entry) => entry.instanceId === idToFind);
        if (!refreshed && current) throw new Error(t("实例已不存在，请重新载入提供商列表。", "The instance no longer exists. Reload the provider list."));
        if (refreshed && refreshed.driver !== driver) throw new Error(t("默认实例 ID 已被其他驱动占用。", "The default instance ID is already used by another driver."));
        latest = refreshed ?? null;
      }
      if (latest && typeof latest.revision !== "number") throw new Error(t("未取得服务器配置版本，请重新载入后重试。", "No server configuration revision was received. Reload and try again."));
      const next = latest
        ? await updateInstance(latest.instanceId, { ...patch, revision: latest.revision })
        : await createInstance({ ...patch, instanceId: wizard ? creationId : defaultInstanceId ?? defaultDriver?.driver, driver, label: patch.label ?? label, enabled: wizard });
      // Remember a successful creation immediately, even if the response lacks a revision.
      baselineRef.current = next;
      setBaseline(next);
      if (typeof next.revision !== "number") throw new Error(t("服务器未返回配置版本，请重新载入后继续编辑。", "The server did not return a configuration revision. Reload before editing again."));
      if (scope === "all" || scope === "label" || label === (current?.label ?? defaultLabel)) setLabel(next.label);
      if (scope === "all" || scope === "accentColor" || accentColor === (current?.accentColor ?? "")) setAccentColor(next.accentColor ?? "");
      if (scope === "all" || scope === "models" || JSON.stringify(customModels) === JSON.stringify(current?.customModels ?? [])) setCustomModels(next.customModels ?? []);
      if (scope === "all" || scope === "models") setModelPreferences(next.modelPreferences ?? emptyModelPreferences());
      onSaved?.(next);
      if (scope === "all" || scope === "environment") setEnvironment((next.environment ?? []).map((entry, id) => ({ ...entry, id })));
      if (scope === "all" || scope === "config") setConfigDraft({});
      else if (scope.startsWith("config:")) setConfigDraft((draft) => { const copy = { ...draft }; delete copy[scope.slice(7)]; return copy; });
      setFailedScope(null);
      setSaved(true);
    } catch (cause) {
      setFailedScope(scope);
      setError(cause instanceof Error ? cause.message : t("保存实例失败。", "Failed to save the instance."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!wizard || step === 3 || (step === 2 && managedCodex)) void save("all", Boolean(error));
  }

  async function deleteInstance() {
    if (!provider || busy) return;
    setError(null);
    setBusy(true);
    try { await removeInstance(provider.instanceId); setEnvironment([]); onDeleted?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("删除实例失败。", "Failed to delete the instance.")); }
    finally { setBusy(false); }
  }

  async function searchRegistry() {
    setBusy(true);
    setError(null);
    try { setRegistryResults(await searchAcpRegistry(registryQuery)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("无法读取 ACP Registry。", "Unable to read the ACP Registry.")); }
    finally { setBusy(false); }
  }

  async function prepareRegistrySelection() {
    if (!registrySelection || idError) return;
    setBusy(true); setError(null);
    try {
      const result = await workspaceClient.json<AcpPreparation>("/api/providers/acp-registry/prepare", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceId: creationId, agentId: registrySelection.id }),
      });
      setInstanceIdOverride(creationId);
      setPreparation(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("准备 ACP Agent 失败。", "Failed to prepare the ACP agent.")); }
    finally { setBusy(false); }
  }

  function selectDriver(next: ProviderDriverDefinition) {
    if (creationAttempt.current) return;
    setWizardDrafts((drafts) => ({ ...drafts, [driver]: { label, instanceId: instanceIdOverride, accentColor, config: configDraft, customModels, modelPreferences, environment } }));
    const draft = next.driver === driver ? { label, instanceId: instanceIdOverride, accentColor, config: configDraft, customModels, modelPreferences, environment } : wizardDrafts[next.driver];
    setDriver(next.driver);
    setInstanceIdOverride(draft?.instanceId ?? null);
    setLabel(draft?.label ?? next.label);
    setAccentColor(draft?.accentColor ?? "");
    setConfigDraft(draft?.config ?? {});
    setCustomModels(draft?.customModels ?? []);
    setModelPreferences(draft?.modelPreferences ?? emptyModelPreferences());
    setEnvironment(draft?.environment ?? []);
    setError(null);
    setFailedScope(null);
    setPreparation(null);
  }

  return <form onSubmit={submit} className="provider-instance-form" autoComplete="off" noValidate onKeyDown={(event) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (!wizard && event.key === "Enter" && event.target instanceof HTMLInputElement) { event.preventDefault(); event.target.blur(); }
    else if (wizard && event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault();
  }}>
    {wizard && <div className="provider-wizard-steps" aria-label={t("添加步骤", "Add steps")}>{(driver === "acpRegistry" ? [t("提供商", "Provider"), t("选择与准备", "Select & prepare"), t("身份", "Identity"), t("配置", "Configuration")] : managedCodex ? [t("提供商", "Provider"), t("账号", "Account")] : [t("提供商", "Provider"), t("身份", "Identity"), t("配置", "Configuration")]).map((name, index) => <span key={name} aria-current={(driver === "acpRegistry" ? step === index : step === (index === 0 ? 0 : index + 1)) ? "step" : undefined}>{index + 1}. {name}</span>)}</div>}
    <fieldset disabled={busy} className="provider-form-fields">
      {wizard && step === 0 && <section className="provider-settings-section">
        <h3>{t("选择提供商", "Choose a provider")}</h3>
        <div className="provider-wizard-tiles">
          {drivers.filter((entry) => entry.driver !== "acpRegistry" && (showMore || entry.featured !== false)).map((entry) => <button className="provider-wizard-tile" type="button" key={entry.driver} aria-label={entry.label} aria-pressed={driver === entry.driver} disabled={creationAttempt.current !== null} title={entry.description} onClick={() => selectDriver(entry)}><ProviderGlyph driver={entry.driver} /><strong>{entry.label}</strong></button>)}
        </div>
        {drivers.some((entry) => entry.driver !== "acpRegistry" && entry.featured === false) && <Button type="button" size="sm" variant="ghost" onClick={() => setShowMore(!showMore)}>{showMore ? t("收起", "Show less") : t("显示更多", "Show more")}</Button>}
        {drivers.find((entry) => entry.driver === "acpRegistry") && <div className="provider-wizard-registry">
          <p>{t("或使用 ACP Registry / 本地 ACP 命令", "Or use ACP Registry / a local ACP command")}</p>
          <button className="provider-wizard-tile" type="button" aria-label="ACP Registry" aria-pressed={driver === "acpRegistry"} disabled={creationAttempt.current !== null} onClick={() => selectDriver(drivers.find((entry) => entry.driver === "acpRegistry")!)}><ProviderGlyph driver="acpRegistry" /><strong>ACP Registry</strong></button>
        </div>}
      </section>}
      {wizard && driver === "acpRegistry" && step === 1 && <section className="provider-settings-section">
        <h3>{t("选择 ACP 来源", "Choose an ACP source")}</h3>
        <div className="provider-settings-group"><SettingsRow title={t("来源", "Source")}><RadixSelect value={localAcp ? "local" : "registry"} onChange={(event) => { if (sourceField) changeField(sourceField, event.target.value); setPreparation(null); }}><option value="registry">ACP Registry</option><option value="local">{t("本地命令", "Local command")}</option></RadixSelect></SettingsRow></div>
        {!localAcp && <div className="provider-registry-search">
          <label htmlFor={`${id}-registry-wizard`}>{t("搜索 ACP Registry", "Search the ACP Registry")}</label>
          <div><Input id={`${id}-registry-wizard`} value={registryQuery} onChange={(event) => setRegistryQuery(event.target.value)} /><Button type="button" variant="outline" onClick={() => void searchRegistry()}><Search aria-hidden="true" />{t("搜索", "Search")}</Button></div>
          {registryResults && <div className="provider-registry-results">{registryResults.agents.map((agent) => <button type="button" key={agent.id} aria-pressed={registrySelection?.id === agent.id} onClick={() => { setRegistrySelection(agent); setPreparation(null); setLabel(agent.name); setInstanceIdOverride(null); const agentId = schemaFields.find((entry) => entry.key === "agentId"); if (agentId) changeField(agentId, agent.id); }}>{agent.icon?.startsWith("https://") && <img src={agent.icon} alt="" referrerPolicy="no-referrer" />}<strong>{agent.name}</strong><code>{agent.id} · {agent.version}</code><span>{agent.description}</span><small>{agent.distributions.join(" / ")} · {agent.integrity === "sha256" ? "SHA-256" : "Registry"}</small></button>)}</div>}
          {registrySelection && <div><p>{t("预览：", "Preview: ")}{registrySelection.name} · {registrySelection.version} · {registrySelection.description}</p><label>{t("实例 ID", "Instance ID")} <Input value={creationId} disabled={Boolean(preparation)} onChange={(event) => setInstanceIdOverride(event.target.value)} /></label>{idError && <p role="alert">{idError}</p>}<Button type="button" variant="outline" disabled={Boolean(idError) || Boolean(preparation)} onClick={() => void prepareRegistrySelection()}>{t("明确准备并安装", "Prepare and install")}</Button>{preparation && <p role="status">{preparation.message}</p>}</div>}
        </div>}
      </section>}
      {(!wizard || step === 2) && <section className="provider-settings-section" aria-label={t("基本信息", "Basic info")}>
        <div className="provider-settings-group">
          {identityStatus && <SettingsRow title={t("状态", "Status")}>{identityStatus}</SettingsRow>}
          <SettingsRow title={t("显示名称", "Display name")} inputId={`${id}-label`}>
            <div className="provider-identity-control">
              <input aria-label={t("选择强调色", "Choose accent color")} type="color" value={/^#[a-f\d]{6}$/i.test(accentColor) ? accentColor : "#6b7280"} onChange={(event) => setAccentColor(event.target.value)} onBlur={() => { if (!wizard) void save("accentColor"); }} />
              <Input id={`${id}-label`} maxLength={120} value={label} placeholder={defaultLabel} onChange={(event) => { setLabel(event.target.value); setSaved(false); }} onBlur={() => { if (!wizard) void save("label"); }} />
              {accentColor && <Button type="button" size="icon-sm" variant="ghost" aria-label={t("重置强调色", "Reset accent color")} onMouseDown={(event) => event.preventDefault()} onClick={() => { setAccentColor(""); if (!wizard) void save("accentColor", false, undefined, ""); }}><Undo2 aria-hidden="true" /></Button>}
            </div>
          </SettingsRow>
          {wizard && <SettingsRow title={t("实例 ID", "Instance ID")} inputId={`${id}-instance-id`} status={idError ? <p role="alert">{idError}</p> : undefined}>
            <Input id={`${id}-instance-id`} value={creationId} maxLength={64} disabled={creationAttempt.current !== null || Boolean(preparation)} aria-invalid={Boolean(idError)} spellCheck={false} onChange={(event) => setInstanceIdOverride(event.target.value)} />
          </SettingsRow>}
        </div>
      </section>}
      {(!wizard || step === 3) && <>
      {(setup || environmentFields.length > 0) ? <section className="provider-settings-section" aria-label="Setup">
        <h3>Setup</h3>{!cursorKey && setup}<div className="provider-settings-group">{environmentFields.map((field) => {
          const row = environment.find((item) => item.name === field.name);
          const inputId = `${id}-setup-${field.name}`;
          return <SettingsRow key={field.name} title={field.label} description={field.description} inputId={inputId}><Input id={inputId} aria-describedby={field.description ? `${inputId}-help` : undefined} type={field.sensitive ? "password" : "text"} value={row?.value ?? ""} placeholder={row?.valueRedacted ? t("已保存 · 留空保留", "Saved · leave blank to keep") : field.placeholder} autoComplete="off" onChange={(event) => setEnvironment((rows) => {
            const original = baseline?.environment?.find((item) => item.name === field.name);
            const value = event.target.value;
            if (!value) {
              if (field.sensitive && original?.valueRedacted) return rows.map((item) => item.name === field.name ? { ...original, id: item.id } : item);
              return rows.filter((item) => item.name !== field.name);
            }
            const previous = rows.find((item) => item.name === field.name);
            if (previous) return rows.map((item) => item === previous ? { ...item, value, valueRedacted: false } : item);
            return [...rows, { id: Math.max(-1, ...rows.map((item) => item.id)) + 1, name: field.name, value, sensitive: field.sensitive ?? false }];
          })} />{row && <Button type="button" variant="ghost" size="sm" onClick={() => setEnvironment((rows) => rows.filter((item) => item.name !== field.name))}>{t("清除", "Clear")}</Button>}</SettingsRow>;
        })}</div>{!wizard && environmentDirty && <Button type="button" size="sm" variant="outline" onClick={() => void save("environment")}>{t("保存 Setup", "Save Setup")}</Button>}</section> : null}
      {(!definition || fields.length > 0 || runtime) && <RuntimeSection className={`provider-settings-section${managedCodex ? " provider-runtime-fold" : ""}`} aria-label="Runtime">
        {managedCodex ? <summary>Runtime</summary> : <h3>Runtime</h3>}
        {managedCodex && <div className="provider-settings-group"><SettingsRow title="Codex runtime"><code>{baseline?.installation?.executablePath ?? t("尚未准备运行时", "Runtime not prepared yet")}</code></SettingsRow></div>}
        {definition?.docsUrl && <p className="provider-section-note"><a href={definition.docsUrl} target="_blank" rel="noreferrer noopener" className="hover:text-primary">{t("配置文档", "Configuration docs")}</a></p>}
        {!definition && <p role="alert" className="provider-feedback provider-feedback-error">{t("驱动配置元数据不可用，请重新读取提供商。", "Driver configuration metadata is unavailable. Reload the providers.")}</p>}
        {!wizard && driver === "acpRegistry" && !localAcp && <div className="provider-registry-search">
          <label htmlFor={`${id}-registry`}>ACP Registry</label>
          <div><Input id={`${id}-registry`} value={registryQuery} onChange={(event) => setRegistryQuery(event.target.value)} placeholder={t("搜索注册的 ACP Agent", "Search registered ACP agents")} /><Button type="button" size="sm" variant="outline" onClick={() => void searchRegistry()}><Search aria-hidden="true" />{t("搜索", "Search")}</Button></div>
          {registryResults && <div className="provider-registry-results" aria-label={t("ACP 搜索结果", "ACP search results")}><p role="status">{t(`共 ${registryResults.total} 个匹配，显示 ${registryResults.agents.length} 个。`, `${registryResults.agents.length} of ${registryResults.total} matches shown.`)}</p>{registryResults.agents.map((agent) => <button type="button" key={agent.id} onClick={() => {
            const agentId = schemaFields.find((entry) => entry.key === "agentId");
            if (agentId) changeField(agentId, agent.id);
            if (!provider && (label === definition?.label || !label.trim())) setLabel(agent.name);
          }}><strong>{agent.name}</strong><code>{agent.id} · {agent.version}</code><span>{agent.description}</span><small>{agent.distributions.join(" / ")}</small></button>)}</div>}
        </div>}
        {fields.length > 0 && <div className="provider-settings-group">{fields.map((entry) => {
          const inputId = `${id}-config-${entry.key}`;
          const value = fieldValue(entry);
          const storedSecret = baseline?.secretConfigKeys.includes(entry.key) === true;
          const secret = entry.secret || entry.type === "password" || entry.control === "password";
          const helpId = entry.description ? `${inputId}-help` : undefined;
          return <SettingsRow key={entry.key} title={entry.label} description={entry.description} inputId={inputId}>
            {entry.type === "boolean" ? <input id={inputId} aria-describedby={helpId} type="checkbox" role="switch" checked={value === true} onChange={(event) => { const draft = changeField(entry, event.target.checked); if (!wizard && driver !== "acpRegistry") void save(`config:${entry.key}`, false, draft); }} /> : entry.type === "select" ? <RadixSelect id={inputId} aria-describedby={helpId} value={String(value)} required={entry.required} onChange={(event) => { const draft = changeField(entry, event.target.value); if (!wizard && driver !== "acpRegistry") void save(`config:${entry.key}`, false, draft); }}>
              {entry.defaultValue === undefined && <option value="">{entry.required ? t("请选择", "Select") : t("使用默认值", "Use default")}</option>}
              {String(value) && !entry.options?.some((option) => option.value === value) && <option value={String(value)}>{t(`${String(value)}（当前配置）`, `${String(value)} (current)`)}</option>}
              {entry.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </RadixSelect> : entry.type === "string-list" ? <div className="provider-string-list">
              {(Array.isArray(value) ? value : []).map((item, index, items) => <div key={index}><Input aria-label={`${entry.label} ${index + 1}`} value={item} autoComplete="off" onChange={(event) => changeField(entry, items.map((current, row) => row === index ? event.target.value : current))} /><Button type="button" size="icon-sm" variant="ghost" aria-label={t(`移除 ${entry.label} ${index + 1}`, `Remove ${entry.label} ${index + 1}`)} onClick={() => changeField(entry, items.filter((_, row) => row !== index))}><X aria-hidden="true" /></Button></div>)}
              <Button type="button" size="sm" variant="outline" onClick={() => changeField(entry, [...(Array.isArray(value) ? value : []), ""])}><Plus aria-hidden="true" />{t("添加", "Add")}</Button>
            </div> : entry.control === "textarea" && !secret ? <textarea id={inputId} aria-describedby={helpId} value={String(value)} placeholder={entry.placeholder} required={entry.required} spellCheck={false} onChange={(event) => changeField(entry, event.target.value)} onBlur={() => { if (!wizard && driver !== "acpRegistry") void save(`config:${entry.key}`); }} /> : <Input id={inputId} aria-describedby={helpId} type={secret ? "password" : entry.type === "number" ? "number" : "text"} required={entry.required && !(secret && storedSecret && configDraft[entry.key] !== null)} min={entry.min} max={entry.max} step={entry.type === "number" ? "any" : undefined} value={String(value)} autoComplete={secret ? "new-password" : "off"} spellCheck={false} placeholder={secret && storedSecret ? t("已保存 · 留空保留现有值", "Saved · leave blank to keep the current value") : entry.placeholder} onChange={(event) => changeField(entry, event.target.value)} onBlur={() => { if (!wizard && driver !== "acpRegistry") void save(`config:${entry.key}`); }} />}
            {secret && storedSecret && <label className="provider-secret-clear"><input type="checkbox" checked={configDraft[entry.key] === null} onChange={(event) => {
              if (event.target.checked) changeField(entry, null);
              else setConfigDraft((current) => { const next = { ...current }; delete next[entry.key]; return next; });
            }} />{t("保存时清除现有值", "Clear the current value when saving")}</label>}
            {!wizard && driver !== "acpRegistry" && configDraft[entry.key] !== undefined && <Button type="button" size="sm" variant="outline" onClick={() => void save(`config:${entry.key}`)}>{t("保存", "Save")}</Button>}
          </SettingsRow>;
        })}</div>}
        {localAcp && <div className="provider-settings-group"><SettingsRow title={t("启动参数", "Arguments")} description={t("按启动顺序，每行一个字面参数。", "One literal argument per row, in launch order.")}>
          <div className="provider-string-list">
            {commandArgs.map((argument, index) => <div key={index}><Input aria-label={t(`启动参数 ${index + 1}`, `Argument ${index + 1}`)} value={argument} spellCheck={false} onChange={(event) => changeCommandArgs(commandArgs.map((value, row) => row === index ? event.target.value : value))} /><Button type="button" size="icon-sm" variant="ghost" aria-label={t(`移除启动参数 ${index + 1}`, `Remove argument ${index + 1}`)} onClick={() => changeCommandArgs(commandArgs.filter((_, row) => row !== index))}><X aria-hidden="true" /></Button></div>)}
            <Button type="button" size="sm" variant="outline" onClick={() => changeCommandArgs([...commandArgs, ""])}><Plus aria-hidden="true" />{t("添加参数", "Add argument")}</Button>
          </div>
        </SettingsRow></div>}
        {!wizard && driver === "acpRegistry" && Object.keys(configDraft).length > 0 && <Button type="button" size="sm" variant="outline" onClick={() => void save("config")}>{t("保存 ACP 配置", "Save ACP configuration")}</Button>}
        {runtime}
      </RuntimeSection>}
      <section className="provider-settings-section" aria-label={t("环境变量", "Environment variables")}>
        <h3>Environment</h3>
        <div className="provider-settings-group">
          <div className="provider-setting-row"><div><span className="provider-setting-label">{t("实例变量", "Instance variables")}</span></div><Button type="button" variant="outline" size="sm" onClick={() => setEnvironment((rows) => [...rows, { id: Math.max(-1, ...rows.map((item) => item.id)) + 1, name: "", value: "", sensitive: true }])}><Plus aria-hidden="true" />{t("添加变量", "Add variable")}</Button></div>
          {environment.filter((row) => !environmentFields.some((field) => field.name === row.name)).map((row, index) => <div className="provider-environment-draft" key={row.id}>
            <Input aria-label={t(`变量名 ${index + 1}`, `Variable name ${index + 1}`)} placeholder="VARIABLE_NAME" value={row.name} disabled={Boolean(row.valueRedacted)} spellCheck={false} onChange={(event) => setEnvironment((rows) => rows.map((item) => item.id === row.id ? { ...item, name: event.target.value } : item))} />
            <Input aria-label={t(`变量值 ${index + 1}`, `Variable value ${index + 1}`)} type={row.sensitive ? "password" : "text"} placeholder={row.valueRedacted ? t("已保存 · 留空保留", "Saved · leave blank to keep") : t("变量值", "Value")} value={row.value} autoComplete="off" onChange={(event) => setEnvironment((rows) => rows.map((item) => {
              if (item.id !== row.id) return item;
              const original = baseline?.environment?.find((entry) => entry.name === item.name);
              return !event.target.value && original?.valueRedacted ? { ...original, id: item.id } : { ...item, value: event.target.value, valueRedacted: false };
            }))} />
            <label><input type="checkbox" checked={row.sensitive} disabled={Boolean(row.valueRedacted)} onChange={(event) => setEnvironment((rows) => rows.map((item) => item.id === row.id ? { ...item, sensitive: event.target.checked } : item))} />{t("敏感", "Sensitive")}</label>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t(`移除变量 ${index + 1}`, `Remove variable ${index + 1}`)} onClick={() => setEnvironment((rows) => rows.filter((item) => item.id !== row.id))}><Trash2 aria-hidden="true" /></Button>
          </div>)}
        </div>{!wizard && environmentDirty && <Button type="button" size="sm" variant="outline" onClick={() => void save("environment")}>{t("保存环境变量", "Save environment variables")}</Button>}
      </section>
      <ProviderModelSettings driver={driver} models={(provider?.revision === baseline?.revision ? provider?.models : baseline?.models) ?? []} customModels={customModels} preferences={modelPreferences} allowCustom={definition?.supportsCustomModels !== false && driver !== "antigravity"} onModelsChange={setCustomModels} onPreferencesChange={setModelPreferences} />
      {!wizard && modelsDirty && <Button type="button" size="sm" variant="outline" onClick={() => void save("models")}>{t("保存模型", "Save models")}</Button>}
      </>}
    </fieldset>
    {error && <p role="alert" className="provider-feedback provider-feedback-error">{error}</p>}
    {provider && dirty && baseline && (provider.revision ?? -1) > (baseline.revision ?? -1) && <p role="alert" className="provider-feedback">{t("服务器配置已更新；草稿仍保留。重试将以最新版本提交当前字段，或放弃草稿。", "The server configuration has changed; your draft is preserved. Retry to submit the current fields against the latest revision, or discard the draft.")}</p>}
    {wizard ? <div className="provider-wizard-actions">
      <Button type="button" variant="ghost" disabled={busy} onClick={() => step === 0 ? onWizardCancel?.() : setStep(step === 2 && driver !== "acpRegistry" ? 0 : step - 1)}>{step === 0 ? t("取消", "Cancel") : t("上一步", "Back")}</Button>
      {step === 0 && driver === "codex" ? <><Button type="button" variant="outline" disabled={busy} onClick={() => { setConfigDraft((draft) => ({ ...draft, setupMode: "existing" })); if (label === "ChatGPT - Personal") setLabel(definition?.label ?? "Codex"); setStep(2); }}>{t("使用现有 CLI", "Use existing CLI")}</Button><Button type="button" disabled={busy} onClick={() => { setConfigDraft((draft) => ({ ...draft, setupMode: "managed" })); if (label === (definition?.label ?? "Codex")) setLabel("ChatGPT - Personal"); setStep(2); }}>{t("继续使用 ChatGPT", "Continue with ChatGPT")}</Button></> : <Button type={step === 3 || (step === 2 && managedCodex) ? "submit" : "button"} disabled={busy || !definition || (step > 0 && Boolean(idError)) || (step === 1 && driver === "acpRegistry" && !localAcp && !preparation)} onClick={(event) => { if (step < 3 && !(step === 2 && managedCodex)) { event.preventDefault(); setStep(step === 0 && driver !== "acpRegistry" ? 2 : step + 1); } }}>{busy && <Loader2 aria-hidden="true" className="animate-spin" />}{step === 2 && managedCodex ? t("继续使用 ChatGPT", "Continue with ChatGPT") : step === 3 ? driver === "acpRegistry" && !localAcp ? t("创建并继续认证", "Create and continue to authentication") : t("创建实例", "Create instance") : t("下一步", "Next")}</Button>}
    </div> : <div className="provider-form-actions"><span role="status">{busy ? t("正在处理…", "Working…") : dirty ? t("有未保存的修改", "Unsaved changes") : saved ? t("配置已保存", "Configuration saved") : ""}</span>{dirty && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { const current = baselineRef.current; reset(provider && (!current || (provider.revision ?? -1) > (current.revision ?? -1)) ? provider : current); setSaved(false); }}>{t("放弃修改", "Discard changes")}</Button>}{failedScope && <Button type="button" size="sm" disabled={busy} onClick={() => void save(failedScope, true)}>{t("重试保存", "Retry save")}</Button>}</div>}
    {provider && provider.instanceId !== defaultInstanceId && <section className="provider-danger-zone"><div><span className="provider-setting-label">{t("删除实例", "Delete instance")}</span><p>{t("历史运行会保留；此操作不会退出原生账号。", "Historical runs are preserved; this action does not sign out of the native account.")}</p></div><Button type="button" variant="ghost" size="sm" className="text-destructive" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 aria-hidden="true" />{t("删除实例", "Delete instance")}</Button>{confirmDelete && <div className="provider-delete-confirm" role="alert"><p>{t(`确认删除“${provider.label}”？后续对话将无法使用此实例。`, `Delete "${provider.label}"? Future sessions will not be able to use this instance.`)}</p><div><Button type="button" variant="destructive" size="sm" disabled={busy} onClick={() => void deleteInstance()}>{t("确认删除实例", "Confirm delete instance")}</Button><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmDelete(false)}>{t("保留实例", "Keep instance")}</Button></div></div>}</section>}
  </form>;
}

export function ProviderInstanceDialog({ open, onOpenChange, onCreated, drivers, providers, ...operations }: Operations & { drivers: ProviderDriverDefinition[]; providers: ProviderInstance[]; open: boolean; onOpenChange: (open: boolean) => void; onCreated: (provider: ProviderInstance) => void }) {
  const [editing, setEditing] = useState<"clean" | "dirty" | "busy">("clean");
  const t = useAgentText();
  function changeOpen(next: boolean) {
    if (!next && (editing === "busy" || (editing === "dirty" && !window.confirm(t("放弃尚未保存的实例配置？", "Discard the unsaved instance configuration?"))))) return;
    onOpenChange(next);
  }
  return <Dialog open={open} onOpenChange={changeOpen}><DialogContent className="provider-create-dialog max-h-[90dvh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{t("添加提供商", "Add provider")}</DialogTitle></DialogHeader>{open && <ProviderInstanceForm wizard provider={null} providers={providers} drivers={drivers} {...operations} onWizardCancel={() => changeOpen(false)} onEditingChange={setEditing} onSaved={(next) => { onCreated(next); onOpenChange(false); }} />}</DialogContent></Dialog>;
}
