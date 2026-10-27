import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Entity } from '@contracts';
import { useLocation, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useCoreSession, useSessionDrafts } from '../markdown/session';
import { usePmCommand, usePmEntities, usePmService } from './pm-service';
import { allowed, CommandNotice, Field, string, useText } from './pm-ui';
import { projectArchived, projectDeletionBlockers, projectSourceVersion, stableProjectPath } from './project-menu-model';
import styles from './project-menu.module.css';

export type ProjectLifecycleAction = 'archive' | 'restore' | 'delete';
export function ProjectLifecycleDialog({ project, action, open, onOpenChange }: { project: Entity; action: ProjectLifecycleAction; open: boolean; onOpenChange: (open: boolean) => void }) {
  const session = useCoreSession();
  const service = usePmService();
  const command = usePmCommand();
  const projects = usePmEntities('project');
  const [drafts] = useSessionDrafts();
  const query = useQuery({ queryKey: session.queryKey, queryFn: ({ signal }) => session.api.workspace(signal), retry: false, enabled: open });
  const source = query.data?.files.find(file => file.id === project.id && file.entity.entity === 'project');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [baseProject, setBaseProject] = useState(project);
  const sourceChanged = baseProject.version !== project.version;
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const running = useRef(false);
  const navigate = useNavigate();
  const location = useLocation();
  const t = useText();
  const title = action === 'archive' ? t('归档项目', 'Archive project') : action === 'restore' ? t('恢复已归档项目', 'Restore archived project') : t('永久删除项目', 'Permanently delete project');
  const archived = projectArchived(project);
  const permission = allowed(service.workspace, 'planning.lifecycle', project.id) && service.capabilities?.business.enabled === true;
  const blockers = action === 'delete' && query.data && !query.error ? projectDeletionBlockers(query.data, project.id) : [];
  const sourceInvalid = !!source && (source.stale || source.error || source.diagnostics?.some(issue => issue.severity === 'error'));
  const synchronized = !!source && projectSourceVersion(source.revision) === project.version;
  const locked = command.pending || !!command.unknownCommand;
  const blocked = locked || sourceChanged || !permission || !!query.error || !source || !!sourceInvalid || !synchronized || !!drafts[project.id] || !!query.data?.configurationErrors.some(issue => issue.severity === 'error') || action === 'archive' && archived || action !== 'archive' && !archived || blockers.length > 0 || action === 'delete' && name !== string(project.data.name);
  const identity = `${service.actor?.id}:${service.workspace?.id}:${service.actorEpoch}`;
  const latestIdentity = useRef(identity);
  latestIdentity.current = identity;
  async function submit() {
    if (blocked || running.current || !service.workspace) return;
    running.current = true; setError('');
    try {
      const envelope = { commandId: crypto.randomUUID(), targetId: project.id, projectId: project.id, expectedVersions: { [project.id]: baseProject.version } };
      const receipt = await command.execute(action === 'delete'
        ? { ...envelope, commandType: 'DeleteObject', payload: { kind: 'project' } }
        : action === 'archive'
          ? { ...envelope, commandType: 'ArchiveObject', payload: { kind: 'project', reason: 'Archived from project menu' } }
          : { ...envelope, commandType: 'RestoreArchivedObject', payload: { kind: 'project', reason: 'Restored from project menu' } });
      if (!active.current || latestIdentity.current !== identity || receipt.status !== 'committed') return;
      onOpenChange(false);
      const root = stableProjectPath(service.workspace.id, project.id);
      if (action !== 'restore' && (location.pathname === root || location.pathname.startsWith(`${root}/`))) navigate(`/pm/${encodeURIComponent(service.workspace.id)}/projects${action === 'archive' ? '?archive=archived' : ''}`);
    } catch (cause) { if (active.current && latestIdentity.current === identity) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { running.current = false; }
  }
  return <Dialog open={open} onOpenChange={next => { if (!command.pending) onOpenChange(next); }}><DialogContent className={styles.dialog} data-testid={`project-${action}-dialog`}><DialogTitle>{title}</DialogTitle><DialogDescription>{action === 'archive'
    ? t('项目将从活动侧栏隐藏；任务、文件和评论保留。不完成项目或任务，也不删除任何用户目录。可从项目列表的“已归档”入口恢复。', 'The project is hidden from the active sidebar. Tasks, files and comments remain. This does not complete the project or its tasks, or remove user directories. Restore it from Archived in the project list.')
    : action === 'restore' ? t('取消归档并重新显示在侧栏；保持原有工作流状态与数据，不恢复任何虚假快照。', 'Remove the archive flag and show the project in the sidebar again. Existing workflow states and data are retained; no snapshot rollback is performed.')
      : t('永久删除仅允许已归档、来源可验证且无入站引用的项目。不会级联删除任务、历史或本地代码目录；操作没有撤销。服务端提交时再次检查所有授权与引用。', 'Permanent deletion requires an archived project with verifiable sources and no inbound references. Tasks, history and local code directories are not cascade-deleted. There is no undo. The server rechecks all permissions and references on submit.')}</DialogDescription>
    <div className={styles.form}><p className="break-words font-medium">{string(project.data.name) || project.id} <span className="text-muted-foreground">· {project.id}</span></p><CommandNotice />
      {query.isPending && <p role="status">{t('正在读取真实源文件与引用…', 'Reading real sources and references…')}</p>}
      {query.error && <p role="alert">{query.error.message}</p>}
      {!permission && <p role="status">{t('需要当前项目生命周期管理权限。', 'Project lifecycle-management permission is required.')}</p>}
      {sourceChanged && <section role="status" className={styles.conflict}><p>{t('项目版本已变化，未发送操作。请核对当前项目后明确采用新版本。', 'The project version changed; no operation was sent. Review the current project and explicitly adopt its new version.')}</p><Button variant="outline" disabled={locked || !synchronized} onClick={() => { setBaseProject(project); setError(''); }}>{t('已核对，采用当前版本', 'Reviewed: use current version')}</Button></section>}
      {action === 'delete' && !archived && <p role="alert">{t('请先归档项目；活动项目不能永久删除。', 'Archive the project first. Active projects cannot be permanently deleted.')}</p>}
      {drafts[project.id] && <p role="alert">{t('已有未保存的项目源码草稿；请先在完整编辑器处理。', 'An unsaved project source draft exists. Resolve it in the full editor first.')}</p>}
      {sourceInvalid && <p role="alert">{t('源文件不可验证，禁止生命周期写入。', 'The source cannot be verified. Lifecycle writes are blocked.')}</p>}
      {query.data?.configurationErrors.some(issue => issue.severity === 'error') && <p role="alert">{t('工作区配置存在错误；请先修复，未发送生命周期操作。', 'Workspace configuration contains errors. Repair it first; no lifecycle operation was sent.')}</p>}
      {!query.isPending && !synchronized && <p role="status">{t('项目与源文件快照未同步，请重新读取。', 'Project and source snapshots are not synchronized. Read again.')}</p>}
      {blockers.length > 0 && <section aria-label={t('删除阻止原因', 'Deletion blockers')} className={styles.conflict}><p>{t('删除被当前可见引用或来源问题阻止：', 'Deletion is blocked by visible references or source problems:')}</p><ul className="list-inside list-disc text-sm">{blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul></section>}
      <Button variant="outline" disabled={locked || query.isFetching || projects.isFetching} onClick={() => { void query.refetch(); void projects.refetch(); }}>{t('重新读取源文件与引用', 'Read sources and references again')}</Button>
      <form onSubmit={event => { event.preventDefault(); void submit(); }} className={styles.form}>{action === 'delete' && <Field label={t('输入完整项目名称以确认永久删除', 'Enter the exact full project name to confirm permanent deletion')} value={name} onChange={setName} disabled={locked || !archived} required />}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className={styles.actions}><Button type="button" variant="outline" disabled={command.pending} onClick={() => onOpenChange(false)}>{t('取消', 'Cancel')}</Button><Button type="submit" data-testid={`project-${action}-confirm`} variant={action === 'delete' ? 'destructive' : 'default'} disabled={blocked}>{title}</Button></div>
      </form>
    </div>
  </DialogContent></Dialog>;
}
