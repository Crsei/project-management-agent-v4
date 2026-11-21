import type { AgentWorkspace, ChatGenerationView, ExecutionEnvironment, RemoteThread, ThreadSidebar } from "@agent-workspace/contracts/chat";

export type RunBoardActivity = {
  status: ThreadSidebar["activity"]["status"] | "unknown";
  column: "queued" | "running" | "waiting" | "attention" | "idle" | "unknown";
  active: boolean;
  generationId: string | null;
};

/** Only the server's activity projection describes a run, never sidebar.running. */
export function runBoardActivity(thread: RemoteThread): RunBoardActivity {
  const activity = thread.sidebar?.activity;
  const generationId = typeof activity?.generationId === "string" && activity.generationId.trim()
    ? activity.generationId : null;
  switch (activity?.status) {
    case "queued": return { status: "queued", column: "queued", active: true, generationId };
    case "running": return { status: "running", column: "running", active: true, generationId };
    case "waiting_approval": return { status: "waiting_approval", column: "waiting", active: true, generationId };
    case "waiting_input": return { status: "waiting_input", column: "waiting", active: true, generationId };
    case "failed": return { status: "failed", column: "attention", active: false, generationId };
    case "cancelled": return { status: "cancelled", column: "attention", active: false, generationId };
    case "interrupted": return { status: "interrupted", column: "attention", active: false, generationId };
    case "idle": return { status: "idle", column: "idle", active: false, generationId };
    default: return { status: "unknown", column: "unknown", active: false, generationId: null };
  }
}

export function runBoardStopTargetMatches(thread: RemoteThread, threadId: string, generationId: string): boolean {
  const activity = runBoardActivity(thread);
  return thread.remoteId === threadId && thread.status === "regular" && activity.active
    && !!generationId.trim() && activity.generationId === generationId;
}

export type RunBoardGenerationFacts = {
  generationId: string | null;
  generation: ChatGenerationView | null;
  consistent: boolean;
  state: ChatGenerationView["status"] | "never-started" | "unknown";
};

/** Sidebar idle is not success; only this Session's matching history supplies a result. */
export function runBoardGenerationFacts(
  thread: RemoteThread | null,
  history: { latestGeneration: ChatGenerationView | null; activeGenerationId?: string } | null,
): RunBoardGenerationFacts {
  const activity = thread ? runBoardActivity(thread) : null;
  const observedId = activity?.generationId ?? null;
  const latest = history?.latestGeneration?.threadId === thread?.remoteId ? history?.latestGeneration : null;
  const generationId = observedId || history?.activeGenerationId || latest?.id || null;
  const generation = latest?.id === generationId ? latest : null;
  const consistent = !!thread && !!history && !!activity
    && (!history.latestGeneration || history.latestGeneration.threadId === thread.remoteId)
    && (!observedId || latest?.id === observedId)
    && (!activity.active || (!!observedId && history.activeGenerationId === observedId))
    && !(activity.status === "idle" && !!history.activeGenerationId)
    && (!history.activeGenerationId || latest?.id === history.activeGenerationId
      && (latest.status === "queued" || latest.status === "running"));
  return {
    generationId,
    generation: generation ?? null,
    consistent,
    state: !consistent ? "unknown" : generation?.status
      ?? (activity?.status === "idle" && !generationId ? "never-started" : "unknown"),
  };
}

export type RunBoardSelection = {
  query: string;
  folder: string;
  provider: string;
  attention: boolean;
  selectedId: string | null;
};

export function readRunBoardSelection(params: URLSearchParams): RunBoardSelection {
  return {
    query: params.get("q") ?? "",
    folder: params.get("folder") ?? "",
    provider: params.get("provider") ?? "",
    attention: params.get("attention") === "1",
    selectedId: params.get("sessionId"),
  };
}

/** Update one board intent without dropping its other filters or exact selection. */
export function updateRunBoardSelection(params: URLSearchParams, patch: Partial<RunBoardSelection>): URLSearchParams {
  const next = new URLSearchParams(params);
  next.set("view", "sessions");
  const keys = { query: "q", folder: "folder", provider: "provider", attention: "attention", selectedId: "sessionId" } as const;
  for (const key of Object.keys(patch) as (keyof RunBoardSelection)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null || value === "" || value === false) next.delete(keys[key]);
    else next.set(keys[key], value === true ? "1" : value);
  }
  return next;
}

