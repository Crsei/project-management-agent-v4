import { useCallback, useEffect, useId, useState } from 'react';
import { CalendarDays, ChevronDown, ChevronRight, CircleCheck, ClockAlert, Folder, Plus, Sun } from 'lucide-react';
import { statusCategory, workflowFor, type FileRecord } from '@pm-schema';
import { addDays } from '../components/service-collection-shared';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { usePmService } from '../service/pm-service';
import { allowed } from '../service/pm-ui';
import { taskStateLabel } from './task-status-label';
import type { WorkspaceController } from './controller';
import { TaskCompletionControl, TaskDateEditor, TaskDueControl, TaskMoreActions, TaskPriorityControl, TaskStatusControl, useTaskRowActions } from './TaskPersonalFields';
import { CollectionContextMenu } from './CollectionContextMenu';
import styles from './TaskPersonalList.module.css';

interface PersonalListProps {
  controller: WorkspaceController;
  en: boolean;
  actorId: string | null;
  today: string | null;
}

function PersonalTaskRow({ file, controller: c, en, today, onOpenDate }: {
  file: FileRecord;
  controller: WorkspaceController;
  en: boolean;
  today: string | null;
  onOpenDate: (id: string, anchor: HTMLElement) => void;
}) {
  const project = c.projects.find(candidate => candidate.id === file.entity.project);
  const projectLabel = project?.entity.title || (file.entity.project ? en ? 'Project unavailable' : '项目不可用' : en ? 'No project' : '未关联项目');
  const { actions } = useTaskRowActions({ file, controller: c, en });
  return <CollectionContextMenu actions={actions} trigger={<li tabIndex={0} className={`${styles.row}${c.selectedId === file.id ? ` ${styles.selected}` : ''}`} data-completed={statusCategory(file.entity, c.configuration) === 'completed' || undefined} data-testid={`task-${file.id}`}>
    <span className={styles.spacer} aria-hidden="true" />
    <div className={styles.completionCell}><TaskCompletionControl file={file} controller={c} en={en} today={today} /></div>
    <button type="button" className={styles.titleButton} title={`${file.id} · ${file.entity.title}`} onClick={() => c.select(file.id)}>
      <span className={styles.taskId}>{file.id}</span>
      <span className={styles.taskTitle}>{file.entity.title}</span>
      {c.draftIds.has(file.id) && <small className={`draft-pill ${styles.draftBadge}`}>{en ? 'Local draft' : '本地草稿'}</small>}
    </button>
    <div className={styles.metadata}>
      <div className={`${styles.cell} ${styles.project}`} title={projectLabel}><span className="sr-only">{en ? 'Project: ' : '项目：'}</span><Folder size={12} aria-hidden="true" /><span>{projectLabel}</span></div>
      <div className={styles.cell}><TaskStatusControl file={file} controller={c} en={en} today={today} /></div>
      <div className={styles.cell}><TaskPriorityControl file={file} controller={c} en={en} today={today} /></div>
      <div className={styles.cell}><TaskDueControl file={file} controller={c} en={en} today={today} onOpen={onOpenDate} /></div>
    </div>
    <div className={styles.actions}><TaskMoreActions file={file} en={en} actions={actions} /></div>
  </li>} />;
}

