import React, { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Background, BackgroundVariant, BaseEdge, EdgeLabelRenderer, Handle, MarkerType, MiniMap, Panel, Position, ReactFlow, ReactFlowProvider, applyNodeChanges, getNodesBounds, getViewportForBounds, useNodesInitialized, useReactFlow, useStore } from '@xyflow/react';
import type { AriaLabelConfig, EdgeProps, NodeChange, NodeProps, Viewport, XYPosition } from '@xyflow/react';
import { entityDefinitions } from '../pm-schema/index.ts';
import type { EntityKind } from '../pm-schema/index.ts';
import type { GraphData, GraphNode } from '../pm-schema/graph.ts';
import { buildFlowGraph, GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH } from './graph-flow-model.ts';
import type { GraphDirection, GraphFlowEdge, GraphFlowModel, GraphFlowNode } from './graph-flow-model.ts';
import { layoutFlowGraph } from './graph-flow-layout.ts';
import '@xyflow/react/dist/style.css';
import './knowledge-graph-flow.css';

/** Ephemeral view state only. The page replaces this ref at authorization/query boundaries. */
export interface GraphCanvasViewState {
  positions: Map<string, XYPosition>;
  viewport?: Viewport;
  direction: GraphDirection;
}
interface CanvasProps {
  data: GraphData;
  selectedId?: string;
  centerId?: string;
  draftIds?: Set<string>;
  en: boolean;
  embedded: boolean;
  onSelect: (id: string) => void;
  viewStateRef?: React.MutableRefObject<GraphCanvasViewState | undefined>;
  focusRequest?: { id: string; nonce: number };
}
interface RelationStyle { color: string; dash?: string; width: number }
interface Presentation {
  en: boolean;
  selectedId?: string;
  centerId?: string;
  draftIds?: Set<string>;
  activeNodeId?: string;
  activeEdgeId?: string;
  highlighted?: Set<string>;
  showLabels: boolean;
}
const PresentationContext = createContext<Presentation>({ en: false, showLabels: false });
const entityLabels: Record<EntityKind, string> = { project: '项目', work_item: '工作项', document: '文档', cycle: '周期', milestone: '里程碑', module: '模块', requirement: '需求', release: '发布', goal: '目标' };
const knownRelations: Record<string, RelationStyle> = {
  project: { color: 'var(--kg-project)', width: 1.6 },
  parent: { color: 'var(--kg-accent)', width: 2.2 },
  blocked_by: { color: 'var(--kg-warning)', dash: '6 3', width: 2 },
  depends_on: { color: 'var(--kg-requirement)', dash: '10 3', width: 2 },
  related_to: { color: 'var(--kg-link)', dash: '4 4', width: 1.6 },
  link: { color: 'var(--kg-link)', dash: '1 5', width: 1.6 },
  cycle: { color: 'var(--kg-cycle)', width: 1.6 },
  milestone: { color: 'var(--kg-milestone)', width: 1.6 },
  module: { color: 'var(--kg-module)', width: 1.6 },
  requirement: { color: 'var(--kg-requirement)', width: 1.6 },
  release: { color: 'var(--kg-release)', width: 1.6 },
  goals: { color: 'var(--kg-goal)', dash: '8 3 2 3', width: 1.6 },
};
function relationStyle(kind: string): RelationStyle {
  if (Object.hasOwn(knownRelations, kind)) return knownRelations[kind]!;
  let hash = 0;
  for (let index = 0; index < kind.length; index++) hash = (Math.imul(hash, 31) + kind.charCodeAt(index)) >>> 0;
  const colors = ['var(--kg-document)', 'var(--kg-module)', 'var(--kg-goal)', 'var(--kg-milestone)'];
  const dashes = ['3 3', '8 3', '8 3 2 3', '2 4'];
  return { color: colors[hash % colors.length]!, dash: dashes[Math.floor(hash / colors.length) % dashes.length]!, width: 1.6 };
}
function nodeDescription(node: GraphNode, degree: number, en: boolean, draft: boolean) {
  const attributes = [node.id, node.title, en ? entityDefinitions[node.entity].label : entityLabels[node.entity], node.status, `${degree} ${en ? 'relationships' : '条关系'}`, node.archived && (en ? 'Archived' : '已归档'), node.stale && (en ? 'Stale snapshot' : '过期快照'), draft && (en ? 'Unsaved draft' : '未保存草稿')];
  return attributes.filter(Boolean).join(' · ');
}

