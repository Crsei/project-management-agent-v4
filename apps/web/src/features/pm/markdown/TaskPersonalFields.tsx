import { useMemo, useRef, useState } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { CalendarDays, Check, Flag, MoreHorizontal, X } from 'lucide-react';
import { fieldRegistry, workflowFor, type FileRecord } from '@pm-schema';
import { priorities, StatusIcon, type ContextMenuAction } from '@pm-views';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useDisplayDateTime } from '@/features/workspace/preference-format';
import { dateOnly, ScheduleEditor, type ScheduleItem } from '../components/service-collection-shared';
import { usePersonalDashboard, usePmService, type PmService } from '../service/pm-service';
import { allowed, useAction } from '../service/pm-ui';
import { taskStateLabel } from './task-status-label';
import type { WorkspaceController } from './controller';
import { CollectionActionMenu, CollectionContextMenu } from './CollectionContextMenu';
import styles from './TaskPersonalFields.module.css';

type TaskFieldProps = { file: FileRecord; controller: WorkspaceController; en: boolean; today?: string | null };
type ServiceWorkspace = PmService['workspace'];
type NativeScheduleItem = ScheduleItem & { source: FileRecord };

const priorityLabels: Record<string, readonly [string, string]> = {
  urgent: ['Urgent', '紧急'], high: ['High', '高'], medium: ['Medium', '中'], low: ['Low', '低'],
};
const supportsDue = fieldRegistry.some(field => field.name === 'due' && field.source === 'yaml' && field.type === 'date' && field.editable && field.entities.includes('work_item'));
const sourceChanged = (en: boolean) => en
  ? 'The source changed; your date draft has not been written. Use the current version while retaining your draft before saving again.'
  : '源文件已变化；日期草稿尚未写入。请先采用当前版本并保留草稿，再次显式保存。';

function writeProblem(file: FileRecord, c: WorkspaceController, en: boolean, changes?: Record<string, unknown>): string | null {
  if (c.accessError || c.query.error) return en ? 'Refresh the authorized source before editing.' : '请先重新读取有权访问的源文件。';
  if (!c.files.some(current => current.id === file.id) || file.entity.entity !== 'work_item') return en ? 'This task source is unavailable.' : '此任务的源文件不可用。';
  if (!changes?.status && !c.canWrite) return en ? 'Read-only: task editing is not permitted.' : '只读：当前权限不允许编辑任务。';
  if (file.entity.archived) return en ? 'Archived tasks cannot be edited.' : '已归档任务不可编辑。';
  if (file.stale || file.error || file.diagnostics?.some(issue => issue.severity === 'error') || c.configurationInvalid) return en ? 'Repair the source or workflow diagnostics before editing.' : '请先修复源文件或工作流诊断。';
  if (c.draftIds.has(file.id) || c.session.drafts.getSnapshot()[file.id]) return en ? 'Save or discard this task’s native draft before editing saved fields.' : '请先保存或放弃此任务的原生草稿，再编辑已保存属性。';
  if (c.conflict?.id === file.id) return en ? 'Resolve this task’s native revision conflict before editing.' : '请先解决此任务的原生版本冲突。';
  if (c.writesBlocked || c.busy) return en ? 'Another write is pending or unconfirmed. Reconcile its original result first.' : '其他写入正在处理或结果待核对，请先核对原请求。';
  if (!c.canEdit(file.id, changes)) return en ? 'Editing is locked by the current permissions or native write state.' : '当前权限或原生写入状态已锁定编辑。';
  return null;
}

