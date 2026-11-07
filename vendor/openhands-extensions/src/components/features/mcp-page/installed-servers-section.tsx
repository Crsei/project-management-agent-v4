import type { ExtensionMcpManagement } from "@agent-workspace/contracts/extensions";
import { useOpenHandsTranslation } from "@pm/openhands-source/web/i18n";
import type { MCPServerConfig } from "@pm/openhands-source/types/mcp-server";
import { extensionModuleEmptyStateClassName } from "@pm/openhands-source/utils/extension-module-card-classes";
import { InstalledServerCard } from "./installed-server-card";

interface InstalledServersSectionProps {
  servers: MCPServerConfig[];
  hasAnyInstalled: boolean;
  query?: string;
  management: ExtensionMcpManagement;
  probeStates: Record<string, string>;
  disabled?: boolean;
  onEdit: (server: MCPServerConfig) => void;
}

export function InstalledServersSection({ servers, hasAnyInstalled, query = "", management, probeStates, disabled, onEdit }: InstalledServersSectionProps) {
  const { t } = useOpenHandsTranslation();
  if (!servers.length) return <div data-testid={hasAnyInstalled && query.trim() ? "mcp-installed-empty-search" : "mcp-installed-empty"} className={extensionModuleEmptyStateClassName}>
    <p>{t(hasAnyInstalled ? "MCP$SEARCH_EMPTY" : "MCP$INSTALLED_EMPTY_TITLE")}</p>
    {!hasAnyInstalled && <p className="oh-mcp-muted">{t("MCP$INSTALLED_EMPTY_HINT")}</p>}
  </div>;
  return <div data-testid="mcp-installed-list" className="oh-mcp-installed-list">{servers.map(server => <InstalledServerCard key={server.id} server={server} configurations={management.agentConfigurations[server.id] ?? {}} probeState={probeStates[server.id]} disabled={disabled} onEdit={() => onEdit(server)} />)}</div>;
}
