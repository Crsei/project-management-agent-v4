import { useState } from "react";
import { useOpenHandsTranslation } from "@pm/openhands-source/web/i18n";
import {
  INTEGRATION_CATALOG as MCP_MARKETPLACE,
  type IntegrationCatalogEntry as MarketplaceEntry,
} from "@openhands/extensions/integrations";
import {
  getMcpConnectionOptions,
  getMarketplaceEntriesByPopularity,
  getMcpMarketplaceCatalog,
  marketplaceEntryMatchesQuery,
} from "@pm/openhands-source/utils/mcp-marketplace-utils";
import { MarketplaceCard } from "./marketplace-card";
import {
  extensionModuleCardGridClassName,
  extensionModuleCardGridContainerClassName,
} from "@pm/openhands-source/utils/extension-module-card-classes";

interface MarketplaceSectionProps {
  onSelect: (entry: MarketplaceEntry) => void;
  onAdd: (entry: MarketplaceEntry) => void;
  /** Empty string = no filter. */
  query?: string;
  disabled?: boolean;
}

export function MarketplaceSection({
  onSelect,
  onAdd,
  query = "",
  disabled = false,
}: MarketplaceSectionProps) {
  const { t } = useOpenHandsTranslation();
  const [transportFilter, setTransportFilter] = useState<"all" | "stdio" | "shttp" | "sse">("all");

  const visibleEntries = getMarketplaceEntriesByPopularity(
    getMcpMarketplaceCatalog(MCP_MARKETPLACE),
  ).filter(entry => marketplaceEntryMatchesQuery(entry, query) && (transportFilter === "all" || getMcpConnectionOptions(entry).some(option => option.transport.kind === transportFilter)));

  return (
    <section
      data-testid="mcp-marketplace-section"
      className="flex flex-col gap-3"
    >
      <div className="oh-mcp-section-heading">
        <div><h3>{t("MCP$LIBRARY_TITLE")} <span className="oh-mcp-count">{visibleEntries.length}</span></h3><p className="oh-mcp-section-description">{t("MCP_PM$DISCOVER_HELP")}</p></div>
        <label className="oh-mcp-catalog-filter">{t("SETTINGS$MCP_SERVER_TYPE")}<select value={transportFilter} onChange={event => setTransportFilter(event.target.value as typeof transportFilter)} data-testid="mcp-marketplace-transport-filter"><option value="all">{t("MCP$SECTION_FILTER_ALL")}</option><option value="stdio">STDIO</option><option value="shttp">HTTP</option><option value="sse">SSE</option></select></label>
      </div>

      {visibleEntries.length === 0 ? (
        <div
          data-testid="mcp-marketplace-empty"
          className="rounded-xl border border-dashed border-border p-6 text-center"
        >
          <p className="text-xs text-tertiary-light">
            {t("MCP$SEARCH_EMPTY")}
          </p>
        </div>
      ) : (
        <div className={extensionModuleCardGridContainerClassName}>
          <div
            data-testid="mcp-marketplace-grid"
            className={extensionModuleCardGridClassName}
          >
            {visibleEntries.map((entry) => (
              <MarketplaceCard
                key={entry.id}
                entry={entry}
                disabled={disabled}
                onClick={() => onSelect(entry)}
                onAdd={() => onAdd(entry)}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
