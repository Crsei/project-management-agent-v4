// Extracted from copied mcpApps/McpAppRequests.ts. The host replaces Orchestrator,
// ProviderSessionManager and SQL with existing Chat persistence and retained capabilities.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { mcpAppToolCallableByApp } from "@t3tools/shared/mcpApp";
import type { McpAppCallInput, McpAppContextInput, McpAppMetadata, McpAppSnapshot, McpAppToolInfo, McpAppToolResult } from "@agent-workspace/contracts/mcp-apps";
import { DurableError } from "../durable/errors.ts";
import { loadMcpAppItem } from "./items.ts";
import { withMcpAppSession, type McpAppSessionAccess } from "./live.ts";
import { readMcpAppHtml } from "./assets.ts";
import { replaceMcpAppContext } from "./context.ts";
import { getNativeOutput } from "../durable/native-output.ts";
import { createPmVisibilityProjector } from "../pm-visibility.ts";

const RESPONSE_LIMIT = 5 * 1024 * 1024;
function boundedResponse<A>(value: A): A {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > RESPONSE_LIMIT)
    throw new DurableError(413, "mcp_app_response_too_large", "The MCP App response exceeds the permitted size.");
  return value;
}

/** A retained native lease does not authorize historical PM content in its producing App. */
async function assertProducingItemVisible(app: McpAppMetadata, headers: Headers, session: McpAppSessionAccess): Promise<void> {
  await session.check();
  const output = getNativeOutput(app.producing.generationId);
  if (!output || output.threadId !== app.producing.threadId)
    throw new DurableError(503, "mcp_app_content_unavailable", "The producing App content is temporarily unavailable.");
  const projector = await createPmVisibilityProjector(app.producing.threadId, headers);
  const item = projector.nativeSnapshot(output).items.find(candidate => candidate.id === app.producing.itemId);
  await session.check();
  if (item?.visibility === "redacted")
    throw new DurableError(403, "mcp_app_content_redacted", "The producing App content is no longer accessible.");
  if (!item || item.visibility === "unavailable" || !item.mcpApp)
    throw new DurableError(503, "mcp_app_content_unavailable", "The producing App content is temporarily unavailable.");
}

export async function mcpAppSnapshot(threadId: string, itemId: string, headers: Headers, signal?: AbortSignal): Promise<McpAppSnapshot> {
  const { app, item } = loadMcpAppItem(threadId, itemId);
  return withMcpAppSession(app, headers, signal, async session => {
    await assertProducingItemVisible(app, headers, session);
    if (!item.mcpToolResult) throw new DurableError(409, "mcp_app_result_missing", "The producing tool result is unavailable.");
    const html = await readMcpAppHtml(app);
    await assertProducingItemVisible(app, headers, session);
    return { app, html, ...(item.input === undefined ? {} : { toolInput: item.input }), toolResult: item.mcpToolResult };
  });
}

export async function mcpAppTools(threadId: string, itemId: string, headers: Headers, signal?: AbortSignal): Promise<{ tools: McpAppToolInfo[] }> {
  const { app } = loadMcpAppItem(threadId, itemId);
  return withMcpAppSession(app, headers, signal, async session => {
    await assertProducingItemVisible(app, headers, session);
    const tools = await session.listTools();
    await assertProducingItemVisible(app, headers, session);
    return boundedResponse({ tools: tools.map(tool => {
      const annotations = tool.annotations !== null && typeof tool.annotations === "object" ? tool.annotations as Record<string, unknown> : undefined;
      return { name: tool.name, callable: mcpAppToolCallableByApp(tool._meta), readOnly: annotations?.readOnlyHint === true,
        ...(typeof annotations?.title === "string" ? { title: annotations.title } : {}), tool };
    }) });
  });
}

export async function mcpAppCall(threadId: string, itemId: string, headers: Headers, input: McpAppCallInput, signal?: AbortSignal): Promise<McpAppToolResult> {
  const { app } = loadMcpAppItem(threadId, itemId);
  return withMcpAppSession(app, headers, signal, async session => {
    await assertProducingItemVisible(app, headers, session);
    const tools = await session.listTools();
    const tool = tools.find(candidate => candidate.name === input.name);
    if (!tool || !mcpAppToolCallableByApp(tool._meta))
      throw new DurableError(403, "mcp_app_tool_not_callable", "This tool is hidden from Apps or absent from the producing server.");
    await assertProducingItemVisible(app, headers, session);
    // Hints and iframe confirmation are not authority. The retained original native MCP
    // transport owns native access; closed PM/automation generation bridges are never revived.
    const result = await session.callTool(input.name, input.arguments);
    await assertProducingItemVisible(app, headers, session);
    return boundedResponse({ content: [...result.content],
      ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
      ...(result.isError === undefined ? {} : { isError: result.isError }), ...(result._meta === undefined ? {} : { _meta: result._meta }) });
  });
}

export async function mcpAppResource(threadId: string, itemId: string, headers: Headers, uri: string, signal?: AbortSignal): Promise<{ contents: unknown[] }> {
  const { app } = loadMcpAppItem(threadId, itemId);
  return withMcpAppSession(app, headers, signal, async session => {
    await assertProducingItemVisible(app, headers, session);
    const result = await session.readResource(uri);
    await assertProducingItemVisible(app, headers, session);
    return boundedResponse({ contents: [...result.contents] });
  });
}

export async function mcpAppContext(threadId: string, itemId: string, headers: Headers, input: McpAppContextInput, signal?: AbortSignal): Promise<{ revision: number }> {
  const { app } = loadMcpAppItem(threadId, itemId);
  return withMcpAppSession(app, headers, signal, async session => {
    await assertProducingItemVisible(app, headers, session);
    // Commit is synchronous immediately after current authorization; replace/clear, never append.
    return { revision: replaceMcpAppContext(app, session.executionEnvironment, session.cwd, input, session.originatingMcpGrant) };
  });
}
