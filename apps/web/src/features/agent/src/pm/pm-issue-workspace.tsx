import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { PmToolTarget } from "@agent-workspace/contracts/pm-tools";
import type { Entity } from "../../../../../../../packages/contracts/src/client";
import { pmJson, PmApiError, refreshCatalog, usePmChatState } from "./state";
import type { PmChangeSet, PmIssue, PmReference } from "./pm-types";
import { clearPmReferences, pmReferenceKey, setPmReferences, subscribePmReferenceConsumption } from "./pm-chat-bridge";
import { agentText } from "../i18n-text.ts";

export const PM_REFERENCE_LIMIT = 20;
type Value = {
  workspaceId: string | null; projectId: string | null; workspaceName: string | null; projectName: string | null;
  issues: readonly PmIssue[]; filteredIssues: readonly PmIssue[]; loading: boolean; error: string | null;
  hasMore: boolean; query: string; selectedIds: ReadonlySet<string>; references: readonly PmReference[];
  currentIssueId: string | null; currentIssue: PmIssue | null; changes: readonly PmChangeSet[];
  pickerOpen: boolean; referenceError: string | null;
  setQuery: (value: string) => void; loadMore: () => void; refresh: () => void;
  toggleSelection: (id: string) => void; selectVisible: () => void; clearSelection: () => void;
  addSelectedToReferences: () => void; toggleReference: (issue: PmIssue) => void;
  removeReference: (reference: PmReference) => void; clearReferences: () => void;
  reuseReferences: (references: readonly PmReference[]) => void;
  selectCurrentIssue: (id: string | null) => void; openPicker: () => void; closePicker: () => void;
  selectTarget: (target: PmToolTarget | null) => void; setChanges: (changes: readonly PmChangeSet[]) => void;
};
const Context = createContext<Value | null>(null);
type SearchItem = { id: string; title: string; status: string | null; priority: string | null; projectId: string | null; assigneeId: string | null; dueDate: string | null; revision: string; updatedAt: string | null };
type SearchPage = { items: SearchItem[]; nextCursor: string | null };
const referenceIdentity = (reference: Pick<PmReference, "workspaceId" | "projectId" | "kind" | "id">) => JSON.stringify([reference.workspaceId, reference.projectId, reference.kind, reference.id]);

function readError(error: unknown) {
  return error instanceof PmApiError && [401, 403].includes(error.status)
    ? agentText("PM 登录已过期或无权读取此目标；请重新登录 PM。", "Your PM session expired or this target is unauthorized. Sign in to PM again.")
    : error instanceof Error ? error.message : String(error);
}

