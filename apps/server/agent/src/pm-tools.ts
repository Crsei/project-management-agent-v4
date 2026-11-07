import { createServer, type Server } from "node:http";
import { Hono } from "hono";
import { z } from "zod";
import type { PmAuthorizedOperation, PmToolCallRecord, PmToolInvocation, PmToolTarget } from "@agent-workspace/contracts/pm-tools";
import { pmToolCallRecordSchema, pmToolInvocationSchema, pmToolTargetSchema, pmWorkspaceDiscoverySchema } from "@agent-workspace/contracts/pm-tools";
import { listRecords, readRecord, writeRecord } from "./durable/store.ts";
import { emitNativeOutput } from "./durable/native-output.ts";
import { getThread } from "./durable/threads.ts";
import { authorizePmTarget } from "./durable/pm-context.ts";
import type { PmChangeKind, PmChangeSet, PmChangeState } from "@agent-workspace/contracts/pm-changes";
import { DurableError } from "./durable/errors.ts";
import { observePmCoreChanges } from "./pm-core-changes/index.ts";
import { assertMcpIdentity, assertMcpThread, mcpIdentityFromHeaders, mcpIdentityHeaders, pmBrowser, type McpInvocationIdentity } from "./mcp/identity.ts";
import { autoApproveApprovals } from "./approval-mode.ts";
import { AGENT_CHAT_TOOL_REGISTRY, agentChatToolDefinitions } from "../../../../packages/application/src/agent-chat-tools.ts";

const namespace = "pm-tool-calls";
type Input = PmToolInvocation;
type Stored = {
  record: PmToolCallRecord; delegation?: McpInvocationIdentity; targetCeiling?: PmToolTarget;
  request: Input & { threadId: string; messageId: string; generationId: string };
};
type Context = {
  threadId: string; messageId: string; generationId: string; headers?: Headers;
  delegation?: McpInvocationIdentity;
  /** Immutable ceiling of this business request, not Session ownership. */
  targetCeiling?: PmToolTarget;
  onAuthorizedOperation?: (operation: PmAuthorizedOperation) => void;
  /** Request-local live Chat authorization; never copied into a stored request. */
  authorizeExecution: (action: "tool") => Promise<void>;
};

/** Only PM's write tools change business state; read tools never appear as changes. */
const changeDefinitions: Record<string, { kind: PmChangeKind; label: string }> = {
  pm_create_project: { kind: "create", label: "创建项目" },
  pm_update_project: { kind: "update", label: "更新项目" },
  pm_create_task: { kind: "create", label: "创建任务" },
  pm_update_task: { kind: "update", label: "更新任务" },
  pm_create_document: { kind: "create", label: "创建文档" },
  pm_save_document: { kind: "update", label: "保存文档" },
  pm_create_comment: { kind: "comment", label: "创建评论" },
  pm_add_relation: { kind: "relation", label: "添加关系" },
  pm_remove_relation: { kind: "relation", label: "移除关系" },
  pm_archive_task: { kind: "archive", label: "归档任务" },
  pm_restore_task: { kind: "archive", label: "恢复任务" },
  pm_delete_task: { kind: "delete", label: "删除任务" },
  pm_transition_task: { kind: "status", label: "更改任务状态" },
};
/** Destructive tools require an explicit approval before PM may be called unless auto-approve is configured. */
export const destructivePmToolNames: Readonly<Record<string, true>> = {
  pm_archive_task: true, pm_restore_task: true, pm_delete_task: true, pm_transition_task: true,
};
/** Failed and unknown outcomes are never reported as applied; pending work is only proposed. */
const changeStates: Record<PmToolCallRecord["status"], PmChangeState> = { pending_approval: "proposed", running: "running", succeeded: "applied", failed: "failed", unknown: "unknown" };
/** Only short, non-sensitive argument labels may reach a change summary. */
function argumentHint(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as Record<string, unknown>;
  for (const key of ["title", "relation"]) {
    const candidate = input[key];
    if (typeof candidate === "string" && candidate.length > 0 && candidate.length <= 120) return candidate;
  }
  return null;
}
function changeSummary(label: string, targetId: string | null, request: unknown): string {
  const target = targetId ?? argumentHint(request);
  return target ? `${label} · ${target}` : label;
}
/** The validated input is exposed only when it is small enough to duplicate safely. */
const maxExposedArgumentsBytes = 16 * 1024;
function exposedArguments(request: Stored["request"]): unknown {
  const value = request.arguments;
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || serialized.length > maxExposedArgumentsBytes) return undefined;
  } catch { return undefined; }
  return value;
}
/**
 * Projects one persisted call into the shared change contract.
 * Missing before/after data is omitted, never reconstructed, and a result source's
 * revision has no slot in `PmChangeSet`, so it is not smuggled into another field.
 */
