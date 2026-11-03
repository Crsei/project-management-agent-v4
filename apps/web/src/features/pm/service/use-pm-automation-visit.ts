import { useCallback, useEffect, useRef, useState } from 'react';
import { StudioApiError, StudioClient } from '../../../../../../packages/contracts/src/automation-studio-client';
import { usePmService } from './pm-service';

type Attempt = { key: string; requestId: string; completed: boolean; pending: Promise<unknown> | null };
let visitEndpointUnavailable = false;
/** A visit is a real project-layout entry, not a render, focus, refresh or background source read. */
export function usePmAutomationVisit(projectId: string, enabled: boolean): { error: string | null; retry: () => void } {
  const { actor, workspace } = usePmService();
  const attempt = useRef<Attempt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const actorId = actor?.id, workspaceId = workspace?.id;
  const permitted = enabled && !!workspace && workspace.capabilities.includes('domain.read')
    && (workspace.projectIds === null || workspace.projectIds.includes(projectId));
  const key = actorId && workspaceId ? `pm.automation.visit.v1:${actorId}:${workspaceId}:${projectId}` : null;
  useEffect(() => {
    if (!key || !permitted || !workspaceId || visitEndpointUnavailable) return;
    if (attempt.current?.key === key && attempt.current.completed) return;
    if (attempt.current?.key !== key) {
      try {
        const saved = sessionStorage.getItem(key);
        if (saved && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(saved)) throw new Error('The pending project visit identity is invalid; it was not replaced.');
        const requestId = saved ?? crypto.randomUUID();
        sessionStorage.setItem(key, requestId);
        attempt.current = { key, requestId, completed: false, pending: null };
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Project visit identity cannot be persisted.');
        return;
      }
    }
    const original = attempt.current;
    let current = true;
    setError(null);
    // StrictMode subscribes to the same in-flight request, not a second navigation.
    original.pending ??= new StudioClient(workspaceId).pmVisit(original.requestId, projectId);
    void original.pending.then(() => {
      original.completed = true;
      try { if (sessionStorage.getItem(key) === original.requestId) sessionStorage.removeItem(key); }
      catch { /* The completed original identity is safe to reconcile after reload. */ }
      if (current) setError(null);
    }).catch(cause => {
      original.pending = null;
      if (cause instanceof StudioApiError && cause.status === 404) {
        // Older deployed servers may not expose the optional automation visit route.
        // Treat it as unavailable rather than blocking the project page with a fake recovery action.
        visitEndpointUnavailable = true;
        original.completed = true;
        try { if (sessionStorage.getItem(key) === original.requestId) sessionStorage.removeItem(key); } catch { /* Reload can still reconcile the original request. */ }
        if (current) setError(null);
        return;
      }
      if (current) setError(cause instanceof Error ? cause.message : 'Project visit result is unknown; retry reconciles the original request.');
    });
    return () => { current = false; };
  }, [key, permitted, workspaceId, projectId, retryVersion]);
  const retry = useCallback(() => setRetryVersion(version => version + 1), []);
  return { error, retry };
}
