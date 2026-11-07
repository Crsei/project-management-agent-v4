import { Search, SlidersHorizontal, X } from "lucide-react";
import { useOpenHandsTranslation } from "@pm/openhands-source/web/i18n";
import { EnumFilterDropdown } from "@pm/openhands-source/web/shared/enum-filter-dropdown";

type McpQuickFilter = "all" | "http" | "stdio" | "issues";

/** Search plus the source presentation's enum filter dropdown. */
export function McpToolbar({
  search,
  onSearchChange,
  quickFilter,
  onQuickFilterChange,
  showIssues = true,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  quickFilter: McpQuickFilter;
  onQuickFilterChange: (filter: McpQuickFilter) => void;
  showIssues?: boolean;
}) {
  const { t } = useOpenHandsTranslation();
  const options: McpQuickFilter[] = showIssues ? ["all", "http", "stdio", "issues"] : ["all", "http", "stdio"];
  const labels: Record<string, string> = {
    all: t("MCP$SECTION_FILTER_ALL"),
    http: "HTTP",
    stdio: "STDIO",
    issues: t("MCP_PM$ATTENTION"),
  };
  return <div data-testid="mcp-toolbar" className="oh-mcp-toolbar">
    <div data-testid="mcp-search" className="oh-mcp-search">
      <Search aria-hidden />
      <input
        type="search"
        value={search}
        onChange={event => onSearchChange(event.target.value)}
        placeholder={t("MCP$SEARCH_PLACEHOLDER")}
        aria-label={t("MCP$SEARCH_PLACEHOLDER")}
        data-testid="mcp-search-input"
      />
      {search ? <button type="button" onClick={() => onSearchChange("")} aria-label={t("MCP$SEARCH_CLEAR")} data-testid="mcp-search-clear">
        <X aria-hidden />
      </button> : null}
    </div>
    <EnumFilterDropdown
      testId="mcp-filter"
      value={quickFilter}
      onChange={onQuickFilterChange}
      options={options}
      labelByValue={labels}
      ariaLabel={t("MCP$SECTION_FILTER_LABEL")}
      startContent={<SlidersHorizontal aria-hidden />}
    />
  </div>;
}