export function projectPmToolChange(record: PmToolCallRecord, request?: unknown): PmChangeSet | null {
  const definition = changeDefinitions[record.name];
  if (!definition) return null;
  const result = record.result;
  const entity = result && result.kind !== "comment" && result.kind !== "relation" && result.kind !== "workspaces" ? result.items[0] : undefined;
  const comment = result?.kind === "comment" ? result.items[0] : undefined;
  const relation = result?.kind === "relation" ? result.items[0] : undefined;
  const source = result && result.items.length === 0 ? result.sources[0] : undefined;
  const targetId = result?.receipt?.targetId ?? entity?.id ?? comment?.taskId ?? relation?.sourceId ?? source?.entityId ?? null;
  const fields = record.changeSet?.fields;
  return {
    id: record.operationId,
    kind: definition.kind,
    state: changeStates[record.status],
    targetId,
    targetTitle: entity?.title ?? source?.title ?? null,
    projectId: entity?.projectId ?? comment?.projectId ?? source?.projectId ?? null,
    summary: changeSummary(definition.label, targetId, record.arguments ?? request),
    ...(fields && fields.length > 0 ? { fields } : {}),
    receiptId: result?.receipt?.operationId ?? null,
    commandId: result?.receipt?.commandId ?? null,
    error: record.error,
    createdAt: record.createdAt,
    ...(record.finishedAt ? { updatedAt: record.finishedAt } : {}),
  };
}

