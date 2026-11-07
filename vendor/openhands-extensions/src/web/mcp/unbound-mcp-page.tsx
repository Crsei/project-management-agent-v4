import { useId, useRef, useState } from "react";
import { INTEGRATION_CATALOG } from "@openhands/extensions/integrations";
import { McpLogoBadge } from "@pm/openhands-source/components/features/mcp-logo-badge";
import { McpToolbar } from "@pm/openhands-source/components/features/mcp-page/mcp-toolbar";
import { useOpenHandsTranslation } from "@pm/openhands-source/web/i18n";
import {
  getDefaultMcpTransport,
  getMarketplaceEntriesByPopularity,
  getMcpConnectionOptions,
  getMcpMarketplaceCatalog,
  marketplaceEntryMatchesQuery,
} from "@pm/openhands-source/utils/mcp-marketplace-utils";
import {
  extensionModuleCardGridClassName,
  extensionModuleCardGridContainerClassName,
  extensionModuleCardSurfaceClassName,
} from "@pm/openhands-source/utils/extension-module-card-classes";
import "@pm/openhands-source/web/mcp/management.css";

const tabs = ["installed", "explore", "matrix"] as const;
type Tab = (typeof tabs)[number];
type CatalogFilter = "all" | "http" | "stdio";
const catalog = getMarketplaceEntriesByPopularity(getMcpMarketplaceCatalog(INTEGRATION_CATALOG));

/** Read-only catalog when no supported Provider has been configured. */
export function UnboundMcpPage({ onBind }: { onBind: () => void }) {
  const { t } = useOpenHandsTranslation();
  const [tab, setTab] = useState<Tab>("explore");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<CatalogFilter>("all");
  const id = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const visibleEntries = catalog.filter(entry =>
    marketplaceEntryMatchesQuery(entry, search) &&
    (filter === "all" || getMcpConnectionOptions(entry).some(option =>
      filter === "stdio" ? option.transport.kind === "stdio" : option.transport.kind !== "stdio")),
  );

  return <main data-testid="mcp-page" className="oh-mcp-page oh-mcp-unbound">
    <header className="oh-mcp-page-header">
      <div><h2>{t("SETTINGS$MCP_TITLE")}</h2><p>{t("MCP_PM$UNBOUND_DESCRIPTION")}</p></div>
      <div className="oh-mcp-actions">
        <button type="button" data-testid="mcp-import-button" onClick={onBind}>{t("MCP_PM$UNBOUND_IMPORT")}</button>
        <button type="button" className="oh-mcp-primary" data-testid="mcp-add-custom-server" onClick={onBind}>{t("MCP_PM$UNBOUND_CUSTOM")}</button>
      </div>
    </header>
    <McpToolbar search={search} onSearchChange={setSearch} quickFilter={filter} onQuickFilterChange={next => { if (next !== "issues") setFilter(next); }} showIssues={false} />
    <div role="tablist" aria-label={t("SETTINGS$MCP_TITLE")} className="oh-mcp-tabs">
      {tabs.map((item, index) => <button key={item} ref={element => { tabRefs.current[index] = element; }} type="button" role="tab" id={`${id}-tab-${item}`} aria-controls={`${id}-panel-${item}`} aria-selected={tab === item} tabIndex={tab === item ? 0 : -1} data-testid={`mcp-tab-${item}`} onClick={() => setTab(item)} onKeyDown={event => {
        if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return;
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
        setTab(tabs[next]!);
        tabRefs.current[next]?.focus();
      }}>{t(`MCP_PM$TAB_${item}`)}{item === "explore" && <span className="oh-mcp-count">{catalog.length}</span>}</button>)}
    </div>
    {tabs.map(item => <div key={item} role="tabpanel" id={`${id}-panel-${item}`} aria-labelledby={`${id}-tab-${item}`} hidden={tab !== item}>
      {tab === item && (item === "explore" ? <section data-testid="mcp-marketplace-section" className="oh-mcp-unbound-catalog">
        <div className="oh-mcp-section-heading"><div><h3>{t("MCP$LIBRARY_TITLE")} <span className="oh-mcp-count">{visibleEntries.length}</span></h3><p className="oh-mcp-section-description">{t("MCP_PM$UNBOUND_CATALOG")}</p></div></div>
        {visibleEntries.length === 0 ? <div data-testid="mcp-marketplace-empty" className="oh-mcp-unbound-empty">{t("MCP$SEARCH_EMPTY")}</div> : <div className={extensionModuleCardGridContainerClassName}><div data-testid="mcp-marketplace-grid" className={extensionModuleCardGridClassName}>
          {visibleEntries.map(entry => {
            const transport = getDefaultMcpTransport(entry)?.kind;
            const transportLabel = transport === "shttp" ? "HTTP" : transport === "sse" ? "SSE" : transport === "stdio" ? "STDIO" : "";
            return <article key={entry.id} data-testid={`mcp-marketplace-card-${entry.id}`} className={`oh-mcp-marketplace-card oh-mcp-unbound-card ${extensionModuleCardSurfaceClassName}`}>
              <McpLogoBadge entry={entry} />
              <div className="oh-mcp-unbound-card-content"><div className="oh-mcp-unbound-card-heading"><div><h3>{entry.name}</h3><span className="oh-mcp-muted">{transportLabel}</span></div><button type="button" onClick={onBind} aria-label={t("MCP_PM$UNBOUND_ADD_NAMED", { name: entry.name })}>{t("MCP_PM$UNBOUND_ADD")}</button></div><p>{entry.description}</p></div>
            </article>;
          })}
        </div></div>}
      </section> : <section className="oh-mcp-unbound-state" data-testid="mcp-unbound-state"><h3>{t("MCP_PM$UNBOUND_TITLE")}</h3><p>{t("MCP_PM$UNBOUND_STATE")}</p><div className="oh-mcp-actions"><button type="button" className="oh-mcp-primary" onClick={onBind}>{t("MCP_PM$UNBOUND_BIND")}</button></div></section>)}
    </div>)}
  </main>;
}
