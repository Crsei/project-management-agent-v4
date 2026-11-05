import { taskStateLabel } from './task-status-label';
import { TaskWorkflowPanel } from '../workflows/TaskWorkflowPanel';
import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { CalendarDays, Circle, CircleCheck, Flag, Folder, GitBranch, Repeat2, Tag, Timer, UserRound } from 'lucide-react';
import { statusCategory, workflowFor } from '@pm-schema';
import type { MemberDirectory } from '@contracts';
import type { WorkspaceController } from './controller';
import { usePmService, usePrivateQuery } from '../service/pm-service';
import { allowed } from '../service/pm-ui';
import { teamTaskCreateProjectProblem } from '../service/team-task-actions-model';
import { Preview } from './Preview';
import { Properties } from './Properties';
import { TaskTitleField } from './TaskDocumentFields';
import { TaskBlockersField, TaskDetailRelated } from './TaskDetailRelated';
import './task-detail.css';
import { TaskCodeDeliveryPanel } from './TaskCodeDeliveryPanel';
import { RadixSelect } from "@/components/ui/radix-select"

const ordinaryFields = ['title', 'status', 'priority', 'assignee', 'due', 'x-pm-start', 'project', 'labels', 'x-pm-estimate', 'blocked_by'];

/** Only an input buffer, never a second task document. Invalid input stays visible. */
function DraftInput({ value, onValue, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & { value: string; onValue: (value: string) => void }) {
  const [text, setText] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  useEffect(() => { if (props.disabled || document.activeElement !== input.current) setText(value); }, [value, props.disabled]);
  return <input {...props} ref={input} value={text} onChange={event => {
    setText(event.target.value);
    if (!composing.current) onValue(event.target.value);
  }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={event => {
    composing.current = false;
    onValue(event.currentTarget.value);
  }} />;
}

export function TaskCompletionAction({ controller: c, en }: { controller: WorkspaceController; en: boolean }) {
  const entity = c.entity;
  if (!entity || !c.selected) return null;
  const workflow = workflowFor('work_item', c.configuration);
  const completed = statusCategory(entity, c.configuration) === 'completed';
  const savedStatus = c.selected.entity.status;
  const staged = entity.status !== savedStatus;
  const candidates = workflow?.states.filter(state =>
    (completed ? !['completed', 'canceled'].includes(state.category) : state.category === 'completed') &&
    (state.id === savedStatus || workflow.transitions.some(transition => transition.from === savedStatus && transition.to === state.id))) ?? [];
  const label = completed ? (en ? 'Reopen task' : '重新打开') : (en ? 'Mark complete' : '标记完成');
  const Icon = completed ? CircleCheck : Circle;
  if (staged && completed) return <button type="button" className="task-complete is-completed" aria-label={en ? 'Undo staged completion' : '撤销草稿中的完成状态'} disabled={!c.canEditTaskDraft} onClick={() => c.patchTaskDraft({ status: savedStatus })} title={en ? 'Undo staged completion; nothing has been saved' : '撤销草稿中的完成状态；尚未保存'}><Icon size={15} /><span>{en ? 'Completed · draft' : '已完成 · 草稿'}</span></button>;
  if (candidates.length > 1) return <label className={`task-complete task-complete-picker ${completed ? 'is-completed' : ''}`}><Icon size={15} /><span className="sr-only">{label}</span><RadixSelect aria-label={label} title={en ? 'Choose a configured state; explicit Save is required' : '选择配置中的状态后，仍需显式保存'} value="" disabled={!c.canEditTaskDraft} onChange={event => { if (event.target.value) c.patchTaskDraft({ status: event.target.value }); }}><option value="" disabled>{label}…</option>{candidates.map(state => <option key={state.id} value={state.id}>{taskStateLabel(state, en)}</option>)}</RadixSelect></label>;
  return <button type="button" className={`task-complete ${completed ? 'is-completed' : ''}`} aria-label={label} disabled={!c.canEditTaskDraft || !candidates.length} title={!candidates.length ? (en ? 'No legal transition is configured. Use Status to inspect this workflow.' : '未配置合法转换，请在状态字段查看工作流。') : (en ? `Stage ${candidates[0].label}; explicit Save is required` : `暂存为「${candidates[0].label}」，仍需显式保存`)} onClick={() => { if (candidates[0]) c.patchTaskDraft({ status: candidates[0].id }); }}><Icon size={15} /><span>{completed && !candidates.length ? (en ? 'Completed' : '已完成') : label}</span></button>;
}

export function TaskDetailSurface({ controller: c, en, onEditSource, onOpenDelivery }: { controller: WorkspaceController; en: boolean; onEditSource: () => void; onOpenDelivery: () => void }) {
  const { workspace } = usePmService();
  const uid = useId();
  const canReadDirectory = workspace?.capabilities.includes('directory.read') === true || allowed(workspace, 'access.manage');
  const directory = usePrivateQuery<MemberDirectory>([...c.session.queryKey.slice(0, 4), 'members', 'directory'], allowed(workspace, 'access.manage') ? 'access.manage' : 'directory.read', undefined, (client, workspaceId, signal) => client.getMemberDirectory(workspaceId, { signal }), canReadDirectory);
  const entity = c.entity;
  if (!entity || !c.selected) return null;
  const disabled = !c.canEditTaskDraft;
  const project = entity.project ?? '';
  const members = directory.data?.members.filter(member => !member.access?.revokedAt && (!member.access || member.access.capabilities.includes('domain.read') && (member.access.projectIds === null || member.access.projectIds.includes(project)))) ?? [];
  const workflow = workflowFor('work_item', c.configuration);
  const savedStatus = c.selected.entity.status;
  const projects = c.projects.filter(file => allowed(workspace, 'domain.read', file.id) && allowed(workspace, 'planning.edit', file.id) && !teamTaskCreateProjectProblem(c.query.data, file.id, c.drafts));
  const labelSuggestions = [...new Set(c.files.flatMap(file => file.entity.labels))];
  const t = (english: string, zh: string) => en ? english : zh;
  const issue = (name: string) => c.draftDiagnostics.find(diagnostic => diagnostic.field === name && diagnostic.severity === 'error');
  const inputProps = (name: string) => ({ 'aria-invalid': !!issue(name), 'aria-describedby': issue(name) ? `${uid}-${name}-error` : undefined, 'data-testid': `field-${name}`, disabled });
  const field = (name: string, label: string, icon: ReactNode, control: ReactNode) => <div className="task-property" key={name}><dt>{icon}<span>{label}</span></dt><dd>{control}{issue(name) && <small className="task-field-error" id={`${uid}-${name}-error`}>{issue(name)!.message}</small>}</dd></div>;
  const lifecycle = (action: 'archive' | 'restore' | 'delete') => {
    if (action === 'delete') { c.setDeleteTarget(c.selected!); c.setDeleteConfirmation(''); c.setError(''); c.setRequestDiagnostics([]); }
    else void c.lifecycle(c.selected!, action);
  };
  return <article className="task-detail-surface" data-testid="task-detail-surface" aria-label={t('Task details', '任务详情')}>
    <TaskTitleField value={entity.title} disabled={disabled} invalid={!!issue('title')} describedBy={issue('title') ? `${uid}-title-error` : undefined} en={en} required testId="field-title" className="task-title-input" onValue={title => c.patchTaskDraft({ title })} />
    {workspace && c.selected.entity.project && <a className="task-delivery-jump" href={`#task-workflow-${c.selected.id}`} onClick={event => { event.preventDefault(); onOpenDelivery(); }}>{t('Open delivery workspace', '进入交付工作台')} <span>→</span></a>}
    {issue('title') && <small className="task-field-error" id={`${uid}-title-error`}>{issue('title')!.message}</small>}
    {disabled && <p className="task-readonly-note" role="status">{c.draftParseError ? t('The source is invalid. Saved values are shown; repair the Markdown source to edit fields.', '源码无效，当前显示已保存的值；请先修复 Markdown 源码。') : entity.archived ? t('Archived task. Restore it in Advanced properties before editing.', '任务已归档，请在高级属性中恢复后再编辑。') : c.ahead ? t('The source changed on disk. Compare and resolve versions before editing fields.', '磁盘源码已更改，请先比较并解决版本冲突。') : c.writesBlocked ? t('A write is pending or unconfirmed. Resolve its original recovery record before editing.', '有写入待确认或结果未知，请先核对原恢复记录。') : t('Task fields are currently read only. Review the access, source or configuration diagnostics.', '任务字段当前只读，请查看权限、源码或配置诊断。')}</p>}
    <dl className="task-properties">
      {field('status', t('Status', '状态'), <Circle size={14} />, <RadixSelect {...inputProps('status')} aria-label={t('Task status', '任务状态')} value={entity.status ?? ''} onChange={event => c.patchTaskDraft({ status: event.target.value })}>{!workflow?.states.some(state => state.id === entity.status) && <option value={entity.status ?? ''}>{entity.status ?? t('Unavailable', '不可用')}</option>}{workflow?.states.map(state => <option key={state.id} value={state.id} disabled={state.id !== savedStatus && state.id !== entity.status && !workflow.transitions.some(transition => transition.from === savedStatus && transition.to === state.id)}>{taskStateLabel(state, en)}</option>)}</RadixSelect>)}
      {field('priority', t('Priority', '优先级'), <Flag size={14} />, <RadixSelect {...inputProps('priority')} aria-label={t('Task priority', '任务优先级')} value={entity.priority ?? ''} onChange={event => c.patchTaskDraft({ priority: event.target.value || null })}><option value="">{t('No priority', '未设置优先级')}</option>{[['low', 'Low', '低'], ['medium', 'Medium', '中'], ['high', 'High', '高'], ['urgent', 'Urgent', '紧急']].map(([value, english, zh]) => <option key={value} value={value}>{t(english, zh)}</option>)}</RadixSelect>)}
      {field('assignee', t('Assignee', '负责人'), <UserRound size={14} />, <><RadixSelect {...inputProps('assignee')} aria-label={t('Task assignee', '任务负责人')} value={entity.assignee ?? ''} disabled={disabled || !directory.data || !!directory.error || !canReadDirectory} onChange={event => c.patchTaskDraft({ assignee: event.target.value || null })}><option value="">{t('Unassigned', '未分配')}</option>{entity.assignee && !members.some(member => member.userId === entity.assignee) && <option value={entity.assignee}>{entity.assignee} · {t('Current identity unavailable', '当前身份不可用')}</option>}{members.map(member => <option key={member.userId} value={member.userId}>{member.name} · {member.userId}</option>)}</RadixSelect>{!canReadDirectory ? <small className="task-field-note">{t('Member directory permission is required to reassign.', '更改负责人需要成员目录读取权限。')}</small> : directory.error ? <div className="task-field-note" role="alert">{t('Member directory unavailable; not an empty directory.', '成员目录读取失败，不代表没有成员。')} <button type="button" className="text-button" onClick={() => { void directory.refetch(); }}>{t('Retry', '重试')}</button></div> : !directory.data ? <small className="task-field-note" role="status">{t('Loading eligible members…', '正在读取可分派成员…')}</small> : null}</>)}
      {field('due', t('Due date', '截止日期'), <CalendarDays size={14} />, <DraftInput {...inputProps('due')} aria-label={t('Due date', '截止日期')} type="date" value={entity.due ?? ''} onValue={due => c.patchTaskDraft({ due: due || null })} />)}
      {field('x-pm-start', t('Start date', '开始日期'), <CalendarDays size={14} />, <DraftInput {...inputProps('x-pm-start')} aria-label={t('Start date', '开始日期')} type="date" value={entity['x-pm-start'] ?? ''} onValue={start => c.patchTaskDraft({ 'x-pm-start': start || null })} />)}
      {field('project', t('Project', '项目'), <Folder size={14} />, <RadixSelect {...inputProps('project')} aria-label={t('Task project', '任务项目')} value={project} onChange={event => c.patchTaskDraft({ project: event.target.value || null })}><option value="" disabled={!!project}>{t('No project', '未关联项目')}</option>{project && !projects.some(file => file.id === project) && <option value={project}>{c.projects.find(file => file.id === project)?.entity.title ?? project} · {t('Current project', '当前项目')}</option>}{projects.map(file => <option key={file.id} value={file.id}>{file.entity.title} · {file.id}</option>)}</RadixSelect>)}
      {field('labels', t('Labels', '标签'), <Tag size={14} />, <><DraftInput {...inputProps('labels')} aria-label={t('Task labels, comma-separated', '任务标签，以逗号分隔')} value={entity.labels.join(', ')} list={`${uid}-labels`} placeholder={t('Add labels', '添加标签')} onValue={value => c.patchTaskDraft({ labels: [...new Set(value.split(',').map(label => label.trim()).filter(Boolean))] })} /><datalist id={`${uid}-labels`}>{labelSuggestions.map(label => <option key={label} value={label} />)}</datalist><small className="task-field-note">{t('Comma-separated · new labels allowed', '逗号分隔 · 可输入新标签')}</small></>)}
      {field('repeat', t('Repeat', '重复'), <Repeat2 size={14} />, <><button type="button" className="task-unavailable-control" disabled aria-describedby={`${uid}-repeat-note`}>{t('Not available', '尚未接入')}</button><small className="task-field-note" id={`${uid}-repeat-note`}>{t('Recurring task creation is not connected. No repeat rule is saved.', '尚未接入周期任务创建，不会保存虚构重复规则。')}</small></>)}
      {field('x-pm-estimate', t('Estimate', '估算'), <Timer size={14} />, <><div className="task-points-input"><DraftInput {...inputProps('x-pm-estimate')} aria-label={t('Estimate points', '估算点')} type="number" min={0} max={1_000_000} step="any" value={String(entity['x-pm-estimate'] ?? '')} placeholder={t('Unknown', '未知')} onValue={value => c.patchTaskDraft({ 'x-pm-estimate': value === '' ? null : Number(value) })} /><span>{t('points', '点')}</span></div><small className="task-field-note">{t('Blank = unknown; 0 = explicit zero. Duration is separate in Advanced.', '空白为未知，0 为明确零；预计持续天数在高级属性中单独设置。')}</small></>)}
      {field('blocked_by', t('Blocked by', '阻塞项'), <GitBranch size={14} />, <TaskBlockersField controller={c} en={en} />)}
    </dl>
    <section className="task-description" aria-labelledby={`${uid}-description`}><div className="task-section-heading"><h3 id={`${uid}-description`}>{t('Description', '描述')}</h3><button type="button" className="text-button" onClick={onEditSource}>{t('Edit Markdown', '编辑 Markdown')}</button></div><Preview raw={c.draftParseError ? c.selected.raw : c.raw} body={entity.body} hideTitle viewProps={{ ...c.viewProps, files: c.files, allFiles: c.files }} disabled={disabled} onToggle={c.toggleTaskChecklist} onLink={c.wikiLink} /><p className="task-field-note">{t('Markdown source is shared with this view. Checklist edits are drafts until Save; checklist items are not subtasks.', '此视图与 Markdown 源码共享草稿；检查项修改需显式保存，正文检查项不是正式子任务。')}</p></section>
    {workspace && c.selected.entity.project && <TaskWorkflowPanel taskStatus={c.selected.entity.status ?? '未设置'} key={`workflow:${workspace.id}:${c.selected.entity.project}:${c.selected.id}`} workspaceId={workspace.id} projectId={c.selected.entity.project} taskId={c.selected.id} revision={c.selected.revision} disabled={disabled || !!c.draft || !!c.ahead || c.writesBlocked} />}
    <TaskDetailRelated controller={c} en={en} />
    {workspace && c.selected.entity.project && <TaskCodeDeliveryPanel key={`${workspace.id}:${c.selected.id}:${c.selected.revision}`} workspaceId={workspace.id} projectId={c.selected.entity.project} taskId={c.selected.id} revision={c.selected.revision} disabled={disabled || !!c.draft || !!c.ahead || c.writesBlocked} en={en} />}
    <details className="task-advanced-properties"><summary>{t('Advanced properties & lifecycle', '高级属性与生命周期')}</summary><Properties file={c.selected} entity={entity} files={c.files} configuration={c.configuration} disabled={disabled} lifecycleDisabled={!c.canManageLifecycle(c.selectedId) || c.draftInvalid} dirty={!!c.draft} draftMode excludeFields={ordinaryFields} section="properties" en={en} onPatch={c.patchTaskDraft} onLink={c.wikiLink} onLifecycle={lifecycle} onContext={() => { void c.loadContext(); }} /></details>
  </article>;
}
