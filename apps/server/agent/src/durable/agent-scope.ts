import path from "node:path";
import { z } from "zod";
import { agentScopeSchema, type AgentScope } from "@agent-workspace/contracts/chat";
import { DurableError } from "./errors.ts";
import { mcpIdentityFromHeaders, mcpIdentityHeaders } from "../mcp/identity.ts";

export type AgentExecutionSnapshot = {
  /** Resolved by PM, never inferred from a local thread or credentials. Legacy snapshots may lack it. */
  actorId?: string;
  scope: AgentScope;
  workspaceName: string;
  projectName: string | null;
  path: string;
  /** Only a verified, server-owned delivery receipt can supply this grant. */
  worktreeWriteConfirmed?: boolean;
};
export const sameAgentScope = (a: AgentScope | undefined, b: AgentScope | undefined): boolean =>
  a?.workspaceId === b?.workspaceId && a?.projectId === b?.projectId;

const resolvedScopeSchema = z.object({
  actorId: z.uuid().optional(),
  scope: agentScopeSchema,
  workspaceName: z.string(),
  projectName: z.string().nullable(),
  path: z.string().min(1).refine((value) => path.isAbsolute(value) && !value.includes("\0")),
});

/** Credentials are request-local: never persist them with a thread or generation. */
export async function resolveAgentScope(
  scope: AgentScope | undefined,
  requestHeaders?: Headers,
  signal?: AbortSignal,
): Promise<AgentExecutionSnapshot> {
  if (!scope)
    throw new DurableError(412, "scope_required", "历史会话没有工作区归属；请先选择工作区或项目并新建会话。");
  let endpoint: URL;
  try {
    const base = new URL(process.env.PM_API_URL?.trim() || "http://127.0.0.1:4194");
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password)
      throw new Error("Invalid PM origin");
    endpoint = new URL("/api/v1/agent-contexts/resolve", base.origin);
  } catch {
    throw new DurableError(503, "scope_unavailable", "PM API 地址配置无效。");
  }
  // Only a server-issued delegation is renewed here. The public OAuth bearer
  // never enters ordinary Chat routes; every renewal checks its original grant.
  let effectiveHeaders = requestHeaders;
  if (requestHeaders?.get("authorization")?.startsWith("Bearer pm-mcp-service-v1.")) {
    const identity = await mcpIdentityFromHeaders(requestHeaders);
    if (!identity) throw new DurableError(403, "mcp_grant_revoked", "原 MCP 委托已失效，拒绝继续执行。");
    effectiveHeaders = await mcpIdentityHeaders(identity);
  }
  const headers = new Headers({ "content-type": "application/json" });
  for (const name of ["cookie", "authorization"]) {
    const value = effectiveHeaders?.get(name);
    if (value) headers.set(name, value);
  }
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(scope),
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
  } catch {
    throw new DurableError(503, "scope_unavailable", "无法连接 PM，未接受本次执行。");
  }
  if (!response.ok) {
    const status = response.status === 401 || response.status === 403 || response.status === 404
      ? response.status
      : response.status >= 500 ? 503 : 412;
    throw new DurableError(status, "scope_unavailable", "无法解析当前文件区域，请检查 PM 登录、访问范围与目录配置。");
  }
  let resolved: AgentExecutionSnapshot;
  try {
    resolved = resolvedScopeSchema.parse(await response.json());
  } catch {
    throw new DurableError(503, "scope_unavailable", "PM 返回了无效的文件区域，未接受本次执行。");
  }
  if (!sameAgentScope(scope, resolved.scope))
    throw new DurableError(409, "scope_conflict", "PM 返回的文件区域归属与会话不一致。");
  return resolved;
}

export function agentContextIdentity(snapshot: AgentExecutionSnapshot): string {
  return `当前 PM 上下文身份（仅标识会话归属，不授予额外权限）：${JSON.stringify({
    workspaceId: snapshot.scope.workspaceId,
    workspaceName: snapshot.workspaceName,
    projectId: snapshot.scope.projectId,
    projectName: snapshot.projectName,
  })}`;
}
