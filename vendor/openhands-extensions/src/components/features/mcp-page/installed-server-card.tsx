import React from "react";
import { Puzzle, Settings2 } from "lucide-react";
import { INTEGRATION_CATALOG as MCP_MARKETPLACE } from "@openhands/extensions/integrations";
import type { ExtensionMcpAgentConfiguration, ExtensionAppId } from "@agent-workspace/contracts/extensions";
import { APP_DISPLAY_NAME } from "@pm/cc-switch-source/components/shell/AppGlyph";
import { useOpenHandsTranslation } from "@pm/openhands-source/web/i18n";
import { McpLogoBadge } from "@pm/openhands-source/components/features/mcp-logo-badge";
import type { MCPServerConfig } from "@pm/openhands-source/types/mcp-server";
import { findCatalogEntryForServer, getMcpMarketplaceCatalog } from "@pm/openhands-source/utils/mcp-marketplace-utils";
import { getInstalledServerTitle } from "@pm/openhands-source/utils/mcp-installed-server-display";
import { cn } from "@pm/openhands-source/utils/utils";
import { extensionModuleCardInteractiveClassName, extensionModuleCardSurfaceClassName } from "@pm/openhands-source/utils/extension-module-card-classes";

interface InstalledServerCardProps {
  server: MCPServerConfig;
  configurations: Partial<Record<ExtensionAppId, ExtensionMcpAgentConfiguration>>;
  probeState?: string;
  disabled?: boolean;
  onEdit: () => void;
}

export function InstalledServerCard({ server, configurations, probeState, disabled, onEdit }: InstalledServerCardProps) {
  const { t } = useOpenHandsTranslation();
  const catalog = findCatalogEntryForServer(server, getMcpMarketplaceCatalog(MCP_MARKETPLACE));
  const title = getInstalledServerTitle(server, catalog);
  const rows = Object.values(configurations);
  const enabled = rows.filter(row => row.enabled);
  const abnormal = rows.filter(row => !row.compatibility.supported || row.sync.state === "pending" || row.sync.state === "error" || row.sync.state === "unavailable");
  const assignedNames = enabled.map(row => APP_DISPLAY_NAME[row.app]);
  const synced = enabled.filter(row => row.sync.state === "synced").length;
  const overrides = rows.filter(row => row.override !== null).length;
  const configureLabel = t("MCP_PM$CONFIGURE", { name: title });
  const open = () => { if (!disabled) onEdit(); };
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
  };
  return <div data-testid="mcp-server-item" data-server-id={server.id} role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled} onClick={open} onKeyDown={handleKeyDown} aria-label={configureLabel} className={cn("oh-mcp-installed-row", extensionModuleCardSurfaceClassName, extensionModuleCardInteractiveClassName)}>
    <McpLogoBadge entry={catalog} fallback={<Puzzle strokeWidth={2.25} />} />
    <div className="oh-mcp-installed-title">
      <strong title={title}>{title}</strong>
      <span className="oh-mcp-muted">{server.id} · {server.type === "shttp" ? "HTTP" : server.type.toUpperCase()}</span>
      <span className="oh-mcp-agent-summary" title={assignedNames.join(", ")}>{assignedNames.length ? <>{assignedNames.slice(0, 3).join(", ")}{assignedNames.length > 3 ? ` +${assignedNames.length - 3}` : ""}</> : t("MCP_PM$UNASSIGNED")}</span>
    </div>
    <div className="oh-mcp-row-states">
      <span className="oh-mcp-badge">{enabled.length ? t("MCP_PM$AGENTS_ASSIGNED", { count: enabled.length }) : t("MCP_PM$UNASSIGNED")}</span>
      {enabled.length > 0 && <span>{t("MCP_PM$SYNC_SUMMARY", { synced, assigned: enabled.length })}{overrides > 0 ? ` · ${t("MCP_PM$OVERRIDE_COUNT", { count: overrides })}` : ""}</span>}
      {abnormal.length > 0 && <span className="oh-mcp-warning">{t("MCP_PM$ATTENTION_COUNT", { count: abnormal.length })}</span>}
      <small>{t("MCP_PM$PROBE_LABEL", { state: t(`MCP_PM$PROBE_${probeState ?? "unavailable"}`) })}</small>
    </div>
    <button type="button" disabled={disabled} className="oh-mcp-icon-button" aria-label={configureLabel} onClick={event => { event.stopPropagation(); open(); }}><Settings2 size={18} /></button>
  </div>;
}
