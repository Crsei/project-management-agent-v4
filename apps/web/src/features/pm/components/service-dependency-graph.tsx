import { useEffect, useId, useMemo, useState } from "react"
import { Background, Controls, MarkerType, Position, ReactFlow, useNodesState, type Edge, type Node } from "@xyflow/react"
import ELK from "elkjs/lib/elk-api.js"
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url"
import "@xyflow/react/dist/style.css"
import type { Entity } from "@contracts"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n-provider"

type Props = {
  items: Entity[]
  onOpen: (item: Entity) => void
  onAdd?: (item: Entity, prerequisiteId: string) => void
  onRemove?: (item: Entity, prerequisiteId: string) => void
  pending?: boolean
}

function prerequisites(item: Entity): string[] {
  return Array.isArray(item.data.prerequisiteIds)
    ? item.data.prerequisiteIds.filter((id): id is string => typeof id === "string")
    : []
}
const title = (item: Entity) => typeof item.data.title === "string" ? item.data.title : item.id
const field = "min-h-9 rounded-control border border-border bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"

export function ServiceDependencyGraph({ items, onOpen, onAdd, onRemove, pending = false }: Props) {
  const { locale } = useI18n()
  const en = locale === "en"
  const id = useId()
  const [selectedId, setSelectedId] = useState("")
  const [prerequisiteId, setPrerequisiteId] = useState("")
  const [layoutAttempt, setLayoutAttempt] = useState(0)
  const [layoutState, setLayoutState] = useState<"loading" | "ready" | "error">("loading")
  const [layoutError, setLayoutError] = useState("")
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const byId = useMemo(() => new Map(items.map(item => [item.id, item])), [items])
  const selected = byId.get(selectedId)
  const edges = useMemo<Edge[]>(() => items.flatMap(item => prerequisites(item)
    .filter(prerequisite => byId.has(prerequisite))
    .map(prerequisite => ({ id: `${prerequisite}:${item.id}`, source: prerequisite, target: item.id,
      markerEnd: { type: MarkerType.ArrowClosed }, ariaLabel: `${title(byId.get(prerequisite)!)} → ${title(item)}` }))), [items, byId])
  const missing = useMemo(() => items.flatMap(item => prerequisites(item)
    .filter(prerequisite => !byId.has(prerequisite))
    .map(prerequisite => ({ item, prerequisite }))), [items, byId])

  useEffect(() => {
    let cancelled = false
    const elk = new ELK({ workerFactory: () => new Worker(elkWorkerUrl) })
    setLayoutState("loading")
    setLayoutError("")
    const initial: Node[] = items.map((item, index) => ({
      id: item.id, position: { x: (index % 3) * 280, y: Math.floor(index / 3) * 130 },
      sourcePosition: Position.Right, targetPosition: Position.Left,
      style: { width: 230, minHeight: 76, color: "var(--foreground)", background: "var(--surface)", borderColor: "var(--border)" },
      data: { label: <button type="button" className="nodrag nopan w-full rounded-control p-1 text-left focus-visible:outline-2 focus-visible:outline-ring" onClick={() => onOpen(item)}>
        <span className="block truncate font-medium">{title(item)}</span>
        <span className="block text-xs text-muted-foreground">{String(item.data.status ?? "")}</span>
      </button> },
    }))
    setNodes(initial)
    void elk.layout({ id: "root", layoutOptions: { "elk.algorithm": "layered", "elk.direction": "RIGHT", "elk.spacing.nodeNode": "45", "elk.layered.spacing.nodeNodeBetweenLayers": "70" },
      children: items.map(item => ({ id: item.id, width: 230, height: 76 })),
      edges: edges.map(edge => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
    }).then(result => {
      if (cancelled) return
      const positions = new Map(result.children?.map(node => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]))
      setNodes(initial.map(node => ({ ...node, position: positions.get(node.id) ?? node.position })))
      setLayoutState("ready")
    }).catch((error: unknown) => {
      if (cancelled) return
      setLayoutState("error")
      setLayoutError(error instanceof Error ? error.message : String(error))
    })
    return () => { cancelled = true; elk.terminateWorker() }
  }, [items, edges, onOpen, layoutAttempt, setNodes])

  const candidates = selected ? items.filter(item => item.projectId === selected.projectId && item.id !== selected.id && !prerequisites(selected).includes(item.id)) : []
  const selectedNodes = useMemo(() => nodes.map(node => ({ ...node, selected: node.id === selectedId })), [nodes, selectedId])

  return <section className="space-y-3" aria-label={en ? "Work item dependencies" : "任务依赖"}>
    <p className="text-sm text-muted-foreground">{en ? "Arrows run from prerequisite to dependent. Select a node to manage dependencies; open its title to view the task. Server rules validate cycles and permissions." : "箭头从前置任务指向依赖任务。选择节点管理依赖，点击标题查看任务。循环与权限由服务端校验。"}</p>
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={`${id}-item`}>{en ? "Selected task" : "选中任务"}</label>
      <select id={`${id}-item`} className={field} value={selected?.id ?? ""} onChange={event => { setSelectedId(event.target.value); setPrerequisiteId("") }}>
        <option value="">{en ? "Select a task" : "选择任务"}</option>
        {items.map(item => <option key={item.id} value={item.id}>{title(item)}</option>)}
      </select>
      {selected && <Button variant="outline" onClick={() => onOpen(selected)}>{en ? "Open task" : "打开任务"}</Button>}
      <Button variant="outline" onClick={() => setLayoutAttempt(value => value + 1)} disabled={layoutState === "loading"}>{en ? "Auto layout" : "自动布局"}</Button>
      <span role="status" className="text-sm">{layoutState === "loading" ? (en ? "Computing layout…" : "正在计算布局…") : selected ? `${en ? "Selected:" : "已选择："} ${title(selected)}` : ""}</span>
    </div>
    {layoutState === "error" && <p role="alert" className="text-sm text-destructive">{en ? "Automatic layout failed; showing a movable grid. Retry with Auto layout." : "自动布局失败，当前显示可移动网格。可点击自动布局重试。"} {layoutError}</p>}
    {items.length === 0 ? <p className="p-8 text-sm text-muted-foreground">{en ? "No work items." : "暂无任务。"}</p> : <div className="h-[440px] rounded-panel border border-border">
      <ReactFlow key={layoutState === "loading" ? "loading" : `layout-${layoutAttempt}`} nodes={selectedNodes} edges={edges} onNodesChange={onNodesChange} onNodeClick={(_, node) => { setSelectedId(node.id); setPrerequisiteId("") }} onNodeDoubleClick={(_, node) => { const item = byId.get(node.id); if (item) onOpen(item) }} fitView nodesConnectable={false} deleteKeyCode={null} minZoom={0.1} maxZoom={2}>
        <Background /><Controls showInteractive={false} />
      </ReactFlow>
    </div>}
    {missing.length > 0 && <div className="rounded-control border border-border p-3 text-sm"><p>{en ? "Some prerequisites are unavailable in this authorized collection and are not drawn:" : "部分前置任务不在当前授权集合中，因此未绘制："}</p><ul>{missing.map(({ item, prerequisite }, index) => <li key={`${item.id}:${prerequisite}`}>{title(item)} ← {en ? `Unavailable prerequisite ${index + 1}` : `不可用前置任务 ${index + 1}`}</li>)}</ul></div>}
    {selected && <div className="space-y-3 rounded-panel border border-border p-3">
      <h3 className="font-medium">{en ? "Prerequisites" : "前置任务"} · {title(selected)}</h3>
      <ul className="space-y-2">{prerequisites(selected).map((prerequisite, index) => { const label = byId.has(prerequisite) ? title(byId.get(prerequisite)!) : en ? `Unavailable prerequisite ${index + 1}` : `不可用前置任务 ${index + 1}`; return <li key={prerequisite} className="flex items-center justify-between gap-3 text-sm"><span>{label}</span>{onRemove && <Button variant="outline" disabled={pending} aria-label={`${en ? "Remove prerequisite" : "移除前置任务"} ${label}`} onClick={() => onRemove(selected, prerequisite)}>{en ? "Remove" : "移除"}</Button>}</li> })}</ul>
      {prerequisites(selected).length === 0 && <p className="text-sm text-muted-foreground">{en ? "No prerequisites." : "无前置任务。"}</p>}
      {onAdd ? <form className="flex flex-wrap items-center gap-2" onSubmit={event => { event.preventDefault(); if (!pending && candidates.some(item => item.id === prerequisiteId)) onAdd(selected, prerequisiteId) }}>
        <label htmlFor={`${id}-prerequisite`}>{en ? "Add prerequisite" : "添加前置任务"}</label>
        <select id={`${id}-prerequisite`} className={field} value={prerequisiteId} onChange={event => setPrerequisiteId(event.target.value)} disabled={pending} required><option value="">{en ? "Choose a task in this project" : "选择同项目任务"}</option>{candidates.map(item => <option key={item.id} value={item.id}>{title(item)}</option>)}</select>
        <Button type="submit" disabled={pending || !candidates.some(item => item.id === prerequisiteId)}>{en ? "Add" : "添加"}</Button>
      </form> : <p className="text-sm text-muted-foreground">{en ? "Dependency creation is unavailable with your current access." : "当前权限不可添加依赖。"}</p>}
    </div>}
  </section>
}
