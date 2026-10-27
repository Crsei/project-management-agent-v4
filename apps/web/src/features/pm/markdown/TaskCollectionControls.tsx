import { useEffect, useId, useRef } from 'react';
import { ArrowUpDown, Bot, Braces, CalendarDays, ChartGantt, CircleHelp, Columns3, List, ListFilter, MoreHorizontal, Network, PanelLeft, Plus, Rows3, Save, Search, Table2, X } from 'lucide-react';
import { workflowFor } from '@pm-schema';
import { priorities, type ArchiveFilter } from '@pm-views';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { WorkspaceController, CollectionLayout } from './controller';
import { taskScopes, type TaskScope } from './task-collection-model';
import { taskStateLabel } from './task-status-label';
import type { WorkspaceProps } from './workspace';
import personalStyles from './task-personal-chrome.module.css';

const scopes: Record<TaskScope, [string, string]> = { all: ['All tasks', '全部任务'], mine: ['My Tasks', '我的任务'], important: ['Important / Watching', '重要 / 我关注的'] };
type MenuLayout = Exclude<CollectionLayout, 'tree'>;
const layouts: [MenuLayout, string, string][] = [['list', 'List', '列表'], ['kanban', 'Board', '看板'], ['table', 'Table', '表格'], ['calendar', 'Calendar', '日历'], ['gantt', 'Timeline', '时间线'], ['graph', 'Graph', '关系图']];
const layoutIcons = { list: List, kanban: Columns3, table: Table2, calendar: CalendarDays, gantt: ChartGantt, graph: Network };
const sortOptions: [string, string, string][] = [['id', 'Task ID', '任务编号'], ['title', 'Title', '标题'], ['priority', 'Priority', '优先级'], ['status', 'Status', '状态'], ['due', 'Due date', '截止日期']];
const priorityLabels: Record<string, string> = { urgent: '紧急', high: '高', medium: '中', low: '低' };

type TaskWorkspaceProps = Pick<WorkspaceProps, 'en' | 'projectId' | 'taskContext' | 'onNewPage' | 'onScope' | 'onPresentation' | 'onSavedView' | 'onAgent'>;
interface Props extends TaskWorkspaceProps {
  controller: WorkspaceController;
  title: string;
  filtersOpen: boolean;
  onFiltersOpenChange: (open: boolean) => void;
  explorerOpen: boolean;
  onExplorerOpenChange: (open: boolean) => void;
  advancedSplit: boolean;
  onAdvancedSplitChange: (open: boolean) => void;
  onHelp: () => void;
  onToolbarTargetChange: (target: HTMLElement | null) => void;
}

