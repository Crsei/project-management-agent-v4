import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AlertTriangle, Braces, CalendarDays, ChevronDown, CircleHelp, Columns3, FileText, Folder, GitBranch, List, ListFilter, LoaderCircle, Network, PanelLeft, Plus, Save, Search, Settings2, Table2, X } from 'lucide-react';
import { entityDefinitions, entityKinds, workflowFor, type EntityKind, type FileRecord, type ProtocolConfiguration, type SavedView, type ViewConfig } from '@pm-schema';
import { PMView, documentKindLabels, priorities, type ArchiveFilter } from '@pm-views';
import { useWorkspaceController, type CollectionLayout, type ControllerOptions, type Preferences } from './controller';
import { useDetailState } from './session';
import { EntityDetail } from './EntityDetail';
import { Diagnostics } from './Diagnostics';
import { ConfigurationEditor, MigrationEditor } from './WorkspaceEditors';
import { WorkspaceDialogs } from './WorkspaceDialogs';
import { TaskCollectionView } from './TaskCollectionView';
import TaskCollectionControls from './TaskCollectionControls';
import type { TaskScope } from './task-collection-model';
import { CommandNotice } from '../service/pm-ui';
import personalStyles from './task-personal-chrome.module.css';
import { DocumentSources, useDocumentSourceCatalog } from './DocumentSources';

import type { DocumentSort, DocumentSourceFilter, DocumentTypeFilter } from './document-collection-model';
import { DocumentCollection } from './DocumentCollection';
import { ExternalDocumentManagementDialog } from './ExternalDocumentEditor';
import type { ExternalManagementIntent } from './external-document-state';
import type { DocumentTarget } from './document-workbench-state';
import { FilterCard } from '@/components/blocks/filter-card';
import type { FilterCondition, FilterField } from '@/lib/filter-model';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { RadixSelect } from "@/components/ui/radix-select"

export type SettingsSection = 'configuration' | 'migrations' | 'diagnostics';
export interface CollectionContext { preferences: Preferences; search: string; view: ViewConfig | null; activeView?: SavedView; advancedSplit: boolean; explorerOpen: boolean; filtersOpen: boolean }
export interface ScheduleViewProps {
  files: FileRecord[];
  layout: 'calendar' | 'gantt';
  contextFiles?: readonly FileRecord[];
  configuration?: ProtocolConfiguration;
  projectId?: string;
  toolbarTarget?: HTMLElement | null;
  onSelect: (id: string) => void;
  onPatch: (id: string, changes: Record<string, unknown>) => Promise<void>;
  canEdit: (id: string) => boolean;
  onCreate?: (due: string) => void;
}
export interface WorkspaceProps extends ControllerOptions {
  mode: 'collection' | 'entity' | 'settings';
  settingsSection: SettingsSection;
  en: boolean;
  collectionContext?: CollectionContext;
  onContextRestored: () => void;
  onExpand: (context: CollectionContext) => void;
  onClose: () => void;
  onSettings: (section: SettingsSection) => void;
  onPresentation: (layout: CollectionLayout) => void;
  onSavedView: (id: string) => void;
  onScope: (scope: TaskScope) => void;
  onRetryPersonal: () => void;
  onNewPage: (project?: string) => void;
  onExpandCreation: (draftId: string) => void;

