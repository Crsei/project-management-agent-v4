import { type ReactNode } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { Bookmark, CalendarDays, Flag, Plus, UserRound } from 'lucide-react';
import { workflowFor, type FileRecord, type WorkflowDefinition } from '@pm-schema';
import { PMView, StatusIcon, type ContextMenuRenderer } from '@pm-views';
import { usePmService } from '../service/pm-service';
import { useWorkspaceStore } from '@/providers/app-providers';
import { useDisplayDateTime } from '@/features/workspace/preference-format';
import { CollectionContextMenu, renderCollectionContextMenu } from './CollectionContextMenu';
import { TaskMoreActions, TaskTableContextMenu, useTaskRowActions } from './TaskPersonalFields';
import { TaskPersonalList } from './TaskPersonalList';
import { taskStateLabel } from './task-status-label';
import { filterTaskCollectionAttention, taskBoardFiles, type TaskScope } from './task-collection-model';
import { useChangeAttention } from './change-history';
import type { QueryExpression } from '@pm-schema/query';
import type { WorkspaceController } from './controller';
import type { ScheduleViewProps } from './workspace';
import './task-list-scope.css';

const priorityLabels: Record<string, string> = { urgent: '紧急', high: '高', medium: '中', low: '低' };

function TaskRow({ file, controller: c, en, workflow, dueLabel, attention }: { file: FileRecord; controller: WorkspaceController; en: boolean; workflow: WorkflowDefinition | undefined; dueLabel?: string; attention: ReactNode }) {
  const { actor } = usePmService();
  const { actions, watchAction, watched } = useTaskRowActions({ file, controller: c, en });
  const status = workflow?.states.find(state => state.id === file.entity.status);
  const statusLabel = status ? taskStateLabel(status, en) : file.entity.status;
  const project = c.projects.find(project => project.id === file.entity.project)?.entity.title || file.entity.project || (en ? 'Unassigned' : '未关联');
  const assigneeLabel = !file.entity.assignee ? en ? 'Unassigned' : '未分配' : file.entity.assignee === actor?.id ? actor.name : en ? 'Assigned' : '已分配';
  return <CollectionContextMenu actions={actions} trigger={<li tabIndex={0} className={`task-native-row${c.selectedId === file.id ? ' selected' : ''}`} data-testid={`task-${file.id}`}>
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
      {attention}
      <button type="button" className="icon-button task-watch" aria-pressed={watched} aria-label={`${watchAction.label} ${file.entity.title}`} disabled={watchAction.disabled} title={watchAction.reason} onClick={watchAction.onSelect}><Bookmark size={15} fill={watched ? 'currentColor' : 'none'} /></button>
      <TaskMoreActions file={file} en={en} actions={actions} className="icon-button task-row-edit-trigger" />
    </div>
    <div className="task-mobile-metadata"><span>{statusLabel}</span>{file.entity.priority && <span className={`priority-${file.entity.priority}`}><Flag size={11} aria-hidden="true" />{en ? file.entity.priority : priorityLabels[file.entity.priority] || file.entity.priority}</span>}{file.entity.due && <time dateTime={file.entity.due}><CalendarDays size={11} aria-hidden="true" />{dueLabel}</time>}{!c.projectId && <span className="task-project-association" title={project}>{project}</span>}</div>
  </li>} />;
}