const EntityCard = memo(function EntityCard({ id, data, sourcePosition = Position.Right, targetPosition = Position.Left }: NodeProps<GraphFlowNode>) {
  const { en, selectedId, centerId, draftIds, activeNodeId, highlighted } = useContext(PresentationContext);
  const node = data.entity;
  const draft = draftIds?.has(id);
  const classes = ['kg-entity-card', highlighted && !highlighted.has(id) && 'is-muted', activeNodeId === id && 'is-highlighted', selectedId === id && 'is-selected', centerId === id && 'is-center', draft && 'is-draft'].filter(Boolean).join(' ');
  return <div className={classes} style={{ '--kg-entity-color': `var(--kg-${node.entity})` } as React.CSSProperties}>
    <Handle id="in" type="target" position={targetPosition} isConnectable={false} />
    <div className="kg-entity-heading"><span className="kg-entity-type">{en ? entityDefinitions[node.entity].label : entityLabels[node.entity]}</span><span className="kg-entity-id">{id}</span></div>
    <strong className="kg-entity-title" title={node.title}>{node.title}</strong>
    <div className="kg-entity-footer"><span className="kg-entity-status" title={node.status}>{node.status || (en ? 'No status' : '无状态')}</span><span className="kg-entity-degree" title={en ? 'Incident relationships (self-reference counted once)' : '关联关系数（自引用计一次）'}>{data.degree} {en ? 'links' : '条关系'}</span></div>
    {(node.archived || node.stale || draft) && <div className="kg-entity-marks">{node.archived && <span>{en ? 'Archived' : '归档'}</span>}{node.stale && <span>{en ? 'Stale' : '过期'}</span>}{draft && <span className="kg-entity-draft">{en ? 'Draft' : '草稿'}</span>}</div>}
    <Handle id="out" type="source" position={sourcePosition} isConnectable={false} />
  </div>;
});

/** Route outside the cards for back edges and self references; never reverse the DTO edge. */
function relationshipPath({ source, target, sourceX: sx, sourceY: sy, targetX: tx, targetY: ty, sourcePosition, data }: EdgeProps<GraphFlowEdge>): [string, number, number] {
  const horizontal = sourcePosition === Position.Right;
  const lane = data?.lane ?? 0;
  if (source === target) {
    const reach = 38 + lane * 18;
    if (horizontal) {
      const top = Math.min(sy, ty) - GRAPH_NODE_HEIGHT / 2 - 44 - lane * 30;
      return [`M ${sx} ${sy} C ${sx + reach} ${sy}, ${sx + reach} ${top}, ${sx} ${top} L ${tx} ${top} C ${tx - reach} ${top}, ${tx - reach} ${ty}, ${tx} ${ty}`, (sx + tx) / 2, top];
    }
    const right = Math.max(sx, tx) + GRAPH_NODE_WIDTH / 2 + 44 + lane * 30;
    return [`M ${sx} ${sy} C ${sx} ${sy + reach}, ${right} ${sy + reach}, ${right} ${sy} L ${right} ${ty} C ${right} ${ty - reach}, ${tx} ${ty - reach}, ${tx} ${ty}`, right, (sy + ty) / 2];
  }
  // Lanes are signed in canonical endpoint order, including reciprocal relations.
  const directedLane = lane * (source < target ? 1 : -1);
  const dx = tx - sx;
  const dy = ty - sy;
  const centerDx = dx + (horizontal ? GRAPH_NODE_WIDTH : 0);
  const centerDy = dy + (horizontal ? 0 : GRAPH_NODE_HEIGHT);
  const length = Math.hypot(centerDx, centerDy) || 1;
  const offsetX = -centerDy / length * directedLane * 52;
  const offsetY = centerDx / length * directedLane * 52;
  if (horizontal && tx <= sx + 24) {
    const side = (Math.abs(offsetY) > .1 ? offsetY : lane) > 0 ? 1 : -1;
    const y = (side > 0 ? Math.max(sy, ty) : Math.min(sy, ty)) + side * (GRAPH_NODE_HEIGHT / 2 + 54 + Math.abs(lane) * 32);
    const reach = 42 + Math.abs(lane) * 16;
    return [`M ${sx} ${sy} C ${sx + reach} ${sy}, ${sx + reach} ${y}, ${sx} ${y} L ${tx} ${y} C ${tx - reach} ${y}, ${tx - reach} ${ty}, ${tx} ${ty}`, (sx + tx) / 2, y];
  }
  if (!horizontal && ty <= sy + 24) {
    const side = (Math.abs(offsetX) > .1 ? offsetX : lane) > 0 ? 1 : -1;
    const x = (side > 0 ? Math.max(sx, tx) : Math.min(sx, tx)) + side * (GRAPH_NODE_WIDTH / 2 + 54 + Math.abs(lane) * 32);
    const reach = 42 + Math.abs(lane) * 16;
    return [`M ${sx} ${sy} C ${sx} ${sy + reach}, ${x} ${sy + reach}, ${x} ${sy} L ${x} ${ty} C ${x} ${ty - reach}, ${tx} ${ty - reach}, ${tx} ${ty}`, x, (sy + ty) / 2];
  }
  const reach = Math.max(48, (horizontal ? dx : dy) / 2);
  const c1x = sx + (horizontal ? reach : 0) + offsetX;
  const c1y = sy + (horizontal ? 0 : reach) + offsetY;
  const c2x = tx - (horizontal ? reach : 0) + offsetX;
  const c2y = ty - (horizontal ? 0 : reach) + offsetY;
  return [`M ${sx} ${sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${tx} ${ty}`, (sx + 3 * c1x + 3 * c2x + tx) / 8, (sy + 3 * c1y + 3 * c2y + ty) / 8];
}
const RelationshipEdge = memo(function RelationshipEdge(props: EdgeProps<GraphFlowEdge>) {
  const { activeNodeId, activeEdgeId, showLabels } = useContext(PresentationContext);
  const kind = props.data?.kind ?? '';
  const style = relationStyle(kind);
  const active = activeEdgeId === props.id || activeNodeId === props.source || activeNodeId === props.target;
  const muted = !!(activeNodeId || activeEdgeId) && !active;
  const [path, labelX, labelY] = relationshipPath(props);
  return <>
    <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} interactionWidth={20} style={{ stroke: style.color, strokeWidth: active ? style.width + 1 : style.width, strokeDasharray: style.dash, opacity: muted ? .32 : active ? 1 : .68 }} />
    {showLabels || active ? <EdgeLabelRenderer><div className={`kg-relationship-label${active ? ' is-active' : ''}${muted ? ' is-muted' : ''}`} style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, borderColor: style.color }} title={`${props.source} → ${props.target} · ${kind}`}><strong>{kind}</strong></div></EdgeLabelRenderer> : null}
  </>;
});
const nodeTypes = { entity: EntityCard };
const edgeTypes = { relationship: RelationshipEdge };