  onDocumentScope: (projectId?: string) => void;
  onOpenDocument: (target: DocumentTarget, options?: { replace?: boolean; anchor?: string }) => void;
  renderSchedule: (props: ScheduleViewProps) => ReactNode;
  renderBusiness: (file: FileRecord) => ReactNode;
}
const kindLabels: Record<EntityKind, string> = { project: '项目', work_item: '工作项', document: '文档', cycle: '迭代', milestone: '里程碑', module: '模块', requirement: '需求', release: '发布', goal: '目标' };
const layouts = [
  { id: 'list', en: 'List', zh: '列表', Icon: List }, { id: 'kanban', en: 'Board', zh: '看板', Icon: Columns3 },
  { id: 'table', en: 'Table', zh: '表格', Icon: Table2 }, { id: 'calendar', en: 'Calendar', zh: '日历', Icon: CalendarDays },
  { id: 'gantt', en: 'Gantt', zh: '甘特图', Icon: GitBranch }, { id: 'tree', en: 'Tree', zh: '树形', Icon: GitBranch },
  { id: 'graph', en: 'Graph', zh: '关系图', Icon: Network },
] as const;
const scopeLabels: Record<TaskScope, { en: string; zh: string }> = { all: { en: 'All tasks', zh: '全部任务' }, mine: { en: 'My Tasks', zh: '我的任务' }, important: { en: 'Important / Watching', zh: '重要 / 我关注的' } };
export default function Workspace(props: WorkspaceProps) {
  const c = useWorkspaceController(props);
  const { en, mode } = props;
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [advancedSplit, setAdvancedSplit] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [documentSettingsOpen, setDocumentSettingsOpen] = useState(false);
  const [documentSourceFilter, setDocumentSourceFilter] = useState<DocumentSourceFilter>('all');
  const [documentTypeFilter, setDocumentTypeFilter] = useState<DocumentTypeFilter>('all');
  const [documentSort, setDocumentSort] = useState<DocumentSort>('updated');
  const [externalManagement, setExternalManagement] = useState<ExternalManagementIntent | null>(null);
  const documentCollection = mode === 'collection' && props.entityKind === 'document';
  const documentCatalog = useDocumentSourceCatalog(documentCollection, props.projectId, en);
  const externalAvailable = documentCatalog.status === 'ready' && documentCatalog.collectionSources.some(source => source.status === 'available');
  const [toolbarTarget, setToolbarTarget] = useState<HTMLElement | null>(null);
  const [graphScopeTarget, setGraphScopeTarget] = useState<HTMLElement | null>(null);
  const [graphToggleTarget, setGraphToggleTarget] = useState<HTMLElement | null>(null);
  const [, setDetail] = useDetailState();
  const bodyRef = useRef<HTMLDivElement>(null);
  const restoredContext = useRef(false);
  useEffect(() => {
    if (mode === 'collection' && props.collectionContext && !restoredContext.current) {
      restoredContext.current = true;
      if (props.projectId && props.collectionContext.preferences.project !== props.projectId) { props.onContextRestored(); return; }
      if (props.collectionContext.view) c.useView(props.collectionContext.view, props.collectionContext.activeView); else c.clearView();
      c.setPrefs(props.collectionContext.preferences); c.setSearch(props.collectionContext.search);
      setAdvancedSplit(!!props.collectionContext.advancedSplit); setExplorerOpen(!!props.collectionContext.explorerOpen); setFiltersOpen(!!props.collectionContext.filtersOpen);
      props.onContextRestored();
    }
  }, [mode, props.collectionContext]);
  useEffect(() => {
    if (advancedSplit && c.selectedId) setDetail({ tab: 'source', entityId: c.selectedId });
  }, [advancedSplit, c.selectedId, setDetail]);
  const openingDocument = mode !== 'settings' && c.selected?.entity.entity === 'document' && !c.unsupported && (!props.projectId || c.selected.entity.project === props.projectId);
  useEffect(() => {
    if (openingDocument) props.onOpenDocument({ kind: 'native', id: c.selectedId }, { replace: true });
  }, [openingDocument, c.selectedId, props.onOpenDocument]);
  if (c.accessError || (c.query.isError && !c.query.data)) return <div className="loading-screen" role="alert"><AlertTriangle size={28} /><h2>{en ? 'Workspace unavailable' : '工作区不可用'}</h2><p>{(c.accessError || c.query.error)?.message}</p><button className="primary-button" onClick={() => void c.refresh()}>{en ? 'Retry connection' : '重试连接'}</button></div>;
  if (c.query.isPending) return <div className="loading-screen" role="status"><LoaderCircle size={24} className="spin" /><p>{en ? 'Loading workspace…' : '正在加载工作区…'}</p></div>;
  if (props.projectId && c.selectedId && (c.unsupported || !c.selected || (c.selected.entity.entity === 'project' ? c.selected.id : c.selected.entity.project) !== props.projectId)) return <section className="loading-screen" role="alert"><AlertTriangle size={28} /><h2>{en ? 'Entity unavailable in this project' : '此项目中无法访问该对象'}</h2><p>{en ? 'The source does not belong to this project, is missing, or its project cannot be verified. No unrelated source is shown.' : '对象不属于此项目、已不可用，或无法确认其项目；不会展示其他项目的源码。'}</p><button className="secondary-button" onClick={props.onClose}>{en ? 'Back to project tasks' : '返回项目任务'}</button></section>;
  if (openingDocument) return <div className="loading-screen" role="status"><LoaderCircle size={24} className="spin" /><p>{en ? 'Opening document workbench…' : '正在打开文档工作台…'}</p></div>;
  const explorerFiles = props.projectId ? c.files.filter(file => (file.entity.entity === 'project' ? file.id : file.entity.project) === props.projectId) : c.files;
  const selected = !!c.selectedId;
  const taskInspector = c.selected?.entity.entity === 'work_item' && !c.unsupported;
  const timeline = mode === 'collection' && !!props.taskContext && c.prefs.layout === 'gantt';
  const personal = mode === 'collection' && !props.projectId && props.taskContext?.scope === 'mine'
    ? { today: props.taskContext.today, actorId: props.taskContext.actorId } : undefined;
  const personalChrome = !!personal && (c.prefs.layout === 'list' || c.prefs.layout === 'calendar');
  const collectionTitle = props.taskContext
    ? props.taskContext.scope !== 'all' ? scopeLabels[props.taskContext.scope][en ? 'en' : 'zh']
      : c.prefs.layout === 'calendar' ? (props.projectId ? en ? 'Project calendar' : '项目日历' : en ? 'Workspace calendar' : '工作区日历')
        : c.prefs.layout === 'gantt' ? (props.projectId ? en ? 'Project timeline' : '项目时间线' : en ? 'Workspace timeline' : '工作区时间线')
          : props.projectId ? en ? 'Project tasks' : '项目任务' : en ? 'Workspace tasks' : '工作区任务'
    : c.prefs.entity ? (en ? c.prefs.entity === 'cycle' ? 'Sprints' : `${entityDefinitions[c.prefs.entity].label}s` : kindLabels[c.prefs.entity]) : (en ? 'All entities' : '全部对象');
  const filterStates = [...new Map((c.prefs.entity ? [c.prefs.entity] : entityKinds).flatMap(kind => workflowFor(kind, c.configuration)?.states || []).map(state => [state.id, state] as const)).values()];
  const filterFields: FilterField[] = [
    { id: 'entity', label: en ? 'Entity' : '对象类型', single: true, options: entityKinds.map(kind => ({ value: kind, label: en ? kind === 'cycle' ? 'Sprint (cycle)' : entityDefinitions[kind].label : kindLabels[kind] })) },
    { id: 'priority', label: en ? 'Priority' : '优先级', single: true, options: priorities.map(priority => ({ value: priority, label: priority })) },
    { id: 'status', label: en ? 'Status' : '状态', single: true, options: filterStates.map(state => ({ value: state.id, label: state.label })) },
  ];
  const filterConditions: FilterCondition[] = [
    ...(c.prefs.entity ? [{ field: 'entity', operator: 'is' as const, values: [c.prefs.entity] }] : []),
    ...(c.prefs.priority ? [{ field: 'priority', operator: 'is' as const, values: [c.prefs.priority] }] : []),
    ...(c.prefs.status ? [{ field: 'status', operator: 'is' as const, values: [c.prefs.status] }] : []),
  ];
  // Entity, priority and status are single-valued preferences, so rows are applied as positive `is` matches.
  const updateFilters = (next: FilterCondition[]) => {
    const desired = new Map<string, string>();
    for (const condition of next) { const value = condition.values[0]; if (value) desired.set(condition.field, value); }
    const entity = (desired.get('entity') || '') as EntityKind | '';
    if (entity !== c.prefs.entity) { c.clearView(); props.onSavedView(''); c.preference('entity', entity); }
    const priority = desired.get('priority') || '';
    if (priority !== c.prefs.priority) c.preference('priority', priority);
    const status = desired.get('status') || '';
    if (status !== c.prefs.status) c.preference('status', status);
  };
  const sortFields = ['id', 'title', ...(c.prefs.entity === 'work_item' || c.prefs.entity === 'requirement' ? ['priority'] : []), ...(c.prefs.entity && c.prefs.entity !== 'document' ? ['status'] : [])];
  return <div className={`native-workbench native-workbench-${mode}${mode === 'collection' && selected && !documentCollection ? ' is-inspecting' : ''}${timeline ? ' task-timeline-workbench' : ''}${personalChrome ? ` ${personalStyles.workbench}` : ''}`} data-task-scope={props.taskContext?.scope} data-task-layout={props.taskContext ? c.prefs.layout : undefined} data-task-project={props.projectId || undefined} data-entity-kind={mode === 'collection' ? props.entityKind || 'all' : undefined} data-document-source-view={documentCollection ? 'unified' : undefined}>
    {(c.error || c.query.isError) && <div className="error-banner" role="alert"><AlertTriangle size={15} /><span>{c.error || c.query.error?.message}</span><button className="icon-button" aria-label={en ? 'Dismiss error' : '关闭错误'} onClick={() => { c.setError(''); c.setRequestDiagnostics([]); }}><X size={14} /></button></div>}
    <Diagnostics diagnostics={c.requestDiagnostics} />
    {(c.session.drafts.persistenceError() || c.session.creationDrafts.persistenceError()) && <p className="inline-error" role="alert">{en ? 'Browser draft recovery is unavailable. Current drafts remain in memory; keep this tab open until saved or recovery storage is restored.' : '浏览器草稿恢复存储不可用。当前草稿仍在内存中，请保留此标签页，直至保存或恢复浏览器存储。'}</p>}
    {c.configurationInvalid && <div className="inline-error" role="alert">{en ? 'Configuration is invalid. Writes are blocked; local drafts are preserved.' : '配置无效，写入已暂停，本地草稿仍予以保留。'} <button data-testid="open-configuration" onClick={() => props.onSettings('configuration')}>{en ? 'Repair configuration' : '修复配置'}</button></div>}
    {!c.canWrite && <p className="readonly-notice" role="status">{en ? 'Source editing is read only. Business actions follow their own permissions.' : '源码编辑为只读，业务操作遵循各自的权限。'}</p>}
    {mode === 'settings' ? <section className="core-settings">
      <div className="collection-heading"><div><h1>{en ? 'Workspace settings' : '工作区设置'}</h1></div></div>
      <div className="settings-tabs" role="tablist" aria-label={en ? 'Workspace settings sections' : '工作区设置分区'}>{(['configuration', 'migrations', 'diagnostics'] as const).map(section => <button key={section} role="tab" aria-selected={props.settingsSection === section} className={props.settingsSection === section ? 'active' : ''} data-testid={`open-${section}`} onClick={() => props.onSettings(section)}>{section === 'configuration' ? (en ? 'Workflows & fields' : '工作流与字段') : section === 'migrations' ? (en ? 'Migrations & backups' : '迁移与备份') : (en ? 'Diagnostics' : '诊断')}</button>)}</div>
      <div className="settings-body">
        <div hidden={props.settingsSection !== 'configuration'}><fieldset disabled={!c.canWrite}><ConfigurationEditor configuration={c.configuration} revision={c.query.data?.configurationRevision || 'absent'} diagnostics={c.query.data?.configurationErrors || []} onSaved={() => void c.refresh()} onError={c.handleAccessError} /></fieldset></div>
        <div hidden={props.settingsSection !== 'migrations'}><fieldset disabled={!c.canWrite}><MigrationEditor onChanged={() => void c.refresh()} onError={c.handleAccessError} /></fieldset></div>
        <div hidden={props.settingsSection !== 'diagnostics'} className="diagnostics-page"><h2>{en ? 'Workspace source diagnostics' : '工作区源码诊断'}</h2><p className="muted">{en ? 'Warnings do not block saving. Invalid configuration, unknown protocols and revision conflicts retain their repair protections.' : '警告不会阻止保存。无效配置、未知协议和版本冲突始终受修复保护。'}</p><Diagnostics diagnostics={[...(c.query.data?.configurationErrors || []), ...(c.query.data?.errors || [])]} />{!c.query.data?.errors.length && !c.query.data?.configurationErrors.length && <p>{en ? 'No workspace diagnostics.' : '暂无工作区诊断。'}</p>}{c.files.filter(file => file.stale || file.diagnostics?.length).map(file => <button key={file.id} className="diagnostic-source" onClick={() => { setDetail({ tab: 'source', entityId: file.id }); c.select(file.id); }}><AlertTriangle size={14} />{file.id} · {file.path}</button>)}{c.unsupportedFiles.map(file => <button key={file.path} className="diagnostic-source" onClick={() => c.select(`source:${file.path}`)}><FileText size={14} />{file.path} · {en ? 'Read only' : '只读'}</button>)}<button className="secondary-button" onClick={() => void c.refresh()}>{en ? 'Refresh diagnostics' : '刷新诊断'}</button><h3>{en ? 'Synchronization' : '同步状态'}</h3><p>{c.connection} · {c.files.length + c.unsupportedFiles.length} {en ? 'source files' : '个源码文件'} · {c.draftIds.size} {en ? 'local drafts' : '个本地草稿'}</p>{c.activity.map((entry, index) => <p className="activity-entry" key={index}>{entry}</p>)}</div>
      </div>
    </section> : mode === 'entity' ? <EntityDetail controller={c} en={en} fullPage onClose={props.onClose} renderBusiness={props.renderBusiness} /> : <>
      {c.writesBlocked && <><CommandNotice /><p className="readonly-notice" role="status">{en ? 'A write is pending or its result is unknown. Resolve its original native attempt or PM command receipt before another write.' : '有写入待确认或结果未知。请先核对原生创建请求或原 PM 命令收据，再进行其他写入。'}</p></>}
      {props.taskContext ? <TaskCollectionControls controller={c} en={en} projectId={props.projectId} taskContext={props.taskContext} title={collectionTitle} filtersOpen={filtersOpen} onFiltersOpenChange={setFiltersOpen} explorerOpen={explorerOpen} onExplorerOpenChange={setExplorerOpen} advancedSplit={advancedSplit} onAdvancedSplitChange={open => { setAdvancedSplit(open); if (open) setDetail({ tab: 'source' }); }} onHelp={() => setHelpOpen(true)} onNewPage={props.onNewPage} onScope={props.onScope} onPresentation={props.onPresentation} onSavedView={props.onSavedView} onToolbarTargetChange={setToolbarTarget} onGraphScopeTargetChange={setGraphScopeTarget} onGraphToggleTargetChange={setGraphToggleTarget} /> : <>
        <div className="collection-heading"><div><h1>{collectionTitle}</h1></div><div className="collection-heading-actions"><button className={`icon-button ${explorerOpen ? 'active' : ''}`} aria-label={en ? 'Toggle file explorer' : '切换文件浏览器'} title={en ? 'File explorer' : '文件浏览器'} onClick={() => setExplorerOpen(value => !value)}><PanelLeft size={18} /></button><button className="icon-button" aria-label={en ? 'Workspace help' : '工作区帮助'} onClick={() => setHelpOpen(true)}><CircleHelp size={18} /></button>{!documentCollection && <button className="primary-button" data-testid="new-task" aria-label={en ? 'New entity' : '新建对象'} disabled={c.configurationInvalid || !!c.busy || !c.canWrite} onClick={() => c.openCreate(workflowFor(c.prefs.entity || 'work_item', c.configuration)?.initial)}><Plus size={15} />{en ? 'New entity' : '新建对象'}</button>}{documentCollection && <button type="button" className="secondary-button document-source-settings-entry" onClick={() => setDocumentSettingsOpen(true)}><Settings2 size={15} />{en ? 'Document source settings' : '文档来源设置'}</button>}</div></div>
        {documentCollection && <DocumentSources projectId={props.projectId} filterProjectId={c.prefs.project || undefined} catalog={documentCatalog} settingsOpen={documentSettingsOpen} en={en} onScope={props.onDocumentScope} onSettingsOpen={() => setDocumentSettingsOpen(true)} onSettingsClose={() => setDocumentSettingsOpen(false)} onManage={setExternalManagement} onOpen={props.onOpenDocument} />}
        <div className="collection-toolbar">
          {documentCollection ? <>
            <RadixSelect aria-label={props.projectId ? en ? 'Fixed project' : '固定项目' : en ? 'Project filter' : '项目筛选'} value={c.prefs.project} disabled={!!props.projectId} onChange={event => c.preference('project', event.target.value)}><option value="">{en ? 'All projects' : '全部项目'}</option>{c.prefs.project && !c.projects.some(file => file.id === c.prefs.project) && <option value={c.prefs.project}>{en ? 'Project unavailable' : '项目不可用'} · {c.prefs.project}</option>}{c.projects.map(file => <option key={file.id} value={file.id}>{file.entity.title}</option>)}</RadixSelect>
            {!props.projectId && c.prefs.project && <button className="text-button" type="button" onClick={() => c.preference('project', '')}>{en ? 'Clear project filter' : '清除项目筛选'}</button>}
            <RadixSelect aria-label={en ? 'Document type' : '文档类型'} value={documentTypeFilter} onChange={event => { const value = event.target.value; if (value === 'all' || value === 'work_item' || value === 'external' || ['note', 'design', 'decision', 'specification'].includes(value)) setDocumentTypeFilter(value as DocumentTypeFilter); }}>
              <option value="all">{en ? 'All types' : '全部类型'}</option>
              <option value="work_item">{en ? 'Task' : '任务'}</option>
              {(['note', 'design', 'decision', 'specification'] as const).map(kind => <option key={kind} value={kind}>{documentKindLabels[kind][en ? 'en' : 'zh']}</option>)}
              <option value="external" disabled={!externalAvailable}>{en ? 'External documents' : '外部文档'}</option>
            </RadixSelect>
            <RadixSelect aria-label={en ? 'Document source' : '文档来源'} value={documentSourceFilter} onChange={event => { const value = event.target.value; if (value === 'all' || value === 'native' || value === 'external') setDocumentSourceFilter(value); }}>
              <option value="all">{en ? 'All sources' : '全部来源'}</option>
              <option value="native">{en ? 'PM documents' : 'PM文档'}</option>
              <option value="external" disabled={!externalAvailable}>{en ? 'External documents' : '外部文档'}</option>
            </RadixSelect>
            <RadixSelect aria-label={en ? 'Document sort' : '文档排序'} value={documentSort} onChange={event => { const value = event.target.value; if (value === 'updated' || value === 'title') setDocumentSort(value); }}>
              <option value="updated">{en ? 'Recently updated' : '最近更新'}</option>
              <option value="title">{en ? 'Document name' : '文档名称'}</option>
            </RadixSelect>
          </> : <><RadixSelect aria-label={props.projectId ? en ? 'Fixed project' : '固定项目' : en ? 'Project filter' : '项目筛选'} value={c.prefs.project} disabled={!!props.projectId} onChange={event => c.preference('project', event.target.value)}><option value="">{en ? 'All projects' : '全部项目'}</option>{c.prefs.project && !c.projects.some(file => file.id === c.prefs.project) && <option value={c.prefs.project}>{en ? 'Project unavailable' : '项目不可用'} · {c.prefs.project}</option>}{c.projects.map(file => <option key={file.id} value={file.id}>{file.entity.title}</option>)}</RadixSelect>{!props.projectId && c.prefs.project && <button className="text-button" type="button" onClick={() => c.preference('project', '')}>{en ? 'Clear project filter' : '清除项目筛选'}</button>}</>}
          <label className="collection-search"><Search size={14} /><input aria-label={documentCollection ? (en ? 'Search documents' : '搜索文档') : 'Search work items'} value={c.search} onChange={event => c.setSearch(event.target.value)} placeholder={documentCollection ? (en ? 'Search documents…' : '搜索文档…') : (en ? 'Search entities…' : '搜索对象…')} /><kbd>/</kbd></label>
          {!documentCollection && <Popover open={filtersOpen} onOpenChange={setFiltersOpen}><PopoverTrigger render={<button type="button" className={`secondary-button ${filtersOpen ? 'active' : ''}`} data-testid="view-filters" aria-expanded={filtersOpen} />}><ListFilter size={14} aria-hidden="true" />{en ? 'Filters' : '筛选'}</PopoverTrigger><PopoverContent align="start" side="bottom" style={{ width: 'min(400px, calc(100vw - 2rem))' }}><FilterCard title={en ? 'Filters' : '筛选'} fields={filterFields} conditions={filterConditions} onChange={updateFilters} emptyHint={en ? 'No filters yet. Add an entity, priority or status condition.' : '暂无筛选条件。可添加对象类型、优先级或状态。'} addLabel={en ? 'Add' : '添加'} clearLabel={en ? 'Clear' : '清除'} whereLabel={en ? 'Where' : '条件'} andLabel={en ? 'and' : '且'} anyLabel={en ? 'Any' : '任意'} removeLabel={en ? 'Remove filter' : '移除筛选'} footer={<div style={{ display: 'grid', gap: 6, inlineSize: '100%' }}><label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted-foreground)' }}>{en ? 'Sort' : '排序'}<RadixSelect aria-label="Sort items" value={c.prefs.sort} onChange={event => c.preference('sort', event.target.value)} style={{ flex: 1 }}>{sortFields.map(field => <option key={field}>{field}</option>)}</RadixSelect></label><label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted-foreground)' }}>{en ? 'Archive' : '归档'}<RadixSelect aria-label="Archive filter" data-testid="archive-filter" value={c.prefs.archived} onChange={event => c.preference('archived', event.target.value as ArchiveFilter)} style={{ flex: 1 }}><option value="exclude">{en ? 'Active objects' : '活动对象'}</option><option value="include">{en ? 'Include archived' : '包含归档'}</option><option value="only">{en ? 'Archived only' : '仅归档'}</option></RadixSelect></label>{!documentCollection && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}><button className="secondary-button" data-testid="save-view" onClick={() => { setFiltersOpen(false); c.setSaveViewOpen(true); }}><Save size={13} aria-hidden="true" />{en ? 'Edit / save view' : '编辑 / 保存视图'}</button><button className="text-button" onClick={() => { c.clearView(); props.onSavedView(''); }}>{en ? 'Clear query' : '清除查询'}</button></div>}</div>} /></PopoverContent></Popover>}
          {!documentCollection && <button className={`secondary-button ${advancedSplit ? 'active' : ''}`} aria-pressed={advancedSplit} onClick={() => { setAdvancedSplit(value => !value); if (!advancedSplit) setDetail({ tab: 'source' }); }}><Columns3 size={14} />{en ? 'Advanced split' : '高级分栏'}</button>}
        </div>
        {!documentCollection && <div className="collection-view-toolbar"><div className="view-tabs" aria-label={en ? 'Collection layouts' : '集合布局'}>{layouts.map(({ id, en: english, zh, Icon }) => <button key={id} className={c.prefs.layout === id ? 'active' : ''} aria-pressed={c.prefs.layout === id} data-testid={`tab-${id}`} onClick={() => { c.preference('layout', id); props.onPresentation(id); }}><Icon size={14} />{en ? english : zh}</button>)}</div><RadixSelect aria-label="Saved view" value={c.activeView?.id || ''} onChange={event => { const view = c.query.data?.views.find(item => item.id === event.target.value); if (view) c.useView(view, view); else c.clearView(); props.onSavedView(event.target.value); }}><option value="">{en ? 'Unsaved view' : '未保存视图'}</option>{c.query.data?.views.map(view => <option key={view.id} value={view.id}>{view.name}</option>)}</RadixSelect><button className="icon-button" aria-label={en ? 'Edit full view query' : '编辑完整视图查询'} data-testid="edit-view-query" onClick={() => c.setSaveViewOpen(true)}><Braces size={17} /></button></div>}
        {c.prefs.entity === 'work_item' && c.prefs.layout === 'kanban' && <div className="task-board-group"><label>{en ? 'Board grouping' : '看板分组'} <RadixSelect aria-label={en ? 'Board grouping' : '看板分组'} value={c.config.group_by || 'status'} onChange={event => c.preference('groupBy', event.target.value === 'priority' ? 'priority' : 'status')}><option value="status">{en ? 'Workflow status' : '工作流状态'}</option><option value="priority">{en ? 'Priority (drag changes priority only)' : '优先级（拖动只修改优先级）'}</option>{c.config.group_by && !['status', 'priority'].includes(c.config.group_by) && <option value={c.config.group_by}>{en ? 'Saved field:' : '保存的字段：'} {c.config.group_by}</option>}</RadixSelect></label></div>}
      </>}
      {c.matchingResult.error && <div className="inline-error" role="alert">{en ? 'Invalid view' : '视图无效'}: {c.matchingResult.error} <button onClick={() => c.setSaveViewOpen(true)}>{en ? 'Edit view query' : '编辑视图查询'}</button></div>}
      {c.scopeError && <div className="inline-error" role="alert"><p>{en ? 'Personal task scope could not be read. This is not an empty list.' : '无法读取个人任务范围，这不代表任务为空。'} {c.scopeError}</p><button onClick={props.onRetryPersonal}>{en ? 'Retry personal data' : '重试个人数据'}</button></div>}
      {!!c.query.data?.errors.length && <div className="collection-diagnostics"><AlertTriangle size={13} />{c.query.data.errors.length} {en ? 'source diagnostic(s)' : '条源码诊断'}<button onClick={() => props.onSettings('diagnostics')}>{en ? 'Review / repair' : '查看 / 修复'}</button></div>}
      {c.prefs.layout === 'graph' && !!c.draftIds.size && <p className="collection-diagnostics" role="status">{en ? 'Graph nodes and relationships use saved Markdown only. Draft badges identify unsaved local changes; save the source to update the formal graph.' : '图谱节点和关系仅来自已保存的 Markdown。草稿标记表示本地未保存更改；保存源码后正式图谱才会更新。'}</p>}
      {!documentCollection && advancedSplit && !selected && <p className="collection-diagnostics">{en ? 'Select an entity to open the optional source / collection split. No editor is opened automatically.' : '选择对象后打开可选的源码 / 集合分栏，不会自动打开编辑器。'}</p>}
      <div ref={bodyRef} className={`collection-body ${selected ? 'has-inspector' : ''} ${advancedSplit && selected && !taskInspector ? 'advanced-split' : ''}`} style={{ '--editor-width': `${c.prefs.editorWidth}%` } as CSSProperties}>
        {explorerOpen && <aside className="collection-explorer" aria-label={en ? 'File explorer' : '文件浏览器'}><div className="explorer-heading"><Folder size={14} /><strong>{en ? 'Source files' : '源码文件'}</strong><button className="icon-button" aria-label={en ? 'Close explorer' : '关闭浏览器'} onClick={() => setExplorerOpen(false)}><X size={15} /></button></div><div className="file-tree">{entityKinds.map(kind => <div className="file-group" key={kind}><div className="file-group-title"><ChevronDown size={12} /><Folder size={13} />{entityDefinitions[kind].directory}<span>{explorerFiles.filter(file => file.entity.entity === kind).length}</span></div>{explorerFiles.filter(file => file.entity.entity === kind).map(file => <button key={file.id} className={`file-item ${c.selectedId === file.id ? 'active' : ''}`} title={file.entity.title} onClick={() => c.select(file.id)}><FileText size={13} /><span>{file.path.split('/').pop()}</span>{file.entity.archived && <small className="archive-badge">{en ? 'Archived' : '归档'}</small>}{c.drafts[file.id] ? <span className="draft-dot" title={en ? 'Unsaved draft' : '未保存草稿'} /> : file.stale ? <AlertTriangle size={12} /> : null}</button>)}</div>)}{!props.projectId && !!c.unsupportedFiles.length && <div className="file-group"><div className="file-group-title"><AlertTriangle size={13} />{en ? 'Read-only sources' : '只读源码'}</div>{c.unsupportedFiles.map(file => <button key={file.path} className={`file-item ${c.unsupported?.path === file.path ? 'active' : ''}`} title={file.path} onClick={() => c.select(`source:${file.path}`)}><FileText size={13} /><span>{file.path.split('/').pop()}</span></button>)}</div>}</div></aside>}
        <section className="native-collection" aria-label={en ? 'Entity collection' : '对象集合'}>
          <div className="view-content">
            {c.taskCollection ? <TaskCollectionView controller={c} en={en} personal={personal} scope={props.taskContext?.scope} renderSchedule={props.renderSchedule} toolbarTarget={toolbarTarget} graphScopeTarget={graphScopeTarget} graphToggleTarget={graphToggleTarget} />
              : !documentCollection && (c.prefs.layout === 'calendar' || c.prefs.layout === 'gantt') ? props.renderSchedule({ files: c.matching, layout: c.prefs.layout, contextFiles: c.files, configuration: c.configuration, projectId: props.projectId || c.prefs.project || undefined, toolbarTarget, onSelect: c.select, onPatch: c.patch, canEdit: c.canEdit, onCreate: due => c.openCreate(workflowFor(c.prefs.entity || 'work_item', c.configuration)?.initial, undefined, { due }) })
                : documentCollection ? <DocumentCollection files={c.files} projects={c.projects} workspaceId={documentCatalog.workspaceId} sources={documentCatalog.collectionSources} scopes={documentCatalog.scopes} sourceRequest={`${documentCatalog.key}:${documentCatalog.request}`} filters={{ source: documentSourceFilter, type: documentTypeFilter, sort: documentSort, projectId: props.projectId || c.prefs.project, search: c.search }} en={en} onOpenNative={file => file.entity.entity === 'document' ? props.onOpenDocument({ kind: 'native', id: file.id }) : props.onNavigateEntity(file)} onOpenExternal={target => props.onOpenDocument(target)} onManageExternal={setExternalManagement} onReloadSources={documentCatalog.reload} />
                  : <PMView {...c.viewProps} />}
            {!documentCollection && !c.taskCollection && !c.files.length && !c.unsupportedFiles.length && <div className="empty-state"><p>{en ? 'Create your first entity. All nine types use real Markdown files.' : '新建第一个对象，全部九种类型均使用真实 Markdown 文件。'}</p><button className="secondary-button" disabled={!c.canWrite || c.configurationInvalid} onClick={() => c.openCreate(workflowFor(c.prefs.entity || 'work_item', c.configuration)?.initial)}><Plus size={14} />{en ? 'Create entity' : '新建对象'}</button></div>}
          </div>
        </section>
        {selected && advancedSplit && !taskInspector && <div className="resize-divider" role="separator" aria-label={en ? 'Resize source and collection panels' : '调整源码与集合面板宽度'} aria-orientation="vertical" aria-valuenow={Math.round(c.prefs.editorWidth)} aria-valuemin={26} aria-valuemax={66} tabIndex={0} onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId) && bodyRef.current) { const bounds = bodyRef.current.getBoundingClientRect(); c.preference('editorWidth', Math.max(26, Math.min(66, (event.clientX - bounds.left) / bounds.width * 100))); } }} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); c.preference('editorWidth', Math.max(26, Math.min(66, c.prefs.editorWidth + (event.key === 'ArrowLeft' ? -2 : 2)))); } }} />}
        {selected && <EntityDetail controller={c} en={en} onClose={props.onClose} onExpand={() => props.onExpand({ preferences: c.prefs, search: c.search, view: c.advancedView, activeView: c.activeView, advancedSplit, explorerOpen, filtersOpen })} renderBusiness={props.renderBusiness} />}
      </div>
    </>}
    {externalManagement && <ExternalDocumentManagementDialog key={JSON.stringify(externalManagement)} intent={externalManagement} sources={documentCatalog.collectionSources} sourcesReady={documentCatalog.status === 'ready'} en={en} onClose={() => setExternalManagement(null)} />}
    <WorkspaceDialogs controller={c} en={en} helpOpen={helpOpen} onCloseHelp={() => setHelpOpen(false)} onSavedView={props.onSavedView} onExpandCreation={props.onExpandCreation} />
  </div>;
}