function pmUrl(workspaceId: string | null, action = ""): URL {
  const base = new URL(process.env.PM_API_URL?.trim() || "http://127.0.0.1:4194");
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("Invalid PM API origin");
  return new URL(workspaceId === null ? action : `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agent-tools${action}`, base.origin);
}
function pmHeaders(headers?: Headers): Headers {
  const result = new Headers({ "content-type": "application/json" });
  for (const name of ["cookie", "authorization"]) { const value = headers?.get(name); if (value) result.set(name, value); }
  return result;
}
function publish(record: PmToolCallRecord): void {
  try {
    emitNativeOutput(record.generationId, { type: "item.upsert", item: {
      id: `pm-tool:${record.operationId}`, type: "dynamic_tool", toolName: record.name,
      status: record.status === "pending_approval" ? "waiting" : record.status === "running" ? "running" : record.status === "succeeded" ? "completed" : "failed",
      startedAt: record.createdAt, ...(record.finishedAt ? { completedAt: record.finishedAt } : {}), output: JSON.stringify(record),
    } });
  } catch (error) {
    if (!(error instanceof DurableError)) throw error;
  }
}
function save(value: Stored): void { writeRecord(namespace, value.record.operationId, value); publish(value.record); }
/** A process restart cannot prove whether an in-flight PM call committed. */
export function interruptPmToolCalls(): void {
  for (const value of listRecords<Stored>(namespace)) {
    if (value.record.status !== "running") continue;
    value.record = { ...value.record, status: "unknown", finishedAt: null, error: { code: "outcome_unknown", message: "The original call was interrupted; reconcile it without redispatching." } };
    writeRecord(namespace, value.record.operationId, value);
  }
}
async function observeCreatedProject(record: PmToolCallRecord, headers?: Headers): Promise<void> {
  const receipt = record.result?.receipt;
  if (!record.workspaceId || record.status !== "succeeded" || record.name !== "pm_create_project" ||
      receipt?.operationId !== record.operationId || receipt.action !== "CreateProject" ||
      !receipt.targetId || !/^PRJ-\d+$/.test(receipt.targetId)) return;
  try {
    await observePmCoreChanges({ workspaceId: record.workspaceId, projectId: receipt.targetId }, headers ?? new Headers(), {
      operationId: record.operationId, createdProjectId: receipt.targetId,
    });
  } catch {
    try {
      emitNativeOutput(record.generationId, { type: "item.upsert", item: { id: `pm-core-observation:${record.operationId}`, type: "notification", status: "failed", title: "PM core observation unavailable", text: "Could not observe the created project's core files." } });
    } catch { /* A completed or deleted generation cannot receive a live diagnostic. */ }
  }
}
async function pmFetch(workspaceId: string | null, action: string, headers: Headers | undefined, request?: unknown): Promise<unknown> {
  const response = await fetch(pmUrl(workspaceId, action), { method: request === undefined ? "GET" : "POST", headers: pmHeaders(headers), ...(request === undefined ? {} : { body: JSON.stringify(request) }), redirect: "error", signal: AbortSignal.timeout(30_000) });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = z.object({ code: z.string().optional(), message: z.string().optional(), error: z.union([z.string(), z.object({ code: z.string().optional(), message: z.string().optional() })]).optional() }).safeParse(body);
    const envelope = parsed.success ? parsed.data : undefined;
    const detail = typeof envelope?.error === "object" ? envelope.error : undefined;
    throw Object.assign(new Error(detail?.message ?? envelope?.message ?? (typeof envelope?.error === "string" ? envelope.error : `PM HTTP ${response.status}`)), { code: detail?.code ?? envelope?.code ?? `pm_http_${response.status}`, status: response.status });
  }
  return body;
}
function assertTargetCeiling(target: PmToolTarget, ceiling?: PmToolTarget): void {
  if (ceiling && (target.workspaceId !== ceiling.workspaceId || ceiling.projectId !== null && target.projectId !== ceiling.projectId))
    throw Object.assign(new Error("PM target exceeds the originating authorization ceiling"), { status: 403 });
}
function storedTarget(value: Stored): PmToolTarget {
  const parsed = pmToolTargetSchema.safeParse(value.request.target);
  if (!parsed.success || value.record.workspaceId !== parsed.data.workspaceId ||
      !value.record.target || JSON.stringify(value.record.target) !== JSON.stringify(parsed.data))
    throw Object.assign(new Error("The original operation has no verifiable explicit target; it cannot be replayed or approved."), { status: 409, code: "pm_tool_target_unverifiable" });
  assertTargetCeiling(parsed.data, value.targetCeiling);
  if (value.delegation) assertTargetCeiling(parsed.data, value.delegation.scope);
  return parsed.data;
}
/** Rehydrate only non-secret grant identity; never approve under the browser's identity. */
async function delegatedHeaders(value: Stored, headers?: Headers): Promise<Headers | undefined> {
  if (!value.delegation) return headers;
  await assertMcpThread(value.delegation, value.record.threadId);
  if (value.request.target) assertTargetCeiling(value.request.target, value.delegation.scope);
  return mcpIdentityHeaders(value.delegation);
}

