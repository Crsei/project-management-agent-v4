import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ChatDefaultSelection, ChatDefaultsResponse } from "@agent-workspace/contracts/settings";
import { useProviders } from "@agent/hooks/use-providers";
import { refreshNewChatDefaults } from "@agent/hooks/use-chat-settings";
import { Button } from "@agent/components/ui/button";
import { workspaceClient } from "../network";
import { useAgentText } from "../i18n";
import { SettingsNotice, SettingsSection, useSettingsGuard } from "./settings-layout";
import { ModelOptionControls, modelOptionsValid, providerSelectable, visibleProviderModels } from "./model-option-controls";
import { formatProviderUpdateRequiredNotice, getProviderInstanceDisplayName, getProviderModelShortName, resolveProviderModelSelection } from "@agent-workspace/client-runtime/providers";
import { RadixSelect } from "@/components/ui/radix-select"

export default function DefaultModelSettings() {
  const t = useAgentText();
  const { providers, loading: providersLoading, error: providersError, refresh } = useProviders();
  const { setGuard } = useSettingsGuard();
  const [saved, setSaved] = useState<ChatDefaultsResponse | null>(null);
  const [draft, setDraft] = useState<ChatDefaultSelection | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const dirty = saved !== null && JSON.stringify(saved.defaults.selection) !== JSON.stringify(draft);
  const selection = resolveProviderModelSelection(providers, draft?.providerInstanceId, draft?.model);
  const provider = "provider" in selection ? selection.provider : undefined;
  const model = selection.status === "selected" || selection.status === "disabled-model" ? selection.model : provider?.models.find((item) => item.id === draft?.model || item.aliases?.includes(draft?.model ?? ""));
  const validDraft = draft === null || Boolean(selection.status === "selected" && providerSelectable(provider) && model && modelOptionsValid(model, draft.modelOptions ?? provider?.modelPreferences?.options[draft.model]));
  const updateNotice = provider ? formatProviderUpdateRequiredNotice(provider) : null;

  useEffect(() => {
    setGuard(saving ? "busy" : dirty ? "dirty" : "clean");
    return () => setGuard("clean");
  }, [dirty, saving, setGuard]);

  const load = useCallback(async (preserveDraft = false) => {
    setLoading(true);
    setError(null);
    setSuccess(false);
    try {
      const response = await workspaceClient.json<ChatDefaultsResponse>("/api/settings/chat-defaults");
      setSaved(response);
      if (!preserveDraft) setDraft(response.defaults.selection);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("无法读取默认模型。", "Could not read the default model."));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!saved || !validDraft || loading || saving) return;
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      const response = await workspaceClient.json<ChatDefaultsResponse>("/api/settings/chat-defaults", {
        method: "PUT",
        body: JSON.stringify({ revision: saved.defaults.revision, selection: draft }),
      });
      setSaved(response);
      setDraft(response.defaults.selection);
      setSuccess(true);
      refreshNewChatDefaults();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("保存失败，草稿已保留。", "Save failed; the draft is preserved."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection title={t("新会话默认模型", "New session default model")} scope="service">
      {loading && <SettingsNotice kind="loading">{t("正在读取默认模型…", "Loading default model…")}</SettingsNotice>}
      {error && <SettingsNotice kind="error" onRetry={() => { void load(true); }}>{error}</SettingsNotice>}
      {providersError && <SettingsNotice kind="error" onRetry={() => { void refresh(); }}>{providersError}</SettingsNotice>}
      {saved?.availability.status === "unavailable" && <SettingsNotice kind="error">{t("原默认模型不可用：", "Previous default model is unavailable: ")}{saved.availability.reason}</SettingsNotice>}
      {saved?.availability.status === "unset" && <SettingsNotice kind="info">{t("尚未设置默认模型。", "No default model is set.")}</SettingsNotice>}
      {success && <SettingsNotice kind="success">{t("已保存。", "Saved.")}</SettingsNotice>}
      <form onSubmit={save} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex min-w-0 flex-col gap-2 text-sm">
            <span>{t("模型提供商", "Model provider")}</span>
            <RadixSelect
              aria-label={t("新会话默认提供商", "New session default provider")}
              className="border-input bg-background min-w-0 rounded-md border px-3 py-2 text-sm"
              value={draft?.providerInstanceId ?? ""}
              disabled={loading || saving || providersLoading}
              onChange={(event) => { setDraft(event.target.value ? { providerInstanceId: event.target.value, model: "", interactionMode: draft?.interactionMode } : null); setSuccess(false); }}
            >
              <option value="">{t("不设置默认值", "No default")}</option>
              {draft && !provider && <option value={draft.providerInstanceId}>{draft.providerInstanceId}{t("（已不可用）", " (unavailable)")}</option>}
              {providers.map((item) => <option key={item.instanceId} value={item.instanceId} disabled={!providerSelectable(item)}>{getProviderInstanceDisplayName(item)}{!item.enabled ? t("（已停用）", " (disabled)") : !providerSelectable(item) ? t("（原生会话未就绪）", " (native session not ready)") : item.authStatus === "unknown" ? t("（就绪，身份未知）", " (ready, identity unknown)") : ""}</option>)}
            </RadixSelect>
          </label>
          <label className="flex min-w-0 flex-col gap-2 text-sm">
            <span>{t("模型", "Model")}</span>
            <RadixSelect
              aria-label={t("新会话默认模型", "New session default model")}
              className="border-input bg-background min-w-0 rounded-md border px-3 py-2 text-sm"
              value={draft?.model ?? ""}
              disabled={!draft || loading || saving || providersLoading || !providerSelectable(provider)}
              onChange={(event) => { if (draft) setDraft({ ...draft, model: event.target.value, modelOptions: (provider?.modelPreferences?.options[event.target.value] ?? []).map((option) => ({ ...option })) }); setSuccess(false); }}
            >
              <option value="">{t("请选择模型", "Select a model")}</option>
              {draft?.model && (!model || model.id !== draft.model || provider?.modelPreferences?.hidden.includes(model.id)) && <option value={draft.model}>{draft.model}{t("（", " (")}{!model ? t("已不可用", "unavailable") : model.id !== draft.model ? t("原生别名", "native alias") : t("已隐藏", "hidden")}{t("）", ")")}</option>}
              {provider && visibleProviderModels(provider).map((item) => <option key={item.id} value={item.id} disabled={!!item.disabledReason} title={item.disabledReason}>{getProviderModelShortName(provider.driver, item) ?? item.label}{item.subProvider ? ` · ${item.subProvider}` : ""}{item.badge === "new" ? t(" · 新", " · New") : ""} · {item.source === "custom" ? t("自定义", "Custom") : item.source === "discovered" ? t("实际发现", "Discovered") : t("内置", "Built-in")}</option>)}
            </RadixSelect>
          </label>
        </div>
        {updateNotice && <p role="status" className="text-muted-foreground text-sm">{updateNotice}</p>}
        {draft && <><ModelOptionControls model={model} selections={draft.modelOptions ?? provider?.modelPreferences?.options[draft.model]} disabled={loading || saving} onChange={(modelOptions) => { setDraft({ ...draft, modelOptions: modelOptions.map((option) => ({ ...option })) }); setSuccess(false); }} />
          <label className="flex flex-col gap-2 text-sm">{t("默认交互模式", "Default interaction mode")}<RadixSelect aria-label={t("新会话默认交互模式", "New session default interaction mode")} value={draft.interactionMode ?? "default"} disabled={loading || saving} onChange={(event) => { setDraft({ ...draft, interactionMode: event.target.value === "plan" ? "plan" : "default" }); setSuccess(false); }}><option value="default">{t("默认", "Default")}</option><option value="plan">{t("计划", "Plan")}</option></RadixSelect></label></>}
        {draft && !validDraft && !providersLoading && !providersError && <p role="alert" className="text-destructive text-sm">{t("请选择有效且可用的模型和选项。", "Select a valid, available model and options.")}</p>}
        
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!saved || !dirty || !validDraft || loading || saving || providersLoading || Boolean(providersError)}>{saving ? t("正在保存…", "Saving…") : t("保存默认模型", "Save default model")}</Button>
          <Button type="button" variant="outline" disabled={!dirty || loading || saving} onClick={() => { setDraft(saved?.defaults.selection ?? null); setError(null); setSuccess(false); }}>{t("放弃更改", "Discard changes")}</Button>
          <Button type="button" variant="ghost" disabled={loading || saving} onClick={() => { void load(dirty); void refresh(); }}>{t("重新读取", "Reload")}</Button>
          {saved && <span className="text-muted-foreground text-xs">{t("版本", "Version")} {saved.defaults.revision}</span>}
        </div>
      </form>
    </SettingsSection>
  );
}
