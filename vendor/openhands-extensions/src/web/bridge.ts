import { webPlatform } from "@pm/cc-switch-source/web/bridge";
import { hasUnsavedChanges } from "@pm/cc-switch-source/lib/unsavedChanges";

export {
  webPlatform,
  getPortalContainer,
  getContentContainer,
  isTargetAvailable,
  invoke,
  openDirectory,
  openExternal,
  pickZip,
  availableApps,
  contextStorageKey,
} from "@pm/cc-switch-source/web/bridge";
export type { ManagementContext, ManagementEvent, WebPlatform } from "@pm/cc-switch-source/web/bridge";

/** The host alone owns context authorization, navigation guards and URL updates. */
export async function selectContext(contextId: string): Promise<boolean> {
  const platform = webPlatform();
  if (hasUnsavedChanges() || !platform.contexts?.some(context => context.id === contextId) || !platform.selectContext) return false;
  return platform.selectContext(contextId);
}
