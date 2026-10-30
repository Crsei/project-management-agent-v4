import { useEffect, useId, useRef } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Bot, Braces, CalendarDays, ChartGantt, CircleHelp, Columns3, List, ListFilter, MoreHorizontal, Network, PanelLeft, Plus, Rows3, Save, Search, Table2, X } from 'lucide-react';
import { workflowFor } from '@pm-schema';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { WorkspaceController, CollectionLayout } from './controller';
import { taskScopes, type TaskScope } from './task-collection-model';
import { usePmService } from '../service/pm-service';
import TaskFilterCard from './TaskFilterCard';
import { taskFilterFieldLabel, taskFilterOperatorLabel, taskFilterOptions, taskFilterValueSummary } from './task-filter';
import type { WorkspaceProps } from './workspace';
import personalStyles from './task-personal-chrome.module.css';

const scopes: Record<TaskScope, [string, string]> = { all: ['All tasks', '全部任务'], mine: ['My Tasks', '我的任务'], important: ['Important / Watching', '重要 / 我关注的'] };
type MenuLayout = Exclude<CollectionLayout, 'tree'>;
const layouts: [MenuLayout, string, string][] = [['list', 'List', '列表'], ['kanban', 'Board', '看板'], ['table', 'Table', '表格'], ['calendar', 'Calendar', '日历'], ['gantt', 'Timeline', '时间线'], ['graph', 'Graph', '关系图']];
const layoutIcons = { list: List, kanban: Columns3, table: Table2, calendar: CalendarDays, gantt: ChartGantt, graph: Network };
const sortOptions: [string, string, string][] = [['id', 'Task ID', '任务编号'], ['title', 'Title', '标题'], ['priority', 'Priority', '优先级'], ['status', 'Status', '状态'], ['due', 'Due date', '截止日期']];

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
  const { actor } = usePmService();
  if (!taskContext) return null;
  const t = (english: string, zh: string) => en ? english : zh;
  const actors = actor ? [{ id: actor.id, name: actor.name }] : undefined;
  const projectOptions = c.projects.map(file => ({ id: file.id, title: file.entity.title }));
  const timeline = c.prefs.layout === 'gantt';
  const personalScope = !projectId && taskContext.scope === 'mine';
  const personalChrome = personalScope && (c.prefs.layout === 'list' || c.prefs.layout === 'calendar');
  const agentProject = projectId || c.prefs.project || undefined;
  const activeFilters = c.prefs.conditions.filter(condition => condition.values.length).length + Number(!!c.prefs.project && !projectId) + Number(c.prefs.archived !== 'exclude') + Number(!!c.advancedView);
  const activeGroup = c.config.group_by || 'status';
  const groupLabel = activeGroup === 'status' ? t('Status', '状态') : activeGroup === 'priority' ? t('Priority', '优先级') : `${t('Saved field', '保存的字段')}: ${activeGroup}`;
  const sortLabel = sortOptions.find(([value]) => value === c.prefs.sort)?.[en ? 1 : 2] ?? c.prefs.sort;
  const sortDirectionArrow = c.prefs.sortDirection === 'desc' ? '↓' : '↑';
  const changeSavedView = (id: string) => {
    const view = c.query.data?.views.find(item => item.id === id);
    if (view) c.useView(view, view); else c.clearView();
    onSavedView(id);
  };
  const agentEntry = <button type="button" className="secondary-button task-agent-entry" data-testid="agent-assistant" aria-label={agentProject ? t('Open the Agent assistant and show this project as context', '打开 Agent 助手并显示当前项目上下文') : t('Open the Agent assistant for this workspace', '打开工作区 Agent 助手')} title={agentProject ? t('The project is shown as entry context; messages do not include project data automatically', '项目仅作为入口上下文显示；消息不会自动携带项目数据') : t('No project selected; open the workspace Agent chat', '未选择项目，打开工作区 Agent 对话')} onClick={() => onAgent(agentProject)}><Bot size={15} aria-hidden="true" /><span className="task-agent-entry-label">{t('Agent assistant', 'Agent 助手')}</span></button>;
  const searchControl = <label className="task-search task-heading-search">
    <Search size={14} aria-hidden="true" />
    <input ref={searchRef} type="search" aria-label={t('Search tasks', '搜索任务')} value={c.search} onChange={event => c.setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && c.search) { c.setSearch(''); event.stopPropagation(); } }} placeholder={t('Search tasks…', '搜索任务…')} />
    {c.search ? <button type="button" className="task-search-clear" aria-label={t('Clear search', '清除搜索')} onClick={() => { c.setSearch(''); searchRef.current?.focus(); }}><X size={12} aria-hidden="true" /></button> : <kbd aria-hidden="true">/</kbd>}
  </label>;
  const filterControl = <Popover open={filtersOpen} onOpenChange={onFiltersOpenChange}>
    <PopoverTrigger render={<button type="button" className={`task-toolbar-button task-filter-trigger ${filtersOpen ? 'active' : ''}`} data-testid="view-filters" aria-controls={panelId} />}><ListFilter size={14} aria-hidden="true" /><span>{t('Filter', '筛选')}</span>{activeFilters > 0 && <span className="task-active-filter-count">{activeFilters}</span>}</PopoverTrigger>
    <PopoverContent id={panelId} className="task-filter-popover" align="end" aria-label={t('Task filters', '任务筛选')}>
      <TaskFilterCard controller={c} en={en} projectId={projectId} today={taskContext.today} actors={actors} onClose={() => onFiltersOpenChange(false)} onSavedView={onSavedView} />
    </PopoverContent>
  </Popover>;
  const sortControl = <DropdownMenu><DropdownMenuTrigger type="button" className="task-toolbar-button" aria-label={`${t('Sort', '排序')}: ${sortLabel} ${sortDirectionArrow}`} title={`${t('Sort', '排序')}: ${sortLabel} ${sortDirectionArrow}`}><ArrowUpDown size={14} aria-hidden="true" /><span>{t('Sort', '排序')}{!timeline && `: ${sortLabel} ${sortDirectionArrow}`}</span></DropdownMenuTrigger><DropdownMenuContent className="task-collection-menu task-sort-menu" align="end"><DropdownMenuLabel className="task-menu-label">{t('Sort by', '排序方式')}</DropdownMenuLabel><DropdownMenuRadioGroup value={c.prefs.sort} onValueChange={value => c.preference('sort', value)}>{sortOptions.map(([value, english, zh]) => <DropdownMenuRadioItem key={value} value={value}>{en ? english : zh}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup><DropdownMenuSeparator className="task-menu-separator" /><DropdownMenuLabel className="task-menu-label">{t('Direction', '方向')}</DropdownMenuLabel><DropdownMenuRadioGroup value={c.prefs.sortDirection} onValueChange={value => c.preference('sortDirection', value as 'asc' | 'desc')}><DropdownMenuRadioItem value="asc"><ArrowUp size={14} aria-hidden="true" />{t('Ascending', '升序')}</DropdownMenuRadioItem><DropdownMenuRadioItem value="desc"><ArrowDown size={14} aria-hidden="true" />{t('Descending', '降序')}</DropdownMenuRadioItem></DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu>;
  const groupControl = c.prefs.layout === 'kanban' ? <DropdownMenu><DropdownMenuTrigger type="button" className="task-toolbar-button" aria-label={`${t('Group', '分组')}: ${groupLabel}`}><Rows3 size={14} aria-hidden="true" /><span>{t('Group', '分组')}: {groupLabel}</span></DropdownMenuTrigger><DropdownMenuContent className="task-collection-menu" align="end"><DropdownMenuLabel className="task-menu-label">{t('Board grouping', '看板分组')}</DropdownMenuLabel><DropdownMenuRadioGroup value={activeGroup} onValueChange={value => c.preference('groupBy', value === 'priority' ? 'priority' : 'status')}><DropdownMenuRadioItem value="status">{t('Workflow status', '工作流状态')}</DropdownMenuRadioItem><DropdownMenuRadioItem value="priority">{t('Priority (drag changes priority only)', '优先级（拖动只修改优先级）')}</DropdownMenuRadioItem>{c.config.group_by && !['status', 'priority'].includes(c.config.group_by) && <DropdownMenuRadioItem value={c.config.group_by}>{t(`Saved field: ${c.config.group_by}`, `保存的字段：${c.config.group_by}`)}</DropdownMenuRadioItem>}</DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu> : null;
  return <>
    <div className={`collection-heading task-collection-heading${projectId ? ' task-project-heading' : ''}${timeline ? ' task-timeline-heading' : ''}${personalChrome ? ` ${personalStyles.heading}` : ''}`}>
      <div className="task-collection-identity">
        <h1>{personalScope ? t('My Tasks', '我的任务') : timeline ? t('Timeline', '时间线') : projectId ? t('Tasks', '任务') : title}</h1>
      </div>
      <div className="collection-heading-actions">
        {personalChrome && <div className={personalStyles.viewSwitch} role="group" aria-label={t('Collection layout', '集合布局')}>
          {(['list', 'calendar'] as const).map(layout => { const Icon = layoutIcons[layout]; return <button key={layout} type="button" aria-pressed={c.prefs.layout === layout} onClick={() => { c.preference('layout', layout); onPresentation(layout); }}><Icon size={13} aria-hidden="true" />{layout === 'list' ? t('List', '列表') : t('Calendar', '日历')}</button>; })}
        </div>}
        {searchControl}
        {filterControl}
        {sortControl}
        {groupControl}
        {agentEntry}
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
    {timeline && <div className="collection-toolbar task-controls task-timeline-controls" role="toolbar" aria-label={t('Timeline tools', '时间线工具')}>
      <div ref={onToolbarTargetChange} className="task-timeline-toolbar-target" />
    </div>}
    {(c.prefs.conditions.some(condition => condition.values.length) || (!!c.prefs.project && !projectId) || c.prefs.archived !== 'exclude' || c.advancedView || c.activeView) && <div className="task-active-filters task-chipsbar" aria-label={t('Active task filters', '当前任务筛选')}>
      {!projectId && c.prefs.project && <div className="task-active-query"><span>{t('Project', '项目')}: {c.projects.find(file => file.id === c.prefs.project)?.entity.title ?? c.prefs.project}</span><button type="button" className="task-clear-filter" aria-label={t('Clear project filter', '清除项目筛选')} onClick={() => c.preference('project', '')}><X size={12} aria-hidden="true" /></button></div>}
      {c.prefs.conditions.map((condition, index) => {
        if (!condition.values.length) return null;
        const options = taskFilterOptions(condition.field, { en, configuration: c.configuration, files: c.files, actors, projects: projectOptions });
        return <div key={index} className="task-active-query"><span>{taskFilterFieldLabel(condition.field, en)}: {taskFilterOperatorLabel(condition.operator, en)} {taskFilterValueSummary(condition.field, condition.values, options, en)}</span><button type="button" className="task-clear-filter" aria-label={t('Clear filter condition', '清除筛选条件')} onClick={() => c.preference('conditions', c.prefs.conditions.filter((_, at) => at !== index))}><X size={12} aria-hidden="true" /></button></div>;
      })}
      {c.prefs.archived !== 'exclude' && <div className="task-active-query"><span>{c.prefs.archived === 'only' ? t('Archived only', '仅归档') : t('Includes archived', '包含归档')}</span><button type="button" className="task-clear-filter" aria-label={t('Exclude archived tasks', '不含归档任务')} onClick={() => c.preference('archived', 'exclude')}><X size={12} aria-hidden="true" /></button></div>}
      {(c.advancedView || c.activeView) && <div className="task-active-query"><span>{c.activeView?.name || t('Custom query', '自定义查询')}</span><button type="button" className="task-clear-filter" aria-label={t('Clear view query', '清除视图查询')} onClick={() => { c.clearView(); onSavedView(''); }}><X size={12} aria-hidden="true" /></button></div>}
    </div>}

  </>;
}