/** Mirror core-routes field-level authorization; the API remains authoritative. */
function transitionProblem(file: FileRecord, c: WorkspaceController, workspace: ServiceWorkspace, target: string, en: boolean): string | null {
  const workflow = workflowFor('work_item', c.configuration);
  const before = workflow?.states.find(state => state.id === file.entity.status);
  const after = workflow?.states.find(state => state.id === target);
  if (!before || !after) return en ? 'The saved state is not in the configured workflow.' : '已保存状态不在配置的工作流中。';
  if (before.id === after.id) return en ? 'Current saved state.' : '当前已保存状态。';
  if (!workflow?.transitions.some(transition => transition.from === before.id && transition.to === after.id)) return en ? 'This transition is not allowed by the configured workflow.' : '配置的工作流不允许此转换。';
  const capability = after.category === 'completed' ? 'workitem.complete'
    : after.category === 'canceled' || before.category === 'completed' || before.category === 'canceled' ? 'workitem.cancel_reopen' : 'planning.edit';
  if (!allowed(workspace, capability, file.entity.project)) return en ? `Permission required: ${capability}.` : `需要权限：${capability}。`;
  return null;
}

/** No optimistic state or inferred outcome: the native controller owns every patch. */
function useTaskPatch(file: FileRecord, c: WorkspaceController, en: boolean, onError?: (message: string) => void) {
  const { workspace } = usePmService();
  const [pending, setPending] = useState(false);
  const sending = useRef(false);
  const latest = useRef({ file, c, en, workspace, onError });
  latest.current = { file, c, en, workspace, onError };
  async function run(changes: Record<string, unknown>, source = latest.current.file) {
    if (sending.current) return;
    const current = latest.current;
    const saved = current.c.files.find(candidate => candidate.id === source.id);
    const report = (message: string) => { current.c.setError(message); current.onError?.(message); };
    if (!saved) { report(current.en ? 'This task is no longer available in the authorized source.' : '此任务已不在有权访问的源文件中。'); return; }
    const problem = writeProblem(saved, current.c, current.en, changes);
    if (problem) { report(problem); return; }
    if (saved.revision !== source.revision || saved.raw !== source.raw) {
      report(current.onError ? sourceChanged(current.en) : current.en ? 'The source changed; nothing was written. Reopen this field before retrying.' : '源文件已变化；尚未写入。请重新打开此属性后重试。');
      return;
    }
    if (typeof changes.status === 'string') {
      const problem = transitionProblem(saved, current.c, current.workspace, changes.status, current.en);
      if (problem) { report(problem); return; }
    }
    sending.current = true;
    setPending(true);
    try {
      await current.c.patch(saved.id, changes);
    } catch (cause) {
      // Preserve errors even if a confirmed source update removes the original row.
      report(cause instanceof Error ? cause.message : String(cause));
    } finally {
      sending.current = false;
      setPending(false);
    }
  }
  return { pending, run, workspace };
}

