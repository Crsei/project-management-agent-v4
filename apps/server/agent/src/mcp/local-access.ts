import { randomUUID } from "node:crypto";
import { z } from "zod";
import { agentCatalogSchema, type AgentCatalog } from "../../../../../packages/contracts/src/agent-file-areas.ts";
import type { McpInvocationIdentity } from "../../../../../packages/infrastructure/src/mcp-service-auth.ts";
import { deleteRecord, listRecords, readRecord, transaction, writeRecord } from "../durable/store.ts";
import { currentGrant, digest, grantIdentity, MCP_GRANTS, McpAuthError, putGrant, type Grant } from "./grants.ts";
import { mcpIdentityHeaders, mcpPublicOrigin, pmRequest } from "./identity.ts";

/**
 * Local Agent access is a standing, loopback-only binding to the PM account that enabled it.
 * It creates one ordinary workspace/project grant per authorized target so every PM call still
 * travels through the same signed delegation and live PM membership checks. No OAuth code,
 * PKCE verifier or bearer token is exchanged for this path.
 */
export const MCP_LOCAL = "mcp:local";
const bindingKey = "binding";
const localProjectId = z.string().regex(/^PRJ-\d+$/);
export const localGrantRefSchema = z.strictObject({
  workspaceId: z.uuid(),
  projectId: localProjectId.nullable(),
  grantId: z.uuid(),
  grantVersion: z.number().int().positive(),
});
export type LocalGrantRef = z.infer<typeof localGrantRefSchema>;
export const localBindingSchema = z.strictObject({
  bindingId: z.uuid(),
  actorId: z.uuid(),
  actorName: z.string().min(1).max(256),
  version: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  grants: z.array(localGrantRefSchema).max(1000),
  catalog: z.object({
    workspaces: z.array(z.object({
      id: z.uuid(),
      name: z.string(),
      workspaceAllowed: z.boolean(),
      projects: z.array(z.object({ id: localProjectId, name: z.string() })),
    })),
  }),
});
export type LocalMcpBinding = z.infer<typeof localBindingSchema>;
export type LocalMcpContext = {
  local: { bindingId: string; actorId: string; actorName: string; version: number; grants: LocalGrantRef[] };
};
export type McpToolIdentity = McpInvocationIdentity | LocalMcpContext;
export function isLocalMcpContext(identity: McpToolIdentity): identity is LocalMcpContext {
  return "local" in identity;
}
export function localAccessAvailable(): boolean {
  if (process.env.MCP_LOCAL_ACCESS === "0") return false;
  try {
    const origin = new URL(mcpPublicOrigin());
    return ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) && origin.protocol === "http:";
  } catch {
    return false;
  }
}
export function localMcpEndpoint(): string {
  return `${mcpPublicOrigin()}/mcp`;
}
export function readLocalBinding(): LocalMcpBinding | undefined {
  const value = readRecord<unknown>(MCP_LOCAL, bindingKey);
  if (value === undefined) return undefined;
  const parsed = localBindingSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
function writeLocalBinding(binding: LocalMcpBinding): void {
  writeRecord(MCP_LOCAL, bindingKey, binding);
}
export function localContext(binding: LocalMcpBinding): LocalMcpContext {
  return {
    local: {
      bindingId: binding.bindingId,
      actorId: binding.actorId,
      actorName: binding.actorName,
      version: binding.version,
      grants: binding.grants.map(ref => ({ ...ref })),
    },
  };
}
/** The request never supplies the actor; it comes from the stored binding. */
export function assertLocalMcpRequest(request: Request): void {
  if (!localAccessAvailable()) throw new McpAuthError("not_found", "Local MCP access is not enabled for this deployment.", 404);
  const origin = new URL(mcpPublicOrigin());
  const host = request.headers.get("host")?.toLowerCase();
  if (!host || host !== origin.host.toLowerCase())
    throw new McpAuthError("access_denied", "Local MCP access requires the configured loopback Host.", 403);
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin !== null && requestOrigin !== origin.origin)
    throw new McpAuthError("access_denied", "Local MCP access requires a same-origin request.", 403);
  if (request.headers.get("sec-fetch-site") === "cross-site")
    throw new McpAuthError("access_denied", "Cross-site local MCP access is not allowed.", 403);
}
export function authenticateLocalMcpRequest(request: Request): LocalMcpContext {
  assertLocalMcpRequest(request);
  const binding = readLocalBinding();
  if (!binding) throw new McpAuthError("login_required", "Enable local Agent access in MCP settings with a PM login first.", 401);
  return localContext(binding);
}
export async function assertLocalContext(context: LocalMcpContext): Promise<LocalMcpBinding> {
  if (!localAccessAvailable()) throw new McpAuthError("not_found", "Local MCP access is not enabled for this deployment.", 404);
  const binding = readLocalBinding();
  if (!binding || binding.bindingId !== context.local.bindingId || binding.actorId !== context.local.actorId || binding.version !== context.local.version)
    throw new McpAuthError("invalid_token", "Local MCP access was changed or disabled.", 401);
  return binding;
}
export function localScopedIdentity(context: LocalMcpContext, ref: LocalGrantRef): McpInvocationIdentity {
  const grant = readRecord<Grant>(MCP_GRANTS, ref.grantId);
  if (!grant || grant.origin !== "local" || grant.actorId !== context.local.actorId || grant.localBindingId !== context.local.bindingId ||
      grant.scope.workspaceId !== ref.workspaceId || grant.scope.projectId !== ref.projectId || grant.version !== ref.grantVersion)
    throw new McpAuthError("invalid_token", "Local MCP grant is no longer available.", 401);
  return grantIdentity(currentGrant({ grantId: grant.grantId, actorId: grant.actorId, scope: grant.scope, access: grant.access, version: grant.version }));
}
export function localIdentityForTarget(context: LocalMcpContext, target: { workspaceId: string; projectId: string | null }): McpInvocationIdentity {
  const candidates = context.local.grants.filter(ref => ref.workspaceId === target.workspaceId);
  const ref = target.projectId === null
    ? candidates.find(item => item.projectId === null)
    : candidates.find(item => item.projectId === target.projectId) ?? candidates.find(item => item.projectId === null);
  if (!ref) throw new McpAuthError("insufficient_scope", "The PM target is outside the enabled local Agent access.", 403);
  return localScopedIdentity(context, ref);
}
async function localGrantCatalog(context: LocalMcpContext, ref: LocalGrantRef): Promise<AgentCatalog> {
  const identity = localScopedIdentity(context, ref);
  const headers = await mcpIdentityHeaders(identity);
  return agentCatalogSchema.parse(await pmRequest("/api/v1/agent-contexts", headers));
}
/**
 * Live catalog across every enabled target. A workspace-wide grant supersedes project grants
 * for the same workspace; failures for one revoked target do not hide the remaining targets.
 */
