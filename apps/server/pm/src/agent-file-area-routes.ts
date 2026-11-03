import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { listAgentContexts, resolveAgentContext, saveAgentFileArea, type AgentFileAreaContext } from '../../../../packages/application/src/agent-file-areas.ts';
import { agentStorageSettings, saveAgentStorageSettings, type AgentDirectoryConfiguration } from '../../../../packages/application/src/agent-storage.ts';
import { agentFileAreaUpdateSchema, agentScopeSchema, agentStorageSettingsUpdateSchema, type AgentScope } from '../../../../packages/contracts/src/agent-file-areas.ts';
import type { Actor } from '../../../../packages/domain/src/core.ts';
import { lockWorkspace } from '../../../../packages/infrastructure/src/database.ts';
import type { Workspace } from '../../../../packages/pm-core/index.ts';
import { getMembership } from '../../../../packages/application/src/access.ts';
import { mcpRequestIdentity, recheckMcpRequest } from '../../../../packages/application/src/mcp-service-auth.ts';

type RouteContext = { database: () => Pool; actor: (request: FastifyRequest) => Promise<Actor>; config: AgentDirectoryConfiguration; workspace: (workspaceId: string) => Promise<Workspace> };
const workspaceParams = agentScopeSchema.pick({ workspaceId: true });
const projectParams = agentScopeSchema.extend({ projectId: z.string().regex(/^PRJ-\d+$/) });

export function registerAgentFileAreaRoutes(app: FastifyInstance, options: RouteContext): void {
  async function inScope<T>(request: FastifyRequest, scope: AgentScope, operation: (context: AgentFileAreaContext) => Promise<T>): Promise<T> {
    const actor = await options.actor(request), sql = await options.database().connect();
    try {
      await sql.query('BEGIN'); await lockWorkspace(sql, scope.workspaceId);
      await recheckMcpRequest(sql, request);
      const result = await operation({ sql, actor, config: options.config, workspace: options.workspace });
      await recheckMcpRequest(sql, request);
      await sql.query('COMMIT');
      return result;
    } catch (error) { await sql.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { sql.release(); }
  }
  app.get('/api/v1/agent-contexts', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    z.strictObject({}).parse(request.query);
    const actor = await options.actor(request);
    const catalog = await listAgentContexts({ sql: options.database(), actor, config: options.config, workspace: options.workspace });
    const delegation = mcpRequestIdentity(request);
    const workspaces = await Promise.all(catalog.workspaces.filter(workspace => !delegation || workspace.id === delegation.scope.workspaceId).map(async workspace => {
      const member = await getMembership(options.database(), actor, workspace.id);
      const projectId = delegation?.scope.projectId;
      return { ...workspace, workspaceAllowed: member.projectIds === null && (!delegation || projectId === null),
        ...(delegation && projectId !== null ? { fileArea: { ...workspace.fileArea, path: null, canManage: false } } : {}),
        projects: workspace.projects.filter(project => !delegation || projectId === null || project.id === projectId) };
    }));
    await recheckMcpRequest(options.database(), request);
    return { workspaces };
  });
  app.get('/api/v1/workspaces/:workspaceId/agent-storage-settings', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    z.strictObject({}).parse(request.query);
    const { workspaceId } = workspaceParams.parse(request.params), actor = await options.actor(request);
    return agentStorageSettings(options.database(), actor, workspaceId, options.config);
  });
  app.put('/api/v1/workspaces/:workspaceId/agent-storage-settings', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    z.strictObject({}).parse(request.query);
    const scope = { ...workspaceParams.parse(request.params), projectId: null }, input = agentStorageSettingsUpdateSchema.parse(request.body);
    return inScope(request, scope, context => saveAgentStorageSettings(context.sql, context.actor, scope.workspaceId, context.config, input));
  });
  app.put('/api/v1/workspaces/:workspaceId/agent-file-area', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    z.strictObject({}).parse(request.query);
    const scope = { ...workspaceParams.parse(request.params), projectId: null }, input = agentFileAreaUpdateSchema.parse(request.body);
    return inScope(request, scope, context => saveAgentFileArea(context, scope, input));
  });
  app.put('/api/v1/workspaces/:workspaceId/projects/:projectId/agent-file-area', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    z.strictObject({}).parse(request.query);
    const scope = projectParams.parse(request.params), input = agentFileAreaUpdateSchema.parse(request.body);
    return inScope(request, scope, context => saveAgentFileArea(context, scope, input));
  });
  app.post('/api/v1/agent-contexts/resolve', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    z.strictObject({}).parse(request.query);
    const scope = agentScopeSchema.parse(request.body);
    return inScope(request, scope, async context => ({ ...await resolveAgentContext(context, scope), actorId: context.actor.id }));
  });
}
