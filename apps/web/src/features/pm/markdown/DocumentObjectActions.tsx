import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CommandOutcomeUnknown, type Command, type CommandReceipt } from '@contracts';
import type { FileRecord } from '@pm-schema';
import type { WorkspaceController } from './controller';
import { useEntityCreation } from './creation-controller';
import { hasUncertainCreationDrafts, newCreationDraft } from './creation-model';
import { withCreationLock } from './creation-store';
import { usePmCommand, usePmEntities, usePmService } from '../service/pm-service';
import { allowed, makeCommand, writable } from '../service/pm-ui';
import { artifactKindFor, classifyFile } from '../service/project-files/model';
import { PmCommandError, PmServiceError } from '../service/pm-errors';
import { hasUncertainProjectTaskDraft } from '../service/project-task-editing-model';
import { applyDocumentUploadReceipt, captureDocumentObjectSource, createDocumentObjectStore, documentAttachmentMarkdown, documentObjectSourceMatches, documentTaskReference, documentTaskTitle, documentWikiLink, flushDocumentTaskFields, recoverDocumentTaskReference, relatedDocumentDraft, type DocumentObjectAction, type DocumentObjectSelection, type DocumentObjectSource, type DocumentObjectStore, type DocumentTaskAction, type DocumentUploadAction } from './document-object-model';
import './document-object-actions.css';

export interface DocumentObjectActionsProps {
  controller: WorkspaceController;
  en: boolean;
  selection: DocumentObjectSelection;
  disabled: boolean;
  onInsert: (markdown: string) => void;
}

