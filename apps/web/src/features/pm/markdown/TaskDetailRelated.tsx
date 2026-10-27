import { useId, useMemo, useRef, useState } from 'react';
import { Bookmark, Download, FileText, GitBranch, Plus, Search, X } from 'lucide-react';
import { statusCategory, workflowFor } from '@pm-schema';
import { createReferenceResolver } from '@pm-schema/relations';
import type { Entity as BusinessEntity } from '@contracts';
import { StatusIcon } from '@pm-views';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useDisplayDateTime } from '@/features/workspace/preference-format';
import { DeliveryWorkflow } from '../service/pm-delivery';
import { TaskComments } from '../service/TaskComments';
import { downloadProjectAttachment } from '../service/service-project-detail-panels';
import { usePersonalDashboard, usePmEntities, usePmEntity, usePmService, useProjectAudit } from '../service/pm-service';
import { allowed, CommandNotice, string, strings, useAction } from '../service/pm-ui';
import type { WorkspaceController } from './controller';
import './task-detail-related.css';

type DetailProps = { controller: WorkspaceController; en: boolean };
type ReadState = { data: unknown; isPending: boolean; isFetching: boolean; error: Error | null; refetch: () => unknown };

/** Business actions operate on saved records, never the source draft projection. */
function sourceWriteProblem(c: WorkspaceController, en: boolean): string | null {
  if (c.draft || c.session.drafts.getSnapshot()[c.selectedId]) return en ? 'Save or discard this task’s source draft before using PM service actions.' : '使用 PM 服务操作前，请先保存或放弃此任务的源码草稿。';
  if (c.accessError || c.query.error) return en ? 'Refresh the authorized source before using service actions.' : '请先重新读取有权访问的源文件，再使用服务操作。';
  if (!c.selected || c.unsupported || c.selected.entity.entity !== 'work_item') return en ? 'This task source is unavailable or unsupported.' : '此任务的源文件不可用或暂不受支持。';
  if (c.selected.entity.archived) return en ? 'Archived tasks are read-only.' : '已归档任务为只读。';
  if (c.selected.stale || c.selected.error || c.selected.diagnostics?.some(issue => issue.severity === 'error') || c.configurationInvalid || c.draftInvalid || c.draftParseError || c.ahead) return en ? 'Repair the source diagnostics or revision conflict before using service actions.' : '请先修复源码诊断或解决版本冲突，再使用服务操作。';
  if (c.writesBlocked || c.busy) return en ? 'Another write is pending or unconfirmed. Reconcile its original result first.' : '其他写入正在处理或结果待核对，请先核对原请求。';
  return null;
}

function ReadNotice({ query, en, label }: { query: ReadState; en: boolean; label: string }) {
  return <>
    {query.isPending && !query.data && <p className="td-related-note" role="status">{en ? `Loading ${label}…` : `正在读取${label}…`}</p>}
    {query.isFetching && !!query.data && !query.error && <p className="td-related-note" role="status">{en ? `Refreshing ${label}…` : `正在刷新${label}…`}</p>}
    {query.error && <div className="td-related-alert" role="alert"><p>{!!query.data && (en ? 'Refresh failed; the retained snapshot may be stale. ' : '刷新失败，保留的快照可能已过期。')}{label}: {query.error.message}</p><button type="button" className="td-related-button" onClick={() => { void query.refetch(); }}>{en ? 'Retry read' : '重试读取'}</button></div>}
  </>;
}

