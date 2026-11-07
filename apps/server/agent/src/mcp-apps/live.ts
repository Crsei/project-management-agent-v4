// Host lifecycle boundary for copied McpAppRequests' ProviderSessionManager.get.
// Native sessions are retained, never opened by an App request.
import * as Effect from "effect/Effect";
import type { ExecutionEnvironment } from "@agent-workspace/contracts/chat";
import type { McpAppMetadata, McpAppProducingIdentity } from "@agent-workspace/contracts/mcp-apps";
import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";
import type { ProviderAdapterV2McpApps, ProviderAdapterV2McpTool, ProviderAdapterV2McpCallToolResult } from "@t3tools/provider-core/server/ProviderAdapter";
import { DurableError } from "../durable/errors.ts";
import { getStoredInstance, subscribeProviderSettingsChanges } from "../providers/instances.ts";
import { clearMcpAppContexts } from "./context.ts";
import type { ProviderDriverContext } from "../providers/driver-adapter.ts";
import { assertStoredThread, currentGrant, grantIdentity } from "../mcp/grants.ts";
import { assertMcpThread } from "../mcp/identity.ts";

interface RetainedSession {
  readonly apps: readonly McpAppMetadata[];
  readonly executionEnvironment: ExecutionEnvironment;
  readonly cwd: string;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly mcpApps: ProviderAdapterV2McpApps;
  readonly blockedServers: readonly string[];
  readonly originatingMcpGrant?: ProviderDriverContext["originatingMcpGrant"];
  readonly assertCurrent: () => Promise<void>;
  readonly authorize: (headers: Headers, producing: McpAppProducingIdentity) => Promise<void>;
  readonly close: () => Promise<void>;
}
type Entry = RetainedSession & { abort: AbortController; pending: Set<Promise<unknown>>; closed: boolean; closing?: Promise<void> };
const sessions = new Map<string, Entry>();
const closing = new Set<Promise<void>>();
const closingThreads = new Map<string, { instanceId: string; grantId?: string; task: Promise<void> }>();
const cleanupFailures: unknown[] = [];
let unsubscribe: (() => void) | undefined;

async function closeEntry(entry: Entry): Promise<void> {
  if (entry.closing) return entry.closing;
  entry.closed = true;
  const threadId = entry.providerThread.appThreadId!;
  if (sessions.get(threadId) === entry) sessions.delete(threadId);
  entry.abort.abort();
  const task = entry.closing = (async () => {
    await Promise.allSettled(entry.pending);
    await entry.close();
  })();
  closing.add(task);
  closingThreads.set(threadId, { instanceId: entry.providerThread.providerInstanceId, grantId: entry.originatingMcpGrant?.grantId, task });
  void task.then(() => {
    closing.delete(task);
    if (closingThreads.get(threadId)?.task === task) closingThreads.delete(threadId);
  }, error => {
    closing.delete(task);
    if (closingThreads.get(threadId)?.task === task) closingThreads.delete(threadId);
    cleanupFailures.push(error);
  });
  return task;
}

/** Called only after a successful normal Chat turn has settled and its generation binding is closing. */
export function retainMcpAppSession(input: RetainedSession): () => Promise<void> {
  const threadId = input.providerThread.appThreadId;
  if (!threadId || !input.apps.length || sessions.has(threadId) || closingThreads.has(threadId))
    throw new DurableError(409, "mcp_app_session_conflict", "An App session cannot replace a still-live native owner.");
  if (input.apps.some(app => app.producing.threadId !== threadId || app.producing.providerThreadId !== input.providerThread.id
    || app.producing.providerSessionId !== input.providerThread.providerSessionId
    || app.producing.providerInstanceId !== input.providerThread.providerInstanceId
    || app.producing.nativeSessionId !== input.providerThread.nativeThreadRef?.nativeId))
    throw new DurableError(409, "mcp_app_identity_mismatch", "The App does not belong to this live native session.");
  if (input.originatingMcpGrant) assertStoredThread(grantIdentity(currentGrant(input.originatingMcpGrant)), threadId);
  const entry: Entry = { ...input,
    executionEnvironment: { ...input.executionEnvironment, worktree: input.executionEnvironment.worktree ? { ...input.executionEnvironment.worktree } : null },
    ...(input.originatingMcpGrant ? { originatingMcpGrant: { ...input.originatingMcpGrant, scope: { ...input.originatingMcpGrant.scope } } } : {}),
    abort: new AbortController(), pending: new Set(), closed: false };
  sessions.set(threadId, entry);
  unsubscribe ??= subscribeProviderSettingsChanges(() => {
    for (const entry of sessions.values()) {
      const producing = entry.apps[0]!.producing;
      let stale = true;
      try {
        const instance = getStoredInstance(producing.providerInstanceId);
        stale = !instance?.enabled || instance.revision !== producing.instanceRevision;
      } catch { /* Configuration read failure revokes, never renews the capability. */ }
      if (stale) {
        clearMcpAppContexts(producing.threadId);
        void closeEntry(entry).catch(() => undefined);
      }
    }
  });
  return async () => {
    if (sessions.get(threadId) === entry) clearMcpAppContexts(threadId);
    await closeEntry(entry);
  };
}