/** Every scope projects the same authorized files; layout never owns the task set. */
export function TaskCollectionView({ controller: c, en, renderSchedule, toolbarTarget, personal, scope, graphScopeTarget, graphToggleTarget }: { controller: WorkspaceController; en: boolean; renderSchedule: (props: ScheduleViewProps) => ReactNode; toolbarTarget?: HTMLElement | null; personal?: { today: string | null; actorId: string | null }; scope?: TaskScope; graphScopeTarget?: HTMLElement | null; graphToggleTarget?: HTMLElement | null }) {
  const showCompletedTasks = useWorkspaceStore(state => state.showCompletedTasks);
  const display = useDisplayDateTime();
  const { workspace } = usePmService();
  const navigate = useNavigate();
  const location = useLocation();
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();
  const taskIds = c.taskCollection?.files.map(file => file.id) ?? [];
  const attention = useChangeAttention(workspace?.id, taskIds);
  const summaries = new Map(attention.data?.items.map(item => [item.taskId, item]) ?? []);
  const incomplete = !!attention.data && taskIds.some(id => !summaries.has(id));
  const pendingIds = new Set(attention.data?.items.filter(item => item.pendingCount > 0).map(item => item.taskId) ?? []);
  const originalCollection = c.taskCollection;
  const collection = originalCollection && c.pendingChangesOnly ? filterTaskCollectionAttention(originalCollection, pendingIds) : originalCollection;
  function renderAttention(file: FileRecord) {
    const item = attention.error || incomplete ? undefined : summaries.get(file.id);
    if (!item?.pendingCount) return null;
    const label = en
      ? `${item.pendingCount} pending changes for ${file.id}: ${item.ownPendingCount} task, ${item.relatedPendingCount} related`
      : `${file.id} 有 ${item.pendingCount} 项待审阅变更：任务 ${item.ownPendingCount}，关联文档 ${item.relatedPendingCount}`;
    return <button type="button" className="task-attention-badge" aria-label={label} title={label} onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onClick={event => {
      event.stopPropagation();
      if (!workspace) return;
      const returnTo = `${location.pathname}${location.search}${location.hash}`;
      const root = `/pm/${encodeURIComponent(workspaceSlug || workspace.id)}${file.entity.project ? `/projects/${encodeURIComponent(file.entity.project)}` : ''}`;
      navigate(`${root}/entities/${encodeURIComponent(file.id)}?${new URLSearchParams({ returnTo, panel: 'changes' })}`, { state: { returnTo } });
    }}>{en ? 'Review' : '待审阅'} · {item.pendingCount}</button>;
  }
  const attentionNotice = attention.error || incomplete
    ? <p className="task-scope-notice" role="alert">{en ? 'Pending changes could not be loaded.' : '无法读取待审阅变更。'} <button type="button" onClick={() => { void attention.refetch(); }}>{en ? 'Retry' : '重试'}</button></p>
    : attention.isPending && taskIds.length > 0 ? <p className="task-scope-notice" role="status">{en ? 'Loading pending changes…' : '正在读取待审阅变更…'}</p> : null;
  if (c.pendingChangesOnly && (attention.error || incomplete || (attention.isPending && taskIds.length > 0))) return attentionNotice;
  const graphIds = collection?.files.map(file => file.id) ?? [];
  const chunks: QueryExpression[] = [];
  for (let index = 0; index < graphIds.length; index += 256) chunks.push({ field: 'id', op: 'in', value: graphIds.slice(index, index + 256) });
  const graphWhere: QueryExpression = chunks.length ? { any: chunks } : { field: 'id', op: 'in', value: ['__no_pending_tasks__'] };
  const graphView = c.graphQuery.view ?? c.config;
  const graphQuery = c.pendingChangesOnly ? { ...c.graphQuery, view: { ...graphView, where: graphView.where ? { all: [graphView.where, graphWhere] } : graphWhere } } : c.graphQuery;
  const adornment = (file: FileRecord) => renderAttention(file);
  const notice = attentionNotice;
  if (!collection) return null;
  if (c.scopePending) return <p className="task-scope-notice" role="status">{en ? 'Reading your personal task context…' : '正在读取个人任务上下文…'}</p>;
  if (c.scopeError) return null;
  if (!collection.files.length) {
    const important = scope === 'important' && !c.pendingChangesOnly;
    return <div className="task-collection-content">{notice}<div className="task-empty-state" role="status"><Bookmark size={22} aria-hidden="true" /><strong>{c.pendingChangesOnly ? (en ? 'No pending changes' : '没有待审阅变更') : important ? (en ? 'Nothing watched yet' : '暂无关注的任务') : (en ? 'No tasks in this scope' : '此范围暂无任务')}</strong><p>{important ? (en ? 'Use the watch action on any task to keep it here. Watching is private and does not change the task.' : '在任意任务中点击关注，即可把任务加入这里。关注仅本人可见，不会改变任务状态。') : (en ? 'Adjust the filters or create a task in an authorized project.' : '调整筛选条件，或在有权限的项目中新建任务。')}</p></div></div>;
  }
  if (personal && c.prefs.layout === 'list') return <>{notice}<TaskPersonalList controller={c} en={en} today={personal.today} actorId={personal.actorId} collection={collection} pendingOnly={c.pendingChangesOnly} renderAttention={adornment} /></>;
  const workflow = workflowFor('work_item', c.configuration);
  const renderContextMenu: ContextMenuRenderer = (trigger, actions, file) => file?.entity.entity === 'work_item'
    ? <TaskTableContextMenu key={file.id} file={file} controller={c} en={en} trigger={trigger} />
    : renderCollectionContextMenu(trigger, actions);
  const board = c.prefs.layout === 'kanban';
  const timeline = c.prefs.layout === 'gantt';
  const scheduled = c.prefs.layout === 'calendar' || c.prefs.layout === 'gantt';
  // Lists group all/important tasks by workflow state; boards keep every task in its column; gantt keeps one open lane plus terminal drawers; the calendar shows open tasks only.
  const boardFiles = taskBoardFiles(collection, showCompletedTasks, c.pendingChangesOnly);
  const grouped = board ? [{ id: 'open', files: boardFiles, due: undefined }] : scheduled ? [{ id: 'open', files: c.pendingChangesOnly ? collection.files : collection.open, due: undefined }] : collection.groups;
  const terminalDrawers = timeline;
  function render(files: FileRecord[], terminal = false) {
    if (!terminal && (c.prefs.layout === 'calendar' || c.prefs.layout === 'gantt')) return renderSchedule({ files, layout: c.prefs.layout, contextFiles: c.files, configuration: c.configuration, projectId: c.projectId || c.prefs.project || undefined, toolbarTarget, onSelect: c.select, onPatch: c.patch, canEdit: c.canEdit, ...(c.canWrite && !c.writesBlocked && !c.configurationInvalid && !c.busy && (!personal || personal.actorId) ? { onCreate: (due: string) => c.openCreate(workflow?.initial, undefined, { due }) } : {}) });
    if (!terminal && c.prefs.layout !== 'list') return <PMView {...c.viewProps} files={files} renderContextMenu={renderContextMenu} renderItemAdornment={adornment} />;
    return <div className={`task-native-table${c.projectId ? ' task-native-table-project' : ''}`}><div className="task-list-columns" aria-hidden="true"><span>{en ? 'Task' : '任务'}</span><span>{en ? 'Status' : '状态'}</span><span>{en ? 'Assignee' : '负责人'}</span><span>{en ? 'Priority' : '优先级'}</span><span>{en ? 'Due' : '截止'}</span>{!c.projectId && <span>{en ? 'Project' : '项目'}</span>}<span /></div><ul className="task-native-list">{files.map(file => <TaskRow key={file.id} file={file} controller={c} en={en} workflow={workflow} dueLabel={file.entity.due ? display.date(file.entity.due) : undefined} attention={adornment(file)} />)}</ul></div>;
  }
  if (personal && c.prefs.layout === 'calendar') return <div className="task-collection-content">{notice}{render(collection.files)}</div>;
  // The graph owns its own entity navigation and node inspector.
  if (c.prefs.layout === 'graph') return <div className="task-collection-content task-collection-graph">{notice}<PMView {...c.viewProps} graphQuery={graphQuery} files={collection.files} graphScopeTarget={graphScopeTarget} graphToggleTarget={graphToggleTarget} /></div>;
  return <div className={`task-collection-content${timeline ? ' task-timeline-content' : ''}${board ? ' task-collection-board' : ''}`}>{notice}
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
    {terminalDrawers && !c.pendingChangesOnly && collection.completed.length > 0 && (!board || showCompletedTasks) && <details className="task-terminal-group"><summary>{en ? 'Completed' : '已完成'} · {collection.completed.length}</summary>{render(collection.completed, true)}</details>}
    {terminalDrawers && !c.pendingChangesOnly && collection.canceled.length > 0 && <details className="task-terminal-group task-canceled-group"><summary>{en ? 'Canceled (not completed)' : '已取消（不计入完成）'} · {collection.canceled.length}</summary>{render(collection.canceled, true)}</details>}
  </div>;
}
