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
  quickFilter?: "all" | "http" | "stdio";
}

export function MarketplaceSection({
  onSelect,
  onAdd,
  query = "",
  disabled = false,
  quickFilter = "all",
}: MarketplaceSectionProps) {
  const { t } = useOpenHandsTranslation();
  const visibleEntries = getMarketplaceEntriesByPopularity(
    getMcpMarketplaceCatalog(MCP_MARKETPLACE),
  ).filter(entry => {
    if (!marketplaceEntryMatchesQuery(entry, query)) return false;
    if (quickFilter === "all") return true;
    return getMcpConnectionOptions(entry).some(option =>
      quickFilter === "stdio" ? option.transport.kind === "stdio" : option.transport.kind !== "stdio");
  });

  return <section data-testid="mcp-marketplace-section" className="flex flex-col gap-3">
    <h2 className="oh-mcp-section-title">{t("MCP_PM$EXPLORE_TITLE")}</h2>
    {visibleEntries.length === 0
      ? <div data-testid="mcp-marketplace-empty" className="oh-mcp-empty-search"><p>{t("MCP$SEARCH_EMPTY")}</p></div>
      : <div className={extensionModuleCardGridContainerClassName}><div data-testid="mcp-marketplace-grid" className={extensionModuleCardGridClassName}>
        {visibleEntries.map(entry => <MarketplaceCard key={entry.id} entry={entry} disabled={disabled} onClick={() => onSelect(entry)} onAdd={() => onAdd(entry)} />)}
      </div></div>}
  </section>;
}
