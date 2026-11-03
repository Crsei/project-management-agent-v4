import type { AgentScope, PmContext } from "@agent-workspace/contracts/chat";
import {
  pmReferenceResolveRequestSchema,
  pmReferenceResolveResponseSchema,
  type PmReferenceInput,
  type PmReferenceResolution,
} from "@agent-workspace/contracts/pm-references";
import { DurableError } from "./errors.ts";
import { mcpIdentityFromHeaders, mcpIdentityHeaders } from "../mcp/identity.ts";

const PM_CONTEXT_TIMEOUT_MS = 30_000;
const projectIdPattern = /^PRJ-\d+$/;
const referenceKind = (id: string): PmReferenceInput["kind"] =>
  projectIdPattern.test(id) ? "project" : /^DOC[-_]/i.test(id) ? "document" : "issue";

/** Both-null/absent means "no PM issue binding", never an empty binding. */
export function normalizedPmContext(context: PmContext | null | undefined): PmContext | undefined {
  if (!context) return undefined;
  const taskId = context.taskId ?? null;
  const entityId = context.entityId ?? null;
  return taskId === null && entityId === null ? undefined : { taskId, entityId };
}

export function samePmContext(a: PmContext | undefined, b: PmContext | undefined): boolean {
  const left = normalizedPmContext(a);
  const right = normalizedPmContext(b);
  return (left?.taskId ?? null) === (right?.taskId ?? null) && (left?.entityId ?? null) === (right?.entityId ?? null);
}

/** Credentials stay request-local: only cookie/authorization are proxied, never stored. */
async function pmEndpoint(path: string, requestHeaders?: Headers): Promise<{ url: URL; headers: Headers }> {
  let base: URL;
  try {
    base = new URL(process.env.PM_API_URL?.trim() || "http://127.0.0.1:4194");
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash)
      throw new Error("Invalid PM origin");
  } catch {
    throw new DurableError(503, "pm_api_unavailable", "PM API 地址配置无效，未接受本次请求。");
  }
  let effectiveHeaders = requestHeaders;
  if (requestHeaders?.get("authorization")?.startsWith("Bearer pm-mcp-service-v1.")) {
    const identity = mcpIdentityFromHeaders(requestHeaders);
    if (!identity) throw new DurableError(403, "mcp_grant_revoked", "原 MCP 委托已失效，拒绝解析 PM 引用。");
    effectiveHeaders = await mcpIdentityHeaders(identity);
  }
  const headers = new Headers({ "content-type": "application/json" });
  for (const name of ["cookie", "authorization"]) {
    const value = effectiveHeaders?.get(name);
    if (value) headers.set(name, value);
  }
  return { url: new URL(path, base.origin), headers };
}

