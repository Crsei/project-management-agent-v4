import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@contracts';
import { localDirectorySchema, type LocalDirectory, type LocalProjectPreview } from '../../../../../../packages/contracts/src/local-projects';
import { useCoreSession } from '../markdown/session';
import { withCreationLock } from '../markdown/creation-store';
import { hasUncertainCreationDrafts } from '../markdown/creation-model';
import { hasUncertainProjectTaskDraft } from './project-task-editing-model';
import { localProjectApi } from './local-project-api';
import { useLocalProjectSettings } from './local-project-hooks';
import { LocalDirectoryFields } from './local-directory-fields';
import { applyLocalMoveResult, createLocalMoveStore, type LocalMoveDraft } from './local-project-move-store';
import { usePmCommand, usePmService, usePrivateQuery } from './pm-service';
import { allowed, useText } from './pm-ui';
import './local-projects.css';

/** Physical storage actions never masquerade as Markdown edits or PM commands. */
export function ProjectLocalLocation({ projectId }: { projectId: string }) {
  const session = useCoreSession();
  const service = usePmService();
  const command = usePmCommand();
  const queryClient = useQueryClient();
  const settings = useLocalProjectSettings();
  const t = useText();
  const api = useMemo(() => localProjectApi(service.client, session.queryKey[3]), [service.client, session]);
  const storageKey = session.storageKey(`local-project-move:${projectId}`);
  const store = useMemo(() => createLocalMoveStore(storageKey, { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) }), [storageKey]);
  const draft = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const location = usePrivateQuery([...session.queryKey.slice(0, 4), 'local-projects', 'location', projectId], 'access.manage', undefined,
    (_client, _workspaceId, signal) => api.location(projectId, signal), settings.data?.enabled === true && settings.data.canManage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<{ directory: string; result: LocalProjectPreview } | null>(null);
  const active = useRef(true);
  const running = useRef(false);
  const latest = useRef({ service, command, settings });
  latest.current = { service, command, settings };
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === storageKey || event.key === null) store.refresh(); };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [storageKey, store]);
  async function run(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(true); setError(''); setNotice('');
    try { await withCreationLock(session.namespace, async () => { store.refresh(); await action(); }); }
    catch (cause) {
      if (active.current) setError(cause instanceof Error ? cause.message : String(cause));
      if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) await session.onAccessFailure();
    } finally { running.current = false; if (active.current) setBusy(false); }
  }
  function save(change: (value: LocalMoveDraft) => LocalMoveDraft, durable = false) {
    if (!store.update(change, durable) && durable) throw new Error(t('恢复存储不可用；未发送后续写入，请保留页面。', 'Recovery storage is unavailable. No additional write was sent; keep this page open.'));
  }
  function editDraft(change: (value: LocalMoveDraft) => LocalMoveDraft) {
    void withCreationLock(session.namespace, async () => {
      store.refresh();
      if (active.current && !store.getSnapshot().attempt) save(change);
    }).catch(cause => { if (active.current) setError(cause instanceof Error ? cause.message : String(cause)); });
  }
  function edit(directory: LocalDirectory) {
    setPreview(null);
    editDraft(value => ({ ...value, directory, mode: value.mode ?? (location.data?.kind === 'legacy' ? 'move' : location.data?.status === 'unavailable' ? 'rebind' : 'move') }));
  }
  async function check(recover: boolean) {
    await run(async () => {
      const attempt = store.getSnapshot().attempt;
      if (!attempt || attempt.phase === 'ready' || attempt.phase === 'rejected') return;
      const result = await (recover ? api.recover(attempt.key) : api.attempt(attempt.key));
      save(value => value.attempt?.key === attempt.key ? { ...value, attempt: applyLocalMoveResult(value.attempt, result) } : value, true);
      await queryClient.invalidateQueries({ queryKey: session.queryKey.slice(0, 4) });
    });
  }
  async function move() {
    await run(async () => {
      const now = latest.current;
      if (!active.current || now.service.actor?.id !== session.queryKey[2] || now.service.actorEpoch !== session.queryKey[6] || now.service.workspace?.id !== session.queryKey[3]) throw new Error(t('会话已改变；未发送。', 'The session changed. Nothing was sent.'));
      if (!now.settings.data?.enabled || !now.settings.data.canManage || !allowed(now.service.workspace, 'planning.edit') || now.service.capabilities?.business.enabled !== true || now.service.error || !navigator.onLine) throw new Error(t('需要可用的本地服务和全局存储管理/计划编辑权限。', 'An available local service and unrestricted storage-management/planning-edit permissions are required.'));
      session.creationDrafts.refresh();
      if (now.command.pending || now.command.unknownCommand || hasUncertainCreationDrafts(session.creationDrafts.getSnapshot()) || hasUncertainProjectTaskDraft(session.drafts.getSnapshot())) throw new Error(t('请先核对原待定写入；未发送目录切换。', 'Reconcile the original pending write before changing storage.'));
      const current = store.getSnapshot();
      if (current.attempt) throw new Error(t('原目录操作仍保留；请核对或结束已确认操作，不要换键重做。', 'The original storage operation is retained. Reconcile it or finish a confirmed operation instead of replacing its key.'));
      if (!current.writersStopped) throw new Error(t('请先停止外部编辑器和写入进程并确认。', 'Stop external editors and writing processes, then confirm.'));
      const directory = localDirectorySchema.parse(current.directory);
      const fresh = await location.refetch({ throwOnError: true });
      if (!fresh.data) throw new Error(t('无法确认当前存储身份。', 'The current storage identity could not be confirmed.'));
      const operation = fresh.data.kind === 'legacy' ? 'migrate' as const : 'relocate' as const;
      const mode = operation === 'migrate' ? 'move' : current.mode ?? (fresh.data.status === 'unavailable' ? 'rebind' : 'move');
      if (mode === 'rebind' && directory.mode !== 'existing') throw new Error(t('重新绑定需要已移动且保留原身份标记的现有目录。', 'Rebinding requires an existing moved directory retaining its original identity marker.'));
      if (mode === 'move') {
        if (preview?.directory !== JSON.stringify(directory)) throw new Error(t('请先预检切换目标。', 'Preview the destination first.'));
        await api.preview(directory);
      }
      if (!active.current || latest.current.service.actor?.id !== session.queryKey[2] || latest.current.service.actorEpoch !== session.queryKey[6] || latest.current.service.workspace?.id !== session.queryKey[3]) throw new Error(t('会话已改变；未发送目录切换。', 'The session changed. No storage move was sent.'));
      const attempt = { key: crypto.randomUUID(), projectId, operation, mode, directory, writersStopped: true as const, phase: 'sending' as const, message: '' };
      save(value => ({ ...value, attempt }), true);
      try {
        const result = await api.move(projectId, operation, directory, attempt.key, mode);
        save(value => value.attempt?.key === attempt.key ? { ...value, attempt: applyLocalMoveResult(value.attempt, result) } : value, true);
      } catch (cause) {
        save(value => value.attempt?.key === attempt.key ? { ...value, attempt: { ...value.attempt, phase: 'unknown', message: cause instanceof Error ? cause.message : String(cause) } } : value, true);
        throw cause;
      }
      await queryClient.invalidateQueries({ queryKey: session.queryKey.slice(0, 4) });
    });
  }
  if (settings.error) return <section className="local-notice" role="alert"><p>{settings.error.message}</p><button type="button" className="local-button" onClick={() => { void settings.refetch(); }}>{t('重新读取存储能力', 'Read storage capability again')}</button></section>;
  if (!settings.data) return <p className="local-hint" role="status">{t('正在读取项目存储能力…', 'Reading project storage capability…')}</p>;
  if (!settings.data.enabled) return null;
  if (!settings.data.canManage) return <p className="local-hint">{t('项目保存在本地目录；主机路径和存储维护仅向工作区全局管理员开放。', 'This project uses local storage. Host paths and storage maintenance are restricted to workspace-wide administrators.')}</p>;
  const current = location.data;
  const attempt = draft.attempt;
  const directory = attempt?.directory ?? draft.directory;
  const relocationMode = current?.kind === 'legacy' ? 'move' : attempt?.mode ?? draft.mode ?? (current?.status === 'unavailable' ? 'rebind' : 'move');
  const selectedPreview = preview && preview.directory === JSON.stringify(directory) ? preview.result : null;
  const editable = !busy && !attempt && allowed(service.workspace, 'planning.edit');
  return <section className="local-project-panel" aria-label={t('项目本地存储', 'Project local storage')}>
    <h2>{t('项目本地存储', 'Project local storage')} · <code>{projectId}</code></h2>
    {location.isPending && <p role="status">{t('正在核对磁盘目录…', 'Checking the disk directory…')}</p>}
    {location.error && <p role="alert">{location.error.message}</p>}
    {current && <>
      <p role="status"><strong>{current.status === 'available' ? t('目录可用', 'Directory available') : t('目录不可用 / 挂载缺失', 'Directory unavailable / mount missing')}</strong> · {current.kind === 'legacy' ? t('原工作区存储（尚未迁移）', 'Original workspace storage (not migrated)') : t('已登记的项目目录', 'Registered project directory')}</p>
      {current.reason && <p className="local-notice">{current.reason}</p>}
      {current.status !== 'available' && <p className="local-notice">{t('请恢复原磁盘或挂载，或显式重新定位到同一身份的已有目录。应用不会创建空替代目录，也不会自动重试迁移。', 'Restore the original disk/mount or explicitly relocate to an existing directory with the same identity. The application will not create an empty replacement or automatically repeat migration.')}</p>}
      {current.path && <div className="local-actions"><code className="local-path" data-testid="project-local-path">{current.path}</code><button type="button" className="local-button" onClick={async () => { try { await navigator.clipboard.writeText(current.path!); setNotice(t('路径已复制。', 'Path copied.')); } catch { setError(t('浏览器无法复制路径；请手动选择路径。', 'The browser could not copy this path. Select it manually.')); } }}>{t('复制路径', 'Copy path')}</button></div>}
      {current.storageId && <p className="local-hint">{t('存储身份', 'Storage identity')}: <code>{current.storageId}</code></p>}
    </>}
    <button type="button" className="local-button" disabled={busy} onClick={() => { void location.refetch(); }}>{t('重新核对目录状态', 'Check directory status again')}</button>
    <details><summary>{current?.kind === 'legacy' ? t('显式迁移到项目文件夹', 'Explicitly migrate to a project folder') : t('重新定位已有项目目录 / 恢复', 'Relocate an existing project directory / recover')}</summary>
      <div className="local-initialization">
        {current?.kind === 'local' && <label>{t('重新定位方式', 'Relocation method')}<select aria-label={t('重新定位方式', 'Relocation method')} value={relocationMode} disabled={!editable} onChange={event => { const mode = event.target.value as 'move' | 'rebind'; setPreview(null); editDraft(value => ({ ...value, mode, directory: undefined, writersStopped: false })); }}><option value="move">{t('移动：复制托管内容并切换到新目录', 'Move: copy managed content and cut over to a new directory')}</option><option value="rebind">{t('找回：重新绑定已完整移动的原项目目录', 'Locate: rebind the original, fully moved project directory')}</option></select></label>}
        <p>{relocationMode === 'rebind' ? t('仅在原路径已不存在时，重新登记由你完整移动、且身份标记匹配的现有目录。不复制、不重建原目录；标记冲突、身份不符或原目录仍存在时拒绝。', 'Only when the original path is absent, rebind an existing directory that you fully moved with its matching identity marker. Nothing is copied and the old directory is not recreated. Conflicting markers, identity mismatches or an existing original directory are rejected.') : t('将原权威文件和附件受控复制到新建或未登记的目标目录，保留全部 ID、revision、关系及历史引用；校验后切换并清理旧权威副本。不修改用户原文件。', 'Copy authoritative files and attachments to a new or unregistered destination while preserving IDs, revisions, relations and historical references; verify, cut over and clean the old authoritative copy. Existing user files are not modified.')}</p>
        <LocalDirectoryFields key={`${session.scope}:${projectId}:${relocationMode}`} value={directory} defaultParent={settings.data.defaultParent} existingOnly={relocationMode === 'rebind'} disabled={!editable || !current} onChange={edit} />
        {relocationMode === 'move' && <button type="button" className="local-button" disabled={!editable || !directory} onClick={() => { void run(async () => { const selected = localDirectorySchema.parse(store.getSnapshot().directory); const result = await api.preview(selected); if (active.current) setPreview({ directory: JSON.stringify(selected), result }); }); }}>{t('预检切换目标', 'Preview destination')}</button>}
        {(selectedPreview || directory?.mode === 'existing') && <p className="local-path">{relocationMode === 'rebind' ? t('所选绝对路径（提交时核对身份）', 'Selected absolute path (identity checked at submission)') : t('最终绝对路径', 'Final absolute path')}: {selectedPreview ? selectedPreview.path : directory?.mode === 'existing' ? directory.path : ''}</p>}
        <label className="local-actions"><input type="checkbox" checked={draft.writersStopped} disabled={!editable} onChange={event => { const writersStopped = event.target.checked; editDraft(value => ({ ...value, writersStopped })); }} />{t('我已停止此项目的所有外部编辑器与写入进程；在核对完成前保持停写。', 'I have stopped all external editors and writing processes for this project and will keep them stopped until reconciliation completes.')}</label>
        <p className="local-hint">{t('原文件不会被无条件覆盖；不会递归删除用户目录。此操作不是完整数据库备份。', 'Existing files are not blindly overwritten; user directories are never recursively deleted. This operation is not a complete database backup.')}</p>
        <button type="button" className="local-button" disabled={!editable || !current || !directory || !draft.writersStopped || store.persistenceError() || relocationMode === 'move' && preview?.directory !== JSON.stringify(directory)} onClick={() => { void move(); }}>{current?.kind === 'legacy' ? t('确认并迁移', 'Confirm and migrate') : relocationMode === 'rebind' ? t('核对身份并重新绑定', 'Verify identity and rebind') : t('确认移动并切换目录', 'Confirm move and cut over')}</button>
      </div>
    </details>
    {attempt && <div className="local-notice" role="status"><p>{t('原目录操作', 'Original storage operation')}: {attempt.operation} · {attempt.phase}</p><p className="local-path">{t('原请求键', 'Original request key')}: {attempt.key}</p>{attempt.message && <p>{attempt.message}</p>}{(attempt.phase === 'unknown' || attempt.phase === 'sending') && <><p>{t('原参数和请求键已冻结。刷新不会解除，不会换键重复执行。', 'The original parameters and key are frozen. Refresh does not release them or repeat the operation with a new key.')}</p><div className="local-actions"><button type="button" className="local-button" disabled={busy} onClick={() => { void check(false); }}>{t('核对原目录操作', 'Check original storage operation')}</button><button type="button" className="local-button" disabled={busy} onClick={() => { void check(true); }}>{t('恢复原目录操作', 'Recover original storage operation')}</button></div></>}{(attempt.phase === 'ready' || attempt.phase === 'rejected') && <button type="button" className="local-button" disabled={busy} onClick={() => { void run(async () => { save(value => value.attempt?.phase === 'ready' || value.attempt?.phase === 'rejected' ? { ...value, writersStopped: false, attempt: undefined } : value, true); }); }}>{attempt.phase === 'ready' ? t('结束已确认目录操作', 'Finish confirmed storage operation') : t('保留目标并编辑已拒绝操作', 'Keep destination and edit rejected operation')}</button>}</div>}
    {store.persistenceError() && <div role="alert"><p>{t('浏览器恢复存储不可用；禁止派发新操作，请勿清除未知请求。', 'Browser recovery storage is unavailable. New operations are blocked; do not clear unknown requests.')}</p><button type="button" className="local-button" onClick={() => { void run(async () => { save(value => value, true); }); }}>{t('重试保存恢复记录', 'Retry saving recovery record')}</button></div>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}
