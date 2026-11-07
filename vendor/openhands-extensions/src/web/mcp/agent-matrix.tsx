import React from "react";
import { Puzzle } from "lucide-react";
import type { ExtensionAppId, ExtensionMcpManagement } from "@agent-workspace/contracts/extensions";
import { APP_DISPLAY_NAME, useSetMcpAgentConfiguration } from "@pm/cc-switch-ui";
import { INTEGRATION_CATALOG as MCP_MARKETPLACE } from "@openhands/extensions/integrations";
import { useOpenHandsTranslation } from "@pm/openhands-source/web/i18n";
import { McpLogoBadge } from "@pm/openhands-source/components/features/mcp-logo-badge";
import { findCatalogEntryForServer, getMcpMarketplaceCatalog } from "@pm/openhands-source/utils/mcp-marketplace-utils";
import { getInstalledServerTitle } from "@pm/openhands-source/utils/mcp-installed-server-display";
import { AgentMatrixTable, MatrixBulkBar, type AgentMatrixRow } from "@pm/openhands-source/web/shared/agent-matrix-table";
import { EnumFilterDropdown } from "@pm/openhands-source/web/shared/enum-filter-dropdown";
import { mcpReasonText } from "./management";

/** Adapted from the rebuilt McpAgentMatrix. Only authorized bound targets and
 * authoritative assignment rows can be changed. */
