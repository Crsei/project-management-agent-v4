import { useEffect, useRef, useState } from 'react';
import type { Entity } from '@contracts';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { localDirectorySchema, type LocalDirectory } from '../../../../../../packages/contracts/src/local-projects';
import { usePmCommand, usePmService } from './pm-service';
import { allowed, CommandNotice, Field, string, useDraftState, useText } from './pm-ui';
import { LocalDirectoryFields } from './local-directory-fields';
import { localProjectApi } from './local-project-api';
import { useLocalProjectSettings } from './local-project-hooks';
import { projectArchived, stableProjectPath } from './project-menu-model';
import styles from './project-menu.module.css';

export function ProjectDuplicateDialog({ project, open, onOpenChange }: { project: Entity; open: boolean; onOpenChange: (open: boolean) => void }) {
  const service = usePmService();
  const command = usePmCommand();
  const settings = useLocalProjectSettings(open);
  const navigate = useNavigate();
  const t = useText();
  const unknown = command.unknownCommand?.commandType === 'DuplicateProject' && command.unknownCommand.targetId === project.id ? command.unknownCommand : undefined;
  const [name, setName] = useDraftState(`project-copy:${project.id}`, 'name', unknown?.payload.name ?? `${string(project.data.name) || project.id} copy`);
  const [includeTasks, setIncludeTasks] = useDraftState(`project-copy:${project.id}`, 'includeTasks', unknown?.payload.includeTasks ?? true);
  const [directory, setDirectory] = useDraftState<LocalDirectory | undefined>(`project-copy:${project.id}`, 'directory', unknown?.payload.localDirectory);
  const [baseProject, setBaseProject] = useState(() => ({ ...project, version: unknown?.expectedVersions?.[project.id] ?? project.version }));
  const sourceChanged = baseProject.version !== project.version;
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [preflight, setPreflight] = useState<{ input: string; path: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const identity = `${service.actor?.id}:${service.workspace?.id}:${service.actorEpoch}`;
  const latestIdentity = useRef(identity);
  latestIdentity.current = identity;
  const local = service.capabilities?.localProjects.enabled === true;
  const canRecover = allowed(service.workspace, 'planning.edit', project.id) && service.workspace?.projectIds === null && service.capabilities?.business.enabled === true;
  const canCopy = canRecover && !projectArchived(project) && !sourceChanged;
  const canLocal = !local || settings.data?.canManage === true;
  const locked = command.pending || !!command.unknownCommand || busy;
  const preflightMatches = !!directory && preflight?.input === JSON.stringify(directory);
  async function preview() {
    if (running.current || locked || !service.workspace || !canLocal) return;
    running.current = true; setBusy(true); setError('');
    try {
      const parsed = localDirectorySchema.parse(directory);
      const result = await localProjectApi(service.client, service.workspace.id).preview(parsed);
      if (latestIdentity.current === identity) setPreflight({ input: JSON.stringify(parsed), path: result.path });
    } catch (cause) { if (latestIdentity.current === identity) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { running.current = false; if (latestIdentity.current === identity) setBusy(false); }
  }
  async function duplicate() {
    if (running.current || locked || !canCopy || !canLocal || !service.workspace || local && !preflightMatches) return;
    running.current = true; setBusy(true); setError('');
    try {
      if (!name.trim() || name.length > 300) throw new Error(t('请输入 1–300 个字符的项目名称。', 'Enter a project name containing 1–300 characters.'));
      const receipt = await command.execute({ commandId: crypto.randomUUID(), commandType: 'DuplicateProject', targetId: project.id, projectId: project.id, expectedVersions: { [project.id]: baseProject.version }, payload: { name: name.trim(), includeTasks, ...(local ? { localDirectory: localDirectorySchema.parse(directory) } : {}) } });
      if (!active.current || latestIdentity.current !== identity) return;
      const result = receipt.status === 'committed' ? receipt.result as { id?: unknown } : undefined;
      if (receipt.status !== 'committed' || typeof result?.id !== 'string') throw new Error(t('尚未确认新项目 ID，请核对原收据。', 'The new project ID is not confirmed. Check the original receipt.'));
      onOpenChange(false);
      navigate(stableProjectPath(service.workspace.id, result.id));
    } catch (cause) { if (latestIdentity.current === identity) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { running.current = false; if (latestIdentity.current === identity) setBusy(false); }
  }
  async function reconcileOriginal(resume: boolean) {
    if (!unknown || running.current || command.pending || !service.workspace || resume && !canRecover) return;
    running.current = true; setBusy(true); setError('');
    try {
      if (resume) await service.client.recoverCommand(service.workspace.id, unknown.commandId);
      const receipt = await command.reconcile();
      if (!active.current || latestIdentity.current !== identity) return;
      const result = receipt?.status === 'committed' ? receipt.result as { id?: unknown } : undefined;
      if (receipt?.status === 'committed' && typeof result?.id === 'string') { onOpenChange(false); navigate(stableProjectPath(service.workspace.id, result.id)); }
    } catch (cause) { if (latestIdentity.current === identity) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { running.current = false; if (latestIdentity.current === identity) setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={next => { if (!busy && !command.pending) onOpenChange(next); }}><DialogContent className={styles.dialog} data-testid="project-duplicate-dialog"><DialogTitle>{t('复制项目', 'Duplicate project')}</DialogTitle><DialogDescription>{t('创建新的真实项目及可选的未归档任务；新 ID、新目录和工作流初始状态。源项目保持不变。', 'Create a new real project and optionally its unarchived tasks, with new IDs, a new directory and initial workflow states. The source project remains unchanged.')}</DialogDescription>
    <div className={styles.form}><CommandNotice />
      <p className={styles.notice}>{t('仅复制项目内容和选择范围内的任务及内部关系。不复制授权、评论、审计、审核、执行历史、附件字节、用户代码或其他项目目录；这不是完整历史备份。', 'Copies project content and the selected task scope with remapped internal relations. Permissions, comments, audits, reviews, execution history, attachment bytes, user code and other project directories are not copied. This is not a full historical backup.')}</p>
      {(!canRecover || projectArchived(project)) && <p role="status">{t('需要工作区级计划编辑权限，源项目必须未归档。', 'Workspace-wide planning-edit permission and an unarchived source project are required.')}</p>}
      {sourceChanged && <section role="status" className={styles.conflict}><p>{t('源项目版本已变化，复制表单保留。不会自动采用新版本或重试。', 'The source project version changed. Your copy form is retained; no new version is adopted or retried automatically.')}</p><Button variant="outline" disabled={locked} onClick={() => { setBaseProject(project); setError(''); }}>{t('核对后采用当前源版本', 'Review and use the current source version')}</Button></section>}
      {unknown && <section className={styles.conflict} aria-label={t('核对原复制请求', 'Reconcile original copy')}><p>{t('原复制结果未知。关闭或刷新不会生成新请求。只核对原收据或显式恢复已保存的原复制。', 'The original copy outcome is unknown. Closing or reloading never creates a new request. Only check its receipt or explicitly recover the saved original copy.')}</p><code className="break-all">{unknown.commandId}</code><p className={styles.notice}>{t('原请求名称', 'Original requested name')}: {unknown.payload.name} · {unknown.payload.includeTasks ? t('包含未归档任务', 'Includes unarchived tasks') : t('仅项目', 'Project only')}</p><Button variant="outline" disabled={busy || command.pending} onClick={() => { void reconcileOriginal(false); }}>{t('查询原复制收据', 'Check original copy receipt')}</Button><Button variant="outline" disabled={busy || command.pending || !canRecover} onClick={() => { void reconcileOriginal(true); }}>{t('恢复原复制并核对', 'Recover original copy and reconcile')}</Button></section>}
      <form className={styles.form} onSubmit={event => { event.preventDefault(); void duplicate(); }}><fieldset className={styles.fields} disabled={locked || !canCopy}>
        <Field label={t('新项目名称', 'New project name')} value={name} onChange={setName} required />
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={includeTasks} onChange={event => setIncludeTasks(event.target.checked)} /><span>{t('包含未归档任务（任务关系重新映射，工作流重置）', 'Include unarchived tasks (remap relations and reset workflow)')}</span></label>
      </fieldset>
      {local && <>{settings.isPending && !settings.data && <p role="status">{t('正在读取本地存储设置…', 'Loading local storage settings…')}</p>}<LocalDirectoryFields value={directory} defaultParent={settings.data?.defaultParent ?? null} disabled={locked || !canCopy || !canLocal} onChange={value => { setDirectory(value); setPreflight(null); }} />{!settings.isPending && !settings.error && !canLocal && <p role="status">{t('本地复制需要工作区全局存储管理权限。', 'Local copying requires unrestricted workspace storage-management permission.')}</p>}<Button type="button" variant="outline" disabled={locked || !canCopy || !canLocal || !directory} onClick={() => { void preview(); }}>{busy ? t('正在预检 / 核对…', 'Preflighting / reconciling…') : t('预检新目录', 'Preflight new directory')}</Button>{preflightMatches && <p role="status" className={styles.notice}>{t('已预检（提交时服务端再次验证）：', 'Preflight complete (the server revalidates on submit): ')}<span className="break-all">{preflight?.path}</span></p>}</>}
      {settings.error && <div role="alert"><p>{settings.error.message}</p><Button type="button" variant="outline" onClick={() => { void settings.refetch(); }}>{t('重新读取存储设置', 'Read storage settings again')}</Button></div>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className={styles.actions}><Button type="button" variant="outline" disabled={busy || command.pending} onClick={() => onOpenChange(false)}>{t('取消', 'Cancel')}</Button><Button type="submit" data-testid="project-duplicate-confirm" disabled={locked || !canCopy || !canLocal || !name.trim() || !!settings.error || local && !preflightMatches}>{t('确认复制项目', 'Confirm duplicate project')}</Button></div></form>
    </div>
  </DialogContent></Dialog>;
}
