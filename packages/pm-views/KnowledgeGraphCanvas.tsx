import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { ForceGraphMethods, LinkObject, NodeObject } from 'react-force-graph-2d';
import { entityDefinitions, entityKinds } from '../pm-schema/index.ts';
import type { EntityKind } from '../pm-schema/index.ts';
import type { GraphData, GraphLink, GraphNode } from '../pm-schema/graph.ts';

interface CanvasProps {
  data: GraphData;
  selectedId?: string;
  centerId?: string;
  draftIds?: Set<string>;
  en: boolean;
  embedded: boolean;
  onSelect: (id: string) => void;
}
type LayoutNode = GraphNode & { degree: number; radius: number };
type LayoutLink = Omit<GraphLink, 'source' | 'target'>;
type CanvasNode = NodeObject<LayoutNode>;
type CanvasLink = LinkObject<LayoutNode, LayoutLink>;
type Palette = Record<EntityKind, string> & { text: string; background: string; link: string; linkMuted: string; accent: string; warning: string };
const fallbackPalette: Palette = { project: '#8b5cf6', work_item: '#3b82f6', document: '#14b8a6', cycle: '#f59e0b', milestone: '#ec4899', module: '#06b6d4', requirement: '#f97316', release: '#22c55e', goal: '#a855f7', text: '#334155', background: '#ffffff', link: '#94a3b8', linkMuted: 'rgba(127,127,127,.16)', accent: '#3b82f6', warning: '#d97706' };
function endpointId(endpoint: CanvasLink['source']): string { return typeof endpoint === 'object' && endpoint !== null ? endpoint.id : String(endpoint ?? ''); }

