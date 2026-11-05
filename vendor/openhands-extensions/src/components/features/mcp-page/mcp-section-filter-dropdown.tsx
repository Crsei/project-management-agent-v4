import { useOpenHandsTranslation } from "@pm/openhands-source/web/i18n";
import { MCP_SECTION_FILTER_OPTIONS, type McpSectionFilter } from "./mcp-section-filter";

const FILTER_LABEL_KEY: Record<McpSectionFilter, string> = {
  all: "MCP$SECTION_FILTER_ALL", installed: "MCP$INSTALLED_TITLE", library: "MCP$LIBRARY_TITLE",
};

export function McpSectionFilterDropdown({ value, onChange }: { value: McpSectionFilter; onChange: (filter: McpSectionFilter) => void }) {
  const { t } = useOpenHandsTranslation();
  return <select data-testid="mcp-section-filter" value={value} onChange={event => onChange(event.target.value as McpSectionFilter)} aria-label={t("MCP$SECTION_FILTER_LABEL")} className="oh-mcp-section-filter">{MCP_SECTION_FILTER_OPTIONS.map(option => <option key={option} value={option}>{t(FILTER_LABEL_KEY[option])}</option>)}</select>;
}
