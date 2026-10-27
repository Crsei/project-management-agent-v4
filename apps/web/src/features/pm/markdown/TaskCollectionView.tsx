import { type ReactNode } from 'react';
import { Bookmark, CalendarDays, Flag, MoreHorizontal, Plus, UserRound } from 'lucide-react';
import { workflowFor, type FileRecord, type WorkflowDefinition } from '@pm-schema';
import { PMView, StatusIcon, priorities } from '@pm-views';
import { usePersonalDashboard, usePmService } from '../service/pm-service';
import { useAction } from '../service/pm-ui';
import { useWorkspaceStore } from '@/providers/app-providers';
import { useDisplayDateTime } from '@/features/workspace/preference-format';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { TaskPersonalList } from './TaskPersonalList';
import { taskStateLabel } from './task-status-label';
import type { WorkspaceController } from './controller';
import type { ScheduleViewProps } from './workspace';

const priorityLabels: Record<string, string> = { urgent: '紧急', high: '高', medium: '中', low: '低' };

function TaskRow({ file, controller: c, en, workflow, dueLabel }: { file: FileRecord; controller: WorkspaceController; en: boolean; workflow: WorkflowDefinition | undefined; dueLabel?: string }) {
  const personal = usePersonalDashboard();
  const { actor } = usePmService();
  const action = useAction();
  const watch = personal.data?.watches.find(record => record.data.taskId === file.id);
  const status = workflow?.states.find(state => state.id === file.entity.status);
  const statusLabel = status ? taskStateLabel(status, en) : file.entity.status;
  const project = c.projects.find(project => project.id === file.entity.project)?.entity.title || file.entity.project || (en ? 'Unassigned' : '未关联');
  const assigneeLabel = !file.entity.assignee ? en ? 'Unassigned' : '未分配' : file.entity.assignee === actor?.id ? actor.name : en ? 'Assigned' : '已分配';
  return <li className={`task-native-row${c.selectedId === file.id ? ' selected' : ''}`} data-testid={`task-${file.id}`}>
    <button type="button" className="task-list-title" title={file.entity.title} onClick={() => c.select(file.id)}>
      <StatusIcon category={status?.category} />
      <span className="task-list-identity"><span className="mono">{file.id}</span><strong>{file.entity.title}</strong>{c.draftIds.has(file.id) && <small className="draft-pill">{en ? 'Local draft' : '本地草稿'}</small>}</span>
    </button>
    <span className="task-row-status" title={statusLabel}><span className="sr-only">{en ? 'Status: ' : '状态：'}</span>{statusLabel}</span>
    <span className="task-row-assignee" title={assigneeLabel}><UserRound size={13} aria-hidden="true" /><span className="sr-only">{en ? 'Assignee: ' : '负责人：'}</span><span>{assigneeLabel}</span></span>
    <span className={`task-row-priority priority-${file.entity.priority}`}><span className="sr-only">{en ? 'Priority: ' : '优先级：'}</span>{file.entity.priority ? en ? file.entity.priority : priorityLabels[file.entity.priority] || file.entity.priority : '—'}</span>
    <span className="task-row-due"><span className="sr-only">{en ? 'Due: ' : '截止：'}</span>{file.entity.due ? <time dateTime={file.entity.due} title={file.entity.due}>{dueLabel}</time> : '—'}</span>
    {!c.projectId && <span className="task-row-project" title={`${project} · ${file.entity.project || ''}`}><span className="sr-only">{en ? 'Project: ' : '项目：'}</span>{project}</span>}
    <div className="task-row-actions">
      <button type="button" className="icon-button task-watch" aria-pressed={!!watch} aria-label={`${watch ? en ? 'Unwatch' : '取消关注' : en ? 'Watch' : '关注'} ${file.entity.title}`} disabled={c.writesBlocked || action.locked || !personal.data || !!personal.error || !file.entity.project} onClick={() => { void action.run(() => action.execute(watch ? { commandId: crypto.randomUUID(), commandType: 'UnwatchTask', targetId: watch.id, projectId: file.entity.project!, expectedVersions: { [watch.id]: watch.version }, payload: {} } : { commandId: crypto.randomUUID(), commandType: 'WatchTask', projectId: file.entity.project!, payload: { taskId: file.id } })); }}><Bookmark size={15} fill={watch ? 'currentColor' : 'none'} /></button>
      <Popover><PopoverTrigger type="button" className="icon-button task-row-edit-trigger" aria-label={`${en ? 'Task actions for' : '任务操作'} ${file.id}`} title={en ? 'Edit task fields' : '编辑任务属性'}><MoreHorizontal size={16} /></PopoverTrigger><PopoverContent className="task-row-editor" align="end" aria-label={`${en ? 'Edit fields for' : '编辑属性'} ${file.id}`}>
        <h3>{file.id} · {en ? 'Task fields' : '任务属性'}</h3>
        <label>{en ? 'Status' : '状态'}<select aria-label={`${en ? 'Status for' : '状态'} ${file.id}`} value={file.entity.status} disabled={!c.canEdit(file.id)} onChange={event => { void c.patch(file.id, { status: event.target.value }); }}>{workflow?.states.map(state => <option key={state.id} value={state.id} disabled={file.entity.status !== state.id && !workflow.transitions.some(transition => transition.from === file.entity.status && transition.to === state.id)}>{taskStateLabel(state, en)}</option>)}</select></label>
        <label>{en ? 'Priority' : '优先级'}<select aria-label={`${en ? 'Priority for' : '优先级'} ${file.id}`} value={file.entity.priority} disabled={!c.canEdit(file.id)} onChange={event => { void c.patch(file.id, { priority: event.target.value }); }}>{priorities.map(priority => <option key={priority} value={priority}>{en ? priority : priorityLabels[priority]}</option>)}</select></label>
        <p><UserRound size={13} aria-hidden="true" />{en ? 'Assignee' : '负责人'}: {assigneeLabel}</p>
        <PopoverClose type="button" className="task-row-open" onClick={() => c.select(file.id)}>{en ? 'Open task details' : '打开任务详情'}</PopoverClose>
      </PopoverContent></Popover>
    </div>
    <div className="task-mobile-metadata"><span>{statusLabel}</span>{file.entity.priority && <span className={`priority-${file.entity.priority}`}><Flag size={11} aria-hidden="true" />{en ? file.entity.priority : priorityLabels[file.entity.priority] || file.entity.priority}</span>}{file.entity.due && <time dateTime={file.entity.due}><CalendarDays size={11} aria-hidden="true" />{dueLabel}</time>}{!c.projectId && <span className="task-project-association" title={project}>{project}</span>}</div>
    {action.localError && <p className="task-row-error" role="alert">{action.localError}</p>}
  </li>;
}