export function TaskBlockersField({ controller: c, en }: DetailProps) {
  const uid = useId();
  const [search, setSearch] = useState('');
  const resolver = useMemo(() => createReferenceResolver(c.accessError ? [] : c.files), [c.accessError, c.files]);
  const workflow = workflowFor('work_item', c.configuration);
  const entity = c.entity;
  if (!entity || entity.entity !== 'work_item' || c.accessError) return <span className="td-related-note">{en ? 'Task source unavailable' : '任务源码不可用'}</span>;
  const ids = entity.blocked_by;
  const editable = c.canEditTaskDraft;
  const query = search.trim().toLocaleLowerCase();
  const candidates = c.files.filter(file => file.entity.entity === 'work_item' && file.id !== entity.id && resolver.resolveId(file.id).file === file && `${file.id} ${file.entity.title} ${file.entity.status ?? ''}`.toLocaleLowerCase().includes(query));
  const diagnostics = c.draftDiagnostics.filter(issue => issue.field === 'blocked_by');
  function change(id: string, checked: boolean) {
    if (!editable) return;
    c.patchTaskDraft({ blocked_by: checked ? [...new Set([...ids, id])] : ids.filter(value => value !== id) });
  }
  return <div className="td-blockers">
    {ids.length > 0 && <ul className="td-blocker-chips" aria-label={en ? 'Selected blocking tasks' : '已选阻塞任务'}>{ids.map(id => {
      const resolved = resolver.resolveId(id);
      const file = resolved.file;
      return <li key={id} className={!file || file.entity.entity !== 'work_item' ? 'td-blocker-missing' : ''}>
        {file ? <button type="button" className="td-blocker-link" onClick={() => c.select(file.id)}><code>{id}</code><span>{file.entity.title}</span><small>{file.entity.entity === 'work_item' ? workflow?.states.find(state => state.id === file.entity.status)?.label || file.entity.status || (en ? 'Status unavailable' : '状态不可用') : en ? 'Not a task' : '不是任务'}</small></button> : <span className="td-blocker-link"><code>{id}</code><small>{resolved.reason === 'ambiguous' ? en ? 'Ambiguous ID' : 'ID 不唯一' : en ? 'Missing or inaccessible' : '缺失或不可访问'}</small></span>}
        {file?.entity.archived && <small className="td-related-note">{en ? 'Archived' : '已归档'}</small>}
        {file && (file.stale || file.error) && <small className="td-related-note">{en ? 'Source diagnostics' : '源码存在诊断'}</small>}
        <button type="button" className="td-blocker-remove" disabled={!editable} aria-label={`${en ? 'Remove blocker' : '移除阻塞项'} ${id}`} onClick={() => change(id, false)}><X size={12} aria-hidden="true" /></button>
      </li>;
    })}</ul>}
    <Popover onOpenChange={open => { if (!open) setSearch(''); }}>
      <PopoverTrigger type="button" className="td-related-button td-blocker-trigger" disabled={!editable} aria-label={en ? 'Choose blocking tasks' : '选择阻塞任务'} aria-describedby={`${uid}-hint`}><GitBranch size={13} aria-hidden="true" />{ids.length ? en ? 'Edit blockers' : '编辑阻塞项' : en ? 'None · choose tasks' : '无 · 选择任务'}</PopoverTrigger>
      <PopoverContent className="td-blockers-picker" aria-labelledby={`${uid}-title`}>
        <h3 id={`${uid}-title`}>{en ? 'Blocked by' : '阻塞项'}</h3>
        <label className="td-blocker-search"><Search size={14} aria-hidden="true" /><span className="sr-only">{en ? 'Search authorized task IDs, titles or status' : '搜索有权访问的任务 ID、标题或状态'}</span><input type="search" autoComplete="off" value={search} placeholder={en ? 'Search tasks…' : '搜索任务…'} onChange={event => setSearch(event.target.value)} /></label>
        <fieldset className="td-blocker-options"><legend className="sr-only">{en ? 'Select multiple blocking tasks' : '选择多个阻塞任务'}</legend>{candidates.map(file => <label key={file.id}><input type="checkbox" checked={ids.includes(file.id)} disabled={!editable || !ids.includes(file.id) && (file.entity.archived || !!file.stale || !!file.error)} onChange={event => change(file.id, event.target.checked)} /><span><strong>{file.entity.title}</strong><small><code>{file.id}</code> · {workflow?.states.find(state => state.id === file.entity.status)?.label || file.entity.status || (en ? 'Status unavailable' : '状态不可用')}{file.entity.archived ? en ? ' · Archived' : ' · 已归档' : ''}{file.stale || file.error ? en ? ' · Source diagnostics' : ' · 源码存在诊断' : ''}</small></span></label>)}</fieldset>
        {candidates.length === 0 && <p className="td-related-note" role="status">{en ? 'No matching authorized tasks.' : '没有匹配且有权访问的任务。'}</p>}
        <p className="td-related-note">{en ? 'Changes stay in this Markdown draft. Existing relation validation checks dependency cycles before saving.' : '修改仅保留在此 Markdown 草稿中，保存前由既有关联校验检查依赖环。'}</p>
      </PopoverContent>
    </Popover>
    <span id={`${uid}-hint`} className="sr-only">{editable ? en ? 'Multiple selection; save the shared Markdown draft to commit.' : '可多选；保存共享 Markdown 草稿后才提交。' : en ? 'Structured editing is read-only until source access, parsing or write restrictions are resolved.' : '解决源码访问、解析或写入限制前，结构化编辑为只读。'}</span>
    {diagnostics.map((issue, index) => <small key={`${issue.code}:${index}`} className="td-related-error" role={issue.severity === 'error' ? 'alert' : 'status'}>{issue.message}</small>)}
  </div>;
}

