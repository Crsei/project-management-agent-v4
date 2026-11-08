import { useSyncExternalStore } from "react";
import type { AgentWorkspace, ExecutionSelection, RemoteThread } from "@agent-workspace/contracts/chat";
import type { PmWorkspaceDiscovery } from "@agent-workspace/contracts/pm-tools";
import type { ProviderOptionSelection, ProvidersResponse } from "@agent-workspace/contracts/provider";
import { getProviderModelTraits, resolveProviderModelSelection } from "@agent-workspace/client-runtime/providers";
import type { Actor, Workspace } from "../../../../../../../packages/contracts/src/client";
import { workspaceClient } from "../network";
import { agentText } from "../i18n-text.ts";

export type { Actor, Workspace };
export type PmIdentity = { actor: Actor; workspaces: Workspace[] };
export const CHAT_ONLY_SELECTION: ExecutionSelection = { version: 2, agentWorkspaceId: null, agentWorkspaceRevision: null };
export function workspaceExecutionSelection(workspace: AgentWorkspace): ExecutionSelection {
  return { version: 2, agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision };
}
export function threadExecutionSelection(localId: string, remoteId?: string): ExecutionSelection | undefined {
  return remoteId ? state.threads.get(remoteId)?.executionSelection : state.executionDrafts.get(localId) ?? CHAT_ONLY_SELECTION;
}
export function bindDraftExecution(localId: string, selection: ExecutionSelection) {
  update({ executionDrafts: new Map(state.executionDrafts).set(localId, selection) });
}

type State = {
  workspaces: AgentWorkspace[];
  loading: boolean;
  error?: string;
  catalog: PmWorkspaceDiscovery | null;
  catalogLoading: boolean;
  catalogError?: string;
  providers: ProvidersResponse["providers"];
  providersLoading: boolean;
  providerError?: string;
  threads: ReadonlyMap<string, RemoteThread>;
  executionDrafts: ReadonlyMap<string, ExecutionSelection>;
  threadError?: string;
  identity: PmIdentity | null;
  identityLoading: boolean;
  identityError?: string;
};
let state: State = {
  workspaces: [], loading: true, catalog: null, catalogLoading: false,
  providers: [], providersLoading: true, threads: new Map(), executionDrafts: new Map(),
  identity: null, identityLoading: false,
};
const listeners = new Set<() => void>();
function update(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}
export function usePmChatState() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => state, () => state);
}
export function acceptAgentWorkspace(workspace: AgentWorkspace) {
  workspaceRefreshSequence++;
  update({ workspaces: [...state.workspaces.filter(item => item.id !== workspace.id), workspace], loading: false, error: undefined });
}
let workspaceRefreshSequence = 0;
export async function refreshAgentWorkspaces(): Promise<void> {
  const sequence = ++workspaceRefreshSequence;
  update({ loading: true });
  try {
    const response = await workspaceClient.json<{ workspaces: AgentWorkspace[] }>("/api/agent-workspaces");
    if (sequence === workspaceRefreshSequence) update({ workspaces: response.workspaces, loading: false, error: undefined });
  } catch (error) {
    if (sequence === workspaceRefreshSequence) update({ loading: false, error: error instanceof Error ? error.message : String(error) });
  }
}
export function getRemoteThread(id: string) {
  return state.threads.get(id);
}
export function acceptRemoteThread(thread: RemoteThread) {
  update({ threads: new Map(state.threads).set(thread.remoteId, thread), threadError: undefined });
}
export function acceptRemoteThreads(threads: RemoteThread[]) {
  update({ threads: new Map(threads.map((thread) => [thread.remoteId, thread])), threadError: undefined });
}
export function forgetRemoteThread(id: string) {
  const threads = new Map(state.threads);
  threads.delete(id);
  update({ threads });
}
export function reportThreadError(error: unknown) {
  update({ threadError: error instanceof Error ? error.message : String(error) });
}
export function availableProviderModel(providerId: string, model: string) {
  if (state.providersLoading || state.providerError) return undefined;
  const selection = resolveProviderModelSelection(state.providers, providerId, model);
  return selection.status === "selected" && selection.provider.nativeSessionReady ? selection.model : undefined;
}
export function canSendThread(localId: string, remoteId: string | undefined, providerId: string, model: string, modelOptions?: ProviderOptionSelection[]) {
  const executionSelection = threadExecutionSelection(localId, remoteId);
  const provider = state.providers.find((item) => item.instanceId === providerId);
  const selected = availableProviderModel(providerId, model);
  const options = modelOptions ?? provider?.modelPreferences?.options[model] ?? [];
  const validOptions = !!selected && !!provider && getProviderModelTraits({ driver: provider.driver, model: selected, options }).invalidOptions.length === 0;
  // PM connectivity and the sidebar's selection never grant or revoke Session execution.
  return executionSelection?.version === 2 && (!remoteId || state.threads.get(remoteId)?.status === "regular") && !!selected && validOptions;
}

export class PmApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export async function pmJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: "same-origin", headers: { "Content-Type": "application/json", ...init?.headers } });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const nested = body?.error;
    const message = typeof body?.message === "string" ? body.message : typeof nested === "string" ? nested
      : nested && typeof nested === "object" && "message" in nested ? String(nested.message)
      : agentText(`请求失败（${response.status}）`, `Request failed (${response.status})`);
    throw new PmApiError(message, response.status);
  }
  return body as T;
}
/** Optional PM discovery, loaded only for explicit PM operations. */
export async function refreshCatalog(): Promise<PmWorkspaceDiscovery> {
  update({ catalogLoading: true });
  try {
    const catalog = await workspaceClient.json<PmWorkspaceDiscovery>("/api/pm-tools/workspaces");
    update({ catalog, catalogLoading: false, catalogError: undefined });
    return catalog;
  } catch (error) {
    update({ catalogLoading: false, catalogError: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
export async function refreshIdentity(): Promise<void> {
  update({ identityLoading: true });
  try {
    const [me, list] = await Promise.all([pmJson<{ actor: Actor }>("/api/v1/auth/me"), pmJson<{ items: Workspace[] }>("/api/v1/workspaces")]);
    update({ identity: { actor: me.actor, workspaces: list.items }, identityLoading: false, identityError: undefined });
  } catch (error) {
    update({ identityLoading: false, identityError: error instanceof Error ? error.message : String(error) });
  }
}
let providerRefreshSequence = 0;
export async function refreshProviders(): Promise<void> {
  const sequence = ++providerRefreshSequence;
  update({ providersLoading: true });
  try {
    const response = await workspaceClient.json<ProvidersResponse>("/api/providers");
    if (sequence === providerRefreshSequence) update({ providers: response.providers, providersLoading: false, providerError: undefined });
  } catch (error) {
    if (sequence === providerRefreshSequence) update({ providersLoading: false, providerError: error instanceof Error ? error.message : String(error) });
  }
}
