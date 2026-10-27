import React, { Suspense, lazy, useEffect, useId, useMemo, useRef, useState } from 'react';
import { defaultConfiguration, entityDefinitions, entityKinds } from '../pm-schema/index.ts';
import type { EntityKind, FileRecord, ProtocolConfiguration } from '../pm-schema/index.ts';
import { buildEntityGraph } from '../pm-schema/graph.ts';
import type { GraphData, GraphQuery } from '../pm-schema/graph.ts';
import './knowledge-graph.css';

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
}

const GraphCanvas = lazy(() => import('./KnowledgeGraphCanvas.tsx'));
const entityLabels: Record<EntityKind, string> = { project: '项目', work_item: '工作项', document: '文档', cycle: '周期', milestone: '里程碑', module: '模块', requirement: '需求', release: '发布', goal: '目标' };

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

export function KnowledgeGraph({ files, configuration = defaultConfiguration, source, query, selectedId, onSelect, draftIds, en = false, embedded = false, refreshKey }: KnowledgeGraphProps) {
  const graphId = useId();
  const [centerId, setCenterId] = useQueryControl(query?.centerId, query?.centerId || '', source);
  const [depth, setDepth] = useQueryControl(query?.depth ?? 1, String(query?.depth ?? 1), source);
  const [search, setSearch] = useQueryControl(query?.search ?? '', query?.search ?? '', source);
  const [relations, setRelations] = useQueryControl(query?.relations, JSON.stringify(query?.relations ?? null), source);
  const [retry, setRetry] = useState(0);
  const queryKey = JSON.stringify({ ...query, centerId, depth: centerId ? depth : undefined, search: search || undefined, relations });
  const stableQuery = useMemo(() => JSON.parse(queryKey) as GraphQuery, [queryKey]);
  const request = useMemo<GraphRequest>(() => ({ source, query: stableQuery, refreshKey, retry }), [source, stableQuery, refreshKey, retry]);
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
  const nodes = data?.nodes ?? [];
  const center = nodes.find(node => node.id === centerId);
  const selected = nodes.find(node => node.id === selectedId);
  const kinds = new Map<EntityKind, number>();
  nodes.forEach(node => kinds.set(node.entity, (kinds.get(node.entity) ?? 0) + 1));
  const availableRelations = data?.availableRelations ?? [];
  const hasDrafts = !!draftIds?.size;
  const focusCandidate = selected?.id ?? nodes[0]?.id;

  function toggleRelation(kind: string, checked: boolean) {
    const next = new Set(relations ?? availableRelations);
    if (checked) next.add(kind); else next.delete(kind);
    setRelations([...next].sort());
  }

  return <section className={`knowledge-graph${embedded ? ' knowledge-graph-embedded' : ''}`} aria-label={en ? 'Knowledge graph' : '知识图谱'} data-testid="knowledge-graph" data-graph-mode={source ? 'saved' : 'preview'}>
    <div className="kg-provenance">
      <strong>{source ? en ? 'Saved knowledge graph' : '已保存知识图谱' : hasDrafts ? en ? 'Embedded draft preview' : '嵌入草稿预览' : en ? 'Embedded graph preview' : '嵌入图谱预览'}</strong>
      <span>{source ? hasDrafts ? en ? 'Unsaved drafts are marked; their edits and links are not included until saved.' : '带标记的实体存在未保存草稿；保存前，草稿修改与链接不会进入此图。' : en ? 'Relationships come from saved Markdown. Layout changes do not edit entities.' : '关系来自已保存的 Markdown。调整布局不会修改实体。' : en ? 'Computed from the supplied preview files; draft relationships are not saved facts.' : '根据当前预览文件计算；草稿关系不代表已保存事实。'}</span>
    </div>
    <div className="kg-toolbar">
      <div className="kg-scope" role="group" aria-label={en ? 'Graph scope' : '图谱范围'}>
        <button type="button" aria-pressed={!centerId} onClick={() => setCenterId(undefined)}>{en ? 'Global' : '全局'}</button>
        <button type="button" aria-pressed={!!centerId} disabled={!centerId && !focusCandidate} onClick={() => { if (!centerId && focusCandidate) setCenterId(focusCandidate); }}>{en ? 'Local' : '局部'}</button>
      </div>
      <label className="kg-center"><span>{en ? 'Focus' : '中心'}</span><select value={centerId ?? ''} onChange={event => setCenterId(event.target.value || undefined)}>
        <option value="">{en ? 'All matching entities' : '所有匹配实体'}</option>
        {centerId && !center && <option value={centerId}>{centerId}</option>}
        {nodes.map(node => <option key={node.id} value={node.id}>{node.id} · {node.title}</option>)}
      </select></label>
      <label><span>{en ? 'Depth' : '层数'}</span><select value={depth} disabled={!centerId} onChange={event => setDepth(Number(event.target.value))}>{[1, 2, 3].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      {selected && selected.id !== centerId && <button type="button" onClick={() => setCenterId(selected.id)}>{en ? 'Focus selected' : '以选中实体为中心'}</button>}
      <label className="kg-search" htmlFor={`${graphId}-search`}><span>{en ? 'Search' : '搜索'}</span><input id={`${graphId}-search`} type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={en ? 'Title, ID, or content…' : '标题、ID 或正文…'} /></label>
    </div>
    <details className="kg-relations">
      <summary>{en ? 'Relation types' : '关系类型'} · {relations === undefined ? en ? 'All' : '全部' : relations.length === 0 ? en ? 'None' : '无' : relations.length}</summary>
      <div className="kg-relation-actions"><button type="button" onClick={() => setRelations(undefined)}>{en ? 'Select all' : '选择全部'}</button><button type="button" onClick={() => setRelations([])}>{en ? 'Select none' : '全部取消'}</button></div>
      {availableRelations.length > 0 ? <div className="kg-relation-options">{availableRelations.map(kind => <label key={kind}><input type="checkbox" checked={relations === undefined || relations.includes(kind)} onChange={event => toggleRelation(kind, event.target.checked)} /><span>{kind}</span></label>)}</div> : <p>{loading ? en ? 'Loading relation types…' : '正在加载关系类型…' : en ? 'No relation types in the current graph.' : '当前图中没有可用关系类型。'}</p>}
    </details>
    <div className="kg-body" aria-busy={loading}>
      {loading ? <div className="kg-state" role="status">{en ? 'Loading saved graph…' : '正在加载已保存图谱…'}</div> : error ? <div className="kg-state kg-error" role="alert"><strong>{en ? 'Graph could not be loaded' : '无法加载图谱'}</strong><p>{error}</p>{source && <button type="button" onClick={() => setRetry(value => value + 1)}>{en ? 'Retry' : '重试'}</button>}<p>{en ? 'No local preview is substituted for a failed saved-graph request.' : '已保存图谱请求失败时，不会以本地预览替代。'}</p></div> : !nodes.length ? <div className="kg-state" role="status"><strong>{en ? 'No entities match these graph filters.' : '没有实体符合当前图谱筛选条件。'}</strong><p>{centerId ? en ? 'The focused entity may be excluded by the current view, search, or archive filters.' : '中心实体可能被当前视图、搜索或归档条件排除。' : en ? 'Try changing the search, view, or archive filters.' : '请调整搜索、视图或归档条件。'}</p></div> : data && <Suspense fallback={<div className="kg-state" role="status">{en ? 'Loading interactive canvas…' : '正在加载交互画布…'}</div>}><GraphCanvas data={data} selectedId={selectedId} centerId={centerId} draftIds={draftIds} en={en} embedded={embedded} onSelect={onSelect} /></Suspense>}
    </div>
    {data && <>
      <div className="kg-summary" role="status" aria-live="polite"><span>{nodes.length} {en ? 'nodes' : '个节点'} · {data.links.length} {en ? 'typed relationships' : '条类型关系'}{centerId ? ` · ${centerId} · ${depth} ${en ? 'hop(s)' : '层邻域'}` : en ? ' · Global within current filters' : ' · 当前筛选范围内的全局图'}</span><span>{en ? 'Drag nodes · drag background to pan · scroll/pinch to zoom · click to open' : '拖动节点 · 拖动画布平移 · 滚轮/双指缩放 · 点击打开实体'}</span></div>
      <ul className="kg-legend" aria-label={en ? 'Entity type legend' : '实体类型图例'}>{entityKinds.filter(kind => kinds.has(kind)).map(kind => <li key={kind}><i style={{ backgroundColor: `var(--kg-${kind})` }} aria-hidden="true" />{en ? entityDefinitions[kind].label : entityLabels[kind]} <span>{kinds.get(kind)}</span></li>)}{hasDrafts && <li><i className="kg-draft-key" aria-hidden="true" />{en ? 'Dashed ring: unsaved draft' : '虚线环：未保存草稿'}</li>}</ul>
      {!!nodes.length && <details className="kg-node-navigation"><summary>{en ? 'Accessible node navigation' : '无障碍节点导航'} · {nodes.length}</summary><p>{en ? 'Open navigates to the entity. Focus changes only the local graph center.' : '“打开”进入实体；“聚焦”只调整局部图的中心。'}</p><ul>{nodes.map(node => <li key={node.id} data-selected={selectedId === node.id || undefined}><span className="kg-node-type" style={{ backgroundColor: `var(--kg-${node.entity})` }} aria-hidden="true" /><button type="button" className="kg-open-node" aria-current={selectedId === node.id ? 'true' : undefined} onClick={() => onSelect(node.id)} aria-label={`${en ? 'Open' : '打开'} ${node.id}: ${node.title}`}><span>{node.id}</span><strong>{node.title}</strong></button><span className="kg-node-meta">{en ? entityDefinitions[node.entity].label : entityLabels[node.entity]}{node.status ? ` · ${node.status}` : ''}{node.archived ? en ? ' · Archived' : ' · 已归档' : ''}{node.stale ? en ? ' · Stale' : ' · 过期快照' : ''}{draftIds?.has(node.id) ? en ? ' · Unsaved draft' : ' · 未保存草稿' : ''}</span><button type="button" onClick={() => setCenterId(node.id)} aria-label={`${en ? 'Focus graph on' : '聚焦图谱到'} ${node.id}`}>{en ? 'Focus' : '聚焦'}</button></li>)}</ul></details>}
      {!!data.unresolved.length && <details className="kg-unresolved"><summary>{en ? 'Unresolved links' : '未解析链接'} · {data.unresolved.length}</summary><ul>{data.unresolved.map((item, index) => <li key={`${item.source}:${item.target}:${item.reason}:${index}`}><span>{item.source} → {item.target}</span> · {item.reason === 'ambiguous' ? en ? 'Ambiguous target' : '目标有歧义' : en ? 'Missing target' : '目标不存在'}</li>)}</ul></details>}
    </>}
  </section>;
}