export async function localCatalog(context: LocalMcpContext): Promise<AgentCatalog> {
  await assertLocalContext(context);
  const workspaceWide = new Set(context.local.grants.filter(ref => ref.projectId === null).map(ref => ref.workspaceId));
  const refs = context.local.grants.filter(ref => ref.projectId === null || !workspaceWide.has(ref.workspaceId));
  const workspaces = new Map<string, AgentCatalog["workspaces"][number]>();
  let lastError: unknown;
  for (const ref of refs) {
    try {
      const value = await localGrantCatalog(context, ref);
      for (const workspace of value.workspaces) {
        const existing = workspaces.get(workspace.id);
        if (!existing) {
          workspaces.set(workspace.id, { ...workspace, projects: [...workspace.projects] });
          continue;
        }
        existing.workspaceAllowed = existing.workspaceAllowed === true || workspace.workspaceAllowed === true;
        const projects = new Map(existing.projects.map(project => [project.id, project]));
        for (const project of workspace.projects) projects.set(project.id, project);
        existing.projects = [...projects.values()];
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (!workspaces.size) {
    if (lastError instanceof McpAuthError) throw lastError;
    throw new McpAuthError("access_denied", "No enabled PM workspace or project is currently authorized.", 403);
  }
  return { workspaces: [...workspaces.values()] };
}
export type LocalEnableInput = { actorId: string; actorName?: string; headers: Headers };
/** PM browser session supplies the full current catalog; the Agent never guesses or shares workspaces. */
export async function enableLocalAccess(input: LocalEnableInput): Promise<LocalMcpBinding> {
  if (!localAccessAvailable()) throw new McpAuthError("not_found", "Local MCP access requires a loopback MCP_PUBLIC_ORIGIN.", 404);
  const catalog = agentCatalogSchema.parse(await pmRequest("/api/v1/agent-contexts", input.headers));
  const existing = readLocalBinding();
  if (existing && existing.actorId !== input.actorId)
    throw new McpAuthError("access_denied", "Local Agent access is already enabled for another PM account. Sign in as that account to disable it first.", 409);
  const targets: { workspaceId: string; projectId: string | null }[] = [];
  for (const workspace of catalog.workspaces) {
    if (workspace.workspaceAllowed === true) targets.push({ workspaceId: workspace.id, projectId: null });
    else for (const project of workspace.projects) targets.push({ workspaceId: workspace.id, projectId: project.id });
  }
  if (!targets.length) throw new McpAuthError("access_denied", "The PM account has no authorized workspace or project to expose.", 403);
  if (targets.length > 1000) throw new McpAuthError("temporarily_unavailable", "Too many PM targets to enable local access at once.", 503);
  const now = new Date().toISOString();
  const bindingId = existing?.bindingId ?? randomUUID();
  const version = (existing?.version ?? 0) + 1;
  const reusable = new Map((existing?.grants ?? []).map(ref => [`${ref.workspaceId}:${ref.projectId ?? "*"}`, ref]));
  const audience = `${mcpPublicOrigin()}/mcp`;
  const nextRefs: LocalGrantRef[] = [];
  transaction(() => {
    for (const target of targets) {
      const key = `${target.workspaceId}:${target.projectId ?? "*"}`;
      const prior = reusable.get(key);
      const priorGrant = prior ? readRecord<Grant>(MCP_GRANTS, prior.grantId) : undefined;
      if (prior && priorGrant && !priorGrant.revokedAt && priorGrant.actorId === input.actorId && priorGrant.localBindingId === bindingId && priorGrant.audience === audience) {
        nextRefs.push({ ...prior });
        reusable.delete(key);
        continue;
      }
      const grant: Grant = {
        grantId: randomUUID(), actorId: input.actorId, scope: { ...target }, access: "full", threadIds: [],
        version: 1, clientHash: digest(`local:${bindingId}`), clientName: "Local Agent", audience,
        createdAt: now, expiresAt: "9999-12-31T23:59:59.999Z", revokedAt: null,
        origin: "local", localBindingId: bindingId,
      };
      putGrant(grant);
      nextRefs.push({ workspaceId: target.workspaceId, projectId: target.projectId, grantId: grant.grantId, grantVersion: grant.version });
    }
    for (const stale of reusable.values()) deleteRecord(MCP_GRANTS, stale.grantId);
    // A crashed enable can leave grants without a binding; only one local binding may exist.
    for (const grant of listRecords<Grant>(MCP_GRANTS)) {
      if (grant.origin === "local" && grant.localBindingId !== bindingId) deleteRecord(MCP_GRANTS, grant.grantId);
    }
    const binding: LocalMcpBinding = {
      bindingId, actorId: input.actorId, actorName: (input.actorName ?? "PM account").slice(0, 256),
      version, createdAt: existing?.createdAt ?? now, updatedAt: now, grants: nextRefs,
      catalog: {
        workspaces: catalog.workspaces.map(workspace => ({
          id: workspace.id, name: workspace.name, workspaceAllowed: workspace.workspaceAllowed === true,
          projects: workspace.projects.map(project => ({ id: project.id, name: project.name })),
        })),
      },
    };
    writeLocalBinding(binding);
  });
  return readLocalBinding()!;
}
/** Disabling removes the standing grants; existing operation records remain historical and unreadable. */
export function disableLocalAccess(actorId: string): boolean {
  const binding = readLocalBinding();
  if (!binding) return false;
  if (binding.actorId !== actorId) throw new McpAuthError("access_denied", "Only the PM account that enabled local Agent access can disable it.", 403);
  transaction(() => {
    for (const grant of listRecords<Grant>(MCP_GRANTS)) {
      if (grant.origin === "local") deleteRecord(MCP_GRANTS, grant.grantId);
    }
    deleteRecord(MCP_LOCAL, bindingKey);
  });
  return true;
}
