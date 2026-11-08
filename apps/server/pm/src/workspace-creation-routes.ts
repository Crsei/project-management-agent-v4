import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Actor } from '../../../../packages/domain/src/core.ts';
import { listWorkspaces } from '../../../../packages/application/src/queries.ts';
import { assertWorkspaceCreationActor, createWorkspaceWithNova } from '../../../../packages/application/src/workspace-creation.ts';
import { initializeNovaWorkspaceSample, readWorkspaceCreation, resumeActorWorkspaceSamples, type WorkspaceSampleOptions } from '../../../../packages/application/src/workspace-samples.ts';
import type { WorkspaceInitialization } from '../../../../packages/contracts/src/workspace-creation.ts';
import { workspaceCreationKeySchema, workspaceCreationRequestSchema, workspaceCreationRecoveryRequestSchema } from '../../../../packages/contracts/src/workspace-creation.ts';

export function registerWorkspaceCreationRoutes(app: FastifyInstance, options: { database: () => Pool; actor: (request: FastifyRequest) => Promise<Actor>; sample: WorkspaceSampleOptions }): void {
  const resuming = new Map<string, Promise<void>>();
  app.get('/api/v1/workspaces', async (request, reply) => {
    z.strictObject({}).parse(request.query);
    reply.header('Cache-Control', 'private, no-store');
    const actor = await options.actor(request);
    let pending = resuming.get(actor.id);
    if (!pending) {
      pending = resumeActorWorkspaceSamples(options.database(), actor, options.sample).finally(() => { resuming.delete(actor.id); });
      resuming.set(actor.id, pending);
    }
    await pending;
    const pendingRows = await options.database().query<{ workspace_id: string; workspace_name: string; request_key: string | null }>("SELECT s.workspace_id,s.workspace_name,CASE WHEN s.actor_id=$1 THEN s.request_key ELSE NULL END AS request_key FROM workspace_sample_initializations s JOIN memberships m ON m.workspace_id=s.workspace_id AND m.user_id=$1 AND m.revoked_at IS NULL JOIN users u ON u.id=m.user_id AND u.disabled_at IS NULL WHERE s.status='pending' ORDER BY s.created_at", [actor.id]);
    const pendingInitializations: WorkspaceInitialization[] = pendingRows.rows.map(row => ({ workspaceId: row.workspace_id, name: row.workspace_name, key: row.request_key }));
    const pendingIds = new Set(pendingInitializations.map(row => row.workspaceId));
    return { items: (await listWorkspaces(options.database(), actor)).filter(workspace => !pendingIds.has(workspace.id)), pendingInitializations };
  });
  app.post('/api/v1/workspaces', { bodyLimit: 4096 }, async (request, reply) => {
    z.strictObject({}).parse(request.query);
    reply.header('Cache-Control', 'private, no-store');
    const key = workspaceCreationKeySchema.parse(request.headers['idempotency-key']);
    return createWorkspaceWithNova(options.database(), await options.actor(request), workspaceCreationRequestSchema.parse(request.body), key, options.sample);
  });
  app.get('/api/v1/workspace-creations/:key', async (request, reply) => {
    z.strictObject({}).parse(request.query);
    reply.header('Cache-Control', 'private, no-store');
    const { key } = z.strictObject({ key: workspaceCreationKeySchema }).parse(request.params);
    return readWorkspaceCreation(options.database(), await options.actor(request), key);
  });
  app.post('/api/v1/workspace-creations/:key/recover', async (request, reply) => {
    z.strictObject({}).parse(request.query);
    const body = workspaceCreationRecoveryRequestSchema.parse(request.body);
    reply.header('Cache-Control', 'private, no-store');
    const { key } = z.strictObject({ key: workspaceCreationKeySchema }).parse(request.params);
    const actor = await options.actor(request);
    assertWorkspaceCreationActor(actor, body.expectedActorId);
    const original = await readWorkspaceCreation(options.database(), actor, key);
    if (original.status !== 'pending') return original;
    await initializeNovaWorkspaceSample(options.database(), original.workspaceId, options.sample);
    return readWorkspaceCreation(options.database(), actor, key);
  });
}
