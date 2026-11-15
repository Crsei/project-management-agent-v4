import { useEffect, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Circle, CircleCheck, CircleX } from 'lucide-react';
import { statusCategory, workflowFor } from '@pm-schema';
import type { WorkspaceController } from './controller';
import { usePmService } from '../service/pm-service';
import { Preview } from './Preview';
import { MarkdownBodyEditor } from './MarkdownBodyEditor';
import { splitTaskBody } from './document-body';
import { TaskTitleField } from './TaskDocumentFields';
import { TaskChildren, TaskDiscussionSection, TaskResourcesSection, useTaskArtifacts } from './TaskDetailRelated';
import { useTaskComments } from '../service/use-task-comments';
import { TaskContextSidebar } from './TaskContextSidebar';
import { TaskBriefPanel } from './TaskBriefPanel';
import { TaskBriefSummary } from './TaskBriefSummary';
import { TaskCodeDeliveryPanel } from './TaskCodeDeliveryPanel';
import { taskStateLabel } from './task-status-label';
import { useOptionalPmAgentPanel } from '../agent/agent-panel-context';
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { RadixSelect } from '@/components/ui/radix-select';
import './task-detail.css';

export function TaskCompletionAction({ controller: c, en }: { controller: WorkspaceController; en: boolean }) {
  const entity = c.entity;
  if (!entity || !c.selected) return null;
  const workflow = workflowFor('work_item', c.configuration);
  const category = statusCategory(entity, c.configuration);
  const savedStatus = c.selected.entity.status;
  const staged = entity.status !== savedStatus;
  const reopening = category === 'completed' || category === 'canceled';
  const candidates = workflow?.states.filter(state =>
    (reopening ? !['completed', 'canceled'].includes(state.category) : state.category === 'completed') &&
    (state.id === savedStatus || workflow.transitions.some(transition => transition.from === savedStatus && transition.to === state.id))) ?? [];
  const label = reopening ? (en ? 'Reopen task' : '重新打开任务') : (en ? 'Mark complete' : '标记完成');
  const Icon = category === 'completed' ? CircleCheck : category === 'canceled' ? CircleX : Circle;
  if (staged && category === 'completed') return <button type="button" className="task-complete is-completed" aria-label={en ? 'Undo staged completion' : '撤销草稿中的完成状态'} disabled={!c.canEditTaskDraft} onClick={() => c.patchTaskDraft({ status: savedStatus })} title={en ? 'Undo staged completion; the draft saves automatically after edits settle' : '撤销草稿中的完成状态；停止输入后自动保存'}><Icon size={15} /><span>{en ? 'Completed · draft' : '已完成 · 草稿'}</span></button>;
  if (reopening && !candidates.length) return <span className={`task-complete is-${category}`} aria-label={category === 'completed' ? (en ? 'Completed' : '已完成') : (en ? 'Canceled' : '已取消')}><Icon size={15} /><span>{category === 'completed' ? (en ? 'Completed' : '已完成') : (en ? 'Canceled' : '已取消')}</span></span>;
  if (candidates.length > 1) return <label className={`task-complete task-complete-picker ${reopening ? '' : 'is-completed'}`}><Icon size={15} /><span className="sr-only">{label}</span><RadixSelect aria-label={label} title={en ? 'Choose a configured state; the draft saves automatically after edits settle' : '选择配置中的状态；停止输入后自动保存'} value="" disabled={!c.canEditTaskDraft} onChange={event => { if (event.target.value) c.patchTaskDraft({ status: event.target.value }); }}><option value="" disabled>{label}…</option>{candidates.map(state => <option key={state.id} value={state.id}>{taskStateLabel(state, en)}</option>)}</RadixSelect></label>;
  return <button type="button" className="task-complete" aria-label={label} disabled={!c.canEditTaskDraft || !candidates.length} title={!candidates.length ? (en ? 'No legal transition is configured.' : '未配置合法转换。') : (en ? `Stage ${candidates[0].label}; the draft saves automatically after edits settle` : `暂存为「${candidates[0].label}」；停止输入后自动保存`)} onClick={() => { if (candidates[0]) c.patchTaskDraft({ status: candidates[0].id }); }}><Icon size={15} /><span>{label}</span></button>;
}