export function TaskCompletionControl({ file, controller: c, en }: TaskFieldProps) {
  const patch = useTaskPatch(file, c, en);
  const workflow = workflowFor('work_item', c.configuration);
  const state = workflow?.states.find(candidate => candidate.id === file.entity.status);
  const completed = state?.category === 'completed';
  const candidates = workflow?.states.filter(candidate =>
    (completed ? candidate.category !== 'completed' && candidate.category !== 'canceled' : candidate.category === 'completed')
    && !transitionProblem(file, c, patch.workspace, candidate.id, en)) ?? [];
  const capability = completed ? 'workitem.cancel_reopen' : 'workitem.complete';
  const reason = (!state ? en ? 'The saved state is not in the configured workflow.' : '已保存状态不在配置的工作流中。' : null)
    || (!allowed(patch.workspace, capability, file.entity.project) ? en ? `Permission required: ${capability}.` : `需要权限：${capability}。` : null)
    || (!candidates.length ? completed
      ? en ? 'No allowed reopen transition is configured. Inspect Status for this workflow.' : '未配置允许的重新打开转换，请在状态字段中查看工作流。'
      : en ? 'No allowed completed-state transition is configured. Inspect Status for this workflow.' : '未配置允许的完成状态转换，请在状态字段中查看工作流。'
      : writeProblem(file, c, en, { status: candidates[0]!.id }));
  const label = completed ? en ? `Reopen ${file.entity.title}` : `重新打开「${file.entity.title}」` : en ? `Mark ${file.entity.title} complete` : `完成「${file.entity.title}」`;
  const className = `${styles.completion}${completed ? ` ${styles.completed}` : ''}`;
  if (candidates.length > 1) return <Popover>
    <PopoverTrigger type="button" className={className} disabled={!!reason || patch.pending} aria-label={label} title={reason || label} aria-busy={patch.pending}>{completed && <Check size={10} aria-hidden="true" />}</PopoverTrigger>
    <PopoverContent className={styles.menu} align="start" aria-label={completed ? en ? 'Choose reopened state' : '选择重新打开状态' : en ? 'Choose completed state' : '选择完成状态'}>
      <h3 className={styles.menuTitle}>{completed ? en ? 'Reopen task as…' : '重新打开并设为…' : en ? 'Complete task as…' : '完成并设为…'}</h3>
      <p className={styles.hint}>{en ? 'This workflow has more than one allowed target. Choose explicitly.' : '此工作流有多个允许的目标状态，请显式选择。'}</p>
      {candidates.map(candidate => <button key={candidate.id} type="button" className={styles.choice} disabled={patch.pending || !!writeProblem(file, c, en, { status: candidate.id })} onClick={() => { void patch.run({ status: candidate.id }, file); }}><StatusIcon category={candidate.category} /><span>{taskStateLabel(candidate, en)}</span></button>)}
      {c.error && <p className={styles.error} role="alert">{c.error}</p>}
    </PopoverContent>
  </Popover>;
  const targetLabel = candidates[0] ? taskStateLabel(candidates[0], en) : '';
  return <button type="button" className={className} disabled={!!reason || patch.pending} aria-label={label} aria-busy={patch.pending} title={reason || (completed ? en ? `Reopen as ${targetLabel}` : `重新打开并设为「${targetLabel}」` : en ? `Complete as ${targetLabel}` : `完成并设为「${targetLabel}」`)} onClick={() => { if (candidates[0]) void patch.run({ status: candidates[0].id }, file); }}>{completed && <Check size={10} aria-hidden="true" />}</button>;
}

export function TaskStatusControl({ file, controller: c, en }: TaskFieldProps) {
  const patch = useTaskPatch(file, c, en);
  const workflow = workflowFor('work_item', c.configuration);
  const state = workflow?.states.find(candidate => candidate.id === file.entity.status);
  const label = state ? taskStateLabel(state, en) : file.entity.status || (en ? 'Unknown state' : '未知状态');
  const available = workflow?.states.find(candidate => !transitionProblem(file, c, patch.workspace, candidate.id, en) && !writeProblem(file, c, en, { status: candidate.id }));
  const reason = !state ? en ? 'The saved state is not in the configured workflow.' : '已保存状态不在配置的工作流中。'
    : !available ? en ? 'No permitted transition is currently available.' : '当前没有允许的状态转换。' : null;
  return <Popover>
    <PopoverTrigger type="button" className={styles.field} data-category={state?.category} disabled={!!reason || patch.pending} aria-label={`${en ? 'Status for' : '状态'} ${file.id}: ${label}`} title={reason || label} aria-busy={patch.pending}><StatusIcon category={state?.category} /><span>{label}</span></PopoverTrigger>
    <PopoverContent className={styles.menu} align="start" aria-label={`${en ? 'Status for' : '状态'} ${file.id}`}>
      <h3 className={styles.menuTitle}>{en ? 'Status' : '状态'}</h3>
      {workflow?.states.map(candidate => {
        const problem = writeProblem(file, c, en, { status: candidate.id }) || transitionProblem(file, c, patch.workspace, candidate.id, en);
        return <button key={candidate.id} type="button" className={styles.choice} data-category={candidate.category} disabled={!!problem || patch.pending} title={problem || undefined} aria-pressed={candidate.id === state?.id} onClick={() => { void patch.run({ status: candidate.id }, file); }}><StatusIcon category={candidate.category} /><span>{taskStateLabel(candidate, en)}</span>{candidate.id === state?.id && <Check size={13} aria-hidden="true" />}</button>;
      })}
      <p className={styles.hint}>{en ? 'Only configured transitions permitted by your current capabilities are available.' : '仅可执行工作流配置且当前权限允许的转换。'}</p>
      {c.error && <p className={styles.error} role="alert">{c.error}</p>}
    </PopoverContent>
  </Popover>;
}

