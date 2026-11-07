import { z } from "zod";
import {
  pmReferenceResolveRequestSchema,
  pmReferenceResolveResponseSchema,
  type PmReferenceInput,
  type PmReferenceResolution,
} from "@agent-workspace/contracts/pm-references";
import { pmAuthorizedOperationSchema, type PmAuthorizedOperation } from "@agent-workspace/contracts/pm-tools";
import { DurableError } from "./errors.ts";
import { mcpIdentityFromHeaders, mcpIdentityHeaders } from "../mcp/identity.ts";

const PM_CONTEXT_TIMEOUT_MS = 30_000;

/** Credentials remain request-local and may only cross the PM business boundary. */
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

async function pmPost(path: string, body: unknown, headers?: Headers, signal?: AbortSignal): Promise<unknown> {
  const endpoint = await pmEndpoint(path, headers);
  let response: Response;
  try {
    const timeout = AbortSignal.timeout(PM_CONTEXT_TIMEOUT_MS);
    response = await fetch(endpoint.url, {
      method: "POST", headers: endpoint.headers, body: JSON.stringify(body), redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    throw new DurableError(503, "pm_reference_unavailable", "无法连接 PM 核验引用，未接受本次请求。");
  }
  if (!response.ok) {
    await response.body?.cancel();
    if ([401, 403, 404].includes(response.status))
      throw new DurableError(403, "pm_reference_forbidden", "当前账号无权访问所选 PM 引用，未接受本次请求。");
    if (response.status < 500)
      throw new DurableError(412, "pm_reference_invalid", "PM 拒绝了解析所选引用，未接受本次请求。");
    throw new DurableError(503, "pm_reference_unavailable", "PM 暂时无法核验引用，未接受本次请求。");
  }
  try { return await response.json(); }
  catch { throw new DurableError(503, "pm_reference_unavailable", "PM 返回了无效的引用解析结果，未接受本次请求。"); }
}

/** No references means no PM request. Targets belong to individual messages, never their Session. */
export async function resolvePmReferences(
  references: readonly PmReferenceInput[], requestHeaders?: Headers, signal?: AbortSignal,
): Promise<PmReferenceResolution[]> {
  if (references.length === 0) return [];
  const body = pmReferenceResolveRequestSchema.parse({ references: [...references] });
  const groups = new Map<string, number[]>();
  for (let index = 0; index < body.references.length; index++) {
    const reference = body.references[index]!;
    const group = groups.get(reference.workspaceId);
    if (group) group.push(index); else groups.set(reference.workspaceId, [index]);
  }
  const items = new Array<PmReferenceResolution>(body.references.length);
  await Promise.all([...groups].map(async ([workspaceId, indices]) => {
    const parsed = pmReferenceResolveResponseSchema.safeParse(await pmPost(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agent-references/resolve`,
      { references: indices.map(index => body.references[index]!) }, requestHeaders, signal,
    ));
    if (!parsed.success)
      throw new DurableError(503, "pm_reference_unavailable", "PM 返回了无效的引用解析结果，未接受本次请求。");
    if (parsed.data.items.length !== indices.length)
      throw new DurableError(412, "pm_reference_invalid", "PM 返回了不匹配的引用数量，未接受本次请求。");
    for (let offset = 0; offset < indices.length; offset++) {
      const index = indices[offset]!, input = body.references[index]!, item = parsed.data.items[offset]!;
      if (item.workspaceId !== input.workspaceId || item.kind !== input.kind || item.id !== input.id ||
          input.projectId !== null && item.projectId !== input.projectId)
        throw new DurableError(412, "pm_reference_invalid", `PM 未返回引用 ${input.id} 的匹配目标解析结果，未接受本次请求。`);
      items[index] = item;
    }
  }));
  return items;
}

/** Produces actor evidence from PM's live authority endpoint, not from execution ownership. */
export async function resolvePmReferenceOperations(
  references: readonly PmReferenceInput[], requestHeaders?: Headers, signal?: AbortSignal,
): Promise<{ references: PmReferenceResolution[]; operations: PmAuthorizedOperation[] }> {
  const resolved = await resolvePmReferences(references, requestHeaders, signal);
  assertResolvedReferences(resolved);
  const targets = new Map<string, PmAuthorizedOperation["target"]>();
  for (const reference of resolved) {
    const target = { workspaceId: reference.workspaceId, projectId: reference.projectId };
    targets.set(JSON.stringify(target), target);
  }
  const operations = await Promise.all([...targets.values()].map(target => authorizePmTarget(target, requestHeaders, signal)));
  return { references: resolved, operations };
}

export async function authorizePmTarget(
  target: PmAuthorizedOperation["target"], requestHeaders?: Headers, signal?: AbortSignal,
): Promise<PmAuthorizedOperation> {
  const authorized = z.object({ actorId: z.uuid(), scope: z.object({ workspaceId: z.uuid(), projectId: z.string().nullable() }) }).safeParse(
    await pmPost("/api/v1/agent-contexts/authorize", target, requestHeaders, signal),
  );
  if (!authorized.success || authorized.data.scope.workspaceId !== target.workspaceId || authorized.data.scope.projectId !== target.projectId)
    throw new DurableError(503, "pm_reference_unavailable", "PM 返回了不匹配的引用授权结果，未接受本次请求。");
  return pmAuthorizedOperationSchema.parse({ actorId: authorized.data.actorId, target });
}

/** Rejects acceptance of a submit whose explicit references are not accessible. */
export function assertResolvedReferences(items: readonly PmReferenceResolution[]): void {
  for (const item of items) {
    if (item.availability === "forbidden")
      throw new DurableError(403, "pm_reference_forbidden", `引用 ${item.id} 当前不可访问，未接受本次请求。`);
    if (item.availability === "deleted")
      throw new DurableError(412, "pm_reference_unavailable", `引用 ${item.id} 已被归档或删除，未接受本次请求。`);
  }
}

export function pmContextPromptLine(references: readonly PmReferenceResolution[] | undefined): string | undefined {
  if (!references?.length) return undefined;
  return `显式 PM 引用（仅目标、ID、标题与修订，不含正文，也不授予额外权限）：${JSON.stringify(references.map(item => ({
    workspaceId: item.workspaceId, projectId: item.projectId, kind: item.kind, id: item.id,
    title: item.title, revision: item.revision, availability: item.availability, reason: item.reason,
  })))}\n使用 PM 工具读取或修改引用的明确 workspaceId/projectId 目标。代码目录与 PM 文档存储相互独立，不得假设代码目录包含 .pm/core。原生状态转换、关系或数据库评论必须使用相应 PM 工具；文件编辑或模型文字不是原生任务完成、审核或数据库写入的证明。`;
}
