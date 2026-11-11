// Adapted from copied mcpApps/McpAppModelContext.ts, McpAppRequests.ts and
// orchestration-v2/RunExecutionService.ts. Copyright (c) 2026 T3 Tools Inc. MIT.
import type { ExecutionEnvironment } from "@agent-workspace/contracts/chat";
import type { McpAppContextInput, McpAppMetadata } from "@agent-workspace/contracts/mcp-apps";
import type { NativeSessionRef } from "@agent-workspace/contracts/provider";
import type { ProviderDriverContext } from "../providers/driver-adapter.ts";
import { sameExecutionIdentity } from "../durable/agent-execution.ts";
import { DurableError } from "../durable/errors.ts";
import { deleteRecord, listRecords, readRecord, transaction, writeRecord } from "../durable/store.ts";
import { loadMcpAppItem } from "./items.ts";
import { assertMcpThread } from "../mcp/identity.ts";
import { assertStoredThread, currentGrant, grantIdentity } from "../mcp/grants.ts";
import { createPmVisibilityProjector, recordPmContentProvenance } from "../pm-visibility.ts";

export const MCP_APP_MODEL_CONTEXT_MAX_BYTES = 16 * 1024;
const CONTEXTS = "mcp-app-model-context-v1";
type ContextRecord = {
  key: string; app: McpAppMetadata; actorId: string | null; executionEnvironment: ExecutionEnvironment; cwd: string;
  text: string; revision: number; updatedAt: string;
  originatingMcpGrant?: ProviderDriverContext["originatingMcpGrant"];
};

export function replaceMcpAppContext(app: McpAppMetadata, executionEnvironment: ExecutionEnvironment, cwd: string, input: McpAppContextInput,
  originatingMcpGrant?: ProviderDriverContext["originatingMcpGrant"]): number {
  const texts = (input.content ?? []).map(block => block.text);
  if (input.structuredContent !== undefined) texts.push(JSON.stringify(input.structuredContent));
  const text = texts.join("\n");
  if (Buffer.byteLength(text, "utf8") > MCP_APP_MODEL_CONTEXT_MAX_BYTES || Buffer.byteLength(JSON.stringify(input), "utf8") > MCP_APP_MODEL_CONTEXT_MAX_BYTES)
    throw new DurableError(413, "mcp_app_context_too_large", "App model context must not exceed 16 KiB.");
  return transaction(() => {
    // Ordinary Apps inherit Agent browser authority, not a fabricated PM actor.
    // Delegated Apps keep their immutable actor and grant ceiling separately.
    const actorId = originatingMcpGrant?.actorId ?? null;
    if (originatingMcpGrant) {
      assertStoredThread(grantIdentity(currentGrant(originatingMcpGrant)), app.producing.threadId);
    }
    const key = JSON.stringify([app.producing.threadId, app.producing.itemId]);
    const previous = readRecord<ContextRecord>(CONTEXTS, key);
    const revision = (previous?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) throw new DurableError(409, "mcp_app_context_revision", "App context revision exhausted.");
    // A clear retains only its revision, so stale context cannot be appended or revived.
    writeRecord<ContextRecord>(CONTEXTS, key, { key, app, actorId,
      executionEnvironment: { ...executionEnvironment, worktree: executionEnvironment.worktree ? { ...executionEnvironment.worktree } : null }, cwd,
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
  const actorId = context.originatingMcpGrant?.actorId ?? null;
  const entries = listRecords<ContextRecord>(CONTEXTS).filter(entry => {
    const producing = entry.app.producing;
    return entry.text !== "" && entry.actorId === actorId && producing.threadId === context.execution!.threadId
      && producing.providerInstanceId === context.instanceId && producing.instanceRevision === context.revision
      && producing.nativeSessionId === source.sessionId && source.providerInstanceId === context.instanceId
      && source.instanceRevision === context.revision && source.cwd === context.cwd && entry.cwd === context.cwd
      && sameExecutionIdentity(entry.executionEnvironment, context.execution!.environment);
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
    if (context.authorizeMcpAppContext) {
      if (!await context.authorizeMcpAppContext(entry.app.producing)) continue;
    } else {
      // Old in-memory callers have no request credentials. Clean non-PM Apps
      // remain usable; PM-derived cached content must never use a permissive fallback.
      const projection = await createPmVisibilityProjector(entry.app.producing.threadId, new Headers());
      const producing = projection.generation({ id: entry.app.producing.generationId, pmVisibility: undefined as string | undefined });
      if (producing.pmVisibility) continue;
      recordPmContentProvenance({ threadId: context.execution.threadId, generationId: context.execution.generationId,
        messageIds: [context.execution.messageId], operationIds: projection.provenance.operationIds,
        targets: projection.provenance.targets, authorities: projection.provenance.authorities ?? [] });
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
  const actorId = context.originatingMcpGrant?.actorId ?? null;
  if (context.originatingMcpGrant) {
    try { assertStoredThread(grantIdentity(currentGrant(context.originatingMcpGrant)), context.execution.threadId); }
    catch { return []; }
  }
  const current = listRecords<ContextRecord>(CONTEXTS).filter(entry => entry.actorId === actorId && entry.cwd === context.cwd
    && sameExecutionIdentity(entry.executionEnvironment, context.execution!.environment) && entry.app.producing.threadId === context.execution!.threadId
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
