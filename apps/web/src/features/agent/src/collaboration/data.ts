import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { workspaceClient } from "../network";
import { collaborationJson as requestCollaborationJson, createCollaborationLocalState, createCollaborationResource as createResource, type Client } from "./data-model.ts";

export { captureCollaborationAuthority, collaborationPath, createCollaborationLocalState, errorText, invalidateCollaborationAccess, restricted, safeCollaborationHref, subscribeCollaborationAccess } from "./data-model.ts";
export type { ResourceSnapshot } from "./data-model.ts";
export function useCollaborationState<T>(initial: T | (() => T), cleared: T | (() => T)) {
  const [source] = useState(() => createCollaborationLocalState(
    typeof initial === "function" ? (initial as () => T)() : initial,
    typeof cleared === "function" ? (cleared as () => T)() : cleared,
  ));
  return [useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot), source.set] as const;
}
export function collaborationJson<T>(path: string, init?: RequestInit, client: Client = workspaceClient): Promise<T> {
  return requestCollaborationJson<T>(path, init, client);
}
export function createCollaborationResource<T>(path: string, client: Client = workspaceClient, parse?: (value: T) => T) {
  return createResource(path, client, parse);
}
const empty = { data: null, error: null, accessDenied: false, loading: false, loadedAt: null };
export function useCollaborationResource<T>(path: string | null, client: Client = workspaceClient) {
  const source = useMemo(() => path ? createCollaborationResource<T>(path, client) : null, [path, client]);
  const state = useSyncExternalStore(source?.subscribe ?? (() => () => {}), source?.getSnapshot ?? (() => empty), source?.getSnapshot ?? (() => empty));
  useEffect(() => source?.start(), [source]);
  return { ...state, refresh: source?.refresh ?? (() => Promise.resolve()) };
}
