// Adapted from copied mcpApps/McpAppModelContext.ts, McpAppRequests.ts and
// orchestration-v2/RunExecutionService.ts. Copyright (c) 2026 T3 Tools Inc. MIT.
import type { AgentScope } from "@agent-workspace/contracts/chat";
import type { McpAppContextInput, McpAppMetadata } from "@agent-workspace/contracts/mcp-apps";
import type { NativeSessionRef } from "@agent-workspace/contracts/provider";
import type { ProviderDriverContext } from "../providers/driver-adapter.ts";
import { sameAgentScope } from "../durable/agent-scope.ts";
import { DurableError } from "../durable/errors.ts";
import { deleteRecord, listRecords, readRecord, transaction, writeRecord } from "../durable/store.ts";
import { loadMcpAppItem } from "./items.ts";
import { assertMcpThread } from "../mcp/identity.ts";
import { assertStoredThread, currentGrant, grantIdentity } from "../mcp/grants.ts";

export const MCP_APP_MODEL_CONTEXT_MAX_BYTES = 16 * 1024;
const CONTEXTS = "mcp-app-model-context-v1";
type ContextRecord = {
  key: string; app: McpAppMetadata; actorId: string; scope: AgentScope; cwd: string;
  text: string; revision: number; updatedAt: string;
  originatingMcpGrant?: ProviderDriverContext["originatingMcpGrant"];
};

export function replaceMcpAppContext(app: McpAppMetadata, scope: AgentScope, cwd: string, input: McpAppContextInput,
  originatingMcpGrant?: ProviderDriverContext["originatingMcpGrant"]): number {
  const texts = (input.content ?? []).map(block => block.text);
  if (input.structuredContent !== undefined) texts.push(JSON.stringify(input.structuredContent));
  const text = texts.join("\n");
  if (Buffer.byteLength(text, "utf8") > MCP_APP_MODEL_CONTEXT_MAX_BYTES || Buffer.byteLength(JSON.stringify(input), "utf8") > MCP_APP_MODEL_CONTEXT_MAX_BYTES)
    throw new DurableError(413, "mcp_app_context_too_large", "App model context must not exceed 16 KiB.");
  return transaction(() => {
    const generation = readRecord<{ executionSnapshot?: { actorId?: string } }>("chat:generations", app.producing.generationId);
    const actorId = generation?.executionSnapshot?.actorId;
    if (!actorId) throw new DurableError(412, "mcp_app_actor_required", "App context requires the producing PM actor identity.");
    if (originatingMcpGrant) {
      if (originatingMcpGrant.actorId !== actorId || !sameAgentScope(originatingMcpGrant.scope, scope))
        throw new DurableError(403, "mcp_app_grant_mismatch", "App context does not belong to its originating MCP grant.");
      assertStoredThread(grantIdentity(currentGrant(originatingMcpGrant)), app.producing.threadId);
    }
    const key = JSON.stringify([app.producing.threadId, app.producing.itemId]);
    const previous = readRecord<ContextRecord>(CONTEXTS, key);
    const revision = (previous?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) throw new DurableError(409, "mcp_app_context_revision", "App context revision exhausted.");
    // A clear retains only its revision, so stale context cannot be appended or revived.
    writeRecord<ContextRecord>(CONTEXTS, key, { key, app, actorId, scope: { ...scope }, cwd,
      text: text.trim() === "" ? "" : text, revision, updatedAt: new Date().toISOString(),
      ...(originatingMcpGrant ? { originatingMcpGrant: {
        grantId: originatingMcpGrant.grantId, actorId: originatingMcpGrant.actorId,
        scope: { ...originatingMcpGrant.scope }, access: originatingMcpGrant.access, version: originatingMcpGrant.version,
      } } : {}) });
    return revision;
  });
}

export function clearMcpAppContexts(threadId?: string, instanceId?: string, grantId?: string): void {
  transaction(() => {
    for (const entry of listRecords<ContextRecord>(CONTEXTS)) {
      if ((threadId === undefined || entry.app.producing.threadId === threadId)
        && (instanceId === undefined || entry.app.producing.providerInstanceId === instanceId)
        && (grantId === undefined || entry.originatingMcpGrant?.grantId === grantId)) deleteRecord(CONTEXTS, entry.key);
    }
  });
}