export function TaskDetailWatch({ controller: c, en }: DetailProps) {
  if (!c.selected || c.selected.entity.entity !== 'work_item' || c.unsupported || c.accessError) return null;
  return <TaskWatchAction key={`${c.session.namespace}:${c.selected.id}`} controller={c} en={en} />;
}

function TaskWatchAction({ controller: c, en }: DetailProps) {
  const personal = usePersonalDashboard();
  const service = usePmService();
  const action = useAction();
  const uid = useId();
  const task = c.selected!;
  const projectId = task.entity.project;
  const watch = personal.data?.watches.find(record => record.data.taskId === task.id);
  const label = watch ? en ? 'Unwatch task' : '取消关注任务' : en ? 'Watch task' : '关注任务';
  const reason = sourceWriteProblem(c, en)
    || (service.error ? en ? 'The PM service is unavailable.' : 'PM 服务当前不可用。' : null)
    || (service.capabilities?.business.enabled !== true ? en ? 'Personal watch commands are unavailable.' : '个人关注命令当前不可用。' : null)
    || (!projectId || !allowed(service.workspace, 'domain.read', projectId) ? en ? 'An accessible saved project is required to watch this task.' : '关注此任务需要可访问的已保存项目。' : null)
    || (action.locked ? en ? 'Check the original pending or unknown PM command before changing your watch.' : '更改关注前，请先核对原先待处理或结果未知的 PM 命令。' : null)
    || (personal.error ? personal.error.message : !personal.data ? en ? 'Loading your personal watch state…' : '正在读取个人关注状态…' : null);
  return <span className="task-detail-watch">
    <button type="button" className="td-watch-button" disabled={!!reason} aria-pressed={personal.data ? !!watch : undefined} aria-label={`${label} ${task.entity.title}`} aria-describedby={`${uid}-state`} title={reason || `${label} · ${en ? 'Watching does not grant access' : '关注不会授予访问权限'}`} onClick={() => {
      if (sourceWriteProblem(c, en) || reason || !projectId) return;
      void action.run(() => action.execute(watch
        ? { commandId: crypto.randomUUID(), commandType: 'UnwatchTask', targetId: watch.id, projectId, expectedVersions: { [watch.id]: watch.version }, payload: {} }
        : { commandId: crypto.randomUUID(), commandType: 'WatchTask', projectId, payload: { taskId: task.id } }));
    }}><Bookmark size={15} fill={watch ? 'currentColor' : 'none'} aria-hidden="true" /><span className="sr-only">{label}</span></button>
    <span id={`${uid}-state`} className="sr-only">{reason || (watch ? en ? 'You are watching selected future saved task changes. Watching does not grant access or replay earlier history.' : '你已关注此任务选定的后续已保存变更。关注不会授予访问权限，也不补发此前历史。' : en ? 'Not currently watched by you. Mentions do not automatically subscribe you.' : '你尚未关注此任务；提及不会自动建立关注。')}</span>
    {(action.localError || personal.error) && <Popover><PopoverTrigger type="button" className="td-watch-error-trigger" aria-label={en ? 'Read personal watch error' : '查看个人关注错误'} title={en ? 'Personal watch error' : '个人关注错误'}><span aria-hidden="true">!</span></PopoverTrigger><PopoverContent className="td-watch-error-popover"><p role="alert">{action.localError || personal.error?.message}</p>{personal.error && <button type="button" className="td-related-button" onClick={() => { void personal.refetch(); }}>{en ? 'Retry watch read' : '重读关注状态'}</button>}</PopoverContent></Popover>}
  </span>;
}

