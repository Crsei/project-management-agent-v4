import React from "react";
import { INTEGRATION_CATALOG as MCP_MARKETPLACE, type IntegrationCatalogEntry as MarketplaceEntry } from "@openhands/extensions/integrations";
import { useMcpManagement } from "@pm/cc-switch-source/hooks/useMcp";
import { useMcpConnectivity } from "@pm/cc-switch-source/hooks/useMcpConnectivity";
import UnifiedMcpPanel from "@pm/cc-switch-source/components/mcp/UnifiedMcpPanel";
import { MCP_APP_IDS } from "@pm/cc-switch-source/config/appConfig";
import { APP_DISPLAY_NAME } from "@pm/cc-switch-source/components/shell/AppGlyph";
import { hasUnsavedChanges } from "@pm/cc-switch-source/lib/unsavedChanges";
import type { ExtensionAppId, ExtensionMcpDefinition } from "@agent-workspace/contracts/extensions";
import { useOpenHandsTranslation } from "@pm/openhands-source/web/i18n";
import { webPlatform } from "@pm/openhands-source/web/bridge";
import { findCatalogEntryForServer, getMcpMarketplaceCatalog, installedServerMatchesQuery } from "@pm/openhands-source/utils/mcp-marketplace-utils";
import { InstalledServersSection, McpToolbar, MarketplaceSection, InstallServerModal, CustomServerEditor, type McpSectionFilter } from "@pm/openhands-source/components/features/mcp-page";
import { definitionToCard, managementToSourceServers } from "@pm/openhands-source/web/mcp/definition-adapter";
import { AgentConfigurationDrawer } from "@pm/openhands-source/web/mcp/agent-configuration-drawer";
import { McpImportPreviewDialog } from "@pm/openhands-source/web/mcp/import-preview-dialog";
import "@pm/openhands-source/web/mcp/management.css";

/** The copied OpenHands Marketplace/installed presentation, backed only by the
 * authorized CC Switch library, assignment and source lifecycle operations. */
