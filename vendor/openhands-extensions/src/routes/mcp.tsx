import React from "react";
import { Download, Plus, RefreshCw } from "lucide-react";
import { INTEGRATION_CATALOG as MCP_MARKETPLACE, type IntegrationCatalogEntry as MarketplaceEntry } from "@openhands/extensions/integrations";
import { useMcpManagement, useMcpConnectivity, usePreviewMcpImport, useApplyMcpImport, useResyncMcpToApps, APP_DISPLAY_NAME, hasUnsavedChanges, toast } from "@pm/cc-switch-ui";
import type { ExtensionAppId, ExtensionMcpDefinition } from "@agent-workspace/contracts/extensions";
import { useOpenHandsTranslation } from "@pm/openhands-source/web/i18n";
import { webPlatform } from "@pm/openhands-source/web/bridge";
import { findCatalogEntryForServer, getMcpMarketplaceCatalog, installedServerMatchesQuery } from "@pm/openhands-source/utils/mcp-marketplace-utils";
import { InstalledServersSection, McpToolbar, MarketplaceSection, InstallServerModal, CustomServerEditor } from "@pm/openhands-source/components/features/mcp-page";
import { definitionToCard, managementToSourceServers } from "@pm/openhands-source/web/mcp/definition-adapter";
import { AgentConfigurationDrawer } from "@pm/openhands-source/web/mcp/agent-configuration-drawer";
import { McpImportPreviewDialog } from "@pm/openhands-source/web/mcp/import-preview-dialog";
import { McpAgentMatrix } from "@pm/openhands-source/web/mcp/agent-matrix";
import { AgentStack } from "@pm/openhands-source/web/shared/agent-avatar";
import "@pm/openhands-source/web/mcp/management.css";

/** The copied OpenHands Marketplace/installed presentation, backed only by the
 * authorized CC Switch library, assignment and source lifecycle operations. */