export function TaskDetailRelated({ controller: c, en }: DetailProps) {
  if (!c.entity || c.entity.entity !== 'work_item' || !c.selected || c.unsupported || c.accessError) return null;
  return <div className="task-detail-related">
    <TaskChildren controller={c} en={en} />
    <CommandNotice />
    {c.draft && <p className="td-related-note" role="status">{en ? 'Related service records below use the saved task. Your source draft does not change saved children, attachments or audit history; PM service writes are locked until it is saved or discarded.' : '以下关联服务记录基于已保存任务。源码草稿不会改变已保存的子任务、附件或审计历史；保存或放弃草稿前，PM 服务写入被锁定。'}</p>}
    <TaskServiceSections key={`${c.session.namespace}:${c.selected.id}`} controller={c} en={en} />
    {c.selected.entity.project && <TaskComments key={`${c.selected.id}:${c.selected.entity.project}`} taskId={c.selected.id} projectId={c.selected.entity.project} writable={!sourceWriteProblem(c, en)} />}
  </div>;
}

function TaskChildren({ controller: c, en }: DetailProps) {
  const uid = useId();
  const display = useDisplayDateTime();
  const task = c.selected!;
  const workflow = workflowFor('work_item', c.configuration);
  const children = c.files.filter(file => file.entity.entity === 'work_item' && file.entity.parent === task.id);
  const complete = children.filter(file => statusCategory(file.entity, c.configuration) === 'completed').length;
  const knownProgress = !c.query.error && !c.configurationInvalid && children.every(file => !file.stale && !file.error && !file.diagnostics?.some(issue => issue.severity === 'error') && !!statusCategory(file.entity, c.configuration));
  const createProblem = sourceWriteProblem(c, en);
  return <section className="td-related-section" aria-labelledby={`${uid}-title`}>
    <header className="td-related-heading"><h3 id={`${uid}-title`}>{en ? 'Subtasks' : '子任务'}</h3><span className="td-related-badge">{knownProgress ? `${complete}/${children.length}` : en ? 'Progress unavailable' : '进度不可用'}</span>{knownProgress && children.length > 0 && <progress max={children.length} value={complete} aria-label={en ? `${complete} of ${children.length} child tasks completed` : `${children.length} 个子任务中已完成 ${complete} 个`} />}</header>
    {c.query.error && <p className="td-related-alert" role="alert">{en ? 'The source snapshot could not be refreshed. Child relations below may be stale.' : '源码快照刷新失败，以下子任务关系可能已过期。'}</p>}
    {children.length > 0 ? <ul className="td-child-list">{children.map(file => <li key={file.id}>
      <StatusIcon category={statusCategory(file.entity, c.configuration)} />
      <button type="button" className="td-child-link" onClick={() => c.select(file.id)}><strong>{file.entity.title}</strong><small><code>{file.id}</code> · {workflow?.states.find(state => state.id === file.entity.status)?.label || file.entity.status || (en ? 'Status unavailable' : '状态不可用')}{file.entity.archived ? en ? ' · Archived' : ' · 已归档' : ''}</small>{c.draftIds.has(file.id) && <small>{en ? 'Local source draft · showing saved status' : '存在本地源码草稿 · 显示已保存状态'}</small>}{(file.stale || file.error) && <small className="td-related-error">{en ? 'Source diagnostics · progress may be stale' : '源码存在诊断 · 进度可能过期'}</small>}</button>
      {file.entity.due && <time className="td-child-due" dateTime={file.entity.due}>{display.date(file.entity.due)}</time>}
    </li>)}</ul> : <p className="td-related-note">{en ? 'No visible saved tasks reference this task as their parent.' : '当前没有可见的已保存任务将此任务设为父项。'}</p>}
    <p className="td-related-note">{en ? 'Progress uses saved child workflow states, not Markdown checkboxes. Canceled tasks do not count as completed.' : '进度来自已保存子任务的工作流状态，不是 Markdown 检查项；已取消不计入完成。'}</p>
    {c.canWrite && <div className="td-child-create"><button type="button" className="td-related-button" disabled={!!createProblem || !task.entity.project} title={createProblem || undefined} aria-describedby={`${uid}-create-hint`} onClick={() => { if (!sourceWriteProblem(c, en)) c.openCreate(workflow?.initial, { layout: 'table', entity: 'work_item', project: task.entity.project }); }}><Plus size={14} aria-hidden="true" />{en ? 'Create task' : '创建任务'}</button><small id={`${uid}-create-hint`} className="td-related-note">{en ? `To create a child, choose kind “subtask” and Parent ${task.id} in the shared form’s advanced properties. Nothing is linked automatically.` : `创建子任务时，请在共享表单的高级属性中将类型设为“subtask”，父项设为 ${task.id}；不会自动建立关联。`}</small></div>}
  </section>;
}

