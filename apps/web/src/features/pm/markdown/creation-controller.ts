import { ideaBoardScenario, scenarioFitsDraft } from './app-scenarios';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError as PmApiError, type CommandReceipt } from '@contracts';
import { relationFields } from '@pm-schema/relations';
import { workflowFor, type Diagnostic, type EntityKind, type FileRecord, type WorkspaceSnapshot } from '@pm-schema';
import { ApiError } from './api';
import { useCoreSession, useCreationDrafts, useSessionDrafts } from './session';
import { applyCreationResult, applyLocalProjectResult, creationChildHasContent, creationComplete, creationDraftEditable, creationDraftIsPristine, creationFieldIssues, creationHasRemainingNativeWrites, creationRequest, editCreationDraft, editRejectedChild, editRejectedCreation, hasUncertainCreationDrafts, initialCreationValues, newCreationDraft, prepareCreationAttempt, resumableCreationDraft, type CreationChild, type CreationDraft, type CreationDrafts, type CreationInitial, type NativeCreationAttempt } from './creation-model';
import { withCreationLock } from './creation-store';
import { usePmCommand, usePmService, usePrivateQuery } from '../service/pm-service';
import { PmCommandError } from '../service/pm-errors';
import { allowed } from '../service/pm-ui';
import { hasUncertainProjectTaskDraft } from '../service/project-task-editing-model';
import { teamTaskCreateProjectProblem } from '../service/team-task-actions-model';
import { localDirectorySchema, localProjectInputSchema, type LocalDirectory, type LocalProjectProbe, type LocalProjectSettings } from '../../../../../../packages/contracts/src/local-projects';
import { localProjectApi } from '../service/local-project-api';
import { useLocalProjectSettings } from '../service/local-project-hooks';
import { usePeopleCandidates } from '../service/people-hooks';
import type { PeopleCandidatePage } from '../../../../../../packages/domain/src/people';

export interface EntityCreationOptions { initial?: CreationInitial; projectId?: string; draftId?: string; onCreated: (file: FileRecord) => void }
export interface LocalProjectCreationState {
  draft: CreationDraft | undefined;
  localSettings: { data: LocalProjectSettings | undefined; error: Error | null; refetch: () => Promise<unknown> };
  busy: boolean;
  canWrite: boolean;
  changeDirectory: (directory: LocalDirectory | undefined) => void;
  suggestTitle: (title: string) => void;
  recoverExisting: (projectId: string, path: string) => Promise<void>;
}

function subscribeOnline(notify: () => void): () => void {
  window.addEventListener('online', notify);
  window.addEventListener('offline', notify);
  return () => {
    window.removeEventListener('online', notify);
    window.removeEventListener('offline', notify);
  };
}