export function TaskPriorityControl({ file, controller: c, en }: TaskFieldProps) {
  const patch = useTaskPatch(file, c, en);
  const reason = writeProblem(file, c, en);
  const label = file.entity.priority ? priorityLabels[file.entity.priority]?.[en ? 0 : 1] || file.entity.priority : en ? 'No priority' : '未设优先级';
  return <Popover>
    <PopoverTrigger type="button" className={styles.field} data-priority={file.entity.priority} disabled={!!reason || patch.pending} aria-label={`${en ? 'Priority for' : '优先级'} ${file.id}: ${label}`} title={reason || label} aria-busy={patch.pending}><Flag size={12} aria-hidden="true" /><span>{label}</span></PopoverTrigger>
    <PopoverContent className={styles.menu} align="start" aria-label={`${en ? 'Priority for' : '优先级'} ${file.id}`}>
      <h3 className={styles.menuTitle}>{en ? 'Priority' : '优先级'}</h3>
      {priorities.map(priority => <button key={priority} type="button" className={styles.choice} data-priority={priority} disabled={!!reason || patch.pending || priority === file.entity.priority} aria-pressed={priority === file.entity.priority} onClick={() => { void patch.run({ priority }, file); }}><Flag size={13} aria-hidden="true" /><span>{priorityLabels[priority]?.[en ? 0 : 1] || priority}</span>{priority === file.entity.priority && <Check size={13} aria-hidden="true" />}</button>)}
      {c.error && <p className={styles.error} role="alert">{c.error}</p>}
    </PopoverContent>
  </Popover>;
}

/** Selection belongs to the list, so a row changing groups cannot close the editor. */
export function TaskDueControl({ file, controller: c, en, today, onOpen }: TaskFieldProps & { onOpen: (id: string, anchor: HTMLElement) => void }) {
  const display = useDisplayDateTime('UTC');
  const due = dateOnly(file.entity.due);
  const personalToday = dateOnly(today);
  const completed = workflowFor('work_item', c.configuration)?.states.find(state => state.id === file.entity.status)?.category === 'completed';
  const label = due ? due === personalToday ? en ? 'Today' : '今天' : display.date(due) : file.entity.due || (en ? 'Set date' : '设置日期');
  const reason = writeProblem(file, c, en);
  return <button type="button" className={styles.field} data-overdue={!completed && due && personalToday && due < personalToday ? true : undefined} aria-haspopup="dialog" aria-label={`${en ? 'Dates for' : '日期'} ${file.id}: ${label}`} title={reason || due || label} onClick={event => onOpen(file.id, event.currentTarget)}><CalendarDays size={13} aria-hidden="true" />{due ? <time dateTime={due}>{label}</time> : <span>{label}</span>}</button>;
}