/** Every scope projects the same authorized files; layout never owns the task set. */
export function TaskCollectionView({ controller: c, en, renderSchedule, toolbarTarget, personal }: { controller: WorkspaceController; en: boolean; renderSchedule: (props: ScheduleViewProps) => ReactNode; toolbarTarget?: HTMLElement | null; personal?: { today: string | null; actorId: string | null } }) {
  const showCompletedTasks = useWorkspaceStore(state => state.showCompletedTasks);
  const display = useDisplayDateTime();
  const collection = c.taskCollection;
  if (!collection) return null;
  if (c.scopePending) return <p className="task-scope-notice" role="status">{en ? 'Reading your personal task context…' : '正在读取个人任务上下文…'}</p>;
  if (c.scopeError) return null;
  if (personal && c.prefs.layout === 'list') return <TaskPersonalList controller={c} en={en} today={personal.today} actorId={personal.actorId} />;
  const workflow = workflowFor('work_item', c.configuration);
  const board = c.prefs.layout === 'kanban';
  const timeline = c.prefs.layout === 'gantt';
  const scheduled = c.prefs.layout === 'calendar' || c.prefs.layout === 'gantt' || c.prefs.layout === 'graph';
  // Lists group all/important tasks by workflow state; boards keep every task in its column, while schedules keep one open lane plus terminal drawers.
  const boardFiles = showCompletedTasks ? collection.files : [...collection.open, ...collection.canceled];
  const grouped = board ? [{ id: 'open', files: boardFiles, due: undefined }] : scheduled ? [{ id: 'open', files: collection.open, due: undefined }] : collection.groups;
  const terminalDrawers = scheduled;
  function render(files: FileRecord[], terminal = false) {
    if (!terminal && (c.prefs.layout === 'calendar' || c.prefs.layout === 'gantt')) return renderSchedule({ files, layout: c.prefs.layout, contextFiles: c.files, configuration: c.configuration, projectId: c.projectId || c.prefs.project || undefined, toolbarTarget, onSelect: c.select, onPatch: c.patch, canEdit: c.canEdit, ...(c.canWrite && !c.writesBlocked && !c.configurationInvalid && !c.busy && (!personal || personal.actorId) ? { onCreate: (due: string) => c.openCreate(workflow?.initial, undefined, { due }) } : {}) });
    if (!terminal && c.prefs.layout !== 'list') return <PMView {...c.viewProps} files={files} />;
    return <div className={`task-native-table${c.projectId ? ' task-native-table-project' : ''}`}><div className="task-list-columns" aria-hidden="true"><span>{en ? 'Task' : '任务'}</span><span>{en ? 'Status' : '状态'}</span><span>{en ? 'Assignee' : '负责人'}</span><span>{en ? 'Priority' : '优先级'}</span><span>{en ? 'Due' : '截止'}</span>{!c.projectId && <span>{en ? 'Project' : '项目'}</span>}<span /></div><ul className="task-native-list">{files.map(file => <TaskRow key={file.id} file={file} controller={c} en={en} workflow={workflow} dueLabel={file.entity.due ? display.date(file.entity.due) : undefined} />)}</ul></div>;
  }
  if (personal && c.prefs.layout === 'calendar') return <div className="task-collection-content">{render(collection.files)}</div>;
  return <div className={`task-collection-content${timeline ? ' task-timeline-content' : ''}${board ? ' task-collection-board' : ''}`}>
    {grouped.map(group => {
      const heading = group.label
        ? `${taskStateLabel({ id: group.id, label: group.label }, en)}${group.category === 'canceled' ? (en ? ' (not completed)' : '（不计入完成）') : ''}`
        : group.id === 'overdue' ? en ? 'Overdue' : '逾期'
        : group.id === 'today' ? en ? 'Today' : '今天'
        : group.id === 'upcoming' ? en ? 'Upcoming' : '即将到来'
        : group.id === 'completed' ? en ? 'Completed' : '已完成'
        : group.due ? display.date(group.due)
        : en ? 'Open tasks' : '未完成任务';
      return <section className={`task-date-group${board ? ' task-board-panel' : ''}${timeline ? ' task-timeline-panel' : ''}`} key={group.id} aria-label={heading}>
        {!board && !timeline && <div className="task-group-heading"><h2>{heading} <span>{group.files.length}</span></h2>{group.due && <button className="secondary-button" disabled={!c.canWrite || c.configurationInvalid} aria-label={`${en ? 'Add task due' : '新增截止于'} ${group.due}`} onClick={() => c.openCreate(workflow?.initial, undefined, { due: group.due })}><Plus size={14} />{en ? 'Add task' : '新增任务'}</button>}</div>}
        {group.files.length || board || scheduled ? render(group.files) : <p className="task-scope-notice">{en ? 'No tasks in this group.' : '此分组暂无任务。'}</p>}
      </section>;
    })}
    {terminalDrawers && collection.completed.length > 0 && (!board || showCompletedTasks) && <details className="task-terminal-group"><summary>{en ? 'Completed' : '已完成'} · {collection.completed.length}</summary>{render(collection.completed, true)}</details>}
    {terminalDrawers && collection.canceled.length > 0 && <details className="task-terminal-group task-canceled-group"><summary>{en ? 'Canceled (not completed)' : '已取消（不计入完成）'} · {collection.canceled.length}</summary>{render(collection.canceled, true)}</details>}
  </div>;
}