/** One persisted intent is consumed by compact, dialog, page and generic editors. */
export function useEntityCreation(options: EntityCreationOptions) {
  const session = useCoreSession();
  const service = usePmService();
  const command = usePmCommand();
  const queryClient = useQueryClient();
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine);
  const [drafts] = useCreationDrafts();
  const [sourceDrafts] = useSessionDrafts();
  const [id] = useState(() => {
    if (options.draftId) return options.draftId;
    const project = options.projectId || options.initial?.project || '';
    const preseeded = !!(options.initial?.title || options.initial?.parent || options.initial?.workKind);
    return (!preseeded ? resumableCreationDraft(session.creationDrafts.getSnapshot(), options.initial?.entity ?? 'work_item', project)?.draftId : undefined) ?? crypto.randomUUID();
  });
  const draft = drafts[id];
  const localSettings = useLocalProjectSettings((draft?.kind ?? options.initial?.entity) === 'project');
  const initialized = useRef(draft !== undefined || options.draftId !== undefined);
  const appliedEntryInitial = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [issues, setIssues] = useState<Diagnostic[]>([]);
  const active = useRef(true);
  const submitting = useRef(false);
  const latest = useRef({ service, command, options, localSettings });
  latest.current = { service, command, options, localSettings };
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const sources = usePrivateQuery<WorkspaceSnapshot>(session.queryKey.slice(0, -2), 'domain.read', undefined, async (_client, _workspaceId, signal) => {
    try { return await session.api.workspace(signal); }
    catch (cause) {
      if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) throw new PmApiError(cause.status, { error: { code: cause.status === 401 ? 'unauthenticated' : 'not_found_or_forbidden', message: cause.message } });
      throw cause;
    }
  });
  const candidateProject = String(draft?.values.project ?? options.projectId ?? options.initial?.project ?? '');
  const candidateKind = draft?.kind ?? options.initial?.entity ?? 'work_item';
  const directory = usePeopleCandidates({ purpose: candidateKind === 'project' ? 'project_owner' : 'assignee', projectId: candidateKind === 'project' ? undefined : candidateProject, enabled: candidateKind === 'project' || candidateKind === 'work_item' && !!candidateProject });
  useEffect(() => {
    if (draft) { initialized.current = true; return; }
    if (initialized.current || !sources.data || session.creationDrafts.persistenceError()) return;
    // Another tab may finish and remove this intent; never resurrect its local ID.
    initialized.current = true;
    void withCreationLock(session.namespace, async () => {
      session.creationDrafts.update(current => current[id] ? current : { ...current, [id]: newCreationDraft(id, sources.data!.configuration, { ...options.initial, ...(options.projectId ? { project: options.projectId } : {}) }) });
    }).catch(cause => { if (active.current) setError(cause instanceof Error ? cause.message : String(cause)); });
  }, [draft, id, options.draftId, options.initial, options.projectId, session, sources.data]);
  useEffect(() => {
    if (!draft || !sources.data || options.draftId || appliedEntryInitial.current) return;
    appliedEntryInitial.current = true;
    const config = sources.data.configuration;
    if (!creationDraftIsPristine(draft, config)) return;
    const requested = initialCreationValues(draft.kind, config, { ...draft.initial, ...options.initial, ...(options.projectId ? { project: options.projectId } : {}) });
    const keys = new Set([...Object.keys(draft.values), ...Object.keys(requested)]);
    if ([...keys].every(key => JSON.stringify(draft.values[key] ?? null) === JSON.stringify(requested[key] ?? null))) return;
    void withCreationLock(session.namespace, async () => {
      session.creationDrafts.update(current => {
        const value = current[id];
        return !value || !creationDraftIsPristine(value, config) ? current : { ...current, [id]: { ...value, values: requested, updatedAt: Date.now() } };
      });
    }).catch(cause => { if (active.current) setError(cause instanceof Error ? cause.message : String(cause)); });
  }, [draft, id, options.draftId, options.initial, options.projectId, session, sources.data]);

  function mutate(change: (current: CreationDraft) => CreationDraft, durable = false): boolean {
    const update = durable ? session.creationDrafts.commit : session.creationDrafts.update;
    return update(current => {
      const value = current[id];
      if (!value) throw new Error('This creation draft is no longer available. / 此创建草稿已不可用。');
      return { ...current, [id]: change(value) };
    });
  }
  function edit(change: (current: CreationDraft) => CreationDraft) {
    // All storage writes, including ordinary keystrokes, use the same lock as
    // preparation. Another tab cannot overwrite a newly frozen request.
    void withCreationLock(session.namespace, async () => { mutate(change); }).catch(cause => {
      if (active.current) setError(cause instanceof Error ? cause.message : String(cause));
    });
  }
  function requireDurable(change: (current: CreationDraft) => CreationDraft) {
    if (!mutate(change, true)) throw new Error('Recovery storage is unavailable or full. No additional write was sent; keep this page open and restore browser storage. / 恢复存储不可用或已满，未发送后续写入，请保留页面并恢复浏览器存储。');
  }
  function changeFields(changes: Record<string, unknown>) {
    if (options.projectId && 'project' in changes && changes.project !== options.projectId) { setError('The route project is fixed. Open the other project to create there. / 当前路由项目不可更改，请进入其他项目后创建。'); return; }
    edit(current => editCreationDraft(current, { values: { ...current.values, ...changes } })); setIssues([]);
  }
  function suggestTitle(title: string) {
    const current = session.creationDrafts.getSnapshot()[id];
    if (!current || current.kind !== 'project' || String(current.values.title ?? '').trim()) return;
    changeFields({ title });
  }
  function changeKind(kind: EntityKind) {
    if (options.projectId && kind === 'project') { setError('Create projects from the workspace, not within another project. / 请从工作区创建项目，而非在另一项目内创建。'); return; }
    edit(current => {
      if (!creationDraftEditable(current)) return current;
      if (current.children.length || current.watch) throw new Error('Remove child drafts and personal watch before changing entity type. / 切换类型前请移除子任务草稿和个人关注。');
      const defaults = initialCreationValues(kind, sources.data!.configuration, { project: String(current.values.project ?? '') });
      return { ...current, kind, values: { ...defaults, title: current.values.title ?? '' }, updatedAt: Date.now() };
    });
  }
  function changeChild(childId: string, changes: Partial<Pick<CreationChild, 'values' | 'body'>>) {
    edit(current => {
      const child = current.children.find(item => item.draftId === childId);
      if (!child || child.attempt || current.attempt && current.attempt.phase !== 'committed') return current;
      return { ...current, children: current.children.map(item => item.draftId === childId ? { ...item, ...changes, ...(changes.values ? { values: { ...item.values, ...changes.values } } : {}) } : item), updatedAt: Date.now() };
    });
  }
  function changeDirectory(localDirectory: LocalDirectory | undefined) {
    edit(current => current.attempt?.phase === 'prepared' && !current.attempt.localDirectory ? { ...current, localDirectory, updatedAt: Date.now() } : editCreationDraft(current, { localDirectory }));
  }
  function writeProblem(current: CreationDraft, isOnline = navigator.onLine): string | null {
    const now = latest.current;
    if (now.options.projectId && (current.kind === 'project' || current.values.project !== now.options.projectId)) return 'This draft belongs to another project. Its original project and recovery state are retained. / 此草稿属于其他项目，原项目与恢复状态均已保留。';
    if (!active.current || !now.service.actor || !now.service.workspace || now.service.actorEpoch !== service.actorEpoch) return 'The session changed. / 会话已改变。';
    if (now.command.pending || now.command.unknownCommand) return 'Resolve the original PM command before creating. / 请先核对原 PM 命令。';
    if (now.service.error || now.service.capabilities?.business.enabled !== true) return 'The service is unavailable. / 服务当前不可用。';
    if (!isOnline) return 'Offline. Your draft is retained; no write was sent. / 当前离线，草稿已保留，未发送写入。';
    if (hasUncertainProjectTaskDraft(session.drafts.getSnapshot())) return 'Reconcile the uncertain native edit first. / 请先核对结果未知的原生编辑。';
    const other = Object.fromEntries(Object.entries(session.creationDrafts.getSnapshot()).filter(([key]) => key !== current.draftId));
    if (hasUncertainCreationDrafts(other)) return 'Reconcile the original native creation first. / 请先核对原生创建原请求。';
    const project = current.kind === 'project' ? undefined : String(current.values.project ?? '') || undefined;
    const capability = creationHasRemainingNativeWrites(current) ? 'planning.edit' : 'domain.read';
    if (current.kind !== 'project' && !project && now.service.workspace.projectIds !== null) return 'Choose an authorized project before creating. / 创建前请选择有权访问的项目。';
    if (!allowed(now.service.workspace, capability, project) || current.kind === 'project' && now.service.workspace.projectIds !== null) return 'Project permission is required for the remaining actions. / 执行剩余项需要相应项目权限。';
    if (current.kind === 'project' && (!current.attempt || current.attempt.phase === 'prepared')) {
      const settings = now.localSettings.data;
      if (!settings) return now.localSettings.error?.message ?? 'Read local storage settings before creating a project. / 创建项目前请先读取本地存储配置。';
      if (settings.enabled) {
        if (!settings.canManage) return 'Local project creation requires unrestricted workspace storage management. / 本地项目创建需要工作区全局存储管理权限。';
        const directory = current.attempt?.localDirectory ?? current.localDirectory;
        if (!localDirectorySchema.safeParse(directory).success) return 'Choose a project directory. / 请选择项目目录。';
      }
    }
    return null;
  }
  function validateGroup(current: CreationDraft, snapshot: WorkspaceSnapshot, members: PeopleCandidatePage | undefined): Diagnostic[] {
    const configuration = snapshot.configuration;
    const parentPending = current.attempt?.phase !== 'committed';
    const result = parentPending ? creationFieldIssues(current.kind, current.values, configuration) : [];
    if (creationHasRemainingNativeWrites(current) && snapshot.configurationErrors.some(item => item.severity === 'error')) result.push(...snapshot.configurationErrors);
    const add = (field: string, message: string) => result.push({ code: 'CREATION_CONTEXT', severity: 'error', path: '', field, message });
    if (current.attempt?.phase === 'committed' && current.children.some(child => child.attempt?.phase !== 'committed')) {
      const parent = snapshot.files.find(file => file.id === current.attempt!.entityId);
      if (!parent || parent.entity.archived || parent.stale || parent.error || parent.diagnostics?.some(issue => issue.severity === 'error')) add('parent', 'The confirmed parent is currently unavailable or read-only; no children were sent. / 已确认父项当前不可用或只读，未发送子任务。');
    }
    const validateValues = (kind: EntityKind, values: Record<string, unknown>, prefix = '') => {
      const project = String(values.project ?? '');
      if (kind === 'work_item') {
        const problem = teamTaskCreateProjectProblem(snapshot, project, session.drafts.getSnapshot());
        if (problem) add(`${prefix}project`, problem);
        const category = workflowFor('work_item', configuration)?.states.find(state => state.id === values.status)?.category;
        const capability = category === 'completed' ? 'workitem.complete' : category === 'canceled' ? 'workitem.cancel_reopen' : null;
        if (capability && !allowed(latest.current.service.workspace, capability, project)) add(`${prefix}status`, `Permission required: ${capability}. / 所选状态需要相应权限。`);
        if (values.assignee) {
          const member = members?.items.find(item => item.userId === values.assignee);
          if (!member || project !== candidateProject) add(`${prefix}assignee`, 'This member cannot be assigned to the selected project. / 此成员不可分派到所选项目。');
        }
      }
      if (kind === 'project' && values.owner && !members?.items.some(member => member.userId === values.owner)) add(`${prefix}owner`, 'This member is not an eligible new-project owner. / 此成员不可担任新项目负责人。');
      for (const reference of relationFields(configuration).filter(field => field.entities.includes(kind))) {
        const input = values[reference.name];
        if (input === undefined || input === null) continue;
        const targets = Array.isArray(input) ? input : [input];
        for (const target of targets) {
          const file = snapshot.files.find(item => item.id === target);
          if (!file || file.entity.archived || file.stale || file.error || file.diagnostics?.some(issue => issue.severity === 'error') || reference.target && file.entity.entity !== (reference.target === 'self' ? kind : reference.target) || reference.scoped && file.entity.project !== project) add(`${prefix}${reference.name}`, 'Select a valid authorized relation in this project. / 请选择同项目内有效且有权访问的关联对象。');
        }
      }
    };
    if (parentPending) validateValues(current.kind, current.values);
    if (current.kind === 'work_item') for (const [index, child] of current.children.entries()) {
      if (child.attempt?.phase === 'committed') continue;
      const values = { ...child.values, project: current.values.project, kind: 'subtask' };
      const prefix = `children.${index}.`;
      result.push(...creationFieldIssues('work_item', values, configuration).map(issue => ({ ...issue, field: `${prefix}${issue.field ?? ''}` })));
      validateValues('work_item', values, prefix);
    }
    return result;
  }
  function acceptFile(file: FileRecord) {
    if (!active.current) return;
    queryClient.setQueryData<WorkspaceSnapshot>(session.queryKey, previous => previous ? { ...previous, files: [...previous.files.filter(item => item.id !== file.id), file], unsupportedFiles: previous.unsupportedFiles.filter(item => item.path !== file.path) } : previous);
    void queryClient.invalidateQueries({ queryKey: session.queryKey.slice(0, 4) });
  }
  function setAttempt(childId: string | undefined, change: (attempt: NativeCreationAttempt) => NativeCreationAttempt, durable = true) {
    const update = (current: CreationDraft) => childId ? { ...current, children: current.children.map(child => child.draftId === childId && child.attempt ? { ...child, attempt: change(child.attempt) } : child), updatedAt: Date.now() } : current.attempt ? { ...current, attempt: change(current.attempt), updatedAt: Date.now() } : current;
    if (durable) { requireDurable(update); return; }
    // A server-confirmed result is authoritative even when browser recovery storage is full:
    // keep it in memory so the user can finish, instead of stranding a confirmed write.
    if (!mutate(update, true)) mutate(update, false);
  }
  async function reconcileNative(childId?: string, recover = false) {
    const current = session.creationDrafts.getSnapshot()[id];
    const attempt = childId ? current?.children.find(child => child.draftId === childId)?.attempt : current?.attempt;
    if (!current || !attempt || attempt.phase === 'prepared' || attempt.phase === 'committed' || attempt.phase === 'rejected') return;
    try {
      if (attempt.localDirectory) {
        const api = localProjectApi(service.client, session.queryKey[3]);
        let result = await (recover ? api.recover(attempt.key) : api.attempt(attempt.key));
        if (recover && result.status === 'not_found') {
          const problem = writeProblem(current);
          if (problem) throw new Error(problem);
          requireDurable(value => value);
          // Only this explicit recovery action may resubmit an absent operation.
          // The original frozen key/input/directory also deduplicate a late arrival.
          result = await api.initialize({ input: localProjectInputSchema.parse(attempt.request), directory: attempt.localDirectory }, attempt.key);
        }
        setAttempt(childId, original => applyLocalProjectResult(original, result), false);
        if (result.status === 'ready' && result.location.status === 'available') acceptFile(result.record);
        return;
      }
      const result = await (recover ? session.api.recoverCreationAttempt(attempt.key) : session.api.creationAttempt(attempt.key));
      setAttempt(childId, original => applyCreationResult(original, result), false);
      if (result.status === 'committed' && result.current.status === 'present') acceptFile(result.current.record);
    } catch (cause) {
      if ((cause instanceof ApiError || cause instanceof PmApiError) && [401, 403, 404].includes(cause.status)) await session.onAccessFailure();
      throw cause;
    }
  }
  async function sendNative(childId?: string) {
    const current = session.creationDrafts.getSnapshot()[id]!;
    const attempt = childId ? current.children.find(child => child.draftId === childId)?.attempt : current.attempt;
    if (!attempt || attempt.phase !== 'prepared') return;
    const problem = writeProblem(current);
    if (problem) throw new Error(problem);
    setAttempt(childId, original => ({ ...original, phase: 'sending' }));
    try {
      if (attempt.localDirectory) {
        const result = await localProjectApi(service.client, session.queryKey[3]).initialize({ input: localProjectInputSchema.parse(attempt.request), directory: attempt.localDirectory }, attempt.key);
        setAttempt(childId, original => applyLocalProjectResult(original, result), false);
        if (result.status === 'ready' && result.location.status === 'available') acceptFile(result.record);
        return;
      }
      const file = await session.api.createEntity(attempt.request, attempt.key);
      setAttempt(childId, original => ({ ...original, phase: 'committed', entityId: file.id, revision: file.revision, currentStatus: 'present', message: '', diagnostics: [] }), false);
      acceptFile(file);
    } catch (cause) {
      setAttempt(childId, original => ({ ...original, phase: 'unknown', message: cause instanceof Error ? cause.message : String(cause), diagnostics: cause instanceof ApiError ? cause.diagnostics : [] }), false);
      if ((cause instanceof ApiError || cause instanceof PmApiError) && [401, 403, 404].includes(cause.status)) await session.onAccessFailure();
      else if ((cause instanceof ApiError || cause instanceof PmApiError) && cause.status < 500) await reconcileNative(childId);
      throw cause;
    }
  }
  async function resolveSelection(api: { probe: (path: string, signal?: AbortSignal) => Promise<LocalProjectProbe> }, directory: LocalDirectory): Promise<LocalDirectory> {
    if (directory.mode !== 'auto') return directory;
    const probe = await api.probe(directory.path);
    if (probe.markerProblem) throw new Error('This directory contains an incomplete or invalid project marker and cannot be adopted. / 该目录包含不完整或无效的项目标记，不能接管。');
    if (probe.problem === 'foreign_workspace') throw new Error('This directory belongs to another workspace and cannot be imported here. / 该目录属于其他工作区，不能在当前工作区导入。');
    if (probe.problem === 'unknown_project') throw new Error('The marked project is not in this workspace and cannot be created as a new project. / 标记中的项目不在当前工作区，不能作为新项目创建。');
    if (probe.project) throw new Error(probe.project.locationStatus === 'available'
      ? `Project ${probe.project.title} is already registered here; open it instead of creating another. / 项目「${probe.project.title}」已登记在此，请直接打开，不要重复创建。`
      : `Project ${probe.project.title} is already registered but its folder is missing; use Recover and open. / 项目「${probe.project.title}」已登记但目录缺失，请使用“找回并打开”。`);
    if (probe.marker) throw new Error('This directory is already a project; it cannot be initialized as a new project. / 该目录已是项目目录，不能作为新项目初始化。');
    return probe.directory;
  }
  const recoveryKeys = useRef(new Map<string, string>());
  async function recoverExisting(projectId: string, path: string) {
    const mapKey = `${projectId}:${path}`;
    const key = recoveryKeys.current.get(mapKey) ?? crypto.randomUUID();
    recoveryKeys.current.set(mapKey, key);
    await run(async () => {
      if (!allowed(latest.current.service.workspace, 'planning.edit')) throw new Error('Project permission is required to recover storage. / 找回存储需要项目写入权限。');
      const api = localProjectApi(service.client, session.queryKey[3]);
      const result = await api.move(projectId, 'relocate', { mode: 'existing', path }, key, 'rebind');
      if (result.status === 'pending') throw new Error('Recovery is pending. Check the original request; do not create a replacement. / 找回结果待核对，请检查原请求，不要新建替代项目。');
      if (result.status === 'rejected') throw new Error(`Recovery was rejected (${result.code}). Inspect project storage. / 找回被拒绝（${result.code}），请核对项目存储。`);
      if (result.status === 'not_found') throw new Error('The original recovery record was not found; retry this action. / 未找到原找回记录，请重试。');
      if (result.location.status !== 'available') throw new Error('Recovery was submitted, but the directory is not currently available. / 找回已提交，但目录当前不可用。');
      recoveryKeys.current.delete(mapKey);
      acceptFile(result.record);
      discardDraft();
      latest.current.options.onCreated(result.record);
    });
  }
  function storeWatchReceipt(receipt: CommandReceipt) {
    requireDurable(current => current.watchAttempt && current.watchAttempt.command.commandId === receipt.commandId ? { ...current, watchAttempt: { ...current.watchAttempt, phase: receipt.status, receipt, message: receipt.status === 'rejected' ? receipt.error.message : '' }, updatedAt: Date.now() } : current);
    void queryClient.invalidateQueries({ queryKey: session.queryKey.slice(0, 4) });
  }
  async function reconcileWatch() {
    const attempt = session.creationDrafts.getSnapshot()[id]?.watchAttempt;
    const now = latest.current;
    if (!attempt || attempt.phase === 'committed' || attempt.phase === 'rejected' || !now.service.workspace) return;
    try {
      const receipt = now.command.unknownCommand?.commandId === attempt.command.commandId ? await now.command.reconcile() : await now.service.client.getCommandReceipt(now.service.workspace.id, attempt.command.commandId);
      if (receipt) storeWatchReceipt(receipt);
    } catch (cause) {
      if (cause instanceof PmCommandError && cause.receipt.commandId === attempt.command.commandId) storeWatchReceipt(cause.receipt);
      else throw cause;
    }
  }
  function discardDraft() {
    const change = (values: CreationDrafts) => { const next = { ...values }; delete next[id]; return next; };
    if (!session.creationDrafts.commit(change)) session.creationDrafts.update(change);
  }
  async function finish() {
    const current = session.creationDrafts.getSnapshot()[id];
    if (!current || !creationComplete(current) || !active.current) return;
    const cached = current.attempt!.currentStatus === 'present' ? queryClient.getQueryData<WorkspaceSnapshot>(session.queryKey)?.files.find(file => file.id === current.attempt!.entityId) : undefined;
    const file = cached ?? await session.api.file(current.attempt!.entityId!);
    if (!('entity' in file)) throw new Error('Creation committed, but the current file is unavailable. The original creation will not be repeated. / 创建已提交，但当前文件不可用，不会重复创建。');
    if (latest.current.options.projectId && (file.entity.entity === 'project' ? file.id : file.entity.project) !== latest.current.options.projectId) throw new Error('The confirmed source is not in this route project. The creation intent is retained; reopen it from workspace recovery. / 已确认源码不属于当前路由项目，创建意图已保留，请从工作区恢复入口打开。');
    acceptFile(file);
    discardDraft();
    latest.current.options.onCreated(file);
  }
  async function run(action: () => Promise<void>) {
    if (submitting.current) return false;
    submitting.current = true; setBusy(true); setError('');
    try { await withCreationLock(session.namespace, async () => { session.creationDrafts.refresh(); await action(); }); return true; }
    catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { submitting.current = false; if (active.current) setBusy(false); }
  }
  async function submit() {
    await run(async () => {
      let current = session.creationDrafts.getSnapshot()[id];
      if (!current) return;
      const problem = writeProblem(current);
      if (problem) throw new Error(problem);
      if (hasUncertainCreationDrafts({ [id]: current })) throw new Error('Query the original request before continuing. / 请先核对原请求。');
      // Empty subtask rows are unfinished UI placeholders, not work items. Drop
      // them before validation and creation; rows with any content still block.
      if (current.children.some(child => !creationChildHasContent(child))) {
        requireDurable(value => ({ ...value, children: value.children.filter(creationChildHasContent), updatedAt: Date.now() }));
        current = session.creationDrafts.getSnapshot()[id]!;
      }
      const fresh = await sources.refetch({ throwOnError: true });
      if (!fresh.data) throw new Error('Read the authoritative workspace first. / 请先读取权威工作区。');
      const members = creationHasRemainingNativeWrites(current) && (current.kind === 'project' || current.kind === 'work_item' && candidateProject) ? (await directory.refetch({ throwOnError: true })).data : undefined;
      current = session.creationDrafts.getSnapshot()[id]!;
      if (current.kind === 'project' && !current.attempt && latest.current.localSettings.data?.enabled) {
        const initialStatus = workflowFor('project', fresh.data.configuration)?.initial;
        if (initialStatus && current.values.status !== initialStatus) {
          requireDurable(value => value.attempt ? value : { ...value, values: { ...value.values, status: initialStatus }, updatedAt: Date.now() });
          current = session.creationDrafts.getSnapshot()[id]!;
        }
      }
      const diagnostics = validateGroup(current, fresh.data, members);
      setIssues(diagnostics);
      if (diagnostics.length) throw new Error('Review the marked fields; no additional write was sent. / 请检查标记字段，未发送后续写入。');
      if (!current.attempt) {
        const request = creationRequest(current.kind, current.values, current.body, fresh.data.configuration);
        let directory = current.kind === 'project' && latest.current.localSettings.data?.enabled ? localDirectorySchema.parse(current.localDirectory) : undefined;
        if (directory) {
          const api = localProjectApi(service.client, session.queryKey[3]);
          directory = await resolveSelection(api, directory);
          await api.preview(directory);
        }
        const attempt = { ...prepareCreationAttempt(request, crypto.randomUUID()), ...(directory ? { localDirectory: directory } : {}) };
        requireDurable(value => value.attempt ? value : { ...value, attempt, updatedAt: Date.now() });
      }
      // A frozen but unsent historical draft keeps its original key and input.
      // Once sent, transport is immutable and reconciliation uses its own journal.
      current = session.creationDrafts.getSnapshot()[id]!;
      if (current.kind === 'project' && current.attempt?.phase === 'prepared' && !current.attempt.localDirectory && latest.current.localSettings.data?.enabled) {
        const api = localProjectApi(service.client, session.queryKey[3]);
        const directory = await resolveSelection(api, localDirectorySchema.parse(current.localDirectory));
        await api.preview(directory);
        setAttempt(undefined, original => ({ ...original, localDirectory: directory }));
      }
      await sendNative();
      current = session.creationDrafts.getSnapshot()[id]!;
      if (current.attempt?.phase !== 'committed') return;
      if (current.attempt.currentStatus !== 'present') throw new Error('Parent creation committed, but its current file is unavailable. No children will be created. / 父项已提交但当前文件不可用，不会创建子项。');
      for (const child of current.children) {
        if (!active.current) return;
        if (child.attempt?.phase === 'committed') continue;
        if (child.attempt && child.attempt.phase !== 'prepared') return;
        if (!child.attempt) {
          const values = { ...child.values, project: current.attempt.request.project, kind: 'subtask', parent: current.attempt.entityId };
          const attempt = prepareCreationAttempt(creationRequest('work_item', values, child.body, fresh.data.configuration), crypto.randomUUID());
          requireDurable(value => ({ ...value, children: value.children.map(item => item.draftId === child.draftId && !item.attempt ? { ...item, attempt } : item), updatedAt: Date.now() }));
        }
        await sendNative(child.draftId);
        if (session.creationDrafts.getSnapshot()[id]?.children.find(item => item.draftId === child.draftId)?.attempt?.phase !== 'committed') return;
      }
      current = session.creationDrafts.getSnapshot()[id]!;
      if (current.watch && !current.watchAttempt) {
        const problem = writeProblem(current);
        if (problem) throw new Error(problem);
        const request = { commandId: crypto.randomUUID(), commandType: 'WatchTask' as const, projectId: String(current.attempt!.request.project), payload: { taskId: current.attempt!.entityId! } };
        requireDurable(value => ({ ...value, watchAttempt: { command: request, phase: 'sending', message: '' }, updatedAt: Date.now() }));
        try { storeWatchReceipt(await latest.current.command.execute(request)); }
        catch (cause) {
          if (cause instanceof PmCommandError && cause.receipt.commandId === request.commandId) storeWatchReceipt(cause.receipt);
          else requireDurable(value => value.watchAttempt ? { ...value, watchAttempt: { ...value.watchAttempt, phase: 'unknown', message: cause instanceof Error ? cause.message : String(cause) } } : value);
          throw cause;
        }
      }
      await finish();
    });
  }
  async function reconcile(childId?: string, recover = false) { await run(async () => { await reconcileNative(childId, recover); await finish(); }); }
  function resetRejected(childId?: string) { edit(current => childId ? editRejectedChild(current, childId) : editRejectedCreation(current)); setError(''); setIssues([]); }
  function retryRejectedWatch() {
    edit(current => {
      if (current.watchAttempt?.phase !== 'rejected') return current;
      const { watchAttempt: _watch, ...next } = current;
      return next;
    });
  }
  const project = draft?.kind === 'project' ? undefined : String(draft?.values.project ?? '') || undefined;
  const capability = draft && !creationHasRemainingNativeWrites(draft) ? 'domain.read' : 'planning.edit';
  const canWrite = service.workspace !== null && service.workspace.capabilities.includes(capability) && (project ? allowed(service.workspace, capability, project) : draft?.kind === 'project' ? service.workspace.projectIds === null : service.workspace.projectIds === null || service.workspace.projectIds.length > 0);
  const guard = draft ? writeProblem(draft, online) : null;
  const recoveryDraftId = Object.values(drafts).find(item => item.draftId !== id && hasUncertainCreationDrafts({ [item.draftId]: item }))?.draftId;
  return {
    draft, draftId: id, busy, error, issues, sources, directory, sourceDrafts, canWrite, guard, recoveryDraftId,
    localSettings,
    changeDirectory,
    suggestTitle,
    recoverExisting,
    storageFailed: session.creationDrafts.persistenceError(),
    applyAppScenario: () => edit(current => {
      if (!scenarioFitsDraft(current) || !creationDraftEditable(current)) throw new Error('场景只可填入空白任务草稿，不覆盖已有标题、描述或已发送请求。');
      return editCreationDraft(current, { values: { ...current.values, title: ideaBoardScenario.title }, body: ideaBoardScenario.body });
    }),
    changeFields, changeKind, changeBody: (body: string) => edit(current => editCreationDraft(current, { body })),
    changeWatch: (watch: boolean) => edit(current => editCreationDraft(current, { watch })),
    addChild: () => edit(current => editCreationDraft(current, { children: [...current.children, { draftId: crypto.randomUUID(), values: initialCreationValues('work_item', sources.data!.configuration, { project: String(current.values.project ?? '') }), body: '' }] })),
    removeChild: (childId: string) => edit(current => editCreationDraft(current, { children: current.children.filter(child => child.draftId !== childId) })),
    changeChild, submit, reconcile, reconcileWatch: () => run(async () => { await reconcileWatch(); await finish(); }), resetRejected, retryRejectedWatch,
    skipRejectedWatch: () => run(async () => { requireDurable(current => current.watchAttempt?.phase === 'rejected' ? { ...current, watch: false } : current); await finish(); }),
    openConfirmed: () => run(finish),
    saveLocally: () => run(async () => { if (!session.creationDrafts.update(current => current)) throw new Error('Browser recovery storage is unavailable. No write was sent. / 浏览器恢复存储不可用，未发送写入。'); }),
    dismissCompleted: () => run(async () => { const current = session.creationDrafts.getSnapshot()[id]; if (current && creationComplete(current) && !session.creationDrafts.commit(values => { const next = { ...values }; delete next[id]; return next; })) throw new Error('Restore browser recovery storage before dismissing this intent. / 请恢复浏览器恢复存储后结束此意图。'); }),
  };
}