export type McpAppSessionAccess = {
  readonly executionEnvironment: ExecutionEnvironment;
  readonly cwd: string;
  readonly originatingMcpGrant?: ProviderDriverContext["originatingMcpGrant"];
  readonly check: () => Promise<void>;
  readonly listTools: () => Promise<ReadonlyArray<ProviderAdapterV2McpTool>>;
  readonly callTool: (tool: string, args: Record<string, unknown>) => Promise<ProviderAdapterV2McpCallToolResult>;
  readonly readResource: (uri: string) => Promise<{ readonly contents: ReadonlyArray<unknown> }>;
};

/** No mutable native runtime escapes. Every operation uses the persisted source server and fresh browser authority. */
export async function withMcpAppSession<A>(app: McpAppMetadata, headers: Headers, signal: AbortSignal | undefined,
  use: (session: McpAppSessionAccess) => Promise<A>): Promise<A> {
  const entry = sessions.get(app.producing.threadId);
  if (!entry || entry.closed || !entry.apps.some(candidate => JSON.stringify(candidate) === JSON.stringify(app)))
    throw new DurableError(409, "mcp_app_session_stopped", "The producing App session is stopped or stale. No model turn was started.");
  if (entry.blockedServers.includes(app.server))
    throw new DurableError(409, "mcp_app_session_stopped", "This server's generation-scoped tool transport has closed; its old grant cannot be reused.");
  if (entry.pending.size >= 8) throw new DurableError(429, "mcp_app_busy", "Too many concurrent App requests.");
  const check = async () => {
    if (entry.closed || sessions.get(app.producing.threadId) !== entry || signal?.aborted)
      throw new DurableError(409, "mcp_app_session_stopped", "The producing App session is no longer current.");
    try {
      if (entry.originatingMcpGrant)
        await assertMcpThread(grantIdentity(currentGrant(entry.originatingMcpGrant)), app.producing.threadId);
      await entry.assertCurrent();
      await entry.authorize(headers, app.producing);
      await entry.assertCurrent();
      if (entry.originatingMcpGrant)
        assertStoredThread(grantIdentity(currentGrant(entry.originatingMcpGrant)), app.producing.threadId);
    } catch (error) {
      clearMcpAppContexts(app.producing.threadId);
      // Fence immediately; closing drains this request after its rejection, avoiding a self-wait.
      void closeEntry(entry).catch(() => undefined);
      throw error;
    }
    if (entry.closed || sessions.get(app.producing.threadId) !== entry || signal?.aborted)
      throw new DurableError(409, "mcp_app_session_stopped", "The producing App session changed during authorization.");
  };
  const operationSignal = AbortSignal.any([entry.abort.signal, ...(signal ? [signal] : []), AbortSignal.timeout(30_000)]);
  const run = async <T, E>(effect: Effect.Effect<T, E>): Promise<T> => {
    await check();
    let value: T;
    try { value = await Effect.runPromise(effect, { signal: operationSignal }); }
    catch {
      if (entry.closed || operationSignal.aborted) throw new DurableError(409, "mcp_app_session_stopped", "The App operation was cancelled; an unconfirmed write is not replayed.");
      throw new DurableError(502, "mcp_app_request_failed", "The native MCP server request failed; an unconfirmed write is not replayed.");
    }
    await check();
    return value;
  };
  const work = Promise.resolve().then(async () => {
    await check();
    const value = await use({ executionEnvironment: entry.executionEnvironment, cwd: entry.cwd, originatingMcpGrant: entry.originatingMcpGrant, check,
      listTools: () => run(entry.mcpApps.listTools({ providerThread: entry.providerThread, server: app.server })),
      callTool: (tool, args) => run(entry.mcpApps.callTool({ providerThread: entry.providerThread, server: app.server, tool, arguments: args })),
      readResource: uri => run(entry.mcpApps.readResource({ providerThread: entry.providerThread, server: app.server, uri })),
    });
    await check();
    return value;
  });
  entry.pending.add(work);
  try { return await work; } finally { entry.pending.delete(work); }
}

export async function closeMcpAppSession(threadId: string, options?: { preserveContext?: boolean }): Promise<void> {
  const entry = sessions.get(threadId);
  if (!options?.preserveContext) clearMcpAppContexts(threadId);
  if (entry) await closeEntry(entry);
  else await closingThreads.get(threadId)?.task;
}
export async function closeMcpAppSessionsForInstance(instanceId: string): Promise<void> {
  clearMcpAppContexts(undefined, instanceId);
  await Promise.all([...sessions.values()].filter(entry => entry.apps[0]?.producing.providerInstanceId === instanceId).map(closeEntry));
  await Promise.all([...closingThreads.values()].filter(entry => entry.instanceId === instanceId).map(entry => entry.task));
}
export async function invalidateMcpAppGrant(grantId: string): Promise<void> {
  clearMcpAppContexts(undefined, undefined, grantId);
  await Promise.all([...sessions.values()].filter(entry => entry.originatingMcpGrant?.grantId === grantId).map(closeEntry));
  await Promise.all([...closingThreads.values()].filter(entry => entry.grantId === grantId).map(entry => entry.task));
}
export async function shutdownMcpApps(): Promise<void> {
  unsubscribe?.();
  unsubscribe = undefined;
  // Durable context survives a clean process shutdown. Only a later explicit user
  // turn with matching actor/native lineage and fresh rights may consume it.
  await Promise.allSettled([...sessions.values()].map(closeEntry));
  await Promise.allSettled(closing);
  if (cleanupFailures.length) throw new AggregateError(cleanupFailures.splice(0), "Native App session cleanup failed.");
}