function signalFor(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(PM_CONTEXT_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Resolves references through PM with the caller's credentials. Only IDs, titles,
 * revisions and short reasons come back; PM bodies are never fetched or stored.
 */
export async function resolvePmReferences(
  workspaceId: string,
  references: readonly PmReferenceInput[],
  requestHeaders?: Headers,
  signal?: AbortSignal,
): Promise<PmReferenceResolution[]> {
  if (references.length === 0) return [];
  const body = pmReferenceResolveRequestSchema.parse({ references: [...references] });
  const { url, headers } = await pmEndpoint(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agent-references/resolve`,
    requestHeaders,
  );
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      signal: signalFor(signal),
    });
  } catch {
    throw new DurableError(503, "pm_reference_unavailable", "无法连接 PM 核验引用，未接受本次请求。");
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403 || response.status === 404)
      throw new DurableError(403, "pm_reference_forbidden", "当前账号无权访问所选 PM 引用，未接受本次请求。");
    if (response.status >= 400 && response.status < 500)
      throw new DurableError(412, "pm_reference_invalid", "PM 拒绝了解析所选引用，未接受本次请求。");
    throw new DurableError(503, "pm_reference_unavailable", "PM 暂时无法核验引用，未接受本次请求。");
  }
  let resolved: { items: PmReferenceResolution[] };
  try {
    resolved = pmReferenceResolveResponseSchema.parse(await response.json());
  } catch {
    throw new DurableError(503, "pm_reference_unavailable", "PM 返回了无效的引用解析结果，未接受本次请求。");
  }
  const items = new Map(resolved.items.map((item) => [item.id, item]));
  return body.references.map((input) => {
    const item = items.get(input.id);
    if (!item || item.kind !== input.kind)
      throw new DurableError(412, "pm_reference_invalid", `PM 未返回引用 ${input.id} 的解析结果，未接受本次请求。`);
    return item;
  });
}

function assertReferenceUsable(item: PmReferenceResolution, context: boolean): void {
  if (item.availability === "forbidden")
    throw new DurableError(403, "pm_reference_forbidden", `引用 ${item.id} 当前不可访问，未接受本次请求。`);
  if (item.availability === "deleted")
    throw new DurableError(412, "pm_reference_unavailable", `引用 ${item.id} 已被归档或删除，未接受本次请求。`);
  if (context && item.availability !== "available")
    throw new DurableError(412, "pm_context_unavailable", `绑定的 PM 议题 ${item.id} 已变化，未接受本次更改。`);
  // A stale explicit reference is a deliberate pinned revision; it stays traceable.
}

/**
 * Validates a thread's PM issue binding against the authoritative core before it is
 * persisted. Access is re-checked on every later scope-sensitive operation.
 */
export async function resolvePmContextBinding(
  context: PmContext | null | undefined,
  scope: AgentScope | undefined,
  requestHeaders?: Headers,
  signal?: AbortSignal,
): Promise<PmContext | undefined> {
  const normalized = normalizedPmContext(context);
  if (!normalized) return undefined;
  if (!scope)
    throw new DurableError(412, "scope_required", "绑定 PM 议题需要工作区归属，请先选择工作区或项目。");
  const projectId = scope.projectId && projectIdPattern.test(scope.projectId) ? scope.projectId : null;
  const references: PmReferenceInput[] = [];
  if (normalized.taskId) references.push({ kind: "issue", id: normalized.taskId, projectId, revision: null });
  if (normalized.entityId && normalized.entityId !== normalized.taskId)
    references.push({ kind: referenceKind(normalized.entityId), id: normalized.entityId, projectId, revision: null });
  const items = await resolvePmReferences(scope.workspaceId, references, requestHeaders, signal);
  for (const item of items) assertReferenceUsable(item, true);
  return normalized;
}

/** Rejects acceptance of a submit whose explicit references are not accessible. */
export function assertResolvedReferences(items: readonly PmReferenceResolution[]): void {
  for (const item of items) assertReferenceUsable(item, false);
}

export function pmContextPromptLine(
  context: PmContext | undefined,
  references: readonly PmReferenceResolution[] | undefined,
): string | undefined {
  const binding = normalizedPmContext(context);
  if (!binding && !references?.length) return undefined;
  return `当前 PM 上下文（仅 ID、标题与修订，不含正文，也不授予额外权限）：${JSON.stringify({
    ...(binding ? { task: binding } : {}),
    references:
      references?.map((item) => ({
        kind: item.kind,
        id: item.id,
        projectId: item.projectId,
        title: item.title,
        revision: item.revision,
        availability: item.availability,
        reason: item.reason,
      })) ?? [],
  })}\nMarkdown 文件约定：work item 位于 .pm/core/work-items/<ID>.md，document 位于 .pm/core/docs/<ID>.md，project 位于 .pm/core/projects/<ID>.md。用户要求批量修改、执行 Issue 或写入评论/审阅意见时，直接在项目文件区域读取并编辑这些 Markdown 文件，保留 frontmatter、ID 和既有结构；原生状态转换、关系或数据库评论必须使用 PM 工具。不要把文件编辑或模型文字当作原生任务完成、审核或评论数据库写入的证明。`;
}