export async function discoverPmWorkspaces(headers?: Headers, delegation?: McpInvocationIdentity) {
  if (delegation) { await assertMcpIdentity(delegation); headers = await mcpIdentityHeaders(delegation); }
  return pmWorkspaceDiscoverySchema.parse(await pmFetch(null, "/api/v1/agent-contexts", headers));
}
const discoveryTool = {
  name: "pm_list_workspaces", description: "Discover currently authorized PM workspaces and projects. No target or directory is selected. Use an explicit target on every subsequent PM call.",
  write: false, inputSchema: { type: "object", properties: { arguments: { type: "object", properties: {}, required: [], additionalProperties: false } }, required: ["arguments"], additionalProperties: false },
};
const nativePmToolCatalog = { tools: [discoveryTool, ...agentChatToolDefinitions.map(definition => ({
  name: definition.function.name, description: definition.function.description,
  write: AGENT_CHAT_TOOL_REGISTRY.find(tool => tool.name === definition.function.name)!.write,
  inputSchema: definition.function.parameters,
}))] };
export async function listPmTools(headers?: Headers, delegation?: McpInvocationIdentity): Promise<unknown> {
  if (!delegation) return nativePmToolCatalog;
  // External MCP catalogs remain live-authorized within their explicit PM ceiling.
  await assertMcpIdentity(delegation);
  headers = await mcpIdentityHeaders(delegation);
  const catalog = z.object({ tools: z.array(z.object({
    name: z.string(), description: z.string().optional(), write: z.boolean(), inputSchema: z.record(z.string(), z.unknown()),
  })) }).parse(await pmFetch(null, "/api/v1/agent-tools", headers));
  return { tools: [discoveryTool, ...catalog.tools] };
}
function assertResponseIdentity(value: Stored, response: PmToolCallRecord): void {
  if (response.operationId !== value.record.operationId || response.threadId !== value.record.threadId ||
      response.messageId !== value.record.messageId || response.generationId !== value.record.generationId ||
      response.name !== value.record.name || response.workspaceId !== value.record.workspaceId ||
      JSON.stringify(response.target) !== JSON.stringify(value.record.target) ||
      response.actorId !== value.record.actorId)
    throw new Error("PM returned a mismatched operation or target");
}
async function reconcile(value: Stored, headers?: Headers): Promise<PmToolCallRecord> {
  if (value.record.name === "pm_list_workspaces") {
    const effectiveHeaders = await delegatedHeaders(value, headers);
    await authorizedThreadCalls(value.record.threadId, effectiveHeaders ?? new Headers());
    return value.record;
  }
  const target = storedTarget(value);
  headers = await delegatedHeaders(value, headers);
  const authority = await authorizePmTarget(target, headers);
  if (authority.actorId !== value.record.actorId)
    throw Object.assign(new Error("Operation belongs to another PM actor"), { status: 403 });
  if (value.record.status === "pending_approval") return value.record;
  try {
    const body = pmToolCallRecordSchema.parse(await pmFetch(target.workspaceId, "/result", headers, value.request));
    assertResponseIdentity(value, body);
    value.record = body; save(value); await observeCreatedProject(body, headers); return body;
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error) throw error;
    value.record = { ...value.record, status: "unknown", error: { code: "result_unavailable", message: "PM result could not be reconciled; do not redispatch this operation." }, finishedAt: null };
    save(value); return value.record;
  }
}
async function dispatch(value: Stored, headers?: Headers): Promise<PmToolCallRecord> {
  const target = storedTarget(value);
  // A denial before network dispatch is definite; a transport failure remains unknown.
  try {
    headers = await delegatedHeaders(value, headers);
    const response = pmToolCallRecordSchema.parse(await pmFetch(target.workspaceId, "/call", headers, value.request));
    assertResponseIdentity(value, response);
    value.record = response;
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 0;
    value.record = { ...value.record, status: status >= 400 && status < 500 ? "failed" : "unknown", error: { code: status >= 400 && status < 500 && error && typeof error === "object" && "code" in error ? String(error.code) : "outcome_unknown", message: status >= 400 && status < 500 && error instanceof Error ? error.message : "PM outcome is unknown; reconcile using the original operationId." }, finishedAt: status >= 400 && status < 500 ? new Date().toISOString() : null };
  }
  save(value); await observeCreatedProject(value.record, headers); return value.record;
}
export async function callPmTool(context: Context, input: Input): Promise<PmToolCallRecord> {
  input = pmToolInvocationSchema.parse(input);
  const delegation = context.delegation ?? (context.headers ? mcpIdentityFromHeaders(context.headers) : null);
  if (input.target) {
    assertTargetCeiling(input.target, context.targetCeiling);
    if (delegation) assertTargetCeiling(input.target, delegation.scope);
  } else z.strictObject({}).parse(input.arguments);
  await context.authorizeExecution("tool");
  let headers = context.headers;
  if (delegation) {
    await assertMcpThread(delegation, context.threadId);
    headers = await mcpIdentityHeaders(delegation);
    const catalog = z.object({ tools: z.array(z.object({ name: z.string(), write: z.boolean() })) }).parse(await listPmTools(headers, delegation));
    const tool = catalog.tools.find(item => item.name === input.name);
    if (!tool || tool.write && delegation.access !== "full")
      throw Object.assign(new Error("PM tool is outside the current delegation ceiling"), { status: 403 });
  }
  const request: Stored["request"] = { ...input, threadId: context.threadId, messageId: context.messageId, generationId: context.generationId };
  let existing = readRecord<Stored>(namespace, input.operationId);
  if (existing) {
    if (JSON.stringify(existing.request) !== JSON.stringify(request) || existing.delegation?.grantId !== delegation?.grantId ||
        JSON.stringify(existing.targetCeiling) !== JSON.stringify(context.targetCeiling)) throw new Error("operationId already belongs to another request");
    if (input.target) {
      const authority = await authorizePmTarget(storedTarget(existing), headers);
      if (authority.actorId !== existing.record.actorId) throw Object.assign(new Error("Operation belongs to another PM actor"), { status: 403 });
      context.onAuthorizedOperation?.(authority);
    }
    const record = !input.target || delegation && (existing.record.status === "unknown" || existing.record.status === "running")
      ? await reconcile(existing, headers) : existing.record;
    await context.authorizeExecution("tool");
    return record;
  }
  const authority = input.target ? await authorizePmTarget(input.target, headers) : undefined;
  // PM authorization awaited network I/O; recheck the live execution before admission.
  await context.authorizeExecution("tool");
  existing = readRecord<Stored>(namespace, input.operationId);
  if (existing) {
    if (JSON.stringify(existing.request) !== JSON.stringify(request) || existing.delegation?.grantId !== delegation?.grantId ||
        JSON.stringify(existing.targetCeiling) !== JSON.stringify(context.targetCeiling) || authority?.actorId !== existing.record.actorId)
      throw new Error("operationId already belongs to another request");
    if (authority) context.onAuthorizedOperation?.(authority);
    const record = !input.target || delegation && (existing.record.status === "unknown" || existing.record.status === "running")
      ? await reconcile(existing, headers) : existing.record;
    await context.authorizeExecution("tool");
    return record;
  }
  const pending = !autoApproveApprovals() && destructivePmToolNames[input.name] === true;
  const value: Stored = { request, ...(delegation ? { delegation } : {}), ...(context.targetCeiling ? { targetCeiling: context.targetCeiling } : {}),
    record: { operationId: input.operationId, name: input.name, status: pending ? "pending_approval" : "running", result: null, error: null,
      threadId: context.threadId, messageId: context.messageId, generationId: context.generationId, workspaceId: input.target?.workspaceId ?? null,
      ...(input.target ? { target: input.target } : {}), ...(authority ? { actorId: authority.actorId } : {}), createdAt: new Date().toISOString(), finishedAt: null } };
  save(value);
  if (authority) context.onAuthorizedOperation?.(authority);
  if (input.name === "pm_list_workspaces") {
    try {
      const discovery = await discoverPmWorkspaces(headers, delegation ?? undefined);
      value.record = { ...value.record, status: "succeeded", finishedAt: new Date().toISOString(),
        result: { kind: "workspaces", items: discovery.workspaces, nextCursor: null, truncated: false, sources: [] } };
    } catch {
      value.record = { ...value.record, status: "failed", finishedAt: new Date().toISOString(), error: { code: "pm_discovery_unavailable", message: "PM workspace discovery is unavailable; no target was selected." } };
    }
    save(value);
    await context.authorizeExecution("tool");
    return value.record;
  }
  if (pending) return value.record;
  const record = await dispatch(value, headers);
  await context.authorizeExecution("tool");
  return record;
}