function TaskServiceSections({ controller: c, en }: DetailProps) {
  const service = usePmService();
  const task = c.selected!;
  const projectId = task.entity.project;
  if (!service.actor || !service.workspace || service.error || !allowed(service.workspace, 'domain.read', projectId)) return <section className="td-related-section"><h3>{en ? 'Attachments and activity' : '附件与活动'}</h3><p className="td-related-note" role="status">{en ? 'PM service records are unavailable with the current session or project permissions. Source content remains in this shared detail.' : '当前会话或项目权限无法读取 PM 服务记录，源码内容仍保留在此共享详情中。'}</p></section>;
  if (!projectId) return <section className="td-related-section"><h3>{en ? 'Attachments and activity' : '附件与活动'}</h3><p className="td-related-note">{en ? 'Set and save an authorized project to use project-scoped artifacts, comments and business audit.' : '请先设置并保存有权访问的项目，再使用项目范围的成果、评论与业务审计。'}</p></section>;
  return <>
    <TaskAttachments controller={c} en={en} projectId={projectId} />
    <section className="td-related-section"><header className="td-related-heading"><h3>{en ? 'Activity · business audit' : '活动 · 业务审计'}</h3></header>{allowed(service.workspace, 'audit.read', projectId) ? <TaskAudit key={projectId} taskId={task.id} projectId={projectId} en={en} /> : <p className="td-related-note">{en ? 'Project audit.read permission is required. File watcher updates are not task history.' : '读取此项目的活动需要 audit.read 权限；文件监听更新不能代替任务历史。'}</p>}</section>
  </>;
}