export function OpenHandsMcpPage({ onInteractionBlockedChange }: { onInteractionBlockedChange?: (blocked: boolean) => void }) {
  const { t } = useOpenHandsTranslation();
  const management = useMcpManagement();
  const context = webPlatform().context;
  const sourceServers = React.useMemo(() => management.data ? managementToSourceServers(management.data) : undefined, [management.data]);
  const probe = useMcpConnectivity(sourceServers);
  const [installEntry, setInstallEntry] = React.useState<MarketplaceEntry | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const selectedSnapshot = React.useRef<ExtensionMcpDefinition | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [sectionFilter, setSectionFilter] = React.useState<McpSectionFilter>("all");
  const [agentFilter, setAgentFilter] = React.useState<ExtensionAppId | "all">("all");
  const [abnormalOnly, setAbnormalOnly] = React.useState(false);
  const [showImport, setShowImport] = React.useState(false);
  const [advanced, setAdvanced] = React.useState(false);
  const [childBusy, setChildBusy] = React.useState(false);
  const busy = childBusy || probe.checking;
  const overlayOpen = !!installEntry || !!selectedId || editingId !== null || showImport;
  const catalog = React.useMemo(() => getMcpMarketplaceCatalog(MCP_MARKETPLACE), []);
  const allServers = React.useMemo(() => Object.values(management.data?.definitions ?? {}).map(definitionToCard), [management.data?.definitions]);
  const filteredInstalledServers = allServers.filter(server => {
    if (!installedServerMatchesQuery(server, findCatalogEntryForServer(server, catalog), searchQuery)) return false;
    const rows = management.data?.agentConfigurations[server.id] ?? {};
    if (agentFilter !== "all" && !rows[agentFilter]?.enabled) return false;
    return !abnormalOnly || Object.values(rows).some(row => !row.compatibility.supported || ["pending", "error", "unavailable"].includes(row.sync.state)) || probe.states[server.id] === "disconnected";
  });
  React.useEffect(() => { onInteractionBlockedChange?.(busy); return () => onInteractionBlockedChange?.(false); }, [busy, onInteractionBlockedChange]);
  const install = (entry: MarketplaceEntry) => { if (!busy && !overlayOpen && management.data) setInstallEntry(entry); };
  const openImport = () => { if (!busy && !overlayOpen && context.kind !== "project" && context.apps.length) setShowImport(true); };
  if (selectedId && management.data?.definitions[selectedId]) selectedSnapshot.current = management.data.definitions[selectedId];
  const definition = selectedId ? management.data?.definitions[selectedId] ?? (selectedSnapshot.current?.id === selectedId ? selectedSnapshot.current : undefined) : undefined;
  const studioUrl = context.scope ? `/agent/automations/integrations?workspace=${encodeURIComponent(context.scope.workspaceId)}&project=${encodeURIComponent(context.scope.projectId)}` : undefined;

  return <main data-testid="mcp-page" className="oh-mcp-page">
    <header className="oh-mcp-page-header">
      <div><h2>{t("SETTINGS$MCP_TITLE")}</h2><p>{t("MCP_PM$PAGE_DESCRIPTION")}</p></div>
      <div className="oh-mcp-actions">
        {!advanced && <button type="button" className="oh-mcp-primary" disabled={busy || overlayOpen || !management.data} onClick={() => setEditingId("")} data-testid="mcp-add-custom-server">{t("MCP$ADD_CUSTOM")}</button>}
        {!advanced && <button type="button" disabled={busy || overlayOpen || context.kind === "project" || !context.apps.length} title={t(context.kind === "project" ? "MCP_PM$IMPORT_PROJECT_DENIED" : !context.apps.length ? "MCP_PM$BIND_FIRST" : "MCP_PM$IMPORT_READ_ONLY")} onClick={openImport}>{t("MCP_PM$PREVIEW_IMPORT")}</button>}
        <button type="button" disabled={busy || overlayOpen} onClick={() => { if (!hasUnsavedChanges() || window.confirm(t("MCP_PM$DISCARD"))) setAdvanced(value => !value); }} aria-pressed={advanced}>{t(advanced ? "MCP_PM$MARKETPLACE_VIEW" : "MCP_PM$MATRIX_VIEW")}</button>
      </div>
    </header>
    {context.kind === "project" && <aside className="oh-mcp-context-note"><p>{t("MCP_PM$PROJECT_NOTE")}</p>{studioUrl && <a href={studioUrl}>{t("MCP_PM$STUDIO_LINK")}</a>}</aside>}
    {!advanced ? <>
      <McpToolbar search={searchQuery} onSearchChange={setSearchQuery} sectionFilter={sectionFilter} onSectionFilterChange={setSectionFilter} />
      {management.isPending ? <p role="status">{t("HOME$LOADING")}</p> : management.isError ? <div role="alert" className="oh-mcp-error"><p>{management.error instanceof Error ? management.error.message : String(management.error)}</p><button type="button" disabled={management.isFetching} onClick={() => void management.refetch()}>{t("MCP_PM$RETRY_READ")}</button></div> : management.data && <>
        {sectionFilter !== "library" && <section className="oh-mcp-installed-section" aria-labelledby="mcp-installed-heading">
          <div className="oh-mcp-section-heading">
            <div><h3 id="mcp-installed-heading">{t("MCP$INSTALLED_TITLE")} <span className="oh-mcp-count">{filteredInstalledServers.length}{filteredInstalledServers.length !== allServers.length ? ` / ${allServers.length}` : ""}</span></h3><p className="oh-mcp-section-description">{t("MCP_PM$INSTALLED_HELP")}</p></div>
            <button type="button" className="oh-mcp-refresh" disabled={busy || management.isFetching} onClick={() => void management.refetch()}>{t("MCP_PM$REFRESH")}</button>
          </div>
          <div className="oh-mcp-installed-filters"><select aria-label={t("MCP_PM$FILTER_AGENT")} value={agentFilter} onChange={event => setAgentFilter(event.target.value as ExtensionAppId | "all")}><option value="all">{t("MCP_PM$ALL_AGENTS")}</option>{MCP_APP_IDS.map(app => <option key={app} value={app}>{APP_DISPLAY_NAME[app]}</option>)}</select><label className="oh-mcp-checkbox"><input type="checkbox" checked={abnormalOnly} onChange={event => setAbnormalOnly(event.target.checked)} />{t("MCP_PM$ATTENTION")}</label></div>
          <InstalledServersSection servers={filteredInstalledServers} hasAnyInstalled={allServers.length > 0} query={searchQuery || (agentFilter !== "all" || abnormalOnly ? "filtered" : "")} management={management.data} probeStates={probe.states} disabled={busy || overlayOpen} onEdit={server => setSelectedId(server.id)} />
        </section>}
        {sectionFilter !== "installed" && <MarketplaceSection onSelect={install} onAdd={install} query={searchQuery} disabled={busy || overlayOpen} />}
      </>}
    </> : <div className="oh-mcp-advanced"><UnifiedMcpPanel onInteractionBlockedChange={setChildBusy} onImport={openImport} /></div>}
    {probe.errors.map((error, index) => <p role="alert" className="oh-mcp-error" key={`${index}:${error}`}>{t("MCP_PM$PROBE_ERROR", { error })}</p>)}
    {installEntry && <InstallServerModal entry={installEntry} existingServers={allServers} onClose={() => setInstallEntry(null)} onInteractionBlockedChange={setChildBusy} />}
    {editingId !== null && management.data && <CustomServerEditor key={editingId} definition={editingId === "" ? undefined : management.data.definitions[editingId]} management={management.data} onClose={() => setEditingId(null)} onInteractionBlockedChange={setChildBusy} />}
    {definition && management.data && <AgentConfigurationDrawer key={definition.id} definition={definition} definitionAvailable={!!management.data.definitions[definition.id]} management={management.data} probe={probe} onClose={() => setSelectedId(null)} onEditDefinition={() => { setSelectedId(null); setEditingId(definition.id); }} onInteractionBlockedChange={setChildBusy} />}
    {showImport && <McpImportPreviewDialog onClose={() => setShowImport(false)} onInteractionBlockedChange={setChildBusy} />}
  </main>;
}

export default OpenHandsMcpPage;
