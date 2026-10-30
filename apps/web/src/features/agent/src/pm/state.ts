import { useSyncExternalStore } from "react";
import type { AgentScope, RemoteThread } from "@agent-workspace/contracts/chat";
import type { ProviderOptionSelection, ProvidersResponse } from "@agent-workspace/contracts/provider";
import { getProviderModelTraits, resolveProviderModelSelection } from "@agent-workspace/client-runtime/providers";
import type { AgentCatalog, AgentFileArea } from "../../../../../../../packages/contracts/src/agent-file-areas";
import type { Actor, Workspace } from "../../../../../../../packages/contracts/src/client";
import { workspaceClient } from "../network";
import { agentText } from "../i18n";

export type { AgentScope, AgentCatalog, AgentFileArea, Actor, Workspace };
export type PmIdentity = { actor: Actor; workspaces: Workspace[] };
export const scopeKey = (scope: AgentScope) => JSON.stringify([scope.workspaceId, scope.projectId]);
export const sameScope = (a?: AgentScope | null, b?: AgentScope | null) =>
  !!a && !!b && a.workspaceId === b.workspaceId && a.projectId === b.projectId;
export function scopeContext(catalog: AgentCatalog | null, scope?: AgentScope | null) {
  const workspace = catalog?.workspaces.find((item) => item.id === scope?.workspaceId);
  const project = workspace?.projects.find((item) => item.id === scope?.projectId);
  if (!workspace || (scope?.projectId && !project)) return null;
  return { workspace, project, fileArea: project?.fileArea ?? workspace.fileArea };
}

type State = {
  catalog: AgentCatalog | null;
  loading: boolean;
  error?: string;
  providers: ProvidersResponse["providers"];
  providersLoading: boolean;
  providerError?: string;
  threads: ReadonlyMap<string, RemoteThread>;
  drafts: ReadonlyMap<string, AgentScope>;
  threadError?: string;
  identity: PmIdentity | null;
  identityLoading: boolean;
  identityError?: string;
};
let state: State = {
  catalog: null, loading: true, providers: [], providersLoading: true,
  threads: new Map(), drafts: new Map(),
  identity: null, identityLoading: true,
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
export function threadScope(localId: string, remoteId?: string): AgentScope | undefined {
  // Once persisted, server ownership is authoritative, including legacy unscoped threads.
  return remoteId ? state.threads.get(remoteId)?.scope : state.drafts.get(localId);
}
export function bindDraftScope(localId: string, scope: AgentScope) {
  const existing = state.drafts.get(localId);
  if (existing && !sameScope(existing, scope)) throw new Error(agentText("会话作用域已绑定，请新建会话。", "This session is already bound to a scope; start a new session."));
  if (!existing) update({ drafts: new Map(state.drafts).set(localId, { ...scope }) });
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
export function acceptFileArea(scope: AgentScope, fileArea: AgentFileArea) {
  if (!state.catalog) return;
  update({ catalog: { workspaces: state.catalog.workspaces.map((workspace) =>
    workspace.id !== scope.workspaceId ? workspace : scope.projectId
      ? { ...workspace, projects: workspace.projects.map((project) => project.id === scope.projectId ? { ...project, fileArea } : project) }
      : { ...workspace, fileArea },
  ) } });
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
  const scope = threadScope(localId, remoteId);
  const context = scopeContext(state.catalog, scope);
  const provider = state.providers.find((item) => item.instanceId === providerId);
  const selected = availableProviderModel(providerId, model);
  const options = modelOptions ?? provider?.modelPreferences?.options[model] ?? [];
  const validOptions = !!selected && !!provider && getProviderModelTraits({
    driver: provider.driver, model: selected, options,
  }).invalidOptions.length === 0;
  return !state.loading && !state.error && !!scope && context?.fileArea.status === "available" &&
    (!remoteId || state.threads.get(remoteId)?.status === "regular") &&
    !!selected && validOptions;
}

export class PmApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export async function pmJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init, credentials: "same-origin", headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const nested = body?.error;
    const message = typeof body?.message === "string" ? body.message
      : typeof nested === "string" ? nested
      : nested && typeof nested === "object" && "message" in nested ? String(nested.message)
      : agentText(`请求失败（${response.status}）`, `Request failed (${response.status})`);
    throw new PmApiError(message, response.status);
  }
  return body as T;
}
export async function refreshCatalog(): Promise<AgentCatalog> {
  update({ loading: true });
  try {
    const catalog = await pmJson<AgentCatalog>("/api/v1/agent-contexts");
    update({ catalog, loading: false, error: undefined });
    return catalog;
  } catch (error) {
    update({ loading: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
/** PM owns the account and workspace directory; the chat shell only mirrors it for navigation. */
export async function refreshIdentity(): Promise<void> {
  update({ identityLoading: true });
  try {
    const [me, list] = await Promise.all([
      pmJson<{ actor: Actor }>("/api/v1/auth/me"),
      pmJson<{ items: Workspace[] }>("/api/v1/workspaces"),
    ]);
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
    if (sequence === providerRefreshSequence)
      update({ providers: response.providers, providersLoading: false, providerError: undefined });
  } catch (error) {
    if (sequence === providerRefreshSequence)
      update({ providersLoading: false, providerError: error instanceof Error ? error.message : String(error) });
  }
}
