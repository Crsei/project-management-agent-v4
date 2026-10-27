import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useLocation, useSearchParams } from 'react-router';
import { defaultConfiguration, statusCategory, workflowFor, validateTransition, diagnosticsOf, type Diagnostic, type FileRecord, type UnsupportedFile, type ProtocolConfiguration, type WorkspaceSnapshot, type ViewConfig, type Status, type Entity, type EntityKind, type SavedView } from '@pm-schema';
import { validateRelations } from '@pm-schema/relations';
import type { GraphQuery } from '@pm-schema/graph';
import type { QueryExpression } from '@pm-schema/query';
import { parseMarkdown, patchMarkdown } from '@pm-markdown';
import { filterFiles, type ArchiveFilter, type GraphSource, type ViewProps } from '@pm-views';
import { ApiError } from './api';
import { stored, useCoreSession, useCreationDrafts, useSessionDrafts, type CoreSession, type Draft, type Drafts } from './session';
import { hasUncertainProjectTaskDraft, preserveUncertainProjectTaskDrafts, readProjectTaskDraft } from '../service/project-task-editing-model';
import { usePmCommand, usePmService } from '../service/pm-service';
import { allowed } from '../service/pm-ui';
import { hasUncertainCreationDrafts, type CreationInitial } from './creation-model';
import { collectTasks, taskScopes, type TaskCollection, type TaskScope, type TaskScopeCounts } from './task-collection-model';
import { patchTaskDraftRaw, toggleTaskChecklistRaw } from './task-detail-model';
import { patchDocumentDraftRaw } from './document-body';

export type CollectionLayout = ViewConfig['layout'] | 'list' | 'calendar' | 'gantt';
export interface Preferences { entity: EntityKind | ''; layout: CollectionLayout; project: string; priority: string; status: string; sort: string; archived: ArchiveFilter; editorWidth: number; groupBy: 'status' | 'priority' }
export interface ControllerOptions {
  mode?: 'collection' | 'entity' | 'settings';
  en: boolean;
  entityKind: EntityKind | '';
  projectId?: string;
  selectedId: string;
  onSelect: (id: string) => void;
  onInspect?: (id: string) => void;
  onNavigateEntity: (file: FileRecord, anchor?: string) => void;
  layout?: CollectionLayout;
  viewId?: string;
  state?: string;
  mapStatus?: (state: string, configuration: ProtocolConfiguration, kind: EntityKind | '') => string;
  overdue?: boolean;
  initialCreate?: boolean;
  onCreateConsumed?: () => void;
  onCreatePage?: (initial: CreationInitial) => void;
  taskContext?: { scope: TaskScope; actorId: string | null; today: string | null; watched: ReadonlySet<string> | null; error: string; pending: boolean };
  canWrite: boolean;
  canLifecycle: boolean;
}
export interface RevisionConflict { id: string; current: FileRecord; local: string }
export interface WorkspaceController {
  session: CoreSession; query: UseQueryResult<WorkspaceSnapshot, Error>;
  projectId?: string;
  accessError: Error | null;
  handleAccessError: (error: unknown) => void;
  files: FileRecord[]; unsupportedFiles: UnsupportedFile[]; configuration: ProtocolConfiguration; configurationInvalid: boolean;
  prefs: Preferences; setPrefs: Dispatch<SetStateAction<Preferences>>;
  preference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  selectedId: string; selected: FileRecord | undefined; unsupported: UnsupportedFile | undefined; source: FileRecord | UnsupportedFile | undefined;
  draft: Draft | undefined; drafts: Drafts; setDrafts: Dispatch<SetStateAction<Drafts>>; raw: string; entity: Entity | undefined;
  projects: FileRecord[]; projected: FileRecord[]; draftIds: Set<string>; draftDiagnostics: Diagnostic[]; draftInvalid: boolean; ahead: boolean;
  config: ViewConfig; advancedView: ViewConfig | null; matching: FileRecord[]; matchingResult: { files: FileRecord[]; error: string }; viewProps: ViewProps;
  taskCollection: TaskCollection | null; scopeCounts: TaskScopeCounts; scopeError: string; scopePending: boolean; writesBlocked: boolean;
  graphSource: GraphSource; graphQuery: GraphQuery; graphRefreshKey: number;
  search: string; setSearch: Dispatch<SetStateAction<string>>; connection: string; notice: string; setNotice: Dispatch<SetStateAction<string>>;
  creationOutsideScope: string | null;
  error: string; setError: Dispatch<SetStateAction<string>>; busy: string | null; requestDiagnostics: Diagnostic[]; setRequestDiagnostics: Dispatch<SetStateAction<Diagnostic[]>>;
  deleteTarget: FileRecord | null; setDeleteTarget: Dispatch<SetStateAction<FileRecord | null>>; deleteConfirmation: string; setDeleteConfirmation: Dispatch<SetStateAction<string>>;
  conflict: RevisionConflict | null; setConflict: Dispatch<SetStateAction<RevisionConflict | null>>; rebaseReviewed: boolean; setRebaseReviewed: Dispatch<SetStateAction<boolean>>;
  createStatus: Status | undefined | null; creationScope: { kind: EntityKind; project: string; assignee?: string; due?: string; watch?: boolean; priority?: string }; saveViewOpen: boolean; setSaveViewOpen: Dispatch<SetStateAction<boolean>>;
  activeView: SavedView | undefined; context: { id: string; markdown: string } | null; setContext: Dispatch<SetStateAction<{ id: string; markdown: string } | null>>;
  activity: string[]; canWrite: boolean;
  select: (id: string) => void; updateDraft: (raw: string) => void; acceptRecord: (file: FileRecord) => void; removeDraft: (id: string) => void;
  save: () => Promise<void>; canEdit: (id: string, changes?: Record<string, unknown>) => boolean; patch: (id: string, changes: Record<string, unknown>) => Promise<void>;
  canEditSourceDraft: boolean; canEditTaskDraft: boolean; draftParseError: boolean;
  patchTaskDraft: (changes: Record<string, unknown>) => void; toggleTaskChecklist: (line: number) => void;
  patchDocumentDraft: (changes: Record<string, unknown>) => void;
  canManageLifecycle: (id: string) => boolean;
  toggleChecklist: (line: number) => Promise<void>; wikiLink: (target: string) => void;
  openCreate: (status: Status | undefined | null, origin?: ViewConfig, initial?: { assignee?: string; due?: string; watch?: boolean; priority?: string }) => void; acceptCreated: (file: FileRecord) => void;
  lifecycle: (file: FileRecord, action: 'archive' | 'restore' | 'delete') => Promise<void>;
  useView: (view: ViewConfig, saved?: SavedView) => void; acceptView: (view: SavedView) => void; clearView: () => void;
  loadContext: () => Promise<void>; refresh: () => Promise<void>;
}
const defaults: Preferences = { entity: 'work_item', layout: 'list', project: '', priority: '', status: '', sort: '', archived: 'exclude', editorWidth: 43, groupBy: 'status' };
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function parseDraftSource(file: FileRecord | undefined, raw: string, configuration: ProtocolConfiguration): { entity?: Entity; diagnostics: Diagnostic[] } {
  try {
    const entity = parseMarkdown(raw, configuration);
    const immutable = file ? (['id', 'schema', 'entity'] as const).find(field => entity[field] !== file.entity[field]) : undefined;
    if (immutable) return { diagnostics: [{ code: 'IMMUTABLE_FIELD', severity: 'error', path: file?.path || '', entityId: file?.id, field: immutable, message: `The ${immutable} field cannot be changed.` }] };
    return { entity, diagnostics: [] };
  } catch (error) { return { diagnostics: diagnosticsOf(error, { path: file?.path, entityId: file?.id }) }; }
}
function validateDraftSource(file: FileRecord, raw: string, entity: Entity, files: FileRecord[], configuration: ProtocolConfiguration): Diagnostic[] {
  const baseline = validateRelations(files, configuration);
  // Rebuild from source so stale projection diagnostics do not survive a repair.
  const candidates = files.map(candidate => {
    const candidateRaw = candidate.id === file.id ? raw : candidate.raw;
    try {
      return { ...candidate, raw: candidateRaw, entity: parseMarkdown(candidateRaw, configuration), stale: false, error: undefined, diagnostics: [] };
    } catch (error) {
      return { ...candidate, stale: true, diagnostics: diagnosticsOf(error, { path: candidate.path, entityId: candidate.id }) };
    }
  });
  return [...validateTransition(file.entity, entity, configuration), ...validateRelations(candidates, configuration).filter(issue => issue.entityId === file.id || !baseline.some(previous => previous.code === issue.code && previous.entityId === issue.entityId && previous.field === issue.field && previous.targetId === issue.targetId))];
}

