import { useEffect, useState } from "react";
import { useBlocker } from "react-router-dom";
import type { RemoteSettings } from "@agent-workspace/contracts/chat";
import type { ProviderInstance } from "@agent-workspace/contracts/provider";
import { getProviderInstanceDisplayName, resolveProviderModelSelection } from "@agent-workspace/client-runtime/providers";
import { Button } from "@agent/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@agent/components/ui/dialog";
import { useAgentText } from "../i18n";
import { agentText } from "../i18n-text.ts";
import { ModelOptionControls, modelOptionsValid, providerSelectable, visibleProviderModels } from "./model-option-controls";
import "./chat-preferences.css";
import { RadixSelect } from "@/components/ui/radix-select"

type SessionSettingsDialogProps = {
  settings: RemoteSettings;
  providers: ProviderInstance[];
  providersLoading: boolean;
  providersError?: string;
  onRefreshProviders: () => void;
  saving: boolean;
  onSave: (settings: RemoteSettings) => Promise<void>;
  onClose: () => void;
};
export default function SessionSettingsDialog({ settings, providers, providersLoading, providersError, onRefreshProviders, saving, onSave, onClose }: SessionSettingsDialogProps) {
  const t = useAgentText();
  // A mounted dialog owns its draft; catalog refreshes never overwrite editing.
  const [draft, setDraft] = useState<RemoteSettings>(() => ({ ...settings }));
  const [temperature, setTemperature] = useState(String(settings.temperature));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings) || temperature !== String(settings.temperature);
  const busy = pending || saving;
  const blocker = useBlocker(dirty || busy);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (!busy && window.confirm(agentText("放弃尚未保存的会话参数并离开？", "Discard unsaved session settings and leave?"))) blocker.proceed();
    else blocker.reset();
  }, [blocker, busy]);
  const selection = resolveProviderModelSelection(providers, draft.providerInstanceId, draft.model);
  const provider = "provider" in selection ? selection.provider : undefined;
  const model = "model" in selection ? selection.model : undefined;
  const supportsTemperature = model?.temperature === true;
  const selected = JSON.stringify([draft.providerInstanceId, draft.model]);
  const validTemperature = temperature.trim() !== "" && Number.isFinite(Number(temperature)) && Number(temperature) >= 0 && Number(temperature) <= 2;
  const canSave = !busy && !providersLoading && !providersError && selection.status === "selected" && providerSelectable(provider) && modelOptionsValid(model, draft.modelOptions ?? provider?.modelPreferences?.options[draft.model]) && (!supportsTemperature || validTemperature);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirty || busy) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty, busy]);
  const close = () => {
    if (busy || (dirty && !window.confirm(agentText("放弃尚未保存的会话参数？", "Discard unsaved session settings?")))) return;
    onClose();
  };
  const save = async () => {
    if (!canSave) return;
    setPending(true); setError(undefined);
    try {
      await onSave({ ...draft, temperature: supportsTemperature ? Number(temperature) : draft.temperature });
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };
  return <Dialog open onOpenChange={(open) => { if (!open) close(); }}><DialogContent className="agent-session-dialog" showCloseButton={!busy}>
    <DialogHeader><DialogTitle>{t("当前会话参数", "Current session settings")}</DialogTitle></DialogHeader>
    <div className="agent-session-fields">
      <label>{t("Provider 与模型", "Provider & model")}<RadixSelect aria-label={t("当前会话模型", "Current session model")} value={selected} disabled={busy || providersLoading} onChange={(event) => {
        const [providerInstanceId, modelId] = JSON.parse(event.target.value) as [string, string];
        setDraft((previous) => ({ ...previous, providerInstanceId, model: modelId, modelOptions: providers.find((item) => item.instanceId === providerInstanceId)?.modelPreferences?.options[modelId] ?? [] }));
      }}>
        {(selection.status !== "selected" || !providerSelectable(provider) || provider?.modelPreferences?.hidden.includes(model?.id ?? draft.model) || model?.id !== draft.model) && <option value={selected}>{draft.providerInstanceId || draft.model ? (model && provider?.modelPreferences?.hidden.includes(model.id)
          ? t(`原选择：${draft.providerInstanceId} / ${draft.model}（已隐藏）`, `Original selection: ${draft.providerInstanceId} / ${draft.model} (hidden)`)
          : selection.status === "selected" && providerSelectable(provider) ? `${getProviderInstanceDisplayName(selection.provider)} · ${selection.model.label} · ${draft.model}` : t(`原选择：${draft.providerInstanceId} / ${draft.model}（不可用）`, `Original selection: ${draft.providerInstanceId} / ${draft.model} (unavailable)`)) : t("请选择模型", "Select a model")}</option>}
        {providers.map((item) => <optgroup key={item.instanceId} label={`${getProviderInstanceDisplayName(item)}${!item.enabled ? t("（已停用）", " (disabled)") : !providerSelectable(item) ? t("（原生会话未就绪）", " (native session not ready)") : item.authStatus === "unknown" ? t("（原生会话已就绪，身份未知）", " (native session ready, identity unknown)") : ""}`} disabled={!providerSelectable(item)}>{visibleProviderModels(item).map((candidate) => <option key={candidate.id} value={JSON.stringify([item.instanceId, candidate.id])} disabled={!!candidate.disabledReason} title={candidate.disabledReason}>{candidate.label}{candidate.subProvider ? ` · ${candidate.subProvider}` : ""}{candidate.badge === "new" ? t(" · 新", " · New") : ""} · {candidate.id} · {candidate.source === "custom" ? t("自定义", "Custom") : candidate.source === "discovered" ? t("实际发现", "Discovered") : t("内置", "Built-in")}</option>)}</optgroup>)}
      </RadixSelect></label>
      {(providersLoading || providersError) && <p role={providersError ? "alert" : "status"}>{providersLoading ? t("正在读取模型目录…", "Loading model catalog…") : providersError}</p>}
      <Button size="sm" variant="outline" disabled={busy || providersLoading} onClick={onRefreshProviders}>{t("重新读取模型目录", "Reload model catalog")}</Button>
      <label>{t("系统提示词", "System prompt")}<textarea aria-label={t("当前会话系统提示词", "Current session system prompt")} value={draft.systemPrompt} maxLength={16000} disabled={busy} onChange={(event) => setDraft((previous) => ({ ...previous, systemPrompt: event.target.value }))} placeholder={t("系统提示词", "System prompt")} /></label>
      <label>Temperature<input aria-label={t("当前会话 temperature", "Current session temperature")} type="number" min="0" max="2" step="0.1" value={temperature} disabled={busy || !supportsTemperature} onChange={(event) => setTemperature(event.target.value)} /></label>
      {supportsTemperature && !validTemperature && <p role="alert" className="text-destructive">{t("请输入 0 到 2 之间的数值。", "Enter a value between 0 and 2.")}</p>}
      <ModelOptionControls model={model} selections={draft.modelOptions ?? provider?.modelPreferences?.options[draft.model]} disabled={busy} onChange={(modelOptions) => setDraft((previous) => ({ ...previous, modelOptions }))} />
      <label>{t("交互模式", "Interaction mode")}<RadixSelect aria-label={t("当前会话交互模式", "Current session interaction mode")} disabled={busy} value={draft.interactionMode ?? "default"} onChange={(event) => setDraft((previous) => ({ ...previous, interactionMode: event.target.value === "plan" ? "plan" : "default" }))}><option value="default">{t("默认", "Default")}</option><option value="plan">{t("计划", "Plan")}</option></RadixSelect></label>
      {error && <p role="alert" className="text-destructive">{t("参数未保存，编辑内容已保留：", "Settings were not saved; your edits are preserved: ")}{error}</p>}
    </div>
    <DialogFooter><Button variant="outline" disabled={busy} onClick={close}>{t("取消", "Cancel")}</Button><Button disabled={!canSave} onClick={() => void save()}>{busy ? t("正在保存…", "Saving…") : t("保存会话参数", "Save session settings")}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