/** The loopback endpoint exists only for this generation. Headers and authorization remain in memory. */
export async function openPmToolBridge(context: Context): Promise<{ url: string; close: () => Promise<void> }> {
  const delegation = context.delegation ?? (context.headers ? mcpIdentityFromHeaders(context.headers) : null);
  if (delegation) context = { ...context, delegation };
  // JSON-RPC IDs are local to a transport; Pi supplies its generation-local namespace.
  const mcpCalls = new Map<string, { signature: string; operationId: string; result: Promise<PmToolCallRecord> }>();
  const server: Server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const address = server.address();
    const host = address && typeof address !== "string" ? `127.0.0.1:${address.port}` : "";
    if (req.socket.remoteAddress !== "127.0.0.1" || req.headers.host !== host ||
        req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined ||
        (req.method === "POST" && req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json")) {
      res.writeHead(403).end(JSON.stringify({ error: "Loopback requests only" }));
      return;
    }
    try {
      if (req.method === "GET" && req.url === "/tools/list") {
        await context.authorizeExecution("tool");
        res.end(JSON.stringify(await listPmTools(context.headers, delegation ?? undefined)));
        return;
      }
      if (req.method !== "POST" || !["/tools/call", "/tools/result", "/tools/mcp-call"].includes(req.url ?? "")) { res.writeHead(404).end(JSON.stringify({ error: "not_found" })); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 1024 * 1024) throw new Error("Input too large"); chunks.push(bytes); }
      const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (delegation) await assertMcpThread(delegation, context.threadId);
      if (req.url === "/tools/mcp-call") {
        const input = z.strictObject({ transportId: z.string().min(1).max(128), requestId: z.union([z.string().max(512), z.number().int(), z.null()]), name: z.string().min(1), arguments: z.unknown() }).parse(payload);
        const argumentsEnvelope = z.strictObject({ target: pmToolTargetSchema.optional(), arguments: z.unknown() }).parse(input.arguments);
        const key = JSON.stringify([input.transportId, input.requestId]);
        const signature = JSON.stringify({ name: input.name, arguments: input.arguments });
        let prior = mcpCalls.get(key);
        if (prior && prior.signature !== signature) throw new Error("MCP request ID already belongs to different tool arguments");
        if (prior) {
          // Wait for the original attempt, then reauthorize its durable receipt rather than its cached data.
          try { await prior.result; } catch { /* The original admission may have failed; the operationId remains unchanged. */ }
          res.end(JSON.stringify(await callPmTool(context, { operationId: prior.operationId, name: input.name, ...argumentsEnvelope })));
        } else {
          const operationId = crypto.randomUUID();
          prior = { signature, operationId, result: callPmTool(context, { operationId, name: input.name, ...argumentsEnvelope }) };
          mcpCalls.set(key, prior);
          res.end(JSON.stringify(await prior.result));
        }
        return;
      }
      const input = pmToolInvocationSchema.parse(payload);
      if (req.url === "/tools/call") { res.end(JSON.stringify(await callPmTool(context, input))); return; }
      await context.authorizeExecution("tool");
      const stored = readRecord<Stored>(namespace, input.operationId);
      if (!stored || stored.record.threadId !== context.threadId ||
          JSON.stringify({ operationId: stored.request.operationId, name: stored.request.name, ...(stored.request.target ? { target: stored.request.target } : {}), arguments: stored.request.arguments }) !== JSON.stringify(input) ||
          JSON.stringify(stored.targetCeiling) !== JSON.stringify(context.targetCeiling) || stored.delegation?.grantId !== delegation?.grantId)
        throw new Error("Original operation not found or mismatched");
      const record = await reconcile(stored, context.headers);
      await context.authorizeExecution("tool");
      res.end(JSON.stringify(record));
    } catch (error) { res.writeHead(400).end(JSON.stringify({ error: error instanceof Error ? error.message : "Tool request failed" })); }
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", () => { server.off("error", listening.reject); listening.resolve(); });
  await listening.promise;
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Loopback listener unavailable");
  return { url: `http://127.0.0.1:${address.port}`, close: () => {
    const closed = Promise.withResolvers<void>();
    server.close((error) => error ? closed.reject(error) : closed.resolve());
    return closed.promise;
  } };
}

