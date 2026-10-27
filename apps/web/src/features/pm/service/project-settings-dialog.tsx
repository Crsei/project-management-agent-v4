import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Entity } from '@contracts';
import type { FileRecord } from '@pm-schema';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useCoreSession, useSessionDrafts } from '../markdown/session';
import { usePmCommand, usePmEntities, usePmService, useProjectDirectory } from './pm-service';
import { useMemberDirectory } from './pm-member-hooks';
import { allowed, Choice, CommandNotice, Field, useDraftState, useText } from './pm-ui';
import { ProjectTeamAssignment } from './project-directory';
import { PROJECT_COLORS, PROJECT_ICONS, projectSettingsUpdate, projectSettingsValues, projectSourceVersion, stableProjectPath, type ProjectSettingsValues } from './project-menu-model';
import styles from './project-menu.module.css';

type SettingsDraft = { source: FileRecord; project: Entity; values: ProjectSettingsValues };

export function ProjectSettingsDialog({ project, open, onOpenChange }: { project: Entity; open: boolean; onOpenChange: (open: boolean) => void }) {
  const session = useCoreSession();
  const service = usePmService();
  const command = usePmCommand();
  const projects = usePmEntities('project');
  const query = useQuery({ queryKey: session.queryKey, queryFn: ({ signal }) => session.api.workspace(signal), retry: false, enabled: open });
  const source = query.data?.files.find(file => file.id === project.id && file.entity.entity === 'project');
  const t = useText();
  return <Dialog open={open} onOpenChange={next => { if (!command.pending) onOpenChange(next); }}><DialogContent className={styles.dialog} data-testid="project-settings-dialog"><DialogTitle>{t('项目设置', 'Project settings')}</DialogTitle><DialogDescription>{t('编辑真实项目；保留 Markdown 源码、未修改字段与原始版本。取消不会保存。', 'Edit the real project while retaining its Markdown source, untouched fields and original version. Cancel does not save.')}</DialogDescription>
    {query.isPending && <p role="status">{t('正在读取项目源文件…', 'Loading the project source…')}</p>}
    {query.error && <div role="alert" className={styles.form}><p>{query.error.message}</p></div>}
    {source && !query.error && <SettingsEditor key={project.id} project={project} source={source} readBlocked={!!query.data?.configurationErrors.some(issue => issue.severity === 'error') || !!service.error} onOpenChange={onOpenChange} />}
    {!query.isPending && !query.error && !source && <p role="alert">{t('项目源文件不存在或不可访问。', 'The project source is missing or unavailable.')}</p>}
    <Button variant="ghost" className="mt-3 justify-self-start" disabled={command.pending || query.isFetching || projects.isFetching} onClick={() => { void query.refetch(); void projects.refetch(); }}>{t('重新读取项目与源文件', 'Read project and source again')}</Button>
  </DialogContent></Dialog>;
}