export function TaskDateEditor({ file, controller: c, en, anchor, onClose }: { file: FileRecord; controller: WorkspaceController; en: boolean; anchor: HTMLElement; onClose: () => void }) {
  const [localError, setLocalError] = useState<string | null>(null);
  const patch = useTaskPatch(file, c, en, setLocalError);
  const panel = useRef<HTMLDivElement>(null);
  const sourceVersion = useRef({ id: file.id, revision: file.revision, raw: file.raw, value: 0 });
  // ScheduleEditor owns the entered draft and its explicit current-version adoption.
  // Its version must also change for a raw-only source replacement, not just revision.
  if (sourceVersion.current.id !== file.id || sourceVersion.current.revision !== file.revision || sourceVersion.current.raw !== file.raw) {
    sourceVersion.current = { id: file.id, revision: file.revision, raw: file.raw, value: sourceVersion.current.value + 1 };
  }
  const virtualAnchor = useMemo(() => {
    let bounds = anchor.getBoundingClientRect();
    return { current: { contextElement: anchor, getBoundingClientRect: () => {
      if (anchor.isConnected) bounds = anchor.getBoundingClientRect();
      return bounds;
    } } };
  }, [anchor]);
  const reason = writeProblem(file, c, en);
  const item: NativeScheduleItem = {
    id: file.id, version: sourceVersion.current.value, source: file,
    scheduleReadOnly: !!reason,
    scheduleFields: { start: true, due: supportsDue },
    data: { title: file.entity.title, startDate: file.entity['x-pm-start'], dueDate: file.entity.due, archivedAt: file.entity.archived ? true : null },
  };
  async function schedule(base: NativeScheduleItem, start: string | null, due: string | null) {
    setLocalError(null);
    if ((start !== null && !dateOnly(start)) || (due !== null && !dateOnly(due)) || (start && due && start > due)) {
      const message = en ? 'Enter valid all-day dates; the due date cannot precede the start date.' : '请输入有效的全天日期；截止日期不能早于开始日期。';
      setLocalError(message); c.setError(message); return;
    }
    if (!supportsDue && due !== null) {
      const message = en ? 'This task does not support the requested due-date field.' : '此任务不支持所请求的截止日期字段。';
      setLocalError(message); c.setError(message); return;
    }
    const changes: Record<string, unknown> = {};
    if (start !== (base.source.entity['x-pm-start'] ?? null)) changes['x-pm-start'] = start;
    if (supportsDue && due !== (base.source.entity.due ?? null)) changes.due = due;
    if (Object.keys(changes).length) await patch.run(changes, base.source);
  }
  if (!c.files.some(current => current.id === file.id)) return null;
  return <Popover open onOpenChange={open => { if (!open) onClose(); }}>
    <PopoverPrimitive.Anchor virtualRef={virtualAnchor} />
    <PopoverContent className={styles.datePanel} align="end" collisionPadding={12} aria-label={`${en ? 'Edit dates for' : '编辑日期'} ${file.id}`} onOpenAutoFocus={event => {
      event.preventDefault();
      requestAnimationFrame(() => {
        const target = panel.current?.querySelector<HTMLElement>('input:not(:disabled)') ?? panel.current?.querySelector<HTMLElement>('button:not(:disabled)');
        if (target?.isConnected) target.focus({ preventScroll: true });
      });
    }} onCloseAutoFocus={event => {
      event.preventDefault();
      if (anchor.isConnected && anchor.getClientRects().length && !anchor.closest('[inert], [aria-hidden="true"]')) anchor.focus({ preventScroll: true });
    }}>
      <div ref={panel} className={styles.dateBody}>
        <header className={styles.dateHeading}><h3>{file.id} · {en ? 'Dates' : '日期'}</h3><PopoverClose type="button" className={styles.icon} aria-label={en ? 'Close date editor' : '关闭日期编辑器'}><X size={14} aria-hidden="true" /></PopoverClose></header>
        {reason && <p className={styles.hint} role="status">{reason}</p>}
        <ScheduleEditor item={item} onSchedule={(base, start, due) => { void schedule(base, start, due); }} pending={patch.pending || !!c.busy || c.writesBlocked} />
        {(c.error || localError) && <p className={styles.error} role="alert">{c.error || localError}</p>}
        {c.requestDiagnostics.filter(issue => !issue.entityId || issue.entityId === file.id).map((issue, index) => <p key={`${issue.code}:${index}`} className={issue.severity === 'error' ? styles.error : styles.hint}>{issue.message}</p>)}
      </div>
    </PopoverContent>
  </Popover>;
}