export function McpAgentMatrix({ management, serverIds, disabled, onOpen, onInteractionBlockedChange }: {
  management: ExtensionMcpManagement;
  serverIds: string[];
  disabled: boolean;
  onOpen: (serverId: string) => void;
  onInteractionBlockedChange: (busy: boolean) => void;
}) {
  const { t } = useOpenHandsTranslation();
  const mutation = useSetMcpAgentConfiguration();
  const [agentFilter, setAgentFilter] = React.useState<ExtensionAppId | "all">("all");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [running, setRunning] = React.useState(false);
  const [failures, setFailures] = React.useState<string[]>([]);
  const lock = React.useRef(false);
  const agents = management.boundApps;
  const rowFor = (id: string, app: ExtensionAppId) => management.agentConfigurations[id]?.[app];
  const visibleIds = serverIds.filter(id => agentFilter === "all" || rowFor(id, agentFilter)?.enabled);
  const selectedIds = visibleIds.filter(id => selected.has(id));
  const allSelected = visibleIds.length > 0 && selectedIds.length === visibleIds.length;
  const busy = disabled || running || mutation.isPending;
  React.useEffect(() => { onInteractionBlockedChange(running || mutation.isPending); return () => onInteractionBlockedChange(false); }, [running, mutation.isPending, onInteractionBlockedChange]);
  const visibleIdsKey = JSON.stringify(visibleIds);
  React.useEffect(() => { setSelected(new Set()); }, [visibleIdsKey]);
  const counts = Object.fromEntries(agents.map(app => [app, serverIds.filter(id => rowFor(id, app)?.enabled).length])) as Record<string, number>;
  const assignmentCount = Object.values(counts).reduce((total, count) => total + count, 0);

  const change = async (operations: Array<{ serverId: string; app: ExtensionAppId; enabled: boolean }>) => {
    if (lock.current || busy || operations.length === 0) return;
    lock.current = true;
    setRunning(true);
    setFailures([]);
    const errors: string[] = [];
    try {
      for (const operation of operations) {
        try { await mutation.mutateAsync(operation); }
        catch (error) { errors.push(`${operation.serverId} · ${APP_DISPLAY_NAME[operation.app]}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      setFailures(errors);
    } finally {
      lock.current = false;
      setRunning(false);
    }
  };
  const canAssign = (app: string) => selectedIds.length > 0 && selectedIds.every(id => !!rowFor(id, app as ExtensionAppId)?.compatibility.supported);
  const clearOperations = selectedIds.flatMap(serverId => agents.flatMap(app => rowFor(serverId, app)?.enabled ? [{ serverId, app, enabled: false }] : []));

  const rows: AgentMatrixRow[] = visibleIds.map(id => {
    const definition = management.definitions[id]!;
    const type = definition.server.type === "sse" ? "sse" : definition.server.type === "stdio" || typeof definition.server.command === "string" ? "stdio" : "shttp";
    const server = { id, name: definition.name, type, ...(typeof definition.server.command === "string" ? { command: definition.server.command } : {}), ...(typeof definition.server.url === "string" ? { url: definition.server.url } : {}) } as const;
    const catalog = findCatalogEntryForServer(server, getMcpMarketplaceCatalog(MCP_MARKETPLACE));
    const title = getInstalledServerTitle(server, catalog);
    const transport = type === "sse" ? "SSE" : type === "stdio" ? "STDIO" : "HTTP";
    const issue = agents.some(app => rowFor(id, app)?.sync.state === "error")
      ? t("MCP_PM$MATRIX_SYNC_ERROR")
      : agents.some(app => rowFor(id, app)?.sync.state === "pending") ? t("MCP_PM$MATRIX_SYNC_PENDING") : null;
    return {
      id,
      title,
      subtitle: [transport, definition.description ?? definition.id].filter(Boolean).join(" · "),
      icon: <McpLogoBadge entry={catalog} size="base" className="shrink-0" fallback={<Puzzle strokeWidth={2.25} />} />,
      issue,
      cells: Object.fromEntries(agents.map(app => {
        const row = rowFor(id, app);
        return [app, {
          supported: !!row?.compatibility.supported,
          enabled: !!row?.enabled,
          syncState: row?.sync.state,
          reason: row?.compatibility.reason ? mcpReasonText(row.compatibility.reason, t) : undefined,
        }];
      })),
    };
  });

  const agentOptions: Array<ExtensionAppId | "all"> = ["all", ...agents];
  const agentLabels = { all: t("MCP_PM$ALL_AGENTS"), ...Object.fromEntries(agents.map(app => [app, APP_DISPLAY_NAME[app]])) } as Record<string, string>;

  return <div className="oh-mcp-matrix" data-testid="mcp-agent-matrix">
    <div className="oh-matrix-toolbar">
      <EnumFilterDropdown testId="mcp-agent-filter" value={agentFilter} onChange={setAgentFilter}
        options={agentOptions} labelByValue={agentLabels} ariaLabel={t("MCP_PM$FILTER_AGENT")} />
      <span className="oh-matrix-summary">{t("MCP_PM$MATRIX_SUMMARY", { servers: visibleIds.length, assignments: assignmentCount })}</span>
    </div>
    {failures.length > 0 && <div role="alert" className="oh-mcp-error"><p>{t("MCP_PM$SAVE_PARTIAL")}</p>{failures.map((failure, index) => <p key={index}>{failure}</p>)}</div>}
    <MatrixBulkBar selectedCount={selectedIds.length} agents={agents} canAssign={canAssign}
      onAssign={app => void change(selectedIds.filter(id => !rowFor(id, app as ExtensionAppId)?.enabled).map(serverId => ({ serverId, app: app as ExtensionAppId, enabled: true })))}
      onClearAssignments={() => void change(clearOperations)}
      onClearSelection={() => setSelected(new Set())}
      assignLabel={t("MCP_PM$MATRIX_ASSIGN")} clearLabel={t("MCP_PM$MATRIX_CLEAR_ASSIGNMENTS")} clearSelectionLabel={t("MCP_PM$MATRIX_CLEAR_SELECTION")} />
    <AgentMatrixTable
      agents={agents}
      rows={rows}
      selected={selected}
      onSelectedChange={setSelected}
      onToggleCell={(id, app, enabled) => void change([{ serverId: id, app: app as ExtensionAppId, enabled }])}
      onOpenRow={onOpen}
      agentCounts={counts}
      rowHeaderLabel={t("MCP_PM$SERVER_COLUMN")}
      emptyLabel={t("MCP$SEARCH_EMPTY")}
    />
    {!agents.length && <p className="oh-mcp-warning">{t("MCP_PM$MATRIX_NO_TARGETS")}</p>}
    {busy && <p className="oh-mcp-muted" role="status">{t("SETTINGS$SAVING")}</p>}
  </div>;
}