function TaskAttachments({ controller: c, en, projectId }: DetailProps & { projectId: string }) {
  const service = usePmService();
  const uid = useId();
  const task = c.selected!;
  const versions = usePmEntities('artifact_version', projectId, 'all');
  const evidence = usePmEntities('evidence', projectId);
  const submissions = usePmEntities('submission', projectId);
  const recordQuery = usePmEntity(task.id);
  const [manageOpen, setManageOpen] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const downloadBusy = useRef(false);
  const referenced = new Map<string, { evidence: string[]; submissions: string[] }>();
  function include(id: string, kind: 'evidence' | 'submissions', sourceId: string) {
    const row = referenced.get(id) ?? { evidence: [], submissions: [] };
    row[kind].push(sourceId);
    referenced.set(id, row);
  }
  evidence.data?.filter(row => strings(row.data.subjectRefs).includes(task.id)).forEach(row => strings(row.data.artifactVersionRefs).forEach(id => include(id, 'evidence', row.id)));
  submissions.data?.filter(row => row.data.workItemId === task.id).forEach(row => strings(row.data.artifactVersionIds).forEach(id => include(id, 'submissions', row.id)));
  const readableVersions = new Map(versions.data?.map(version => [version.id, version]));
  const completeRead = !!versions.data && !!evidence.data && !!submissions.data && !versions.error && !evidence.error && !submissions.error;
  const record = recordQuery.data?.id === task.id && recordQuery.data.kind === 'work_item' && recordQuery.data.workspaceId === service.workspace?.id && recordQuery.data.projectId === projectId ? recordQuery.data : undefined;
  const sourceProblem = sourceWriteProblem(c, en);
  const storageProblem = service.capabilities?.business.enabled !== true || !service.capabilities.storage.enabled;
  const managementProblem = sourceProblem || (storageProblem ? en ? 'Real artifact storage or business commands are unavailable.' : '真实成果存储或业务命令当前不可用。' : null) || (recordQuery.error || !record ? en ? 'An accessible current PM task record is required for artifact management.' : '管理成果需要可访问且有效的当前 PM 任务记录。' : null);
  async function download(version: BusinessEntity) {
    if (downloadBusy.current || !service.workspace || !allowed(service.workspace, 'domain.read', projectId)) return;
    downloadBusy.current = true;
    setDownloading(version.id);
    setDownloadError(null);
    try { await downloadProjectAttachment(service.client, service.workspace.id, version); }
    catch (error) { setDownloadError(error instanceof Error ? error.message : String(error)); }
    finally { downloadBusy.current = false; setDownloading(null); }
  }
  return <section className="td-related-section" aria-labelledby={`${uid}-title`}>
    <header className="td-related-heading"><h3 id={`${uid}-title`}>{en ? 'Attachments / evidence' : '附件 / 证据'}</h3>{completeRead && <span className="td-related-badge">{referenced.size}</span>}</header>
    <p className="td-related-note">{en ? 'Only immutable artifact versions referenced by this task’s evidence or submissions are shown. Project uploads alone are not task attachments.' : '仅显示此任务的证据或提交实际引用的不可变成果版本；仅上传到项目的文件不会被当作任务附件。'}</p>
    <ReadNotice query={versions} en={en} label={en ? 'artifact versions' : '成果版本'} /><ReadNotice query={evidence} en={en} label={en ? 'task evidence' : '任务证据'} /><ReadNotice query={submissions} en={en} label={en ? 'task submissions' : '任务提交'} />
    {referenced.size > 0 && <ul className="td-attachment-list">{Array.from(referenced, ([id, sources]) => {
      const version = readableVersions.get(id);
      return <li key={id}><FileText size={17} aria-hidden="true" /><div className="td-attachment-info"><strong>{version ? string(version.data.fileName) || id : id}</strong><small>{version ? typeof version.data.size === 'number' ? `${version.data.size.toLocaleString()} ${en ? 'bytes' : '字节'}` : en ? 'Size unavailable' : '大小不可用' : en ? 'Version missing or inaccessible; no file contents were loaded.' : '版本缺失或不可访问，未读取文件内容。'}</small><details><summary>{en ? 'Provenance' : '引用来源'}</summary><code>{id}</code>{sources.evidence.length > 0 && <p>{en ? 'Evidence' : '证据'}: {sources.evidence.join(', ')}</p>}{sources.submissions.length > 0 && <p>{en ? 'Submissions' : '提交'}: {sources.submissions.join(', ')}</p>}{version && <p>SHA-256: {string(version.data.sha256) || '—'}</p>}</details></div>{version && <button type="button" className="td-related-button" disabled={!!downloading || !!versions.error} aria-label={`${en ? 'Download' : '下载'} ${string(version.data.fileName) || id}`} onClick={() => { void download(version); }}><Download size={14} aria-hidden="true" /><span className="sr-only">{en ? 'Download' : '下载'}</span></button>}</li>;
    })}</ul>}
    {completeRead && referenced.size === 0 && <p className="td-related-note">{en ? 'No artifact versions are linked to this task through evidence or submissions.' : '此任务尚未通过证据或提交关联成果版本。'}</p>}
    {downloading && <p className="td-related-note" role="status">{en ? 'Downloading…' : '正在下载…'}</p>}{downloadError && <p className="td-related-error" role="alert">{downloadError}</p>}
    <details className="td-related-management" onToggle={event => setManageOpen(event.currentTarget.open)}><summary>{en ? 'Delivery / evidence · manage uploads and artifacts' : '交付 / 证据 · 管理上传与成果'}</summary><p className="td-related-note">{en ? 'Uses the existing delivery workflow: staging, artifact registration and linking via evidence or a submission are distinct explicit operations. Uploading does not automatically attach a file to this task. Markdown fields and the explicit shared draft Save remain task authority; PM commands retain their own receipts.' : '复用既有交付流程：暂存、成果登记、通过证据或提交建立关联是不同的显式操作。上传不会自动附加到此任务；Markdown 字段与共享草稿的显式保存仍是任务权威，PM 命令使用各自独立的收据。'}</p>{manageOpen && <>
      <ReadNotice query={recordQuery} en={en} label={en ? 'saved PM task' : '已保存 PM 任务'} />
      {managementProblem && <p className="td-related-note" role="status">{managementProblem}</p>}
      {record && <fieldset disabled={!!managementProblem} className="td-delivery-controls"><legend className="sr-only">{en ? 'Existing delivery workflow' : '既有交付流程'}</legend><DeliveryWorkflow key={`${task.id}:${record.version}`} item={record} /></fieldset>}
    </>}</details>
  </section>;
}