export default function KnowledgeGraphCanvas({ data, selectedId, centerId, draftIds, en, embedded, onSelect }: CanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const graph = useRef<ForceGraphMethods<CanvasNode, CanvasLink> | undefined>(undefined);
  const fitted = useRef<GraphData | undefined>(undefined);
  const interacted = useRef(false);
  const [dimensions, setDimensions] = useState({ width: 1, height: embedded ? 340 : 440 });
  const [palette, setPalette] = useState(fallbackPalette);
  const [hoverId, setHoverId] = useState<string>();
  const [hoverLink, setHoverLink] = useState<CanvasLink>();
  const [showLabels, setShowLabels] = useState(true);
  const [zoom, setZoom] = useState(1);
  const fitPadding = dimensions.width < 400 ? 60 : 72;
  const layout = useMemo(() => {
    const neighbors = new Map<string, Set<string>>(data.nodes.map(node => [node.id, new Set<string>()]));
    data.links.forEach(link => { neighbors.get(link.source)?.add(link.target); neighbors.get(link.target)?.add(link.source); });
    // d3 mutates positions, velocities and link endpoints. None of those objects
    // may be the DTOs shared with a query cache or the embedded graph builder.
    const nodes: LayoutNode[] = data.nodes.map(node => {
      const degree = neighbors.get(node.id)?.size ?? 0;
      return { ...node, degree, radius: 4 + Math.min(7, Math.sqrt(degree) * 1.8) };
    });
    const links: CanvasLink[] = data.links.map(link => ({ ...link }));
    return { nodes, links, neighbors };
  }, [data]);
  const highlighted = useMemo(() => hoverId ? new Set([hoverId, ...(layout.neighbors.get(hoverId) ?? [])]) : undefined, [hoverId, layout]);
  const hovered = layout.nodes.find(node => node.id === hoverId);

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    function measure() {
      const width = Math.max(1, Math.floor(element!.clientWidth));
      const height = Math.max(1, Math.floor(element!.clientHeight));
      setDimensions(previous => previous.width === width && previous.height === height ? previous : { width, height });
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    function readTheme() {
      const style = getComputedStyle(element!);
      const next = { ...fallbackPalette };
      entityKinds.forEach(kind => { next[kind] = style.getPropertyValue(`--kg-${kind}`).trim() || fallbackPalette[kind]; });
      (['text', 'background', 'link', 'linkMuted', 'accent', 'warning'] as const).forEach(key => {
        const variable = key === 'linkMuted' ? 'link-muted' : key;
        next[key] = style.getPropertyValue(`--kg-${variable}`).trim() || fallbackPalette[key];
      });
      setPalette(previous => Object.keys(next).every(key => previous[key as keyof Palette] === next[key as keyof Palette]) ? previous : next);
    }
    readTheme();
    const observer = new MutationObserver(readTheme);
    for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) observer.observe(ancestor, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', readTheme);
    return () => { observer.disconnect(); media.removeEventListener('change', readTheme); };
  }, []);

  useEffect(() => {
    fitted.current = undefined;
    interacted.current = false;
    setHoverId(undefined);
    setHoverLink(undefined);
  }, [data]);

  useEffect(() => {
    const instance = graph.current;
    if (!instance) return;
    instance.d3Force('charge')?.strength(-220);
    instance.d3Force('link')?.distance(95);
    instance.d3ReheatSimulation();
  }, [layout]);

  function changeZoom(multiplier: number) {
    if (!graph.current) return;
    interacted.current = true;
    graph.current.zoom(Math.max(.1, Math.min(8, graph.current.zoom() * multiplier)), 200);
  }
  function drawNode(node: CanvasNode, context: CanvasRenderingContext2D, scale: number) {
    const x = node.x ?? 0;
    const y = node.y ?? 0;
    const active = node.id === selectedId || node.id === centerId || node.id === hoverId;
    const visible = !highlighted || highlighted.has(node.id);
    context.save();
    context.globalAlpha = visible ? 1 : .2;
    context.beginPath();
    context.arc(x, y, node.radius, 0, Math.PI * 2);
    context.fillStyle = palette[node.entity];
    context.fill();
    if (node.archived) {
      context.strokeStyle = palette.background;
      context.lineWidth = 1.5 / scale;
      context.beginPath(); context.moveTo(x - node.radius * .6, y); context.lineTo(x + node.radius * .6, y); context.stroke();
    }
    if (active || draftIds?.has(node.id)) {
      context.beginPath();
      context.arc(x, y, node.radius + 3 / scale, 0, Math.PI * 2);
      context.strokeStyle = active ? palette.accent : palette.warning;
      context.lineWidth = (active ? 2 : 1.5) / scale;
      if (draftIds?.has(node.id)) context.setLineDash([3 / scale, 2 / scale]);
      context.stroke();
      context.setLineDash([]);
    }
    if (visible && (active || showLabels && (layout.nodes.length <= 80 || scale >= 1.3))) {
      const fontSize = 11 / scale;
      const title = node.title.length > 42 && !active ? `${node.title.slice(0, 40)}…` : node.title;
      const label = `${node.id} · ${title}`;
      context.font = `${fontSize}px system-ui, sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'top';
      const labelWidth = context.measureText(label).width;
      const labelY = y + node.radius + 5 / scale;
      context.fillStyle = palette.background;
      context.globalAlpha = .9;
      context.fillRect(x - labelWidth / 2 - 3 / scale, labelY - 1 / scale, labelWidth + 6 / scale, fontSize + 3 / scale);
      context.globalAlpha = 1;
      context.fillStyle = palette.text;
      context.fillText(label, x, labelY);
    }
    context.restore();
  }

  return <div className="kg-canvas" ref={container}>
    <div className="kg-canvas-controls" role="group" aria-label={en ? 'Graph viewport controls' : '图谱视口控制'}>
      <button type="button" onClick={() => { interacted.current = true; graph.current?.zoomToFit(300, fitPadding); }}>{en ? 'Fit' : '适配'}</button>
      <button type="button" onClick={() => changeZoom(1 / 1.35)} aria-label={en ? 'Zoom out' : '缩小'}>−</button>
      <output aria-label={en ? 'Zoom level' : '缩放比例'}>{Math.round(zoom * 100)}%</output>
      <button type="button" onClick={() => changeZoom(1.35)} aria-label={en ? 'Zoom in' : '放大'}>+</button>
      <button type="button" aria-pressed={showLabels} onClick={() => setShowLabels(value => !value)}>{en ? 'Labels' : '标签'}</button>
    </div>
    <div className="kg-canvas-image" role="img" onPointerDown={() => { interacted.current = true; }} onWheelCapture={() => { interacted.current = true; }} aria-label={en ? 'Interactive relationship graph. Use accessible node navigation below to open or focus entities with the keyboard.' : '可交互关系图。可使用下方的无障碍节点导航，通过键盘打开或聚焦实体。'}>
      <ForceGraph2D<LayoutNode, LayoutLink>
        ref={graph}
        graphData={layout}
        width={dimensions.width}
        height={dimensions.height}
        backgroundColor={palette.background}
        nodeRelSize={4}
        nodeVal={node => (node.radius / 4) ** 2}
        nodeColor={node => palette[node.entity]}
        nodeCanvasObject={drawNode}
        nodePointerAreaPaint={(node, color, context) => { context.fillStyle = color; context.beginPath(); context.arc(node.x ?? 0, node.y ?? 0, node.radius + 3, 0, Math.PI * 2); context.fill(); }}
        nodeLabel={() => ''}
        linkLabel={() => ''}
        linkColor={link => hoverId ? endpointId(link.source) === hoverId || endpointId(link.target) === hoverId ? palette.accent : palette.linkMuted : palette.link}
        linkWidth={link => hoverId && (endpointId(link.source) === hoverId || endpointId(link.target) === hoverId) ? 2 : 1}
        linkDirectionalArrowLength={3.5}
        linkDirectionalArrowRelPos={1}
        linkCurvature={link => endpointId(link.source) === endpointId(link.target) ? .5 : .12}
        minZoom={.1}
        maxZoom={8}
        warmupTicks={60}
        cooldownTicks={160}
        enableNodeDrag
        enablePanInteraction
        enableZoomInteraction
        onNodeHover={node => { setHoverId(node?.id); setHoverLink(undefined); }}
        onLinkHover={link => { setHoverLink(link ?? undefined); if (link) setHoverId(undefined); }}
        onNodeClick={node => onSelect(node.id)}
        onNodeDrag={() => { interacted.current = true; }}
        onNodeDragEnd={node => { node.fx = node.x; node.fy = node.y; }}
        onZoom={transform => { setZoom(transform.k); }}
        onEngineStop={() => { if (fitted.current !== data && !interacted.current) { fitted.current = data; graph.current?.zoomToFit(300, fitPadding); } }}
      />
    </div>
    <div className="kg-hover-info" aria-live="polite">{hovered ? <><strong>{hovered.id} · {hovered.title}</strong><span>{entityDefinitions[hovered.entity].label}{hovered.status ? ` · ${hovered.status}` : ''} · {hovered.degree} {en ? 'neighbors' : '个邻居'}{hovered.archived ? en ? ' · Archived' : ' · 已归档' : ''}{hovered.stale ? en ? ' · Stale snapshot' : ' · 过期快照' : ''}{draftIds?.has(hovered.id) ? en ? ' · Unsaved draft' : ' · 未保存草稿' : ''}</span></> : hoverLink ? <><strong>{hoverLink.kind}</strong><span>{endpointId(hoverLink.source)} → {endpointId(hoverLink.target)}</span></> : <span>{en ? 'Hover a node to highlight its neighbors; hover a line to inspect its relation type.' : '悬停节点以高亮邻居；悬停连线查看关系类型。'}</span>}</div>
  </div>;
}
