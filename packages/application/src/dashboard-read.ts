import type { Actor } from '../../domain/src/core.ts';
import { DomainError } from '../../domain/src/core.ts';
import type { Membership } from './access.ts';
import { getMembership } from './access.ts';
import type { CoreAccess, SqlExecutor } from './ports.ts';

export type DashboardReadContext = {
  sql: SqlExecutor;
  actor: Actor;
  workspaceId: string;
  membership: Membership;
  now: Date;
  core: Omit<CoreAccess, 'handles'>;
};

/** Self data needs an active readable membership, not an unrestricted project scope. */
export async function requireDashboardReadSelf(ctx: Pick<DashboardReadContext, 'sql' | 'actor' | 'workspaceId'>): Promise<Membership> {
  const membership = await getMembership(ctx.sql, ctx.actor, ctx.workspaceId);
  if (!membership.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Capability domain.read is required', 403);
  return membership;
}
