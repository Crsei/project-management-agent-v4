import type { ProjectManagementClient } from '@contracts';
import { coreCreationFileRecordSchema } from '../../../../../../packages/contracts/src/core-creation';
import type { LocalDirectory, LocalProjectAttempt, LocalProjectInitialization } from '../../../../../../packages/contracts/src/local-projects';

/** Bind the shared authenticated client; accept only validated ready FileRecords. */
export function localProjectApi(client: ProjectManagementClient, workspaceId: string) {
  const local = client.localProjects;
  async function attempt(request: Promise<LocalProjectAttempt>): Promise<LocalProjectAttempt> {
    const result = await request;
    return result.status === 'ready' ? { ...result, record: coreCreationFileRecordSchema.parse(result.record) } : result;
  }
  return {
    settings: (signal?: AbortSignal) => local.settings(workspaceId, signal),
    saveSettings: (defaultParent: string) => local.saveSettings(workspaceId, { defaultParent }),
    directories: (path?: string, signal?: AbortSignal) => local.directories(workspaceId, path, signal),
    preview: (directory: LocalDirectory) => local.preview(workspaceId, { directory }),
    initialize: (input: LocalProjectInitialization, key: string) => attempt(local.initialize(workspaceId, key, input)),
    attempt: (key: string) => attempt(local.initialization(workspaceId, key)),
    recover: (key: string) => attempt(local.recover(workspaceId, key)),
    location: (id: string, signal?: AbortSignal) => local.location(workspaceId, id, signal),
    move: (id: string, operation: 'migrate' | 'relocate', directory: LocalDirectory, key: string, mode: 'move' | 'rebind') => attempt(operation === 'migrate' ? local.migrate(workspaceId, id, key, { directory, writersStopped: true }) : local.relocate(workspaceId, id, key, { directory, writersStopped: true, mode })),
  };
}
