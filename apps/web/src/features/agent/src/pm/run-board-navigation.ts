import type { AgentWorkspace, ExecutionSelection } from "@agent-workspace/contracts/chat";

const returnKeys: Record<string, true> = { view: true, sessionId: true, q: true, folder: true, provider: true, attention: true, workspaceId: true, projectId: true, taskId: true, runId: true, status: true, definitionId: true };
// oxlint-disable-next-line no-control-regex -- URL normalization must not hide controls or backslashes.
const unsafeUrlCharacters = /[\\\u0000-\u001f\u007f]/;

/** Keep the exact board URL, including the caller's selection and filters. */
export function safeRunBoardReturn(value: string | null): string | null {
  if (!value || unsafeUrlCharacters.test(value) || !/^\/agent\/runs(?:\?|$)/.test(value)) return null;
  try {
    const decoded = decodeURIComponent(value);
    if (unsafeUrlCharacters.test(decoded)) return null;
    const url = new URL(value, "https://run-board.invalid");
    if (url.origin !== "https://run-board.invalid" || url.pathname !== "/agent/runs" || url.hash) return null;
    for (const [key, item] of url.searchParams) {
      if (!Object.hasOwn(returnKeys, key) || url.searchParams.getAll(key).length !== 1) return null;
      if (key === "view" && item !== "sessions" && item !== "business" || key === "attention" && item !== "1") return null;
    }
    return value;
  } catch { return null; }
}

export function runBoardChatHref(input: { threadId?: string; agentWorkspaceId?: string | null; terminal?: boolean; returnTo: string }): string {
  const returnTo = safeRunBoardReturn(input.returnTo) ?? "/agent/runs";
  const params = new URLSearchParams({ runReturn: returnTo });
  if (input.threadId !== undefined) {
    if (!input.threadId) throw new Error("A Session id is required");
    params.set("thread", input.threadId);
    if (input.agentWorkspaceId) params.set("agentWorkspaceId", input.agentWorkspaceId);
  } else {
    params.set("newSession", "1");
    if (input.agentWorkspaceId) params.set("agentWorkspaceId", input.agentWorkspaceId);
    else if (input.agentWorkspaceId === null) params.set("chatOnly", "1");
  }
  if (input.terminal) params.set("openTerminal", "1");
  return `/agent/workspace?${params}`;
}

export type RunBoardChatIntent =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "thread"; threadId: string; agentWorkspaceId?: string }
  | { kind: "new"; threadId?: string; agentWorkspaceId?: string | null };

/** A thread alongside newSession is the original, URL-pinned creation receipt. */
export function runBoardChatIntent(params: URLSearchParams): RunBoardChatIntent {
  const keys = ["thread", "newSession", "agentWorkspaceId", "chatOnly", "openTerminal"];
  if (keys.some(key => params.getAll(key).length > 1)) return { kind: "invalid" };
  const threadId = params.get("thread");
  const folder = params.get("agentWorkspaceId");
  if (params.has("openTerminal") && params.get("openTerminal") !== "1") return { kind: "invalid" };
  if (params.has("thread") && !threadId || params.has("agentWorkspaceId") && !folder) return { kind: "invalid" };
  if (params.has("newSession")) {
    if (params.get("newSession") !== "1" || !!folder && params.has("chatOnly") || params.has("chatOnly") && params.get("chatOnly") !== "1") return { kind: "invalid" };
    return { kind: "new", ...(threadId ? { threadId } : {}), ...(folder ? { agentWorkspaceId: folder } : params.has("chatOnly") ? { agentWorkspaceId: null } : {}) };
  }
  if (params.has("chatOnly") || !threadId && (folder || params.has("openTerminal"))) return { kind: "invalid" };
  return threadId ? { kind: "thread", threadId, ...(folder ? { agentWorkspaceId: folder } : {}) } : { kind: "none" };
}

export function runBoardNavigationKey(params: URLSearchParams): string {
  const invalidTerminal = params.has("openTerminal") && (params.get("openTerminal") !== "1" || params.getAll("openTerminal").length !== 1);
  return JSON.stringify([...["thread", "newSession", "agentWorkspaceId", "chatOnly"].map(key => params.getAll(key)), invalidTerminal ? params.getAll("openTerminal") : []]);
}

export function newRunBoardSelection(intent: Extract<RunBoardChatIntent, { kind: "new" }>, workspaces: readonly AgentWorkspace[]): ExecutionSelection | null {
  if (intent.agentWorkspaceId === null) return { version: 2, agentWorkspaceId: null, agentWorkspaceRevision: null };
  const workspace = workspaces.find(item => item.id === intent.agentWorkspaceId);
  return workspace && workspace.status === "available" && !workspace.archivedAt
    ? { version: 2, agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision } : null;
}

/** Explicit hand-offs take precedence over the last locally selected Session. */
export function requestedChatThread(params: URLSearchParams, cached: () => string | undefined): string | undefined {
  if (params.has("newSession")) return undefined;
  const thread = params.get("thread");
  if (thread) return thread;
  if (["workspace", "agentWorkspaceId", "chatOnly", "openTerminal", "thread"].some(key => params.has(key))) return undefined;
  return cached();
}

export function resolvedRunBoardChatParams(params: URLSearchParams, threadId: string): URLSearchParams {
  const next = new URLSearchParams(params);
  next.set("thread", threadId);
  next.delete("newSession"); next.delete("chatOnly");
  return next;
}

export function consumedRunBoardTerminalParams(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete("openTerminal");
  return next;
}

export type RunBoardRouteReplacement = { fromKeys: readonly string[]; toKey: string };

/** React Router may still render the consumed URL while its replacement transitions. */
export function runBoardRouteReplacementPending(replacement: RunBoardRouteReplacement | undefined, currentKey: string): boolean {
  return !!replacement && currentKey !== replacement.toKey && replacement.fromKeys.includes(currentKey);
}

/** Only promote a genuinely initialized local draft; explicit hand-offs own their URL. */
export function initializedDraftChatParams(params: URLSearchParams, remoteId: string | undefined, initializedDraft: boolean): URLSearchParams | null {
  if (!initializedDraft || !remoteId || ["thread", "newSession", "agentWorkspaceId", "chatOnly", "openTerminal"].some(key => params.has(key))) return null;
  const next = new URLSearchParams(params);
  next.set("thread", remoteId);
  return next;
}
