import { useRef, useState } from 'react';
import type { RoadmapNode, RoadmapPlan, RoadmapTask } from '../../../../../../packages/contracts/src/product-roadmap';
export function RoadmapCanvas({ plan, selected, onSelect, onMove, tasks, statuses }: { plan: RoadmapPlan; selected: string | null; onSelect: (id: string) => void; onMove?: (id: string, x: number, y: number) => void; tasks?: RoadmapTask[]; statuses?: Record<string,string> }) {
  const [zoom, setZoom] = useState(1);
  const viewport = useRef<HTMLDivElement>(null), drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const width = Math.max(960, ...plan.nodes.map(n => n.x + 290)), height = Math.max(330, ...plan.nodes.map(n => n.y + 180));
  function move(event: React.DragEvent, n: RoadmapNode) {
    const rect = viewport.current?.getBoundingClientRect(), offset = drag.current;
    if (!rect || !offset || !onMove) return;
    const x = Math.round((event.clientX - rect.left - viewport.current!.clientLeft + viewport.current!.scrollLeft) / zoom - offset.dx), y = Math.round((event.clientY - rect.top - viewport.current!.clientTop + viewport.current!.scrollTop) / zoom - offset.dy);
    onMove(n.id, Math.min(6000, Math.max(0, x)), Math.min(6000, Math.max(0, y))); drag.current = null;
  }
  return <><div className="roadmap-canvas-tools" role="group" aria-label="画布缩放"><button onClick={() => setZoom(v => Math.max(.25, v - .1))} aria-label="缩小画布">−</button><span>{Math.round(zoom * 100)}%</span><button onClick={() => setZoom(v => Math.min(1.5, v + .1))} aria-label="放大画布">+</button><button onClick={() => setZoom(Math.max(.25, Math.min(1, ((viewport.current?.clientWidth ?? width) - 20) / width)))}>适配画布</button><button onClick={() => setZoom(1)}>100%</button></div><div className="roadmap-canvas" ref={viewport} role="region" aria-label="产品 Roadmap 依赖画布" tabIndex={0} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const node = plan.nodes.find(n => n.id === drag.current?.id); if (node) move(e, node); }}>
    <div style={{ width: width * zoom, height: height * zoom, position: 'relative' }}><div className="roadmap-plane" style={{ width, height, position: 'absolute', transform: `scale(${zoom})`, transformOrigin: 'top left' }}>
      <svg width={width} height={height} aria-hidden="true"><defs><marker id="roadmap-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="currentColor" /></marker></defs>{plan.nodes.flatMap(n => n.dependsOn.map(id => { const from = plan.nodes.find(p => p.id === id); if (!from) return null; const x = from.x + 260, y = from.y + 75; return <path key={`${id}:${n.id}`} d={`M${x},${y} C${x + 45},${y} ${n.x - 45},${n.y + 75} ${n.x - 8},${n.y + 75}`} fill="none" stroke="currentColor" strokeWidth="2" markerEnd="url(#roadmap-arrow)" />; }))}</svg>
      {plan.nodes.map((n, index) => { const matches = (tasks ?? []).filter(t => t.nodeId === n.id), task = matches.length === 1 ? matches[0] : undefined; return <article key={n.id} className="roadmap-node" data-selected={selected === n.id} style={{ left: n.x, top: n.y }}>
        <div className="roadmap-node-grip" draggable={!!onMove} onDragStart={e => { const rect = e.currentTarget.parentElement!.getBoundingClientRect(); drag.current = { id: n.id, dx: (e.clientX - rect.left) / zoom, dy: (e.clientY - rect.top) / zoom }; e.dataTransfer.setData('text/plain', n.id); }} onDragEnd={() => { drag.current = null; }}><span>{`功能 ${String(index + 1).padStart(2, '0')}`}</span><span>{onMove ? '⠿' : `#${index + 1}`}</span></div>
        <button type="button" className="roadmap-node-select" aria-label={`选择功能：${n.title || '未命名'}`} onClick={() => onSelect(n.id)}><strong>{n.title || '未命名功能'}</strong><span>{n.outcome || '描述用户能做什么'}</span></button>
        <footer>{statuses?.[n.id] ? statuses[n.id] : matches.length > 1 ? '关联冲突' : task ? `${task.taskId} · ${task.archived ? '已归档' : task.status}${task.drifted ? ' · 需求已变更' : ''}` : tasks ? '候选 · 未创建' : '功能草稿'}<span>{n.dependsOn.length ? `${n.dependsOn.length} 个前置` : '起点'}</span></footer>
      </article>; })}
      {!plan.nodes.length && <p className="roadmap-canvas-empty">先描述用户流程，再生成产品功能。连线表示功能之间的前置关系。</p>}
    </div></div>
  </div></>;
}