export const pmToolRoutes = new Hono();
pmToolRoutes.onError((error, c) => {
  if (error instanceof DurableError) return c.json({ error: error.message, code: error.code }, error.status);
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = Number(error.status);
    if (status === 401 || status === 403 || status === 404) return c.json({ error: error instanceof Error ? error.message : "PM access denied" }, status);
    if (status === 409) {
      const code = "code" in error && typeof error.code === "string" ? error.code : "conflict";
      return c.json({ error: error instanceof Error ? error.message : "Approval conflict", code }, 409);
    }
  }
  return c.json({ error: "PM tool request failed." }, 503);
});
pmToolRoutes.get("/pm-tools/workspaces", async (c) => {
  c.header("Cache-Control", "private, no-store");
  const delegation = mcpIdentityFromHeaders(c.req.raw.headers);
  return c.json(await discoverPmWorkspaces(c.req.raw.headers, delegation ?? undefined));
});
async function authorizedThreadCalls(threadId: string, headers: Headers): Promise<Stored[]> {
  const calls = listRecords<Stored>(namespace).filter(item => item.record.threadId === threadId);
  const targets = new Map<string, PmToolTarget>();
  for (const item of calls) {
    if (item.record.name !== "pm_list_workspaces") {
      const target = storedTarget(item);
      targets.set(JSON.stringify(target), target);
    }
  }
  await Promise.all([...targets.values()].map(target => authorizePmTarget(target, headers)));
  if (calls.some(item => item.record.result?.kind === "workspaces")) {
    const current = await discoverPmWorkspaces(headers);
    for (const item of calls) {
      if (item.record.result?.kind !== "workspaces") continue;
      if (item.record.result.items.some(workspace => !current.workspaces.some(allowed => allowed.id === workspace.id &&
          (workspace.workspaceAllowed !== true || allowed.workspaceAllowed === true) &&
          workspace.projects.every(project => allowed.projects.some(visible => visible.id === project.id)))))
        throw Object.assign(new Error("PM discovery history is no longer authorized"), { status: 403 });
    }
  }
  return calls;
}

