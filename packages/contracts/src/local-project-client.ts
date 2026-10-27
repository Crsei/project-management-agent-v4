import type { LocalDirectory, LocalProjectAttempt, LocalProjectDirectoryListing, LocalProjectInitialization, LocalProjectLocation, LocalProjectPreview, LocalProjectSettings } from './local-projects.ts';

export type LocalProjectTransport = <T>(method: string, path: string, body?: unknown, headers?: Record<string, string>, signal?: AbortSignal) => Promise<T>;
/** Uses the existing authenticated transport; it never retries an unknown write or replaces its key. */
export function createLocalProjectClient(send: LocalProjectTransport) {
  const base = (workspaceId: string) => `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/local-projects`;
  return {
    settings: (workspaceId: string, signal?: AbortSignal) => send<LocalProjectSettings>('GET', base(workspaceId) + '/settings', undefined, undefined, signal),
    saveSettings: (workspaceId: string, input: { defaultParent: string }, signal?: AbortSignal) => send<LocalProjectSettings>('PUT', base(workspaceId) + '/settings', input, undefined, signal),
    directories: (workspaceId: string, path?: string, signal?: AbortSignal) => send<LocalProjectDirectoryListing>('GET', base(workspaceId) + '/directories' + (path ? `?path=${encodeURIComponent(path)}` : ''), undefined, undefined, signal),
    preview: (workspaceId: string, input: { directory: LocalDirectory }, signal?: AbortSignal) => send<LocalProjectPreview>('POST', base(workspaceId) + '/preview', input, undefined, signal),
    initialize: (workspaceId: string, key: string, input: LocalProjectInitialization, signal?: AbortSignal) => send<LocalProjectAttempt>('POST', base(workspaceId) + '/initializations', input, { 'Idempotency-Key': key }, signal),
    initialization: (workspaceId: string, key: string, signal?: AbortSignal) => send<LocalProjectAttempt>('GET', base(workspaceId) + '/initializations/' + encodeURIComponent(key), undefined, undefined, signal),
    recover: (workspaceId: string, key: string, signal?: AbortSignal) => send<LocalProjectAttempt>('POST', base(workspaceId) + '/initializations/' + encodeURIComponent(key) + '/recover', {}, undefined, signal),
    location: (workspaceId: string, projectId: string, signal?: AbortSignal) => send<LocalProjectLocation>('GET', base(workspaceId) + '/projects/' + encodeURIComponent(projectId) + '/location', undefined, undefined, signal),
    migrate: (workspaceId: string, projectId: string, key: string, input: { directory: LocalDirectory; writersStopped: true }, signal?: AbortSignal) => send<LocalProjectAttempt>('POST', base(workspaceId) + '/projects/' + encodeURIComponent(projectId) + '/migrate', input, { 'Idempotency-Key': key }, signal),
    relocate: (workspaceId: string, projectId: string, key: string, input: { directory: LocalDirectory; writersStopped: true; mode: 'move' | 'rebind' }, signal?: AbortSignal) => send<LocalProjectAttempt>('POST', base(workspaceId) + '/projects/' + encodeURIComponent(projectId) + '/relocate', input, { 'Idempotency-Key': key }, signal),
  };
}