export function PmIssueWorkspaceProvider({ workspaceId: entryWorkspaceId, projectId: entryProjectId, initialIssueId = null, initialEntityId = null, referenceKey, localThreadId, children }: {
  workspaceId: string | null; projectId: string | null; initialIssueId?: string | null; initialEntityId?: string | null;
  referenceKey: string; localThreadId: string; children: ReactNode;
}) {
  const chatState = usePmChatState();
  const [target, setTarget] = useState<PmToolTarget | null>(() => entryWorkspaceId ? { workspaceId: entryWorkspaceId, projectId: entryProjectId } : null);
  const workspaceId = target?.workspaceId ?? null, projectId = target?.projectId ?? null;
  const [issues, setIssues] = useState<readonly PmIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [references, setReferences] = useState<readonly PmReference[]>([]);
  const [currentIssueId, setCurrentIssueId] = useState<string | null>(initialIssueId);
  const [changes, setChanges] = useState<readonly PmChangeSet[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const cursor = useRef<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const referenceOwner = useRef<{ key: string; localId: string } | null>(null);
  const skipReferenceSave = useRef(false);
  useEffect(() => { setTarget(entryWorkspaceId ? { workspaceId: entryWorkspaceId, projectId: entryProjectId } : null); }, [entryWorkspaceId, entryProjectId, localThreadId]);
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
      setReferences(Array.isArray(value) ? value.filter((item): item is PmReference => item && typeof item.workspaceId === "string" && typeof item.id === "string" && typeof item.title === "string" && (item.projectId === null || typeof item.projectId === "string") && ["issue", "project", "document"].includes(item.kind)).slice(0, PM_REFERENCE_LIMIT) : []);
    } catch { setReferences([]); setReferenceError(agentText("浏览器无法恢复引用。", "The browser could not restore references.")); }
  }, [referenceKey, localThreadId]);
  useEffect(() => {
    if (skipReferenceSave.current) { skipReferenceSave.current = false; return; }
    try {
      if (references.length) sessionStorage.setItem(`pm-v3:agent-references:${referenceKey}`, JSON.stringify(references));
      else sessionStorage.removeItem(`pm-v3:agent-references:${referenceKey}`);
    } catch { setReferenceError(agentText("浏览器无法保存引用。", "The browser could not save references.")); }
  }, [referenceKey, references]);
  useEffect(() => {
    const unsubscribe = subscribePmReferenceConsumption(localThreadId, consumed => {
      const accepted = new Set(consumed.map(pmReferenceKey));
      setReferences(current => current.filter(reference => !accepted.has(pmReferenceKey(reference))));
    });
    return () => { unsubscribe(); clearPmReferences(localThreadId); };
  }, [localThreadId]);
  useEffect(() => {
    setPmReferences(localThreadId, references.map(({ workspaceId, projectId, kind, id, revision }) => ({ workspaceId, projectId, kind, id, revision })));
  }, [localThreadId, references]);

  const workspace = chatState.catalog?.workspaces.find(item => item.id === workspaceId);
  const projectName = workspace?.projects.find(item => item.id === projectId)?.name ?? null;
  const load = useCallback(async (append: boolean, signal: AbortSignal) => {
    if (!workspaceId) { setIssues([]); setLoading(false); setHasMore(false); return; }
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (projectId) params.set("projectId", projectId);
      if (append && cursor.current) params.set("after", cursor.current);
      if (query.trim()) params.set("q", query.trim());
      const page = await pmJson<SearchPage>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agent-issues?${params}`, { signal });
      if (signal.aborted) return;
      const mapped: PmIssue[] = page.items.map(item => ({ ...item, projectId: item.projectId ?? "", projectName: workspace?.projects.find(project => project.id === item.projectId)?.name, status: item.status ?? "unknown", archived: false }));
      setIssues(previous => [...new Map([...(append ? previous : []), ...mapped].map(issue => [issue.id, issue])).values()]);
      cursor.current = page.nextCursor; setHasMore(page.nextCursor !== null);
    } catch (cause) { if (!signal.aborted) setError(readError(cause)); }
    finally { if (!signal.aborted) setLoading(false); }
  }, [workspaceId, projectId, query, workspace]);
  useEffect(() => {
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    setIssues([]); setSelectedIds(new Set()); cursor.current = null;
    void load(false, controller.signal);
    return () => controller.abort();
  }, [load]);
  // An explicit PM entry may become a message reference, but never Session ownership.
  useEffect(() => {
    const id = initialIssueId ?? initialEntityId;
    if (!entryWorkspaceId || !id) return;
    const controller = new AbortController();
    void pmJson<Entity>(`/api/v1/workspaces/${encodeURIComponent(entryWorkspaceId)}/entities/${encodeURIComponent(id)}`, { signal: controller.signal }).then(entity => {
      if (controller.signal.aborted) return;
      if (!["work_item", "project", "document"].includes(entity.kind)) throw new Error(agentText("此 PM 对象类型不支持消息引用。", "This PM entity type does not support message references."));
      const kind = entity.kind === "work_item" ? "issue" : entity.kind === "project" ? "project" : "document";
      const reference: PmReference = { workspaceId: entryWorkspaceId, projectId: entity.projectId ?? entryProjectId, kind, id: entity.id, title: String(entity.data.title ?? entity.data.name ?? entity.id), revision: entity.data.contentRevision == null ? null : String(entity.data.contentRevision), availability: "unverified" };
      setReferences(previous => previous.some(item => referenceIdentity(item) === referenceIdentity(reference)) ? previous : [...previous, reference].slice(0, PM_REFERENCE_LIMIT));
    }).catch(cause => { if (!controller.signal.aborted) setReferenceError(readError(cause)); });
    return () => controller.abort();
  }, [entryWorkspaceId, entryProjectId, initialIssueId, initialEntityId, localThreadId]);

  const addSelectedToReferences = useCallback(() => {
    if (!workspaceId) return;
    setReferences(previous => {
      const existing = new Set(previous.map(referenceIdentity));
      const additions = issues.filter(issue => selectedIds.has(issue.id)).map((issue): PmReference => ({ workspaceId, projectId: issue.projectId || null, kind: "issue", id: issue.id, title: issue.title, revision: issue.revision, availability: "unverified" })).filter(item => !existing.has(referenceIdentity(item)));
      if (previous.length + additions.length > PM_REFERENCE_LIMIT) setReferenceError(agentText(`单次最多引用 ${PM_REFERENCE_LIMIT} 个对象。`, `At most ${PM_REFERENCE_LIMIT} references per message.`));
      return [...previous, ...additions].slice(0, PM_REFERENCE_LIMIT);
    });
    setSelectedIds(new Set());
  }, [workspaceId, issues, selectedIds]);
  const toggleReference = useCallback((issue: PmIssue) => {
    if (!workspaceId) return;
    const reference: PmReference = { workspaceId, projectId: issue.projectId || null, kind: "issue", id: issue.id, title: issue.title, revision: issue.revision, availability: "unverified" };
    setReferences(previous => previous.some(item => referenceIdentity(item) === referenceIdentity(reference)) ? previous.filter(item => referenceIdentity(item) !== referenceIdentity(reference)) : [...previous, reference].slice(0, PM_REFERENCE_LIMIT));
  }, [workspaceId]);
  const toggleSelection = useCallback((id: string) => setSelectedIds(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; }), []);
  const selectVisible = useCallback(() => setSelectedIds(new Set(issues.map(issue => issue.id))), [issues]);
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);
  const clearReferences = useCallback(() => { setReferences([]); setReferenceError(null); }, []);
  const removeReference = useCallback((reference: PmReference) => { setReferences(previous => previous.filter(item => referenceIdentity(item) !== referenceIdentity(reference))); setReferenceError(null); }, []);
  const reuseReferences = useCallback((next: readonly PmReference[]) => {
    const combined = new Map(references.map(reference => [referenceIdentity(reference), reference]));
    for (const reference of next) combined.set(referenceIdentity(reference), { ...reference, availability: "unverified" });
    setReferenceError(combined.size > PM_REFERENCE_LIMIT ? agentText(`单次最多引用 ${PM_REFERENCE_LIMIT} 个对象。`, `At most ${PM_REFERENCE_LIMIT} references per message.`) : null);
    setReferences([...combined.values()].slice(0, PM_REFERENCE_LIMIT));
  }, [references]);
  const selectTarget = useCallback((next: PmToolTarget | null) => { addSelectedToReferences(); setTarget(next); setQuery(""); setCurrentIssueId(null); }, [addSelectedToReferences]);
  const openPicker = useCallback(() => { setPickerOpen(true); void refreshCatalog().catch(() => {}); }, []);
  const closePicker = useCallback(() => setPickerOpen(false), []);
  const refresh = useCallback(() => { abort.current?.abort(); const controller = new AbortController(); abort.current = controller; void load(false, controller.signal); }, [load]);
  const loadMore = useCallback(() => { if (!hasMore || loading) return; const controller = new AbortController(); abort.current = controller; void load(true, controller.signal); }, [hasMore, loading, load]);
  const value: Value = {
    workspaceId, projectId, workspaceName: workspace?.name ?? null, projectName, issues, filteredIssues: issues, loading, error,
    hasMore, query, selectedIds, references, currentIssueId, currentIssue: issues.find(issue => issue.id === currentIssueId) ?? null,
    changes, pickerOpen, referenceError, setQuery, loadMore, refresh, toggleSelection, selectVisible, clearSelection,
    addSelectedToReferences, toggleReference, removeReference, clearReferences, reuseReferences, selectCurrentIssue: setCurrentIssueId,
    openPicker, closePicker, selectTarget, setChanges,
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function usePmIssueWorkspace(): Value {
  const value = useContext(Context);
  if (!value) throw new Error("PmIssueWorkspaceProvider is required inside Agent Chat");
  return value;
}
