import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError, type Actor } from '../../../../packages/domain/src/core.ts';
import { assertProjectScope, getMembership } from '../../../../packages/application/src/access.ts';
import { workflowFor, type Entity, type FileRecord } from '../../../../packages/pm-schema/index.ts';
import { CoreScope, type CoreWorkspacePool } from './core-routes.ts';

const workspaceParams = z.strictObject({ workspaceId: z.uuid().toLowerCase() });
const prioritySchema = z.enum(['low', 'medium', 'high', 'urgent']);
const querySchema = z.strictObject({
  q: z.string().max(500).optional(),
  projectId: z.string().min(1).max(80).optional(),
  status: z.string().min(1).max(120).optional(),
  assigneeId: z.string().min(1).max(200).optional(),
  after: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * The search response is a deliberately small DTO rather than a database aggregate: every field
 * mirrors the authoritative Markdown core, and `updatedAt` is the core `x-pm-updated-at` metadata
 * (null when the source carries no timestamp, because the core exposes no other clock).
 */
export const agentIssueSearchItemSchema = z.strictObject({
  id: z.string().min(1), title: z.string(), status: z.string().nullable(), priority: prioritySchema.nullable(),
  projectId: z.string().nullable(), assigneeId: z.string().nullable(), dueDate: z.string().nullable(),
  revision: z.string().min(1), updatedAt: z.string().min(1).nullable(),
});
export const agentIssueSearchPageSchema = z.strictObject({
  items: z.array(agentIssueSearchItemSchema), nextCursor: z.string().nullable(),
});
export type AgentIssueSearchItem = z.infer<typeof agentIssueSearchItemSchema>;
export type AgentIssueSearchPage = z.infer<typeof agentIssueSearchPageSchema>;

function toItem(record: FileRecord): AgentIssueSearchItem {
  const entity: Entity = record.entity;
  const updatedAt = entity['x-pm-updated-at'];
  return {
    id: record.id,
    title: entity.title,
    status: typeof entity.status === 'string' ? entity.status : null,
    priority: entity.priority ?? null,
    projectId: typeof entity.project === 'string' ? entity.project : null,
    assigneeId: typeof entity.assignee === 'string' ? entity.assignee : null,
    dueDate: typeof entity.due === 'string' ? entity.due : null,
    revision: record.revision,
    updatedAt: typeof updatedAt === 'string' && updatedAt ? updatedAt : null,
  };
}

/** Every request re-reads membership and the core projection; nothing is cached across requests. */
export function registerAgentIssueSearchRoutes(app: FastifyInstance, options: {
  database: () => Pool; actor: (request: FastifyRequest) => Promise<Actor>; coreWorkspaces: CoreWorkspacePool | undefined;
}): void {
  app.get('/api/v1/workspaces/:workspaceId/agent-issues', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { workspaceId } = workspaceParams.parse(request.params);
    const query = querySchema.parse(request.query);
    const q = query.q?.trim() || undefined;
    const actor = await options.actor(request);
    const member = await getMembership(options.database(), actor, workspaceId);
    if (!member.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Capability domain.read is required', 403);
    if (query.projectId !== undefined) assertProjectScope(member, query.projectId);
    if (!options.coreWorkspaces) throw new DomainError('backend_not_initialized', 'The Markdown core is unavailable', 503);
    const workspace = await options.coreWorkspaces.get(workspaceId), scope = new CoreScope(member, workspaceId);
    if (query.projectId && !workspace.items({ entity: 'project', archived: 'include' }).some(record => record.id === query.projectId && scope.allows(record))) {
      throw new DomainError('not_found_or_forbidden', 'Project is not accessible', 404);
    }
    const workflow = workflowFor('work_item', workspace.configuration().config);
    if (query.status && !workflow?.states.some(state => state.id === query.status))
      return agentIssueSearchPageSchema.parse({ items: [], nextCursor: null });
    const baseQuery = {
      entity: 'work_item' as const, archived: 'exclude' as const,
      ...(query.projectId ? { project: query.projectId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const records = new Map<string, FileRecord>();
    for (const record of workspace.items({ ...baseQuery, ...(q ? { q } : {}) })) records.set(record.id, record);
    if (q) {
      // The core search covers identifiers, titles and labels; prose is matched here so `q` also searches the body.
      const needle = q.toLowerCase();
      for (const record of workspace.items(baseQuery)) if (record.entity.body.toLowerCase().includes(needle)) records.set(record.id, record);
    }
    // Code-unit ID order keeps the stable cursor and the result sort permanently consistent.
    const matched = [...records.values()]
      .filter(record => scope.allows(record))
      .filter(record => query.assigneeId === undefined || record.entity.assignee === query.assigneeId)
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    const eligible = query.after === undefined ? matched : matched.filter(record => record.id > query.after!);
    const page = eligible.slice(0, query.limit);
    return agentIssueSearchPageSchema.parse({
      items: page.map(toItem),
      nextCursor: eligible.length > page.length ? page.at(-1)?.id ?? null : null,
    });
  });
}
