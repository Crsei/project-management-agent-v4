import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { pmJson, PmApiError, usePmChatState } from "./state";
import type { Entity } from "../../../../../../../packages/contracts/src/client";
import type { PmChangeSet, PmIssue, PmReference } from "./pm-types";
import { setPmChatContext, setPmReferences } from "./pm-chat-bridge";
import { agentText } from "../i18n";

export const PM_REFERENCE_LIMIT = 20;

type State = {
  issues: readonly PmIssue[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  query: string;
  selectedIds: ReadonlySet<string>;
  references: readonly PmReference[];
  currentIssueId: string | null;
  currentIssue: PmIssue | null;
  changes: readonly PmChangeSet[];
};

type Value = State & {
  workspaceId: string | null;
  projectId: string | null;
  workspaceName: string | null;
  projectName: string | null;
  filteredIssues: readonly PmIssue[];
  pickerOpen: boolean;
  referenceError: string | null;
  setQuery: (value: string) => void;
  loadMore: () => void;
  refresh: () => void;
  toggleSelection: (id: string) => void;
  selectVisible: () => void;
  clearSelection: () => void;
  addSelectedToReferences: () => void;
  toggleReference: (issue: PmIssue) => void;
  removeReference: (id: string) => void;
  clearReferences: () => void;
  selectCurrentIssue: (id: string | null) => void;
  openPicker: () => void;
  closePicker: () => void;
  setChanges: (changes: readonly PmChangeSet[]) => void;
};

const Context = createContext<Value | null>(null);

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    backlog: "Backlog",
    todo: agentText("待办", "To do"),
    in_progress: agentText("进行中", "In progress"),
    in_review: agentText("待审", "In review"),
    done: agentText("完成", "Done"),
    canceled: agentText("已取消", "Canceled"),
    cancelled: agentText("已取消", "Canceled"),
    blocked: agentText("阻塞", "Blocked"),
  };
  return labels[status] ?? status.replaceAll("_", " ");
}

function mapIssue(entity: Entity, projectName?: string): PmIssue {
  const data = entity.data ?? {};
  const projectId = entity.projectId ?? asString(data.projectId) ?? "";
  const status = asString(data.status) ?? asString(data.labStatus) ?? "unknown";
  return {
    id: entity.id,
    title: asString(data.title) ?? asString(data.name) ?? entity.id,
    projectId,
    ...(projectName ? { projectName } : {}),
    status,
    statusLabel: statusLabel(status),
    priority: asString(data.priority),
    assigneeId: asString(data.assigneeId) ?? asString(data.assignee),
    assigneeName: asString(data.assigneeName),
    dueDate: asString(data.dueDate) ?? asString(data.due),
    updatedAt: entity.updatedAt,
    revision: data.contentRevision != null ? String(data.contentRevision) : null,
    archived: data.archived === true || entity.kind === "work_item" && data.archivedAt != null,
  };
}

type AgentIssueSearchItem = {
  id: string; title: string; status: string | null; priority: string | null;
  projectId: string | null; assigneeId: string | null; dueDate: string | null;
  revision: string; updatedAt: string | null;
};
type AgentIssueSearchPage = { items: AgentIssueSearchItem[]; nextCursor: string | null };

function mapSearchItem(item: AgentIssueSearchItem, projectName?: string): PmIssue {
  const status = item.status ?? "unknown";
  return {
    id: item.id,
    title: item.title,
    projectId: item.projectId ?? "",
    ...(projectName ? { projectName } : {}),
    status,
    statusLabel: statusLabel(status),
    priority: item.priority,
    assigneeId: item.assigneeId,
    dueDate: item.dueDate,
    updatedAt: item.updatedAt,
    revision: item.revision,
    archived: false,
  };
}

