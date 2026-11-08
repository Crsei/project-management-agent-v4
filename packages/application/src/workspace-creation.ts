import type { Pool } from 'pg';
import { DomainError, type Actor } from '../../domain/src/core.ts';
import { createWorkspace } from '../../infrastructure/src/auth.ts';
import { workspaceCreationKeySchema, workspaceCreationRequestSchema, type WorkspaceCreationResult } from '../../contracts/src/workspace-creation.ts';
import { initializeNovaWorkspaceSample, queueNovaWorkspaceSample, queueWorkspaceWithoutSample, readWorkspaceCreation, type WorkspaceSampleOptions } from './workspace-samples.ts';

/** A captured creation intent cannot be executed as another authenticated account. */
export function assertWorkspaceCreationActor(actor: Actor, expectedActorId: string): void {
  if (actor.id !== expectedActorId) throw new DomainError('session_changed', 'The authenticated account changed. No workspace change was performed; retain and reconcile the original creation request.', 409);
}

type CreationRecord = { workspace_id: string; workspace_name: string; sample_skipped: boolean };

/** The request key is the idempotency boundary for both modes: an original
 * no-sample creation is already complete, while an original sample creation is
 * always resumed even if a retry omits or flips the optional flag. */
export async function createWorkspaceFromRequest(pool: Pool, actor: Actor, input: unknown, requestKey: string, options: WorkspaceSampleOptions): Promise<WorkspaceCreationResult> {
  const body = workspaceCreationRequestSchema.parse(input);
  assertWorkspaceCreationActor(actor, body.expectedActorId);
  const key = workspaceCreationKeySchema.parse(requestKey);
  const includeSample = body.includeSample !== false;
  let original = (await pool.query<CreationRecord>('SELECT workspace_id,workspace_name,sample_skipped FROM workspace_sample_initializations WHERE actor_id=$1 AND request_key=$2', [actor.id, key])).rows[0];
  if (!original) {
    try {
      const workspace = await createWorkspace(pool, actor.id, body.name, {
        prepare: includeSample
          ? (sql, created) => queueNovaWorkspaceSample(sql, created.id, actor.id, created.name, options, key)
          : (sql, created) => queueWorkspaceWithoutSample(sql, created.id, actor.id, created.name, key),
      });
      original = { workspace_id: workspace.id, workspace_name: workspace.name, sample_skipped: !includeSample };
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === '23505')) throw error;
      // A competing original-key request may have committed. No second workspace
      // survives the losing transaction, and no filesystem work preceded commit.
      original = (await pool.query<CreationRecord>('SELECT workspace_id,workspace_name,sample_skipped FROM workspace_sample_initializations WHERE actor_id=$1 AND request_key=$2', [actor.id, key])).rows[0];
      if (!original) throw error;
    }
  }
  if (original.workspace_name !== body.name) throw new DomainError('idempotency_conflict', 'The workspace request key belongs to a different name; reconcile the original request', 409);
  const outcome = await readWorkspaceCreation(pool, actor, key);
  if (outcome.status === 'ready' || original.sample_skipped) return outcome;
  await initializeNovaWorkspaceSample(pool, original.workspace_id, options);
  return readWorkspaceCreation(pool, actor, key);
}
