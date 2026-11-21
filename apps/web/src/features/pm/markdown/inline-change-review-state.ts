import { useEffect, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ChangeComparison, ChangeHistoryPage, ChangeHistoryTarget } from '../../../../../../packages/contracts/src/change-history';
import { usePmService, usePrivateQuery } from '../service/pm-service';
import { useHistoryKey } from './change-history';

export type InlineChangeReviewState = {
  page: ChangeHistoryPage | undefined;
  comparison: ChangeComparison | undefined;
  loading: boolean;
  refreshing: boolean;
  error: Error | null;
  accepting: boolean;
  canAccept: boolean;
  accept: () => Promise<boolean>;
  refresh: () => void;
};

type ReviewSnapshot = { page: ChangeHistoryPage; comparison: ChangeComparison | undefined };
type ReviewView = { scope: string; generation: number; revision: string };
// Snapshot text and pinned endpoints stay exclusively in the private query.
type AcceptAttempt = { viewId: string; observationToken: string };
type LiveReview = { viewId: string; active: boolean; canAccept: boolean; head: string | undefined; observationToken: string | undefined };

function sameTarget(left: ChangeHistoryTarget, right: ChangeHistoryTarget) {
  return left.kind === 'core'
    ? right.kind === 'core' && left.entityId === right.entityId
    : right.kind === 'external' && left.sourceId === right.sourceId && left.path === right.path;
}

function assertComparison(page: ChangeHistoryPage, comparison: ChangeComparison, target: ChangeHistoryTarget) {
  const newest = page.items[0];
  if (!sameTarget(comparison.target, target) || comparison.head !== page.head || !comparison.toChangeId
    || !newest || newest.sequence !== page.head || newest.changeId !== comparison.toChangeId
    || page.items.some(item => item.relation !== 'self' || !sameTarget(item.target, target))) {
    throw new Error('The saved comparison does not match the observed object and watermark. Refresh before reviewing.');
  }
}