export function useWorkspaceController(options: ControllerOptions): WorkspaceController {
  const session = useCoreSession();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const projectFilter = options.mode === 'collection' && !options.projectId ? params.get('project') : null;
  const { coreEvents, workspace, actor, capabilities } = usePmService();
  const { api, queryKey, onAccessFailure } = session;
  const client = useQueryClient();
  const [blockedAccess, setBlockedAccess] = useState<Error | null>(null);
  const query = useQuery({ queryKey, queryFn: ({ signal }) => api.workspace(signal), enabled: !blockedAccess, retry: false, refetchOnWindowFocus: true });
  const accessError = blockedAccess || (query.error instanceof ApiError && [401, 403, 404].includes(query.error.status) ? query.error : null);
  const snapshot = accessError ? undefined : query.data;
  const files = snapshot?.files || [];
  const unsupportedFiles = snapshot?.unsupportedFiles || [];
  const configuration = snapshot?.configuration || defaultConfiguration;
  const configurationInvalid = !!snapshot?.configurationErrors.some(issue => issue.severity === 'error');
  const blockAccess = useCallback((error: Error) => {
    setBlockedAccess(error);
    void client.cancelQueries({ queryKey, exact: true }).then(() => client.removeQueries({ queryKey, exact: true }));
    void onAccessFailure().catch(() => {});
  }, [client, queryKey, onAccessFailure]);
  const handleAccessError = useCallback((error: unknown) => {
    if (error instanceof ApiError && [401, 403].includes(error.status)) blockAccess(error);
  }, [blockAccess]);
  const graphSource = useCallback<GraphSource>(async (input, signal) => {
    try { return await api.graph(input, signal); }
    catch (error) {
      if (signal?.aborted) throw error;
      handleAccessError(error);
      if (error instanceof ApiError && error.status === 404) {
        // A missing center does not prove that workspace access was revoked.
        // Verify the workspace before clearing access, and replace a vanished
        // center only once so the refresh key cannot produce a refetch loop.
        try {
          const current = await api.workspace(signal);
          if (signal?.aborted) throw error;
          if (input.centerId && !current.files.some(file => file.id === input.centerId)
            && client.getQueryData<WorkspaceSnapshot>(queryKey)?.files.some(file => file.id === input.centerId)) {
            client.setQueryData(queryKey, current);
          }
        } catch (workspaceError) {
          if (!signal?.aborted && workspaceError instanceof ApiError && [401, 403, 404].includes(workspaceError.status)) blockAccess(workspaceError);
        }
      }
      throw error;
    }
  }, [api, client, queryKey, blockAccess, handleAccessError]);
  useEffect(() => {
    if (!accessError || blockedAccess) return;
    blockAccess(accessError);
  }, [accessError, blockedAccess, blockAccess]);
  const preferenceKey = session.storageKey(options.projectId ? `project:${options.projectId}:preferences` : 'preferences');
  const searchKey = session.storageKey(options.projectId ? `project:${options.projectId}:search` : 'search');
  const [storedPrefs, setPrefs] = useState<Preferences>(() => ({ ...defaults, ...stored<Partial<Preferences>>(preferenceKey, {}), entity: options.entityKind, project: options.projectId || projectFilter || '', ...(options.layout ? { layout: options.layout } : {}) }));
  // Route scope is an invariant, including when a saved view or restored context changes preferences.
  const taskCollectionMode = !!options.taskContext;
  const prefs = useMemo(() => ({ ...storedPrefs, sort: storedPrefs.sort || (options.taskContext?.scope === 'mine' && !options.projectId ? 'due' : 'id'), ...(options.projectId ? { project: options.projectId } : projectFilter !== null ? { project: projectFilter } : {}), ...(taskCollectionMode ? { entity: 'work_item' as const } : {}) }), [storedPrefs, options.projectId, projectFilter, taskCollectionMode, options.taskContext?.scope]);
  const selectedId = options.selectedId;
  const [drafts, updateSessionDrafts] = useSessionDrafts();
  const nativeWriteUncertain = hasUncertainProjectTaskDraft(drafts);
  const [creationDrafts] = useCreationDrafts();
  const command = usePmCommand();
  const creationWriteUncertain = hasUncertainCreationDrafts(creationDrafts);
  const writesBlocked = nativeWriteUncertain || creationWriteUncertain || command.pending || !!command.unknownCommand;
  const setDrafts = useCallback<Dispatch<SetStateAction<Drafts>>>(next => updateSessionDrafts(previous => preserveUncertainProjectTaskDrafts(previous, typeof next === 'function' ? next(previous) : next)), [updateSessionDrafts]);
  const [search, setSearch] = useState(() => stored(searchKey, ''));
  const [connection, setConnection] = useState('Connecting');
  const [notice, setNotice] = useState('');
  const [creationFeedback, setCreationFeedback] = useState<{ id: string; message: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [requestDiagnostics, setRequestDiagnostics] = useState<Diagnostic[]>([]);
  const rejectedTaskFieldsRef = useRef<Record<string, Record<string, Diagnostic[]>>>({});
  const [rejectedTaskFields, setRejectedTaskFields] = useState(rejectedTaskFieldsRef.current);
  const [deleteTarget, setDeleteTarget] = useState<FileRecord | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [conflict, setConflict] = useState<RevisionConflict | null>(null);
  const [rebaseReviewed, setRebaseReviewed] = useState(false);
  const [createStatus, setCreateStatus] = useState<Status | undefined | null>(null);
  const [creationScope, setCreationScope] = useState<WorkspaceController['creationScope']>({ kind: options.entityKind || 'work_item', project: options.projectId || '' });
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const [advancedView, setAdvancedView] = useState<ViewConfig | null>(null);
  const [activeView, setActiveView] = useState<SavedView | undefined>();
  const [context, setContext] = useState<{ id: string; markdown: string } | null>(null);
  const [activity, setActivity] = useState<string[]>([]);
  const selected = files.find(f => f.id === selectedId);
  const unsupported = unsupportedFiles.find(f => `source:${f.path}` === selectedId || f.id === selectedId);
  const source = unsupported || selected;
  const draft = drafts[selectedId];
  const selectedTaskAttempt = readProjectTaskDraft(draft);
  const raw = unsupported ? unsupported.raw : draft?.raw ?? selected?.raw ?? '';
  const parsed = useMemo<{ entity?: Entity; diagnostics: Diagnostic[] }>(() => unsupported || !source ? { diagnostics: [] } : parseDraftSource(selected, raw, configuration), [raw, selected, unsupported, source, configuration]);
  const draftParseError = !!source && !parsed.entity;
  const entity = unsupported ? undefined : parsed.entity || selected?.entity;
  const projects = files.filter(f => f.entity.entity === 'project');
  const draftIds = useMemo(() => new Set(Object.keys(drafts)), [drafts]);
  const projected = useMemo(() => files.map(file => { const d = drafts[file.id]; if (!d) return file; try { const e = parseMarkdown(d.raw, configuration); return e.id === file.id ? { ...file, entity: e, raw: d.raw } : file; } catch { return file; } }), [files, drafts, configuration]);
  const draftDiagnostics = useMemo(() => {
    const rejected = Object.values(rejectedTaskFields[selectedId] || {}).flat();
    if (!draft || !selected || unsupported) return rejected;
    if (!parsed.entity) return [...rejected, ...parsed.diagnostics];
    return [...rejected, ...parsed.diagnostics, ...validateDraftSource(selected, raw, parsed.entity, files, configuration)];
  }, [draft, selected, selectedId, unsupported, parsed, files, raw, configuration, rejectedTaskFields]);
  const draftInvalid = writesBlocked || configurationInvalid || draftDiagnostics.some(issue => issue.severity === 'error');
  const stateFilter = options.state ? options.mapStatus?.(options.state, configuration, prefs.entity) || options.state : '';
  const config = useMemo<ViewConfig>(() => ({
    ...advancedView, entity: options.taskContext ? 'work_item' : prefs.entity || undefined, project: prefs.project || undefined,
    layout: ['list', 'calendar', 'gantt'].includes(prefs.layout) ? 'table' : prefs.layout as ViewConfig['layout'],
    ...(prefs.layout === 'list' ? { columns: prefs.entity === 'work_item' ? ['status', 'priority', 'assignee', 'due'] : prefs.entity === 'document' ? ['document_kind'] : prefs.entity ? ['status', 'due'] : ['entity'] } : {}),
    group_by: advancedView?.group_by || (prefs.entity === 'work_item' ? prefs.groupBy || 'status' : prefs.entity === 'document' ? 'document_kind' : 'status'),
    filter: { ...advancedView?.filter, ...(prefs.priority ? { priority: prefs.priority } : {}), ...(prefs.status ? { status: prefs.status } : {}), ...(stateFilter ? { status: stateFilter } : {}) }, sort: prefs.sort,
  }), [prefs, advancedView, stateFilter, options.taskContext]);
  const matchingResult = useMemo(() => {
    try {
      // Explicit embedded previews use projected; collection task counts and grouping use saved records.
      const collectionFiles = options.taskContext || prefs.layout === 'graph' ? files : files.map((file, index) => file.entity.entity === 'work_item' ? file : projected[index]!);
      const scopedFiles = options.projectId ? collectionFiles.filter(file => file.entity.entity === 'project' ? file.id === options.projectId : file.entity.project === options.projectId) : collectionFiles;
      const candidates = filterFiles(scopedFiles, config, search, prefs.archived, configuration);
      const today = options.taskContext?.today;
      if (options.overdue && !today) return { files: [], error: '' };
      return { files: options.overdue ? candidates.filter(file => !!file.entity.due && file.entity.due < today! && !['completed', 'canceled'].includes(statusCategory(file.entity, configuration) || '')) : candidates, error: '' };
    } catch (error) { return { files: [], error: message(error) }; }
  }, [files, projected, config, search, prefs.archived, prefs.layout, configuration, options.overdue, options.taskContext, options.projectId]);
  const taskCollection = useMemo(() => options.taskContext ? collectTasks(matchingResult.files, options.projectId ? 'all' : options.taskContext.scope, options.taskContext.today, options.taskContext.watched, configuration, options.taskContext.actorId) : null, [matchingResult.files, options.taskContext, options.projectId, configuration]);
  const scopeError = options.taskContext?.error || '';
  const scopePending = options.taskContext?.pending || false;
  const matching = scopeError || scopePending ? [] : taskCollection?.files || matchingResult.files;
  const scopeCounts = useMemo<TaskScopeCounts>(() => Object.fromEntries(taskScopes.map(scope => [scope, options.overdue && !options.taskContext?.today || scope === 'important' && !options.taskContext?.watched || scope === 'mine' && (!options.taskContext?.today || !options.taskContext.actorId) ? null : collectTasks(matchingResult.files, scope, options.taskContext?.today || null, options.taskContext?.watched || null, configuration, options.taskContext?.actorId).files.length])) as TaskScopeCounts, [matchingResult.files, options.overdue, options.taskContext, configuration]);
  const graphQuery = useMemo<GraphQuery>(() => {
    let scoped: QueryExpression | undefined;
    if (options.taskContext) {
      const ids = scopeError || scopePending ? [] : taskCollection?.open.map(file => file.id) || [];
      const chunks: QueryExpression[] = [];
      for (let index = 0; index < ids.length; index += 256) chunks.push({ field: 'id', op: 'in', value: ids.slice(index, index + 256) });
      scoped = { any: chunks };
    }
    return { view: scoped ? { ...config, where: config.where ? { all: [config.where, scoped] } : scoped } : config, search, archived: prefs.archived };
  }, [config, search, prefs.archived, options.taskContext, taskCollection, scopeError, scopePending]);
  const graphRefreshKey = query.dataUpdatedAt;
  const ahead = !!draft && !!selected && !unsupported && draft.revision !== selected.revision;
  useEffect(() => {
    if (options.mode !== 'collection') return;
    try { localStorage.setItem(preferenceKey, JSON.stringify({ ...prefs, sort: storedPrefs.sort })); localStorage.setItem(searchKey, JSON.stringify(search)); } catch { /* Draft persistence is monitored separately. */ }
  }, [prefs, storedPrefs.sort, search, preferenceKey, searchKey, options.mode]);
  useEffect(() => { if (session.drafts.persistenceError()) setError('Local draft backup is unavailable. Keep this tab open until saved.'); }, [drafts, session]);
  useEffect(() => { setPrefs(old => ({ ...old, entity: options.entityKind, project: options.projectId || projectFilter || '' })); }, [options.entityKind, options.projectId, projectFilter]);
  useEffect(() => { if (options.layout) setPrefs(old => ({ ...old, layout: options.layout! })); }, [options.layout]);
  useEffect(() => {
    if (selectedId) session.detail.update(old => old.entityId === selectedId ? old : { entityId: selectedId, tab: 'content' });
  }, [selectedId, session]);
  useEffect(() => {
    // Never treat a not-yet-loaded workspace as an empty one: doing so would
    // delete recovered drafts before the first authoritative snapshot arrives.
    if (!query.isSuccess) return;
    const visible = new Set([...files.map(file => file.id), ...unsupportedFiles.map(file => file.id ?? `source:${file.path}`)]);
    updateSessionDrafts(old => {
      const next = Object.fromEntries(Object.entries(old).filter(([id]) => visible.has(id)));
      return Object.keys(next).length === Object.keys(old).length ? old : next;
    });
  }, [files, unsupportedFiles, query.isSuccess]);
  useEffect(() => {
    if (conflict && unsupportedFiles.some(file => file.id === conflict.id || file.path === conflict.current.path)) {
      setDrafts(old => ({ ...old, [conflict.id]: { raw: conflict.local, revision: old[conflict.id]?.revision || conflict.current.revision } }));
      setConflict(null);
    }
  }, [conflict, unsupportedFiles]);
  useEffect(() => {
    if (!coreEvents) { setConnection('Connecting'); return; }
    // The provider owns one native stream per session; a second stream here
    // exhausts HTTP/1.1 connection slots when two workbench tabs are open.
    const ready = () => setConnection('Live sync');
    const change = () => { void client.invalidateQueries({ queryKey }); setActivity(old => [`${new Date().toLocaleTimeString()} · Workspace updated from disk`, ...old].slice(0, 8)); };
    const error = () => { setConnection(coreEvents.readyState === EventSource.OPEN ? 'Index warning' : 'Reconnecting'); void client.invalidateQueries({ queryKey }); };
    setConnection(coreEvents.readyState === EventSource.OPEN ? 'Live sync' : 'Connecting');
    coreEvents.addEventListener('ready', ready);
    coreEvents.addEventListener('open', ready);
    coreEvents.addEventListener('change', change);
    coreEvents.addEventListener('error', error);
    return () => {
      coreEvents.removeEventListener('ready', ready);
      coreEvents.removeEventListener('open', ready);
      coreEvents.removeEventListener('change', change);
      coreEvents.removeEventListener('error', error);
    };
  }, [client, coreEvents, queryKey]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timer); }, [notice]);
  function preference<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    if (key === 'project' && !options.projectId) {
      const next = new URLSearchParams(params);
      if (value) next.set('project', String(value)); else next.delete('project');
      setParams(next, { state: location.state });
    }
    setPrefs(old => ({ ...old, [key]: value }));
    if (key === 'groupBy') setAdvancedView(old => old ? { ...old, group_by: String(value) } : old);
  }
  const select = useCallback((id: string) => { options.onSelect(id); setError(''); setRequestDiagnostics([]); }, [options.onSelect]);
  const inspect = useCallback((id: string) => { (options.onInspect ?? options.onSelect)(id); setError(''); setRequestDiagnostics([]); }, [options.onInspect, options.onSelect]);
  function taskPatchIssues(id: string, fields?: string[], diagnostics: Diagnostic[] = []) {
    const previous = rejectedTaskFieldsRef.current;
    if (!previous[id] && !diagnostics.length) return;
    const issues: Record<string, Diagnostic[]> = fields ? { ...previous[id] } : {};
    for (const field of fields || []) {
      delete issues[field];
      if (diagnostics.length) issues[field] = diagnostics;
    }
    const next = { ...previous };
    if (Object.keys(issues).length) next[id] = issues;
    else delete next[id];
    rejectedTaskFieldsRef.current = next;
    setRejectedTaskFields(next);
  }
  function sourceDraftWritable() {
    return !!selected && !unsupported && options.canWrite && !selected.entity.archived && !busy && !accessError && !query.isError && !configurationInvalid && !ahead && conflict?.id !== selected.id && !writesBlocked && !hasUncertainProjectTaskDraft(session.drafts.getSnapshot()) && !hasUncertainCreationDrafts(session.creationDrafts.getSnapshot()) && !command.pending && !command.unknownCommand;
  }
  const canEditSourceDraft = sourceDraftWritable();
  function updateDraft(value: string) {
    if (!selected || !sourceDraftWritable()) return;
    setDrafts(old => { const next = { ...old }; if (value === selected.raw) delete next[selected.id]; else next[selected.id] = { raw: value, revision: old[selected.id]?.revision || selected.revision }; return next; });
    if (selected.entity.entity === 'work_item') taskPatchIssues(selected.id);
    setError(''); setRequestDiagnostics([]);
  }
  function acceptRecord(file: FileRecord) { client.setQueryData<WorkspaceSnapshot>(queryKey, old => old ? { ...old, files: old.files.some(f => f.id === file.id) ? old.files.map(f => f.id === file.id ? file : f) : [...old.files, file], unsupportedFiles: old.unsupportedFiles.filter(f => f.path !== file.path) } : { files: [file], errors: [], views: [], unsupportedFiles: [], configuration, configurationRevision: 'absent', configurationErrors: [] }); }
  function removeDraft(id: string) { setDrafts(old => { const next = { ...old }; delete next[id]; return next; }); taskPatchIssues(id); }
  function reportError(error: unknown) {
    setError(message(error));
    setRequestDiagnostics(error instanceof ApiError ? error.diagnostics : diagnosticsOf(error));
    handleAccessError(error);
  }
  async function handleError(e: unknown, id: string, local: string) {
    reportError(e);
    if (e instanceof ApiError && e.status === 409 && e.diagnostics.some(issue => issue.code === 'REVISION_CONFLICT')) {
      try {
        const current = e.current || await api.file(id);
        if (!('entity' in current)) { void client.invalidateQueries({ queryKey }); return; }
        acceptRecord(current); setDrafts(old => ({ ...old, [id]: old[id] || { raw: local, revision: files.find(f => f.id === id)?.revision || '' } })); setRebaseReviewed(false); setConflict({ id, current, local: session.drafts.getSnapshot()[id]?.raw ?? local });
      } catch (fetchError) { reportError(fetchError); }
    }
  }
  async function save() {
    if (!selected || unsupported || busy || !options.canWrite || writesBlocked || accessError || query.isError || hasUncertainProjectTaskDraft(session.drafts.getSnapshot()) || hasUncertainCreationDrafts(session.creationDrafts.getSnapshot()) || command.pending || command.unknownCommand) return;
    const current = client.getQueryData<WorkspaceSnapshot>(queryKey);
    const file = current?.files.find(file => file.id === selected.id);
    const savingDraft = session.drafts.getSnapshot()[selected.id];
    if (!current || !file || !savingDraft || file.entity.archived || current.configurationErrors.some(issue => issue.severity === 'error') || current.unsupportedFiles.some(source => source.id === file.id || source.path === file.path)) return;
    if (savingDraft.revision !== file.revision) { setRebaseReviewed(false); setConflict({ id: file.id, current: file, local: savingDraft.raw }); return; }
    const parsed = parseDraftSource(file, savingDraft.raw, current.configuration);
    const diagnostics = [...(file.entity.entity === 'work_item' ? Object.values(rejectedTaskFieldsRef.current[file.id] || {}).flat() : []), ...parsed.diagnostics, ...(parsed.entity ? validateDraftSource(file, savingDraft.raw, parsed.entity, current.files, current.configuration) : [])];
    if (diagnostics.some(issue => issue.severity === 'error')) { setRequestDiagnostics(diagnostics); setError('Repair the Markdown draft before saving.'); return; }
    setBusy(file.id); setError(''); setRequestDiagnostics([]);
    const saving = savingDraft.raw;
    try { const saved = await api.save(file.id, saving, savingDraft.revision); acceptRecord(saved); setDrafts(old => { const next = { ...old }; if (next[file.id]?.raw === saving) delete next[file.id]; else if (next[file.id]) next[file.id] = { ...next[file.id], revision: saved.revision }; return next; }); setNotice(`${saved.id} saved to Markdown`); }
    catch (e) { await handleError(e, file.id, saving); }
    finally { setBusy(null); }
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); void save(); }
      const target = event.target as HTMLElement;
      if (event.key === '/' && !event.metaKey && !event.ctrlKey && !target.isContentEditable && !['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('[aria-label="Search work items"]')?.focus();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  const canMutate = (id: string) => !writesBlocked && !hasUncertainProjectTaskDraft(session.drafts.getSnapshot()) && !hasUncertainCreationDrafts(session.creationDrafts.getSnapshot()) && !accessError && !query.isError && !configurationInvalid && !busy && !drafts[id] && !!files.find(file => file.id === id && !file.stale) && !unsupportedFiles.some(file => file.id === id);
  const canEdit = (id: string, changes?: Record<string, unknown>) => {
    const file = files.find(file => file.id === id);
    if (!file || file.entity.archived || !canMutate(id)) return false;
    if (file.entity.entity !== 'work_item' || !changes || Object.keys(changes).length !== 1 || typeof changes.status !== 'string') return options.canWrite;
    if (!actor || capabilities?.business.enabled !== true) return false;
    const workflow = workflowFor('work_item', configuration);
    const before = workflow?.states.find(state => state.id === file.entity.status);
    const after = workflow?.states.find(state => state.id === changes.status);
    if (!before || !after || !workflow?.transitions.some(transition => transition.from === before.id && transition.to === after.id)) return false;
    // Match core-routes status authorization without requiring planning.edit for completion/reopen.
    const capability = after.category === 'completed' ? 'workitem.complete'
      : after.category === 'canceled' || before.category === 'completed' || before.category === 'canceled' ? 'workitem.cancel_reopen' : 'planning.edit';
    return allowed(workspace, capability, file.entity.project);
  };
  const canManageLifecycle = (id: string) => options.canLifecycle && canMutate(id);
  function taskDraftSource() {
    const current = client.getQueryData<WorkspaceSnapshot>(queryKey);
    if (!current || !options.canWrite || busy || accessError || query.isError || writesBlocked || command.pending || command.unknownCommand || hasUncertainProjectTaskDraft(session.drafts.getSnapshot()) || hasUncertainCreationDrafts(session.creationDrafts.getSnapshot()) || current.configurationErrors.some(issue => issue.severity === 'error')) return;
    const file = current.files.find(file => file.id === selectedId && file.entity.entity === 'work_item');
    if (!file || file.stale || file.entity.archived || current.unsupportedFiles.some(source => source.id === file.id || source.path === file.path)) return;
    return { file, configuration: current.configuration };
  }
  const canEditTaskDraft = !!taskDraftSource() && !!parsed.entity && !parsed.entity.archived && !ahead;
  function editTaskDraft(edit: (file: FileRecord, raw: string, configuration: ProtocolConfiguration) => string): boolean {
    const source = taskDraftSource();
    if (!source) return false;
    const { file, configuration } = source;
    let accepted = false;
    setDrafts(old => {
      if (hasUncertainProjectTaskDraft(old)) return old;
      const latest = old[file.id];
      if (latest && latest.revision !== file.revision) throw new Error('The source revision changed. Compare versions before editing task fields.');
      const base = latest?.raw ?? file.raw;
      const raw = edit(file, base, configuration);
      accepted = true;
      if (raw === base) return old;
      const next = { ...old };
      if (raw === file.raw) delete next[file.id];
      else next[file.id] = { raw, revision: latest?.revision ?? file.revision };
      return next;
    });
    return accepted;
  }
  function patchTaskDraft(changes: Record<string, unknown>) {
    try {
      if (!editTaskDraft((file, raw, configuration) => patchTaskDraftRaw(file, raw, changes, configuration))) return;
      taskPatchIssues(selectedId, Object.keys(changes));
      setError(''); setRequestDiagnostics([]);
    } catch (error) {
      taskPatchIssues(selectedId, Object.keys(changes), diagnosticsOf(error));
      reportError(error);
    }
  }
  function toggleTaskChecklist(line: number) {
    const expectedLine = raw.split('\n')[line - 1] || '';
    try {
      if (editTaskDraft((file, raw, configuration) => toggleTaskChecklistRaw(file, raw, line, configuration, expectedLine))) { setError(''); setRequestDiagnostics([]); }
    } catch (error) { reportError(error); }
  }
  function patchDocumentDraft(changes: Record<string, unknown>) {
    try {
      if (!selected || !sourceDraftWritable()) return;
      const current = client.getQueryData<WorkspaceSnapshot>(queryKey);
      const file = current?.files.find(file => file.id === selectedId && file.entity.entity === 'document');
      if (!current || !file || file.stale || file.entity.archived || current.configurationErrors.some(issue => issue.severity === 'error') || current.unsupportedFiles.some(source => source.id === file.id || source.path === file.path)) return;
      if (file.revision !== selected.revision) throw new Error('The source revision changed. Compare versions before editing document properties.');
      setDrafts(old => {
        const latest = old[file.id];
        if (latest && latest.revision !== file.revision) throw new Error('The source revision changed. Compare versions before editing document properties.');
        const base = latest?.raw ?? file.raw;
        const patched = patchDocumentDraftRaw(file, base, changes, current.configuration);
        if (patched === base) return old;
        const next = { ...old };
        if (patched === file.raw) delete next[file.id];
        else next[file.id] = { raw: patched, revision: latest?.revision ?? file.revision };
        return next;
      });
      setError(''); setRequestDiagnostics([]);
    } catch (error) { reportError(error); }
  }
  async function patch(id: string, changes: Record<string, unknown>) {
    const file = files.find(f => f.id === id); if (!file || !canEdit(id, changes)) return;
    setBusy(id); setError(''); setRequestDiagnostics([]);
    try { acceptRecord(await api.patch(id, changes, file.revision)); setNotice(`${id} updated · Markdown saved`); }
    catch (e) { let local = file.raw; try { local = patchMarkdown(file.raw, changes, configuration); } catch { /* The API returns the authoritative validation message. */ } await handleError(e, id, local); }
    finally { setBusy(null); }
  }
  async function toggleChecklist(line: number) {
    if (!selected || !canEdit(selected.id)) return;
    const lines = selected.raw.split('\n');
    if (!/^\s*(?:[-+*]|\d+[.)])\s+\[[ xX]\]/.test(lines[line - 1] || '')) { setError('This checklist line moved. Refresh the preview before editing.'); return; }
    lines[line - 1] = lines[line - 1].replace(/\[([ xX])\]/, (_, checked: string) => checked === ' ' ? '[x]' : '[ ]');
    const next = lines.join('\n'); setBusy(selected.id);
    try { acceptRecord(await api.save(selected.id, next, selected.revision)); setNotice('Checklist saved to Markdown'); } catch (e) { await handleError(e, selected.id, next); } finally { setBusy(null); }
  }
  function wikiLink(target: string) {
    const separator = target.indexOf('#');
    const identity = separator < 0 ? target : target.slice(0, separator);
    const anchor = separator < 0 ? undefined : target.slice(separator + 1);
    const future = unsupportedFiles.find(f => f.id === identity || f.path.replace(/\.md$/, '').split('/').pop() === identity);
    if (future) { select(`source:${future.path}`); return; }
    const file = files.find(f => f.id === identity || f.entity.title === identity || f.path.replace(/\.md$/, '').split('/').pop() === identity);
    if (!file) { setError(`Unresolved wikilink: ${target}`); return; }
    setError('');
    setRequestDiagnostics([]);
    options.onNavigateEntity(file, anchor);
  }
  function openCreate(status: Status | undefined | null, origin?: ViewConfig, initial?: { assignee?: string; due?: string; watch?: boolean; priority?: string }) {
    if (status !== null && !options.canWrite) return;
    if (status !== null) {
      const scope = { kind: origin ? origin.entity || 'work_item' : prefs.entity || 'work_item', project: options.projectId || (origin ? origin.project || '' : prefs.project), ...(!options.projectId && options.taskContext?.scope === 'mine' && options.taskContext.actorId ? { assignee: options.taskContext.actorId } : {}), ...(!options.projectId && options.taskContext?.scope === 'important' ? { watch: true } : {}), ...(origin?.group_by === 'priority' && typeof origin.filter?.priority === 'string' ? { priority: origin.filter.priority } : {}), ...initial };
      if (scope.kind === 'work_item' && options.onCreatePage) {
        options.onCreatePage({ ...scope, entity: 'work_item', status });
        return;
      }
      setCreationScope(scope);
    }
    setCreateStatus(status); setError(''); setRequestDiagnostics([]);
  }
  const viewProps: ViewProps = { files: matching, allFiles: config.layout === 'graph' ? files : projected, config, configuration, archiveFilter: prefs.archived, selectedId, draftIds, graphSource, graphQuery, graphRefreshKey, en: options.en, canEdit, onSelect: select, onInspect: inspect, onOpenPage: id => { const file = files.find(candidate => candidate.id === id); if (file) options.onNavigateEntity(file); }, onPatch: patch, onCreate: options.canWrite ? openCreate : undefined, onMove: options.canWrite && activeView && !configurationInvalid && !busy && !writesBlocked && (!options.taskContext || options.taskContext.scope === 'all') ? moveItem : undefined };
  async function lifecycle(file: FileRecord, action: 'archive' | 'restore' | 'delete') {
    if (!canManageLifecycle(file.id)) return;
    setBusy(file.id); setError(''); setRequestDiagnostics([]);
    try {
      if (action === 'delete') {
        await api.delete(file.id, file.revision);
        client.setQueryData<WorkspaceSnapshot>(queryKey, old => old ? { ...old, files: old.files.filter(f => f.id !== file.id) } : old);
        setDeleteTarget(null); setDeleteConfirmation(''); if (selectedId === file.id) select('');
      } else acceptRecord(await api[action](file.id, file.revision));
      setNotice(`${file.id} ${action === 'delete' ? 'permanently deleted' : action === 'archive' ? 'archived' : 'restored'}`);
      void client.invalidateQueries({ queryKey });
    } catch (e) { reportError(e); void client.invalidateQueries({ queryKey }); }
    finally { setBusy(null); }
  }
  function acceptCreated(file: FileRecord) {
    acceptRecord(file); select(file.id); setCreateStatus(null);
    let included = true;
    try { included = filterFiles([file], config, search, prefs.archived, configuration).length > 0 && (!options.taskContext || collectTasks([file], options.projectId ? 'all' : options.taskContext.scope, options.taskContext.today, options.taskContext.watched, configuration, options.taskContext.actorId).files.length > 0); } catch { included = false; }
    const feedback = included ? `${file.id} ${options.en ? 'created in Markdown' : '已写入 Markdown'}` : `${file.id} ${options.en ? 'created, but outside this scope or filter. The new task is open.' : '已创建，但不在当前范围或筛选中；已打开新任务。'}`;
    setNotice(feedback);
    setCreationFeedback(included ? null : { id: file.id, message: feedback });
  }
  function useView(view: ViewConfig, saved?: SavedView) {
    setAdvancedView(view); setActiveView(saved); setPrefs(old => ({ ...old, entity: options.taskContext ? 'work_item' : view.entity || '', layout: view.layout, project: options.projectId || view.project || '', priority: '', status: '', sort: view.sort || '', groupBy: view.group_by === 'priority' ? 'priority' : 'status' }));
  }
  function acceptView(view: SavedView) {
    client.setQueryData<WorkspaceSnapshot>(queryKey, old => old ? { ...old, views: [...old.views.filter(item => item.id !== view.id), view] } : old);
    useView(view, view); setSaveViewOpen(false); setNotice('View saved with revision protection');
  }
  async function moveItem(id: string, direction: -1 | 1) {
    if (busy || configurationInvalid || !options.canWrite || writesBlocked || options.taskContext && options.taskContext.scope !== 'all' || hasUncertainProjectTaskDraft(session.drafts.getSnapshot()) || hasUncertainCreationDrafts(session.creationDrafts.getSnapshot())) return;
    if (!activeView) { setNotice('Save this view first to persist manual ordering.'); setSaveViewOpen(true); return; }
    const index = matching.findIndex(file => file.id === id); const neighbor = matching[index + direction];
    if (!neighbor) return;
    const order = [...new Set([...(activeView.order || []), ...matching.map(file => file.id)])];
    const from = order.indexOf(id), to = order.indexOf(neighbor.id);
    [order[from], order[to]] = [order[to], order[from]];
    setBusy('view'); setError('');
    try {
      const { id: viewId, revision, name, ...definition } = activeView;
      const view = await api.saveView(viewId, { ...definition, order, name, revision });
      client.setQueryData<WorkspaceSnapshot>(queryKey, old => old ? { ...old, views: [...old.views.filter(item => item.id !== view.id), view] } : old);
      setActiveView(view);
      setAdvancedView(old => ({ ...(old || definition), order }));
      setNotice('Manual order saved; temporary filters remain unchanged');
    }
    catch (error) { reportError(error); }
    finally { setBusy(null); }
  }
  const requestedView = useRef('');
  useEffect(() => {
    if (!options.viewId) { requestedView.current = ''; return; }
    if (!query.isSuccess || requestedView.current === options.viewId) return;
    const view = query.data.views.find(item => item.id === options.viewId);
    if (view) { requestedView.current = options.viewId; useView(view, view); if (options.layout) setPrefs(old => ({ ...old, layout: options.layout! })); }
  }, [options.viewId, query.data, query.isSuccess]);
  const createRequested = useRef(false);
  useEffect(() => {
    if (!options.initialCreate) { createRequested.current = false; return; }
    if (!createRequested.current && query.isSuccess && options.canWrite) {
      createRequested.current = true;
      openCreate(workflowFor(options.entityKind || 'work_item', configuration)?.initial);
      options.onCreateConsumed?.();
    }
  }, [options.initialCreate, options.entityKind, options.canWrite, query.isSuccess, configuration]);
  async function loadContext() {
    if (!selected) return;
    try { setContext(await api.context(selected.id)); }
    catch (error) { reportError(error); }
  }
  function clearView() { setAdvancedView(null); setActiveView(undefined); setPrefs(old => ({ ...old, priority: '', status: '', sort: '' })); }
  async function refresh() { setBlockedAccess(null); await client.invalidateQueries({ queryKey }); }
  return {
    projectId: options.projectId,
    session, query, accessError, handleAccessError, files, unsupportedFiles, configuration, configurationInvalid, prefs, setPrefs, preference,
    selectedId, selected, unsupported, source, draft, drafts, setDrafts, raw, entity, projects, projected, draftIds,
    draftDiagnostics, draftInvalid, ahead, config, advancedView, matching, matchingResult, viewProps, taskCollection, scopeCounts, scopeError, scopePending, writesBlocked, graphSource, graphQuery, graphRefreshKey, search, setSearch,
    connection, notice, setNotice, error: nativeWriteUncertain ? 'A project task write has an uncertain result. Return to its project to read the authoritative source, then deliberately adopt or discard the retained fields. Writes and editing are locked until recovery; local drafts are retained.' : error, setError, busy, requestDiagnostics, setRequestDiagnostics,
    creationOutsideScope: creationFeedback?.message === notice ? creationFeedback.id : null,
    deleteTarget, setDeleteTarget, deleteConfirmation, setDeleteConfirmation, conflict, setConflict, rebaseReviewed, setRebaseReviewed,
    createStatus, creationScope, saveViewOpen, setSaveViewOpen, activeView, context, setContext, activity, canWrite: options.canWrite && selectedTaskAttempt?.phase !== 'unknown' && selectedTaskAttempt?.phase !== 'observed',
    select, updateDraft, acceptRecord, removeDraft, save, canEdit, canManageLifecycle, patch, toggleChecklist, wikiLink,
    canEditSourceDraft, canEditTaskDraft, draftParseError, patchTaskDraft, toggleTaskChecklist, patchDocumentDraft,
    openCreate, acceptCreated, lifecycle, useView, acceptView, clearView, loadContext, refresh,
  };
}