/** Native untrusted context field, once per next turn; never appended to saved user history. */
export async function mcpAppContextForTurn(context: ProviderDriverContext, source?: NativeSessionRef): Promise<{ key: string; text: string }[]> {
  if (!context.execution || !context.authorizeMcpApp || !context.authorizeExecution || context.pmAnalysis || !source) return [];
  await context.authorizeExecution("tool");
  const generation = readRecord<{ executionSnapshot?: { actorId?: string } }>("chat:generations", context.execution.generationId);
  const actorId = generation?.executionSnapshot?.actorId;
  if (!actorId) return [];
  const entries = listRecords<ContextRecord>(CONTEXTS).filter(entry => {
    const producing = entry.app.producing;
    return entry.text !== "" && entry.actorId === actorId && producing.threadId === context.execution!.threadId
      && producing.providerInstanceId === context.instanceId && producing.instanceRevision === context.revision
      && producing.nativeSessionId === source.sessionId && source.providerInstanceId === context.instanceId
      && source.instanceRevision === context.revision && source.cwd === context.cwd && entry.cwd === context.cwd
      && sameAgentScope(entry.scope, context.execution!.scope);
  }).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.app.producing.itemId.localeCompare(b.app.producing.itemId));
  const result: { key: string; text: string }[] = [];
  for (const entry of entries) {
    if (entry.originatingMcpGrant) {
      try { await assertMcpThread(grantIdentity(currentGrant(entry.originatingMcpGrant)), entry.app.producing.threadId); }
      catch {
        clearMcpAppContexts(undefined, undefined, entry.originatingMcpGrant.grantId);
        continue;
      }
    }
    try {
      const current = loadMcpAppItem(entry.app.producing.threadId, entry.app.producing.itemId);
      if (JSON.stringify(current.app) !== JSON.stringify(entry.app)) continue;
    } catch (error) {
      if (error instanceof DurableError && error.status === 404) continue;
      throw error;
    }
    result.push({ key: `mcp_app_${entry.app.producing.itemId.replace(/[^\w.-]/g, "_")}`, text: entry.text });
  }
  await context.authorizeExecution("tool");
  return mcpAppContextForDispatch(context, source, result);
}

/** Synchronous commit-time grant check immediately before native startTurn dispatch. */
export function mcpAppContextForDispatch(context: ProviderDriverContext, source: NativeSessionRef | undefined,
  selected: readonly { key: string; text: string }[]): { key: string; text: string }[] {
  if (!context.execution || !context.authorizeMcpApp || !context.authorizeExecution || context.pmAnalysis || !source
    || source.providerInstanceId !== context.instanceId || source.instanceRevision !== context.revision || source.cwd !== context.cwd) return [];
  const actorId = readRecord<{ executionSnapshot?: { actorId?: string } }>("chat:generations", context.execution.generationId)?.executionSnapshot?.actorId;
  if (!actorId) return [];
  const current = listRecords<ContextRecord>(CONTEXTS).filter(entry => entry.actorId === actorId && entry.cwd === context.cwd
    && sameAgentScope(entry.scope, context.execution!.scope) && entry.app.producing.threadId === context.execution!.threadId
    && entry.app.producing.providerInstanceId === context.instanceId && entry.app.producing.instanceRevision === context.revision
    && entry.app.producing.nativeSessionId === source.sessionId);
  return selected.filter(value => current.some(entry => {
    if (value.key !== `mcp_app_${entry.app.producing.itemId.replace(/[^\w.-]/g, "_")}` || value.text !== entry.text) return false;
    if (!entry.originatingMcpGrant) return true;
    try {
      assertStoredThread(grantIdentity(currentGrant(entry.originatingMcpGrant)), entry.app.producing.threadId);
      return true;
    } catch {
      clearMcpAppContexts(undefined, undefined, entry.originatingMcpGrant.grantId);
      return false;
    }
  }));
}