export function TaskDetailSurface({ controller: c, en, onOpenGraph }: { controller: WorkspaceController; en: boolean; onOpenGraph: () => void }) {
  const { workspace } = usePmService();
  const agentPanel = useOptionalPmAgentPanel();
  const location = useLocation();
  const [briefView, setBriefView] = useState<'brief' | 'knowledge' | null>(null);
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const entity = c.entity;
  const task = c.selected;
  const projectId = entity?.project;
  const comments = useTaskComments(task?.id ?? '', projectId ?? '');
  const artifacts = useTaskArtifacts(task?.id ?? '', projectId, !!projectId);
  const discussionTaskId = task?.id;
  useEffect(() => {
    if (!discussionTaskId || location.hash !== `#task-discussion-${discussionTaskId}`) return;
    const frame = requestAnimationFrame(() => document.getElementById(`task-discussion-${discussionTaskId}`)?.scrollIntoView({ block: 'start' }));
    return () => cancelAnimationFrame(frame);
  }, [location.hash, discussionTaskId]);
  if (!entity || !task) return null;
  const disabled = !c.canEditTaskDraft;
  const childCount = c.files.filter(file => file.entity.entity === 'work_item' && file.entity.parent === task.id).length;
  const commentCount = comments.isPending || comments.error ? '—' : String(comments.data?.length ?? 0);
  const resourceCount = artifacts.completeRead ? String(artifacts.referenced.size) : '—';
  const scrollToSection = (id: string) => document.getElementById(id)?.scrollIntoView({ block: 'start' });
  const t = (english: string, zh: string) => en ? english : zh;
  const workflow = workflowFor('work_item', c.configuration);
  const state = workflow?.states.find(state => state.id === entity.status);
  const stateLabel = state ? taskStateLabel(state, en) : entity.status || t('Unavailable', '不可用');
  const issue = (name: string) => c.draftDiagnostics.find(diagnostic => diagnostic.field === name && diagnostic.severity === 'error');
  const descriptionSplit = splitTaskBody(c.raw);
  const descriptionBody = descriptionSplit?.body ?? entity.body;
  const descriptionEditable = c.canEditSourceDraft && !!descriptionSplit;
  function beginDescriptionEdit() {
    if (!descriptionEditable) return;
    setEditingDescription(true);
  }
  function changeDescriptionBody(body: string) {
    const current = splitTaskBody(c.raw);
    if (!current || !c.canEditSourceDraft) return;
    c.updateDraft(`${current.prefix}${body}`);
  }
  function endDescriptionEdit(event: FocusEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setEditingDescription(false);
  }
  function editDescriptionFromPointer(event: MouseEvent<HTMLDivElement>) {
    if (!descriptionEditable || window.getSelection()?.toString().trim()) return;
    if ((event.target as HTMLElement).closest('a, button, input, textarea, select, summary, [role="checkbox"], [contenteditable="true"]')) return;
    beginDescriptionEdit();
  }
  function editDescriptionFromKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (!descriptionEditable || event.target !== event.currentTarget || event.key !== 'Enter') return;
    event.preventDefault();
    beginDescriptionEdit();
  }
  return <article className={`task-detail-surface issue-detail ${contextOpen ? 'is-context-open' : ''} ${focusMode ? 'is-focus' : ''}`} data-testid="task-detail-surface" aria-label={t('Task details', '任务详情')}>
    <main className="issue-document">
      <div className="issue-title-row">
        <TaskTitleField value={entity.title} disabled={disabled} invalid={!!issue('title')} describedBy={issue('title') ? 'task-title-error' : undefined} en={en} required testId="field-title" className="task-title-input" onValue={title => c.patchTaskDraft({ title })} />
        <button type="button" className="issue-focus-toggle" aria-pressed={focusMode} onClick={() => setFocusMode(value => !value)}>{t('Focus', '专注')}</button>
        <button type="button" className="issue-context-toggle" aria-expanded={contextOpen} onClick={() => setContextOpen(value => !value)}>{t('Details', '详情')}</button>
      </div>
      {issue('title') && <small className="task-field-error" id="task-title-error">{issue('title')!.message}</small>}
      <div className="issue-status-line"><span className="issue-state-chip" data-category={statusCategory(entity, c.configuration) ?? 'unknown'}>{stateLabel}</span>
        <button type="button" className="issue-meta-count" onClick={() => scrollToSection(`task-children-${task.id}`)}>{t('Subtasks', '子任务')} {childCount}</button>
        {projectId && <button type="button" className="issue-meta-count" onClick={() => scrollToSection(`task-resources-${task.id}`)}>{t('Resources', '资料')} {resourceCount}</button>}
        {projectId && <button type="button" className="issue-meta-count" onClick={() => scrollToSection(`task-discussion-${task.id}`)}>{t('Comments', '评论')} {commentCount}</button>}
        {workspace && projectId && <Link className="issue-meta-count" to={`/agent/runs?${new URLSearchParams({ view: "business", workspaceId: workspace.id, projectId, taskId: task.id })}`}>{t('Related Agent Runs', '关联 Agent 执行')}</Link>}
      </div>
      {disabled && <p className="task-readonly-note" role="status">{c.draftParseError ? t('The source is invalid. Saved values are shown; repair the Markdown source to edit fields.', '源码无效，当前显示已保存的值；请先修复 Markdown 源码。') : entity.archived ? t('Archived task. Restore it in Advanced properties before editing.', '任务已归档，请在高级属性中恢复后再编辑。') : c.ahead ? t('The source changed on disk. Compare and resolve versions before editing fields.', '磁盘源码已更改，请先比较并解决版本冲突。') : c.writesBlocked ? t('A write is pending or unconfirmed. Resolve its original recovery record before editing.', '有写入待确认或结果未知，请先核对原恢复记录。') : t('Task fields are currently read only. Review the access, source or configuration diagnostics.', '任务字段当前只读，请查看权限、源码或配置诊断。')}</p>}
      <section className={`task-description ${editingDescription ? 'is-editing' : ''}`} aria-labelledby="task-description-heading">
        <div className="task-section-heading">
          <h2 id="task-description-heading" className="issue-section-title">{t('Description', '描述')}</h2>
        </div>
        {editingDescription
          ? <div className="task-description-editor" onBlur={endDescriptionEdit}><MarkdownBodyEditor value={descriptionBody} disabled={!descriptionEditable} en={en} onChange={changeDescriptionBody} /></div>
          : <div className="task-description-surface" tabIndex={descriptionEditable ? 0 : -1} aria-label={descriptionEditable ? t('Edit description', '编辑描述') : undefined} onClick={editDescriptionFromPointer} onKeyDown={editDescriptionFromKeyboard}>
            {entity.body.trim() ? <Preview raw={c.draftParseError ? c.selected!.raw : c.raw} body={entity.body} hideTitle viewProps={{ ...c.viewProps, files: c.files, allFiles: c.files }} disabled={disabled} onToggle={c.toggleTaskChecklist} onLink={c.wikiLink} /> : <span className="task-description-empty">{t('Add description', '添加描述')}</span>}
          </div>}
      </section>
      <div className="task-detail-related issue-document-sections">
        <TaskChildren controller={c} en={en} />
        <TaskResourcesSection controller={c} en={en} />
        {workspace && projectId && <section className="issue-delivery"><header className="issue-section-heading"><h2 className="issue-section-title">{t('Delivery result', '交付结果')}</h2><button type="button" className="issue-meta-count" onClick={() => setDeliveryOpen(true)}>{t('Review delivery', '交付审查')}</button></header><button type="button" className="issue-delivery-card" onClick={() => setDeliveryOpen(true)}><span>{t('Code delivery & evidence', '代码交付与证据')}</span><span aria-hidden="true">→</span></button></section>}
        <TaskDiscussionSection controller={c} en={en} />
      </div>
    </main>
    <aside className={`issue-sidebar ${contextOpen ? 'is-open' : ''}`} aria-label={t('Task context', '任务上下文')}>
      <button type="button" className="issue-context-close" onClick={() => setContextOpen(false)}>{t('Close details', '关闭详情')}</button>
      <TaskContextSidebar controller={c} en={en} />
      {projectId && <TaskBriefSummary key={`summary:${task.id}:${task.revision}`} controller={c} en={en} onOpen={() => setBriefView('brief')} />}
      {agentPanel && workspace && <section className="issue-context-card issue-agent-card" aria-label={t('Agent collaboration', 'Agent 协作')}>
        <header className="issue-context-card-heading"><h3>{t('Agent collaboration', 'Agent 协作')}</h3></header>
        <button type="button" className="issue-context-link" onClick={() => agentPanel.openPanel({ workspaceId: workspace.id, projectId, entityId: task.id, taskId: task.id, title: entity.title })}>{t('Open Agent chat', '打开 Agent 对话')}</button>
        {projectId && <Link className="issue-context-link" to={`/agent/runs?${new URLSearchParams({ view: "business", workspaceId: workspace.id, projectId, taskId: task.id })}`}>{t('Related Runs & same Work Thread', '关联执行与同一 Work Thread')}</Link>}
        <button type="button" className="issue-context-link" onClick={() => scrollToSection(`task-discussion-${task.id}`)}>{t('Same Issue Work Thread', '同一 Issue Work Thread')}</button>
      </section>}
      {projectId && <section className="issue-context-card issue-knowledge-card" aria-label={t('Knowledge and relations', '知识与关联')}>
        <header className="issue-context-card-heading"><h3>{t('Knowledge & relations', '知识与关联')}</h3></header>
        <div className="issue-context-actions"><button type="button" onClick={onOpenGraph}>{t('Graph', '关系图')}</button><button type="button" onClick={() => setBriefView('knowledge')}>{t('Knowledge candidates', '知识候选')}</button></div>
      </section>}
    </aside>
    <Sheet open={briefView !== null} onOpenChange={open => { if (!open) setBriefView(null); }}>
      <SheetContent side="right" size={640} className="issue-drawer">
        <SheetHeader><SheetTitle>{briefView === 'knowledge' ? t('Knowledge & relations', '知识与关联') : t('Execution brief', '执行简报')}</SheetTitle><SheetDescription>{briefView === 'knowledge' ? t('Scoped knowledge candidates and their sources.', '明确范围的候选知识与来源。') : t('Read-only task material. Viewing it does not dispatch a model.', '只读任务材料；查看不会派发模型。')}</SheetDescription></SheetHeader>
        <SheetBody>{briefView && <TaskBriefPanel key={`${task.id}:${task.revision}:${briefView}`} controller={c} en={en} focusSection={briefView} embedded />}</SheetBody>
      </SheetContent>
    </Sheet>
    <Sheet open={deliveryOpen} onOpenChange={setDeliveryOpen}>
      <SheetContent side="right" size={760} className="issue-drawer">
        <SheetHeader><SheetTitle>{t('Delivery review', '交付审查')}</SheetTitle><SheetDescription>{t('Read-only code delivery, tests and CI evidence. Reviewing does not complete the task.', '只读代码交付、测试与 CI 证据；审查不会完成任务。')}</SheetDescription></SheetHeader>
        <SheetBody>{workspace && projectId && <><TaskCodeDeliveryPanel key={`${workspace.id}:${task.id}:${task.revision}`} workspaceId={workspace.id} projectId={projectId} taskId={task.id} revision={task.revision} disabled={disabled || !!c.draft || !!c.ahead || c.writesBlocked} en={en} /><button type="button" className="issue-context-link issue-drawer-link" onClick={() => { setDeliveryOpen(false); requestAnimationFrame(() => scrollToSection(`task-resources-${task.id}`)); }}>{t('View resources & evidence', '查看关联资料与证据')}</button></>}</SheetBody>
      </SheetContent>
    </Sheet>
  </article>;
}