function SettingsEditor({ project, source, readBlocked, onOpenChange }: { project: Entity; source: FileRecord; readBlocked: boolean; onOpenChange: (open: boolean) => void }) {
  const service = usePmService();
  const session = useCoreSession();
  const command = usePmCommand();
  const directory = useProjectDirectory();
  const members = useMemberDirectory();
  const [sourceDrafts] = useSessionDrafts();
  const [retainedDraft, setDraft] = useDraftState<SettingsDraft | null>(`project-settings:${project.id}`, 'draft', null);
  const draft = retainedDraft ?? { source, project, values: projectSettingsValues(source) };
  const [error, setError] = useState('');
  const t = useText();
  const conflict = draft.source.revision !== source.revision || draft.project.version !== project.version;
  const synchronized = projectSourceVersion(source.revision) === project.version;
  const invalidSource = source.stale || source.error || source.diagnostics?.some(issue => issue.severity === 'error');
  const permission = allowed(service.workspace, 'planning.edit', project.id) && service.capabilities?.business.enabled === true && !source.entity.archived;
  const locked = command.pending || !!command.unknownCommand;
  const blocked = locked || readBlocked || !!invalidSource || !!sourceDrafts[project.id] || !permission || !synchronized || conflict;
  const candidates = members.error ? [] : (members.data?.members ?? []).filter(member => member.access && !member.access.revokedAt && member.access.capabilities.includes('domain.read') && (member.access.projectIds === null || member.access.projectIds.includes(project.id))).map(member => ({ id: member.userId, name: member.name }));
  const people = [...new Map([
    ...(directory.data?.projects.find(row => row.projectId === project.id)?.identities ?? []),
    ...candidates,
    ...(service.actor && allowed(service.workspace, 'domain.read', project.id) ? [{ id: service.actor.id, name: service.actor.name }] : []),
  ].map(person => [person.id, person])).values()];
  const owners = [...people.map(person => ({ value: person.id, label: person.name })), ...(draft.values.ownerId && !people.some(person => person.id === draft.values.ownerId) ? [{ value: draft.values.ownerId, label: `${t('当前负责人', 'Current owner')} · ${draft.values.ownerId}` }] : [])];
  const original = projectSettingsValues(draft.source);
  const dirty = Object.keys(original).some(key => draft.values[key as keyof ProjectSettingsValues] !== original[key as keyof ProjectSettingsValues]);
  const sourceHref = service.workspace ? `/pm/${encodeURIComponent(service.workspace.id)}/entities/${encodeURIComponent(project.id)}?${new URLSearchParams({ returnTo: stableProjectPath(service.workspace.id, project.id) })}` : '#';
  const change = (patch: Partial<ProjectSettingsValues>) => { setDraft(previous => ({ ...(previous ?? draft), values: { ...(previous ?? draft).values, ...patch } })); setError(''); };
  async function save() {
    if (blocked || !dirty) return;
    setError('');
    try {
      if (!draft.values.name.trim() || draft.values.name.length > 300 || /[\r\n]/.test(draft.values.name)) throw new Error(t('名称须为 1–300 个字符且为单行。', 'The name must contain 1–300 characters on a single line.'));
      if (draft.values.description !== original.description && draft.values.description.length > 64000) throw new Error(t('正文不能超过 64000 个字符。', 'The body cannot exceed 64000 characters.'));
      const receipt = await command.execute({ commandId: crypto.randomUUID(), commandType: 'UpdateProject', targetId: project.id, projectId: project.id, expectedVersions: { [project.id]: draft.project.version }, payload: projectSettingsUpdate(draft.source, draft.values) });
      if (receipt.status === 'committed') { setDraft(null); onOpenChange(false); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  return <div className={styles.form}>
    <CommandNotice />
    {!permission && <p role="status" className={styles.notice}>{t('需要当前项目计划编辑权限，且项目必须未归档。', 'Current project planning-edit permission and an unarchived project are required.')}</p>}
    {readBlocked && <p role="alert" className={styles.notice}>{t('配置或当前服务读取异常；禁止保存，请先恢复真实授权读取。', 'Configuration or current service reads are unavailable. Saving is blocked until authorized reads recover.')}</p>}
    {!synchronized && <p role="status" className={styles.notice}>{t('项目与 Markdown 快照尚未同步；请重新读取后保存。', 'Project and Markdown snapshots are not synchronized. Read again before saving.')}</p>}
    {!!invalidSource && <p role="alert" className={styles.notice}>{t('源文件无效或过期；请在完整编辑器处理。', 'The source is invalid or stale. Repair it in the full editor.')}</p>}
    {sourceDrafts[project.id] && <p role="status" className={styles.notice}>{t('已有未保存源码草稿；设置不会覆盖。', 'An unsaved source draft already exists; settings will not overwrite it.')} <Link className="underline" to={sourceHref} onClick={() => onOpenChange(false)}>{t('继续源码编辑', 'Resume source editing')}</Link></p>}
    {conflict && <div role="status" className={styles.conflict}><p>{t('服务端版本已变化。草稿与原版本保留，未自动合并或重试。', 'The saved version changed. Your draft and its original baseline remain retained; nothing is merged or retried automatically.')}</p><p className={styles.notice}>{source.entity.title} · <code className="break-all">{source.revision}</code></p><Button variant="outline" disabled={locked || !synchronized} onClick={() => setDraft({ ...draft, source, project })}>{t('采用当前版本并保留填写内容', 'Use current version and keep entered fields')}</Button><Button variant="ghost" disabled={locked} onClick={() => setDraft(null)}>{t('放弃填写内容并读取当前值', 'Discard entered fields and load current values')}</Button></div>}
    <form onSubmit={event => { event.preventDefault(); void save(); }} className={styles.form}>
      <fieldset disabled={locked || !permission} className={styles.fields}>
        <Field label={t('项目名称', 'Project name')} value={draft.values.name} onChange={name => change({ name })} required />
        <Field label={t('描述 / Markdown 正文', 'Description / Markdown body')} value={draft.values.description} onChange={description => change({ description })} multiline />
        <div className={styles.columns}><Choice label={t('负责人 / Lead', 'Owner / lead')} value={draft.values.ownerId} onChange={ownerId => change({ ownerId })} options={[{ value: '', label: t('未分配', 'Unassigned') }, ...owners]} disabled={!!directory.error || !directory.data || !!members.error} /><Field label={t('目标日期', 'Target date')} type="date" value={draft.values.dueDate} onChange={dueDate => change({ dueDate })} /></div>
        <div className={styles.columns}><Choice label={t('图标', 'Icon')} value={draft.values.icon} onChange={icon => change({ icon })} options={[{ value: '', label: t('默认图标', 'Default icon') }, ...[...new Set([...PROJECT_ICONS, draft.values.icon].filter(Boolean))].map(value => ({ value, label: value }))]} /><Choice label={t('颜色', 'Color')} value={draft.values.color} onChange={color => change({ color })} options={[{ value: '', label: t('默认颜色', 'Default color') }, ...[...new Set([...PROJECT_COLORS, draft.values.color].filter(Boolean))].map(value => ({ value, label: value }))]} /></div>
      </fieldset>
      {directory.error && <p role="alert" className={styles.notice}>{directory.error.message}</p>}
      {members.error && <p role="alert" className={styles.notice}>{members.error.message}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className={styles.actions}><Button type="button" variant="outline" disabled={command.pending} onClick={() => onOpenChange(false)}>{t('取消', 'Cancel')}</Button><Button type="submit" data-testid="project-settings-save" disabled={blocked || !dirty}>{t('保存项目设置', 'Save project settings')}</Button></div>
    </form>
    <p className={styles.notice}>{t('稳定 ID、工作流、目标及完成标准不变。源码修订：', 'The stable ID, workflow, goal and completion criteria are unchanged. Source revision: ')}<code className="break-all">{draft.source.revision}</code></p>
    <details><summary className="cursor-pointer text-sm font-medium">{t('团队关联（独立保存）', 'Team assignments (save separately)')}</summary><div className="space-y-3 pt-3"><p className={styles.notice}>{t('复用现有团队编辑器；仅点击其保存才写入，不授予项目访问权限。取消上方项目设置不会撤销已经明确保存的团队修改。', 'Uses the existing team editor. Only its own Save writes changes, and assignments grant no project access. Canceling settings does not undo team changes you explicitly saved separately.')}</p><ProjectTeamAssignment project={project} /></div></details>
    {session.drafts.persistenceError() && <p role="alert">{t('源码草稿存储不可用，请保留页面。', 'Source draft storage is unavailable. Keep this page open.')}</p>}
  </div>;
}
