import { usePmService, usePrivateQuery } from './pm-service';
import { pmKeys } from './pm-data';
import { localProjectApi } from './local-project-api';

export function useLocalProjectSettings(enabled = true) {
  const { actor, workspace } = usePmService();
  return usePrivateQuery([...pmKeys.workspace(window.location.origin, actor?.id ?? 'anonymous', workspace?.id ?? 'none'), 'local-projects', 'settings'], 'domain.read', undefined,
    (client, workspaceId, signal) => localProjectApi(client, workspaceId).settings(signal), enabled);
}
