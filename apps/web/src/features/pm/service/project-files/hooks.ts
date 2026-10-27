import { ApiError } from '@contracts';
import { usePmService, usePrivateQuery } from '../pm-service';
import { buildFileEntries, entryForFile } from './model';

/** Direct IDs remain readable even when their parent is excluded from visible lists. */
export function useFileHistory(fileId: string | null, projectId: string) {
  const { actor, workspace } = usePmService();
  return usePrivateQuery(['pm', window.location.origin, actor?.id ?? 'anonymous', workspace?.id ?? 'none', 'file-history', projectId, fileId], 'domain.read', projectId, async (client, workspaceId, signal) => {
    const first = await client.getEntity(workspaceId, fileId!, { signal });
    const artifact = first.kind === 'artifact' ? first : first.kind === 'artifact_version' ? await client.getEntity(workspaceId, String(first.data.artifactId), { signal }) : null;
    if (!artifact || artifact.kind !== 'artifact' || artifact.projectId !== projectId || first.projectId !== projectId || !Array.isArray(artifact.data.versionRefs)) throw new ApiError(404, { error: { code: 'not_found_or_forbidden' } });
    const versions = await Promise.all(artifact.data.versionRefs.map(async (id: unknown) => {
      if (typeof id !== 'string') throw new ApiError(502, { error: { code: 'invalid_response' } });
      const version = first.id === id ? first : await client.getEntity(workspaceId, id, { signal });
      if (version.kind !== 'artifact_version' || version.projectId !== projectId || version.data.artifactId !== artifact.id) throw new ApiError(502, { error: { code: 'invalid_response' } });
      return version;
    }));
    signal.throwIfAborted();
    const match = entryForFile(buildFileEntries([artifact], versions), fileId!);
    if (!match) throw new ApiError(404, { error: { code: 'not_found_or_forbidden' } });
    return match;
  }, !!fileId);
}

export function useArtifactCopyOrigin(versionId: string, projectId: string | null) {
  const { actor, workspace } = usePmService();
  return usePrivateQuery(['pm', window.location.origin, actor?.id ?? 'anonymous', workspace?.id ?? 'none', 'file-copy-origin', versionId], 'domain.read', projectId ?? undefined,
    (client, workspaceId, signal) => client.getArtifactCopyOrigin(workspaceId, versionId, { signal }));
}
