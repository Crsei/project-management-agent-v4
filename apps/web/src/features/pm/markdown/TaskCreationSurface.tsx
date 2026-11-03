import { scenarioFitsDraft } from './app-scenarios';
import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { stringify as stringifyYaml } from 'yaml';
import { entityDefinitions, entityKinds, workflowFor, type EntityKind, type FileRecord } from '@pm-schema';
import { Bot, LoaderCircle } from 'lucide-react';
import { useI18n } from '@/lib/i18n-provider';
import { EntityFields } from './EntityFields';
import { Diagnostics } from './Diagnostics';
import { creationComplete, creationDraftEditable, hasUncertainCreationDrafts, type CreationInitial, type NativeCreationAttempt } from './creation-model';
import { useEntityCreation } from './creation-controller';
import { useCoreSession, useCreationDrafts } from './session';
import { usePmService } from '../service/pm-service';
import { allowed, CommandNotice } from '../service/pm-ui';
import { teamTaskCreateProjectProblem } from '../service/team-task-actions-model';
import { PersonalMentionPicker } from '../service/PersonalMentionPicker';
import { LocalProjectCreationFields } from './LocalProjectCreationFields';
import { ProjectCreationFields } from './ProjectCreationFields';
import { InlineSubtasks, TaskProperties, TaskTitleField } from './TaskDocumentFields';
import { MarkdownBodyEditor } from './MarkdownBodyEditor';
import './task-creation.css';
import './task-document.css';
import './project-creation.css';
import { RadixSelect } from "@/components/ui/radix-select"

export interface EntityCreationSurfaceProps {
  mode: 'compact' | 'dialog' | 'page';
  initial?: CreationInitial;
  projectId?: string;
  draftId?: string;
  onCreated: (file: FileRecord) => void;
  onClose?: () => void;
  onExpand?: (draftId: string) => void;
}
const taskFields = ['title', 'status', 'project', 'assignee', 'priority', 'x-pm-start', 'due', 'labels', 'x-pm-estimate', 'x-pm-location'];
const zhKind: Record<EntityKind, string> = { project: '项目', work_item: '任务', document: '文档', cycle: 'Sprint（周期）', milestone: '里程碑', module: '模块', requirement: '需求', release: '发布', goal: '目标' };

export function TaskCreationSurface(props: EntityCreationSurfaceProps) {
  return <EntityCreationSurface {...props} initial={{ ...props.initial, entity: 'work_item' }} />;
}

function CreationInput({ value, onChange, ...props }: InputHTMLAttributes<HTMLInputElement> & { value: string }) {
  const [text, setText] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (props.disabled || document.activeElement !== input.current) setText(value); }, [props.disabled, value]);
  return <input {...props} ref={input} value={text} onChange={event => { setText(event.target.value); onChange?.(event); }} />;
}

function CreationTextarea({ value, onChange, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const [text, setText] = useState(value);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (props.disabled || document.activeElement !== input.current) setText(value); }, [props.disabled, value]);
  return <textarea {...props} ref={input} value={text} onChange={event => { setText(event.target.value); onChange?.(event); }} />;
}

function CreationLabels({ value, suggestions, disabled, label, uid, onChange }: { value: unknown; suggestions: string[]; disabled: boolean; label: string; uid: string; onChange: (labels: string[]) => void }) {
  const rendered = Array.isArray(value) ? value.join(', ') : '';
  const [text, setText] = useState(rendered);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (document.activeElement !== input.current) setText(rendered); }, [rendered]);
  return <label>{label}<input ref={input} aria-label={label} data-testid="field-labels" list={`${uid}-labels`} value={text} disabled={disabled} onChange={event => {
    setText(event.target.value);
    onChange([...new Set(event.target.value.split(',').map(item => item.trim()).filter(Boolean))]);
  }} onBlur={() => setText(rendered)} /><datalist id={`${uid}-labels`}>{suggestions.map(item => <option key={item} value={item} />)}</datalist></label>;
}

function CreationContent({ project, children }: { project: boolean; children: ReactNode }) {
  if (!project) return children;
  return <div className="project-creation-body">{children}</div>;
}

