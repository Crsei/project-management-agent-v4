import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { ChatDefaultSelection, ChatDefaultsResponse } from "@agent-workspace/contracts/settings";
import { useProviders } from "@/hooks/use-providers";
import { refreshNewChatDefaults } from "@/hooks/use-chat-settings";
import { Button } from "@/components/ui/button";
import { workspaceClient } from "../network";
import { SettingsNotice, SettingsSection, useSettingsGuard } from "./settings-layout";

export default function DefaultModelSettings() {
  const { providers, loading: providersLoading, error: providersError, refresh } = useProviders();
  const { setGuard } = useSettingsGuard();
  const [saved, setSaved] = useState<ChatDefaultsResponse | null>(null);
  const [draft, setDraft] = useState<ChatDefaultSelection | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const dirty = saved !== null && JSON.stringify(saved.defaults.selection) !== JSON.stringify(draft);
  const provider = providers.find((item) => item.instanceId === draft?.providerInstanceId);
  const model = provider?.models.find((item) => item.id === draft?.model);
  const validDraft = draft === null || Boolean(provider?.enabled && provider.configured && model);

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
      setError(cause instanceof Error ? cause.message : "无法读取默认模型。");
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
      setError(cause instanceof Error ? cause.message : "保存失败，草稿已保留。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection title="新会话默认模型" scope="service" description="只影响之后创建的会话。已有会话保留自己的模型与参数，不会随默认设置变化。">
      {loading && <SettingsNotice kind="loading">正在读取默认模型…</SettingsNotice>}
      {error && <SettingsNotice kind="error" onRetry={() => { void load(true); }}>{error} 重新读取只更新版本，不会清除当前草稿。</SettingsNotice>}
      {providersError && <SettingsNotice kind="error" onRetry={() => { void refresh(); }}>{providersError}</SettingsNotice>}
      {saved?.availability.status === "unavailable" && <SettingsNotice kind="error">原默认模型不可用：{saved.availability.reason} 不会自动切换到其他提供商；请重新选择或清除默认值。</SettingsNotice>}
      {saved?.availability.status === "unset" && <SettingsNotice kind="info">尚未设置默认模型。新会话会要求在输入框显式选择提供商和模型，选择前不能发送。</SettingsNotice>}
      {success && <SettingsNotice kind="success">已保存。只对之后创建的会话生效。</SettingsNotice>}
      <form onSubmit={save} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex min-w-0 flex-col gap-2 text-sm">
            <span>模型提供商</span>
            <select
              aria-label="新会话默认提供商"
              className="border-input bg-background min-w-0 rounded-md border px-3 py-2 text-sm"
              value={draft?.providerInstanceId ?? ""}
              disabled={loading || saving || providersLoading}
              onChange={(event) => { setDraft(event.target.value ? { providerInstanceId: event.target.value, model: "" } : null); setSuccess(false); }}
            >
              <option value="">不设置默认值</option>
              {draft && !provider && <option value={draft.providerInstanceId}>{draft.providerInstanceId}（已不可用）</option>}
              {providers.map((item) => <option key={item.instanceId} value={item.instanceId} disabled={!item.enabled || !item.configured}>{item.label}{!item.enabled ? "（已停用）" : item.configured ? "" : "（未就绪）"}</option>)}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-2 text-sm">
            <span>模型</span>
            <select
              aria-label="新会话默认模型"
              className="border-input bg-background min-w-0 rounded-md border px-3 py-2 text-sm"
              value={draft?.model ?? ""}
              disabled={!draft || loading || saving || providersLoading || !provider?.enabled || !provider.configured}
              onChange={(event) => { if (draft) setDraft({ ...draft, model: event.target.value }); setSuccess(false); }}
            >
              <option value="">请选择模型</option>
              {draft?.model && !model && <option value={draft.model}>{draft.model}（已不可用）</option>}
              {provider?.models.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.source === "custom" ? "自定义" : item.source === "discovered" ? "实际发现" : "内置"}</option>)}
            </select>
          </label>
        </div>
        {draft && !validDraft && !providersLoading && !providersError && <p role="alert" className="text-destructive text-sm">请选择已启用且配置就绪的提供商中的有效模型；当前选择不能保存，也不会被其他模型替代。</p>}
        <p className="text-muted-foreground text-sm">没有可用选项？先前往 <Link className="underline underline-offset-4" to="/settings/providers">提供商设置</Link> 配置凭据和模型。保存默认值不代表连接验证或实际模型调用成功。</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!saved || !dirty || !validDraft || loading || saving || providersLoading || Boolean(providersError)}>{saving ? "正在保存…" : "保存默认模型"}</Button>
          <Button type="button" variant="outline" disabled={!dirty || loading || saving} onClick={() => { setDraft(saved?.defaults.selection ?? null); setError(null); setSuccess(false); }}>放弃更改</Button>
          <Button type="button" variant="ghost" disabled={loading || saving} onClick={() => { void load(dirty); void refresh(); }}>重新读取</Button>
          {saved && <span className="text-muted-foreground text-xs">版本 {saved.defaults.revision}</span>}
        </div>
      </form>
    </SettingsSection>
  );
}
