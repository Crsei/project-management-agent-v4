import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { CalendarDays, Circle, Flag, Folder, GitBranch, Tag, Timer, UserRound } from 'lucide-react';
import { statusCategory, workflowFor } from '@pm-schema';
import { MemberPicker } from '../service/people-components';
import type { WorkspaceController } from './controller';
import { usePmService } from '../service/pm-service';
import { allowed } from '../service/pm-ui';
import { teamTaskCreateProjectProblem } from '../service/team-task-actions-model';
import { Properties } from './Properties';
import { TaskBlockersField } from './TaskDetailRelated';
import { taskStateLabel } from './task-status-label';
import { RadixSelect } from '@/components/ui/radix-select';
import { HumanIdentity } from '../service/human-identity';

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

const sidebarFields = ['title', 'status', 'priority', 'assignee', 'due', 'x-pm-start', 'project', 'labels', 'x-pm-estimate', 'blocked_by', 'repeat'] as const;

export function TaskContextSidebar({ controller: c, en }: { controller: WorkspaceController; en: boolean }) {
  const { workspace } = usePmService();
  const uid = useId();
  const [moreOpen, setMoreOpen] = useState(false);
  const entity = c.entity;
  const task = c.selected;
  if (!entity || !task) return null;
  const disabled = !c.canEditTaskDraft;
  const project = entity.project ?? '';
  const t = (english: string, zh: string) => en ? english : zh;
  const workflow = workflowFor('work_item', c.configuration);
  const savedStatus = task.entity.status;
  const state = workflow?.states.find(candidate => candidate.id === entity.status);
  const stateLabel = state ? taskStateLabel(state, en) : entity.status || t('Unavailable', '不可用');
  const projects = c.projects.filter(file => allowed(workspace, 'domain.read', file.id) && allowed(workspace, 'planning.edit', file.id) && !teamTaskCreateProjectProblem(c.query.data, file.id, c.drafts));
  const labelSuggestions = [...new Set(c.files.flatMap(file => file.entity.labels))];
  const issue = (name: string) => c.draftDiagnostics.find(diagnostic => diagnostic.field === name && diagnostic.severity === 'error');
  const inputProps = (name: string) => ({ 'aria-invalid': !!issue(name), 'aria-describedby': issue(name) ? `${uid}-${name}-error` : undefined, 'data-testid': `field-${name}`, disabled });
  const field = (name: string, label: string, icon: ReactNode, control: ReactNode) => <div className="task-property" key={name}><dt>{icon}<span>{label}</span></dt><dd>{control}{issue(name) && <small className="task-field-error" id={`${uid}-${name}-error`}>{issue(name)!.message}</small>}</dd></div>;
  const lifecycle = (action: 'archive' | 'restore' | 'delete') => {
    if (action === 'delete') { c.setDeleteTarget(task); c.setDeleteConfirmation(''); c.setError(''); c.setRequestDiagnostics([]); }
    else void c.lifecycle(task, action);
  };
  return <section className="issue-context-card issue-properties" aria-label={t('Task properties', '任务属性')}>
    <header className="issue-context-card-heading"><h3>{t('Properties', '属性')}</h3><span className="issue-state-chip" data-category={statusCategory(entity, c.configuration) ?? 'unknown'}>{stateLabel}</span></header>
    <dl className="task-properties">
      {field('status', t('Status', '状态'), <Circle size={14} />, <RadixSelect {...inputProps('status')} aria-label={t('Task status', '任务状态')} value={entity.status ?? ''} onChange={event => c.patchTaskDraft({ status: event.target.value })}>{!workflow?.states.some(state => state.id === entity.status) && <option value={entity.status ?? ''}>{entity.status ?? t('Unavailable', '不可用')}</option>}{workflow?.states.map(state => <option key={state.id} value={state.id} disabled={state.id !== savedStatus && state.id !== entity.status && !workflow.transitions.some(transition => transition.from === savedStatus && transition.to === state.id)}>{taskStateLabel(state, en)}</option>)}</RadixSelect>)}
      {field('assignee', t('Assignee', '负责人'), <UserRound size={14} />, <div className="space-y-2"><HumanIdentity userId={entity.assignee} projectId={project} /><MemberPicker purpose="assignee" projectId={project} value={entity.assignee ?? null} disabled={disabled} label={t('Task assignee', '任务负责人')} onChange={assignee => c.patchTaskDraft({ assignee })} /></div>)}
      {field('priority', t('Priority', '优先级'), <Flag size={14} />, <RadixSelect {...inputProps('priority')} aria-label={t('Task priority', '任务优先级')} value={entity.priority ?? ''} onChange={event => c.patchTaskDraft({ priority: event.target.value || null })}><option value="">{t('No priority', '未设置优先级')}</option>{[['low', 'Low', '低'], ['medium', 'Medium', '中'], ['high', 'High', '高'], ['urgent', 'Urgent', '紧急']].map(([value, english, zh]) => <option key={value} value={value}>{t(english, zh)}</option>)}</RadixSelect>)}
      {field('due', t('Due date', '截止日期'), <CalendarDays size={14} />, <DraftInput {...inputProps('due')} aria-label={t('Due date', '截止日期')} type="date" value={entity.due ?? ''} onValue={due => c.patchTaskDraft({ due: due || null })} />)}
      {field('labels', t('Labels', '标签'), <Tag size={14} />, <><DraftInput {...inputProps('labels')} aria-label={t('Task labels, comma-separated', '任务标签，以逗号分隔')} value={entity.labels.join(', ')} list={`${uid}-labels`} placeholder={t('Add labels', '添加标签')} onValue={value => c.patchTaskDraft({ labels: [...new Set(value.split(',').map(label => label.trim()).filter(Boolean))] })} /><datalist id={`${uid}-labels`}>{labelSuggestions.map(label => <option key={label} value={label} />)}</datalist></>)}
    </dl>
    <button type="button" className="issue-context-more" aria-expanded={moreOpen} onClick={() => setMoreOpen(value => !value)}>{moreOpen ? t('Less properties', '收起属性') : t('More properties', '更多属性')}</button>
    {moreOpen && <dl className="task-properties issue-context-more-fields">
      {field('x-pm-start', t('Start date', '开始日期'), <CalendarDays size={14} />, <DraftInput {...inputProps('x-pm-start')} aria-label={t('Start date', '开始日期')} type="date" value={entity['x-pm-start'] ?? ''} onValue={start => c.patchTaskDraft({ 'x-pm-start': start || null })} />)}
      {field('project', t('Project', '项目'), <Folder size={14} />, <RadixSelect {...inputProps('project')} aria-label={t('Task project', '任务项目')} value={project} onChange={event => c.patchTaskDraft({ project: event.target.value || null })}><option value="" disabled={!!project}>{t('No project', '未关联项目')}</option>{project && !projects.some(file => file.id === project) && <option value={project}>{c.projects.find(file => file.id === project)?.entity.title ?? t('Current project', '当前项目')}</option>}{projects.map(file => <option key={file.id} value={file.id}>{file.entity.title}</option>)}</RadixSelect>)}
      {field('x-pm-estimate', t('Estimate', '估算'), <Timer size={14} />, <div className="task-points-input" title={t('Blank = unknown; 0 = explicit zero.', '空白为未知，0 为明确零。')}><DraftInput {...inputProps('x-pm-estimate')} aria-label={t('Estimate points', '估算点')} type="number" min={0} max={1_000_000} step="any" value={String(entity['x-pm-estimate'] ?? '')} placeholder={t('Unknown', '未知')} onValue={value => c.patchTaskDraft({ 'x-pm-estimate': value === '' ? null : Number(value) })} /><span>{t('points', '点')}</span></div>)}
      {field('blocked_by', t('Blocked by', '阻塞项'), <GitBranch size={14} />, <TaskBlockersField controller={c} en={en} />)}
    </dl>}
    <details className="task-advanced-properties issue-advanced-properties"><summary>{t('Advanced properties & lifecycle', '高级属性与生命周期')}</summary><Properties file={task} entity={entity} files={c.files} configuration={c.configuration} disabled={disabled} lifecycleDisabled={!c.canManageLifecycle(c.selectedId) || c.draftInvalid} dirty={!!c.draft} draftMode excludeFields={sidebarFields} section="properties" en={en} onPatch={c.patchTaskDraft} onLink={c.wikiLink} onLifecycle={lifecycle} onContext={() => { void c.loadContext(); }} /></details>
  </section>;
}
