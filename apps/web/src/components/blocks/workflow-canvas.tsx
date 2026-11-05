import { useI18n } from "../../lib/i18n-provider"

import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  type AriaLabelConfig,
  ReactFlow,
  ReactFlowProvider,
  Background,
  MiniMap,
  Panel,
  MarkerType,
  ViewportPortal,
  useReactFlow,
  useViewport,
  useNodesInitialized,
  useStoreApi,
  type Node,
  type NodeProps,
  type Edge,
  type NodeChange,
  type NodePositionChange,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { Hand, MousePointer2, Scan, ZoomIn, ZoomOut } from "lucide-react"
import { Button } from "../ui/button"
import { ContextMenuItem, ContextMenuPopup, isNativeContextTarget, useContextMenu } from "../ui/context-menu"
import { CanvasNode, type CanvasNodeProps } from "../ui/canvas-node"
import { CanvasEdge } from "../ui/canvas-edge"
import { CanvasFrame } from "./canvas-frame"
import { CanvasNote } from "./canvas-note"
import {
  canvasId,
  type CanvasCommand,
  type CanvasDocument,
  type CanvasNodeRecord,
  type CanvasNodeDefinition,
  type CanvasSelection,
  type CanvasIssue,
  type CanvasExecutionSnapshot,
  type CanvasExecutionVisuals,
  type CanvasFrameRecord,
  type CanvasNoteRecord,
  type CanvasPoint,
} from "../../lib/canvas-model"
import type { CanvasMeasurements } from "../../lib/canvas-layout"
import { buildCanvasIndexes } from "../../lib/canvas-index"
import { validateCanvasConnection } from "../../lib/canvas-validation"
import { cn } from "../../lib/utils"
import styles from "./workflow-canvas.module.css"

type FlowNode = Node<
  {
    record: CanvasNodeRecord
    definition?: CanvasNodeDefinition
    readOnly: boolean
    issues: CanvasIssue[]
    status?: string
    executionVisuals?: CanvasExecutionVisuals
    outcome?: "known" | "unknown"
    fallbackPorts: CanvasNodeDefinition["ports"]
    renderNode?: WorkflowCanvasProps["renderNode"]
  },
  "canvas"
>
type FrameNode = Node<
  { frame: CanvasFrameRecord; collapsed?: boolean },
  "frame"
