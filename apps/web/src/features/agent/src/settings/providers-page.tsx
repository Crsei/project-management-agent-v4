"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Button } from "@agent/components/ui/button";
import { Skeleton } from "@agent/components/ui/skeleton";
import type { ProviderDriverDefinition, ProviderInstance } from "@agent-workspace/contracts/provider";
import { useProviders } from "@agent/hooks/use-providers";
import { getProviderInstanceDisplayName, shouldShowProviderInstanceBadge } from "@agent-workspace/client-runtime/providers";
import { useSettingsGuard } from "./settings-layout";
import { ProviderCard, ProviderGlyph, ProviderStatus } from "./provider-card";
import { ProviderAuthDialog } from "./provider-auth-dialog";
import { ProviderInstanceDialog, ProviderInstanceForm } from "./provider-instance-dialog";
import { ProviderMaintenance } from "./provider-maintenance";
import { ProviderHealthSetting } from "./provider-health-setting";
import { ProviderCodexSetup } from "./provider-codex-setup";
import { useAgentText } from "../i18n";

type ProviderRow = { id: string; definition?: ProviderDriverDefinition; provider?: ProviderInstance };

export default function ProvidersPage() {
  const t = useAgentText();
  const { providers, drivers, loading, error, refresh, test, logout, loadAuth, startAuth, cancelAuth, sendAuthInput, authState, authInstanceId, authError, clearAuth, createInstance, updateInstance, removeInstance, resetInstance, searchAcpRegistry } = useProviders();
  const [authFor, setAuthFor] = useState<ProviderInstance | null>(null);
  const [authMethod, setAuthMethod] = useState<string | undefined>();
  const [authAutoStart, setAuthAutoStart] = useState(false);
  const [instanceOpen, setInstanceOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftEpoch, setDraftEpoch] = useState(0);
  const [toggleId, setToggleId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Keep a successful mutation visible if the subsequent status refresh fails.
  const [pendingProviders, setPendingProviders] = useState<Record<string, ProviderInstance>>({});
  const [editingState, setEditingState] = useState<"clean" | "dirty" | "busy">("clean");
  const editorSlot = useRef<{ id: string; slot: boolean } | null>(null);
  const editing = useRef<"clean" | "dirty" | "busy">("clean");
  const cardBusy = useRef(false);
  const maintenanceBusy = useRef(false);
  const codexBusy = useRef(false);
  const toggling = useRef(false);
  const { setGuard } = useSettingsGuard();
  useEffect(() => { setGuard(toggleId ? "busy" : "clean"); return () => setGuard("clean"); }, [toggleId, setGuard]);
  useEffect(() => {
    setPendingProviders((current) => {
      const next = { ...current };
      let changed = false;
      for (const provider of providers) {
        const pending = next[provider.instanceId];
        if (pending && (pending.revision === undefined || (provider.revision !== undefined && provider.revision >= pending.revision))) {
          delete next[provider.instanceId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [providers, pendingProviders]);
  const onEditingChange = useCallback((state: "clean" | "dirty" | "busy") => { editing.current = state; setEditingState(state); }, []);
  const onCardBusyChange = useCallback((busy: boolean) => { cardBusy.current = busy; }, []);
  const onMaintenanceBusyChange = useCallback((busy: boolean) => { maintenanceBusy.current = busy; }, []);
  const onCodexBusyChange = useCallback((busy: boolean) => { codexBusy.current = busy; }, []);
  const rememberProvider = (provider: ProviderInstance) => setPendingProviders((current) => ({ ...current, [provider.instanceId]: provider }));
  const allProviders = providers.map((provider) => {
    const pending = pendingProviders[provider.instanceId];
    return pending && (provider.revision === undefined || (pending.revision !== undefined && pending.revision > provider.revision)) ? pending : provider;
  });
  for (const provider of Object.values(pendingProviders)) if (!allProviders.some((entry) => entry.instanceId === provider.instanceId)) allProviders.push(provider);
  const rows: ProviderRow[] = [];
  for (const definition of drivers) {
    const matching = allProviders.filter((provider) => provider.driver === definition.driver);
    const defaultProvider = matching.find((provider) => provider.instanceId === definition.driver);
    if (defaultProvider) rows.push({ id: defaultProvider.instanceId, definition, provider: defaultProvider });
    else if (definition.defaultInstance && (definition.driver === "codex" || definition.driver === "claude" || selectedId === definition.driver) && !allProviders.some((provider) => provider.instanceId === definition.driver)) rows.push({ id: definition.driver, definition });
    for (const provider of matching) if (provider !== defaultProvider) rows.push({ id: provider.instanceId, definition, provider });
  }
  for (const provider of allProviders) if (!drivers.some((definition) => definition.driver === provider.driver)) rows.push({ id: provider.instanceId, provider });
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0];
  const selectedProvider = selected?.provider;
  const authProvider = authFor ? allProviders.find((item) => item.instanceId === authFor.instanceId) ?? authFor : null;
  if (selected && editorSlot.current?.id !== selected.id) editorSlot.current = { id: selected.id, slot: !selected.provider };
  if (selected?.provider && editorSlot.current?.id === selected.id && editingState === "clean") editorSlot.current.slot = false;
  const operations = { createInstance, updateInstance, removeInstance, searchAcpRegistry };

  function protectDraft() {
    if (editing.current === "busy" || cardBusy.current || maintenanceBusy.current || codexBusy.current || toggling.current) return false;
    if (editing.current === "dirty") {
      if (!window.confirm(t("放弃尚未保存的提供商配置？", "Discard the unsaved provider configuration?"))) return false;
      editing.current = "clean";
      setDraftEpoch((current) => current + 1);
    }
    return true;
  }

  function openAuth(provider: ProviderInstance, methodId?: string) {
    if (!protectDraft()) return;
    clearAuth();
    setAuthMethod(methodId);
    setAuthAutoStart(provider.driver === "codex" && methodId !== undefined);
    setAuthFor(provider);
  }

  async function toggle(row: ProviderRow) {
    if (!protectDraft()) return;
    toggling.current = true;
    setToggleId(row.id);
    setActionError(null);
    try {
      const next = row.provider
        ? await updateInstance(row.id, { enabled: !row.provider.enabled, revision: row.provider.revision })
        : await createInstance({ instanceId: row.id, driver: row.definition!.driver, label: row.definition!.label, enabled: true });
      rememberProvider(next);
    } catch (cause) {
      setActionError(cause instanceof Error && cause.message ? cause.message : t("更新提供商状态失败。", "Failed to update provider status."));
    } finally {
      toggling.current = false;
      setToggleId(null);
    }
  }
  async function startCodex(mode: "existing" | "managed") {
    if (!selected?.definition || !protectDraft()) return;
    toggling.current = true;
    setToggleId(selected.id);
    setActionError(null);
    try {
      const next = selected.provider
        ? await updateInstance(selected.id, { revision: selected.provider.revision, enabled: true, config: { setupMode: mode } })
        : await createInstance({ instanceId: selected.id, driver: "codex", label: selected.definition.label, enabled: true, config: { setupMode: mode } });
      rememberProvider(next);
      setDraftEpoch((value) => value + 1);
      if (mode === "managed") {
        clearAuth();
        setAuthMethod("chatgpt-new");
        setAuthAutoStart(true);
        setAuthFor(next);
      }
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t("无法配置 Codex。", "Unable to configure Codex."));
    } finally {
      toggling.current = false;
      setToggleId(null);
    }
  }
  async function resetDefault(provider: ProviderInstance) {
    if (!protectDraft() || provider.revision === undefined || !window.confirm(t("重置此默认实例的所有设置？此操作不会退出原生账号。", "Reset all settings for this default instance? This does not sign out of the native account."))) return;
    setToggleId(provider.instanceId); toggling.current = true; setActionError(null);
    try {
      const next = await resetInstance(provider.instanceId, provider.revision);
      setPendingProviders(current => {
        const updated = { ...current };
        if (next) updated[provider.instanceId] = next;
        else delete updated[provider.instanceId];
        return updated;
      });
      if (!next) setSelectedId(null);
      setDraftEpoch((value) => value + 1);
    }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : t("重置失败。", "Reset failed.")); }
    finally { toggling.current = false; setToggleId(null); }
  }

  return <>
    <div className="provider-page-heading"><h2>{t("提供商", "Providers")}</h2><Button variant="ghost" size="sm" disabled={loading || toggleId !== null} onClick={() => { if (protectDraft()) void refresh(); }}><RefreshCw aria-hidden="true" className={loading ? "animate-spin" : undefined} />{t("刷新状态", "Refresh status")}</Button></div>
    <ProviderHealthSetting />
    {error && <div role="alert" className="provider-feedback provider-feedback-error"><span>{error}</span><Button variant="outline" size="sm" disabled={loading || toggleId !== null} onClick={() => { if (protectDraft()) void refresh(); }}>{t("重试", "Retry")}</Button></div>}
    {actionError && <div role="alert" className="provider-feedback provider-feedback-error"><span>{actionError}</span><Button variant="outline" size="sm" disabled={loading || toggleId !== null} onClick={() => { if (protectDraft()) void refresh(); }}>{t("刷新状态", "Refresh status")}</Button></div>}
    {loading && drivers.length === 0 && providers.length === 0 ? <div role="status" aria-label={t("正在加载提供商", "Loading providers")} className="provider-loading"><Skeleton className="h-full w-64" /><Skeleton className="h-full flex-1" /></div> : <div className="provider-master-detail">
      <div className="provider-list-pane"><nav className="provider-instance-list" aria-label={t("提供商实例", "Provider instances")}>
        {rows.map((row) => {
          const provider = row.provider;
          const label = provider ? getProviderInstanceDisplayName(provider) : row.definition!.label;
          const driver = provider?.driver ?? row.definition!.driver;
          return <div key={row.id} className="provider-list-item" data-selected={row.id === selected?.id || undefined}>
            <button type="button" className="provider-list-select" aria-current={row.id === selected?.id ? "true" : undefined} onClick={() => { if (row.id !== selected?.id && protectDraft()) { setSelectedId(row.id); setActionError(null); } }}>
              <ProviderGlyph driver={driver} accentColor={provider?.accentColor} iconUrl={provider?.registryIconUrl} displayName={label} showInstanceBadge={provider ? shouldShowProviderInstanceBadge(provider, allProviders) : false} /><span className="provider-list-label"><span>{label}{provider?.installation?.version && <small>{provider.installation.version}</small>}</span>{provider ? <ProviderStatus provider={provider} /> : <span className="provider-status" data-status="disabled">{t("已停用", "Disabled")}</span>}</span>
            </button>
            <button type="button" role="switch" className="provider-enable-switch" aria-label={t(`启用 ${label}`, `Enable ${label}`)} aria-checked={provider?.enabled ?? false} disabled={toggleId !== null} onClick={() => void toggle(row)}><span /></button>
          </div>;
        })}
        <button type="button" className="provider-list-add" disabled={drivers.length === 0 || toggleId !== null} onClick={() => { if (protectDraft()) setInstanceOpen(true); }}><Plus aria-hidden="true" />{t("添加提供商", "Add provider")}</button>
      </nav></div>
      <div className="provider-detail-pane" inert={toggleId !== null} aria-busy={toggleId !== null}>
        {selected && selectedProvider && !editorSlot.current?.slot ? (
          <ProviderCard key={selected.id} provider={selectedProvider} definition={selected.definition} onAuth={openAuth} onTest={test} onLogout={(provider) => logout(provider.instanceId)} onBeforeAction={protectDraft} onBusyChange={onCardBusyChange}>
            {(setup) => <>
              <ProviderInstanceForm
                key={`${selected.id}:${draftEpoch}`}
                provider={selectedProvider}
                defaultDriver={selected.definition?.defaultInstance && selected.id === selected.definition.driver ? selected.definition : undefined}
                defaultInstanceId={selected.definition?.defaultInstance && selected.id === selected.definition.driver ? selected.id : undefined}
                drivers={drivers}
                {...operations}
                identityStatus={<ProviderStatus provider={selectedProvider} />}
                setup={selectedProvider.driver === "codex" && selectedProvider.config.setupMode === "managed"
                  ? <ProviderCodexSetup provider={selectedProvider} onBeforeAction={protectDraft} onBusyChange={onCodexBusyChange} onUpdate={updateInstance} onSaved={rememberProvider} onRefresh={refresh} onAuth={openAuth} onLogout={logout} />
                  : setup}
                runtime={selectedProvider.driver === "codex" && selectedProvider.config.setupMode === "managed"
                  ? <ProviderMaintenance provider={selectedProvider} definition={selected.definition} onBeforeAction={protectDraft} onBusyChange={onMaintenanceBusyChange} onRefresh={refresh} />
                  : undefined}
                onEditingChange={onEditingChange}
                onSaved={rememberProvider}
                onDeleted={() => { setPendingProviders((current) => { const next = { ...current }; delete next[selected.id]; return next; }); setSelectedId(null); }}
              />
              {selectedProvider.driver !== "codex" && <ProviderMaintenance provider={selectedProvider} definition={selected.definition} onBeforeAction={protectDraft} onBusyChange={onMaintenanceBusyChange} onRefresh={refresh} />}
              {selected.definition?.defaultInstance && selected.id === selected.definition.driver && <section className="provider-danger-zone"><div><span className="provider-setting-label">{t("重置默认实例", "Reset default instance")}</span><p>{t("此操作不会退出原生账号。", "This action does not sign out of the native account.")}</p></div><Button type="button" size="sm" variant="outline" disabled={selectedProvider.revision === undefined} onClick={() => void resetDefault(selectedProvider)}>{t("重置", "Reset")}</Button></section>}
            </>}
          </ProviderCard>
        ) : selected?.definition ? (
          <article className="provider-detail">
            <header className="provider-detail-heading"><ProviderGlyph driver={selected.definition.driver} /><h2>{selected.definition.label}</h2></header>
            {selected.definition.driver === "codex" && <section className="provider-settings-section provider-settings-group provider-codex-onboarding" aria-label={t("连接 Codex", "Connect Codex")}>
              <div><strong>Codex</strong></div>
              <Button type="button" size="sm" onClick={() => void startCodex("managed")}>{t("继续使用 ChatGPT", "Continue with ChatGPT")}</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => void startCodex("existing")}>{t("使用现有 CLI", "Use existing CLI")}</Button>
            </section>}
            <ProviderInstanceForm key={`${selected.id}:${draftEpoch}`} provider={null} defaultDriver={selected.definition} defaultInstanceId={selected.id} drivers={drivers} {...operations} identityStatus={selectedProvider ? <ProviderStatus provider={selectedProvider} /> : <span className="provider-status" data-status="disabled">{t("已停用", "Disabled")}</span>} onEditingChange={onEditingChange} onSaved={rememberProvider} />
          </article>
        ) : <div className="provider-list-empty">{t("暂无可用的提供商驱动。", "No provider drivers available.")}</div>}
      </div>
    </div>}
    <ProviderInstanceDialog open={instanceOpen} onOpenChange={setInstanceOpen} drivers={drivers} providers={allProviders} {...operations} onCreated={(provider) => {
      rememberProvider(provider);
      setSelectedId(provider.instanceId);
      if ((provider.driver === "codex" && provider.config.setupMode === "managed") || (provider.driver === "acpRegistry" && provider.config.source !== "local")) {
        clearAuth();
        setAuthMethod(provider.driver === "codex" ? "chatgpt-new" : undefined);
        setAuthAutoStart(provider.driver === "codex");
        setAuthFor(provider);
      }
    }} />
    <ProviderAuthDialog open={authProvider !== null} provider={authProvider} authState={authState} authInstanceId={authInstanceId} authError={authError} initialMethodId={authMethod} autoStart={authAutoStart} loadAuth={loadAuth} startAuth={startAuth} cancelAuth={cancelAuth} sendAuthInput={sendAuthInput} onOpenChange={(open) => { if (!open) { setAuthFor(null); setAuthMethod(undefined); setAuthAutoStart(false); clearAuth(); } }} />
  </>;
}