/** Task-only chrome; generic entities retain their existing collection workspace. */
export default function TaskCollectionControls({ controller: c, en, projectId, taskContext, title, filtersOpen, onFiltersOpenChange, explorerOpen, onExplorerOpenChange, advancedSplit, onAdvancedSplitChange, onHelp, onNewPage, onScope, onPresentation, onSavedView, onAgent, onToolbarTargetChange }: Props) {
  const panelId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!taskContext) return;
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [data-radix-popper-content-wrapper]')) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, [taskContext]);
  if (!taskContext) return null;
  const t = (english: string, zh: string) => en ? english : zh;
  const timeline = c.prefs.layout === 'gantt';
  const personalScope = !projectId && taskContext.scope === 'mine';
  const personalChrome = personalScope && (c.prefs.layout === 'list' || c.prefs.layout === 'calendar');
  const summaryReady = !c.scopeError && !c.scopePending && !c.matchingResult.error;
  const personalCollection = personalScope && summaryReady ? c.taskCollection : null;
  const dueToday = personalCollection?.groups.find(group => group.id === 'today')?.files.length ?? '—';
  const overdue = personalCollection?.groups.find(group => group.id === 'overdue')?.files.length ?? '—';
  const upcoming = personalCollection?.groups.find(group => group.id === 'upcoming')?.files.length ?? '—';
  const agentProject = projectId || c.prefs.project || undefined;
  const activeFilters = Number(!!c.prefs.priority) + Number(!!c.prefs.status) + Number(!!c.prefs.project && !projectId) + Number(c.prefs.archived !== 'exclude') + Number(!!c.advancedView);
  const filterState = workflowFor('work_item', c.configuration)?.states.find(state => state.id === c.prefs.status);
  const filterStatusLabel = filterState ? taskStateLabel(filterState, en) : c.prefs.status;
  const activeGroup = c.config.group_by || 'status';
  const groupLabel = activeGroup === 'status' ? t('Status', '状态') : activeGroup === 'priority' ? t('Priority', '优先级') : `${t('Saved field', '保存的字段')}: ${activeGroup}`;
  const sortLabel = sortOptions.find(([value]) => value === c.prefs.sort)?.[en ? 1 : 2] ?? c.prefs.sort;
  const changeSavedView = (id: string) => {
    const view = c.query.data?.views.find(item => item.id === id);
    if (view) c.useView(view, view); else c.clearView();
    onSavedView(id);
  };
  const agentEntry = <button type="button" className="secondary-button task-agent-entry" data-testid="agent-assistant" aria-label={agentProject ? t('Open the Agent assistant and show this project as context', '打开 Agent 助手并显示当前项目上下文') : t('Open the Agent assistant for this workspace', '打开工作区 Agent 助手')} title={agentProject ? t('The project is shown as entry context; messages do not include project data automatically', '项目仅作为入口上下文显示；消息不会自动携带项目数据') : t('No project selected; open the workspace Agent chat', '未选择项目，打开工作区 Agent 对话')} onClick={() => onAgent(agentProject)}><Bot size={15} aria-hidden="true" /><span className="task-agent-entry-label">{t('Agent assistant', 'Agent 助手')}</span></button>;
  return <>
    <div className={`collection-heading task-collection-heading${projectId ? ' task-project-heading' : ''}${timeline ? ' task-timeline-heading' : ''}${personalChrome ? ` ${personalStyles.heading}` : ''}`}>
      <div className="task-collection-identity">
        <h1>{personalScope ? t('My Tasks', '我的任务') : timeline ? t('Timeline', '时间线') : projectId ? t('Tasks', '任务') : title}</h1>
        {personalChrome ? <p className={personalStyles.summary} aria-busy={c.scopePending}>{en ? `${dueToday} due today · ${overdue} overdue · ${upcoming} upcoming` : `${dueToday} 项今日到期 · ${overdue} 项已逾期 · ${upcoming} 项即将到来`}</p>
          : timeline ? <p>{projectId ? t('Schedules, dependencies, and milestones in this project.', '查看项目内的排期、依赖与里程碑。') : t('Schedules, dependencies, and milestones across projects.', '跨项目查看排期、依赖与里程碑。')}</p>
            : null}
      </div>
      <div className="collection-heading-actions">
        {personalChrome && <div className={personalStyles.viewSwitch} role="group" aria-label={t('Collection layout', '集合布局')}>
          {(['list', 'calendar'] as const).map(layout => { const Icon = layoutIcons[layout]; return <button key={layout} type="button" aria-pressed={c.prefs.layout === layout} onClick={() => { c.preference('layout', layout); onPresentation(layout); }}><Icon size={13} aria-hidden="true" />{layout === 'list' ? t('List', '列表') : t('Calendar', '日历')}</button>; })}
        </div>}
        {!personalChrome && agentEntry}
        <button type="button" className="primary-button" data-testid="new-task" aria-label={t('New task', '新建任务')} disabled={c.configurationInvalid || c.writesBlocked || !!c.busy || !c.canWrite || (personalScope && !taskContext.actorId)} onClick={() => c.openCreate(workflowFor('work_item', c.configuration)?.initial)}><Plus size={15} aria-hidden="true" />{t('New task', '新建任务')}</button>
        <DropdownMenu><DropdownMenuTrigger type="button" className="icon-button task-more-trigger" aria-label={t('More task tools', '更多任务工具')} title={t('More task tools', '更多任务工具')}><MoreHorizontal size={18} /></DropdownMenuTrigger><DropdownMenuContent className="task-collection-menu" align="end">
          <DropdownMenuLabel className="task-menu-label">{t('Create', '创建')}</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => onNewPage(c.prefs.project)}><Plus size={14} aria-hidden="true" />{t('Full creation page', '完整创建页')}</DropdownMenuItem>
          <DropdownMenuSeparator className="task-menu-separator" />
          {personalChrome && <>
            <DropdownMenuSub><DropdownMenuSubTrigger><ListFilter size={14} aria-hidden="true" />{t('Task scope', '任务范围')}</DropdownMenuSubTrigger><DropdownMenuSubContent className="task-collection-menu"><DropdownMenuRadioGroup value={taskContext.scope} onValueChange={value => onScope(value as TaskScope)}>{taskScopes.map(scope => <DropdownMenuRadioItem key={scope} value={scope} closeOnClick>{scopes[scope][en ? 0 : 1]} · {c.scopeCounts[scope] ?? '—'}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></DropdownMenuSubContent></DropdownMenuSub>
            <DropdownMenuSub><DropdownMenuSubTrigger><Rows3 size={14} aria-hidden="true" />{t('All layouts', '全部布局')}</DropdownMenuSubTrigger><DropdownMenuSubContent className="task-collection-menu"><DropdownMenuRadioGroup value={c.prefs.layout} onValueChange={value => { const layout = value as CollectionLayout; c.preference('layout', layout); onPresentation(layout); }}>{layouts.map(([id, english, zh]) => { const Icon = layoutIcons[id]; return <DropdownMenuRadioItem key={id} value={id} closeOnClick><Icon size={14} aria-hidden="true" />{en ? english : zh}</DropdownMenuRadioItem>; })}</DropdownMenuRadioGroup></DropdownMenuSubContent></DropdownMenuSub>
            <DropdownMenuSeparator className="task-menu-separator" />
          </>}
          <DropdownMenuSub><DropdownMenuSubTrigger><Save size={14} aria-hidden="true" />{t('Saved views', '保存的视图')}{c.activeView && <span className="task-menu-current">{c.activeView.name}</span>}</DropdownMenuSubTrigger><DropdownMenuSubContent className="task-collection-menu"><DropdownMenuRadioGroup value={c.activeView?.id || ''} onValueChange={changeSavedView}><DropdownMenuRadioItem value="" closeOnClick>{t('Unsaved view', '未保存视图')}</DropdownMenuRadioItem>{c.query.data?.views.map(view => <DropdownMenuRadioItem key={view.id} value={view.id} closeOnClick>{view.name}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></DropdownMenuSubContent></DropdownMenuSub>
          <DropdownMenuItem data-testid="edit-view-query" onSelect={() => c.setSaveViewOpen(true)}><Braces size={14} aria-hidden="true" />{t('Edit / save full view query', '编辑 / 保存完整视图查询')}</DropdownMenuItem>
          <DropdownMenuSeparator className="task-menu-separator" />
          <DropdownMenuLabel className="task-menu-label">{t('Advanced & source', '高级与源码工具')}</DropdownMenuLabel>
          <DropdownMenuCheckboxItem checked={explorerOpen} onCheckedChange={onExplorerOpenChange} closeOnClick><PanelLeft size={14} aria-hidden="true" />{t('File explorer', '文件浏览器')}</DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={advancedSplit} onCheckedChange={onAdvancedSplitChange} closeOnClick><Columns3 size={14} aria-hidden="true" />{t('Advanced source split', '高级源码分栏')}</DropdownMenuCheckboxItem>
          <DropdownMenuItem onSelect={onHelp}><CircleHelp size={14} aria-hidden="true" />{t('Workspace help', '工作区帮助')}</DropdownMenuItem>
        </DropdownMenuContent></DropdownMenu>
      </div>
    </div>
    <div className={`collection-toolbar task-controls${timeline ? ' task-timeline-controls' : ''}${personalChrome ? ` ${personalStyles.toolbar}` : ''}`} role="toolbar" aria-label={t('Task tools', '任务工具')}>
      <label className="task-search">
        <Search size={14} aria-hidden="true" />
        <input ref={searchRef} type="search" aria-label={t('Search tasks', '搜索任务')} value={c.search} onChange={event => c.setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && c.search) { c.setSearch(''); event.stopPropagation(); } }} placeholder={personalChrome ? t('Search tasks', '搜索任务') : t('Search tasks…', '搜索任务…')} />
        {c.search ? <button type="button" className="task-search-clear" aria-label={t('Clear search', '清除搜索')} onClick={() => { c.setSearch(''); searchRef.current?.focus(); }}><X size={12} aria-hidden="true" /></button> : <kbd aria-hidden="true">/</kbd>}
      </label>
      <button type="button" className={`task-toolbar-button task-filter-trigger ${filtersOpen ? 'active' : ''}`} data-testid="view-filters" aria-expanded={filtersOpen} aria-controls={panelId} onClick={() => onFiltersOpenChange(!filtersOpen)}><ListFilter size={14} aria-hidden="true" /><span>{personalChrome ? t('Filter', '筛选') : t('Filters', '筛选')}</span>{activeFilters > 0 && <span className="task-active-filter-count">{activeFilters}</span>}</button>
      <DropdownMenu><DropdownMenuTrigger type="button" className="task-toolbar-button" aria-label={`${t('Sort', '排序')}: ${sortLabel}`} title={`${t('Sort', '排序')}: ${sortLabel}`}><ArrowUpDown size={14} aria-hidden="true" /><span>{t('Sort', '排序')}{!timeline && `: ${sortLabel}`}</span></DropdownMenuTrigger><DropdownMenuContent className="task-collection-menu" align="start"><DropdownMenuLabel className="task-menu-label">{t('Sort by', '排序方式')}</DropdownMenuLabel><DropdownMenuRadioGroup value={c.prefs.sort} onValueChange={value => c.preference('sort', value)}>{sortOptions.map(([value, english, zh]) => <DropdownMenuRadioItem key={value} value={value}>{en ? english : zh}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu>
      {c.prefs.layout === 'kanban' && <DropdownMenu><DropdownMenuTrigger type="button" className="task-toolbar-button" aria-label={`${t('Group', '分组')}: ${groupLabel}`}><Rows3 size={14} aria-hidden="true" /><span>{t('Group', '分组')}: {groupLabel}</span></DropdownMenuTrigger><DropdownMenuContent className="task-collection-menu" align="start"><DropdownMenuLabel className="task-menu-label">{t('Board grouping', '看板分组')}</DropdownMenuLabel><DropdownMenuRadioGroup value={activeGroup} onValueChange={value => c.preference('groupBy', value === 'priority' ? 'priority' : 'status')}><DropdownMenuRadioItem value="status">{t('Workflow status', '工作流状态')}</DropdownMenuRadioItem><DropdownMenuRadioItem value="priority">{t('Priority (drag changes priority only)', '优先级（拖动只修改优先级）')}</DropdownMenuRadioItem>{c.config.group_by && !['status', 'priority'].includes(c.config.group_by) && <DropdownMenuRadioItem value={c.config.group_by}>{t('Saved field:', '保存的字段：')} {c.config.group_by}</DropdownMenuRadioItem>}</DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu>}
      {timeline && <div ref={onToolbarTargetChange} className="task-timeline-toolbar-target" />}
      <span className="task-toolbar-spacer" />
      {personalChrome && agentEntry}
    </div>
    {(c.prefs.priority || c.prefs.status || c.prefs.archived !== 'exclude' || c.advancedView || c.activeView) && <div className="task-active-filters task-chipsbar" aria-label={t('Active task filters', '当前任务筛选')}>
      {c.prefs.status && <div className="task-active-query"><span>{t('Status', '状态')}: {filterStatusLabel}</span><button type="button" className="task-clear-filter" aria-label={t('Clear status filter', '清除状态筛选')} onClick={() => c.preference('status', '')}><X size={12} aria-hidden="true" /></button></div>}
      {c.prefs.priority && <div className="task-active-query"><span>{t('Priority', '优先级')}: {en ? c.prefs.priority : priorityLabels[c.prefs.priority] || c.prefs.priority}</span><button type="button" className="task-clear-filter" aria-label={t('Clear priority filter', '清除优先级筛选')} onClick={() => c.preference('priority', '')}><X size={12} aria-hidden="true" /></button></div>}
      {c.prefs.archived !== 'exclude' && <div className="task-active-query"><span>{c.prefs.archived === 'only' ? t('Archived only', '仅归档') : t('Includes archived', '包含归档')}</span><button type="button" className="task-clear-filter" aria-label={t('Exclude archived tasks', '不含归档任务')} onClick={() => c.preference('archived', 'exclude')}><X size={12} aria-hidden="true" /></button></div>}
      {(c.advancedView || c.activeView) && <div className="task-active-query"><span>{c.activeView?.name || t('Custom query', '自定义查询')}</span><button type="button" className="task-clear-filter" aria-label={t('Clear view query', '清除视图查询')} onClick={() => { c.clearView(); onSavedView(''); }}><X size={12} aria-hidden="true" /></button></div>}
    </div>}
    {filtersOpen && <section id={panelId} className="filter-bar task-filter-panel" aria-label={t('Task filters', '任务筛选')}>
      <label className="task-project-filter">{projectId ? t('Fixed project', '固定项目') : t('Project filter', '项目筛选')}<select aria-label={projectId ? t('Fixed project', '固定项目') : t('Project filter', '项目筛选')} value={c.prefs.project} disabled={!!projectId} onChange={event => c.preference('project', event.target.value)}><option value="">{t('All projects', '全部项目')}</option>{c.prefs.project && !c.projects.some(file => file.id === c.prefs.project) && <option value={c.prefs.project}>{t('Project unavailable', '项目不可用')} · {c.prefs.project}</option>}{c.projects.map(file => <option key={file.id} value={file.id}>{file.entity.title}</option>)}</select></label>
      {!projectId && c.prefs.project && <button type="button" className="text-button" onClick={() => c.preference('project', '')}>{t('Clear project filter', '清除项目筛选')}</button>}
      <label>{t('Priority', '优先级')}<select aria-label={t('Filter priority', '筛选优先级')} value={c.prefs.priority} onChange={event => c.preference('priority', event.target.value)}><option value="">{t('All priorities', '全部优先级')}</option>{priorities.map(priority => <option key={priority} value={priority}>{en ? priority : priorityLabels[priority]}</option>)}</select></label>
      <label>{t('Status', '状态')}<select aria-label={t('Filter status', '筛选状态')} value={c.prefs.status} onChange={event => c.preference('status', event.target.value)}><option value="">{t('All statuses', '全部状态')}</option>{workflowFor('work_item', c.configuration)?.states.map(state => <option key={state.id} value={state.id}>{taskStateLabel(state, en)}</option>)}</select></label>
      <label>{t('Archive', '归档')}<select aria-label={t('Archive filter', '归档筛选')} data-testid="archive-filter" value={c.prefs.archived} onChange={event => c.preference('archived', event.target.value as ArchiveFilter)}><option value="exclude">{t('Active objects', '活动对象')}</option><option value="include">{t('Include archived', '包含归档')}</option><option value="only">{t('Archived only', '仅归档')}</option></select></label>
      <div className="task-filter-actions"><button type="button" className="secondary-button" data-testid="save-view" onClick={() => c.setSaveViewOpen(true)}><Save size={13} aria-hidden="true" />{t('Edit / save view', '编辑 / 保存视图')}</button><button type="button" className="text-button" onClick={() => { c.clearView(); onSavedView(''); }}>{t('Clear query', '清除查询')}</button><button type="button" className="text-button" onClick={() => onFiltersOpenChange(false)}>{t('Close filters', '收起筛选')}</button></div>
    </section>}
  </>;
}
