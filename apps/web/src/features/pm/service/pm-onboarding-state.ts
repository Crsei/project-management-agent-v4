import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { OnboardingState, UpdateOnboardingRequest } from '@contracts';
import { usePmService } from './pm-service';
import { pmKeys } from './pm-data';

/** Account-scoped acknowledgements. A failed write is never replayed: read first. */
export function useOnboarding() {
  const { actor, actorEpoch, client } = usePmService();
  const queryClient = useQueryClient();
  const actorId = actor?.id;
  const scope = `${window.location.origin}:${actorId ?? ''}:${actorEpoch}`;
  const current = useRef(scope);
  current.current = scope;
  useEffect(() => {
    current.current = scope;
    return () => { if (current.current === scope) current.current = ''; };
  }, [scope]);
  const sending = useRef(false);
  const [operation, setOperation] = useState<{ scope: string; busy: boolean; error: string } | null>(null);
  const key = [...pmKeys.private(window.location.origin), actorId ?? 'anonymous', 'onboarding', actorEpoch] as const;
  const query = useQuery({
    queryKey: key,
    enabled: !!actorId,
    retry: false,
    refetchOnMount: 'always',
    queryFn: async ({ signal }) => {
      const state = await client.getOnboarding({ signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
      if (state.actorId !== actorId) throw new Error('Session changed');
      return state;
    },
  });
  const busy = (operation?.scope === scope && operation.busy) || query.isFetching;
  const error = operation?.scope === scope ? operation.error : '';
  async function update(action: UpdateOnboardingRequest['action'], workspaceId?: string): Promise<OnboardingState | null> {
    if (!actorId || !query.data || query.error || query.isFetching || sending.current || busy) return null;
    const state = query.data;
    if (state.actorId !== actorId || (action === 'select-workspace' && !workspaceId)) return null;
    sending.current = true;
    setOperation({ scope, busy: true, error: '' });
    try {
      const input: UpdateOnboardingRequest = action === 'select-workspace'
        ? { expectedActorId: actorId, expectedRevision: state.revision, action, workspaceId: workspaceId! }
        : { expectedActorId: actorId, expectedRevision: state.revision, action };
      const next = await client.updateOnboarding(input, { signal: AbortSignal.timeout(20_000) });
      if (current.current !== scope || next.actorId !== actorId) return null;
      queryClient.setQueryData(key, next);
      return next;
    } catch (cause) {
      if (current.current !== scope) return null;
      // Any failure may have followed a committed response. Do not resend it.
      const result = await query.refetch();
      if (current.current === scope) setOperation({ scope, busy: false, error: result.error ? 'Unable to reconcile the previous action. Retry reading before continuing.' : (cause instanceof Error ? cause.message : 'Action outcome was checked; review the current state before continuing.') });
      return null;
    } finally {
      sending.current = false;
      if (current.current === scope) setOperation(previous => previous?.scope === scope && previous.busy ? { ...previous, busy: false } : previous);
    }
  }
  return { ...query, data: !query.error && query.isFetchedAfterMount && query.data?.actorId === actorId ? query.data : undefined, busy, actionError: error, update };
}
