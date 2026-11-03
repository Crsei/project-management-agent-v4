import { Suspense, lazy, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Crosshair, Network, PanelLeft, Search, X } from 'lucide-react';
import { defaultConfiguration, entityDefinitions, entityKinds, workflowFor } from '../pm-schema/index.ts';
import type { EntityKind, FileRecord, ProtocolConfiguration } from '../pm-schema/index.ts';
import { buildEntityGraph } from '../pm-schema/graph.ts';
import type { GraphData, GraphNode, GraphQuery } from '../pm-schema/graph.ts';
import './knowledge-graph.css';
import { RadixSelect } from './RadixSelect.tsx';
import type { GraphCanvasViewState } from './KnowledgeGraphCanvas.tsx';

export type GraphSource = (query: GraphQuery, signal?: AbortSignal) => Promise<GraphData>;
export interface KnowledgeGraphProps {
  files: FileRecord[];
  configuration?: ProtocolConfiguration;
  source?: GraphSource;
  query?: GraphQuery;
  selectedId?: string;
  onSelect: (id: string) => void;
  draftIds?: Set<string>;
  en?: boolean;
  embedded?: boolean;
  refreshKey?: unknown;
  graphScopeTarget?: HTMLElement | null;
  graphToggleTarget?: HTMLElement | null;
}

const GraphCanvas = lazy(() => import('./KnowledgeGraphCanvas.tsx'));
const entityLabels: Record<EntityKind, string> = { project: '项目', work_item: '工作项', document: '文档', cycle: '周期', milestone: '里程碑', module: '模块', requirement: '需求', release: '发布', goal: '目标' };
const statusGroups = [
  { id: 'open', zh: '未完成', en: 'Open' },
  { id: 'completed', zh: '已完成', en: 'Completed' },
  { id: 'canceled', zh: '已取消', en: 'Canceled' },
  { id: 'other', zh: '其他', en: 'Other' },
] as const;
type StatusGroupId = typeof statusGroups[number]['id'];

function statusCategoryOf(node: GraphNode, configuration: ProtocolConfiguration) {
  return workflowFor(node.entity, configuration)?.states.find(state => state.id === node.status)?.category;
}
function statusGroupOf(node: GraphNode, configuration: ProtocolConfiguration): StatusGroupId {
  const category = statusCategoryOf(node, configuration);
  return category === 'completed' ? 'completed' : category === 'canceled' ? 'canceled' : category ? 'open' : 'other';
}
function statusLabelOf(node: GraphNode, configuration: ProtocolConfiguration, en: boolean) {
  if (!node.status) return en ? 'No status' : '无状态';
  return workflowFor(node.entity, configuration)?.states.find(state => state.id === node.status)?.label || node.status;
}

// Compare upstream values semantically, not by a host-created query/array identity.
// An upstream change takes effect during this render, before an old request can display.
function useQueryControl<T>(initial: T, identity: string, scope: GraphSource | undefined): [T, (value: T) => void] {
  const [state, setState] = useState({ identity, scope, value: initial });
  const unchanged = state.identity === identity && state.scope === scope;
  if (!unchanged) setState({ identity, scope, value: initial });
  return [unchanged ? state.value : initial, value => setState({ identity, scope, value })];
}

type GraphRequest = { source: GraphSource | undefined; query: GraphQuery; refreshKey: unknown; retry: number };
type RemoteResult = { request: GraphRequest; data?: GraphData; error?: string };

function ReadonlyNote({ source, hasDrafts, en }: { source: GraphSource | undefined; hasDrafts: boolean; en: boolean }) {
  return <div className="kg-readonly-note">
    <p>{source ? hasDrafts ? en ? 'Draft badges mark unsaved local changes. Titles and relationships use saved Markdown until those changes are saved.' : '草稿徽标表示本地未保存更改；保存之前，标题和关系仍来自已保存的 Markdown。' : en ? 'Entities and relationships come from saved Markdown. Dragging cards changes only this in-memory layout and is never saved.' : '实体与关系来自已保存的 Markdown。拖动卡片仅调整当前内存布局，不会保存。' : en ? 'Computed from the supplied preview files, which may include drafts. These relationships are not saved facts; dragging cards saves nothing.' : '根据当前预览文件计算，可能包含草稿。这些关系并非已保存事实，拖动卡片不会保存任何内容。'}</p>
    <p className="kg-scope-note">{en ? 'Global means all matching entities within your current access and filters, not the whole database.' : '“全局”仅指当前权限与筛选范围内的匹配实体，并非整个数据库。'}</p>
  </div>;
}

