import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError, type Actor } from '../../../../packages/domain/src/core.ts';
import { getMembership, type Membership } from '../../../../packages/application/src/access.ts';
import { pmToolCapabilitiesSchema, type PmToolCapabilities } from '../../../../packages/agent-contracts/src/pm-capabilities.ts';
import { CoreScope, type CoreWorkspacePool } from './core-routes.ts';
import type { AgentChatTools } from './agent-chat-tools.ts';

const workspaceIdSchema = z.uuid().toLowerCase();
const projectIdSchema = z.string().regex(/^PRJ-\d+$/, 'Expected a stable project ID such as PRJ-101');
const capabilityQuerySchema = z.object({ projectId: projectIdSchema.optional() });

/** Stable, client-facing reasons; never derived from the current tool description. */
const CAPABILITY_REQUIRED = 'capability_required';
const TOOL_UNAVAILABLE = 'tool_unavailable';
const WORKSPACE_SCOPE_REQUIRED = 'workspace_scope_required';
const PROJECT_SCOPE_REQUIRED = 'project_scope_required';

/**
 * Capability advertisement for Agent Chat. Every request re-reads current membership and the
 * authoritative project projection; nothing is cached across requests.
 */
export function registerAgentCapabilityRoutes(app: FastifyInstance, options: {
  database: () => Pool; actor: (request: FastifyRequest) => Promise<Actor>;
  coreWorkspaces: CoreWorkspacePool | undefined; tools: AgentChatTools | undefined;
}): void {
  async function requireTools(): Promise<{ tools: AgentChatTools; coreWorkspaces: CoreWorkspacePool }> {
    if (!options.tools || !options.coreWorkspaces) throw new DomainError('backend_not_initialized', 'The Markdown core is unavailable', 503);
    return { tools: options.tools, coreWorkspaces: options.coreWorkspaces };
  }

  async function authorizeScope(actor: Actor, workspaceId: string, projectId: string | undefined, coreWorkspaces: CoreWorkspacePool): Promise<{ member: Membership; scope: PmToolCapabilities['scope'] }> {
    const member = await getMembership(options.database(), actor, workspaceId);
    if (!member.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Capability domain.read is required', 403);
    if (!projectId) {
      if (member.projectIds !== null) throw new DomainError(WORKSPACE_SCOPE_REQUIRED, 'Workspace-wide scope requires unrestricted project access', 403);
      return { member, scope: { kind: 'workspace', projectIds: [] } };
    }
    if (member.projectIds !== null && !member.projectIds.includes(projectId)) {
      throw new DomainError('not_found_or_forbidden', 'Project is not accessible', 404);
    }
    const coreScope = new CoreScope(member, workspaceId);
    const workspace = await coreWorkspaces.get(workspaceId);
    const project = workspace.items({ entity: 'project', archived: 'exclude' })
      .find(record => record.id === projectId && coreScope.allows(record) && !record.stale && !record.error);
    if (!project) throw new DomainError('not_found_or_forbidden', 'Project is not accessible', 404);
    return { member, scope: { kind: 'projects', projectIds: [project.id] } };
  }

  app.get('/api/v1/workspaces/:workspaceId/agent-capabilities', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const { workspaceId } = z.object({ workspaceId: workspaceIdSchema }).parse(request.params);
    const { projectId } = capabilityQuerySchema.parse(request.query);
    const actor = await options.actor(request);
    const { tools, coreWorkspaces } = await requireTools();
    const { member, scope } = await authorizeScope(actor, workspaceId, projectId, coreWorkspaces);
    const capabilities: PmToolCapabilities = {
      scope,
      tools: tools.registry.map(tool => {
        const missing = tool.capabilities.some(capability => !member.capabilities.includes(capability));
        let denyReason: string | null = null;
        if (missing) denyReason = CAPABILITY_REQUIRED;
        else if (!tool.available) denyReason = tool.denyReason ?? TOOL_UNAVAILABLE;
        else if (tool.name === 'pm_create_project' && scope.kind !== 'workspace') denyReason = WORKSPACE_SCOPE_REQUIRED;
        else if (tool.write && tool.name !== 'pm_create_project' && scope.kind !== 'projects') denyReason = PROJECT_SCOPE_REQUIRED;
        return {
          name: tool.name, description: tool.description, write: tool.write,
          capabilities: [...tool.capabilities], allowed: denyReason === null, denyReason,
        };
      }),
    };
    return pmToolCapabilitiesSchema.parse(capabilities);
  });
}
