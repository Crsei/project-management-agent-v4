/** OpenHands transport/card view, projected from the CC Switch shared definition.
 * Agent enablement and encrypted overrides live only in the management contract.
 * Hosted OpenHands test/OAuth response types are intentionally not part of this host.
 */
export type MCPServerType = "sse" | "stdio" | "shttp";

export interface MCPServerConfig {
  id: string;
  type: MCPServerType;
  name?: string;
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}
