import type { Pool, PoolClient } from 'pg';
import { DomainError, type Actor } from '../../domain/src/core.ts';
import { updateOnboardingRequestSchema, type OnboardingState } from '../../contracts/src/onboarding.ts';

type Row = { id: string; onboarding_revision: number; workspace_id: string | null; onboarding_profile: OnboardingState['profile']; onboarding_ai: OnboardingState['ai']; onboarding_completed_at: Date | null; onboarding_checklist_dismissed: boolean };
const stateQuery = `SELECT u.id,u.onboarding_revision,
  CASE WHEN EXISTS (SELECT 1 FROM memberships m JOIN workspaces w ON w.id=m.workspace_id
    WHERE m.user_id=u.id AND m.workspace_id=u.onboarding_workspace_id AND m.revoked_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM workspace_sample_initializations s WHERE s.workspace_id=w.id AND s.status='pending'))
    THEN u.onboarding_workspace_id ELSE NULL END AS workspace_id,
  u.onboarding_profile,u.onboarding_ai,u.onboarding_completed_at,u.onboarding_checklist_dismissed
  FROM users u WHERE u.id=$1 AND u.disabled_at IS NULL`;
function toState(row: Row): OnboardingState {
  return { actorId: row.id, revision: row.onboarding_revision, workspaceId: row.workspace_id, profile: row.onboarding_profile, ai: row.onboarding_ai, completedAt: row.onboarding_completed_at?.toISOString() ?? null, checklistDismissed: row.onboarding_checklist_dismissed };
}
async function read(sql: Pool | PoolClient, actor: Actor): Promise<OnboardingState> {
  const row = (await sql.query<Row>(stateQuery, [actor.id])).rows[0];
  if (!row) throw new DomainError('unauthorized', 'Account unavailable', 401);
  return toState(row);
}
export async function getOnboarding(pool: Pool, actor: Actor): Promise<OnboardingState> { return read(pool, actor); }

export async function updateOnboarding(pool: Pool, actor: Actor, input: unknown): Promise<OnboardingState> {
  const body = updateOnboardingRequestSchema.parse(input);
  if (body.expectedActorId !== actor.id) throw new DomainError('session_changed', 'The authenticated account changed', 409);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query<{ onboarding_revision: number; onboarding_workspace_id: string | null; onboarding_profile: string; onboarding_ai: string }>('SELECT onboarding_revision,onboarding_workspace_id,onboarding_profile,onboarding_ai FROM users WHERE id=$1 AND disabled_at IS NULL FOR UPDATE', [actor.id]);
    const current = locked.rows[0];
    if (!current) throw new DomainError('unauthorized', 'Account unavailable', 401);
    if (current.onboarding_revision !== body.expectedRevision) throw new DomainError('onboarding_conflict', 'Onboarding changed in another session; reread its state', 409);
    const workspaceId = body.action === 'select-workspace' ? body.workspaceId : body.action === 'finish' ? current.onboarding_workspace_id : null;
    if (body.action === 'select-workspace' || body.action === 'finish') {
      const available = workspaceId && await client.query(`SELECT m.workspace_id FROM memberships m JOIN workspaces w ON w.id=m.workspace_id
        WHERE m.user_id=$1 AND m.workspace_id=$2 AND m.revoked_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM workspace_sample_initializations s WHERE s.workspace_id=w.id AND s.status='pending') FOR SHARE OF m,w`, [actor.id, workspaceId]);
      if (!available || !available.rows.length) throw new DomainError('onboarding_workspace_unavailable', 'Select an authorized ready workspace', 409);
    }
    if (body.action === 'finish' && (current.onboarding_profile === 'pending' || current.onboarding_ai === 'pending')) throw new DomainError('onboarding_incomplete', 'Review or skip profile and AI before finishing', 409);
    await client.query(`UPDATE users SET onboarding_revision=onboarding_revision+1,
      onboarding_workspace_id=CASE WHEN $2='select-workspace' THEN $3::uuid ELSE onboarding_workspace_id END,
      onboarding_profile=CASE WHEN $2='review-profile' THEN 'reviewed' WHEN $2='skip-profile' THEN 'skipped' ELSE onboarding_profile END,
      onboarding_ai=CASE WHEN $2='review-ai' THEN 'reviewed' WHEN $2='skip-ai' THEN 'skipped' ELSE onboarding_ai END,
      onboarding_completed_at=CASE WHEN $2='finish' THEN COALESCE(onboarding_completed_at,clock_timestamp()) ELSE onboarding_completed_at END,
      onboarding_checklist_dismissed=CASE WHEN $2='dismiss-checklist' THEN true ELSE onboarding_checklist_dismissed END WHERE id=$1`, [actor.id, body.action, workspaceId]);
    const state = await read(client, actor);
    await client.query('COMMIT');
    return state;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