function TaskConversionForm({ action, store, controller, en, canConfirm, onCreated, onClose }: { action: DocumentTaskAction; store: DocumentObjectStore; controller: WorkspaceController; en: boolean; canConfirm: boolean; onCreated: (file: FileRecord) => void; onClose: () => void }) {
  const creation = useEntityCreation({ draftId: action.draftId, onCreated });
  const { workspace } = usePmService();
  const draft = creation.draft;
  const t = (zh: string, english: string) => en ? english : zh;
  const storedTitle = String(draft?.values.title ?? '');
  const storedProject = String(draft?.values.project ?? '');
  const [title, setTitle] = useState(storedTitle);
  const [project, setProject] = useState(storedProject);
  const [flushing, setFlushing] = useState(false);
  const [inputError, setInputError] = useState('');
  const titleInput = useRef<HTMLInputElement>(null);
  const projectInput = useRef<HTMLSelectElement>(null);
  const dirty = useRef({ title: false, project: false });
  const composing = useRef(false);
  const confirming = useRef(false);
  const mounted = useRef(true);
  const confirmAllowed = useRef(canConfirm);
  confirmAllowed.current = canConfirm;
  const projects = (creation.sources.data?.files ?? []).filter(file => file.entity.entity === 'project' && allowed(workspace, 'domain.read', file.id) && allowed(workspace, 'planning.edit', file.id));
  const editable = !!draft && !draft.attempt && !creation.busy && !flushing && creation.canWrite;
  const attempt = draft?.attempt;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (attempt || !dirty.current.title && !composing.current && document.activeElement !== titleInput.current) setTitle(storedTitle);
    if (attempt) dirty.current.title = false;
  }, [attempt, storedTitle]);
  useEffect(() => {
    if (attempt || !dirty.current.project && document.activeElement !== projectInput.current) setProject(storedProject);
    if (attempt) dirty.current.project = false;
  }, [attempt, storedProject]);
  async function confirmFields(fields: { title: string; project: string | null }) {
    if (confirming.current || composing.current || !confirmAllowed.current || store.persistenceError()) return;
    confirming.current = true;
    setFlushing(true); setInputError('');
    try {
      await withCreationLock(controller.session.namespace, async () => {
        if (!mounted.current || !confirmAllowed.current || store.persistenceError()) throw new Error(t('源选区或恢复状态已改变，未发送创建。', 'The source selection or recovery state changed. No create was sent.'));
        const drafts = controller.session.creationDrafts;
        drafts.refresh();
        const current = drafts.getSnapshot()[action.draftId];
        if (!current) throw new Error(t('原任务草稿已不可用，未创建替代意图。', 'The original task draft is unavailable. No replacement intent was created.'));
        if (!current.attempt) flushDocumentTaskFields(drafts, action.draftId, fields);
      });
      if (mounted.current && confirmAllowed.current) await creation.submit();
    } catch (cause) { if (mounted.current) setInputError(cause instanceof Error ? cause.message : String(cause)); }
    finally { confirming.current = false; if (mounted.current) setFlushing(false); }
  }
  if (draft && (!workspace?.capabilities.includes('domain.read') || storedProject && !allowed(workspace, 'domain.read', storedProject))) return <p role="status">{t('此任务草稿的项目当前不可读取；原请求已保留，未创建替代任务。', 'This task draft project is not currently readable. The original request is retained; no replacement task is created.')}</p>;
  return <section className="document-object-form" aria-label={t('选区转正式任务', 'Convert selection to a real task')}>
    <h4>{t('确认创建正式任务', 'Confirm real task creation')}</h4>
    <p>{t('先检查标题和所属项目，点击确认后才发送创建。源检查项保持原状，不会自动勾选或完成。原创建结果未知时只核对，不重发。', 'Review the title and project before confirming. The source checklist stays unchanged and is never completed. Uncertain creation is reconciled, not replayed.')}</p>
    {!draft ? <p role="status">{creation.error || t('原创建草稿不可用；不会自动生成新的创建意图。可刷新授权对象后恢复已创建引用。', 'The original draft is unavailable; no replacement intent is created. Refresh authorized objects to recover a created reference.')}</p> : <form onSubmit={event => {
      event.preventDefault();
      const fields = new FormData(event.currentTarget);
      void confirmFields({ title: String(fields.get('title') ?? title), project: String(fields.get('project') ?? project) || null });
    }}>
      <label>{t('任务标题', 'Task title')}<input ref={titleInput} name="title" data-testid="document-task-title" value={title} disabled={!editable} onChange={event => { const value = event.target.value; dirty.current.title = true; setTitle(value); creation.changeFields({ title: value }); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={event => { composing.current = false; const value = event.currentTarget.value; dirty.current.title = true; setTitle(value); creation.changeFields({ title: value }); }} onKeyDown={event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || composing.current)) event.preventDefault(); }} required /></label>
      <label>{t('所属项目', 'Project')}<select ref={projectInput} name="project" data-testid="document-task-project" value={project} disabled={!editable} onChange={event => { const value = event.target.value; dirty.current.project = true; setProject(value); creation.changeFields({ project: value || null }); }} required><option value="">{t('请选择项目', 'Choose a project')}</option>{project && !projects.some(file => file.id === project) && <option value={project}>{project}</option>}{projects.map(file => <option key={file.id} value={file.id}>{file.entity.title} · {file.id}</option>)}</select></label>
      <details><summary>{t('任务描述与源双链', 'Task description and source backlink')}</summary><pre>{draft.body}</pre></details>
      {attempt && <p role="status">{t('原生创建状态', 'Native creation status')}: <strong>{attempt.phase}</strong> · <code>{attempt.key}</code>{attempt.entityId && <> · {attempt.entityId}</>}{attempt.message && <> · {attempt.message}</>}</p>}
      {creation.error && <p role="alert">{creation.error}</p>}{creation.sources.error && <p role="alert">{creation.sources.error.message}</p>}
      {inputError && <p role="alert">{inputError}</p>}
      {creation.issues.map((issue, index) => <p role="alert" key={`${issue.field}-${index}`}>{issue.field}: {issue.message}</p>)}
      {!canConfirm && !attempt && <p role="status">{t('源文档、选区或编辑权限已改变；未发送创建。请关闭并从当前选区重新开始。', 'The source, selection, or edit permission changed. No create was sent; close and start from the current selection.')}</p>}
      {creation.storageFailed && <p role="alert">{t('恢复存储不可用；禁止发送，请保留页面。', 'Recovery storage is unavailable. Sending is blocked; keep this page open.')}</p>}
      <div className="document-object-buttons">
        {(!attempt || attempt.phase === 'prepared') && <button type="submit" data-testid="document-task-confirm" disabled={!canConfirm || creation.busy || flushing || !creation.canWrite || creation.storageFailed || store.persistenceError()}>{t('确认并创建任务', 'Confirm and create task')}</button>}
        {(attempt?.phase === 'unknown' || attempt?.phase === 'sending') && <><button type="button" disabled={creation.busy} onClick={() => { void creation.reconcile(); }}>{t('核对原创建结果', 'Check original creation')}</button><button type="button" disabled={creation.busy} onClick={() => { void creation.reconcile(undefined, true); }}>{t('恢复原写入审计', 'Recover original write audit')}</button></>}
        {attempt?.phase === 'rejected' && <button type="button" disabled={creation.busy} onClick={() => creation.resetRejected()}>{t('编辑已确认拒绝的草稿', 'Edit confirmed rejected draft')}</button>}
        {attempt?.phase === 'committed' && <button type="button" disabled={creation.busy} onClick={() => { void creation.openConfirmed(); }}>{t('恢复已确认任务引用', 'Recover confirmed task reference')}</button>}
        <button type="button" onClick={onClose}>{t('关闭并保留恢复记录', 'Close and retain recovery')}</button>
      </div>
    </form>}
    {controller.selectedId !== action.source.id && <p role="status">{t('源文档已切换；不会插入当前文档。', 'The source document changed; nothing will be inserted into the current document.')}</p>}
  </section>;
}

