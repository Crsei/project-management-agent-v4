import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError, type Actor } from '../../../../packages/domain/src/core.ts';
import { getMembership } from '../../../../packages/application/src/access.ts';
import {
  pmReferenceResolveRequestSchema,
  pmReferenceResolveResponseSchema,
  type PmReferenceInput,
  type PmReferenceKind,
  type PmReferenceResolution,
} from '../../../../packages/agent-contracts/src/pm-references.ts';
import type { FileRecord } from '../../../../packages/pm-schema/index.ts';
import { CoreScope, type CoreWorkspacePool } from './core-routes.ts';
import { mcpRequestIdentity, recheckMcpRequest } from '../../../../packages/application/src/mcp-service-auth.ts';

const params = z.strictObject({ workspaceId: z.uuid().toLowerCase() });

type ReferenceSource = { get(id: string): FileRecord };

const entityFor: Record<PmReferenceKind, FileRecord['entity']['entity']> = {
  issue: 'work_item',
  project: 'project',
  document: 'document',
};

function forbidden(input: PmReferenceInput, reason: string): PmReferenceResolution {
  return { kind: input.kind, id: input.id, workspaceId: input.workspaceId, projectId: input.projectId, title: '', revision: null, availability: 'forbidden', reason };
}

function readReference(workspace: ReferenceSource, id: string): FileRecord | null {
  try {
    return workspace.get(id);
  } catch {
    return null;
  }
}

/** Resolves pinned references against the authoritative Markdown core without distinguishing missing from unauthorized. */
export async function resolveReferences(
  references: readonly PmReferenceInput[],
  workspace: ReferenceSource,
  scope: CoreScope,
): Promise<PmReferenceResolution[]> {
  const items: PmReferenceResolution[] = [];
  for (const input of references) {
    const record = readReference(workspace, input.id);
    if (!record) {
      items.push(forbidden(input, 'The reference is unavailable or not accessible.'));
      continue;
    }
    const expected = entityFor[input.kind];
    if (record.entity.entity !== expected) {
      items.push(forbidden(input, 'The reference is unavailable or not accessible.'));
      continue;
    }
    try {
      scope.entity(record);
    } catch {
      items.push(forbidden(input, 'The reference is unavailable or not accessible.'));
      continue;
    }
    const projectId = input.kind === 'project' ? record.id : typeof record.entity.project === 'string' ? record.entity.project : null;
    if (input.projectId !== null && input.projectId !== projectId) {
      items.push(forbidden(input, 'The reference does not belong to the requested project.'));
      continue;
    }
    if (record.entity.archived === true) {
      items.push({ kind: input.kind, id: record.id, workspaceId: input.workspaceId, projectId, title: record.entity.title, revision: record.revision, availability: 'deleted', reason: 'The reference was archived.' });
      continue;
    }
    if (input.revision !== null && input.revision !== record.revision) {
      items.push({ kind: input.kind, id: record.id, workspaceId: input.workspaceId, projectId, title: record.entity.title, revision: record.revision, availability: 'stale', reason: 'The reference changed since the selected revision.' });
      continue;
    }
    items.push({ kind: input.kind, id: record.id, workspaceId: input.workspaceId, projectId, title: record.entity.title, revision: record.revision, availability: 'available', reason: null });
  }
  return items;
}

export function registerAgentReferenceRoutes(app: FastifyInstance, options: {
  database: () => Pool; actor: (request: FastifyRequest) => Promise<Actor>; coreWorkspaces: CoreWorkspacePool | undefined;
}): void {
  app.post('/api/v1/workspaces/:workspaceId/agent-references/resolve', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { workspaceId } = params.parse(request.params);
    const input = pmReferenceResolveRequestSchema.parse(request.body);
    if (input.references.some(reference => reference.workspaceId !== workspaceId)) throw new DomainError('agent_reference_target_mismatch', 'Every reference must match the URL workspace', 400);
    await recheckMcpRequest(options.database(), request);
    const member = await getMembership(options.database(), await options.actor(request), workspaceId);
    if (!member.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Capability domain.read is required', 403);
    if (!options.coreWorkspaces) throw new DomainError('backend_not_initialized', 'The Markdown core is unavailable', 503);
    const workspace = await options.coreWorkspaces.get(workspaceId);
    const delegation = mcpRequestIdentity(request);
    const effective = delegation?.scope.projectId
      ? { ...member, projectIds: member.projectIds === null || member.projectIds.includes(delegation.scope.projectId) ? [delegation.scope.projectId] : [] }
      : member;
    const result = pmReferenceResolveResponseSchema.parse({ items: await resolveReferences(input.references, workspace, new CoreScope(effective, workspaceId)) });
    await recheckMcpRequest(options.database(), request);
    return result;
  });
}