export function OpenHandsMcpPage({ onInteractionBlockedChange }: { onInteractionBlockedChange?: (blocked: boolean) => void }) {
  const { t } = useOpenHandsTranslation();
  const management = useMcpManagement();
  const context = webPlatform().context;
  const nativePreview = usePreviewMcpImport();
  const applyNative = useApplyMcpImport();
  const resyncAll = useResyncMcpToApps();
  const previewStarted = React.useRef(false);
  const sourceServers = React.useMemo(() => management.data ? managementToSourceServers(management.data) : undefined, [management.data]);
  const probe = useMcpConnectivity(sourceServers);
  const [installEntry, setInstallEntry] = React.useState<MarketplaceEntry | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [nativeSkipped, setNativeSkipped] = React.useState<Set<string>>(new Set());
  const [nativeBusyId, setNativeBusyId] = React.useState<string>();
  const selectedSnapshot = React.useRef<ExtensionMcpDefinition | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [tab, setTab] = React.useState<"installed" | "explore" | "matrix">("installed");
  const [quickFilter, setQuickFilter] = React.useState<"all" | "http" | "stdio" | "issues">("all");
  const [showImport, setShowImport] = React.useState(false);
  const [childBusy, setChildBusy] = React.useState(false);
  const [matrixBusy, setMatrixBusy] = React.useState(false);
  const busy = childBusy || matrixBusy || probe.checking || resyncAll.isPending || applyNative.isPending;
  const overlayOpen = !!installEntry || !!selectedId || editingId !== null || showImport;
  const catalog = React.useMemo(() => getMcpMarketplaceCatalog(MCP_MARKETPLACE), []);
  const allServers = React.useMemo(() => Object.values(management.data?.definitions ?? {}).map(definitionToCard), [management.data?.definitions]);
  const filteredInstalledServers = allServers.filter(server => {
    if (!installedServerMatchesQuery(server, findCatalogEntryForServer(server, catalog), searchQuery)) return false;
    if (quickFilter === "stdio" && server.type !== "stdio") return false;
    if (quickFilter === "http" && server.type === "stdio") return false;
    const rows = Object.values(management.data?.agentConfigurations[server.id] ?? {});
    return quickFilter !== "issues" || rows.some(row => !row.compatibility.supported || ["pending", "error", "unavailable"].includes(row.sync.state)) || probe.states[server.id] === "disconnected";
  });
  React.useEffect(() => { onInteractionBlockedChange?.(busy); return () => onInteractionBlockedChange?.(false); }, [busy, onInteractionBlockedChange]);
  const install = (entry: MarketplaceEntry) => { if (!busy && !overlayOpen && management.data) setInstallEntry(entry); };
  const openImport = () => { if (!busy && !overlayOpen && context.kind !== "project" && context.apps.length) setShowImport(true); };
  const nativeEntries = nativePreview.data?.entries ?? [];
  const visibleNativeEntries = nativeEntries.filter(entry => !nativeSkipped.has(entry.entryId));
  React.useEffect(() => {
    previewStarted.current = false;
    setNativeSkipped(new Set());
    nativePreview.reset();
  }, [context.id, nativePreview.reset]);
  React.useEffect(() => {
    if (previewStarted.current || !management.data || context.kind === "project" || !context.apps.length) return;
    previewStarted.current = true;
    nativePreview.mutate();
  }, [management.data, context.id, context.kind, context.apps.length, nativePreview.mutate]);
  const resyncAllApps = async () => {
    if (busy || overlayOpen || !management.data) return;
    try {
      const outcomes = await resyncAll.mutateAsync(undefined);
      const failed = outcomes.filter(outcome => !outcome.ok);
      if (failed.length === 0) {
        toast.success(t("MCP_PM$RESYNC_ALL_OK", { count: outcomes.length }), { closeButton: true });
      } else {
        toast.warning(t("MCP_PM$RESYNC_ALL_PARTIAL", {
          count: failed.length,
          apps: failed.map(outcome => APP_DISPLAY_NAME[outcome.app] ?? outcome.app).join(", "),
        }), { closeButton: true });
      }
    } catch (error) {
      toast.error(t("MCP_PM$RESYNC_ALL_FAILED"), { description: error instanceof Error ? error.message : String(error) });
    }
  };
  const refreshNative = async () => {
    setNativeSkipped(new Set());
    previewStarted.current = false;
    nativePreview.reset();
    await management.refetch();
    await nativePreview.mutateAsync();
  };
  const importNativeEntry = async (entry: (typeof nativeEntries)[number]) => {
    if (busy || overlayOpen || applyNative.isPending || !nativePreview.data || entry.classification === "conflict") return;
    setNativeBusyId(entry.entryId);
    try {
      const result = await applyNative.mutateAsync({
        previewId: nativePreview.data.previewId,
        selections: nativeEntries.map(item => ({
          entryId: item.entryId,
          resolution: item.entryId === entry.entryId ? "import" : "skip",
        })),
      });
      toast.success(t("MCP_PM$NATIVE_IMPORTED", { count: result.applied }), { closeButton: true });
      await refreshNative();
    } catch (error) {
      toast.error(t("MCP_PM$NATIVE_IMPORT_FAILED"), { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setNativeBusyId(undefined);
    }
  };
  const skipNativeEntry = (entry: (typeof nativeEntries)[number]) => {
    setNativeSkipped(previous => {
      const next = new Set(previous);
      next.add(entry.entryId);
      return next;
    });
  };
  const changeTab = (next: typeof tab) => {
    if (busy || overlayOpen || (tab !== next && hasUnsavedChanges() && !window.confirm(t("MCP_PM$DISCARD")))) return false;
    setTab(next);
    if (next === "explore" && quickFilter === "issues") setQuickFilter("all");
    return true;
  };
  if (selectedId && management.data?.definitions[selectedId]) selectedSnapshot.current = management.data.definitions[selectedId];
  const definition = selectedId ? management.data?.definitions[selectedId] ?? (selectedSnapshot.current?.id === selectedId ? selectedSnapshot.current : undefined) : undefined;
  const boundApps = management.data?.boundApps ?? [];
  const banner = boundApps.length ? t("MCP_PM$AGENT_BANNER", { agents: boundApps.map(app => APP_DISPLAY_NAME[app as ExtensionAppId] ?? app).join(", ") }) : "";

  return <main data-testid="mcp-page" className="oh-mcp-page">
    <header className="oh-mcp-page-header">
      <div>
        <h2>{t("MCP_PM$PAGE_TITLE")}</h2>
        <p>{t("MCP_PM$PAGE_DESCRIPTION")}</p>
        {banner ? <div className="oh-mcp-agent-banner"><AgentStack appIds={boundApps} size="sm" max={5} /><span>{banner}</span></div> : null}
      </div>
      <div className="oh-mcp-actions">
        <button type="button" disabled={busy || overlayOpen || !management.data} onClick={() => void resyncAllApps()} data-testid="mcp-resync-all"><RefreshCw aria-hidden />{resyncAll.isPending ? t("MCP_PM$RESYNCING") : t("MCP_PM$RESYNC_ALL")}</button>
        <button type="button" disabled={busy || overlayOpen || context.kind === "project" || !context.apps.length} onClick={openImport} data-testid="mcp-import-button"><Download aria-hidden />{t("MCP_PM$PREVIEW_IMPORT")}</button>
        <button type="button" className="oh-mcp-primary" disabled={busy || overlayOpen || !management.data} onClick={() => setEditingId("")} data-testid="mcp-add-custom-server"><Plus aria-hidden />{t("MCP_PM$ADD_MCP")}</button>
      </div>
    </header>
    <McpToolbar search={searchQuery} onSearchChange={setSearchQuery} quickFilter={quickFilter} onQuickFilterChange={setQuickFilter} showIssues={tab !== "explore"} />
    <div role="tablist" aria-label={t("MCP_PM$PAGE_TITLE")} className="oh-mcp-tabs">
      {(["installed", "explore", "matrix"] as const).map(item => <button key={item} type="button" role="tab" id={`mcp-tab-${item}`} aria-controls={tab === item && management.data ? `mcp-panel-${item}` : undefined} aria-selected={tab === item} tabIndex={tab === item ? 0 : -1} data-testid={`mcp-tab-${item}`} disabled={busy || overlayOpen} onClick={() => { changeTab(item); }} onKeyDown={event => {
        if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return;
        event.preventDefault();
        const tabs = ["installed", "explore", "matrix"] as const;
        const index = tabs.indexOf(item);
        const next = tabs[event.key === "Home" ? 0 : event.key === "End" ? 2 : (index + (event.key === "ArrowRight" ? 1 : 2)) % 3]!;
        if (changeTab(next)) document.getElementById(`mcp-tab-${next}`)?.focus();
      }}>{t(`MCP_PM$TAB_${item}`)}{item !== "matrix" && <span className="oh-mcp-count">{item === "installed" ? allServers.length : catalog.length}</span>}</button>)}
    </div>
    {management.isPending ? <p role="status" className="oh-mcp-muted">{t("HOME$LOADING")}</p> : management.isError ? <div role="alert" className="oh-mcp-error"><p>{management.error instanceof Error ? management.error.message : String(management.error)}</p><button type="button" disabled={management.isFetching} onClick={() => void management.refetch()}>{t("MCP_PM$RETRY_READ")}</button></div> : management.data && <div role="tabpanel" id={`mcp-panel-${tab}`} aria-labelledby={`mcp-tab-${tab}`} className="oh-mcp-tab-panel">
      {tab === "installed" && (nativePreview.isPending || visibleNativeEntries.length > 0 || nativePreview.isError || (context.apps.length === 1 && context.apps[0] === "omp")) && <section className="oh-mcp-native" data-testid="mcp-native-observations">
        <header className="oh-mcp-native-header">
          <div>
            <h3>{t("MCP_PM$NATIVE_TITLE")} ({visibleNativeEntries.length})</h3>
            <p>{t("MCP_PM$NATIVE_DESCRIPTION")}</p>
          </div>
          <button type="button" disabled={busy || overlayOpen || nativePreview.isPending} onClick={() => void refreshNative()}>{t("MCP_PM$NATIVE_REFRESH")}</button>
        </header>
        {nativePreview.isPending ? <p role="status" className="oh-mcp-muted">{t("MCP_PM$NATIVE_LOADING")}</p> : null}
        {nativePreview.isError ? <p role="alert" className="oh-mcp-error">{t("MCP_PM$NATIVE_FAILED")} {nativePreview.error instanceof Error ? nativePreview.error.message : String(nativePreview.error)}</p> : null}
        {!nativePreview.isPending && !nativePreview.isError && visibleNativeEntries.length === 0 ? <p className="oh-mcp-muted">{t(context.apps.length === 1 && context.apps[0] === "omp" ? "MCP_PM$NATIVE_OMP_NOTE" : "MCP_PM$NATIVE_EMPTY")}</p> : null}
        {visibleNativeEntries.length > 0 ? <ul className="oh-mcp-native-list">{visibleNativeEntries.map(entry => <li key={entry.entryId} className="oh-mcp-native-row" data-classification={entry.classification}>
          <div className="oh-mcp-native-copy">
            <strong>{entry.name || entry.serverId}</strong>
            <span>{t("MCP_PM$NATIVE_SOURCE")}: {APP_DISPLAY_NAME[entry.sourceApp as ExtensionAppId] ?? entry.sourceApp}</span>
          </div>
          <div className="oh-mcp-native-actions">
            {entry.classification === "conflict"
              ? <button type="button" disabled={busy} onClick={openImport}>{t("MCP_PM$NATIVE_REVIEW_CONFLICT")}</button>
              : <button type="button" className="oh-mcp-primary" disabled={busy || applyNative.isPending} onClick={() => void importNativeEntry(entry)}>{nativeBusyId === entry.entryId ? t("MCP_PM$NATIVE_IMPORTING") : t("MCP_PM$NATIVE_IMPORT_ENTRY")}</button>}
            <button type="button" disabled={busy || applyNative.isPending} onClick={() => skipNativeEntry(entry)}>{t("MCP_PM$NATIVE_SKIP_ENTRY")}</button>
          </div>
        </li>)}</ul> : null}
      </section>}
      {tab === "installed" && <InstalledServersSection servers={filteredInstalledServers} hasAnyInstalled={allServers.length > 0} query={searchQuery} management={management.data} probeStates={probe.states} disabled={busy || overlayOpen} onEdit={server => setSelectedId(server.id)} />}
      {tab === "explore" && <MarketplaceSection onSelect={install} onAdd={install} query={searchQuery} quickFilter={quickFilter === "issues" ? "all" : quickFilter} disabled={busy || overlayOpen} />}
      {tab === "matrix" && <McpAgentMatrix key={context.id} management={management.data} serverIds={filteredInstalledServers.map(server => server.id)} disabled={childBusy || probe.checking || overlayOpen} onOpen={setSelectedId} onInteractionBlockedChange={setMatrixBusy} />}
    </div>}
    {probe.errors.map((error, index) => <p role="alert" className="oh-mcp-error" key={`${index}:${error}`}>{t("MCP_PM$PROBE_ERROR", { error })}</p>)}
    {installEntry && <InstallServerModal entry={installEntry} existingServers={allServers} onClose={() => setInstallEntry(null)} onInteractionBlockedChange={setChildBusy} />}
    {editingId !== null && management.data && <CustomServerEditor key={editingId} definition={editingId === "" ? undefined : management.data.definitions[editingId]} management={management.data} onClose={() => setEditingId(null)} onInteractionBlockedChange={setChildBusy} />}
    {definition && management.data && <AgentConfigurationDrawer key={`${context.id}:${definition.id}`} definition={definition} definitionAvailable={!!management.data.definitions[definition.id]} management={management.data} probe={probe} onClose={() => setSelectedId(null)} onEditDefinition={() => { setSelectedId(null); setEditingId(definition.id); }} onInteractionBlockedChange={setChildBusy} />}
    {showImport && <McpImportPreviewDialog initialPreview={nativePreview.data} onApplied={() => { void refreshNative().catch(() => undefined); }} onClose={() => setShowImport(false)} onInteractionBlockedChange={setChildBusy} />}
  </main>;
}

export default OpenHandsMcpPage;