type LayoutJob = { model: GraphFlowModel; force: boolean };
type RenderState = { job: LayoutJob; nodes: GraphFlowNode[]; status: 'loading' | 'ready' | 'error'; error?: string };
function prepareNodes(model: GraphFlowModel, cache: GraphCanvasViewState, direction: GraphDirection) {
  const retained = new Set<string>();
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of model.nodes) {
    const position = cache.positions.get(node.id);
    if (position) { retained.add(node.id); maxX = Math.max(maxX, position.x); maxY = Math.max(maxY, position.y); }
  }
  let added = 0;
  const columns = Math.max(1, Math.ceil(Math.sqrt(model.nodes.length - retained.size)));
  const nodes = model.nodes.map(node => {
    const saved = cache.positions.get(node.id);
    if (saved) return { ...node, position: { ...saved } };
    const index = added++;
    return { ...node, position: {
      x: (retained.size && direction === 'RIGHT' ? maxX + GRAPH_NODE_WIDTH + 100 : 0) + index % columns * (GRAPH_NODE_WIDTH + 100),
      y: (retained.size && direction === 'DOWN' ? maxY + GRAPH_NODE_HEIGHT + 88 : 0) + Math.floor(index / columns) * (GRAPH_NODE_HEIGHT + 88),
    } };
  });
  return { nodes, retained };
}
function focusedElement(target: EventTarget | null) {
  return target instanceof Element ? target.closest<HTMLElement | SVGElement>('.react-flow__node[data-id], .react-flow__edge[data-id]') : null;
}

