import React from "react";
import { ChevronRight, Puzzle } from "lucide-react";
import { INTEGRATION_CATALOG as MCP_MARKETPLACE } from "@openhands/extensions/integrations";
import type { ExtensionMcpAgentConfiguration, ExtensionAppId } from "@agent-workspace/contracts/extensions";
import { APP_DISPLAY_NAME } from "@pm/cc-switch-ui";
import { useOpenHandsTranslation } from "@pm/openhands-source/web/i18n";
import { McpLogoBadge } from "@pm/openhands-source/components/features/mcp-logo-badge";
import type { MCPServerConfig } from "@pm/openhands-source/types/mcp-server";
import { findCatalogEntryForServer, getMcpMarketplaceCatalog } from "@pm/openhands-source/utils/mcp-marketplace-utils";
import { getInstalledServerTitle } from "@pm/openhands-source/utils/mcp-installed-server-display";
import { extensionModuleCardInteractiveClassName, extensionModuleCardSurfaceClassName } from "@pm/openhands-source/utils/extension-module-card-classes";
import { AgentStack } from "@pm/openhands-source/web/shared/agent-avatar";
import { StatusPill, type StatusTone } from "@pm/openhands-source/web/shared/status-pill";

interface InstalledServerCardProps {
  server: MCPServerConfig;
  configurations: Partial<Record<ExtensionAppId, ExtensionMcpAgentConfiguration>>;
  probeState?: string;
  disabled?: boolean;
  onEdit: () => void;
}

function syncState(rows: ExtensionMcpAgentConfiguration[]): { synced: number; total: number; tone: StatusTone } {
  if (rows.length === 0) return { synced: 0, total: 0, tone: "neutral" };
  const synced = rows.filter(row => row.sync.state === "synced").length;
  const failed = rows.some(row => row.sync.state === "error");
  const pending = rows.some(row => row.sync.state === "pending" || row.sync.state === "unavailable");
  return { synced, total: rows.length, tone: failed ? "error" : pending ? "warning" : "success" };
}

function connectionTone(state?: string): StatusTone {
  switch (state) {
    case "connected": return "success";
    case "disconnected": return "error";
    default: return "neutral";
  }
}

export function InstalledServerCard({ server, configurations, probeState, disabled, onEdit }: InstalledServerCardProps) {
  const { t } = useOpenHandsTranslation();
  const catalog = findCatalogEntryForServer(server, getMcpMarketplaceCatalog(MCP_MARKETPLACE));
  const title = getInstalledServerTitle(server, catalog);
  const rows = Object.values(configurations).filter((row): row is ExtensionMcpAgentConfiguration => !!row);
  const enabled = rows.filter(row => row.enabled);
  const assignedApps = enabled.map(row => row.app);
  const sync = syncState(enabled);
  const syncLabel = sync.total === 0 ? t("MCP_PM$NO_AGENTS") : t("MCP_PM$SYNC_SUMMARY_SHORT", { synced: sync.synced, total: sync.total });
  const connectionLabel = t(`MCP_PM$PROBE_${probeState ?? "unchecked"}`);
  const assignedLabel = assignedApps.length === 0 ? t("MCP_PM$NO_AGENTS") : assignedApps.length === 1 ? t("MCP_PM$AGENT_ONE") : t("MCP_PM$AGENT_COUNT", { count: assignedApps.length });
  const description = catalog?.description ?? server.url ?? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ") ?? server.id;
  const transport = server.type === "shttp" ? "HTTP" : server.type.toUpperCase();
  const open = () => { if (!disabled) onEdit(); };
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
  };
  return <div data-testid="mcp-server-item" data-server-id={server.id} role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled} onClick={open} onKeyDown={handleKeyDown} aria-label={t("MCP$MANAGE_SERVER_ARIA", { name: title })} className={`oh-mcp-installed-row ${extensionModuleCardSurfaceClassName} ${extensionModuleCardInteractiveClassName}`}>
    <McpLogoBadge entry={catalog} fallback={<Puzzle strokeWidth={2.25} />} />
    <div className="oh-mcp-installed-copy">
      <div className="oh-mcp-installed-heading">
        <strong title={title}>{title}</strong>
        <span className="oh-mcp-transport">{transport}</span>
        <StatusPill tone={catalog ? "neutral" : "accent"}>{catalog ? t("MCP_PM$OFFICIAL") : t("MCP_PM$CUSTOM")}</StatusPill>
      </div>
      <p title={description}>{description}</p>
      <div className="oh-mcp-installed-states">
        <StatusPill tone={sync.tone} dot>{syncLabel}</StatusPill>
        <StatusPill tone={connectionTone(probeState)} dot>{connectionLabel}</StatusPill>
      </div>
    </div>
    <div className="oh-mcp-installed-agents">
      <AgentStack appIds={assignedApps} size="sm" max={4} />
      <span>{assignedLabel}</span>
      <span className="oh-mcp-agent-names" title={assignedApps.map(app => APP_DISPLAY_NAME[app]).join(", ")}>{assignedApps.map(app => APP_DISPLAY_NAME[app]).join(", ")}</span>
    </div>
    <ChevronRight aria-hidden className="oh-mcp-installed-chevron" />
  </div>;
}