>
type NoteNode = Node<{ note: CanvasNoteRecord }, "note">
type AnyNode = FlowNode | FrameNode | NoteNode
const FlowNodeView = memo(
  function FlowNodeView({ data, selected }: NodeProps<FlowNode>) {
    if (data.renderNode) return data.renderNode({ ...data, node: data.record, selected })
    return <CanvasNode {...data} node={data.record} selected={selected} />
  },
  (a, b) => a.data === b.data && a.selected === b.selected,
)
function FrameView({ data, selected }: NodeProps<FrameNode>) {
  return (
    <CanvasFrame
      frame={data.frame}
      selected={selected}
      collapsed={data.collapsed}
    />
  )
}
function NoteView({ data, selected }: NodeProps<NoteNode>) {
  return <CanvasNote note={data.note} selected={selected} />
}
const nodeTypes = { canvas: FlowNodeView, frame: FrameView, note: NoteView }
const edgeTypes = { canvas: CanvasEdge }
const noIssues: CanvasIssue[] = []
const noFrames: string[] = []
const noPorts: CanvasNodeDefinition["ports"] = []
export type CanvasContextMenuTarget = {
  kind: "node" | "frame" | "note" | "edge" | "pane"
  id?: string
  x: number
  y: number
  origin: "pointer" | "keyboard"
  trigger: HTMLElement | SVGElement
}
export type WorkflowCanvasProps = {
  document: CanvasDocument
  definitions: CanvasNodeDefinition[]
  selection: CanvasSelection
  onSelectionChange: (selection: CanvasSelection) => void
  onCommand?: (command: CanvasCommand) => void
  readOnly?: boolean
  issues?: CanvasIssue[]
  execution?: CanvasExecutionSnapshot
  executionVisuals?: CanvasExecutionVisuals
  onContextMenu?: (target: CanvasContextMenuTarget) => boolean | void
  focusRequest?: { id: string; request: number }
  viewport?: CanvasDocument["viewport"]
  onViewportChange?: (viewport: NonNullable<CanvasDocument["viewport"]>) => void
  onOpenNode?: (nodeId: string) => void
  onMeasurementsChange?: (measurements: CanvasMeasurements) => void
  collapsedFrameIds?: string[]
  className?: string
  renderNode?: (props: CanvasNodeProps) => ReactNode
  showBackground?: boolean
  showMiniMap?: boolean
  controlsVariant?: "default" | "minimal-vertical" | "minimal-horizontal"
  presentation?: "default" | "media"
  toolbarActions?: ReactNode
  defaultInteractionMode?: "pan" | "select"
  nodeDragHandle?: string
  fitViewOptions?: import("@xyflow/react").FitViewOptions
  edgePath?: "bezier" | "smoothstep"
  showEdgeLabels?: boolean
  showEdgeArrows?: boolean
}
export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasViewport {...props} />
    </ReactFlowProvider>
  )
}
function CanvasViewport({
  document,
  definitions,
  selection,
  onSelectionChange,
  onCommand,
  readOnly = false,
  issues = noIssues,
  execution,
  executionVisuals,
  onContextMenu,
  focusRequest,
  className,
  collapsedFrameIds = noFrames,
  viewport,
  onViewportChange,
  onOpenNode,
  onMeasurementsChange,
  renderNode,
  showBackground,
  showMiniMap,
  controlsVariant = "default",
  presentation = "default",
  toolbarActions,
  defaultInteractionMode = presentation === "media" ? "select" : "pan",
  nodeDragHandle,
  fitViewOptions,
  edgePath = "bezier",
  showEdgeLabels = true,
  showEdgeArrows = false,
}: WorkflowCanvasProps) {
  const { t, locale } = useI18n()
  const contextMenu = useContextMenu<CanvasContextMenuTarget>()
  const rightPointer = useRef<{ x: number; y: number; moved: boolean; down: boolean; pending?: CanvasContextMenuTarget } | null>(null)
  function showContext(target: CanvasContextMenuTarget) {
    if (onContextMenu && onContextMenu(target) !== false) {
      contextMenu.close()
      return true
    }
    if (target.kind !== "pane" && (target.kind !== "node" || !target.id || !onOpenNode)) return false
    contextMenu.openAt({ x: target.x, y: target.y }, target, target.trigger)
    return true
  }
  function requestContext(event: { target: EventTarget | null; clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, kind: CanvasContextMenuTarget["kind"], id?: string) {
    if (isNativeContextTarget(event.target) || (kind !== "pane" && !onContextMenu && !(kind === "node" && onOpenNode))) return
    const element = event.target instanceof Element ? event.target.closest<HTMLElement>(".react-flow__node, .react-flow__edge") : null
    const trigger = element ?? surface.current
    if (!trigger) return
    const target: CanvasContextMenuTarget = { kind, id, x: event.clientX, y: event.clientY, origin: "pointer", trigger }
    if (rightPointer.current?.moved) { event.preventDefault(); return }
    if (rightPointer.current?.down) {
      rightPointer.current.pending = target
      event.preventDefault()
      event.stopPropagation()
    } else if (showContext(target)) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  const fitToNodes = () => {
    if (fitViewOptions) void flow.fitView({ duration: 0, ...fitViewOptions })
    else void flow.fitBounds(flow.getNodesBounds(flow.getNodes()), { padding: 0.16, duration: 0 })
  }
  const locked = readOnly || !onCommand
  const latestSelection = useRef(selection)
  const lastSelectionProp = useRef(selection)
  function currentSelection() {
    if (lastSelectionProp.current !== selection) {
      lastSelectionProp.current = selection
      latestSelection.current = selection
    }
    return latestSelection.current
  }
  function publishSelection(next: CanvasSelection) {
    currentSelection()
    latestSelection.current = next
    onSelectionChange(next)
  }
  const [pan, setPan] = useState(defaultInteractionMode === "pan")
  const [positions, setPositions] = useState<{
    revision: number
    values: Record<string, CanvasPoint>
  }>({ revision: -1, values: {} })
  const [dimensions, setDimensions] = useState<
    Record<string, { width: number; height: number }>
  >({})
  useEffect(() => {
    onMeasurementsChange?.(dimensions)
  }, [dimensions, onMeasurementsChange])
  const reconnecting = useRef<string | undefined>(undefined)
  const boxSelecting = useRef(false)
  const ariaLabelConfig = useMemo<Partial<AriaLabelConfig>>(
    () => ({
      "node.a11yDescription.default": t(
        locked ? "canvas.nodeReadOnlyInstructions" : "canvas.nodeInstructions",
      ),
      "node.a11yDescription.keyboardDisabled": t(
        "canvas.nodeReadOnlyInstructions",
      ),
      "node.a11yDescription.ariaLiveMessage": ({ direction, x, y }) =>
        t("canvas.movedNode", {
          direction:
            direction === "left"
              ? t("canvas.left")
              : direction === "right"
                ? t("canvas.right")
                : direction === "up"
                  ? t("canvas.up")
                  : direction === "down"
                    ? t("canvas.down")
                    : direction,
          x,
          y,
        }),
      "edge.a11yDescription.default": t(
        locked ? "canvas.nodeReadOnlyInstructions" : "canvas.edgeInstructions",
      ),
      "controls.ariaLabel": t("canvas.controls"),
      "minimap.ariaLabel": t("canvas.minimap"),
      "handle.ariaLabel": t("canvas.handle"),
    }),
    [locked, t],
  )
  const flow = useReactFlow()
  const { zoom } = useViewport()
  const initialized = useNodesInitialized()
  const surface = useRef<HTMLDivElement>(null)
  const initialFitPending = useRef(!viewport && !document.viewport)
  const store = useStoreApi()
  useEffect(() => {
    const element = surface.current
    if (!element) return
    let wasVisible = false
    let frame = 0
    const measure = () => {
      const visible = Boolean(element.clientWidth && element.clientHeight)
      if (visible && !wasVisible) {
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => {
          if (!element.clientWidth || !element.clientHeight) return
          // The ID-based hook interpolates selectors; entity keys may contain quotes.
          const updates = new Map<string, { id: string; nodeElement: HTMLDivElement; force: boolean }>()
          for (const nodeElement of element.querySelectorAll<HTMLDivElement>(".react-flow__node[data-id]")) {
            const id = nodeElement.dataset.id
            if (id !== undefined) updates.set(id, { id, nodeElement, force: true })
          }
          if (updates.size) store.getState().updateNodeInternals(updates, { triggerFitView: false })
        })
      }
      wasVisible = visible
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [store])
  useEffect(() => {
    if (!initialized || !initialFitPending.current) return
    const element = surface.current
    if (!element) return
    let frame = 0
    const fit = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (!initialFitPending.current || !element.clientWidth || !element.clientHeight) return
        const { width, height } = store.getState()
        // React Flow's ResizeObserver can lag the surrounding flex layout.
        // Do not persist an initial viewport calculated for the previous size.
        if (width !== element.clientWidth || height !== element.clientHeight) return
        initialFitPending.current = false
        void flow.fitView({ duration: 0, ...fitViewOptions })
      })
    }
    const unsubscribe = store.subscribe((next, previous) => {
      if (next.width !== previous.width || next.height !== previous.height) fit()
    })
    const observer = new ResizeObserver(fit)
    observer.observe(element)
    fit()
    return () => {
      observer.disconnect()
      unsubscribe()
      cancelAnimationFrame(frame)
    }
  }, [initialized, flow, fitViewOptions, store])
  useEffect(() => {
    if (!focusRequest || !initialized) return
    const node = flow.getNode(focusRequest.id)
    if (node)
      flow.setCenter(
        node.position.x + (node.measured?.width ?? 240) / 2,
        node.position.y + (node.measured?.height ?? 160) / 2,
        { zoom: 1, duration: 0 },
      )
  }, [flow, focusRequest, initialized])
  const indexes = useMemo(
    () =>
      buildCanvasIndexes(
        {
          nodes: document.nodes,
          frames: document.frames,
          edges: document.edges,
        },
        definitions,
        issues,
      ),
    [document.nodes, document.frames, document.edges, definitions, issues],
  )
  const collapsedIds = useMemo(
    () => new Set(collapsedFrameIds),
    [collapsedFrameIds],
  )
  const selectedNodeIds = useMemo(
    () => new Set(selection.nodeIds),
    [selection.nodeIds],
  )
  const selectedEdgeIds = useMemo(
    () => new Set(selection.edgeIds),
    [selection.edgeIds],
  )
  const dataCache = useRef(new Map<string, FlowNode["data"]>())
  const baseNodes = useMemo<AnyNode[]>(() => {
    const previousData = dataCache.current
    const nextData = new Map<string, FlowNode["data"]>()
    function reuseData(id: string, data: FlowNode["data"]) {
      const previous = previousData.get(id)
      const same =
        previous &&
        (Object.keys(data) as (keyof typeof data)[]).every(
          (key) => previous[key] === data[key],
        )
      const result = same ? previous : data
      nextData.set(id, result)
      return result
    }
    dataCache.current = nextData
    const snapshot =
      execution?.documentId === document.id &&
      execution?.documentRevision === document.revision
        ? execution
        : undefined
    return [
      ...document.frames.map((frame) => ({
        id: frame.id,
        type: "frame" as const,
        position: frame.position,
        style: {
          width: frame.width,
          height: collapsedIds.has(frame.id) ? 64 : frame.height,
          zIndex: -1,
        },
        data: { frame, collapsed: collapsedIds.has(frame.id) },
      })),
      ...document.nodes.map((record) => ({
        id: record.id,
        type: "canvas" as const,
        position: record.position,
        dragHandle: nodeDragHandle,
        ariaLabel: t("common.valueNode", { value0: record.title }),
        hidden: !!record.parentId && collapsedIds.has(record.parentId),
        data: reuseData(record.id, {
          record,
          definition: indexes.definitionByType.get(record.type),
          renderNode,
          readOnly: locked,
          issues: indexes.issuesByNodeId.get(record.id) ?? noIssues,
          status: snapshot?.nodes[record.id]?.status,
          executionVisuals,
          outcome: snapshot?.nodes[record.id]?.outcome,
          fallbackPorts:
            indexes.fallbackPortsByNodeId.get(record.id) ?? noPorts,
        }),
      })),
      ...document.notes.map((note) => ({
        id: note.id,
        type: "note" as const,
        position: note.position,
        data: { note },
      })),
    ]
  }, [document, indexes, execution, executionVisuals, locked, collapsedIds, t, renderNode, nodeDragHandle])
  const nodes = useMemo<AnyNode[]>(
    () =>
      baseNodes.map((node) => {
        const record = indexes.nodeById.get(node.id)
        const frame = record?.parentId
          ? indexes.frameById.get(record.parentId)
          : undefined
        const moving =
          positions.revision === document.revision ? positions.values : {}
        const parentPosition = frame && moving[frame.id]
        return {
          ...node,
          measured: dimensions[node.id],
          position:
            moving[node.id] ??
            (frame && parentPosition
              ? {
                  x: node.position.x + parentPosition.x - frame.position.x,
                  y: node.position.y + parentPosition.y - frame.position.y,
                }
              : node.position),
          selected:
            node.type === "frame"
              ? selection.frameId === node.id
              : node.type === "note"
                ? selection.noteId === node.id
                : selectedNodeIds.has(node.id),
        }
      }),
    [
      baseNodes,
      dimensions,
      document.revision,
      indexes,
      positions,
      selection.frameId,
      selection.noteId,
      selectedNodeIds,
    ],
  )
  const baseEdges = useMemo<Edge[]>(
    () =>
      document.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourcePort,
        targetHandle: edge.targetPort,
        label: showEdgeLabels ? edge.label : undefined,
        ariaLabel: showEdgeLabels ? undefined : `${edge.source} → ${edge.target}${edge.label ? `: ${edge.label}` : ""}`,
        type: "canvas",
        markerEnd: showEdgeArrows ? { type: MarkerType.ArrowClosed, color: "var(--canvas-edge)" } : undefined,
        hidden: [edge.source, edge.target].some((id) => {
          const parentId = indexes.nodeById.get(id)?.parentId
          return !!parentId && collapsedIds.has(parentId)
        }),
        data: {
          executionVisuals,
          edgePath,
          status:
            execution?.documentId === document.id &&
            execution?.documentRevision === document.revision
              ? execution.edges?.[edge.id]?.status
              : undefined,
        },
      })),
    [
      document.edges,
      document.id,
      document.revision,
      indexes,
      execution,
      executionVisuals,
      collapsedIds,
      edgePath,
      showEdgeLabels,
      showEdgeArrows,
    ],
  )
  const edges = useMemo(
    () =>
      baseEdges.map((edge) => ({
        ...edge,
        selected: selectedEdgeIds.has(edge.id),
      })),
    [baseEdges, selectedEdgeIds],
  )
  const renderedNodeById = useMemo(
    () => new Map(nodes.map((node) => [node.id, node])),
    [nodes],
  )
  const guides = useMemo(() => {
    if (positions.revision !== document.revision) return []
    const movingIds = new Set(Object.keys(positions.values)),
      moving = document.nodes.find((node) => movingIds.has(node.id))
    if (!moving) return []
    const point = positions.values[moving.id],
      stationary = document.nodes.filter((node) => !movingIds.has(node.id))
    const x = stationary.find(
      (node) => Math.abs(node.position.x - point.x) <= 8,
    )?.position.x
    const y = stationary.find(
      (node) => Math.abs(node.position.y - point.y) <= 8,
    )?.position.y
    const minX =
        Math.min(...document.nodes.map((node) => node.position.x)) - 32,
      maxX = Math.max(...document.nodes.map((node) => node.position.x)) + 272
    const minY =
        Math.min(...document.nodes.map((node) => node.position.y)) - 32,
      maxY = Math.max(...document.nodes.map((node) => node.position.y)) + 272
    return [
      ...(x === undefined
        ? []
        : [{ axis: "x", x, y: minY, width: 1, height: maxY - minY }]),
      ...(y === undefined
        ? []
        : [{ axis: "y", x: minX, y, width: maxX - minX, height: 1 }]),
    ]
  }, [document, positions])
  const connectionEdge = (
    connection: {
      source: string
      target: string
      sourceHandle?: string | null
      targetHandle?: string | null
    },
    id = canvasId("edge"),
  ) => ({
    id,
    source: connection.source,
    sourcePort: connection.sourceHandle ?? "",
    target: connection.target,
    targetPort: connection.targetHandle ?? "",
  })
  function select(node: AnyNode, additive = false) {
    const current = currentSelection()
    publishSelection(
      node.type === "frame"
        ? { nodeIds: [], edgeIds: [], frameId: node.id }
        : node.type === "note"
          ? { nodeIds: [], edgeIds: [], noteId: node.id }
          : {
              nodeIds: additive
                ? current.nodeIds.includes(node.id)
                  ? current.nodeIds.filter((id) => id !== node.id)
                  : [...current.nodeIds, node.id]
                : [node.id],
              edgeIds: [],
            },
    )
  }
  function changes(changes: NodeChange<AnyNode>[]) {
    const selected = new Set(currentSelection().nodeIds)
    let changed = false
    let hasSelectedNode = false
    for (const change of changes)
      if (change.type === "select") {
        const node = renderedNodeById.get(change.id)
        if (node?.type === "frame" || node?.type === "note") {
          if (change.selected) select(node)
          continue
        }
        changed = true
        if (change.selected) {
          selected.add(change.id)
          hasSelectedNode = true
        } else selected.delete(change.id)
      }
    if (changed) {
      const current = currentSelection()
      publishSelection(hasSelectedNode
        ? { nodeIds: [...selected], edgeIds: current.edgeIds }
        : { ...current, nodeIds: [...selected] })
    }
    // Measurements are temporary engine layout, never graph data or undo history.
    const measured = changes.flatMap((change) =>
      change.type === "dimensions" && change.dimensions
        ? [{ id: change.id, value: change.dimensions }]
        : [],
    )
    if (measured.length)
      setDimensions((current) => {
        const next = { ...current }
        let changed = false
        for (const { id, value } of measured)
          if (
            next[id]?.width !== value.width ||
            next[id]?.height !== value.height
          ) {
            next[id] = value
            changed = true
          }
        return changed ? next : current
      })
    if (locked) return
    const moves = changes.filter(
      (change): change is NodePositionChange =>
        change.type === "position" && !!change.position,
    )
    if (moves.length)
      setPositions((current) => ({
        revision: document.revision,
        values: {
          ...(current.revision === document.revision ? current.values : {}),
          ...Object.fromEntries(
            moves.map((change) => [change.id, change.position!]),
          ),
        },
      }))
  }
  function finishDrag(node: AnyNode, moved: AnyNode[]) {
    if (locked) return
    if (node.type === "frame")
      onCommand?.({
        type: "move-frame",
        frameId: node.id,
        position: node.position,
      })
    else if (node.type === "note")
      onCommand?.({
        type: "move-note",
        noteId: node.id,
        position: node.position,
      })
    else
      onCommand?.({
        type: "move",
        positions: Object.fromEntries(
          moved
            .filter((item) => item.type === "canvas")
            .map((item) => [item.id, item.position]),
        ),
      })
    setPositions({ revision: -1, values: {} })
  }
  return (
    <div ref={surface}
      className={cn(styles.canvas, className)}
      aria-label={t("workflowCanvas.workflowCanvas")}
      data-canvas-ready={initialized}
      data-canvas-editor-context
      tabIndex={0}
      onPointerDownCapture={(event) => {
        if (event.button === 2) rightPointer.current = { x: event.clientX, y: event.clientY, moved: false, down: true }
        if (
          event.target instanceof Element &&
          event.target.closest(".react-flow__pane")
        )
          event.currentTarget.focus({ preventScroll: true })
      }}
      onPointerMoveCapture={event => {
        const pointer = rightPointer.current
        if (pointer && (Math.abs(event.clientX - pointer.x) > 5 || Math.abs(event.clientY - pointer.y) > 5)) pointer.moved = true
      }}
      onPointerUpCapture={event => {
        const pointer = rightPointer.current
        if (!pointer || event.button !== 2) return
        pointer.down = false
        if (pointer.pending) {
          if (!pointer.moved) showContext(pointer.pending)
          rightPointer.current = null
        }
      }}
      onPointerCancel={() => { rightPointer.current = null }}
      onDragOver={(event) => {
        if (
          !locked &&
          event.dataTransfer.types.includes("application/x-pm-workflow-node")
        ) {
          event.preventDefault()
          event.dataTransfer.dropEffect = "copy"
        }
      }}
      onDrop={(event) => {
        event.preventDefault()
        if (locked) return
        const definition = indexes.definitionByType.get(
          event.dataTransfer.getData("application/x-pm-workflow-node"),
        )
        if (definition)
          onCommand?.({
            type: "add",
            node: {
              id: canvasId("node"),
              type: definition.type,
              title: definition.label,
              position: flow.screenToFlowPosition({
                x: event.clientX,
                y: event.clientY,
              }),
              config: structuredClone(definition.defaults),
            },
          })
      }}
      onKeyDownCapture={(event) => {
        if (!event.nativeEvent.isComposing && !isNativeContextTarget(event.target) && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
          const trigger = event.target instanceof Element ? event.target.closest<HTMLElement>(".react-flow__node, .react-flow__edge") ?? event.currentTarget : event.currentTarget
          const id = trigger.dataset.id
          const node = id ? flow.getNode(id) : undefined
          const kind: CanvasContextMenuTarget["kind"] = node?.type === "frame" ? "frame" : node?.type === "note" ? "note" : node ? "node" : trigger.classList.contains("react-flow__edge") ? "edge" : "pane"
          const box = trigger.getBoundingClientRect()
          if (showContext({ kind, id, x: box.left + 8, y: box.bottom, origin: "keyboard", trigger })) {
            event.preventDefault()
            event.stopPropagation()
          }
          return
        }
        if (
          locked ||
          event.nativeEvent.isComposing ||
          !(event.target instanceof Element) ||
          !event.target.closest(".react-flow__node") ||
          event.target.closest(
            "input, textarea, select, [contenteditable=true]",
          )
        )
          return
        if (
          !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(
            event.key,
          )
        )
          return
        event.preventDefault()
        event.stopPropagation()
        const delta = event.shiftKey ? 32 : 8
        const offset = {
          x:
            event.key === "ArrowLeft"
              ? -delta
              : event.key === "ArrowRight"
                ? delta
                : 0,
          y:
            event.key === "ArrowUp"
              ? -delta
              : event.key === "ArrowDown"
                ? delta
                : 0,
        }
        const focused = (
          event.target.closest(".react-flow__node") as HTMLElement
        ).dataset.id
        const ids = selection.nodeIds.length
          ? selection.nodeIds
          : focused
            ? [focused]
            : []
        if (selection.frameId) {
          const frame = document.frames.find(
            (item) => item.id === selection.frameId,
          )!
          onCommand?.({
            type: "move-frame",
            frameId: frame.id,
            position: {
              x: frame.position.x + offset.x,
              y: frame.position.y + offset.y,
            },
          })
        } else if (selection.noteId) {
          const note = document.notes.find(
            (item) => item.id === selection.noteId,
          )!
          onCommand?.({
            type: "move-note",
            noteId: note.id,
            position: {
              x: note.position.x + offset.x,
              y: note.position.y + offset.y,
            },
          })
        } else
          onCommand?.({
            type: "move",
            positions: Object.fromEntries(
              document.nodes
                .filter((item) => ids.includes(item.id))
                .map((item) => [
                  item.id,
                  {
                    x: item.position.x + offset.x,
                    y: item.position.y + offset.y,
                  },
                ]),
            ),
          })
      }}
    >
      <ReactFlow
        ariaLabelConfig={ariaLabelConfig}
        onlyRenderVisibleElements={initialized && document.nodes.length > 50}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={!locked}
        nodesConnectable={!locked}
        edgesReconnectable={!locked}
        deleteKeyCode={null}
        defaultViewport={viewport ?? document.viewport}
        fitViewOptions={fitViewOptions}
        onMoveEnd={(_, nextViewport) => {
          if (surface.current?.clientWidth && surface.current.clientHeight) onViewportChange?.(nextViewport)
        }}
        onNodeDoubleClick={(_, node) => onOpenNode?.(node.id)}
        minZoom={0.25}
        maxZoom={2}
        panOnDrag={pan ? true : [1, 2]}
        selectionOnDrag={!pan}
        onSelectionStart={() => {
          boxSelecting.current = true
        }}
        onSelectionEnd={() => {
          boxSelecting.current = false
        }}
        multiSelectionKeyCode="Shift"
        selectNodesOnDrag={false}
        onNodesChange={changes}
        onNodeClick={(event, node) => select(node, event.shiftKey)}
        onEdgesChange={(changes) => {
          // React Flow auto-selects connected edges during a node box gesture.
          // Those events must not replace the controlled node selection.
          if (boxSelecting.current) return
          const selected = new Set(currentSelection().edgeIds)
          let changed = false
          let hasSelectedEdge = false
          for (const change of changes)
            if (change.type === "select") {
              changed = true
              if (change.selected) {
                selected.add(change.id)
                hasSelectedEdge = true
              } else selected.delete(change.id)
            }
          if (changed) {
            const current = currentSelection()
            publishSelection(hasSelectedEdge
              ? { nodeIds: current.nodeIds, edgeIds: [...selected] }
              : { ...current, edgeIds: [...selected] })
          }
        }}
        onNodeDragStop={(_, node, moved) =>
          finishDrag(node, moved.length ? moved : [node])
        }
        onConnect={(connection) => {
          if (!locked)
            onCommand?.({ type: "connect", edge: connectionEdge(connection) })
        }}
        onReconnectStart={(_, edge) => {
          reconnecting.current = edge.id
        }}
        onReconnectEnd={() => {
          reconnecting.current = undefined
        }}
        onReconnect={(edge, connection) => {
          if (!locked)
            onCommand?.({
              type: "reconnect",
              edgeId: edge.id,
              edge: connectionEdge(connection, edge.id),
            })
        }}
        isValidConnection={(connection) =>
          !locked &&
          !validateCanvasConnection(
            document,
            definitions,
            connectionEdge(connection),
            reconnecting.current,
          )
        }
        onEdgeClick={(_, edge) =>
          publishSelection({ nodeIds: [], edgeIds: [edge.id] })
        }
        onPaneClick={() => publishSelection({ nodeIds: [], edgeIds: [] })}
        onNodeContextMenu={(event, node) => requestContext(event, node.type === "frame" ? "frame" : node.type === "note" ? "note" : "node", node.id)}
        onEdgeContextMenu={(event, edge) => requestContext(event, "edge", edge.id)}
        onPaneContextMenu={event => requestContext(event, "pane")}
      >
        <ViewportPortal>
          {guides.map((guide) => (
            <div
              key={guide.axis}
              aria-hidden="true"
              data-canvas-guide={guide.axis}
              className={styles.guide}
              style={{
                left: guide.x,
                top: guide.y,
                width: guide.width,
                height: guide.height,
              }}
            />
          ))}
        </ViewportPortal>
        {(showBackground ?? presentation !== "media") && <Background color="var(--canvas-grid)" gap={16} size={1} />}
        {presentation === "media" && (<Panel position="top-left" className={cn(styles.controls, "flex-col")}>
          <Button variant="outline" size="icon" aria-label={t("workflowCanvas.switchToSelectionMode")} aria-pressed={!pan} onClick={() => setPan(false)}><MousePointer2 /></Button>
          <Button variant="outline" size="icon" aria-label={t("workflowCanvas.switchToPanMode")} aria-pressed={pan} onClick={() => setPan(true)}><Hand /></Button>
          {toolbarActions}
        </Panel>)}
        <Panel position="bottom-left" className={cn(styles.controls, controlsVariant === "minimal-vertical" && "flex-col")}>
          <Button variant="outline" size="icon" aria-label={controlsVariant === "minimal-vertical" ? t("workflowCanvas.zoomIn") : t("workflowCanvas.zoomOut")} onClick={() => controlsVariant === "minimal-vertical" ? flow.zoomIn({ duration: 0 }) : flow.zoomOut({ duration: 0 })}>
            {controlsVariant === "minimal-vertical" ? <ZoomIn /> : <ZoomOut />}
          </Button>
          {controlsVariant === "default" && presentation !== "media" && <output aria-label={t("workflowCanvas.canvasZoomLevel")}>{Math.round(zoom * 100)}%</output>}
          {presentation === "media" && <Button variant="outline" size="icon" aria-label={t("workflowCanvas.fitAllNodes")} onClick={fitToNodes}><Scan /></Button>}
          <Button variant="outline" size="icon" aria-label={controlsVariant === "minimal-vertical" ? t("workflowCanvas.zoomOut") : t("workflowCanvas.zoomIn")} onClick={() => controlsVariant === "minimal-vertical" ? flow.zoomOut({ duration: 0 }) : flow.zoomIn({ duration: 0 })}>
            {controlsVariant === "minimal-vertical" ? <ZoomOut /> : <ZoomIn />}
          </Button>
          {presentation !== "media" && <Button variant="outline" size="icon" aria-label={t("workflowCanvas.fitAllNodes")} onClick={fitToNodes}><Scan /></Button>}
          {controlsVariant === "default" && presentation !== "media" && (<Button variant="outline" size="icon" aria-label={pan ? t("workflowCanvas.switchToSelectionMode") : t("workflowCanvas.switchToPanMode")} aria-pressed={!pan} onClick={() => setPan((value) => !value)}>{pan ? <Hand /> : <MousePointer2 />}</Button>)}
        </Panel>
        {(showMiniMap ?? presentation !== "media") && <MiniMap pannable zoomable nodeColor="var(--canvas-node-surface)" nodeStrokeColor="var(--canvas-node-border)" maskColor="var(--canvas-minimap-mask)" ariaLabel={t("workflowCanvas.workflowMinimap")} />}
      </ReactFlow>
      <ContextMenuPopup menu={contextMenu} aria-label={locale.startsWith("zh") ? "画布操作" : "Canvas actions"}>
        {contextMenu.target?.kind === "pane" ? <>
          <ContextMenuItem disabled={!document.nodes.length} onSelect={fitToNodes}>{t("workflowCanvas.fitAllNodes")}</ContextMenuItem>
          <ContextMenuItem onSelect={() => { void flow.zoomIn({ duration: 0 }) }}>{t("workflowCanvas.zoomIn")}</ContextMenuItem>
          <ContextMenuItem onSelect={() => { void flow.zoomOut({ duration: 0 }) }}>{t("workflowCanvas.zoomOut")}</ContextMenuItem>
        </> : <ContextMenuItem disabled={!contextMenu.target?.id || !document.nodes.some(node => node.id === contextMenu.target?.id)} onSelect={() => {
          const id = contextMenu.target?.id
          if (id && document.nodes.some(node => node.id === id)) onOpenNode?.(id)
        }}>{locale.startsWith("zh") ? "打开对象详情" : "Open object details"}</ContextMenuItem>}
      </ContextMenuPopup>
    </div>
  )
}