/** Row menus write saved collection fields; they never edit the detail draft. */
export function useTaskRowActions({ file, controller: c, en }: TaskFieldProps) {
  const personal = usePersonalDashboard();
  const { workspace, capabilities } = usePmService();
  const action = useAction();
  const patch = useTaskPatch(file, c, en);
  const sending = useRef(false);
  const watch = personal.data?.watches.find(record => record.data.taskId === file.id);
  const watchReason = (c.writesBlocked || action.locked ? en ? 'Reconcile the pending or unknown original command first.' : '请先核对待处理或结果未知的原命令。' : null)
    || (capabilities?.business.enabled !== true ? en ? 'Personal watch commands are unavailable.' : '个人关注命令当前不可用。' : null)
    || (!personal.data || personal.error ? en ? 'Personal watches are unavailable. Refresh your personal dashboard before changing them.' : '个人关注数据不可用，请先重新读取个人面板。' : null)
    || (!file.entity.project || !allowed(workspace, 'domain.read', file.entity.project) ? en ? 'An accessible source project is required to change watches.' : '修改关注需要可访问的所属项目。' : null);
  const liveWatch = useRef({ action, c, watchReason, watch });
  liveWatch.current = { action, c, watchReason, watch };
  const toggleWatch = () => {
    const current = liveWatch.current;
    if (sending.current || current.watchReason) return;
    if (current.watch?.id !== watch?.id || current.watch?.version !== watch?.version) {
      current.c.setError(en ? 'Your watch state changed. Reopen this task menu before trying again.' : '个人关注状态已改变，请重新打开此任务菜单后再操作。');
      return;
    }
    sending.current = true;
    void current.action.run(async () => {
      try {
        await current.action.execute(watch
          ? { commandId: crypto.randomUUID(), commandType: 'UnwatchTask', targetId: watch.id, projectId: file.entity.project!, expectedVersions: { [watch.id]: watch.version }, payload: {} }
          : { commandId: crypto.randomUUID(), commandType: 'WatchTask', projectId: file.entity.project!, payload: { taskId: file.id } });
      } catch (cause) {
        current.c.setError(cause instanceof Error ? cause.message : String(cause));
        throw cause;
      } finally { sending.current = false; }
    });
  };
  const watchAction: ContextMenuAction = { id: 'watch', label: watch ? en ? 'Unwatch task' : '取消关注' : en ? 'Watch task' : '关注任务', disabled: !!watchReason, reason: watchReason || undefined, onSelect: toggleWatch };
  const workflow = workflowFor('work_item', c.configuration);
  const actions: ContextMenuAction[] = [
    { id: 'inspect', label: en ? 'Open task details / attributes' : '打开任务详情与属性', onSelect: () => c.select(file.id) },
    ...(c.viewProps.onOpenPage ? [{ id: 'open', label: en ? 'Open full page' : '打开完整页面', onSelect: () => c.viewProps.onOpenPage?.(file.id) }] : []),
    watchAction,
    ...(workflow?.states.map((state, index) => {
      const reason = transitionProblem(file, c, workspace, state.id, en) || writeProblem(file, c, en, { status: state.id });
      return { id: `status:${state.id}`, label: `${en ? 'Status' : '状态'} · ${taskStateLabel(state, en)}`, separatorBefore: index === 0, disabled: patch.pending || !!reason, reason: reason || undefined, onSelect: () => { void patch.run({ status: state.id }, file); } };
    }) ?? []),
    ...priorities.map((priority, index) => {
      const reason = writeProblem(file, c, en) || (priority === file.entity.priority ? en ? 'Current saved priority.' : '当前已保存优先级。' : null);
      return { id: `priority:${priority}`, label: `${en ? 'Priority' : '优先级'} · ${priorityLabels[priority]?.[en ? 0 : 1] || priority}`, separatorBefore: index === 0, disabled: patch.pending || !!reason, reason: reason || undefined, onSelect: () => { void patch.run({ priority }, file); } };
    }),
  ];
  return { actions, watchAction, watched: !!watch };
}

export function TaskMoreActions({ file, en, actions, className }: { file: FileRecord; en: boolean; actions: ContextMenuAction[]; className?: string }) {
  return <CollectionActionMenu actions={actions} trigger={<button type="button" className={className ?? styles.icon} aria-label={`${en ? 'More actions for' : '更多操作'} ${file.id}`} title={en ? 'More task actions' : '更多任务操作'}><MoreHorizontal size={16} aria-hidden="true" /></button>} />;
}

export function TaskTableContextMenu({ file, controller, en, trigger }: TaskFieldProps & { trigger: React.ReactElement }) {
  const { actions } = useTaskRowActions({ file, controller, en });
  return <CollectionContextMenu trigger={trigger} actions={actions} />;
}
