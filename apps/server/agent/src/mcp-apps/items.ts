// Host persistence boundary for copied McpAppRequests.resolveApp; no second Chat store.
import type { AgentOutputSnapshot, NativeOutputItem } from "@agent-workspace/contracts/output";
import { mcpAppMetadataSchema, type McpAppMetadata } from "@agent-workspace/contracts/mcp-apps";
import { readRecord, writeRecord } from "../durable/store.ts";
import { DurableError } from "../durable/errors.ts";

const ITEMS = "mcp-app-producing-items-v1";
const key = (threadId: string, itemId: string) => JSON.stringify([threadId, itemId]);
export function indexMcpAppItem(snapshot: AgentOutputSnapshot, item: NativeOutputItem): void {
  if (!item.mcpApp) return;
  const identity = item.mcpApp.producing;
  if (identity.threadId !== snapshot.threadId || identity.generationId !== snapshot.generationId || identity.itemId !== item.id
    || item.type !== "dynamic_tool" || item.toolName !== `${item.mcpApp.server}.${item.mcpApp.tool}`)
    throw new DurableError(409, "mcp_app_identity_mismatch", "The App output does not match its producing item.");
  writeRecord(ITEMS, key(snapshot.threadId, item.id), { generationId: snapshot.generationId });
}
export function loadMcpAppItem(threadId: string, itemId: string): { app: McpAppMetadata; item: NativeOutputItem } {
  const index = readRecord<{ generationId: string }>(ITEMS, key(threadId, itemId));
  const output = index && readRecord<AgentOutputSnapshot>("native-output", index.generationId);
  const item = output?.threadId === threadId ? output.items.find(candidate => candidate.id === itemId) : undefined;
  const parsed = mcpAppMetadataSchema.safeParse(item?.mcpApp);
  if (!index || !item || item.type !== "dynamic_tool" || item.status !== "completed" || !parsed.success
    || parsed.data.producing.threadId !== threadId || parsed.data.producing.itemId !== itemId
    || parsed.data.producing.generationId !== index.generationId
    || item.toolName !== `${parsed.data.server}.${parsed.data.tool}`)
    throw new DurableError(404, "mcp_app_not_found", "This producing item has no interactive MCP App.");
  return { app: parsed.data, item };
}
