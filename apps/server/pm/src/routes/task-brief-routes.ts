import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError, type Actor } from '../../../../../packages/domain/src/core.ts';
import type { FileRecord } from '../../../../../packages/pm-schema/index.ts';
import { readTaskBrief, searchTaskKnowledge, type TaskBriefContext } from '../../../../../packages/application/src/task-brief.ts';
import { taskBriefEntityIdSchema, taskBriefRevisionSchema, taskBriefStageSchema, taskBriefQuerySchema, taskKnowledgeQuerySchema } from '../../../../../packages/agent-contracts/src/task-brief.ts';
import { authorizeCoreScope, type CoreWorkspacePool } from './core-routes.ts';

type Options = { database: () => Pool; actor: (request: FastifyRequest) => Promise<Actor>; coreWorkspaces: CoreWorkspacePool | undefined };
const params = z.strictObject({ workspaceId: z.uuid().toLowerCase(), projectId: taskBriefEntityIdSchema, taskId: taskBriefEntityIdSchema });
const briefHttpQuery = z.strictObject({ revision: taskBriefRevisionSchema, stage: taskBriefStageSchema,
  bodyOffset: z.coerce.number().int().min(0).max(4000000).optional(), bodyLimit: z.coerce.number().int().min(1).max(48000).optional() });
const knowledgeHttpQuery = z.strictObject({ revision: taskBriefRevisionSchema, query: z.string().trim().min(1).max(500),
  projectIds: z.string().min(1).max(1700).transform(value => value.split(',')).pipe(z.array(taskBriefEntityIdSchema).min(1).max(20)).optional(),
  limit: z.coerce.number().int().min(1).max(20).optional(), cursor: z.string().min(1).max(2048).optional() });

/** A fresh current authorization and Markdown snapshot for both HTTP and existing PM tools. Frozen tool project grants can only narrow this scope. */
export async function taskBriefReadContext(options: Pick<Options, 'database' | 'coreWorkspaces'>, actor: Actor, workspaceId: string, allowedProjects?: readonly string[], includeRelations = true): Promise<TaskBriefContext & { snapshotComplete: boolean }> {
  const scope = await authorizeCoreScope(options.database(), actor, workspaceId, 'domain.read');
  if (!options.coreWorkspaces) throw new DomainError('backend_not_initialized', 'The Markdown core is unavailable', 503);
  const workspace = await options.coreWorkspaces.get(workspaceId);
  // Recheck after asynchronous source refresh: a pre-refresh membership is not a retained read grant.
  const current = await authorizeCoreScope(options.database(), actor, workspaceId, 'domain.read');
  const snapshot = workspace.snapshot();
  const visible = (record: FileRecord) => {
    const projectId = record.entity.entity === 'project' ? record.id : record.entity.project;
    return scope.allows(record) && current.allows(record) && typeof projectId === 'string' && (!allowedProjects || allowedProjects.includes(projectId));
  };
  return { workspaceId, authorizationKey: JSON.stringify([actor.id, current.membership.version, current.membership.projectIds, current.membership.capabilities, allowedProjects ?? null]),
    snapshotComplete: !snapshot.errors.some(issue => issue.severity === 'error') && !snapshot.configurationErrors.some(issue => issue.severity === 'error') && snapshot.unsupportedFiles.length === 0,
    records: snapshot.files.filter(visible), relations: includeRelations ? workspace.graph({ archived: 'include' }, visible).links : [] };
}

export function registerTaskBriefRoutes(app: FastifyInstance, options: Options): void {
  const base = '/api/v1/workspaces/:workspaceId/projects/:projectId/tasks/:taskId';
  app.get(`${base}/brief`, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const { workspaceId, projectId, taskId } = params.parse(request.params);
    const query = taskBriefQuerySchema.parse(briefHttpQuery.parse(request.query));
    const actor = await options.actor(request), context = await taskBriefReadContext(options, actor, workspaceId);
    return readTaskBrief(context, projectId, taskId, query);
  });
  app.get(`${base}/knowledge`, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const { workspaceId, projectId, taskId } = params.parse(request.params);
    const query = taskKnowledgeQuerySchema.parse(knowledgeHttpQuery.parse(request.query));
    const actor = await options.actor(request), context = await taskBriefReadContext(options, actor, workspaceId, undefined, false);
    return searchTaskKnowledge(context, projectId, taskId, query);
  });
}
