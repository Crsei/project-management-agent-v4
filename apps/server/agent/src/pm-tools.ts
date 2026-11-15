import { createServer, type Server } from "node:http";
import { Hono } from "hono";
import { z } from "zod";
import type { PmAuthorizedOperation, PmToolCallRecord, PmToolInvocation, PmToolTarget, PmToolLinkage, PmToolCallProjection } from "@agent-workspace/contracts/pm-tools";
import { pmToolCallRecordSchema, pmToolInvocationSchema, pmToolTargetSchema, pmWorkspaceDiscoverySchema, pmToolReconcileResultSchema } from "@agent-workspace/contracts/pm-tools";
import { PM_TOOL_APPROVAL_AUTHORITY_HEADER } from "@agent-workspace/contracts/pm-tools";
import { getDatabase, listRecords, readRecord, writeRecord } from "./durable/store.ts";
import { emitNativeOutput } from "./durable/native-output.ts";
import { getThread } from "./durable/threads.ts";
import { authorizePmTarget } from "./durable/pm-context.ts";
import type { PmChangeKind, PmChangeSet, PmChangeState } from "@agent-workspace/contracts/pm-changes";
import { DurableError } from "./durable/errors.ts";
import { observePmCoreChanges } from "./pm-core-changes/index.ts";
import { assertMcpIdentity, assertMcpThread, mcpIdentityFromHeaders, mcpIdentityHeaders, pmBrowser, type McpInvocationIdentity } from "./mcp/identity.ts";
import { autoApproveApprovals } from "./approval-mode.ts";
import { AGENT_CHAT_TOOL_REGISTRY, agentChatToolDefinitions, parseAgentChatToolInput } from "../../../../packages/application/src/agent-chat-tools.ts";
import { DomainError } from "../../../../packages/domain/src/core.ts";
import { createPmToolLinkageBearer, createPmToolReconcileBearer, pmToolRequestHash, PM_TOOL_RECONCILE_PATH } from "../../../../packages/infrastructure/src/pm-tool-service-auth.ts";
import { createPmVisibilityProjector, type PmVisibilityProjector } from "./pm-visibility.ts";
import { updatePmNativeOutput } from "./durable/native-output.ts";
import { normalizePmToolResult } from "./pm-outcomes.ts";
import { pmUrl, pmFetch, assertTargetCeiling, storedTarget, delegatedHeaders, assertResponseIdentity, signedHeaders } from "./pm-tool-transport.ts";
import { callCollaborationGenerationTool, isCollaborationTool, listCollaborationGenerationTools } from "./collaboration/tools.ts";
import { getCollaborationGenerationContext } from "./collaboration/runs.ts";
import { capturePmApprovalCapabilities, assertPmApprovalCapabilitiesCurrent, assertPmApprovalNotCancelled, pmApprovalDecisionFingerprint, type PmApprovalCapabilityGuard } from "./collaboration/approval-capabilities.ts";

