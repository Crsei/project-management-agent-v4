import { useEffect, useState } from "react";
import { useBlocker } from "react-router-dom";
import type { RemoteSettings } from "@agent-workspace/contracts/chat";
import type { ProviderInstance } from "@agent-workspace/contracts/provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import "./chat-preferences.css";

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
  // A mounted dialog owns its draft; catalog refreshes never overwrite editing.
  const [draft, setDraft] = useState<RemoteSettings>(() => ({
    providerInstanceId: settings.providerInstanceId, model: settings.model,
    systemPrompt: settings.systemPrompt, temperature: settings.temperature,
  }));
  const [temperature, setTemperature] = useState(String(settings.temperature));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const dirty = draft.providerInstanceId !== settings.providerInstanceId || draft.model !== settings.model
    || draft.systemPrompt !== settings.systemPrompt || temperature !== String(settings.temperature);
  const busy = pending || saving;
  const blocker = useBlocker(dirty || busy);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (!busy && window.confirm("放弃尚未保存的会话参数并离开？")) blocker.proceed();
    else blocker.reset();
  }, [blocker, busy]);
  const provider = providers.find((item) => item.instanceId === draft.providerInstanceId);
  const model = provider?.models.find((item) => item.id === draft.model);
  const supportsTemperature = model?.temperature === true;
  const selected = JSON.stringify([draft.providerInstanceId, draft.model]);
  const validTemperature = temperature.trim() !== "" && Number.isFinite(Number(temperature)) && Number(temperature) >= 0 && Number(temperature) <= 2;
  const canSave = !busy && !providersLoading && !providersError && !!provider?.enabled && !!model && provider.configured && (!supportsTemperature || validTemperature);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirty || busy) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty, busy]);
  const close = () => {
    if (busy || (dirty && !window.confirm("放弃尚未保存的会话参数？"))) return;
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
    <DialogHeader><DialogTitle>当前会话参数</DialogTitle><DialogDescription>仅保存到当前会话，下一次发送前必须保存成功。已接受或正在生成的回复继续使用原参数快照；不会修改新会话默认值。</DialogDescription></DialogHeader>
    <div className="agent-session-fields">
      <label>Provider 与模型<select aria-label="当前会话模型" value={selected} disabled={busy || providersLoading} onChange={(event) => {
        const [providerInstanceId, modelId] = JSON.parse(event.target.value) as [string, string];
        setDraft((previous) => ({ ...previous, providerInstanceId, model: modelId }));
      }}>
        {(!model || !provider?.enabled || !provider.configured) && <option value={selected}>{draft.providerInstanceId || draft.model ? `原选择不可用：${draft.providerInstanceId} / ${draft.model}` : "请选择模型"}</option>}
        {providers.map((item) => <optgroup key={item.instanceId} label={`${item.label}${!item.enabled ? "（已停用）" : item.configured ? "" : "（未就绪）"}`} disabled={!item.enabled || !item.configured}>{item.models.map((candidate) => <option key={candidate.id} value={JSON.stringify([item.instanceId, candidate.id])}>{candidate.label} · {candidate.id} · {candidate.source === "custom" ? "自定义" : candidate.source === "discovered" ? "实际发现" : "内置"}</option>)}</optgroup>)}
      </select><small>只列出服务端登记或检测到的模型。凭据已配置不代表连接已验证；失效选择不会自动替换。</small></label>
      {(providersLoading || providersError) && <p role={providersError ? "alert" : "status"}>{providersLoading ? "正在读取模型目录…" : providersError}</p>}
      <Button size="sm" variant="outline" disabled={busy || providersLoading} onClick={onRefreshProviders}>重新读取模型目录</Button>
      <label>系统提示词<textarea aria-label="当前会话系统提示词" value={draft.systemPrompt} maxLength={16000} disabled={busy} onChange={(event) => setDraft((previous) => ({ ...previous, systemPrompt: event.target.value }))} placeholder="留空表示不添加自定义系统提示词" /><small>发送给当前模型的会话级指令；不能授予权限、扩大文件区域或改变业务规则。不要填写秘密。</small></label>
      <label>Temperature<input aria-label="当前会话 temperature" type="number" min="0" max="2" step="0.1" value={temperature} disabled={busy || !supportsTemperature} onChange={(event) => setTemperature(event.target.value)} /><small>{supportsTemperature ? "此模型支持 0–2 的 temperature；数值只影响后续请求。" : "当前模型未声明支持 temperature，此参数不会作为可调能力发送。"}</small></label>
      {supportsTemperature && !validTemperature && <p role="alert" className="text-destructive">请输入 0 到 2 之间的数值。</p>}
      <p className="text-muted-foreground text-xs">思考强度：当前没有已接通的可调执行参数，不提供模拟控制。</p>
      {error && <p role="alert" className="text-destructive">参数未保存，编辑内容已保留：{error}</p>}
    </div>
    <DialogFooter><Button variant="outline" disabled={busy} onClick={close}>取消</Button><Button disabled={!canSave} onClick={() => void save()}>{busy ? "正在保存…" : "保存会话参数"}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
