"use client";

import { useCallback, useRef, useState } from "react";
import { ChevronRight, KeyRound, Plug, Plus, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { ProviderInstance } from "@agent-workspace/contracts/provider";
import { useProviders } from "@/hooks/use-providers";
import { ProviderCard, ProviderGlyph, ProviderStatus } from "./provider-card";
import { ProviderAuthDialog } from "./provider-auth-dialog";
import { ProviderInstanceDialog, ProviderInstanceForm } from "./provider-instance-dialog";
import "../../styles/providers.css";

export default function ProvidersPage() {
  const { providers, drivers, loading, error, refresh, test, logout, loadAuth, startAuth, cancelAuth, sendAuthInput, authState, authInstanceId, authError, clearAuth, createInstance, updateInstance, removeInstance, searchAcpRegistry, prepareInstance } = useProviders();
  const [authFor, setAuthFor] = useState<ProviderInstance | null>(null);
  const [instanceOpen, setInstanceOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [draftEpoch, setDraftEpoch] = useState(0);
  const editing = useRef<"clean" | "dirty" | "busy">("clean");
  const onEditingChange = useCallback((state: "clean" | "dirty" | "busy") => { editing.current = state; }, []);
  const selectedProvider = providers.find((item) => item.instanceId === selectedId) ?? providers[0];
  const visibleProviders = providers.filter((item) => `${item.label} ${item.driver}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const authProvider = authFor ? providers.find((item) => item.instanceId === authFor.instanceId) ?? authFor : null;
  const readyCount = providers.filter((provider) => provider.enabled && provider.configured).length;
  const operations = { createInstance, updateInstance, removeInstance, searchAcpRegistry, prepareInstance };

  function protectDraft() {
    if (editing.current === "busy") return false;
    if (editing.current === "dirty") {
      if (!window.confirm("放弃尚未保存的提供商配置？")) return false;
      editing.current = "clean";
      setDraftEpoch((current) => current + 1);
    }
    return true;
  }

  function openAuth(provider: ProviderInstance) {
    if (!protectDraft()) return;
    clearAuth();
    setAuthFor(provider);
  }

  return <>
    <div className="provider-page-heading"><div><h2>Providers</h2><span>{readyCount} / {providers.length} 个已启用并配置</span></div><div><Button variant="ghost" size="sm" disabled={loading} onClick={() => void refresh()}><RefreshCw aria-hidden="true" className={loading ? "animate-spin" : undefined} />刷新状态</Button><Button variant="outline" size="sm" disabled={drivers.length === 0} onClick={() => { if (protectDraft()) setInstanceOpen(true); }}><Plus aria-hidden="true" />添加提供商</Button></div></div>
    {error && <div role="alert" className="provider-feedback provider-feedback-error"><span>{error}</span><Button variant="outline" size="sm" disabled={loading} onClick={() => void refresh()}>重试</Button></div>}
    {loading && providers.length === 0 ? <div role="status" aria-label="正在加载提供商" className="provider-loading"><Skeleton className="h-full w-64" /><Skeleton className="h-full flex-1" /></div> : providers.length === 0 ? !error && <div className="provider-empty"><Plug aria-hidden="true" /><h2>尚未添加提供商</h2><p>添加原生 Agent 实例。初始目录仅包含 Codex 与 Claude，其余驱动按需添加。</p><Button variant="outline" size="sm" disabled={drivers.length === 0} onClick={() => setInstanceOpen(true)}><Plus aria-hidden="true" />添加提供商</Button></div> : <div className="provider-master-detail">
      <div className="provider-list-pane"><label className="provider-list-search"><Search aria-hidden="true" /><Input aria-label="搜索提供商" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索提供商…" /></label><nav className="provider-instance-list" aria-label="提供商实例">{visibleProviders.map((provider) => <button type="button" key={provider.instanceId} className="provider-list-item" aria-current={provider.instanceId === selectedProvider?.instanceId ? "true" : undefined} onClick={() => { if (provider.instanceId !== selectedProvider?.instanceId && protectDraft()) setSelectedId(provider.instanceId); }}><ProviderGlyph driver={provider.driver} accentColor={provider.accentColor} /><span className="provider-list-label"><span>{provider.label}<small>{drivers.find((entry) => entry.driver === provider.driver)?.label ?? provider.driver}{!provider.enabled ? " · 已停用" : ""}</small></span><ProviderStatus provider={provider} /></span><ChevronRight aria-hidden="true" className="provider-list-chevron" /></button>)}{visibleProviders.length === 0 && <p className="provider-list-empty">没有匹配的提供商</p>}</nav></div>
      <div className="provider-detail-pane">{selectedProvider && <ProviderCard key={selectedProvider.instanceId} provider={selectedProvider} definition={drivers.find((entry) => entry.driver === selectedProvider.driver)} onAuth={openAuth} onTest={test} onLogout={(provider) => logout(provider.instanceId)}><ProviderInstanceForm key={`${selectedProvider.instanceId}:${draftEpoch}`} provider={selectedProvider} drivers={drivers} {...operations} onEditingChange={onEditingChange} onDeleted={() => setSelectedId(null)} /></ProviderCard>}</div>
    </div>}
    <p className="provider-page-note"><KeyRound aria-hidden="true" />原生认证与配置秘密仅由本机服务端管理。各实例使用独立环境，不自动导入或修改全局账号。</p>
    <ProviderInstanceDialog open={instanceOpen} onOpenChange={setInstanceOpen} drivers={drivers} {...operations} onCreated={(provider) => { setSearch(""); setSelectedId(provider.instanceId); }} />
    <ProviderAuthDialog open={authProvider !== null} provider={authProvider} authState={authState} authInstanceId={authInstanceId} authError={authError} loadAuth={loadAuth} startAuth={startAuth} cancelAuth={cancelAuth} sendAuthInput={sendAuthInput} onOpenChange={(open) => { if (!open) { setAuthFor(null); clearAuth(); } }} />
  </>;
}
