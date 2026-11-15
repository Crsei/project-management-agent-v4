import { z } from "zod";
import { pmToolCallRecordSchema, pmToolTargetSchema, type PmToolCallRecord, type PmToolTarget } from "@agent-workspace/contracts/pm-tools";
import { assertMcpIdentity, assertMcpThread, mcpIdentityHeaders } from "./mcp/identity.ts";
import { createPmToolLinkageBearer, pmToolRequestHash } from "../../../../packages/infrastructure/src/pm-tool-service-auth.ts";
import type { StoredPmToolCall } from "./pm-tools.ts";

export function pmUrl(workspaceId: string | null, action = ""): URL {
  const base = new URL(process.env.PM_API_URL?.trim() || "http://127.0.0.1:4194");
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("Invalid PM API origin");
  return new URL(workspaceId === null ? action : `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agent-tools${action}`, base.origin);
}
function pmHeaders(headers?: Headers): Headers {
  const result = new Headers({ "content-type": "application/json" });
  for (const name of ["cookie", "authorization", "x-pm-tool-linkage", "x-pm-approval-authority"]) { const value = headers?.get(name); if (value) result.set(name, value); }
  return result;
}
export async function pmFetch(workspaceId: string | null, action: string, headers: Headers | undefined, request?: unknown, onDispatch?: () => void): Promise<unknown> {
  const url = pmUrl(workspaceId, action), effectiveHeaders = pmHeaders(headers);
  const bodyText = request === undefined ? undefined : JSON.stringify(request);
  const options: RequestInit = { method: request === undefined ? "GET" : "POST", headers: effectiveHeaders, ...(bodyText === undefined ? {} : { body: bodyText }), redirect: "error", signal: AbortSignal.timeout(30_000) };
  onDispatch?.();
  const response = await fetch(url, options);
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = z.object({ code: z.string().optional(), message: z.string().optional(), error: z.union([z.string(), z.object({ code: z.string().optional(), message: z.string().optional() })]).optional() }).safeParse(body);
    const envelope = parsed.success ? parsed.data : undefined;
    const detail = typeof envelope?.error === "object" ? envelope.error : undefined;
    throw Object.assign(new Error(detail?.message ?? envelope?.message ?? (typeof envelope?.error === "string" ? envelope.error : `PM HTTP ${response.status}`)), { code: detail?.code ?? envelope?.code ?? `pm_http_${response.status}`, status: response.status });
  }
  return body;
}
export function assertTargetCeiling(target: PmToolTarget, ceiling?: PmToolTarget): void {
  if (ceiling && (target.workspaceId !== ceiling.workspaceId || ceiling.projectId !== null && target.projectId !== ceiling.projectId))
    throw Object.assign(new Error("PM target exceeds the originating authorization ceiling"), { status: 403 });
}
export function storedTarget(value: StoredPmToolCall): PmToolTarget {
  const parsed = pmToolTargetSchema.safeParse(value.request.target);
  if (!parsed.success || value.record.workspaceId !== parsed.data.workspaceId ||
      !value.record.target || JSON.stringify(value.record.target) !== JSON.stringify(parsed.data))
    throw Object.assign(new Error("The original operation has no verifiable explicit target; it cannot be replayed or approved."), { status: 409, code: "pm_tool_target_unverifiable" });
  assertTargetCeiling(parsed.data, value.targetCeiling);
  if (value.delegation) assertTargetCeiling(parsed.data, value.delegation.scope);
  return parsed.data;
}
/** Rehydrate only non-secret grant identity; never approve under the browser's identity. */
export async function delegatedHeaders(value: StoredPmToolCall, headers?: Headers): Promise<Headers | undefined> {
  if (!value.delegation) return headers;
  if (value.request.linkage?.executionRoot === "external") await assertMcpIdentity(value.delegation);
  else await assertMcpThread(value.delegation, value.record.threadId);
  if (value.request.target) assertTargetCeiling(value.request.target, value.delegation.scope);
  return mcpIdentityHeaders(value.delegation);
}
export function assertResponseIdentity(value: StoredPmToolCall, response: PmToolCallRecord): void {
  if (response.operationId !== value.record.operationId || response.threadId !== value.record.threadId ||
      response.messageId !== value.record.messageId || response.generationId !== value.record.generationId ||
      response.name !== value.record.name || response.workspaceId !== value.record.workspaceId ||
      JSON.stringify(response.target) !== JSON.stringify(value.record.target) ||
      response.actorId !== value.record.actorId)
    throw new Error("PM returned a mismatched operation or target");
}
export async function signedHeaders(value: StoredPmToolCall, headers?: Headers): Promise<Headers> {
  const result = new Headers(headers);
  if (value.request.linkage && value.record.actorId) {
    const hash = value.requestHash ?? pmToolRequestHash(value.request, value.record.actorId);
    try { result.set("x-pm-tool-linkage", createPmToolLinkageBearer(value.record.actorId, hash, value.request.linkage)); }
    catch (error) { if (value.delegation) throw error; /* Optional audit linkage never gates ordinary authenticated PM execution. */ }
  }
  return result;
}
/** Read the original operation through PM's current family/source authorizer; never call a business mutation. */
export async function readAuthorizedPmToolResult(value: StoredPmToolCall, headers?: Headers): Promise<PmToolCallRecord> {
  const target = storedTarget(value);
  assertResponseIdentity(value, { ...value.record, ...value.request, workspaceId: target.workspaceId });
  if (!value.record.actorId || value.requestHash && value.requestHash !== pmToolRequestHash(value.request, value.record.actorId))
    throw new Error("The original request has no verifiable actor/hash binding");
  const effectiveHeaders = await signedHeaders(value, await delegatedHeaders(value, headers));
  const result = pmToolCallRecordSchema.parse(await pmFetch(target.workspaceId, "/result", effectiveHeaders, value.request));
  assertResponseIdentity(value, result);
  return result;
}