pmToolRoutes.get("/pm-tools/threads/:threadId/calls", async (c) => {
  const thread = getThread(c.req.param("threadId")); if (!thread) return c.json({ error: "Thread not found" }, 404);
  return c.json({ items: (await authorizedThreadCalls(thread.remoteId, c.req.raw.headers)).map((item) => {
    const args = exposedArguments(item.request);
    return args === undefined ? item.record : { ...item.record, arguments: args };
  }) });
});
pmToolRoutes.get("/pm-tools/threads/:threadId/changes", async (c) => {
  const thread = getThread(c.req.param("threadId")); if (!thread) return c.json({ error: "Thread not found" }, 404);
  const items: PmChangeSet[] = [];
  for (const item of await authorizedThreadCalls(thread.remoteId, c.req.raw.headers)) {
    const change = projectPmToolChange(item.record, item.request.arguments);
    if (change) items.push(change);
  }
  return c.json({ items });
});
pmToolRoutes.post("/pm-tools/calls/:operationId/reconcile", async (c) => {
  const stored = readRecord<Stored>(namespace, c.req.param("operationId")); if (!stored) return c.json({ error: "Operation not found" }, 404);
  const thread = getThread(stored.record.threadId); if (!thread) return c.json({ error: "Thread not found" }, 404);
  return c.json(await reconcile(stored, c.req.raw.headers));
});
pmToolRoutes.post("/pm-tools/calls/:operationId/approve", async (c) => {
  const stored = readRecord<Stored>(namespace, c.req.param("operationId")); if (!stored) return c.json({ error: "Operation not found" }, 404);
  const thread = getThread(stored.record.threadId); if (!thread) return c.json({ error: "Thread not found" }, 404);
  if (stored.delegation?.access === "read-only") return c.json({ error: "Read-only delegation cannot approve a write" }, 403);
  if (stored.delegation && (await pmBrowser(c.req.raw)).actorId !== stored.delegation.actorId)
    return c.json({ error: "Only the originating PM actor may approve this delegated operation" }, 403);
  const authority = await authorizePmTarget(storedTarget(stored), await delegatedHeaders(stored, c.req.raw.headers));
  if (authority.actorId !== stored.record.actorId) return c.json({ error: "Only the originating PM actor may approve this operation" }, 403);
  const latest = readRecord<Stored>(namespace, c.req.param("operationId"));
  if (!latest || latest.record.status !== "pending_approval") return c.json({ error: "Operation is not awaiting approval", code: "approval_not_pending" }, 409);
  // Claim the original operation before any await so a concurrent approval cannot dispatch it twice.
  latest.record = { ...latest.record, status: "running", result: null, error: null, finishedAt: null };
  save(latest);
  return c.json(await dispatch(latest, c.req.raw.headers));
});
pmToolRoutes.post("/pm-tools/calls/:operationId/reject", async (c) => {
  const stored = readRecord<Stored>(namespace, c.req.param("operationId")); if (!stored) return c.json({ error: "Operation not found" }, 404);
  const thread = getThread(stored.record.threadId); if (!thread) return c.json({ error: "Thread not found" }, 404);
  if (stored.delegation && (await pmBrowser(c.req.raw)).actorId !== stored.delegation.actorId)
    return c.json({ error: "Only the originating PM actor may reject this delegated operation" }, 403);
  const authority = await authorizePmTarget(storedTarget(stored), await delegatedHeaders(stored, c.req.raw.headers));
  if (authority.actorId !== stored.record.actorId) return c.json({ error: "Only the originating PM actor may reject this operation" }, 403);
  const latest = readRecord<Stored>(namespace, c.req.param("operationId"));
  if (!latest || latest.record.status !== "pending_approval") return c.json({ error: "Operation is not awaiting approval", code: "approval_not_pending" }, 409);
  latest.record = { ...latest.record, status: "failed", result: null, error: { code: "approval_rejected", message: "The operation was rejected; no PM write was performed." }, finishedAt: new Date().toISOString() };
  save(latest);
  return c.json(latest.record);
});