export function DocumentObjectActions({ controller, en, selection, disabled, onInsert }: DocumentObjectActionsProps) {
  const service = usePmService();
  const command = usePmCommand();
  const session = controller.session;
  const storageKey = session.storageKey('document-object-actions');
  const store = useMemo(() => createDocumentObjectStore(storageKey, { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) }), [storageKey, session.scope]);
  const journal = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const defaultProject = controller.entity?.entity === 'project' ? controller.entity.id : controller.entity?.project || controller.projectId || '';
  const [attachmentProject, setAttachmentProject] = useState(defaultProject);
  const versions = usePmEntities('artifact_version', attachmentProject || undefined);
  const projects = usePmEntities('project');
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState('');
  const [running, setRunning] = useState(false);
  const [conversionId, setConversionId] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const operationPending = useRef(false);
  const automaticInsertion = useRef<(() => void) | null>(null);
  const [fileSource, setFileSource] = useState<DocumentObjectSource | null>(null);
  const active = useRef(true);
  const latest = useRef({ controller, selection, disabled, onInsert, service });
  latest.current = { controller, selection, disabled, onInsert, service };
  const t = (zh: string, english: string) => en ? english : zh;
  const entries = Object.values(journal).filter(action => {
    if (action.source.id !== controller.selectedId) return false;
    const targetProject = action.projectId || (action.kind === 'task' ? String(session.creationDrafts.getSnapshot()[action.draftId]?.values.project ?? '') : '');
    return !targetProject || allowed(service.workspace, 'domain.read', targetProject);
  });
  const targets = controller.files.filter(candidate => candidate.id !== controller.selectedId && allowed(service.workspace, 'domain.read', candidate.entity.entity === 'project' ? candidate.id : candidate.entity.project || undefined) && `${candidate.id} ${candidate.entity.title}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const project = projects.data?.find(candidate => candidate.id === attachmentProject);
  const uploadAllowed = !!attachmentProject && service.capabilities?.business.enabled === true && service.capabilities.storage.enabled && allowed(service.workspace, 'delivery.write', attachmentProject) && writable(project);
  const locked = disabled || running || command.pending || !!command.unknownCommand || controller.writesBlocked;

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    setAttachmentProject(defaultProject); setFile(null); setFileSource(null); setMessage(''); setConversionId(null);
  }, [controller.selectedId, defaultProject]);
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === storageKey || event.key === null) store.refresh(); };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [storageKey, store]);
  useEffect(() => session.creationDrafts.subscribe(() => {
    const drafts = session.creationDrafts.getSnapshot();
    const updates = Object.values(store.getSnapshot()).filter((action): action is DocumentTaskAction => action.kind === 'task' && !action.taskId && !!drafts[action.draftId]?.attempt?.entityId && drafts[action.draftId]?.attempt?.phase === 'committed');
    if (updates.length) store.commit(current => {
      const next = { ...current };
      for (const action of updates) next[action.id] = { ...action, taskId: drafts[action.draftId]!.attempt!.entityId, projectId: String(drafts[action.draftId]!.values.project ?? '') };
      return next;
    });
  }), [session, store]);
  useEffect(() => {
    if (locked || !automaticInsertion.current) return;
    const insert = automaticInsertion.current;
    automaticInsertion.current = null;
    void withCreationLock(session.namespace, async () => { store.refresh(); insert(); }).catch(cause => {
      if (active.current) setMessage(cause instanceof Error ? cause.message : String(cause));
    });
  }, [locked, journal, session.namespace, store]);

  function currentSource(): DocumentObjectSource {
    const now = latest.current;
    const revision = now.controller.draft?.revision ?? now.controller.selected?.revision ?? '';
    return captureDocumentObjectSource(now.controller.selectedId, now.controller.raw, revision, now.selection);
  }
  function requireSource(source: DocumentObjectSource) {
    const now = latest.current;
    const c = now.controller;
    const selected = c.selected;
    const draftWritable = c.canWrite && selected?.id === source.id && !c.writesBlocked && !c.busy && !c.conflict && !c.ahead && !c.configurationInvalid && !c.draftParseError && !c.accessError && !c.query.error && !selected.entity.archived && !selected.stale && !selected.error;
    if (!active.current || now.disabled || !draftWritable || !documentObjectSourceMatches(source, currentSource())) throw new Error(t('源文档或选区已改变，未插入；引用已保留，请回到源文档选择位置后手动插入。', 'The source or selection changed. No insertion was made; the real reference is retained. Return to the source and explicitly choose an insertion point.'));
  }
  function commitAction(action: DocumentObjectAction) {
    if (!store.commit(current => ({ ...current, [action.id]: action }))) throw new Error(t('无法保存恢复记录，未发送后续操作；请恢复浏览器存储并保留页面。', 'Recovery storage could not be saved. No further operation was sent; restore browser storage and keep this page open.'));
  }
  async function perform(action: () => Promise<void>) {
    if (operationPending.current) return;
    operationPending.current = true;
    setRunning(true); setMessage('');
    try { await action(); }
    catch (cause) { if (active.current) setMessage(cause instanceof Error ? cause.message : String(cause)); }
    finally { operationPending.current = false; if (active.current) setRunning(false); }
  }
  function insertAction(action: DocumentObjectAction, source: DocumentObjectSource, preserveText: boolean) {
    requireSource(source);
    if (action.source.id !== source.id || action.inserted) throw new Error(t('此引用已插入或属于另一文档。', 'This reference was already inserted or belongs to another document.'));
    if (store.getSnapshot()[action.id]?.inserted) throw new Error(t('此引用已插入，不会重复插入。', 'This reference was already inserted and will not be inserted twice.'));
    const markdown = action.kind === 'task' && action.taskId ? documentTaskReference(preserveText ? source.selection.text : '', action.taskId) : action.kind === 'upload' && action.versionId ? documentAttachmentMarkdown(action.versionId, action.name, action.mediaType) : '';
    if (!markdown) throw new Error(t('尚无已确认的真实引用，请先核对原请求。', 'No confirmed reference exists. Reconcile the original request first.'));
    // Reserve durably before the editor transaction: a lost storage acknowledgement
    // must not offer the same real reference a second time after remount.
    commitAction({ ...action, inserted: true, insertion: 'reserved' });
    try { latest.current.onInsert(markdown); }
    catch (cause) { commitAction({ ...action, inserted: false, insertion: undefined }); throw cause; }
    commitAction({ ...action, inserted: true, insertion: 'inserted' });
    setMessage(t('已插入共享草稿；请显式保存文档。', 'Inserted into the shared draft; explicitly save the document.'));
  }
  async function prepareTask() {
    const source = currentSource();
    requireSource(source);
    const title = documentTaskTitle(source.selection.text);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(source))))].map(value => value.toString(16).padStart(2, '0')).join('');
    const id = `document-task:${digest}`;
    await withCreationLock(session.namespace, async () => {
      requireSource(source); store.refresh(); session.creationDrafts.refresh();
      const existing = store.getSnapshot()[id];
      if (existing?.kind === 'task') { setConversionId(id); return; }
      const draftId = `document-conversion:${digest}`;
      const draft = newCreationDraft(draftId, controller.configuration, { entity: 'work_item', ...(defaultProject ? { project: defaultProject } : {}) });
      draft.values = { ...draft.values, title, related_to: [source.id] };
      draft.body = `${source.selection.text}\n\n${t('来源', 'Source')}: [[${source.id}]]\n\n<!-- pm-document-conversion:${digest} -->\n`;
      const action: DocumentTaskAction = { kind: 'task', id, source, draftId, projectId: defaultProject, inserted: false };
      if (!session.creationDrafts.commit(current => current[draftId] ? current : { ...current, [draftId]: draft })) throw new Error(t('任务恢复草稿无法持久化；未发送创建。', 'The task recovery draft could not be persisted; no create was sent.'));
      commitAction(action);
      setConversionId(id);
    });
  }
  function taskCreated(action: DocumentTaskAction, created: FileRecord) {
    const confirmed: DocumentTaskAction = { ...action, ...(store.getSnapshot()[action.id]?.kind === 'task' ? store.getSnapshot()[action.id] as DocumentTaskAction : {}), taskId: created.id, projectId: created.entity.project };
    try {
      commitAction(confirmed);
      insertAction(confirmed, action.source, true);
    } catch (cause) { if (active.current) setMessage(`${created.id}: ${cause instanceof Error ? cause.message : String(cause)}`); }
    setConversionId(null);
  }
  async function recoverTask(action: DocumentTaskAction) {
    session.creationDrafts.refresh();
    if (session.creationDrafts.getSnapshot()[action.draftId]) throw new Error(t('原生创建草稿仍存在；请先恢复原草稿并核对原请求。', 'The native creation draft still exists. Resume it and reconcile the original request first.'));
    const fresh = await controller.query.refetch({ throwOnError: true });
    if (!active.current || latest.current.service.actorEpoch !== service.actorEpoch || latest.current.service.workspace?.id !== service.workspace?.id || !fresh.data) throw new Error(t('会话已改变或授权快照不可用；未替换原意图。', 'The session changed or the authorized snapshot is unavailable; the original intent was not replaced.'));
    const confirmed = recoverDocumentTaskReference(action, fresh.data.files);
    commitAction({ ...action, taskId: confirmed.id, projectId: confirmed.entity.project });
    setConversionId(null);
    setMessage(t('已读取真实源关联任务；请在源文档选择位置后插入引用，不会再次创建。', 'The real source-linked task was recovered. Choose an insertion point in the source document; it will not be created again.'));
  }
  function chooseFile(chosen: File | undefined) {
    if (!chosen) return;
    try {
      if (locked || !uploadAllowed) throw new Error(t('当前文档、项目或权限不允许上传。', 'The current document, project, or capabilities do not allow uploads.'));
      if (!chosen.size || chosen.size > 8 * 1024 * 1024) throw new Error(t('文件必须为 1 字节至 8 MiB。', 'The file must contain 1 byte to 8 MiB.'));
      const source = currentSource(); requireSource(source);
      setFile(chosen); setFileSource(source); setMessage('');
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function readBase64(chosen: File): Promise<string> {
    const bytes = new Uint8Array(await chosen.arrayBuffer());
    let binary = '';
    for (let index = 0; index < bytes.length; index += 32_768) binary += String.fromCharCode(...bytes.subarray(index, index + 32_768));
    return btoa(binary);
  }
  function requireUploadScope(action: DocumentUploadAction) {
    const now = latest.current;
    if (!active.current || now.service.actorEpoch !== service.actorEpoch || now.service.workspace?.id !== service.workspace?.id || now.service.error || now.service.capabilities?.business.enabled !== true || !now.service.capabilities.storage.enabled || !allowed(now.service.workspace, 'delivery.write', action.projectId) || hasUncertainCreationDrafts(session.creationDrafts.getSnapshot()) || hasUncertainProjectTaskDraft(session.drafts.getSnapshot())) throw new Error(t('上传权限、会话或原写入状态已改变，未发送后续命令；原记录已保留。', 'Upload permission, session, or original write state changed. No further command was sent; the original record is retained.'));
  }
  async function sendUpload(action: DocumentUploadAction, request: Command) {
    return withCreationLock(session.namespace, async () => {
      store.refresh();
      const current = store.getSnapshot()[action.id];
      if (action.step === 'register' && current?.kind === 'upload') {
        if (current.phase === 'done') return current;
        if (current.phase !== 'staged' && !(current.phase === 'rejected' && current.step === 'register')) throw new Error(t('原上传状态已改变；请核对原请求，不能重复登记。', 'The original upload state changed. Reconcile it instead of registering again.'));
      }
      requireUploadScope(action);
      commitAction(action);
      let received: CommandReceipt | undefined;
      try {
        received = await command.execute(request);
        const settled = applyDocumentUploadReceipt(action, received);
        commitAction(settled);
        if (settled.phase === 'done' && active.current) automaticInsertion.current = () => insertAction(settled, settled.source, false);
        return settled;
      } catch (cause) {
        const receipt = cause instanceof PmCommandError ? cause.receipt : undefined;
        const uncertain = !!received || cause instanceof CommandOutcomeUnknown && cause.commandId === action.commandId || cause instanceof PmServiceError && cause.code === 'session_changed';
        commitAction(receipt && receipt.commandId === action.commandId ? applyDocumentUploadReceipt(action, receipt) : { ...action, phase: uncertain ? 'unknown' : 'rejected', error: cause instanceof Error ? cause.message : String(cause) });
        throw cause;
      }
    });
  }
  async function registerUpload(action: DocumentUploadAction) {
    if (!action.uploadId || !action.uploadVersion) throw new Error(t('缺少已确认暂存 ID；请核对原上传。', 'The confirmed staged upload is missing. Reconcile the original upload.'));
    const request = { ...makeCommand('RegisterArtifact', { title: action.name, kind: artifactKindFor(classifyFile(action.name, action.mediaType)), uploadId: action.uploadId }, undefined, action.projectId), expectedVersions: { [action.uploadId]: action.uploadVersion } };
    await sendUpload({ ...action, phase: 'registering', step: 'register', commandId: request.commandId, error: '' }, request);
  }
  async function uploadFile() {
    if (!file || !fileSource || !uploadAllowed) return;
    const chosen = file;
    const source = fileSource;
    requireSource(source);
    const contentBase64 = await readBase64(chosen);
    requireSource(source);
    const request = makeCommand('StageUpload', { contentBase64, fileName: chosen.name, mediaType: chosen.type || 'application/octet-stream' }, undefined, attachmentProject);
    const action: DocumentUploadAction = { kind: 'upload', id: crypto.randomUUID(), source, projectId: attachmentProject, name: chosen.name, mediaType: chosen.type || 'application/octet-stream', phase: 'staging', step: 'stage', commandId: request.commandId, error: '', inserted: false };
    setFile(null); setFileSource(null);
    const staged = await sendUpload(action, request);
    if (staged.phase === 'staged') await registerUpload(staged);
  }
  async function reconcileUpload(action: DocumentUploadAction) {
    if (!action.commandId || !service.workspace || !allowed(service.workspace, 'domain.read', action.projectId)) return;
    let receipt: CommandReceipt | undefined;
    try { receipt = command.unknownCommand?.commandId === action.commandId ? await command.reconcile() : await service.client.getCommandReceipt(service.workspace.id, action.commandId); }
    catch (cause) {
      if (cause instanceof PmCommandError && cause.receipt.commandId === action.commandId) receipt = cause.receipt;
      else throw cause;
    }
    if (!receipt) { setMessage(t('原收据尚不可用，不能证明请求失败；不会重发。', 'The original receipt is unavailable. This does not prove failure; the command will not be replayed.')); return; }
    const settled = applyDocumentUploadReceipt(action, receipt);
    commitAction(settled);
    setMessage(settled.phase === 'staged' ? t('暂存已确认；请显式确认登记成果。', 'Staging is confirmed; explicitly confirm artifact registration.') : t('原结果已核对；请在源文档选择位置后插入引用。', 'The original result is reconciled. Select an insertion point in the source document.'));
  }
  const conversion = conversionId ? journal[conversionId] : undefined;
  let sameSource = false;
  try { sameSource = !!conversion && documentObjectSourceMatches(conversion.source, currentSource()); } catch { /* Invalid source remains read-only. */ }
  if (!controller.selected || controller.accessError || !allowed(service.workspace, 'domain.read', controller.selected.entity.entity === 'project' ? controller.selected.id : controller.selected.entity.project)) return <p role="status">{t('当前无权读取源文档；对象与恢复内容已隐藏。', 'The source document is not currently readable; object actions and private recovery content are hidden.')}</p>;

  return <details className="document-object-actions" data-testid="document-object-actions">
    <summary>{t('对象、任务与附件', 'Objects, tasks and attachments')}</summary>
    <div className="document-object-panel">
      {message && <p role="status" className="document-object-notice">{message}</p>}
      {store.persistenceError() && <p role="alert">{t('恢复存储不可用；禁止新写入。不要清除未知请求记录。', 'Recovery storage is unavailable; new writes are blocked. Do not clear uncertain request records.')} <button type="button" onClick={() => store.refresh()}>{t('重读恢复记录', 'Reload recovery records')}</button></p>}
      <section><h4>{t('授权对象链接与正式关联', 'Authorized object links and relations')}</h4><input aria-label={t('搜索授权对象', 'Search authorized objects')} data-testid="document-object-search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('ID 或标题', 'ID or title')} />
        <ul className="document-object-results">{targets.map(target => <li key={target.id}><span>{target.entity.title} · <code>{target.id}</code></span><button type="button" disabled={locked} onClick={() => { void perform(async () => { const source = currentSource(); requireSource(source); latest.current.onInsert(documentWikiLink(target.id, target.entity.title)); }); }}>{t('插入双链', 'Insert wiki link')}</button><button type="button" disabled={locked || target.entity.archived || target.stale || !!target.error} onClick={() => { void perform(async () => { const source = currentSource(); requireSource(source); controller.updateDraft(relatedDocumentDraft(source.raw, target.id, controller.configuration)); setMessage(t('related_to 已更新共享草稿，尚未保存；正文未丢弃。', 'related_to updated in the shared draft, not saved; the body is preserved.')); }); }}>{t('正式关联', 'Relate formally')}</button></li>)}</ul>
      </section>
      <section><h4>{t('选区或清单转任务', 'Selection or checklist to task')}</h4><button type="button" data-testid="document-convert-task" disabled={locked || !selection.text.trim() || store.persistenceError()} onClick={() => { void perform(prepareTask); }}>{t('检查并准备任务…', 'Review and prepare task…')}</button>
        {conversion?.kind === 'task' && conversion.source.id === controller.selectedId && !conversion.inserted && <TaskConversionForm key={conversion.draftId} action={conversion} store={store} controller={controller} en={en} canConfirm={!locked && sameSource} onCreated={created => taskCreated(conversion, created)} onClose={() => setConversionId(null)} />}
      </section>
      <section><h4>{t('图片与附件', 'Images and attachments')}</h4><label>{t('附件项目', 'Attachment project')}<select aria-label={t('附件项目', 'Attachment project')} value={attachmentProject} disabled={running || command.pending} onChange={event => { setAttachmentProject(event.target.value); setFile(null); setFileSource(null); }}><option value="">{t('请选择项目', 'Choose a project')}</option>{projects.data?.filter(candidate => allowed(service.workspace, 'domain.read', candidate.id)).map(candidate => <option key={candidate.id} value={candidate.id}>{String(candidate.data.title || candidate.id)}</option>)}</select></label>
        <div className="document-object-drop" data-testid="document-attachment-drop" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={event => { if (!event.dataTransfer.files.length) return; event.preventDefault(); if (event.dataTransfer.files.length !== 1) { setMessage(t('每次选择一个文件，以便逐项核对。', 'Choose one file at a time so each outcome can be reconciled.')); return; } chooseFile(event.dataTransfer.files[0]); }}><label>{t('选择或拖入文件（最大 8 MiB）', 'Choose or drop a file (maximum 8 MiB)')}<input type="file" data-testid="document-attachment-file" disabled={locked || !uploadAllowed || store.persistenceError()} onChange={event => { chooseFile(event.target.files?.[0]); event.currentTarget.value = ''; }} /></label></div>
        {file && <p>{file.name} · {file.size} B <button type="button" data-testid="document-upload-confirm" disabled={locked || !uploadAllowed || store.persistenceError()} onClick={() => { void perform(uploadFile); }}>{t('确认上传并登记', 'Confirm upload and registration')}</button><button type="button" onClick={() => { setFile(null); setFileSource(null); }}>{t('取消', 'Cancel')}</button></p>}
        {!uploadAllowed && <p>{t('上传需要可写的项目、delivery.write 和真实存储能力；已有授权附件仍可引用。', 'Uploading requires a writable project, delivery.write and real storage capability. Authorized existing attachments can still be referenced.')}</p>}
        {(versions.error || projects.error) && <p role="alert">{(versions.error || projects.error)?.message}<button type="button" onClick={() => { void versions.refetch(); void projects.refetch(); }}>{t('重读附件', 'Reload attachments')}</button></p>}
        {attachmentProject && <ul className="document-object-results">{versions.data?.map(version => <li key={version.id}><span>{String(version.data.fileName || version.id)} · <code>{version.id}</code></span><button type="button" disabled={locked} onClick={() => { void perform(async () => { const source = currentSource(); requireSource(source); latest.current.onInsert(documentAttachmentMarkdown(version.id, String(version.data.fileName || version.id), String(version.data.mediaType || ''))); }); }}>{t('插入此不可变版本', 'Insert this immutable version')}</button></li>)}</ul>}
      </section>
      {!!entries.length && <section><h4>{t('源文档操作恢复', 'Source document recovery')}</h4><ul className="document-object-recovery">{entries.map(action => <li key={action.id}>
        <strong>{action.kind === 'task' ? t('任务创建', 'Task creation') : action.name}</strong> · {action.kind === 'task' ? action.taskId || t('草稿或待核对', 'Draft or unconfirmed') : action.phase}
        {action.kind === 'task' && !action.taskId && <><button type="button" onClick={() => setConversionId(action.id)}>{t('恢复原任务草稿', 'Resume original task draft')}</button>{!session.creationDrafts.getSnapshot()[action.draftId] && <button type="button" disabled={running || controller.query.isFetching} onClick={() => { void perform(() => withCreationLock(session.namespace, () => recoverTask(action))); }}>{t('从授权对象恢复已创建引用', 'Recover created reference from authorized objects')}</button>}</>}
        {action.kind === 'upload' && action.phase === 'unknown' && <button type="button" disabled={running || command.pending} onClick={() => { void perform(() => withCreationLock(session.namespace, () => reconcileUpload(action))); }}>{t('核对原上传收据', 'Check original upload receipt')}</button>}
        {action.kind === 'upload' && (action.phase === 'staged' || action.phase === 'rejected' && action.step === 'register') && <button type="button" disabled={locked || !allowed(service.workspace, 'delivery.write', action.projectId)} onClick={() => { void perform(() => registerUpload(action)); }}>{t('确认登记已暂存文件', 'Confirm staged file registration')}</button>}
        {action.kind === 'upload' && action.error && <p role="alert">{action.error}</p>}
        {(action.kind === 'task' && action.taskId || action.kind === 'upload' && action.versionId) && <><code className="document-object-reference">{action.kind === 'task' ? `[[${action.taskId}]]` : documentAttachmentMarkdown(action.versionId!, action.name, action.mediaType)}</code>{action.inserted ? <span>{action.insertion === 'reserved' ? t('本次插入结果待核对；请检查源草稿，引用仍可复制，不会自动重插。', 'Insertion is unconfirmed. Inspect the source draft; the reference remains copyable and will not be inserted again automatically.') : t('引用已插入，不会重复插入。', 'Reference inserted; it will not be inserted twice.')}</span> : <button type="button" data-testid="document-recover-reference" disabled={locked} onClick={() => { void perform(() => withCreationLock(session.namespace, async () => { store.refresh(); insertAction(action, currentSource(), true); })); }}>{t('在当前选区插入已确认引用', 'Insert confirmed reference at current selection')}</button>}</>}
      </li>)}</ul></section>}
      <section aria-label={t('Agent 与 Session 能力', 'Agent and Session capabilities')}><h4>Agent / Session</h4><button type="button" disabled aria-describedby="document-agent-unavailable">{t('执行 Agent / 关联 Session（不可用）', 'Execute Agent / associate Session (unavailable)')}</button><p id="document-agent-unavailable">{t('execution 始终为 false；尚无已验收的 Runner / Session 读写合同，不会执行或模拟 Agent。SSE 和 revision 冲突检查不是多人实时协同编辑。', 'execution is always false. No accepted Runner / Session read-write contract exists; Agent actions are neither executed nor simulated. SSE and revision conflicts are not real-time collaborative editing.')}</p></section>
    </div>
  </details>;
}