export function EntityCreationSurface({ mode, initial, projectId, draftId, onCreated, onClose, onExpand }: EntityCreationSurfaceProps) {
  const session = useCoreSession();
  const c = useEntityCreation({ initial, projectId, draftId, onCreated: file => {
    if (mode === 'page') session.detail.update(() => ({ entityId: file.id, tab: 'source' }));
    onCreated(file);
  } });
  const [creationDrafts] = useCreationDrafts();
  const location = useLocation();
  const navigate = useNavigate();
  const { workspace } = usePmService();
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();
  const root = `/pm/${encodeURIComponent(workspaceSlug || workspace?.id || '')}`;
  const projectRoot = projectId ? `${root}/projects/${encodeURIComponent(projectId)}` : root;
  const returnTo = location.pathname.endsWith('/issues/new') ? new URLSearchParams(location.search).get('returnTo') : `${location.pathname}${location.search}${location.hash}`;
  const recoveryLink = (id: string) => `${root}/issues/new?${new URLSearchParams({ draft: id, ...(returnTo ? { returnTo } : {}) })}`;
  const en = useI18n().locale === 'en';
  const uid = useId();
  const [expanded, setExpanded] = useState(mode !== 'compact');
  const [dirty, setDirty] = useState(false);
  const composing = useRef(false);
  const draft = c.draft;
  const snapshot = c.sources.data;
  const documentMode = mode === 'page' && draft?.kind === 'work_item';
  const t = (zh: string, english: string) => en ? english : zh;
  useEffect(() => {
    if (!documentMode || !dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [documentMode, dirty]);
  if (c.sources.error) return <section className="task-creation" role="alert"><p>{c.sources.error.message}</p><button type="button" className="secondary-button" onClick={() => { void c.sources.refetch(); }}>{t('重新读取工作区', 'Read workspace again')}</button><CommandNotice /></section>;
  if (!snapshot) return <p className="task-creation" role="status">{t('正在读取授权工作区…', 'Reading the authorized workspace…')}</p>;
  if (!draft) return <section className="task-creation" role={c.error || c.storageFailed ? 'alert' : 'status'}><p>{c.error || (c.storageFailed ? t('无法读取浏览器恢复存储；未发送创建请求。请恢复存储后重新打开，不能清空未知请求记录。', 'Browser recovery storage could not be read; no create request was sent. Restore storage and reopen without clearing unknown requests.') : t('此草稿不存在或已完成；未自动创建新意图。', 'This draft is missing or already complete; no replacement intent was created.'))}</p>{onClose && <button type="button" className="secondary-button" onClick={onClose}>{t('返回', 'Back')}</button>}</section>;
  const project = String(draft.values.project ?? '');
  if (!workspace?.capabilities.includes('domain.read') || project && !allowed(workspace, 'domain.read', project)) return <section className="task-creation" role="alert"><p>{t('当前无权读取此草稿的项目。私有内容已隐藏；重新获得相同账号的授权后可恢复。', 'You cannot currently read this draft’s project. Private content is hidden; the same account may resume after access is restored.')}</p>{onClose && <button type="button" className="secondary-button" onClick={onClose}>{t('返回', 'Back')}</button>}</section>;
  if (projectId && (draft.kind === 'project' || project !== projectId)) return <section className="task-creation" role="alert"><p>{t('此草稿属于其他项目，未移动或修改。请返回原创建意图继续恢复。', 'This draft belongs to another project and has not been moved or changed. Reopen the original intent to continue recovery.')}</p><Link className="secondary-button" to={recoveryLink(draft.draftId)}>{t('打开原草稿', 'Open original draft')}</Link>{onClose && <button type="button" className="secondary-button" onClick={onClose}>{t('返回项目任务', 'Back to project tasks')}</button>}</section>;
  const task = draft.kind === 'work_item';
  const projectCreation = draft.kind === 'project';
  const editable = creationDraftEditable(draft) && !c.busy && c.canWrite;
  const uncertain = hasUncertainCreationDrafts({ [draft.draftId]: draft });
  const completed = creationComplete(draft);
  const submitLabel = c.busy ? t('正在创建…', 'Creating…') : draft.attempt?.phase === 'committed' ? t('继续未完成项', 'Continue remaining actions') : projectCreation ? c.localSettings.data?.enabled ? t('创建并初始化项目', 'Create and initialize project') : t('创建项目', 'Create project') : mode === 'page' ? t('创建任务', 'Create task') : t('创建', 'Create');
  const submitDisabled = c.busy || !!c.guard || c.storageFailed || uncertain || !c.canWrite || completed || draft.attempt?.phase === 'rejected' || draft.children.some(child => child.attempt?.phase === 'rejected') || draft.watchAttempt?.phase === 'rejected';
  const issues = [...c.issues, ...(draft.attempt?.diagnostics ?? [])];
  const fieldError = (name: string) => issues.find(issue => issue.field === name)?.message;
  const subtasksEditable = c.canWrite && !c.busy && !completed && (!draft.attempt || draft.attempt.phase === 'committed');
  const errorProps = (name: string) => ({ 'aria-invalid': !!fieldError(name), 'aria-describedby': fieldError(name) ? `${uid}-${name}-error` : undefined });
  const projects = snapshot.files.filter(file => file.entity.entity === 'project' && allowed(workspace, 'domain.read', file.id) && allowed(workspace, 'planning.edit', file.id) && (!task || !teamTaskCreateProjectProblem(snapshot, file.id, c.sourceDrafts)));
  const members = c.directory.data?.members.filter(member => !member.access?.revokedAt && (!member.access || member.access.capabilities.includes('domain.read') && (member.access.projectIds === null || member.access.projectIds.includes(project)))) ?? [];
  const assignee = String(draft.values.assignee ?? '');
  const labels = Array.from(new Set(snapshot.files.flatMap(file => file.entity.labels)));
  const recoverableDrafts = Object.values(creationDrafts).filter(item => item.draftId !== draft.draftId && item.draftId !== c.recoveryDraftId && !creationComplete(item) && (item.kind === 'project' || !item.values.project || allowed(workspace, 'domain.read', String(item.values.project)))).sort((a, b) => b.updatedAt - a.updatedAt);
  const renderAttempt = (attempt: NativeCreationAttempt | undefined, childId?: string) => attempt && <div className={`creation-outcome creation-outcome-${attempt.phase}`} role="status">
    <p><strong>{attempt.localDirectory ? t('本地项目初始化', 'Local project initialization') : t('原生创建', 'Native creation')}: {attempt.phase === 'committed' ? t('已确认', 'Confirmed') : attempt.phase === 'rejected' ? t('已确认拒绝', 'Confirmed rejected') : attempt.phase === 'prepared' ? t('已冻结、尚未发送', 'Frozen, not sent') : t('结果待核对', 'Outcome unconfirmed')}</strong>{attempt.entityId && <> · <code>{attempt.entityId}</code></>}</p>
    <p className="creation-key">{t('原请求键', 'Original request key')}: <code>{attempt.key}</code></p>
    {attempt.message && (!attempt.localDirectory || c.localSettings.data?.canManage) && <p>{attempt.message}</p>}
    {attempt.revision && <p className="creation-key">{t('原提交 revision', 'Original committed revision')}: <code>{attempt.revision}</code></p>}
    {attempt.currentStatus && attempt.currentStatus !== 'present' && <p>{t('原创建已提交，但当前文件已删除、缺失或不可访问；不会重新创建。', 'The original creation committed, but its current file is deleted, missing or inaccessible; it will never be recreated.')}</p>}
    {(attempt.phase === 'unknown' || attempt.phase === 'sending') && <div className="creation-inline-actions"><button type="button" className="secondary-button" disabled={c.busy} onClick={() => { void c.reconcile(childId); }}>{attempt.localDirectory ? t('核对原项目初始化', 'Check original project initialization') : t('核对原生创建结果', 'Check native creation result')}</button><button type="button" className="secondary-button" disabled={c.busy} onClick={() => { void c.reconcile(childId, true); }}>{attempt.localDirectory ? t('恢复原初始化步骤并核对', 'Recover original initialization steps') : t('恢复原写入审计并核对', 'Recover original write audit')}</button></div>}
    {attempt.phase === 'rejected' && <button type="button" className="secondary-button" disabled={c.busy || !c.canWrite} onClick={() => c.resetRejected(childId)}>{t('保留草稿并编辑已拒绝项', 'Keep draft and edit rejected item')}</button>}
    <Diagnostics diagnostics={attempt.diagnostics} />
  </div>;
  return <section className={`task-creation task-creation-${mode}${documentMode ? ' task-document' : ''}${projectCreation ? ' project-creation' : ''}`} aria-label={projectCreation ? t('创建项目', 'Create project') : task ? t('创建任务', 'Create task') : t('创建 Markdown 对象', 'Create Markdown entity')}>
    <CommandNotice />
    <form className={documentMode ? 'task-document-form' : undefined} onSubmit={event => { event.preventDefault(); if (!projectCreation || !composing.current && !submitDisabled) void c.submit(); }} onInput={documentMode ? () => setDirty(true) : undefined} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => {
      if (projectCreation && (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) return;
      if (projectCreation && (event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        if (!submitDisabled) event.currentTarget.requestSubmit();
        return;
      }
      if (mode === 'page' && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (!event.currentTarget.querySelector<HTMLButtonElement>('[data-testid="create-task-submit"]')?.disabled) event.currentTarget.requestSubmit();
      }
    }} aria-busy={c.busy}>
      <CreationContent project={projectCreation}>
      {documentMode ? <div className="doc-toolbar">
        <span className="doc-toolbar-status" role="status">{(c.busy || dirty) && (c.busy ? t('正在创建…', 'Creating…') : c.storageFailed ? t('草稿仅保留在此页内存', 'Draft is only in this page') : t('草稿已自动保存在此浏览器', 'Draft saved in this browser'))}</span>
        <button type="button" className="secondary-button doc-agent-button" onClick={() => {
          const next = new URLSearchParams({ workspace: workspace?.id || workspaceSlug || '' });
          if (project) next.set('project', project);
          next.set('returnTo', `${location.pathname}${location.search}${location.hash}`);
          navigate(`/agent/workspace?${next}`);
        }} aria-label={t('打开 Agent 助手', 'Open the Agent assistant')} title={t('打开 Agent 助手；当前项目作为上下文，未保存草稿会保留', 'Open the Agent assistant with this project as context; the draft is kept')}><Bot size={15} aria-hidden="true" />Agent</button>
        <button type="submit" className="primary-button" data-busy={c.busy || undefined} data-testid="create-task-submit" disabled={submitDisabled}>
          {c.busy && <LoaderCircle className="doc-spinner" size={14} aria-hidden="true" />}{submitLabel}
        </button>
      </div> : projectCreation ? mode === 'dialog' ? null : <header className="project-creation-heading"><h2>{t('新建项目', 'New project')}</h2></header> : <header className="creation-heading"><div><h2>{task ? t('新建任务', 'New task') : t('新建对象', 'New entity')}</h2>{projectId && <p>{t('项目', 'Project')}: {snapshot.files.find(file => file.id === projectId && file.entity.entity === 'project')?.entity.title || projectId}</p>}</div><div className="creation-inline-actions">{onClose && <button type="button" className="secondary-button" onClick={onClose}>{t('取消 / 返回', 'Cancel / back')}</button>}<button type="submit" className="primary-button" data-testid="create-task-submit" disabled={submitDisabled}>{submitLabel}</button></div></header>}
      {c.storageFailed && <div className="creation-alert" role="alert"><p>{t('浏览器恢复存储不可用或已满。已禁止发送；当前输入保留在本页内存，请勿关闭。', 'Browser recovery storage is unavailable or full. Sending is blocked; current text remains in this page’s memory. Keep it open.')}</p><button type="button" className="secondary-button" onClick={c.saveLocally}>{t('重试保存草稿', 'Retry saving draft')}</button></div>}
      {c.guard && !projectCreation && <p className="creation-alert" role="status">{c.guard}</p>}
      {c.recoveryDraftId && <p className="creation-alert"><Link to={recoveryLink(c.recoveryDraftId)}>{t('恢复其他项目中尚待核对的原创建意图', 'Recover the other unconfirmed creation intent')}</Link></p>}
      {recoverableDrafts.length > 0 && <details className="creation-saved-drafts"><summary>{t('恢复其他创建草稿', 'Recover other creation drafts')} · {recoverableDrafts.length}</summary><ul>{recoverableDrafts.map(item => <li key={item.draftId}><Link to={recoveryLink(item.draftId)}>{String(item.values.title || (en ? entityDefinitions[item.kind].label : zhKind[item.kind]))} · {item.values.project ? snapshot.files.find(file => file.id === item.values.project && file.entity.entity === 'project')?.entity.title || String(item.values.project) : t('工作区', 'Workspace')}</Link></li>)}</ul></details>}
      {c.error && !projectCreation && <p className="creation-alert" role="alert">{c.error}</p>}
      {!c.canWrite && <p className="creation-alert" role="status">{t('当前只读；草稿已保留，未发送写入。', 'Read-only. Your draft is retained; no write was sent.')}</p>}
      {c.directory.error && task && <div className="creation-alert" role="alert"><p>{t('成员目录读取失败，不会将读取失败当作没有成员。', 'Member directory failed to load; this is not an empty directory.')}</p><button type="button" className="secondary-button" onClick={() => { void c.directory.refetch(); }}>{t('重新读取成员', 'Read members again')}</button></div>}
      {!task && !projectCreation && <label>{t('对象类型', 'Entity type')}<RadixSelect aria-label="New entity type" data-testid="new-entity-type" value={draft.kind} disabled={!editable} onChange={event => c.changeKind(event.target.value as EntityKind)}>{entityKinds.filter(kind => !projectId || kind !== 'project').map(kind => <option key={kind} value={kind}>{en ? kind === 'cycle' ? 'Sprint (cycle)' : entityDefinitions[kind].label : zhKind[kind]}</option>)}</RadixSelect></label>}
      {task && <aside className="app-scenario-card" aria-label={t('预置 App 场景', 'App scenario')}>
        <div><strong>IdeaBoard</strong><span>{t('用户反馈与路线图 App', 'Feedback & roadmap app')}</span>
        <p>{t('提交反馈、投票、路线图与数据持久化。预置需求，由 Agent 真正开发成品。', 'Feedback, votes, roadmap and persistence. Seed requirements; let the Agent build the app.')}</p>
        <small>{t('只填入可编辑草稿，不自动创建任务或运行；保存后选择「开发并交付」。', 'Fills an editable draft only. Save, then choose Develop and deliver.')}</small></div>
        <button type="button" className="secondary-button" disabled={!editable || !scenarioFitsDraft(draft)} onClick={c.applyAppScenario}>{t('使用这个场景', 'Use this scenario')}</button>
        {!scenarioFitsDraft(draft) && <small>{t('已有标题或描述不会被覆盖。新建空白任务可再次使用。', 'Existing content is never overwritten. Use a blank task to apply this scenario.')}</small>}
      </aside>}
      {projectCreation ? <>
        <ProjectCreationFields values={draft.values} body={draft.body} disabled={!editable} en={en} errors={Object.fromEntries(issues.filter(issue => issue.field).map(issue => [issue.field!, issue.message]))} onChange={c.changeFields} onBodyChange={c.changeBody} />
        <div className="project-creation-location"><LocalProjectCreationFields controller={c} /></div>
        {c.error && <p className="creation-alert" role="alert">{c.error}</p>}
        {c.guard && <p className="project-creation-guard" role="status">{c.guard}</p>}
        <details className="creation-advanced project-creation-advanced">
          <summary>{t('高级属性与关系', 'Advanced properties and relations')}</summary>
          <div className="creation-advanced-fields"><EntityFields kind="project" errors={Object.fromEntries(issues.filter(issue => issue.field).map(issue => [issue.field!, issue.message]))} creating en={en} values={draft.values} files={snapshot.files} configuration={snapshot.configuration} disabled={!editable} exclude={['title', 'owner', 'due', 'x-pm-icon', 'x-pm-color', ...(c.localSettings.data?.enabled ? ['status'] : [])]} onChange={c.changeFields} /></div>
          <details><summary>{t('提交属性预览', 'Property preview')}</summary><pre>{stringifyYaml({ ...draft.values, entity: draft.kind })}</pre></details>
        </details>
      </> : documentMode ? <>
        <TaskTitleField value={String(draft.values.title ?? '')} disabled={!editable} invalid={!!fieldError('title')} describedBy={fieldError('title') ? `${uid}-title-error` : undefined} en={en} autoFocus required testId="new-task-title" placeholder={t('需要完成什么？', 'What needs to be done?')} onValue={title => c.changeFields({ title })} />
        {fieldError('title') && <p className="doc-field-error" id={`${uid}-title-error`} role="alert">{fieldError('title')}</p>}
        <TaskProperties
          values={draft.values}
          configuration={snapshot.configuration}
          members={members}
          projects={projects.map(file => ({ id: file.id, title: file.entity.title }))}
          projectLocked={!!projectId}
          labelSuggestions={labels}
          disabled={!editable}
          en={en}
          errors={{ project: fieldError('project'), status: fieldError('status'), assignee: fieldError('assignee'), priority: fieldError('priority'), due: fieldError('due'), 'x-pm-start': fieldError('x-pm-start'), labels: fieldError('labels'), 'x-pm-estimate': fieldError('x-pm-estimate'), 'x-pm-location': fieldError('x-pm-location') }}
          onChange={c.changeFields}
        />
        <ul className="doc-property-errors" role="alert">
          {([
            ['project', t('项目', 'Project')], ['status', t('状态', 'Status')], ['assignee', t('负责人', 'Assignee')], ['priority', t('优先级', 'Priority')],
            ['due', t('截止日期', 'Due date')], ['x-pm-start', t('开始日期', 'Start date')], ['labels', t('标签', 'Labels')],
            ['x-pm-estimate', t('估算点数', 'Estimate')], ['x-pm-location', t('位置', 'Location')],
          ] as const).filter(([name]) => fieldError(name)).map(([name, label]) => <li key={name}>{label}: {fieldError(name)}</li>)}
        </ul>
        <MarkdownBodyEditor value={draft.body} disabled={!editable} en={en} onChange={c.changeBody} />
        <div className="doc-attach"><PersonalMentionPicker projectId={project} disabled={!editable} showHints={false} onInsert={token => c.changeBody(`${draft.body}${draft.body.endsWith('\n') ? '' : '\n'}${token}\n`)} /></div>
        <InlineSubtasks
          items={draft.children.map(child => ({ draftId: child.draftId, values: child.values, body: child.body, locked: !!child.attempt || (!!draft.attempt && draft.attempt.phase !== 'committed') }))}
          configuration={snapshot.configuration}
          members={members}
          disabled={!subtasksEditable}
          en={en}
          errorFor={index => issues.filter(issue => issue.field?.startsWith(`children.${index}.`)).map(issue => issue.message)}
          onAdd={c.addChild}
          onRemove={c.removeChild}
          onChange={c.changeChild}
        />
        {draft.children.filter(child => child.attempt).map(child => <div className="doc-child-outcome" key={child.draftId}>{renderAttempt(child.attempt, child.draftId)}</div>)}
        <details className="doc-advanced">
          <summary>{t('高级属性与关系', 'Advanced properties and relations')}</summary>
          <div className="doc-advanced-grid"><EntityFields kind={draft.kind} errors={Object.fromEntries(issues.filter(issue => issue.field).map(issue => [issue.field!, issue.message]))} creating en={en} values={draft.values} files={snapshot.files} configuration={snapshot.configuration} disabled={!editable} exclude={taskFields} onChange={c.changeFields} /></div>
          <label className="creation-checkbox"><input type="checkbox" checked={draft.watch} disabled={!editable} onChange={event => c.changeWatch(event.target.checked)} />{t('创建后加入我的关注', 'Add to my watched tasks after creation')}</label>
          <details><summary>{t('提交属性预览', 'Property preview')}</summary><pre>{stringifyYaml({ ...draft.values, entity: draft.kind })}</pre></details>
        </details>
      </> : <>
      <div className={expanded ? 'creation-columns' : 'creation-compact-fields'}>
        <div className="creation-main">
          <label>{t('标题', 'Title')}<CreationInput name="title" data-testid="new-task-title" aria-label={t('标题', 'Title')} {...errorProps('title')} required value={String(draft.values.title ?? '')} disabled={!editable} onChange={event => c.changeFields({ title: event.target.value })} placeholder={t('需要完成什么？', 'What needs to be done?')} /></label>{fieldError('title') && <small id={`${uid}-title-error`} className="creation-field-error">{fieldError('title')}</small>}
          {expanded && <>{mode === 'page' ? <MarkdownBodyEditor value={draft.body} disabled={!editable} en={en} onChange={c.changeBody} /> : <label>{t('描述 · Markdown 源码', 'Description · Markdown source')}<CreationTextarea aria-label={t('新对象 Markdown 描述', 'New entity Markdown description')} value={draft.body} disabled={!editable} onChange={event => c.changeBody(event.target.value)} rows={10} spellCheck={false} /></label>}</>}
          {expanded && task && <PersonalMentionPicker projectId={project} disabled={!editable} showHints={false} onInsert={token => c.changeBody(`${draft.body}${draft.body.endsWith('\n') ? '' : '\n'}${token}\n`)} />}
          {expanded && task && <fieldset className="creation-children"><legend>{t('正式子任务', 'Formal subtasks')}</legend>{draft.children.map((child, index) => {
            const childEditable = !c.busy && c.canWrite && !child.attempt && (!draft.attempt || draft.attempt.phase === 'committed');
            const prefix = `children.${index}.title`;
            return <article className="creation-child" key={child.draftId}>
              <label>{t('子任务', 'Subtask')} {index + 1}<CreationInput aria-label={`${t('子任务标题', 'Subtask title')} ${index + 1}`} required value={String(child.values.title ?? '')} disabled={!childEditable} aria-invalid={!!fieldError(prefix)} aria-describedby={fieldError(prefix) ? `${uid}-child-${index}-error` : undefined} onChange={event => c.changeChild(child.draftId, { values: { title: event.target.value } })} /></label>{fieldError(prefix) && <small id={`${uid}-child-${index}-error`} className="creation-field-error">{fieldError(prefix)}</small>}
              {!draft.attempt && <button type="button" className="secondary-button" disabled={!editable} aria-label={`${t('移除子任务', 'Remove subtask')} ${index + 1}`} onClick={() => c.removeChild(child.draftId)}>{t('移除', 'Remove')}</button>}
              <details><summary>{t('子任务描述与属性', 'Subtask description and properties')}</summary><label>{t('Markdown 描述', 'Markdown description')}<CreationTextarea  value={child.body} disabled={!childEditable} rows={3} onChange={event => c.changeChild(child.draftId, { body: event.target.value })} /></label><label>{t('负责人', 'Assignee')}<RadixSelect aria-label={`${t('子任务负责人', 'Subtask assignee')} ${index + 1}`} value={String(child.values.assignee ?? '')} disabled={!childEditable || !c.directory.data} onChange={event => c.changeChild(child.draftId, { values: { assignee: event.target.value || null } })}><option value="">{t('未分配', 'Unassigned')}</option>{!!child.values.assignee && !members.some(member => member.userId === child.values.assignee) && <option value={String(child.values.assignee)}>{t('原负责人不可用', 'Original assignee unavailable')}</option>}{members.map(member => <option key={member.userId} value={member.userId}>{member.name} · {member.userId}</option>)}</RadixSelect></label><div className="creation-advanced-fields"><EntityFields kind="work_item" errors={Object.fromEntries([...c.issues.filter(issue => issue.field?.startsWith(`children.${index}.`)).map(issue => [issue.field!.slice(`children.${index}.`.length), issue.message]), ...(child.attempt?.diagnostics ?? []).filter(issue => issue.field).map(issue => [issue.field!, issue.message])])} creating en={en} values={{ ...child.values, project }} files={snapshot.files} configuration={snapshot.configuration} disabled={!childEditable} exclude={['title', 'project', 'parent', 'kind', 'assignee']} onChange={values => c.changeChild(child.draftId, { values })} /></div></details>
              {renderAttempt(child.attempt, child.draftId)}
            </article>;
          })}<button type="button" className="secondary-button" disabled={!editable || draft.children.length >= 100} onClick={c.addChild}>{t('添加子任务', 'Add subtask')}</button></fieldset>}
        </div>
        <aside className="creation-properties" aria-label={t('创建属性', 'Creation properties')}>
          {task ? <>
            <label>{t('项目', 'Project')}<RadixSelect required aria-label={t('任务项目', 'Task project')} data-testid="field-project" {...errorProps('project')} value={project} disabled={!editable || !!projectId} onChange={event => c.changeFields({ project: event.target.value || null })}><option value="">{t('请选择项目', 'Choose a project')}</option>{project && !projects.some(file => file.id === project) && <option value={project}>{t('草稿项目当前不可写', 'Draft project currently unavailable')} · {project}</option>}{projects.map(file => <option key={file.id} value={file.id}>{file.entity.title} · {file.id}</option>)}</RadixSelect></label>{fieldError('project') && <small id={`${uid}-project-error`} className="creation-field-error">{fieldError('project')}</small>}
            {expanded && <>
              <label>{t('状态', 'Status')}<RadixSelect aria-label={t('任务状态', 'Task status')} data-testid="field-status" {...errorProps('status')} value={String(draft.values.status ?? '')} disabled={!editable} onChange={event => c.changeFields({ status: event.target.value })}>{workflowFor('work_item', snapshot.configuration)?.states.map(state => <option key={state.id} value={state.id}>{state.label}</option>)}</RadixSelect></label>{fieldError('status') && <small id={`${uid}-status-error`} className="creation-field-error">{fieldError('status')}</small>}
              <label>{t('负责人', 'Assignee')}<RadixSelect aria-label={t('任务负责人', 'Task assignee')} data-testid="field-assignee" {...errorProps('assignee')} value={assignee} disabled={!editable || !c.directory.data} onChange={event => c.changeFields({ assignee: event.target.value || null })}><option value="">{t('未分配', 'Unassigned')}</option>{assignee && !members.some(member => member.userId === assignee) && <option value={assignee}>{t('原负责人不可用', 'Original assignee unavailable')} · {assignee}</option>}{members.map(member => <option key={member.userId} value={member.userId}>{member.name} · {member.userId}</option>)}</RadixSelect></label>{fieldError('assignee') && <small id={`${uid}-assignee-error`} className="creation-field-error">{fieldError('assignee')}</small>}
              <label>{t('开始日期', 'Start date')}<CreationInput aria-label={t('开始日期', 'Start date')} data-testid="field-x-pm-start" type="date" {...errorProps('x-pm-start')} value={String(draft.values['x-pm-start'] ?? '')} disabled={!editable} onChange={event => c.changeFields({ 'x-pm-start': event.target.value || null })} /></label>{fieldError('x-pm-start') && <small id={`${uid}-x-pm-start-error`} className="creation-field-error">{fieldError('x-pm-start')}</small>}
            </>}
            <label>{t('截止日期', 'Due date')}<CreationInput aria-label={t('截止日期', 'Due date')} data-testid="field-due" type="date" {...errorProps('due')} value={String(draft.values.due ?? '')} disabled={!editable} onChange={event => c.changeFields({ due: event.target.value || null })} /></label>{fieldError('due') && <small id={`${uid}-due-error`} className="creation-field-error">{fieldError('due')}</small>}
            {expanded && <>
              <label>{t('优先级', 'Priority')}<RadixSelect aria-label={t('优先级', 'Priority')} data-testid="field-priority" value={String(draft.values.priority ?? 'medium')} disabled={!editable} onChange={event => c.changeFields({ priority: event.target.value })}>{[['low', '低', 'Low'], ['medium', '中', 'Medium'], ['high', '高', 'High'], ['urgent', '紧急', 'Urgent']].map(([value, zh, english]) => <option key={value} value={value}>{en ? english : zh}</option>)}</RadixSelect></label>
              <CreationLabels value={draft.values.labels} suggestions={labels} disabled={!editable} label={t('标签', 'Labels')} uid={uid} onChange={labels => c.changeFields({ labels })} />
              <label>{t('估算点', 'Estimate points')}<CreationInput aria-label={t('估算点', 'Estimate points')} data-testid="field-x-pm-estimate" type="number" min={0} max={1_000_000} step="any" {...errorProps('x-pm-estimate')} value={String(draft.values['x-pm-estimate'] ?? '')} disabled={!editable} onChange={event => c.changeFields({ 'x-pm-estimate': event.target.value === '' ? null : Number(event.target.value) })} /></label>{fieldError('x-pm-estimate') && <small id={`${uid}-x-pm-estimate-error`} className="creation-field-error">{fieldError('x-pm-estimate')}</small>}
              <label>{t('位置', 'Location')}<CreationInput aria-label={t('位置', 'Location')} data-testid="field-x-pm-location" maxLength={1000} {...errorProps('x-pm-location')} value={String(draft.values['x-pm-location'] ?? '')} disabled={!editable} onChange={event => c.changeFields({ 'x-pm-location': event.target.value || null })} /></label>{fieldError('x-pm-location') && <small id={`${uid}-x-pm-location-error`} className="creation-field-error">{fieldError('x-pm-location')}</small>}
              <label className="creation-checkbox"><input type="checkbox" checked={draft.watch} disabled={!editable} onChange={event => c.changeWatch(event.target.checked)} />{t('创建后加入我的关注', 'Add to my watched tasks after creation')}</label>
              <label>{t('提醒', 'Reminders')}<button type="button" disabled>{t('尚未接入', 'Not connected')}</button></label>
            </>}
          </> : null}
        </aside>
      </div>
      {expanded && <details className="creation-advanced" open={!task || undefined}><summary>{t('高级属性与关系', 'Advanced properties and relations')}</summary>{task && <label>{t('对象类型', 'Entity type')}<RadixSelect aria-label="New entity type" data-testid="new-entity-type" value={draft.kind} disabled={!editable || draft.children.length > 0 || draft.watch} onChange={event => c.changeKind(event.target.value as EntityKind)}>{entityKinds.filter(kind => !projectId || kind !== 'project').map(kind => <option key={kind} value={kind}>{en ? kind === 'cycle' ? 'Sprint (cycle)' : entityDefinitions[kind].label : zhKind[kind]}</option>)}</RadixSelect></label>}<div className="creation-advanced-fields"><EntityFields kind={draft.kind} errors={Object.fromEntries(issues.filter(issue => issue.field).map(issue => [issue.field!, issue.message]))} creating en={en} values={draft.values} files={snapshot.files} configuration={snapshot.configuration} disabled={!editable} exclude={task ? taskFields : projectId ? ['title', 'project'] : ['title']} onChange={c.changeFields} /></div><details><summary>{t('提交属性预览', 'Property preview')}</summary><pre>{stringifyYaml({ ...draft.values, entity: draft.kind })}</pre></details></details>}
      {!expanded && <div className="creation-inline-actions"><button type="button" className="secondary-button" disabled={c.busy} onClick={() => { if (onExpand) onExpand(c.draftId); else setExpanded(true); }}>{t('展开完整创建页', 'Expand full creation page')}</button>{draft.watch && <span>{t('创建后关注', 'Watch after creation')}</span>}</div>}
      </>}
      {renderAttempt(draft.attempt)}
      {draft.watchAttempt && <div className="creation-outcome" role="status"><p>{t('个人关注命令', 'Personal watch command')}: {draft.watchAttempt.phase} · <code>{draft.watchAttempt.command.commandId}</code></p>{draft.watchAttempt.message && <p>{draft.watchAttempt.message}</p>}{(draft.watchAttempt.phase === 'unknown' || draft.watchAttempt.phase === 'sending') && <button type="button" className="secondary-button" disabled={c.busy} onClick={() => { void c.reconcileWatch(); }}>{t('核对原关注命令收据', 'Check original watch command receipt')}</button>}{draft.watchAttempt.phase === 'rejected' && <div className="creation-inline-actions"><button type="button" className="secondary-button" disabled={c.busy} onClick={c.retryRejectedWatch}>{t('保留已创建任务，重试已拒绝的关注', 'Keep created task; retry rejected watch')}</button><button type="button" className="secondary-button" disabled={c.busy} onClick={() => { void c.skipRejectedWatch(); }}>{t('明确结束，不添加个人关注', 'Finish explicitly without personal watch')}</button></div>}</div>}
      {draft.attempt?.phase === 'committed' && !completed && <p role="status">{t('父任务已确认，关联项尚未全部完成。返回或刷新仍保留分项进度，不会重建父任务。', 'Parent confirmed; related actions are not all complete. Navigation and refresh preserve individual outcomes and will not recreate the parent.')}{draft.attempt.entityId && <> <Link to={`${projectRoot}/entities/${encodeURIComponent(draft.attempt.entityId)}`}>{t('打开已确认父项', 'Open confirmed parent')}</Link></>}</p>}
      {completed && <div role="status"><p>{t('所有请求均已确认。原创建不会重复；若文件已删除，可结束此意图。', 'All requested outcomes are confirmed. Creation will not repeat; you can finish this intent if its file was deleted.')}</p><div className="creation-inline-actions"><button type="button" className="secondary-button" disabled={c.busy} onClick={() => { void c.openConfirmed(); }}>{t('打开已确认对象', 'Open confirmed entity')}</button><button type="button" className="secondary-button" disabled={c.busy} onClick={async () => { if (await c.dismissCompleted()) onClose?.(); }}>{t('结束已完成创建意图', 'Dismiss completed creation intent')}</button></div></div>}
      <Diagnostics diagnostics={c.issues} />
      </CreationContent>
      {projectCreation && <footer className="project-creation-footer">
        <span className="project-creation-shortcut" aria-hidden="true"><kbd>Ctrl / ⌘</kbd><kbd>↵</kbd></span>
        {onClose && <button type="button" className="secondary-button" onClick={onClose}>{t('取消', 'Cancel')}</button>}
        <button type="submit" className="primary-button" data-testid="create-task-submit" aria-keyshortcuts="Control+Enter Meta+Enter" disabled={submitDisabled}>{c.busy && <LoaderCircle size={14} aria-hidden="true" />}{submitLabel}</button>
      </footer>}
    </form>
  </section>;
}