async function readIssues(workspaceId: string, projectId: string | null, after: string | null, queryText: string, signal: AbortSignal): Promise<AgentIssueSearchPage> {
  const query = new URLSearchParams({ limit: "100" });
  if (projectId) query.set("projectId", projectId);
  if (after) query.set("after", after);
  if (queryText.trim()) query.set("q", queryText.trim());
  return pmJson<AgentIssueSearchPage>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agent-issues?${query.toString()}`, { signal });
}

function errorMessage(error: unknown): string {
  if (error instanceof PmApiError && (error.status === 401 || error.status === 403)) return agentText("PM 登录已过期或无权读取任务；请重新登录 PM。", "Your PM session expired or you lack permission to read tasks; sign in to PM again.");
  return error instanceof Error ? error.message : String(error);
}

export function PmIssueWorkspaceProvider({ workspaceId, projectId, initialIssueId = null, initialEntityId = null, referenceKey, localThreadId, children }: {
  workspaceId: string | null;
  projectId: string | null;
  initialIssueId?: string | null;
  /** PM hand-off entity (document or project) that is not a work item. */
  initialEntityId?: string | null;
  referenceKey: string;
  localThreadId: string;
  children: ReactNode;
}) {
  const chatState = usePmChatState();
  const [issues, setIssues] = useState<readonly PmIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [query, setQueryState] = useState("");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [references, setReferences] = useState<readonly PmReference[]>([]);
  const [currentIssueId, setCurrentIssueId] = useState<string | null>(initialIssueId);
  const [currentIssue, setCurrentIssue] = useState<PmIssue | null>(null);
  /** Entity kind of the resolved entry object; null means "not proven". */
  const [currentIssueKind, setCurrentIssueKind] = useState<Entity["kind"] | null>(null);
  const [changes, setChangesState] = useState<readonly PmChangeSet[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const cursor = useRef<string | null>(null);
  const loadedScope = useRef<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const referenceOwner = useRef<{ key: string; localId: string } | null>(null);
  const skipReferenceSave = useRef(false);

  useEffect(() => {
    const previous = referenceOwner.current;
    referenceOwner.current = { key: referenceKey, localId: localThreadId };
    skipReferenceSave.current = true;
    if (previous?.localId === localThreadId) {
      try { sessionStorage.removeItem(`pm-v3:agent-references:${previous.key}`); } catch { setReferenceError(agentText("浏览器无法保存引用。", "The browser could not save references.")); }
      setReferences(current => [...current]);
      return;
    }
    try {
      const value: unknown = JSON.parse(sessionStorage.getItem(`pm-v3:agent-references:${referenceKey}`) ?? "[]");
      setReferences(Array.isArray(value) ? value.filter((item): item is PmReference => item && typeof item.id === "string" && typeof item.title === "string" && ["issue", "project", "document"].includes(item.kind)).slice(0, PM_REFERENCE_LIMIT) : []);
    } catch { setReferences([]); setReferenceError(agentText("浏览器无法恢复引用。", "The browser could not restore references.")); }
  }, [referenceKey, localThreadId]);
  useEffect(() => {
    if (skipReferenceSave.current) { skipReferenceSave.current = false; return; }
    try {
      if (references.length) sessionStorage.setItem(`pm-v3:agent-references:${referenceKey}`, JSON.stringify(references));
      else sessionStorage.removeItem(`pm-v3:agent-references:${referenceKey}`);
    } catch { setReferenceError(agentText("浏览器无法保存引用。", "The browser could not save references.")); }
  }, [referenceKey, references]);

  const catalogWorkspace = chatState.catalog?.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  const catalogProject = catalogWorkspace?.projects.find((project) => project.id === projectId) ?? null;
  const workspaceName = catalogWorkspace?.name ?? null;
  const projectName = catalogProject?.name ?? null;

  const mapWithProject = useCallback((entity: Entity) => {
    const projectIdForIssue = entity.projectId ?? asString(entity.data?.projectId) ?? "";
    const name = chatState.catalog?.workspaces
      .flatMap((workspace) => workspace.projects)
      .find((project) => project.id === projectIdForIssue)?.name;
    return mapIssue(entity, name);
  }, [chatState.catalog]);

  const load = useCallback(async (mode: "replace" | "append", signal: AbortSignal) => {
    if (!workspaceId) {
      setIssues([]);
      setHasMore(false);
      setLoading(false);
      setError(null);
      cursor.current = null;
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const page = await readIssues(workspaceId, projectId, mode === "append" ? cursor.current : null, query, signal);
      if (signal.aborted) return;
      const mapped = page.items.map((item) => {
        const name = chatState.catalog?.workspaces.flatMap((workspace) => workspace.projects).find((project) => project.id === item.projectId)?.name;
        return mapSearchItem(item, name);
      });
      setIssues((previous) => {
        const next = mode === "append" ? [...previous, ...mapped] : mapped;
        return [...new Map(next.map((issue) => [issue.id, issue])).values()];
      });
      cursor.current = page.nextCursor;
      setHasMore(page.nextCursor !== null);
    } catch (cause) {
      if (!signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [chatState.catalog, projectId, query, workspaceId]);

  useEffect(() => {
    const scopeKey = `${workspaceId ?? ""}:${projectId ?? ""}`;
    const scoped = loadedScope.current === scopeKey;
    loadedScope.current = scopeKey;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    if (!scoped) {
      setIssues([]);
      setSelectedIds(new Set());
      setCurrentIssueId(initialIssueId);
      setCurrentIssue(null);
      setCurrentIssueKind(null);
      setChangesState([]);
      cursor.current = null;
    }
    void load("replace", controller.signal);
    return () => controller.abort();
  }, [initialIssueId, load, projectId, workspaceId]);


  useEffect(() => {
    if (!currentIssueId || !workspaceId) {
      setCurrentIssue(null);
      setCurrentIssueKind(null);
      return;
    }
    const found = issues.find((issue) => issue.id === currentIssueId);
    if (found) {
      setCurrentIssue(found);
      setCurrentIssueKind("work_item");
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    void pmJson<Entity>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/entities/${encodeURIComponent(currentIssueId)}`, { signal: controller.signal })
      .then((entity) => {
        if (cancelled) return;
        const mapped = mapWithProject(entity);
        setCurrentIssue(mapped);
        setCurrentIssueKind(entity.kind);
        setIssues((previous) => previous.some((issue) => issue.id === mapped.id) ? previous : [...previous, mapped]);
      })
      .catch((cause) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    return () => { cancelled = true; controller.abort(); };
  }, [currentIssueId, issues, mapWithProject, workspaceId]);

  // Publish the resolved PM entry object to the transport bridge. A missing
  // kind never becomes an entity binding; an unresolved hand-off is treated as
  // the task ID PM itself passed in, which is what the create call needs.
  useEffect(() => {
    const resolvedId = currentIssue?.id ?? null;
    const taskId = currentIssueKind === "work_item"
      ? resolvedId
      : currentIssueKind === null
        ? resolvedId ?? initialIssueId
        : null;
    const entityId = initialEntityId ?? (currentIssueKind === "project" ? resolvedId : null);
    setPmChatContext({ taskId, entityId });
  }, [currentIssue, currentIssueKind, initialEntityId, initialIssueId]);

  // Publish only schema-valid reference inputs: unknown project IDs are dropped
  // instead of making the whole chat body fail PM validation.
  useEffect(() => {
    setPmReferences(references.map((reference) => ({
      kind: reference.kind,
      id: reference.id,
      projectId: reference.projectId && /^PRJ-\d+$/.test(reference.projectId) ? reference.projectId : null,
      revision: reference.revision,
    })));
  }, [references]);

  const filteredIssues = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return issues;
    return issues.filter((issue) => [issue.id, issue.title, issue.statusLabel, issue.priority, issue.projectName]
      .some((value) => value?.toLowerCase().includes(needle)));
  }, [issues, query]);

  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const selectVisible = useCallback(() => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      for (const issue of filteredIssues) next.add(issue.id);
      return next;
    });
  }, [filteredIssues]);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const toggleReference = useCallback((issue: PmIssue) => {
    setReferences((previous) => {
      const found = previous.some((reference) => reference.kind === "issue" && reference.id === issue.id);
      if (found) return previous.filter((reference) => !(reference.kind === "issue" && reference.id === issue.id));
      if (previous.length >= PM_REFERENCE_LIMIT) {
        setReferenceError(agentText(`单次最多引用 ${PM_REFERENCE_LIMIT} 个任务；请先移除部分引用。`, `You can reference at most ${PM_REFERENCE_LIMIT} tasks at once; remove some references first.`));
        return previous;
      }
      setReferenceError(null);
      return [...previous, { kind: "issue", id: issue.id, projectId: issue.projectId, title: issue.title, revision: issue.revision, availability: "unverified" }];
    });
  }, []);

  const addSelectedToReferences = useCallback(() => {
    setReferences((previous) => {
      const existing = new Set(previous.map((reference) => `${reference.kind}:${reference.id}`));
      const additions = issues
        .filter((issue) => selectedIds.has(issue.id) && !existing.has(`issue:${issue.id}`))
        .slice(0, Math.max(0, PM_REFERENCE_LIMIT - previous.length))
        .map((issue) => ({ kind: "issue" as const, id: issue.id, projectId: issue.projectId, title: issue.title, revision: issue.revision, availability: "unverified" as const }));
      if (previous.length + additions.length > PM_REFERENCE_LIMIT) setReferenceError(agentText(`单次最多引用 ${PM_REFERENCE_LIMIT} 个任务；超出的任务未加入。`, `You can reference at most ${PM_REFERENCE_LIMIT} tasks at once; the extra tasks were not added.`));
      else setReferenceError(null);
      return [...previous, ...additions];
    });
  }, [issues, selectedIds]);

  const removeReference = useCallback((id: string) => {
    setReferences((previous) => previous.filter((reference) => !(reference.kind === "issue" && reference.id === id)));
    setReferenceError(null);
  }, []);
  const clearReferences = useCallback(() => { setReferences([]); setReferenceError(null); }, []);
  const selectCurrentIssue = useCallback((id: string | null) => setCurrentIssueId(id), []);
  const openPicker = useCallback(() => setPickerOpen(true), []);
  const closePicker = useCallback(() => setPickerOpen(false), []);
  const setChanges = useCallback((next: readonly PmChangeSet[]) => setChangesState(next), []);
  const refresh = useCallback(() => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    void load("replace", controller.signal);
  }, [load]);
  const loadMore = useCallback(() => {
    if (!hasMore || loading) return;
    const controller = new AbortController();
    abort.current = controller;
    void load("append", controller.signal);
  }, [hasMore, load, loading]);

  const value = useMemo<Value>(() => ({
    workspaceId: workspaceId ?? null,
    projectId: projectId ?? null,
    workspaceName,
    projectName,
    issues,
    filteredIssues,
    loading,
    error,
    hasMore,
    query,
    selectedIds,
    references,
    currentIssueId,
    currentIssue,
    changes,
    pickerOpen,
    referenceError,
    setQuery: setQueryState,
    loadMore,
    refresh,
    toggleSelection,
    selectVisible,
    clearSelection,
    addSelectedToReferences,
    toggleReference,
    removeReference,
    clearReferences,
    selectCurrentIssue,
    openPicker,
    closePicker,
    setChanges,
  }), [addSelectedToReferences, changes, clearReferences, clearSelection, closePicker, currentIssue, currentIssueId, error, filteredIssues, hasMore, issues, loadMore, loading, openPicker, pickerOpen, projectId, projectName, query, referenceError, references, refresh, removeReference, selectCurrentIssue, selectVisible, selectedIds, setChanges, toggleReference, toggleSelection, workspaceId, workspaceName]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function usePmIssueWorkspace(): Value {
  const value = useContext(Context);
  if (!value) throw new Error("PmIssueWorkspaceProvider is required inside Agent Chat");
  return value;
}