/** A resolved execution path may be a Worktree, never a guessed PM directory. */
export function runBoardTerminalWorkspace(
  thread: RemoteThread,
  workspaces: AgentWorkspace[],
  environment: ExecutionEnvironment | null,
): AgentWorkspace | null {
  const selection = thread.executionSelection;
  if (selection?.version !== 2 || !selection.agentWorkspaceId || !selection.agentWorkspaceRevision
    || environment?.version !== 2 || environment.hostId !== "local"
    || environment.agentWorkspaceId !== selection.agentWorkspaceId
    || environment.agentWorkspaceRevision !== selection.agentWorkspaceRevision
    || !environment.sourcePath || !environment.executionPath) return null;
  return workspaces.find(workspace => workspace.id === selection.agentWorkspaceId
    && workspace.status === "available" && workspace.path === environment.sourcePath
    && workspace.revision >= selection.agentWorkspaceRevision!) ?? null;
}

export const RUN_BOARD_SCOPE_STORAGE_KEY = "pm-v4:run-board-scope";

type ScopeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserScopeStorage(): ScopeStorage | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}

/** A remembered board scope is only a preference; the server list still decides validity. */
export function readRunBoardFolderScope(storage: ScopeStorage | undefined = browserScopeStorage()): string {
  try {
    const value = storage?.getItem(RUN_BOARD_SCOPE_STORAGE_KEY);
    if (value === "chat-only" || !!value && /^folder:[^\s\u0000-\u001f\u007f]+$/.test(value)) return value;
  } catch { /* Storage failure keeps the board usable without a remembered scope. */ }
  return "";
}

export function writeRunBoardFolderScope(folder: string, storage: ScopeStorage | undefined = browserScopeStorage()): void {
  try {
    if (folder) storage?.setItem(RUN_BOARD_SCOPE_STORAGE_KEY, folder);
    else storage?.removeItem(RUN_BOARD_SCOPE_STORAGE_KEY);
  } catch { /* Storage failure never changes the selected scope. */ }
}

/** A registered folder can be pinned before it has any Session; archived folders cannot. */
export function isRunBoardFolderScopeValid(folder: string, workspaces: readonly AgentWorkspace[]): boolean {
  if (folder === "chat-only") return true;
  if (!folder.startsWith("folder:")) return false;
  const id = folder.slice("folder:".length);
  return workspaces.some(workspace => workspace.id === id && !workspace.archivedAt);
}

export function isRunBoardAttentionColumn(column: RunBoardActivity["column"]): boolean {
  return column === "waiting" || column === "attention" || column === "unknown";
}

export type RunBoardKeyboardRow = { id: string; column: RunBoardActivity["column"] };

/** Kander-style card movement: j/k inside a column, h/l to the next non-empty column. */
export function nextRunBoardKeyboardTarget(
  rows: readonly RunBoardKeyboardRow[],
  columns: readonly RunBoardActivity["column"][],
  selectedId: string | null,
  key: "j" | "k" | "h" | "l",
): string | null {
  const byColumn = new Map(columns.map(column => [column, rows.filter(row => row.column === column)]));
  const nonEmpty = columns.filter(column => (byColumn.get(column)?.length ?? 0) > 0);
  const first = nonEmpty[0] ? byColumn.get(nonEmpty[0])?.[0] : undefined;
  if (!first) return null;
  const selected = selectedId ? rows.find(row => row.id === selectedId) : undefined;
  if (!selected || !nonEmpty.includes(selected.column)) return first.id;
  const current = byColumn.get(selected.column)!;
  const index = current.findIndex(row => row.id === selected.id);
  if (key === "j" || key === "k") {
    const next = Math.max(0, Math.min(current.length - 1, index + (key === "j" ? 1 : -1)));
    return current[next]?.id ?? selected.id;
  }
  const position = nonEmpty.indexOf(selected.column);
  const targetColumn = nonEmpty[Math.max(0, Math.min(nonEmpty.length - 1, position + (key === "l" ? 1 : -1)))]!;
  if (targetColumn === selected.column) return selected.id;
  const target = byColumn.get(targetColumn)!;
  return target[Math.min(Math.max(index, 0), target.length - 1)]!.id;
}