/** Saved snapshots only. Acknowledgement advances one personal, self-only history cursor. */
export function useInlineChangeReview({ workspaceId, target, enabled, currentRevision }: {
  workspaceId: string;
  target: ChangeHistoryTarget;
  enabled: boolean;
  currentRevision: string;
}): InlineChangeReviewState {
  const service = usePmService();
  const queryClient = useQueryClient();
  const key = useHistoryKey(workspaceId);
  const instanceId = useId();
  const pinnedView = useRef<string | null>(null);
  const inFlight = useRef<AcceptAttempt | null>(null);
  const attemptedView = useRef<string | null>(null);
  const live = useRef<LiveReview | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [attempt, setAttempt] = useState<AcceptAttempt | null>(null);
  const [ackError, setAckError] = useState<{ viewId: string; error: Error } | null>(null);
  const workspace = service.workspace;
  const active = enabled && !!service.actor && !!workspace && workspaceId === workspace.id
    && workspace.capabilities.includes('domain.read');
  const targetIdentity = target.kind === 'core' ? ['core', target.entityId] : ['external', target.sourceId, target.path];
  const scope = JSON.stringify([key, service.actorEpoch, service.workspace?.id, service.workspace?.version, targetIdentity, active]);
  const [view, setView] = useState<ReviewView>({ scope, generation: 0, revision: currentRevision });
  let currentView = view;
  const previousViewId = JSON.stringify([instanceId, view.scope, view.generation]);
  if (view.scope !== scope || view.revision !== currentRevision) {
    // Scope transitions (including disable/re-enable and A -> B -> A) get a fresh
    // cache entry. A new saved revision must not replace an already displayed pair.
    const retainReview = view.scope === scope
      && (pinnedView.current === previousViewId || attemptedView.current === previousViewId);
    currentView = { scope, generation: view.generation + (retainReview ? 0 : 1), revision: currentRevision };
    setView(currentView);
  }
  const generation = currentView.generation;
  const viewId = JSON.stringify([instanceId, scope, generation]);
  const snapshotKey = [...key, 'list', 'inline', target, instanceId, generation] as const;
  const privateSnapshotKey = [...snapshotKey, service.workspace?.version ?? null, service.actorEpoch] as const;
  const snapshot = usePrivateQuery<ReviewSnapshot>(snapshotKey, 'domain.read', undefined,
    async (client, ws, signal) => {
      // Only a snapshot committed to this exact private-query entry may pin a
      // refetch; an aborted/late response must not establish an unseen pin.
      const cached = queryClient.getQueryData<ReviewSnapshot>(privateSnapshotKey);
      const endpoint = cached?.comparison;
      const retained = cached && cached.page.pendingCount > 0 && endpoint?.toChangeId ? {
        head: cached.page.head, fromChangeId: endpoint.fromChangeId, toChangeId: endpoint.toChangeId,
      } : null;
      let page = await client.changeHistory.list(ws, { target, includeRelated: false, limit: 50, ...(retained ? { head: retained.head } : {}) }, signal);
      signal.throwIfAborted();
      let comparison: ChangeComparison | undefined;
      if (page.pendingCount > 0) {
        comparison = await client.changeHistory.compare(ws, {
          target, through: page.head,
          ...(retained ? { fromChangeId: retained.fromChangeId, toChangeId: retained.toChangeId } : {}),
        }, signal);
        signal.throwIfAborted();
        assertComparison(page, comparison, target);
        // Compare's default base uses the personal cursor. Re-observe afterwards:
        // a concurrent acknowledgement can only advance that cursor, so the
        // comparison cannot omit anything still pending in this final page.
        page = await client.changeHistory.list(ws, { target, includeRelated: false, head: page.head, limit: 50 }, signal);
        signal.throwIfAborted();
        assertComparison(page, comparison, target);
        if (retained && (comparison.fromChangeId !== retained.fromChangeId || comparison.toChangeId !== retained.toChangeId)) {
          throw new Error('The pinned saved endpoints changed. Refresh before reviewing.');
        }
        if (page.pendingCount === 0) comparison = undefined;
      }
      if (!mounted.current || live.current?.viewId !== viewId || !live.current.active) {
        throw new DOMException('The inline review scope changed.', 'AbortError');
      }
      return { page, comparison };
    }, active);

  const error = active ? (ackError?.viewId === viewId ? ackError.error : snapshot.error) : null;
  const data = active && !error ? snapshot.data : undefined;
  const page = data?.page;
  const comparison = data?.comparison;
  if (data) pinnedView.current = comparison?.toChangeId ? viewId : null;
  const accepting = attempt?.viewId === viewId;
  const canAccept = active && !!page && page.pendingCount > 0 && !!comparison && !!(comparison.before || comparison.after)
    && !snapshot.isFetching && !snapshot.isPending && !error && !inFlight.current && attemptedView.current !== viewId;
  live.current = { viewId, active, canAccept, head: page?.head, observationToken: page?.observationToken };

  function advanceView() {
    setView(previous => previous.scope === scope && previous.generation === generation
      ? { ...previous, generation: previous.generation + 1 }
      : previous);
  }

  function refresh() {
    if (!mounted.current || live.current?.viewId !== viewId || !live.current.active || inFlight.current) return;
    live.current.canAccept = false;
    attemptedView.current = viewId;
    setAckError(null);
    advanceView();
    void queryClient.invalidateQueries({ queryKey: key });
  }

  async function accept(): Promise<boolean> {
    const current = live.current;
    const cached = queryClient.getQueryState<ReviewSnapshot>(privateSnapshotKey);
    if (!mounted.current || !current || current.viewId !== viewId || !current.active || !current.canAccept || inFlight.current
      || attemptedView.current === viewId || !page || !comparison
      || current.head !== page.head || current.observationToken !== page.observationToken
      || cached?.fetchStatus !== 'idle' || cached.status !== 'success' || cached.error || cached.data !== data) return false;
    // Ref guards close the same-tick double activation and post-success/pre-render
    // windows. A failed/unknown write stays locked until an explicit refresh.
    const pending = { viewId, observationToken: page.observationToken };
    inFlight.current = pending;
    attemptedView.current = viewId;
    current.canAccept = false;
    setAttempt(pending);
    try {
      await service.client.changeHistory.acknowledge(workspaceId, { target, through: page.head, observationToken: page.observationToken });
      const stillCurrent = mounted.current && live.current?.viewId === viewId && live.current.active;
      if (stillCurrent) advanceView();
      // Do not use acknowledgement.pendingCount: it also includes related sources.
      // A fresh self-only query discovers newer changes without acknowledging them.
      void queryClient.invalidateQueries({ queryKey: key });
      return stillCurrent;
    } catch (cause) {
      if (mounted.current && live.current?.viewId === viewId && live.current.active) {
        setAckError({ viewId, error: cause instanceof Error ? cause : new Error(String(cause)) });
      }
      return false;
    } finally {
      if (inFlight.current === pending) inFlight.current = null;
      if (mounted.current) setAttempt(previous => previous === pending ? null : previous);
    }
  }

  return {
    page, comparison,
    loading: active && snapshot.isPending,
    refreshing: active && snapshot.isFetching && !snapshot.isPending,
    error, accepting, canAccept, accept, refresh,
  };
}
