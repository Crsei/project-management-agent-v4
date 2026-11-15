import type { MemberHandover, MemberImpact } from '@contracts';
import { pmKeys } from './pm-data';
import { usePmService, usePrivateQuery } from './pm-service';
import { allowed } from './pm-ui';

export function useMemberImpact(userId: string, enabled: boolean) {
  const { actor, workspace } = usePmService();
  const key = [...pmKeys.workspace(window.location.origin, actor?.id ?? 'anonymous', workspace?.id ?? 'none'), 'member-impact', userId];
  return usePrivateQuery<MemberImpact>(key, null, undefined, (client, workspaceId, signal) => client.memberLifecycle.impact(workspaceId, userId, signal), enabled);
}
export function useMemberHandovers(userId: string, enabled: boolean) {
  const { actor, workspace } = usePmService();
  const key = [...pmKeys.workspace(window.location.origin, actor?.id ?? 'anonymous', workspace?.id ?? 'none'), 'member-handovers', userId];
  return usePrivateQuery<{ items: MemberHandover[] }>(key, 'access.manage', undefined, (client, workspaceId, signal) => client.memberLifecycle.list(workspaceId, userId, signal), enabled && allowed(workspace, 'access.manage') && allowed(workspace, 'domain.read'));
}