export function KnowledgeGraph({ files, configuration = defaultConfiguration, source, query, selectedId, onSelect, draftIds, en = false, embedded = false, refreshKey, graphScopeTarget, graphToggleTarget }: KnowledgeGraphProps) {
  const graphId = useId();
  const [centerId, setCenterId] = useQueryControl(query?.centerId, query?.centerId || '', source);
  const [depth, setDepth] = useQueryControl(query?.depth ?? 1, String(query?.depth ?? 1), source);
  const [search, setSearch] = useQueryControl(query?.search ?? '', query?.search ?? '', source);
  const [relations, setRelations] = useQueryControl(query?.relations, JSON.stringify(query?.relations ?? null), source);
  const [retry, setRetry] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(() => !embedded && typeof window !== 'undefined' && window.innerWidth > 900);
  const [inspectorId, setInspectorId] = useState<string>();
  const [hiddenGroups, setHiddenGroups] = useState<Set<StatusGroupId>>(() => embedded ? new Set<StatusGroupId>() : new Set<StatusGroupId>(['completed', 'canceled']));
  const [focusRequest, setFocusRequest] = useState<{ id: string; nonce: number }>();
  const focusSequence = useRef(0);
  const queryKey = JSON.stringify({ ...query, centerId, depth: centerId ? depth : undefined, search: search || undefined, relations });
  const stableQuery = useMemo(() => JSON.parse(queryKey) as GraphQuery, [queryKey]);
  const request = useMemo<GraphRequest>(() => ({ source, query: stableQuery, refreshKey, retry }), [source, stableQuery, refreshKey, retry]);
  const viewStateRef = useRef<GraphCanvasViewState | undefined>(undefined);
  const viewScope = useRef({ source, queryKey, version: 0 });
  if (viewScope.current.source !== source || viewScope.current.queryKey !== queryKey) {
    viewScope.current = { source, queryKey, version: viewScope.current.version + 1 };
    viewStateRef.current = undefined;
  }
  const sequence = useRef(0);
  const [remote, setRemote] = useState<RemoteResult>();

  useEffect(() => {
    const load = request.source;
    if (!load) return;
    const controller = new AbortController();
    const current = ++sequence.current;
    setRemote({ request });
    void Promise.resolve().then(() => load(request.query, controller.signal)).then(data => {
      if (!controller.signal.aborted && current === sequence.current) setRemote({ request, data });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && current === sequence.current) setRemote({ request, error: error instanceof Error ? error.message || error.name : String(error) });
    });
    return () => { controller.abort(); sequence.current += 1; };
  }, [request]);

  const preview = useMemo(() => {
    if (source) return undefined;
    try { return { data: buildEntityGraph(files, configuration, stableQuery), error: undefined }; }
    catch (error) { return { data: undefined, error: error instanceof Error ? error.message || error.name : String(error) }; }
  }, [source, files, configuration, stableQuery]);
  // Request identity includes the authorization-scoped source and freshness key.
  // Never leave a previous scope/query's graph visible while its replacement loads.
  const current = source ? remote?.request === request ? remote : undefined : preview;
  const data = current?.data;
  const error = current?.error;
  const loading = !!source && !data && !error;
  // Failed or empty refreshes may reflect a permission change; retain no old layout.
  // Loading renders no previous DTO, but successful same-scope refreshes keep the view.
  if (error || data?.nodes.length === 0) viewStateRef.current = undefined;
  const nodes = data?.nodes ?? [];
  const center = nodes.find(node => node.id === centerId);
  const availableRelations = data?.availableRelations ?? [];
  const hasDrafts = !!draftIds?.size;
  const relationCounts = new Map<string, number>();
  data?.links.forEach(link => relationCounts.set(link.kind, (relationCounts.get(link.kind) ?? 0) + 1));
  const nodeMap = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes]);
  const degrees = useMemo(() => {
    const result = new Map<string, number>();
    for (const link of data?.links ?? []) {
      result.set(link.source, (result.get(link.source) ?? 0) + 1);
      if (link.target !== link.source) result.set(link.target, (result.get(link.target) ?? 0) + 1);
    }
    return result;
  }, [data]);
  const grouped = useMemo(() => {
    const groups = new Map<StatusGroupId, GraphNode[]>(statusGroups.map(group => [group.id, []]));
    for (const node of nodes) groups.get(statusGroupOf(node, configuration))!.push(node);
    return statusGroups.map(group => ({ ...group, nodes: groups.get(group.id)! })).filter(group => group.nodes.length > 0);
  }, [nodes, configuration]);
  const visibleNodes = useMemo(() => !search && hiddenGroups.size ? nodes.filter(node => !hiddenGroups.has(statusGroupOf(node, configuration))) : nodes, [nodes, hiddenGroups, configuration, search]);
  const visibleIds = useMemo(() => new Set(visibleNodes.map(node => node.id)), [visibleNodes]);
  const visibleData = useMemo<GraphData | undefined>(() => data ? { ...data, nodes: visibleNodes, links: data.links.filter(link => visibleIds.has(link.source) && visibleIds.has(link.target)) } : undefined, [data, visibleNodes, visibleIds]);
  const focusCandidate = (inspectorId && visibleIds.has(inspectorId) ? inspectorId : undefined) ?? (selectedId && visibleIds.has(selectedId) ? selectedId : undefined) ?? visibleNodes[0]?.id ?? nodes[0]?.id;
  const inspector = inspectorId ? nodeMap.get(inspectorId) : undefined;
  const inspectorRelations = useMemo(() => {
    if (!inspector || !data) return [];
    return data.links.filter(link => link.source === inspector.id || link.target === inspector.id).map(link => {
      const otherId = link.source === inspector.id ? link.target : link.source;
      return { link, otherId, other: nodeMap.get(otherId), outgoing: link.source === inspector.id };
    });
  }, [inspector, data, nodeMap]);
  const visibleDraftCount = visibleNodes.filter(node => draftIds?.has(node.id)).length;
  const kinds = new Map<EntityKind, number>();
  visibleNodes.forEach(node => kinds.set(node.entity, (kinds.get(node.entity) ?? 0) + 1));

  // The shared entity detail is the full inspector once a node is opened from this page.
  useEffect(() => {
    if (!embedded && selectedId) setInspectorId(undefined);
  }, [embedded, selectedId]);

  function toggleRelation(kind: string, checked: boolean) {
    const next = new Set(relations ?? availableRelations);
    if (checked) next.add(kind); else next.delete(kind);
    setRelations([...next].sort());
  }
  function toggleGroup(id: StatusGroupId) {
    setHiddenGroups(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function requestFocus(id: string) {
    focusSequence.current += 1;
    setFocusRequest({ id, nonce: focusSequence.current });
  }
  function selectNode(id: string) {
    if (embedded || selectedId) onSelect(id);
    else setInspectorId(id);
  }
  function switchScope(local: boolean) {
    if (!local) { setCenterId(undefined); return; }
    if (!centerId && focusCandidate) setCenterId(focusCandidate);
  }

  const scopeSwitch = <div className="kg-scope" role="group" aria-label={en ? 'Graph scope' : '图谱范围'}>
    <button type="button" aria-pressed={!centerId} onClick={() => switchScope(false)}>{en ? 'Global' : '全局'}</button>
    <button type="button" aria-pressed={!!centerId} disabled={!centerId && !focusCandidate} onClick={() => switchScope(true)}>{en ? 'Local' : '局部'}</button>
  </div>;

  const relationFilter = availableRelations.length > 0
    ? <details className="kg-relations">
      <summary>{en ? 'Relationship types' : '关系类型'} · {relations === undefined ? en ? 'All' : '全部' : relations.length === 0 ? en ? 'None' : '无' : relations.length}</summary>
      <div className="kg-relation-actions"><button type="button" onClick={() => setRelations(undefined)}>{en ? 'Select all' : '选择全部'}</button><button type="button" onClick={() => setRelations([])}>{en ? 'Select none' : '全部取消'}</button></div>
      <div className="kg-relation-options">{availableRelations.map(kind => <label key={kind}><input type="checkbox" checked={relations === undefined || relations.includes(kind)} onChange={event => toggleRelation(kind, event.target.checked)} /><span>{kind}</span><small aria-label={en ? 'Relationships in current result' : '当前结果中的关系数量'}>{relationCounts.get(kind) ?? 0}</small></label>)}</div>
    </details>
    : <p className="kg-filter-empty">{loading ? en ? 'Loading relationship types…' : '正在加载关系类型…' : error ? en ? 'Relationship types are unavailable until the graph loads.' : '图谱加载成功后可查看关系类型。' : en ? 'No relationship types in the current scope.' : '当前范围中没有可用关系类型。'}</p>;

  const focusControls = centerId ? <div className="kg-focus-controls">
    <label className="kg-center"><span>{en ? 'Focus entity' : '中心实体'}</span><RadixSelect aria-label={en ? 'Focus entity' : '中心实体'} value={centerId ?? ''} onChange={event => setCenterId(event.target.value || undefined)}>
      <option value="">{en ? 'All matching entities' : '所有匹配实体'}</option>
      {centerId && !center && <option value={centerId}>{centerId}</option>}
      {nodes.map(node => <option key={node.id} value={node.id}>{node.id} · {node.title}</option>)}
    </RadixSelect></label>
    <label className="kg-depth"><span>{en ? 'Neighborhood depth' : '邻域层数'}</span><RadixSelect aria-label={en ? 'Neighborhood depth' : '邻域层数'} value={depth} onChange={event => setDepth(Number(event.target.value))}>{[1, 2, 3].map(value => <option key={value} value={value}>{value} {en ? value === 1 ? 'hop' : 'hops' : '层'}</option>)}</RadixSelect></label>
    {inspector && inspector.id !== centerId && <button type="button" onClick={() => setCenterId(inspector.id)}>{en ? 'Focus selected' : '以选中实体为中心'}</button>}
  </div> : null;

  const canvas = loading
    ? <div className="kg-state" role="status"><strong>{en ? 'Loading saved graph…' : '正在加载已保存图谱…'}</strong><p>{en ? 'Previous results are hidden while the current scope is checked.' : '核对当前范围期间，旧结果已隐藏。'}</p></div>
    : error
      ? <div className="kg-state kg-error" role="alert"><strong>{en ? 'Graph could not be loaded' : '无法加载图谱'}</strong><p>{error}</p>{source && <button type="button" onClick={() => setRetry(value => value + 1)}>{en ? 'Retry saved graph' : '重试已保存图谱'}</button>}<p>{source ? en ? 'No local preview is substituted for a failed saved-graph request.' : '已保存图谱请求失败时，不会以本地预览替代。' : en ? 'The supplied preview could not be computed. Repair its files or view configuration.' : '无法计算当前预览，请修复预览文件或视图配置。'}</p></div>
      : !nodes.length
        ? <div className="kg-state" role="status"><strong>{en ? 'No entities match these graph filters.' : '没有实体符合当前图谱筛选条件。'}</strong><p>{centerId ? en ? 'The focused entity may be excluded by the current view, search, or archive filters.' : '中心实体可能被当前视图、搜索或归档条件排除。' : en ? 'Try changing the search, view, or archive filters.' : '请调整搜索、视图或归档条件。'}</p></div>
        : visibleData && visibleData.nodes.length
          ? <Suspense fallback={<div className="kg-state" role="status">{en ? 'Loading interactive canvas…' : '正在加载交互画布…'}</div>}><GraphCanvas key={viewScope.current.version} data={visibleData} selectedId={inspectorId ?? selectedId} centerId={centerId} draftIds={draftIds} en={en} embedded={embedded} onSelect={selectNode} viewStateRef={viewStateRef} focusRequest={focusRequest} /></Suspense>
          : <div className="kg-state" role="status"><strong>{en ? 'Every entity is hidden by the current status filter.' : '当前状态筛选隐藏了全部实体。'}</strong><p>{en ? 'Re-enable a status group in the entity sidebar.' : '请在左侧实体导航中重新启用一个状态分组。'}</p></div>;

  const pageSummary = <span className="kg-page-summary" role="status" aria-live="polite">{visibleNodes.length} {en ? 'entities' : '个实体'} · {visibleData?.links.length ?? 0} {en ? 'relationships' : '条关系'}</span>;
  const sidebarToggle = <button type="button" className="kg-icon-button task-graph-toggle" aria-pressed={sidebarOpen} aria-controls={`${graphId}-sidebar`} aria-label={en ? sidebarOpen ? 'Hide entity navigation' : 'Show entity navigation' : sidebarOpen ? '收起实体导航' : '展开实体导航'} title={en ? 'Entity navigation' : '实体导航'} onClick={() => setSidebarOpen(value => !value)}><PanelLeft size={16} aria-hidden="true" /></button>;

  if (!embedded) return <section className="knowledge-graph knowledge-graph-page" aria-label={en ? 'Relationship graph' : '关系图'} aria-describedby={`${graphId}-provenance`} data-testid="knowledge-graph" data-graph-mode={source ? 'saved' : 'preview'}>
    {graphScopeTarget && createPortal(<>{scopeSwitch}{pageSummary}</>, graphScopeTarget)}
    {graphToggleTarget && createPortal(sidebarToggle, graphToggleTarget)}
    {(!graphScopeTarget || !graphToggleTarget) && <header className="kg-page-head">
      <div className="kg-page-title"><Network size={16} aria-hidden="true" /><strong>{en ? 'Relationship graph' : '关系图'}</strong></div>
      <div className="kg-page-actions">
        {!graphScopeTarget && scopeSwitch}
        {!graphScopeTarget && pageSummary}
        {!graphToggleTarget && sidebarToggle}
      </div>
    </header>}
    <div className="kg-workbench">
      <aside id={`${graphId}-sidebar`} className="kg-sidebar" data-open={sidebarOpen} aria-label={en ? 'Entity navigation and graph filters' : '实体导航与图谱筛选'}>
        <label className="kg-sidebar-search"><Search size={14} aria-hidden="true" /><span className="sr-only">{en ? 'Search entities' : '搜索实体'}</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={en ? 'Search entities…' : '搜索实体…'} /></label>
        <div className="kg-sidebar-filters">{focusControls}{relationFilter}</div>
        <nav className="kg-entity-nav" aria-label={en ? 'Entities in the current graph' : '当前图谱中的实体'}>
          <div className="kg-nav-heading"><span>{en ? 'All entities' : '全部实体'}</span><span>{nodes.length}</span></div>
          {grouped.map(group => {
            const hidden = !search && hiddenGroups.has(group.id);
            return <section className="kg-entity-group" key={group.id}>
              <button type="button" className="kg-entity-group-heading" aria-pressed={!hidden} aria-label={`${hidden ? en ? 'Show' : '显示' : en ? 'Hide' : '隐藏'} ${en ? group.en : group.zh}`} onClick={() => toggleGroup(group.id)}>
                <ChevronDown size={13} className={hidden ? 'is-collapsed' : ''} aria-hidden="true" />
                <span>{en ? group.en : group.zh}</span>
                <span className="kg-group-count">{group.nodes.length}</span>
              </button>
              {!hidden && <ul className="kg-entity-list">
                {group.nodes.map(node => <li key={node.id} data-selected={inspectorId === node.id || selectedId === node.id || undefined}>
                  <button type="button" className="kg-entity-open" aria-current={selectedId === node.id ? 'true' : undefined} onClick={() => selectNode(node.id)}>
                    <i style={{ backgroundColor: `var(--kg-${node.entity})` }} aria-hidden="true" />
                    <span className="kg-entity-copy"><span className="kg-entity-meta">{node.id} · {en ? entityDefinitions[node.entity].label : entityLabels[node.entity]}</span><strong>{node.title}</strong></span>
                  </button>
                  <button type="button" className="kg-entity-locate" aria-label={`${en ? 'Locate' : '定位'} ${node.id}`} title={en ? 'Locate on canvas' : '在画布中定位'} onClick={() => requestFocus(node.id)}><Crosshair size={13} aria-hidden="true" /></button>
                </li>)}
              </ul>}
            </section>;
          })}
          {!nodes.length && !loading && !error && <p className="kg-filter-empty">{en ? 'No entities in the current scope.' : '当前范围没有实体。'}</p>}
        </nav>
        <details className="kg-sidebar-note" id={`${graphId}-provenance`}>
          <summary>{source ? en ? 'Read-only' : '只读说明' : en ? 'Preview note' : '预览说明'}</summary>
          <ReadonlyNote source={source} hasDrafts={hasDrafts} en={en} />
        </details>
      </aside>
      <div className="kg-main" aria-busy={loading}>{canvas}</div>
      {inspector && <aside className="kg-inspector" aria-label={en ? 'Selected entity' : '选中实体详情'}>
        <header className="kg-inspector-head">
          <div><span className="kg-inspector-type" style={{ color: `var(--kg-${inspector.entity})` }}>{en ? entityDefinitions[inspector.entity].label : entityLabels[inspector.entity]}</span><strong className="kg-inspector-id">{inspector.id}</strong></div>
          <button type="button" className="kg-icon-button" aria-label={en ? 'Close entity details' : '关闭实体详情'} onClick={() => setInspectorId(undefined)}><X size={15} aria-hidden="true" /></button>
        </header>
        <div className="kg-inspector-body">
          <h2>{inspector.title}</h2>
          <dl className="kg-inspector-props">
            <div><dt>{en ? 'Status' : '状态'}</dt><dd>{statusLabelOf(inspector, configuration, en)}</dd></div>
            <div><dt>{en ? 'Relationships' : '关系'}</dt><dd>{degrees.get(inspector.id) ?? 0}</dd></div>
            {inspector.archived && <div><dt>{en ? 'Archived' : '归档'}</dt><dd>{en ? 'Yes' : '是'}</dd></div>}
            {inspector.stale && <div><dt>{en ? 'Snapshot' : '快照'}</dt><dd>{en ? 'Stale' : '已过期'}</dd></div>}
            {draftIds?.has(inspector.id) && <div><dt>{en ? 'Draft' : '草稿'}</dt><dd>{en ? 'Unsaved local changes' : '本地未保存更改'}</dd></div>}
          </dl>
          <div className="kg-inspector-actions">
            <button type="button" className="kg-primary-action" onClick={() => onSelect(inspector.id)}>{inspector.entity === 'work_item' ? en ? 'Open task' : '打开任务' : en ? 'Open entity' : '打开对象'}</button>
            <button type="button" disabled={inspector.id === centerId} onClick={() => setCenterId(inspector.id)}>{en ? 'Focus as center' : '设为中心'}</button>
            <button type="button" onClick={() => requestFocus(inspector.id)}>{en ? 'Locate' : '定位'}</button>
          </div>
          <section className="kg-inspector-relations">
            <h3>{en ? 'Relationships' : '关联关系'} · {inspectorRelations.length}</h3>
            {inspectorRelations.length ? <ul>{inspectorRelations.map(({ link, otherId, other, outgoing }) => <li key={link.id}>
              <button type="button" onClick={() => selectNode(otherId)} title={other?.title}>
                <span className="kg-relation-kind">{link.kind}</span>
                <span className="kg-relation-direction" aria-hidden="true">{link.source === link.target ? '↻' : outgoing ? '→' : '←'}</span>
                <span className="kg-relation-other"><span>{otherId}</span>{other?.title}</span>
              </button>
            </li>)}</ul> : <p>{en ? 'No relationships in the current result.' : '当前结果中没有关联关系。'}</p>}
          </section>
          <p className="kg-inspector-hint">{en ? 'Dragging cards changes only this in-memory layout. Business relationships are read-only.' : '拖动卡片只改变当前内存布局，业务关系为只读。'}</p>
        </div>
      </aside>}
    </div>
  </section>;

  return <section className={`knowledge-graph knowledge-graph-embedded`} aria-label={en ? 'Knowledge graph' : '知识图谱'} aria-describedby={`${graphId}-provenance`} data-testid="knowledge-graph" data-graph-mode={source ? 'saved' : 'preview'}>
    <header className="kg-provenance">
      <div className="kg-provenance-heading">
        <strong>{source ? en ? 'Relationship graph' : '关系图' : en ? 'Relationship preview' : '关系预览'}</strong>
        <span className="kg-mode-badge">{source ? en ? 'Saved facts · Read only' : '已保存事实 · 只读' : en ? 'Preview · Not saved facts' : '预览 · 非已保存事实'}</span>
      </div>
      <p id={`${graphId}-provenance`} className="kg-embedded-note">{source ? hasDrafts ? en ? 'Draft badges mark unsaved local changes. Relationships still come from saved Markdown; dragging changes only this in-memory layout.' : '草稿徽标表示本地未保存更改；关系仍来自已保存的 Markdown，拖动仅调整当前内存布局。' : en ? 'Entities and relationships come from saved Markdown. Dragging changes only this in-memory layout and is never saved.' : '实体与关系来自已保存的 Markdown。拖动仅调整当前内存布局，不会保存。' : en ? 'Computed from the supplied preview files, which may include drafts. These relationships are not saved facts.' : '根据当前预览文件计算，可能包含草稿；这些关系并非已保存事实。'}</p>
    </header>
    <div className="kg-toolbar">
      {scopeSwitch}
      <label className="kg-search" htmlFor={`${graphId}-search`}><span>{en ? 'Search entities' : '搜索实体'}</span><input id={`${graphId}-search`} type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={en ? 'Title, ID, or content…' : '标题、ID 或正文…'} /></label>
      <button type="button" className="kg-filter-toggle" aria-expanded={sidebarOpen} aria-controls={`${graphId}-filters`} onClick={() => setSidebarOpen(value => !value)}>{en ? 'Filters' : '筛选'}<span className="kg-filter-value">{centerId ? `${centerId} · ${depth}` : en ? 'Global' : '全局'}{relations !== undefined ? ` · ${relations.length} ${en ? 'types' : '类关系'}` : ''}</span><span aria-hidden="true">{sidebarOpen ? '▴' : '▾'}</span></button>
    </div>
    <div className="kg-filters" id={`${graphId}-filters`} hidden={!sidebarOpen}>
      {focusControls}
      {relationFilter}
    </div>
    {data && <div className="kg-summary" role="status" aria-live="polite"><span><strong>{visibleNodes.length}</strong> {en ? 'entities' : '个实体'} · <strong>{visibleData?.links.length ?? 0}</strong> {en ? 'typed relationships' : '条类型关系'}{centerId ? ` · ${centerId} · ${depth} ${en ? 'hop(s)' : '层邻域'}` : en ? ' · Global within current filters' : ' · 当前筛选范围内的全局图'}</span>{visibleDraftCount > 0 && <span className="kg-draft-count">{visibleDraftCount} {en ? 'with unsaved drafts' : '个实体有未保存草稿'}</span>}</div>}
    <div className="kg-body" aria-busy={loading}>{canvas}</div>
    {data && <>
      <ul className="kg-legend" aria-label={en ? 'Entity type legend' : '实体类型图例'}>{entityKinds.filter(kind => kinds.has(kind)).map(kind => <li key={kind}><i style={{ backgroundColor: `var(--kg-${kind})` }} aria-hidden="true" />{en ? entityDefinitions[kind].label : entityLabels[kind]} <span>{kinds.get(kind)}</span></li>)}</ul>
      {!!nodes.length && <details className="kg-node-navigation"><summary>{en ? 'Accessible node navigation' : '无障碍节点导航'} · {nodes.length}</summary><p>{en ? 'Open navigates to the entity. Focus changes only the local graph center.' : '“打开”进入实体；“聚焦”只调整局部图的中心。'}</p><ul>{nodes.map(node => <li key={node.id} data-selected={selectedId === node.id || undefined}><span className="kg-node-type" style={{ backgroundColor: `var(--kg-${node.entity})` }} aria-hidden="true" /><button type="button" className="kg-open-node" aria-current={selectedId === node.id ? 'true' : undefined} onClick={() => onSelect(node.id)} aria-label={`${en ? 'Open' : '打开'} ${node.id}: ${node.title}`}><span>{node.id}</span><strong>{node.title}</strong></button><span className="kg-node-meta">{en ? entityDefinitions[node.entity].label : entityLabels[node.entity]}{node.status ? ` · ${node.status}` : ''}{node.archived ? en ? ' · Archived' : ' · 已归档' : ''}{node.stale ? en ? ' · Stale' : ' · 过期快照' : ''}{draftIds?.has(node.id) ? en ? ' · Unsaved draft' : ' · 未保存草稿' : ''}</span><button type="button" onClick={() => setCenterId(node.id)} aria-pressed={centerId === node.id} aria-label={`${en ? 'Focus graph on' : '聚焦图谱到'} ${node.id}`}>{en ? 'Focus' : '聚焦'}</button></li>)}</ul></details>}
      {!!data.unresolved.length && <details className="kg-unresolved"><summary>{en ? 'Unresolved links' : '未解析链接'} · {data.unresolved.length}</summary><ul>{data.unresolved.map((item, index) => <li key={`${item.source}:${item.target}:${item.reason}:${index}`}><span>{item.source} → {item.target}</span> · {item.reason === 'ambiguous' ? en ? 'Ambiguous target' : '目标有歧义' : en ? 'Missing target' : '目标不存在'}</li>)}</ul></details>}
    </>}
  </section>;
}