function GraphCanvasBody({ data, selectedId, centerId, draftIds, en, embedded, onSelect, viewStateRef, focusRequest }: CanvasProps) {
  const [cache] = useState<GraphCanvasViewState>(() => {
    if (viewStateRef?.current) return viewStateRef.current;
    const next: GraphCanvasViewState = { positions: new Map(), direction: 'RIGHT' };
    if (viewStateRef) viewStateRef.current = next;
    return next;
  });
  const cacheIsCurrent = useCallback(() => !viewStateRef || viewStateRef.current === cache, [cache, viewStateRef]);
  const [settings, setSettings] = useState({ direction: cache.direction, attempt: 0 });
  const { direction } = settings;
  const consumedAttempt = useRef(0);
  const [showLabels, setShowLabels] = useState(false);
  const [showMiniMap, setShowMiniMap] = useState(!embedded);
  const [hoverNodeId, setHoverNodeId] = useState<string>();
  const [hoverEdgeId, setHoverEdgeId] = useState<string>();
  const [focusNodeId, setFocusNodeId] = useState<string>();
  const [focusEdgeId, setFocusEdgeId] = useState<string>();
  const [zoom, setZoom] = useState(cache.viewport?.zoom ?? 1);
  const surface = useRef<HTMLDivElement>(null);
  const interaction = useRef(0);
  const drag = useRef<{ id: string; until: number } | undefined>(undefined);
  const movedDuringLayout = useRef(new Set<string>());
  const pendingFit = useRef<{ job: LayoutJob; interaction: number } | undefined>(undefined);
  const flow = useReactFlow<GraphFlowNode, GraphFlowEdge>();
  const initialized = useNodesInitialized();
  const width = useStore(state => state.width);
  const height = useStore(state => state.height);
  const model = useMemo(() => {
    const result = buildFlowGraph(data, direction);
    return { ...result,
      nodes: result.nodes.map(node => ({ ...node, className: 'kg-flow-node', selectable: false, deletable: false, connectable: false, focusable: true, ariaRole: 'button' as const, ariaLabel: `${en ? 'Open' : '打开'} · ${nodeDescription(node.data.entity, node.data.degree, en, !!draftIds?.has(node.id))}`, domAttributes: { 'aria-roledescription': en ? 'entity card' : '实体卡片' } })),
      edges: result.edges.map(edge => ({ ...edge, selectable: false, deletable: false, reconnectable: false, focusable: true, ariaLabel: `${edge.source} → ${edge.target} · ${edge.data?.kind ?? ''}`, domAttributes: { 'aria-roledescription': en ? 'directed relationship' : '有向关系' }, markerEnd: { type: MarkerType.ArrowClosed, color: relationStyle(edge.data?.kind ?? '').color, width: 18, height: 18 } })),
    };
  }, [data, direction, en, draftIds]);
  const job = useMemo<LayoutJob>(() => ({ model, force: settings.attempt !== consumedAttempt.current }), [model, settings.attempt]);
  const prepared = useMemo(() => prepareNodes(job.model, cache, direction), [job, cache, direction]);
  const initial = useMemo<RenderState>(() => ({ job, nodes: prepared.nodes, status: job.force || prepared.retained.size !== model.nodes.length ? 'loading' : 'ready' }), [job, prepared, model.nodes.length]);
  const [rendered, setRendered] = useState<RenderState>(initial);
  const current = rendered.job === job ? rendered : initial;
  const activeJob = useRef(job);
  // Invalidate immediately during a data render, before an old Worker promise can settle.
  activeJob.current = job;

  const markInteraction = useCallback(() => {
    interaction.current += 1;
    pendingFit.current = undefined;
    if (cacheIsCurrent() && flow.viewportInitialized) cache.viewport = flow.getViewport();
  }, [cache, cacheIsCurrent, flow]);

  useLayoutEffect(() => {
    const controller = new AbortController();
    const startedAt = interaction.current;
    consumedAttempt.current = settings.attempt;
    movedDuringLayout.current = new Set();
    pendingFit.current = undefined;
    setHoverNodeId(undefined); setHoverEdgeId(undefined); setFocusNodeId(undefined); setFocusEdgeId(undefined);
    if (!cacheIsCurrent()) return () => controller.abort();
    cache.direction = direction;
    // Do not cache provisional grid placements: an interrupted first layout must retry on remount.
    cache.positions = new Map(initial.nodes.filter(node => prepared.retained.has(node.id)).map(node => [node.id, { ...node.position }]));
    setRendered(initial);
    const requestFit = () => {
      if ((job.force || !cache.viewport) && interaction.current === startedAt) pendingFit.current = { job, interaction: startedAt };
    };
    if (initial.status === 'ready') {
      requestFit();
      return () => controller.abort();
    }
    void layoutFlowGraph(model, direction, controller.signal).then(positions => {
      if (controller.signal.aborted || activeJob.current !== job || !cacheIsCurrent()) return;
      const preserved = job.force ? new Set<string>() : prepared.retained;
      let shiftX = 0;
      let shiftY = 0;
      // New entities get their own non-overlapping extension; retained cards never jump on refresh.
      if (preserved.size) {
        let oldMax = -Infinity;
        let newMin = Infinity;
        for (const node of model.nodes) {
          const position = preserved.has(node.id) ? cache.positions.get(node.id) : positions.get(node.id);
          if (!position) continue;
          const axis = direction === 'RIGHT' ? position.x : position.y;
          if (preserved.has(node.id)) oldMax = Math.max(oldMax, axis); else newMin = Math.min(newMin, axis);
        }
        if (Number.isFinite(oldMax) && Number.isFinite(newMin)) {
          if (direction === 'RIGHT') shiftX = oldMax + GRAPH_NODE_WIDTH + 100 - newMin;
          else shiftY = oldMax + GRAPH_NODE_HEIGHT + 88 - newMin;
        }
      }
      const next = new Map<string, XYPosition>();
      for (const node of model.nodes) {
        const keep = preserved.has(node.id) || movedDuringLayout.current.has(node.id);
        const position = keep ? cache.positions.get(node.id) : positions.get(node.id);
        if (position) next.set(node.id, keep ? { ...position } : { x: position.x + shiftX, y: position.y + shiftY });
      }
      cache.positions = next;
      requestFit();
      setRendered(previous => previous.job === job ? { job, nodes: previous.nodes.map(node => ({ ...node, position: next.get(node.id) ?? node.position })), status: 'ready' } : previous);
    }).catch((error: unknown) => {
      if (controller.signal.aborted || activeJob.current !== job || !cacheIsCurrent()) return;
      requestFit();
      setRendered(previous => previous.job === job ? { ...previous, status: 'error', error: error instanceof Error ? error.message || error.name : String(error) } : previous);
    });
    return () => controller.abort();
  }, [job, initial, model, direction, cache, cacheIsCurrent, prepared.retained, settings.attempt]);
  const fitGraph = useCallback((duration: number) => {
    const nodes = flow.getNodes();
    if (!nodes.length || !width || !height) return;
    const byId = new Map(nodes.map(node => [node.id, node]));
    const horizontal = direction === 'RIGHT';
    let marginX = 16;
    let marginY = 16;
    for (const edge of model.edges) {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      if (!source || !target) continue;
      const lane = Math.abs(edge.data?.lane ?? 0);
      if (edge.source === edge.target) {
        if (horizontal) {
          marginX = Math.max(marginX, 38 + lane * 18);
          marginY = Math.max(marginY, 44 + lane * 30);
        } else {
          marginX = Math.max(marginX, 44 + lane * 30);
          marginY = Math.max(marginY, 38 + lane * 18);
        }
        continue;
      }
      // Parallel-edge offsets are perpendicular to the layout direction.
      if (horizontal) marginY = Math.max(marginY, lane * 52);
      else marginX = Math.max(marginX, lane * 52);
      const backward = horizontal ? target.position.x <= source.position.x + GRAPH_NODE_WIDTH + 24 : target.position.y <= source.position.y + GRAPH_NODE_HEIGHT + 24;
      if (backward) {
        // Back edges route around the cards on the perpendicular axis.
        if (horizontal) marginY = Math.max(marginY, 54 + lane * 32);
        else marginX = Math.max(marginX, 54 + lane * 32);
      }
    }
    // React Flow's node-only fit would crop the external self-loop/back-edge routes.
    const bounds = getNodesBounds(nodes);
    const viewport = getViewportForBounds({ x: bounds.x - marginX, y: bounds.y - marginY, width: bounds.width + 2 * marginX, height: bounds.height + 2 * marginY }, width, height, .01, 1, .1);
    return flow.setViewport(viewport, { duration });
  }, [flow, model.edges, direction, width, height]);

  // A completed layout is not sufficient: handles must be measured in a visible, sized viewport.
  useEffect(() => {
    if (!initialized || !flow.viewportInitialized || current.status === 'loading' || !width || !height) return;
    const frame = requestAnimationFrame(() => {
      const fit = pendingFit.current;
      const element = surface.current;
      if (!fit || fit.job !== job || activeJob.current !== job || fit.interaction !== interaction.current || !cacheIsCurrent() || !element || Math.abs(element.clientWidth - width) > 1 || Math.abs(element.clientHeight - height) > 1) return;
      pendingFit.current = undefined;
      void fitGraph(0);
    });
    return () => cancelAnimationFrame(frame);
  }, [initialized, flow, current.status, job, width, height, cacheIsCurrent, fitGraph]);

  const onNodesChange = useCallback((changes: NodeChange<GraphFlowNode>[]) => {
    if (!cacheIsCurrent() || activeJob.current !== job) return;
    const allowed = changes.filter(change => change.type === 'position' || change.type === 'dimensions');
    if (!allowed.length) return;
    for (const change of allowed) {
      if (change.type === 'position' && change.position) {
        cache.positions.set(change.id, { ...change.position });
        movedDuringLayout.current.add(change.id);
      }
    }
    setRendered(previous => previous.job === job ? { ...previous, nodes: applyNodeChanges(allowed, previous.nodes) } : previous);
  }, [cache, cacheIsCurrent, job]);
  const activeNodeId = focusNodeId ?? hoverNodeId;
  const activeEdgeId = focusEdgeId ?? hoverEdgeId;
  const highlighted = useMemo(() => activeNodeId ? new Set([activeNodeId, ...(model.neighbors.get(activeNodeId) ?? [])]) : undefined, [activeNodeId, model.neighbors]);
  const presentation = useMemo<Presentation>(() => ({ en, selectedId, centerId, draftIds, activeNodeId, activeEdgeId, highlighted, showLabels }), [en, selectedId, centerId, draftIds, activeNodeId, activeEdgeId, highlighted, showLabels]);
  const nodeIndex = useMemo(() => new Map(model.nodes.map(node => [node.id, node])), [model.nodes]);
  const edgeIndex = useMemo(() => new Map(model.edges.map(edge => [edge.id, edge])), [model.edges]);
  const relations = useMemo(() => [...new Set(data.links.map(edge => edge.kind))].sort(), [data.links]);
  const focused = activeNodeId ? nodeIndex.get(activeNodeId) : undefined;
  const inspectedEdge = activeEdgeId ? edgeIndex.get(activeEdgeId) : undefined;
  const focusId = centerId && nodeIndex.has(centerId) ? centerId : selectedId && nodeIndex.has(selectedId) ? selectedId : undefined;
  const ready = initialized && flow.viewportInitialized && width > 0 && height > 0;
  const ariaLabelConfig = useMemo<Partial<AriaLabelConfig>>(() => ({
    'node.a11yDescription.default': en ? 'Press Enter or Space to open this entity. Dragging changes only this view. Relationships cannot be edited.' : '按 Enter 或空格打开实体。拖动只改变当前画布位置，不能编辑业务关系。',
    'node.a11yDescription.keyboardDisabled': en ? 'Press Enter or Space to open this entity.' : '按 Enter 或空格打开实体。',
    'node.a11yDescription.ariaLiveMessage': ({ x, y }) => en ? `View position: ${x}, ${y}` : `画布位置：${x}，${y}`,
    'edge.a11yDescription.default': en ? 'Read-only directed relationship. Focus shows its type and endpoints. Relationships cannot be edited or deleted.' : '只读有向关系。聚焦显示类型及端点，不能修改或删除业务关系。',
    'minimap.ariaLabel': en ? 'Graph minimap: drag to pan, scroll to zoom' : '图谱缩略图：拖动平移，滚轮缩放',
    'handle.ariaLabel': en ? 'Read-only relationship endpoint' : '只读关系端点',
  }), [en]);
  const requestLayout = (nextDirection = direction) => {
    markInteraction();
    setSettings(previous => ({ direction: nextDirection, attempt: previous.attempt + 1 }));
  };
  const fitAll = () => {
    markInteraction();
    if (ready) void fitGraph(160);
  };
  const centerFocus = () => {
    if (!ready || !focusId) return;
    markInteraction();
    const node = flow.getNode(focusId);
    if (node) void flow.setCenter(node.position.x + GRAPH_NODE_WIDTH / 2, node.position.y + GRAPH_NODE_HEIGHT / 2, { zoom: Math.max(.75, flow.getZoom()), duration: 180 });
  };
  useEffect(() => {
    if (!focusRequest || !ready) return;
    const node = flow.getNode(focusRequest.id);
    if (!node) return;
    markInteraction();
    void flow.setCenter(node.position.x + GRAPH_NODE_WIDTH / 2, node.position.y + GRAPH_NODE_HEIGHT / 2, { zoom: Math.max(.75, flow.getZoom()), duration: 180 });
  }, [focusRequest, ready, flow, markInteraction]);

  return <PresentationContext.Provider value={presentation}><div className={`kg-canvas kg-flow-canvas${embedded ? ' kg-flow-embedded' : ''}`}>
    <div className="kg-flow-surface" ref={surface} onPointerDownCapture={markInteraction} onWheelCapture={markInteraction}
      onFocusCapture={event => { const element = focusedElement(event.target); if (!element) return; markInteraction(); if (element.classList.contains('react-flow__node')) { setFocusNodeId(element.getAttribute('data-id') ?? undefined); setFocusEdgeId(undefined); } else { setFocusEdgeId(element.getAttribute('data-id') ?? undefined); setFocusNodeId(undefined); } }}
      onBlurCapture={event => { const next = focusedElement(event.relatedTarget); if (!next || !event.currentTarget.contains(next)) { setFocusNodeId(undefined); setFocusEdgeId(undefined); } }}
      onKeyDownCapture={event => { const element = focusedElement(event.target); if (!element) return; if (event.key === 'Escape') { (element as HTMLElement).blur(); return; } if (element.classList.contains('react-flow__node') && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation(); const id = element.getAttribute('data-id'); if (id && nodeIndex.has(id) && !event.repeat) onSelect(id); } }}>
      <ReactFlow<GraphFlowNode, GraphFlowEdge>
        className="kg-react-flow"
        nodes={current.nodes} edges={model.edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange}
        defaultViewport={cache.viewport} minZoom={.01} maxZoom={3} aria-label={en ? 'Interactive entity relationship graph' : '可交互实体关系图'} ariaLabelConfig={ariaLabelConfig}
        nodesConnectable={false} edgesReconnectable={false} connectOnClick={false} deleteKeyCode={null} selectionKeyCode={null} multiSelectionKeyCode={null} elementsSelectable={false} nodesFocusable edgesFocusable
        nodesDraggable selectNodesOnDrag={false} nodeDragThreshold={5} nodeClickDistance={3} autoPanOnNodeFocus autoPanOnNodeDrag={false} zoomOnDoubleClick={false}
        onNodeClick={(_event, node) => { const previousDrag = drag.current; if (previousDrag?.id === node.id && (previousDrag.until === Infinity || performance.now() < previousDrag.until)) return; onSelect(node.id); }}
        onNodeDragStart={(_event, node) => { markInteraction(); drag.current = { id: node.id, until: Infinity }; }}
        onNodeDragStop={(_event, node) => { drag.current = { id: node.id, until: performance.now() + 300 }; if (cacheIsCurrent()) cache.positions.set(node.id, { ...node.position }); }}
        onNodeMouseEnter={(_event, node) => { setHoverNodeId(node.id); setHoverEdgeId(undefined); }} onNodeMouseLeave={() => setHoverNodeId(undefined)}
        onEdgeMouseEnter={(_event, edge) => { setHoverEdgeId(edge.id); setHoverNodeId(undefined); }} onEdgeMouseLeave={() => setHoverEdgeId(undefined)}
        onEdgeClick={(_event, edge) => { markInteraction(); setHoverEdgeId(edge.id); setHoverNodeId(undefined); }}
        onPaneClick={() => { setHoverNodeId(undefined); setHoverEdgeId(undefined); }}
        onMoveStart={event => { if (event) markInteraction(); }}
        onMoveEnd={(_event, viewport) => { if (cacheIsCurrent()) cache.viewport = { ...viewport }; setZoom(previous => previous === viewport.zoom ? previous : viewport.zoom); }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--kg-flow-grid)" />
        <Panel position="top-right" className="kg-flow-menus" role="group" aria-label={en ? 'Canvas layout and display' : '画布布局与显示'}>
          <details className="kg-flow-menu">
            <summary>{en ? 'Layout' : '布局'}</summary>
            <div className="kg-flow-menu-body">
              <div className="kg-flow-directions" role="group" aria-label={en ? 'Automatic layout direction' : '自动布局方向'}><button type="button" aria-pressed={direction === 'RIGHT'} onClick={() => requestLayout('RIGHT')}>{en ? 'Horizontal' : '横向'}</button><button type="button" aria-pressed={direction === 'DOWN'} onClick={() => requestLayout('DOWN')}>{en ? 'Vertical' : '纵向'}</button></div>
              <button type="button" onClick={() => requestLayout()}>{en ? 'Relayout' : '重新布局'}</button>
            </div>
          </details>
          <details className="kg-flow-menu">
            <summary>{en ? 'Display' : '显示'}</summary>
            <div className="kg-flow-menu-body">
              <button type="button" aria-pressed={showLabels} onClick={() => setShowLabels(value => !value)}>{en ? 'Edge labels' : '关系标签'}</button>
              <button type="button" aria-pressed={showMiniMap} onClick={() => setShowMiniMap(value => !value)}>{en ? 'Minimap' : '缩略图'}</button>
            </div>
          </details>
        </Panel>
        <Panel position="bottom-left" className="kg-flow-actions" role="group" aria-label={en ? 'Graph navigation' : '图谱导航'}>
          <div className="kg-flow-zoom" role="group" aria-label={en ? 'Zoom' : '缩放'}>
            <button type="button" disabled={!ready} aria-label={en ? 'Zoom out' : '缩小'} onClick={() => { markInteraction(); void flow.zoomOut({ duration: 120 }); }}>−</button>
            <button type="button" disabled={!ready} aria-label={en ? 'Zoom in' : '放大'} onClick={() => { markInteraction(); void flow.zoomIn({ duration: 120 }); }}>+</button>
          </div>
          <button type="button" disabled={!ready} onClick={fitAll}>{en ? 'Fit all' : '适配全部'}</button>
          <button type="button" disabled={!ready || !focusId} onClick={centerFocus}>{en ? 'Center focus' : '定位中心'}</button>
          <output aria-label={en ? 'Zoom level' : '缩放比例'}>{Math.round(zoom * 100)}%</output>
          {relations.length > 0 && <details className="kg-flow-legend"><summary>{en ? 'Legend' : '图例'} · {relations.length}</summary><ul>{relations.map(kind => { const style = relationStyle(kind); return <li key={kind}><svg width="38" height="14" viewBox="0 0 38 14" aria-hidden="true"><path d="M 1 7 H 31" fill="none" stroke={style.color} strokeWidth={style.width} strokeDasharray={style.dash} /><path d="m 30 3 6 4-6 4Z" fill={style.color} /></svg><span>{kind}</span></li>; })}</ul></details>}
        </Panel>
        {showMiniMap && <MiniMap<GraphFlowNode> position="bottom-right" pannable zoomable nodeColor={node => `var(--kg-${node.data.entity.entity})`} nodeStrokeColor="var(--kg-background)" nodeStrokeWidth={2} bgColor="var(--kg-background)" maskColor="var(--kg-flow-minimap-mask)" maskStrokeColor="var(--kg-accent)" ariaLabel={en ? 'Graph minimap: drag to pan, scroll to zoom' : '图谱缩略图：拖动平移，滚轮缩放'} />}
      </ReactFlow>
      {current.status === 'loading' && <div className="kg-flow-layout-status" role="status">{en ? 'Arranging entities… You can still pan, zoom, and drag.' : '正在排列实体…仍可平移、缩放及拖动。'}</div>}
      {current.status === 'error' && <div className="kg-flow-layout-status kg-flow-layout-error" role="alert"><strong>{en ? 'Automatic layout failed' : '自动布局失败'}</strong><span>{en ? 'Showing a draggable grid, or retained positions. Graph facts are unchanged.' : '正在显示可拖动网格或保留位置，图谱事实未改变。'}</span><details><summary>{en ? 'Error details' : '错误详情'}</summary><p>{current.error}</p></details><button type="button" onClick={() => requestLayout()}>{en ? 'Retry layout' : '重试布局'}</button></div>}
      {(focused || inspectedEdge) && <div className="kg-flow-info" aria-live="polite">{focused ? <><strong>{focused.data.entity.id} · {focused.data.entity.title}</strong><span>{nodeDescription(focused.data.entity, focused.data.degree, en, !!draftIds?.has(focused.id))}</span></> : inspectedEdge ? <><strong>{inspectedEdge.data?.kind}</strong><span>{inspectedEdge.source} → {inspectedEdge.target}</span></> : null}</div>}
    </div>
  </div></PresentationContext.Provider>;
}

export default function KnowledgeGraphCanvas(props: CanvasProps) {
  return <ReactFlowProvider><GraphCanvasBody {...props} /></ReactFlowProvider>;
}
