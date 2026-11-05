import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import type { RoadmapNode, RoadmapPlan, RoadmapTask } from '../../../../../../packages/contracts/src/product-roadmap';
export function RoadmapCanvas({ plan, selected, onSelect, onInspect, onMove, tasks, onEdit, onRemove, onAdd, onLayout, taskHref }: {
  plan: RoadmapPlan;
  selected: string | null;
  onSelect: (id: string) => void;
  onInspect?: (id: string) => void;
  onMove?: (id: string, x: number, y: number) => void;
  tasks?: RoadmapTask[];
  onEdit?: (id: string, section: 'outcome' | 'dependencies') => void;
  onRemove?: (id: string) => void;
  onAdd?: () => void;
  onLayout?: () => void;
  taskHref?: (task: RoadmapTask) => string;
}) {
  const [zoom, setZoom] = useState(1);
  const viewport = useRef<HTMLDivElement>(null), drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const width = Math.max(960, ...plan.nodes.map(n => n.x + 290)), height = Math.max(330, ...plan.nodes.map(n => n.y + 180));
  function move(event: React.DragEvent, n: RoadmapNode) {
    const rect = viewport.current?.getBoundingClientRect(), offset = drag.current;
    if (!rect || !offset || !onMove) return;
    const x = Math.round((event.clientX - rect.left - viewport.current!.clientLeft + viewport.current!.scrollLeft) / zoom - offset.dx), y = Math.round((event.clientY - rect.top - viewport.current!.clientTop + viewport.current!.scrollTop) / zoom - offset.dy);
    onMove(n.id, Math.min(6000, Math.max(0, x)), Math.min(6000, Math.max(0, y))); drag.current = null;
  }
  const canvas = <div className="roadmap-canvas" ref={viewport} role="region" aria-label="产品 Roadmap 依赖画布" tabIndex={0} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const node = plan.nodes.find(n => n.id === drag.current?.id); if (node) move(e, node); }}>
    <div style={{ width: width * zoom, height: height * zoom, position: 'relative' }}><div className="roadmap-plane" style={{ width, height, position: 'absolute', transform: `scale(${zoom})`, transformOrigin: 'top left' }}>
      <svg width={width} height={height} aria-hidden="true"><defs><marker id="roadmap-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="currentColor" /></marker></defs>{plan.nodes.flatMap(n => n.dependsOn.map(id => { const from = plan.nodes.find(p => p.id === id); if (!from) return null; const x = from.x + 260, y = from.y + 75; return <path key={`${id}:${n.id}`} d={`M${x},${y} C${x + 45},${y} ${n.x - 45},${n.y + 75} ${n.x - 8},${n.y + 75}`} fill="none" stroke="currentColor" strokeWidth="2" markerEnd="url(#roadmap-arrow)" />; }))}</svg>
      {plan.nodes.map((n, index) => {
        const matches = (tasks ?? []).filter(t => t.nodeId === n.id), task = matches.length === 1 ? matches[0] : undefined;
        return <ContextMenu key={n.id}>
          <ContextMenuTrigger asChild onContextMenu={event => event.stopPropagation()}>
            <article className="roadmap-node" data-selected={selected === n.id} style={{ left: n.x, top: n.y }} tabIndex={0} aria-label={`${tasks ? '发布节点' : '候选任务'}：${n.title || '未命名'}`}>
              <div className="roadmap-node-grip" draggable={!!onMove} onDragStart={e => { const rect = e.currentTarget.parentElement!.getBoundingClientRect(); drag.current = { id: n.id, dx: (e.clientX - rect.left) / zoom, dy: (e.clientY - rect.top) / zoom }; e.dataTransfer.setData('text/plain', n.id); }} onDragEnd={() => { drag.current = null; }}><span>{n.stage || '未分阶段'}</span><span>{onMove ? '⠿' : `#${index + 1}`}</span></div>
              <button type="button" className="roadmap-node-select" aria-label={`选择任务：${n.title || '未命名'}`} onClick={() => onSelect(n.id)}><strong>{n.title || '未命名任务'}</strong><span>{n.outcome || '请明确要交付的成果'}</span></button>
              <footer>{matches.length > 1 ? '关联冲突' : task ? `${task.taskId} · ${task.archived ? '已归档' : task.status}${task.drifted ? ' · 需求已变更' : ''}` : tasks ? '候选 · 未创建' : '规划草稿'}<span>{n.dependsOn.length ? `${n.dependsOn.length} 个前置` : '起点'}</span></footer>
            </article>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuLabel>{tasks ? '已发布 · 冻结快照' : n.title || '未命名候选任务'}</ContextMenuLabel>
            <ContextMenuItem onSelect={() => (onInspect ?? onSelect)(n.id)}>{tasks ? '查看冻结成果与验收' : '查看节点详情'}</ContextMenuItem>
            {task && taskHref && <ContextMenuItem asChild><Link to={taskHref(task)}>打开关联任务 · {task.taskId}</Link></ContextMenuItem>}
            {!tasks && onEdit && <><ContextMenuSeparator /><ContextMenuItem onSelect={() => onEdit(n.id, 'outcome')}>编辑任务成果</ContextMenuItem><ContextMenuItem onSelect={() => onEdit(n.id, 'dependencies')}>调整前置依赖</ContextMenuItem></>}
            {!tasks && onRemove && <><ContextMenuSeparator /><ContextMenuItem className="text-destructive" onSelect={() => onRemove(n.id)}>移除候选…</ContextMenuItem></>}
          </ContextMenuContent>
        </ContextMenu>;
      })}
      {!plan.nodes.length && <p className="roadmap-canvas-empty">先描述用户流程，再生成候选任务。画布连接的是产品成果，不是开发步骤。</p>}
    </div></div>
  </div>;
  return <>
    <div className="roadmap-canvas-tools" role="group" aria-label="画布缩放"><button onClick={() => setZoom(v => Math.max(.25, v - .1))} aria-label="缩小画布">−</button><span>{Math.round(zoom * 100)}%</span><button onClick={() => setZoom(v => Math.min(1.5, v + .1))} aria-label="放大画布">+</button><button onClick={() => setZoom(Math.max(.25, Math.min(1, ((viewport.current?.clientWidth ?? width) - 20) / width)))}>适配画布</button><button onClick={() => setZoom(1)}>100%</button></div>
    {onAdd || onLayout ? <ContextMenu>
      <ContextMenuTrigger asChild>{canvas}</ContextMenuTrigger>
      <ContextMenuContent>
        {onAdd && <ContextMenuItem disabled={plan.nodes.length >= 24} title={plan.nodes.length >= 24 ? '最多 24 个候选任务' : undefined} onSelect={onAdd}>添加候选任务</ContextMenuItem>}
        {onLayout && <ContextMenuItem onSelect={onLayout}>自动布局</ContextMenuItem>}
      </ContextMenuContent>
    </ContextMenu> : canvas}
  </>;
}