function TaskAudit({ taskId, projectId, en }: { taskId: string; projectId: string; en: boolean }) {
  const query = useProjectAudit(projectId);
  const display = useDisplayDateTime();
  const entries = query.data?.pages.flatMap(page => page.entries).filter(entry => entry.targetKind === 'work_item' && entry.targetId === taskId) ?? [];
  return <div className="td-task-audit">
    <p className="td-related-note">{en ? 'Actual controlled-write audit for this task, including native core requests when recorded. It is not a complete Markdown edit history; external edits and old actions are not reconstructed.' : '显示此任务真实的受控写入审计（包含已记录的原生核心请求），不是完整 Markdown 编辑历史；不会补造外部编辑或旧操作。'}</p>
    <ReadNotice query={query} en={en} label={en ? 'task business audit' : '任务业务审计'} />
    {query.data && entries.length === 0 && <p className="td-related-note">{query.hasNextPage ? en ? 'No task entries in the loaded project audit pages. Earlier project pages may contain more.' : '已加载的项目审计页中没有此任务的记录，较早页面可能仍有记录。' : en ? 'No visible recorded audit entries for this task.' : '此任务暂无可见的已记录审计。'}</p>}
    {entries.length > 0 && <ol className="td-audit-list">{entries.map(entry => <li key={entry.id}><div className="td-audit-line"><strong>{entry.action}</strong><time dateTime={entry.occurredAt}>{display.dateTime(entry.occurredAt)}</time></div><p className="td-related-note">{en ? 'Actor' : '操作者'}: <code>{entry.actorId}</code> · {entry.source === 'core_http' ? en ? 'Native core API' : '原生核心 API' : en ? 'PM command' : 'PM 命令'}</p><details><summary>{en ? 'Recorded change details' : '已记录的变更详情'}</summary><p>{en ? 'Version' : '版本'}: <code>{entry.beforeVersion ?? '∅'}</code> → <code>{entry.afterVersion ?? '∅'}</code></p>{entry.changes.length > 0 ? <dl>{entry.changes.map(change => <div key={change.field}><dt>{change.field}</dt><dd>{change.before === null ? '∅' : String(change.before)} → {change.after === null ? '∅' : String(change.after)}</dd></div>)}</dl> : <p className="td-related-note">{en ? 'No public allowlisted field diff was recorded. Content is not included.' : '此次没有可公开的白名单字段差异，内容未记录。'}</p>}<p>{entry.source === 'core_http' ? en ? 'Native request' : '原生请求' : en ? 'PM command' : 'PM 命令'}: <code>{entry.commandId}</code></p></details></li>)}</ol>}
    <div className="td-audit-actions"><button type="button" className="td-related-button" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>{en ? 'Refresh activity' : '刷新活动'}</button>{query.hasNextPage && <button type="button" className="td-related-button" disabled={query.isFetching} onClick={() => { void query.fetchNextPage(); }}>{query.isFetchingNextPage ? en ? 'Loading earlier project audit…' : '正在读取较早项目审计…' : en ? 'Load earlier project audit' : '加载较早项目审计'}</button>}</div>
  </div>;
}