/** Ownership, date groups and sort order belong to the authorized collection model. */
export function TaskPersonalList({ controller: c, en, actorId, today }: PersonalListProps) {
  const listId = useId();
  const { workspace } = usePmService();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set(['completed']));
  const [dateSelection, setDateSelection] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  // Resolve against authorized saved sources, not rows that can leave a group.
  const dateFile = dateSelection ? c.files.find(file => file.id === dateSelection.id) : undefined;
  const openDate = useCallback((id: string, anchor: HTMLElement) => setDateSelection({ id, anchor }), []);
  const closeDate = useCallback(() => setDateSelection(null), []);
  useEffect(() => {
    if (dateSelection && !dateFile) setDateSelection(null);
  }, [dateSelection, dateFile]);
  const collection = c.taskCollection;
  if (!collection) return null;
  const workflow = workflowFor('work_item', c.configuration);
  const createDisabled = !actorId || !c.canWrite || c.configurationInvalid || c.writesBlocked || !!c.busy;
  const completedStates = workflow?.states.filter(state => state.category === 'completed') ?? [];
  const canCreateCompleted = c.prefs.project
    ? allowed(workspace, 'workitem.complete', c.prefs.project)
    : c.projects.some(project => allowed(workspace, 'planning.edit', project.id) && allowed(workspace, 'workitem.complete', project.id));
  function toggleGroup(id: string) {
    setCollapsed(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  return <div className={styles.list} aria-label={en ? 'My Tasks' : '我的任务'}>
    <div className={styles.columns} aria-hidden="true">
      <span className={styles.spacer} /><span />
      <span>{en ? 'Task' : '任务'}</span>
      <span className={styles.metadataHeading}>{en ? 'Project' : '项目'}</span>
      <span className={styles.metadataHeading}>{en ? 'Status' : '状态'}</span>
      <span className={styles.metadataHeading}>{en ? 'Priority' : '优先级'}</span>
      <span className={styles.metadataHeading}>{en ? 'Due date' : '截止日期'}</span>
      <span />
    </div>
    {collection.groups.map(group => {
      const heading = group.id === 'overdue' ? en ? 'Overdue' : '逾期'
        : group.id === 'today' ? en ? 'Today' : '今天'
          : group.id === 'completed' ? en ? 'Completed' : '已完成' : en ? 'Upcoming' : '即将到来';
      const completed = group.id === 'completed';
      const due = today && group.id === 'today' ? today : today && group.id === 'upcoming' ? addDays(today, 3) : undefined;
      const addLabel = en ? `Add task to ${heading}` : `新增${heading}任务`;
      const completedReason = !completedStates.length ? en ? 'No completed state is configured.' : '未配置完成状态。'
        : !canCreateCompleted ? en ? 'Permission required: workitem.complete in an accessible project.' : '需要可访问项目的 workitem.complete 权限。' : undefined;
      const addTask = () => c.openCreate(completed ? completedStates[0]?.id : workflow?.initial, undefined, due ? { due } : undefined);
      const addControl = (row = false) => completed && completedStates.length > 1
        ? <DropdownMenu><DropdownMenuTrigger type="button" className={row ? styles.addRow : styles.groupAdd} aria-label={addLabel} title={completedReason || addLabel} disabled={createDisabled || !canCreateCompleted}><Plus size={row ? 14 : 13} aria-hidden="true" />{row && (en ? 'Add task' : '新增任务')}</DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuLabel>{en ? 'Create completed task as…' : '新建已完成任务并设为…'}</DropdownMenuLabel>{completedStates.map(state => <DropdownMenuItem key={state.id} onSelect={() => c.openCreate(state.id)}>{taskStateLabel(state, en)}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
        : <button type="button" className={row ? styles.addRow : styles.groupAdd} aria-label={addLabel} title={(completed && completedReason) || addLabel} disabled={createDisabled || (completed && !!completedReason)} onClick={addTask}><Plus size={row ? 14 : 13} aria-hidden="true" />{row && (en ? 'Add task' : '新增任务')}</button>;
      const isCollapsed = collapsed.has(group.id);
      const headingId = `${listId}-${group.id}-heading`;
      const contentId = `${listId}-${group.id}-tasks`;
      const Icon = group.id === 'overdue' ? ClockAlert : group.id === 'today' ? Sun : completed ? CircleCheck : CalendarDays;
      return <section className={styles.group} key={group.id} aria-labelledby={headingId} data-group={group.id}>
        <div className={styles.groupStrip}>
          <h2 id={headingId} className={styles.groupHeading}>
            <button type="button" className={styles.groupToggle} aria-expanded={!isCollapsed} aria-controls={contentId} onClick={() => toggleGroup(group.id)}>
              {isCollapsed ? <ChevronRight size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
              <Icon size={14} className={group.id === 'overdue' ? styles.overdue : completed ? styles.completed : undefined} aria-hidden="true" />
              <span>{heading}</span>
              <span className={styles.count}>{group.files.length}<span className="sr-only">{en ? ' tasks' : ' 项任务'}</span></span>
            </button>
          </h2>
          {addControl()}
        </div>
        <div id={contentId} hidden={isCollapsed}>
          {group.files.length ? <ul className={styles.rows}>{group.files.map(file => <PersonalTaskRow key={file.id} file={file} controller={c} en={en} today={today} onOpenDate={openDate} />)}</ul> : <p className={styles.emptyGroup}>{en ? 'No tasks in this group.' : '此分组暂无任务。'}</p>}
          {addControl(true)}
        </div>
      </section>;
    })}
    {dateSelection && dateFile && <TaskDateEditor key={dateSelection.id} file={dateFile} controller={c} en={en} anchor={dateSelection.anchor} onClose={closeDate} />}
  </div>;
}
