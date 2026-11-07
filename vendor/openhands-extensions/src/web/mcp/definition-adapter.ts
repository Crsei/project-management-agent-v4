import type { ExtensionMcpDefinition, ExtensionMcpManagement } from "@agent-workspace/contracts/extensions";
import { MCP_APP_IDS, type McpAppId, type McpServer, type McpServersMap } from "@pm/cc-switch-ui";
import type { MCPServerConfig } from "@pm/openhands-source/types/mcp-server";

/** Presentation projection only. Rust remains the validator/projector for all writes. */
export function definitionToCard(definition: ExtensionMcpDefinition): MCPServerConfig {
  const spec = definition.server;
  return {
    id: definition.id,
    name: definition.name,
    type: spec.type === "sse" ? "sse" : spec.type === "stdio" || typeof spec.command === "string" ? "stdio" : "shttp",
    ...(typeof spec.command === "string" ? { command: spec.command } : {}),
    ...(typeof spec.url === "string" ? { url: spec.url } : {}),
    ...(Array.isArray(spec.args) ? { args: spec.args.filter((value): value is string => typeof value === "string") } : {}),
  };
}

export function managementToSourceServers(management: ExtensionMcpManagement): McpServersMap {
  return Object.fromEntries(Object.entries(management.definitions).map(([id, definition]) => [id, {
    ...definition,
    apps: Object.fromEntries(MCP_APP_IDS.map(app => [app, management.agentConfigurations[id]?.[app]?.enabled ?? false])) as Record<McpAppId, boolean>,
  } satisfies McpServer]));
}