const namespace = "pm-tool-calls";
type Input = PmToolInvocation;
export type StoredPmToolCall = {
  record: PmToolCallRecord; delegation?: McpInvocationIdentity; targetCeiling?: PmToolTarget;
  requestHash?: string;
  executionId?: string;
  approvalCapabilities?: PmApprovalCapabilityGuard;
  request: Input & { threadId: string; messageId: string; generationId: string; linkage?: PmToolLinkage };
};
type Stored = StoredPmToolCall;
export type ExternalPmToolContext = {
  executionRoot: "external"; executionId: string; traceId: string;
  delegation: McpInvocationIdentity; headers?: Headers; targetCeiling?: PmToolTarget;
  executionGrantId?: string;
  authorizeExecution: (action: "tool") => Promise<void>;
};
type Context = {
  threadId: string; messageId: string; generationId: string; headers?: Headers;
  traceId?: string; inputMessageId?: string; executionGrantId?: string;
  executionRoot?: "generation" | "external"; executionId?: string;
  delegation?: McpInvocationIdentity;
  /** Immutable ceiling of this business request, not Session ownership. */
  targetCeiling?: PmToolTarget;
  onAuthorizedOperation?: (operation: PmAuthorizedOperation) => void;
  /** Request-local live Chat authorization; never copied into a stored request. */
  authorizeExecution: (action: "tool") => Promise<void>;
};
async function readApprovalDecision(request: Request): Promise<string | undefined> {
  const text = await request.text();
  if (!text.trim()) return undefined;
  if (text.length > 1024) throw new DurableError(400, "invalid_approval_decision", "Approval decision input is too large.");
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new DurableError(400, "invalid_approval_decision", "Approval decision must be JSON."); }
  const parsed = z.strictObject({ decisionFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(body);
  if (!parsed.success) throw new DurableError(400, "invalid_approval_decision", "Use the original decision fingerprint.");
  return parsed.data.decisionFingerprint;
}

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
  pm_create_entity: { kind: "create", label: "创建实体" },
  pm_update_entity: { kind: "update", label: "更新实体" },
  pm_save_entity_body: { kind: "update", label: "保存正文" },
  pm_save_entity_source: { kind: "update", label: "保存源码" },
  pm_archive_entity: { kind: "archive", label: "归档实体" },
  pm_restore_entity: { kind: "archive", label: "恢复实体" },
  pm_delete_entity: { kind: "delete", label: "删除实体" },
  pm_transition_entity: { kind: "status", label: "更改实体状态" },
  pm_save_view: { kind: "update", label: "保存视图" },
  pm_save_configuration: { kind: "update", label: "保存配置" },
  pm_preview_migration: { kind: "create", label: "创建迁移预览" },
  pm_apply_migration: { kind: "update", label: "应用迁移" },
  pm_restore_migration: { kind: "update", label: "恢复迁移" },
};
/** Destructive tools require an explicit approval before PM may be called unless auto-approve is configured. */
export const destructivePmToolNames: Readonly<Record<string, true>> = {
  pm_archive_task: true, pm_restore_task: true, pm_delete_task: true, pm_transition_task: true,
  pm_archive_entity: true, pm_restore_entity: true, pm_delete_entity: true, pm_transition_entity: true,
  pm_apply_migration: true, pm_restore_migration: true,
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
/** Every centrally registered write has a truthful resource change, not an invented core entity. */
function changeDefinition(name: string): { kind: PmChangeKind; label: string } | undefined {
  const defined = changeDefinitions[name];
  if (defined) return defined;
  if (!AGENT_CHAT_TOOL_REGISTRY.some(tool => tool.name === name && tool.write)) return undefined;
  const action = name.split("_")[1];
  const kind: PmChangeKind = action === "create" ? "create" : action === "delete" ? "delete"
    : action === "archive" || action === "restore" ? "archive" : "update";
  return { kind, label: name };
}
/**
 * Projects one persisted call into the shared change contract.
 * Missing before/after data is omitted, never reconstructed, and a result source's
 * revision has no slot in `PmChangeSet`, so it is not smuggled into another field.
 */
export function projectPmToolChange(record: PmToolCallRecord, request?: unknown): PmChangeSet | null {
  const definition = changeDefinition(record.name);
  if (!definition) return null;
  const result = record.result;
  const entity = result && (result.kind === "project" || result.kind === "task" || result.kind === "document" ||
    result.kind === "cycle" || result.kind === "milestone" || result.kind === "module" || result.kind === "requirement" ||
    result.kind === "release" || result.kind === "goal" || result.kind === "query" || result.kind === "lifecycle") ? result.items[0] : undefined;
  const comment = result?.kind === "comment" ? result.items[0] : undefined;
  const relation = result?.kind === "relation" ? result.items[0] : undefined;
  const source = !entity && !comment && !relation ? result?.sources[0] : undefined;
  const targetId = result?.receipt?.targetId ?? entity?.id ?? comment?.taskId ?? relation?.sourceId ?? source?.entityId ?? record.changeSet?.targetId ?? null;
  const fields = record.changeSet?.fields;
  return {
    id: record.operationId,
    kind: definition.kind,
    state: changeStates[record.status],
    targetId,
    targetTitle: entity?.title ?? source?.title ?? record.changeSet?.targetTitle ?? null,
    projectId: entity?.projectId ?? comment?.projectId ?? source?.projectId ?? record.changeSet?.projectId ?? record.target?.projectId ?? null,
    summary: changeSummary(definition.label, targetId, record.arguments ?? request),
    ...(fields && fields.length > 0 ? { fields } : {}),
    receiptId: result?.receipt?.operationId ?? null,
    commandId: result?.receipt?.commandId ?? null,
    error: record.error,
    createdAt: record.createdAt,
    ...(record.finishedAt ? { updatedAt: record.finishedAt } : {}),
  };
}

export type PmToolCallChange = Pick<PmToolCallRecord, "operationId" | "threadId" | "generationId" | "status">;
const pmToolCallObservers = new Set<(change: Readonly<PmToolCallChange>) => void>();
/** Observes already-committed original identities only; no payload, replay, dispatch or approval authority. */
export function subscribePmToolCalls(listener: (change: Readonly<PmToolCallChange>) => void): () => void {
  pmToolCallObservers.add(listener);
  return () => { pmToolCallObservers.delete(listener); };
}
function publish(record: PmToolCallRecord): void {
  if (!record.generationId) return;
  try {
    updatePmNativeOutput(record.generationId, {
      id: `pm-tool:${record.operationId}`, type: "dynamic_tool", toolName: record.name,
      status: record.status === "pending_approval" ? "waiting" : record.status === "running" ? "running" : record.status === "succeeded" ? "completed" : record.status,
      startedAt: record.createdAt, ...(record.finishedAt && record.status !== "unknown" ? { completedAt: record.finishedAt } : {}), output: JSON.stringify(record),
    });
  } catch (error) {
    if (!(error instanceof DurableError)) throw error;
  }
}
function save(value: Stored): void {
  const previous = readRecord<Stored>(namespace, value.record.operationId);
  if (previous?.record.status === "succeeded" && value.record.status !== "succeeded") value.record = previous.record;
  else if (previous?.record.status === "succeeded" && value.record.status === "succeeded") {
    const retained = previous.record, incoming = value.record;
    value.record = { ...incoming, result: incoming.result ?? retained.result,
      arguments: incoming.arguments ?? retained.arguments, changeSet: incoming.changeSet ?? retained.changeSet,
      commandIds: [...new Set([...(retained.commandIds ?? []), ...(incoming.commandIds ?? [])])],
      linkage: retained.linkage ?? incoming.linkage, notices: retained.notices ?? incoming.notices,
      finishedAt: retained.finishedAt ?? incoming.finishedAt,
      certainty: !incoming.result && retained.result ? retained.certainty : incoming.certainty };
  }
  writeRecord(namespace, value.record.operationId, value);
  // Current PM saves are standalone commits. Never expose an ambient transaction's speculative state.
  if (pmToolCallObservers.size && !getDatabase().isTransaction) {
    const { operationId, threadId, generationId, status } = value.record;
    const change: Readonly<PmToolCallChange> = Object.freeze({ operationId, threadId, generationId, status });
    for (const listener of pmToolCallObservers) {
      try { listener(change); }
      catch { /* An execution observer cannot reject or overwrite the durable PM operation. */ }
    }
  }
  publish(value.record);
}
/** A process restart cannot prove whether an in-flight or unproven legacy failure committed. */
export function interruptPmToolCalls(): void {
  for (const value of listRecords<Stored>(namespace)) {
    const legacyFailure = value.record.status === "failed" && !value.record.certainty && value.record.name !== "pm_list_workspaces" && value.record.error?.code !== "approval_rejected";
    if (value.record.status !== "running" && !legacyFailure) continue;
    value.record = { ...value.record, status: "unknown", finishedAt: null, certainty: { dispatch: "possibly_sent", evidence: "unresolved" }, error: { code: "outcome_unknown", message: "The original call was interrupted or lacks execution evidence; reconcile it without redispatching." } };
    save(value);
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
/** Shared business schemas apply before every transport's PM dispatch, not just inside PM. */
function pmInputError(name: string, input: unknown): PmToolCallRecord["error"] {
  if (name === "pm_list_workspaces") return z.strictObject({}).safeParse(input).success ? null
    : { code: "agent_tool_invalid_input", message: "Invalid pm_list_workspaces arguments. Provide an empty arguments object." };
  const tool = AGENT_CHAT_TOOL_REGISTRY.find(tool => tool.name === name);
  if (!tool) return { code: "agent_tool_not_available", message: "This PM tool is not registered." };
  try { parseAgentChatToolInput(tool.name, input); return null; }
  catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return { code: error.code, message: error.message };
  }
}
/** A known read schema can reject an old invalid query, never establish a write's outcome. */
function legacyQueryInputError(value: Stored): PmToolCallRecord["error"] {
  if (value.record.name !== "pm_query" || value.request.name !== "pm_query" || value.record.result ||
      !["running", "unknown", "failed"].includes(value.record.status) ||
      value.record.certainty && (value.record.certainty.dispatch === "not_sent" || value.record.certainty.evidence !== "unresolved")) return null;
  return pmInputError(value.request.name, value.request.arguments);
}
function rejectInput(value: Stored, error: NonNullable<PmToolCallRecord["error"]>, dispatch: "not_sent" | "possibly_sent"): void {
  value.record = { ...value.record, status: "failed", result: null, commandIds: [],
    certainty: { dispatch, evidence: "local_rejection" }, finishedAt: new Date().toISOString(),
    error: { code: error.code, message: `${error.message} ${dispatch === "not_sent" ? "No PM command was sent." : "The original read was not replayed."} Correct arguments require a new operationId.` } };
  save(value);
}
/** Internal proof only changes business certainty. It never grants access to the business payload. */
async function reconcileProof(value: Stored): Promise<void> {
  if (!value.record.actorId || !value.request.target || value.record.status === "pending_approval" ||
      value.record.certainty?.dispatch === "not_sent" || value.record.certainty?.evidence === "local_rejection" || legacyQueryInputError(value)) return;
  try {
    const requestHash = value.requestHash ?? pmToolRequestHash(value.request, value.record.actorId);
    const proof = { operationId: value.record.operationId, actorId: value.record.actorId, target: value.request.target, requestHash };
    const response = await fetch(pmUrl(null, PM_TOOL_RECONCILE_PATH), {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${createPmToolReconcileBearer(proof)}` },
      body: JSON.stringify(proof), redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) { await response.body?.cancel(); return; }
    const result = pmToolReconcileResultSchema.parse(await response.json());
    if (result.operationId !== proof.operationId || result.actorId !== proof.actorId || result.requestHash !== proof.requestHash || JSON.stringify(result.target) !== JSON.stringify(proof.target)) return;
    if (result.status === "unknown" || result.evidence === "unresolved") return;
    value.record = { ...value.record, status: result.status, certainty: { dispatch: "possibly_sent", evidence: "internal_proof" }, commandIds: result.commandIds,
      ...(result.linkage ? { linkage: result.linkage } : {}), finishedAt: value.record.finishedAt ?? new Date().toISOString(), error: null };
    save(value);
  } catch { /* Missing service configuration or proof is not evidence of failure. */ }
}
async function reconcile(value: Stored, headers?: Headers, rejectAccessDenied = false): Promise<PmToolCallRecord> {
  if (value.record.name === "pm_list_workspaces") {
    const current = await discoverPmWorkspaces(await delegatedHeaders(value, headers));
    const historical = value.record.result;
    if (historical?.kind === "workspaces" && historical.items.some(workspace => !current.workspaces.some(allowed => allowed.id === workspace.id &&
        (workspace.workspaceAllowed !== true || allowed.workspaceAllowed === true) && workspace.projects.every(project => allowed.projects.some(item => item.id === project.id)))))
      throw Object.assign(new Error("PM discovery history is no longer authorized"), { status: 403 });
    return value.record;
  }
  const invalidQuery = legacyQueryInputError(value);
  if (!invalidQuery) await reconcileProof(value);
  const target = storedTarget(value);
  headers = await delegatedHeaders(value, headers);
  const authority = await authorizePmTarget(target, headers);
  if (authority.actorId !== value.record.actorId) throw Object.assign(new Error("Operation belongs to another PM actor"), { status: 403 });
  if (invalidQuery) {
    // Keep the original arguments/hash and require the same binding as a PM result.
    assertResponseIdentity(value, { ...value.record, ...value.request, workspaceId: target.workspaceId });
    if (value.requestHash && value.requestHash !== pmToolRequestHash(value.request, authority.actorId))
      throw Object.assign(new Error("The original request hash does not match its operation"), { status: 409, code: "pm_tool_identity_conflict" });
    rejectInput(value, invalidQuery, "possibly_sent");
    return value.record;
  }
  if (value.record.status === "pending_approval" || value.record.certainty?.dispatch === "not_sent" || value.record.certainty?.evidence === "local_rejection") return value.record;
  try {
    const body = pmToolCallRecordSchema.parse(await pmFetch(target.workspaceId, "/result", await signedHeaders(value, headers), value.request));
    assertResponseIdentity(value, body);
    const normalized = normalizePmToolResult(body);
    value.record = { ...normalized, linkage: value.record.linkage ?? normalized.linkage, notices: value.record.notices, commandIds: normalized.commandIds ?? value.record.commandIds };
    save(value); await observeCreatedProject(value.record, headers);
  } catch (error) {
    if (rejectAccessDenied && typeof error === "object" && error !== null && "status" in error &&
        [401, 403].includes(Number(error.status))) throw error;
    // Original success is immutable; a delivery error withholds content instead of changing that fact.
    if (value.record.status === "succeeded") throw error;
    if (!(value.record.status === "failed" && value.record.certainty?.evidence === "pm_result") && value.record.certainty?.evidence !== "internal_proof") {
      value.record = { ...value.record, status: "unknown", error: { code: "result_unavailable", message: "PM result could not be reconciled; do not redispatch this operation." }, finishedAt: null };
      save(value);
    }
  }
  return value.record;
}
/** Server-owned original reconciliation; no new request identity, business dispatch or cancellation gate. */
export async function reconcilePmToolCall(operationId: string, headers: Headers): Promise<PmToolCallProjection> {
  const stored = readRecord<Stored>(namespace, operationId);
  if (!stored) throw new DurableError(404, "pm_operation_not_found", "Operation not found");
  if (stored.request.linkage?.executionRoot !== "external" && !getThread(stored.record.threadId))
    throw new DurableError(404, "pm_thread_not_found", "Thread not found");
  try { await reconcile(stored, headers); } catch (error) {
    if (stored.record.status === "succeeded") {
      const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 0;
      return { operationId: stored.record.operationId, threadId: stored.record.threadId,
        messageId: stored.record.messageId, generationId: stored.record.generationId,
        visibility: [401, 403, 404].includes(status) ? "redacted" : "unavailable" };
    }
    // Proof is preserved independently of current body visibility.
  }
  return (await createPmVisibilityProjector(stored.record.threadId, headers, { operationIds: [stored.record.operationId] })).calls[0]!;
}
async function dispatch(value: Stored, headers?: Headers): Promise<PmToolCallRecord> {
  let sent = false;
  try {
    const target = storedTarget(value);
    headers = await delegatedHeaders(value, headers);
    const authority = await authorizePmTarget(target, headers);
    if (authority.actorId !== value.record.actorId) throw Object.assign(new Error("Operation belongs to another PM actor"), { status: 403 });
    const invalid = pmInputError(value.request.name, value.request.arguments);
    if (invalid) { rejectInput(value, invalid, "not_sent"); return value.record; }
    const effectiveHeaders = await signedHeaders(value, headers);
    // Only the persisted server-derived snapshot constrains dispatch; never accept one from tool/browser input.
    effectiveHeaders.delete(PM_TOOL_APPROVAL_AUTHORITY_HEADER);
    if (value.approvalCapabilities?.pmAuthority)
      effectiveHeaders.set(PM_TOOL_APPROVAL_AUTHORITY_HEADER, value.approvalCapabilities.pmAuthority.fingerprint);
    if (value.request.name === "pm_create_comment" && value.request.linkage?.collaboration && !effectiveHeaders.has("x-pm-tool-linkage"))
      throw new DurableError(503, "collaboration_origin_unavailable", "Trusted Run comment origin cannot be signed; no PM comment was sent.");
    if (value.approvalCapabilities) assertPmApprovalNotCancelled(value);
    const response = pmToolCallRecordSchema.parse(await pmFetch(target.workspaceId, "/call", effectiveHeaders, value.request, () => {
      value.record = { ...value.record, certainty: { dispatch: "possibly_sent", evidence: "unresolved" } };
      save(value);
      sent = true;
    }));
    assertResponseIdentity(value, response);
    const normalized = normalizePmToolResult(response);
    value.record = { ...normalized, linkage: value.record.linkage ?? normalized.linkage, notices: value.record.notices };
  } catch {
    value.record = { ...value.record, status: sent ? "unknown" : "failed",
      certainty: { dispatch: sent ? "possibly_sent" : "not_sent", evidence: sent ? "unresolved" : "local_rejection" },
      error: { code: sent ? "outcome_unknown" : "dispatch_rejected", message: sent ? "PM outcome is unknown; reconcile using the original operationId." : "The operation was rejected before dispatch; no PM command was sent." },
      finishedAt: sent ? null : new Date().toISOString() };
  }
  save(value); await observeCreatedProject(value.record, headers); return value.record;
}
function sameDelegation(left?: McpInvocationIdentity, right?: McpInvocationIdentity | null): boolean {
  return left?.grantId === right?.grantId && left?.actorId === right?.actorId && left?.version === right?.version &&
    left?.access === right?.access && JSON.stringify(left?.scope) === JSON.stringify(right?.scope);
}
async function readableRecord(value: Stored, headers?: Headers, authorizeExecution?: Context["authorizeExecution"]): Promise<PmToolCallRecord> {
  const projected = (await createPmVisibilityProjector(value.record.threadId, headers ?? new Headers(), { operationIds: [value.record.operationId] })).calls[0];
  await authorizeExecution?.("tool");
  if (!projected || projected.visibility !== "visible")
    throw Object.assign(new Error("PM content is not currently accessible."), { status: projected?.visibility === "redacted" ? 403 : 503 });
  return projected;
}
export async function callPmTool(providedContext: Context | ExternalPmToolContext, input: Input): Promise<PmToolCallRecord> {
  const originalContext: Context = providedContext.executionRoot === "external" ? { ...providedContext, threadId: "", messageId: "", generationId: "" } : providedContext as Context;
  const collaboration = originalContext.executionRoot !== "external" ? getCollaborationGenerationContext(originalContext.generationId) : null;
  if (collaboration && (collaboration.threadId !== originalContext.threadId || originalContext.inputMessageId && collaboration.inputMessageId !== originalContext.inputMessageId))
    throw new DurableError(409, "collaboration_binding_mismatch", "PM origin does not belong to the original server-owned Run generation.");
  const context: Context = collaboration ? { ...originalContext, targetCeiling: { workspaceId: collaboration.target.workspaceId, projectId: collaboration.target.projectId } } : originalContext;
  if (input.name === operationResultTool.name) throw new Error("Operation recovery is a native control read, not a business invocation.");
  input = pmToolInvocationSchema.parse(input);
  const delegation = context.delegation ?? (context.headers ? mcpIdentityFromHeaders(context.headers) : null);
  if (input.target) {
    assertTargetCeiling(input.target, context.targetCeiling);
    if (delegation) assertTargetCeiling(input.target, delegation.scope);
  }
  await context.authorizeExecution("tool");
  let headers = context.headers;
  if (delegation) {
    if (context.executionRoot === "external") await assertMcpIdentity(delegation);
    else await assertMcpThread(delegation, context.threadId);
    headers = await mcpIdentityHeaders(delegation);
    const catalog = z.object({ tools: z.array(z.object({ name: z.string(), write: z.boolean() })) }).parse(await listPmTools(headers, delegation));
    const tool = catalog.tools.find(item => item.name === input.name);
    if (!tool || tool.write && delegation.access !== "full")
      throw Object.assign(new Error("PM tool is outside the current delegation ceiling"), { status: 403 });
  }
  let existing = readRecord<Stored>(namespace, input.operationId);
  const linkage: PmToolLinkage | undefined = context.traceId ? {
    traceId: context.traceId, invocationId: input.operationId, executionRoot: context.executionRoot ?? "generation",
    ...(context.inputMessageId ? { inputMessageId: context.inputMessageId } : {}),
    ...(context.executionGrantId ? { executionGrantId: context.executionGrantId } : {}),
    clientKind: context.executionRoot === "external" ? "mcp" : "chat", policy: "full", enforcement: "audit-only",
    ...(collaboration ? { collaboration: {
      runId: collaboration.runId, agentId: collaboration.agentId, agentVersion: collaboration.agentVersion,
      delegationId: collaboration.delegationId ?? null, target: collaboration.target,
    } } : {}),
  } : undefined;
  let request: Stored["request"] = { ...input, threadId: context.threadId, messageId: context.messageId, generationId: context.generationId, ...(linkage ? { linkage } : {}) };
  if (existing) {
    if (JSON.stringify(existing.request) !== JSON.stringify({ ...request, ...(existing.request.linkage ? {} : { linkage: undefined }) }) ||
        linkage && existing.record.linkage && JSON.stringify(existing.record.linkage) !== JSON.stringify(linkage) || existing.delegation?.grantId !== delegation?.grantId ||
        existing.executionId !== context.executionId || !sameDelegation(existing.delegation, delegation) ||
        JSON.stringify(existing.targetCeiling) !== JSON.stringify(context.targetCeiling)) throw new Error("operationId already belongs to another request");
    if (input.target) {
      const authority = await authorizePmTarget(storedTarget(existing), headers);
      if (authority.actorId !== existing.record.actorId) throw Object.assign(new Error("Operation belongs to another PM actor"), { status: 403 });
      context.onAuthorizedOperation?.(authority);
    }
    if (legacyQueryInputError(existing)) await reconcile(existing, headers);
    const record = !input.target || delegation && (existing.record.status === "unknown" || existing.record.status === "running")
      ? await reconcile(existing, headers) : existing.record;
    await context.authorizeExecution("tool");
    return input.target ? readableRecord(existing, headers, context.authorizeExecution) : record;
  }
  const authority = input.target ? await authorizePmTarget(input.target, headers) : undefined;
  // PM authorization awaited network I/O; recheck the live execution before admission.
  if (collaboration && authority && collaboration.actorId !== authority.actorId) throw new DurableError(403, "collaboration_actor_changed", "Current PM actor does not match the originating Run.");
  await context.authorizeExecution("tool");
  let notices: PmToolCallRecord["notices"];
  if (linkage && authority && !delegation) {
    try { createPmToolLinkageBearer(authority.actorId, pmToolRequestHash(request, authority.actorId), linkage); }
    catch {
      if (collaboration && input.name === "pm_create_comment") throw new DurableError(503, "collaboration_origin_unavailable", "Trusted Run comment origin requires the existing service signing key; no PM comment was sent.");
      delete request.linkage;
      notices = [{ code: "pm_linkage_unavailable", message: "Cross-service audit linkage is unavailable; existing PM authorization remains enforced." }];
    }
  }
  existing = readRecord<Stored>(namespace, input.operationId);
  if (existing) {
    if (JSON.stringify(existing.request) !== JSON.stringify({ ...request, ...(existing.request.linkage ? {} : { linkage: undefined }) }) ||
        linkage && existing.record.linkage && JSON.stringify(existing.record.linkage) !== JSON.stringify(linkage) || existing.delegation?.grantId !== delegation?.grantId ||
        existing.executionId !== context.executionId || !sameDelegation(existing.delegation, delegation) ||
        JSON.stringify(existing.targetCeiling) !== JSON.stringify(context.targetCeiling) || authority?.actorId !== existing.record.actorId)
      throw new Error("operationId already belongs to another request");
    if (authority) context.onAuthorizedOperation?.(authority);
    if (legacyQueryInputError(existing)) await reconcile(existing, headers);
    const record = !input.target || delegation && (existing.record.status === "unknown" || existing.record.status === "running")
      ? await reconcile(existing, headers) : existing.record;
    await context.authorizeExecution("tool");
    return input.target ? readableRecord(existing, headers, context.authorizeExecution) : record;
  }
  const invalid = pmInputError(input.name, input.arguments);
  const pending = !autoApproveApprovals() && destructivePmToolNames[input.name] === true;
  const value: Stored = { request, ...(delegation ? { delegation } : {}), ...(context.targetCeiling ? { targetCeiling: context.targetCeiling } : {}),
    ...(context.executionId ? { executionId: context.executionId } : {}),
    ...(authority ? { requestHash: pmToolRequestHash(request, authority.actorId) } : {}),
    record: { operationId: input.operationId, name: input.name, status: pending ? "pending_approval" : "running", result: null, error: null,
      certainty: { dispatch: "not_sent", evidence: "unresolved" }, ...(linkage ? { linkage } : {}), ...(notices ? { notices } : {}),
      threadId: context.threadId, messageId: context.messageId, generationId: context.generationId, workspaceId: input.target?.workspaceId ?? null,
      ...(input.target ? { target: input.target } : {}), ...(authority ? { actorId: authority.actorId } : {}), createdAt: new Date().toISOString(), finishedAt: null } };
  if (pending && !invalid) {
    value.approvalCapabilities = await capturePmApprovalCapabilities(value, headers);
    await context.authorizeExecution("tool");
    const prior = readRecord<Stored>(namespace, input.operationId);
    if (prior) {
      if (pmApprovalDecisionFingerprint(prior) !== pmApprovalDecisionFingerprint(value)) throw new DurableError(409, "approval_request_changed", "The operation was already accepted with different approval facts.");
      return readableRecord(prior, headers, context.authorizeExecution);
    }
  }
  if (invalid) rejectInput(value, invalid, "not_sent"); else save(value);
  if (authority) context.onAuthorizedOperation?.(authority);
  if (invalid) {
    await context.authorizeExecution("tool");
    return input.target ? readableRecord(value, headers, context.authorizeExecution) : value.record;
  }
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
  await dispatch(value, headers);
  await context.authorizeExecution("tool");
  return readableRecord(value, headers, context.authorizeExecution);
}

/** External callers can only recover their original binding; an absent reservation never dispatches. */
export async function readPmToolOperation(operationId: string, context: ExternalPmToolContext): Promise<PmToolCallProjection> {
  await context.authorizeExecution("tool");
  await assertMcpIdentity(context.delegation);
  const value = readRecord<Stored>(namespace, operationId);
  if (!value) return { operationId, threadId: "", messageId: "", generationId: "", visibility: "unavailable" };
  if (value.executionId !== context.executionId || value.request.linkage?.executionRoot !== "external" ||
      value.request.linkage.traceId !== context.traceId || !sameDelegation(value.delegation, context.delegation))
    throw Object.assign(new Error("Operation belongs to another execution root"), { status: 403 });
  await reconcileProof(value);
  try {
    await reconcile(value, context.headers);
    await context.authorizeExecution("tool");
    return (await createPmVisibilityProjector("", await delegatedHeaders(value, context.headers) ?? new Headers(), { operationIds: [operationId] })).calls[0]!;
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 0;
    return { operationId, threadId: "", messageId: "", generationId: "", visibility: [401, 403, 404].includes(status) ? "redacted" : "unavailable" };
  }
}

const operationResultInputSchema = z.strictObject({ arguments: z.strictObject({ operationId: z.uuid() }) });
const operationResultTool = {
  name: "pm_get_operation_result",
  description: "Read the original target-bound PM operation in this Chat using only its operationId. The server reuses its persisted request and current authorization; never creates an operation, executes a business command, or retries an unknown write. Unknown stays unresolved without authoritative evidence.",
  write: false,
  inputSchema: z.toJSONSchema(operationResultInputSchema, { io: "input" }),
};
/** Generation control read: the model supplies an identity, never a reconstructed invocation. */
async function readGenerationPmToolOperation(context: Context, operationId: string): Promise<PmToolCallRecord> {
  await context.authorizeExecution("tool");
  if (context.delegation) await assertMcpThread(context.delegation, context.threadId);
  const value = readRecord<Stored>(namespace, operationId);
  if (!value || value.record.threadId !== context.threadId || value.request.threadId !== context.threadId ||
      value.request.linkage?.executionRoot === "external" || value.executionId !== context.executionId ||
      JSON.stringify(value.targetCeiling) !== JSON.stringify(context.targetCeiling) ||
      !sameDelegation(value.delegation, context.delegation))
    throw new Error("Original operation not found or mismatched");
  const target = storedTarget(value);
  assertTargetCeiling(target, context.targetCeiling);
  if (context.delegation) assertTargetCeiling(target, context.delegation.scope);
  const headers = await delegatedHeaders(value, context.headers);
  const authority = await authorizePmTarget(target, headers);
  if (authority.actorId !== value.record.actorId) throw Object.assign(new Error("Operation belongs to another PM actor"), { status: 403 });
  assertResponseIdentity(value, { ...value.record, ...value.request, workspaceId: target.workspaceId });
  if (value.requestHash && value.requestHash !== pmToolRequestHash(value.request, authority.actorId))
    throw new Error("The original request hash does not match its operation");
  context.onAuthorizedOperation?.(authority);
  await context.authorizeExecution("tool");
  await reconcile(value, headers, true);
  const record = await readableRecord(value, await delegatedHeaders(value, headers));
  await context.authorizeExecution("tool");
  if (context.delegation) await assertMcpThread(context.delegation, context.threadId);
  return record;
}

/** The loopback endpoint exists only for this generation. Headers and authorization remain in memory. */
export async function openPmToolBridge(context: Context): Promise<{ url: string; close: () => Promise<void> }> {
  const delegation = context.delegation ?? (context.headers ? mcpIdentityFromHeaders(context.headers) : null);
  if (delegation) context = { ...context, delegation };
  const collaboration = getCollaborationGenerationContext(context.generationId);
  if (collaboration) context = { ...context, targetCeiling: { workspaceId: collaboration.target.workspaceId, projectId: collaboration.target.projectId } };
  // JSON-RPC IDs are local to a transport; Pi supplies its generation-local namespace.
  const mcpCalls = new Map<string, { signature: string; operationId: string; result: Promise<PmToolCallRecord> }>();
  const mcpSignatures = new Map<string, string>();
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
        const catalog = await listPmTools(context.headers, delegation ?? undefined) as { tools: unknown[] };
        const collaboration = delegation ? [] : await listCollaborationGenerationTools(context.generationId, context.headers);
        res.end(JSON.stringify({ ...catalog, tools: [...catalog.tools, operationResultTool, ...collaboration] }));
        return;
      }
      if (req.method !== "POST" || !["/tools/call", "/tools/result", "/tools/mcp-call"].includes(req.url ?? "")) { res.writeHead(404).end(JSON.stringify({ error: "not_found" })); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 1024 * 1024) throw new Error("Input too large"); chunks.push(bytes); }
      const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (delegation) await assertMcpThread(delegation, context.threadId);
      if (req.url === "/tools/mcp-call") {
        const input = z.strictObject({ transportId: z.string().min(1).max(128), requestId: z.union([z.string().max(512), z.number().int(), z.null()]), name: z.string().min(1), arguments: z.unknown() }).parse(payload);
        const key = JSON.stringify([input.transportId, input.requestId]);
        const signature = JSON.stringify({ name: input.name, arguments: input.arguments });
        const originalSignature = mcpSignatures.get(key);
        if (originalSignature && originalSignature !== signature) throw new Error("MCP request ID already belongs to different tool arguments");
        mcpSignatures.set(key, signature);
        if (isCollaborationTool(input.name)) {
          if (delegation) throw new DurableError(403, "collaboration_context_required", "External MCP delegation cannot acquire internal Run authority.");
          await context.authorizeExecution("tool");
          const result = await callCollaborationGenerationTool({
            generationId: context.generationId, transportId: input.transportId, requestId: input.requestId,
            name: input.name, arguments: input.arguments, ...(context.headers ? { headers: context.headers } : {}),
          });
          res.end(JSON.stringify(result));
          return;
        }
        let prior = mcpCalls.get(key);
        if (prior && prior.signature !== signature) throw new Error("MCP request ID already belongs to different tool arguments");
        if (input.name === operationResultTool.name) {
          const { arguments: { operationId } } = operationResultInputSchema.parse(input.arguments);
          const result = readGenerationPmToolOperation(context, operationId);
          mcpCalls.set(key, { signature, operationId, result });
          res.end(JSON.stringify(await result));
          return;
        }
        const argumentsEnvelope = z.strictObject({ target: pmToolTargetSchema.optional(), arguments: z.unknown() }).parse(input.arguments);
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
          JSON.stringify(stored.targetCeiling) !== JSON.stringify(context.targetCeiling) || !sameDelegation(stored.delegation, delegation))
        throw new Error("Original operation not found or mismatched");
      await reconcile(stored, context.headers);
      const record = await readableRecord(stored, await delegatedHeaders(stored, context.headers));
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

/** Inbox is a current projection of the original PM owner, never a second decision endpoint. */
export async function listPendingPmApprovals(input: { workspaceId: string; projectId?: string; headers: Headers }) {
  const items: Array<{ call: PmToolCallRecord; decisionFingerprint: string; capabilityFingerprint: string | null; respondable: boolean; unavailableReason: string | null }> = [];
  const projectors = new Map<string, PmVisibilityProjector>();
  for (const value of listRecords<Stored>(namespace)) {
    if (value.record.status !== "pending_approval" || value.record.workspaceId !== input.workspaceId ||
        input.projectId && value.request.target?.projectId !== input.projectId ||
        value.request.linkage?.executionRoot !== "external" && !getThread(value.record.threadId)) continue;
    try {
      const target = storedTarget(value);
      const browserAuthority = await authorizePmTarget(target, input.headers);
      if (browserAuthority.actorId !== value.record.actorId || value.delegation && browserAuthority.actorId !== value.delegation.actorId) continue;
      let projector = projectors.get(value.record.threadId);
      if (!projector) {
        projector = await createPmVisibilityProjector(value.record.threadId, input.headers);
        projectors.set(value.record.threadId, projector);
      }
      const call = projector.calls.find(item => item.operationId === value.record.operationId);
      if (!call || call.visibility !== "visible" || call.status !== "pending_approval") continue;
      let unavailableReason: string | null = null;
      try {
        if (value.delegation?.access === "read-only") throw new Error("Read-only delegation");
        await assertPmApprovalCapabilitiesCurrent(value, await delegatedHeaders(value, input.headers));
      } catch {
        unavailableReason = "The original capability snapshot or delegation is no longer current. Open the original operation to reject or reconcile it; approval is disabled.";
      }
      const latest = readRecord<Stored>(namespace, value.record.operationId);
      if (!latest || latest.record.status !== "pending_approval" || pmApprovalDecisionFingerprint(latest) !== pmApprovalDecisionFingerprint(value)) continue;
      items.push({ call, decisionFingerprint: pmApprovalDecisionFingerprint(value), capabilityFingerprint: value.approvalCapabilities?.manifest?.fingerprint ?? null,
        respondable: unavailableReason === null, unavailableReason });
    } catch {
      // Revoked/unavailable content is omitted, not exposed as an approval card with saved arguments.
    }
  }
  return items;
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

pmToolRoutes.get("/pm-tools/threads/:threadId/calls", async (c) => {
  const thread = getThread(c.req.param("threadId")); if (!thread) return c.json({ error: "Thread not found" }, 404);
  c.header("Cache-Control", "private, no-store");
  return c.json({ items: (await createPmVisibilityProjector(thread.remoteId, c.req.raw.headers)).calls });
});
pmToolRoutes.get("/pm-tools/threads/:threadId/changes", async (c) => {
  const thread = getThread(c.req.param("threadId")); if (!thread) return c.json({ error: "Thread not found" }, 404);
  const items: PmChangeSet[] = [];
  for (const item of (await createPmVisibilityProjector(thread.remoteId, c.req.raw.headers)).calls) {
    if (item.visibility !== "visible") continue;
    const change = projectPmToolChange(item, item.arguments);
    if (change) items.push(change);
  }
  return c.json({ items });
});
/** Correlation reverse lookup is a read projection, never a reconciliation or execution trigger. */
pmToolRoutes.get("/pm-tools/calls/:operationId", async (c) => {
  const stored = readRecord<Stored>(namespace, c.req.param("operationId"));
  if (!stored || stored.request.linkage?.executionRoot !== "external" && !getThread(stored.record.threadId)) return c.json({ error: "Operation not found" }, 404);
  c.header("Cache-Control", "private, no-store");
  return c.json((await createPmVisibilityProjector(stored.record.threadId, c.req.raw.headers, { operationIds: [stored.record.operationId] })).calls[0]);
});
pmToolRoutes.post("/pm-tools/calls/:operationId/reconcile", async (c) => {
  c.header("Cache-Control", "private, no-store");
  try { return c.json(await reconcilePmToolCall(c.req.param("operationId"), c.req.raw.headers)); }
  catch (error) {
    if (error instanceof DurableError && error.status === 404) return c.json({ error: error.message }, 404);
    throw error;
  }
});
pmToolRoutes.post("/pm-tools/calls/:operationId/approve", async (c) => {
  const stored = readRecord<Stored>(namespace, c.req.param("operationId")); if (!stored) return c.json({ error: "Operation not found" }, 404);
  if (stored.request.linkage?.executionRoot !== "external" && !getThread(stored.record.threadId)) return c.json({ error: "Thread not found" }, 404);
  if (stored.delegation?.access === "read-only") return c.json({ error: "Read-only delegation cannot approve a write" }, 403);
  if (stored.delegation && (await pmBrowser(c.req.raw)).actorId !== stored.delegation.actorId)
    return c.json({ error: "Only the originating PM actor may approve this delegated operation" }, 403);
  const authority = await authorizePmTarget(storedTarget(stored), await delegatedHeaders(stored, c.req.raw.headers));
  if (authority.actorId !== stored.record.actorId) return c.json({ error: "Only the originating PM actor may approve this operation" }, 403);
  const decision = await readApprovalDecision(c.req.raw);
  if (decision && decision !== pmApprovalDecisionFingerprint(stored)) throw new DurableError(409, "approval_request_changed", "The action, parameters, target or capability facts changed since this decision was displayed.");
  if (stored.record.status !== "pending_approval") return c.json({ error: "Operation is not awaiting approval", code: "approval_not_pending" }, 409);
  await assertPmApprovalCapabilitiesCurrent(stored, await delegatedHeaders(stored, c.req.raw.headers));
  const latest = readRecord<Stored>(namespace, c.req.param("operationId"));
  if (!latest || latest.record.status !== "pending_approval") return c.json({ error: "Operation is not awaiting approval", code: "approval_not_pending" }, 409);
  if (pmApprovalDecisionFingerprint(latest) !== pmApprovalDecisionFingerprint(stored)) throw new DurableError(409, "approval_request_changed", "The original approval facts changed before the claim.");
  assertPmApprovalNotCancelled(latest);
  // Claim the original operation before any await so a concurrent approval cannot dispatch it twice.
  latest.record = { ...latest.record, status: "running", result: null, error: null, finishedAt: null };
  save(latest);
  await dispatch(latest, c.req.raw.headers);
  return c.json(await readableRecord(latest, await delegatedHeaders(latest, c.req.raw.headers)));
});
pmToolRoutes.post("/pm-tools/calls/:operationId/reject", async (c) => {
  const stored = readRecord<Stored>(namespace, c.req.param("operationId")); if (!stored) return c.json({ error: "Operation not found" }, 404);
  if (stored.request.linkage?.executionRoot !== "external" && !getThread(stored.record.threadId)) return c.json({ error: "Thread not found" }, 404);
  if (stored.delegation && (await pmBrowser(c.req.raw)).actorId !== stored.delegation.actorId)
    return c.json({ error: "Only the originating PM actor may reject this delegated operation" }, 403);
  const authority = await authorizePmTarget(storedTarget(stored), await delegatedHeaders(stored, c.req.raw.headers));
  if (authority.actorId !== stored.record.actorId) return c.json({ error: "Only the originating PM actor may reject this operation" }, 403);
  const decision = await readApprovalDecision(c.req.raw);
  if (decision && decision !== pmApprovalDecisionFingerprint(stored)) throw new DurableError(409, "approval_request_changed", "The action, parameters, target or capability facts changed since this decision was displayed.");
  const latest = readRecord<Stored>(namespace, c.req.param("operationId"));
  if (!latest || latest.record.status !== "pending_approval") return c.json({ error: "Operation is not awaiting approval", code: "approval_not_pending" }, 409);
  if (pmApprovalDecisionFingerprint(latest) !== pmApprovalDecisionFingerprint(stored)) throw new DurableError(409, "approval_request_changed", "The original approval facts changed before the decision.");
  latest.record = { ...latest.record, status: "failed", certainty: { dispatch: "not_sent", evidence: "local_rejection" }, result: null, error: { code: "approval_rejected", message: "The operation was rejected; no PM write was performed." }, finishedAt: new Date().toISOString() };
  save(latest);
  return c.json(latest.record);
});
