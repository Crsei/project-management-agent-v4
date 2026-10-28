"use client"
import { useUiFeedback } from "../../lib/i18n-provider"
import { uiMessage } from "../../lib/i18n-core"
import { UiError } from "../../lib/i18n-core"
import { useI18n } from "../../lib/i18n-provider"

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  Plus,
  Undo2,
  Redo2,
  Copy,
  ClipboardPaste,
  Trash2,
  Link2,
  Search,
  Keyboard,
  MoreHorizontal,
  Download,
  Upload,
  Group,
  StickyNote,
  ChevronUp,
  ChevronDown,
} from "lucide-react"
import {
  CanvasRunControls,
  CanvasExecutionPanel,
  CanvasExecutionInspector,
} from "./canvas-execution-panel"
import {
  CanvasServicePanel,
  type CanvasServicePanelProps,
} from "./canvas-service-panel"
import type { CanvasPersistenceController } from "../../lib/use-canvas-persistence"
import { canvasRuntimeUnknown } from "../../lib/canvas-runtime"
import type { CanvasExecutionVisuals } from "../../lib/canvas-model"
import type { CanvasRuntimeController } from "../../lib/use-canvas-runtime"
import { WorkspaceShell } from "./workspace-shell"
import { WorkflowCanvas } from "./workflow-canvas"
import { NodePalette } from "./node-palette"
import {
  NodeInspector,
  type CanvasInspectorDraft,
} from "./node-inspector"
import { CanvasConnectionForm } from "./canvas-connection-form"
import { Inspector } from "./inspector"
import { layoutCanvasDAG, type CanvasMeasurements } from "../../lib/canvas-layout"
import { Menu, MenuTrigger, MenuContent, MenuItem } from "../ui/menu"
import { Tabs, TabsList, TabsTab, TabsPanel } from "../ui/tabs"
import { CommandToolbar } from "./command-toolbar"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { DataRegion, type RegionError } from "../ui/data-region"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog"
import {
  canvasId,
  type CanvasCommand,
  type CanvasCatalogs,
  type CanvasDocument,
  type CanvasFragment,
  type CanvasNodeDefinition,
  type CanvasSelection,
} from "../../lib/canvas-model"
import { copyCanvasFragment } from "../../lib/canvas-commands"
import {
  exportCanvasDocument,
  parseCanvasDocument,
  validateCanvasDocument,
} from "../../lib/canvas-validation"
import type { DataState } from "../../lib/runtime-status"
import styles from "./canvas-controls.module.css"

export type CanvasWorkspaceProps = {
  layout?: "preview" | "fill"
  document: CanvasDocument
  definitions: CanvasNodeDefinition[]
  selection: CanvasSelection
  onSelectionChange: (selection: CanvasSelection) => void
  onCommand?: (command: CanvasCommand) => void
  readOnly?: boolean
  canUndo?: boolean
  canRedo?: boolean
  onUndo?: () => void
  onRedo?: () => void
  state?: DataState
  error?: RegionError
  onRetry?: () => void
  refreshing?: boolean
  feedback?: string
  onDirtyChange?: (dirty: boolean) => void
  services?: CanvasServicePanelProps
  persistence?: CanvasPersistenceController
  runtime?: CanvasRuntimeController
  executionVisuals?: CanvasExecutionVisuals
  runtimeToolbar?: ReactNode
  catalogs?: CanvasCatalogs
  viewport?: CanvasDocument["viewport"]
  onViewportChange?: (viewport: NonNullable<CanvasDocument["viewport"]>) => void
  onOpenNode?: (nodeId: string) => void
  fixedNodeIds?: readonly string[]
}
function fingerprint(document: CanvasDocument) {
  return JSON.stringify({ ...document, revision: 0 })
}
export function CanvasWorkspace({
  layout = "preview",
  document: graph,
  definitions,
  selection,
  onSelectionChange,
  onCommand,
  readOnly = false,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  state = "success",
  error,
  onRetry,
  refreshing,
  feedback,
  onDirtyChange,
  runtime,
  executionVisuals,
  runtimeToolbar,
  persistence,
  services,
  catalogs,
  viewport,
  onViewportChange,
  onOpenNode,
  fixedNodeIds,
}: CanvasWorkspaceProps) {
  const { t, resolve } = useI18n()
  const [measurements, setMeasurements] = useState<CanvasMeasurements>({})
  const layoutController = useRef<AbortController | null>(null)
  const currentInputs = useRef({ graph, definitions, fixedNodeIds })
  currentInputs.current = { graph, definitions, fixedNodeIds }
  const [layoutJob, setLayoutJob] = useState<{
    source: CanvasDocument
    definitions: CanvasNodeDefinition[]
    fixedNodeIds?: readonly string[]
    state: "pending" | "preview" | "error"
    positions?: Record<string, { x: number; y: number }>
    reason?: "cycle" | "subflow" | "invalid" | "groupCapacity"
  } | null>(null)
  const activeLayout =
    layoutJob?.source === graph &&
    layoutJob.definitions === definitions &&
    layoutJob.fixedNodeIds === fixedNodeIds
      ? layoutJob
      : null
  const previewGraph = useMemo(
    () =>
      activeLayout?.state === "preview"
        ? {
            ...graph,
            nodes: graph.nodes.map((node) => ({
              ...node,
              position: activeLayout.positions?.[node.id] ?? node.position,
            })),
          }
        : graph,
    [graph, activeLayout],
  )
  useEffect(
    () => () => {
      layoutController.current?.abort()
    },
    [graph, definitions, fixedNodeIds],
  )
  async function previewLayout() {
    layoutController.current?.abort()
    const controller = new AbortController()
    layoutController.current = controller
    const inputs = currentInputs.current
    setLayoutJob({ source: graph, definitions, fixedNodeIds, state: "pending" })
    try {
      const result = await layoutCanvasDAG(graph, definitions, {
        measurements,
        fixedNodeIds,
        signal: controller.signal,
      })
      const latest = currentInputs.current
      if (
        controller.signal.aborted ||
        latest.graph !== inputs.graph ||
        latest.definitions !== inputs.definitions ||
        latest.fixedNodeIds !== inputs.fixedNodeIds
      )
        return
      setLayoutJob({
        source: graph,
        definitions,
        fixedNodeIds,
        ...(result.ok
          ? { state: "preview", positions: result.positions }
          : { state: "error", reason: result.reason }),
      })
    } catch {
      if (!controller.signal.aborted)
        setLayoutJob({
          source: graph,
          definitions,
          fixedNodeIds,
          state: "error",
          reason: "invalid",
        })
    }
  }
  function cancelLayout() {
    layoutController.current?.abort()
    setLayoutJob(null)
  }

  const [collapsed, setCollapsed] = useState<string[]>([])
  const [recent, setRecent] = useState<string[]>([])
  const [commandQuery, setCommandQuery] = useState("")
  const [inspectorView, setInspectorView] = useState("config")
  const [bottomView, setBottomView] = useState("validation")
  const [bottomOpen, setBottomOpen] = useState(layout !== "fill")
  const bottomId = useId()
  const locked = readOnly || !onCommand
  const sourceFrozen =
    !!runtime &&
    (runtime.state.transport === "disconnected" ||
      !!runtime.state.readError ||
      !!runtime.state.uncertain ||
      canvasRuntimeUnknown(runtime.state.snapshot) ||
      !["starting", "running", "thinking", "queued"].includes(
        runtime.state.snapshot?.status ?? "",
      ))
  const effect = executionVisuals?.edgeEffect,
    speed = executionVisuals?.speed,
    visualPaused = executionVisuals?.paused
  // Selection changes must not recreate every node's execution presentation.
  const flowVisuals = useMemo<CanvasExecutionVisuals>(
    () => ({
      edgeEffect: effect,
      speed,
      paused: visualPaused || sourceFrozen,
    }),
    [effect, speed, visualPaused, sourceFrozen],
  )
  const [dialog, setDialog] = useState<
    | "palette"
    | "connect"
    | "operations"
    | "help"
    | "json"
    | "nodes"
    | "commands"
    | null
  >(null)
  const [query, setQuery] = useState("")
  const [json, setJson] = useState("")
  const [fileError, setFileError] = useUiFeedback("")
  const [localFeedback, setLocalFeedback] = useUiFeedback("")
  const [locate, setLocate] = useState<{ id: string; request: number }>()
  const [checkpoint, setCheckpoint] = useState(() => fingerprint(graph))
  const [draftStore, setDraftStore] = useState<
    Record<string, CanvasInspectorDraft>
  >({})
  const clipboard = useRef<CanvasFragment | null>(null)
  const [hasClipboard, setHasClipboard] = useState(false)
  const issues = useMemo(
    () => validateCanvasDocument(graph, definitions),
    [graph, definitions],
  )
  const graphFingerprint = useMemo(() => fingerprint(graph), [graph])
  const nodeParents = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node.parentId])),
    [graph.nodes],
  )
  const dirty = persistence
    ? persistence.state.status !== "saved"
    : graphFingerprint !== checkpoint
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  const edge = graph.edges.find((item) => item.id === selection.edgeIds[0])
  const note = graph.notes.find((item) => item.id === selection.noteId)
  const frame = graph.frames.find((item) => item.id === selection.frameId)
  const anySelected = !!(
    selection.nodeIds.length ||
    selection.edgeIds.length ||
    frame ||
    note
  )
  useEffect(() => {
    if (!dirty) return
    function beforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", beforeUnload)
    return () => window.removeEventListener("beforeunload", beforeUnload)
  }, [dirty])
  function command(command: CanvasCommand) {
    if (!locked) {
      setLocalFeedback("")
      onCommand?.(command)
    }
  }
  function add(definition: CanvasNodeDefinition) {
    if (locked) return
    setRecent((current) =>
      [
        definition.type,
        ...current.filter((type) => type !== definition.type),
      ].slice(0, 5),
    )
    const id = canvasId("node")
    command({
      type: "add",
      node: {
        id,
        type: definition.type,
        title: definition.label,
        position: {
          x: 80 + (graph.nodes.length % 4) * 320,
          y: 80 + Math.floor(graph.nodes.length / 4) * 240,
        },
        config: structuredClone(definition.defaults),
      },
    })
    setDialog(null)
    setLocate({ id, request: Date.now() })
  }
  function remove() {
    if (frame) command({ type: "delete-frame", frameId: frame.id })
    else if (note) command({ type: "delete-note", noteId: note.id })
    else command({ type: "delete", selection })
  }
  function copy() {
    clipboard.current = copyCanvasFragment(graph, selection.nodeIds)
    setHasClipboard(!!clipboard.current.nodes.length)
    setLocalFeedback(
      clipboard.current.nodes.length
        ? uiMessage("canvasWorkspace.copiedToTheCanvasInMemoryClipboard")
        : uiMessage("canvasWorkspace.selectNodesToCopyFirst"),
    )
  }
  function paste() {
    if (clipboard.current)
      command({ type: "paste", fragment: clipboard.current })
  }
  function align(axis: "x" | "y" | "distribute") {
    const members = graph.nodes
      .filter((node) => selection.nodeIds.includes(node.id))
      .sort((a, b) => a.position.x - b.position.x)
    if (locked || members.length < 2) return
    const origin = members[0].position,
      step = (members.at(-1)!.position.x - origin.x) / (members.length - 1)
    command({
      type: "move",
      positions: Object.fromEntries(
        members.map((node, index) => [
          node.id,
          {
            x:
              axis === "x"
                ? origin.x
                : axis === "distribute"
                  ? Math.round((origin.x + step * index) / 4) * 4
                  : node.position.x,
            y: axis === "y" ? origin.y : node.position.y,
          },
        ]),
      ),
    })
  }
  function group() {
    const members = graph.nodes.filter((node) =>
      selection.nodeIds.includes(node.id),
    )
    if (!members.length) return
    const x = Math.min(...members.map((node) => node.position.x)) - 24,
      y = Math.min(...members.map((node) => node.position.y)) - 64
    command({
      type: "frame",
      nodeIds: members.map((node) => node.id),
      frame: {
        id: canvasId("frame"),
        title: "流程分组",
        position: { x, y },
        width: Math.max(...members.map((node) => node.position.x)) - x + 264,
        height: Math.max(...members.map((node) => node.position.y)) - y + 264,
      },
    })
  }
  function selectNode(id: string, additive = false) {
    const parentId = graph.nodes.find((node) => node.id === id)?.parentId
    if (parentId)
      setCollapsed((current) => current.filter((id) => id !== parentId))
    onSelectionChange({
      nodeIds: additive
        ? selection.nodeIds.includes(id)
          ? selection.nodeIds.filter((value) => value !== id)
          : [...selection.nodeIds, id]
        : [id],
      edgeIds: [],
    })
    setLocate({ id, request: Date.now() })
  }
  const palette = (
    <NodePalette
      definitions={definitions}
      recentTypes={recent}
      onAdd={add}
      readOnly={locked}
    />
  )
  const nodeList = (
    <div className={styles.navigation}>
      <label className={styles.field}>
        {t("canvasWorkspace.findNodesInGraph")}
        <Input
          aria-label={t("canvasWorkspace.findNodesInGraph")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("canvasWorkspace.nodeTitleOrId")}
        />
      </label>
      <ul className={styles.list}>
        {graph.nodes
          .filter((node) =>
            `${node.title} ${node.id}`
              .toLowerCase()
              .includes(query.trim().toLowerCase()),
          )
          .map((node) => (
            <li key={node.id}>
              <button
                className={styles.nodeLink}
                aria-label={t("common.locateValue", { value0: node.title })}
                aria-pressed={selection.nodeIds.includes(node.id)}
                onClick={(event) => selectNode(node.id, event.shiftKey)}
              >
                {node.title}
              </button>
            </li>
          ))}
      </ul>
      {!graph.nodes.some((node) =>
        `${node.title} ${node.id}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      ) && (
        <p className={styles.muted}>
          {t("canvasWorkspace.noMatchingNodesInThisGraph")}
        </p>
      )}
    </div>
  )
  const operations = (
    <div className={styles.actions}>
      <Button
        variant="outline"
        disabled={!selection.nodeIds.length}
        onClick={copy}
      >
        <Copy />
        {t("canvasWorkspace.copyNodes")}
      </Button>
      <Button
        variant="outline"
        disabled={locked || !hasClipboard}
        onClick={paste}
      >
        <ClipboardPaste />
        {t("canvasWorkspace.pasteNodes")}
      </Button>
      <Button
        variant="outline"
        disabled={locked || !anySelected}
        onClick={remove}
      >
        <Trash2 />
        {frame
          ? t("canvasWorkspace.deleteGroupAndUngroupMembers")
          : t("canvasWorkspace.deleteSelection")}
      </Button>
      <Button
        variant="outline"
        disabled={locked || !selection.nodeIds.length}
        onClick={group}
      >
        <Group />
        {t("canvasWorkspace.groupSelectedNodes")}
      </Button>
      <Button
        variant="outline"
        disabled={locked || selection.nodeIds.length < 2}
        onClick={() => align("x")}
      >
        {t("canvasWorkspace.alignLeft")}
      </Button>
      <Button
        variant="outline"
        disabled={locked || selection.nodeIds.length < 2}
        onClick={() => align("y")}
      >
        {t("canvasWorkspace.alignTop")}
      </Button>
      <Button
        variant="outline"
        disabled={locked || selection.nodeIds.length < 3}
        onClick={() => align("distribute")}
      >
        {t("canvasWorkspace.distributeHorizontally")}
      </Button>
      <Button
        variant="outline"
        disabled={locked}
        onClick={() =>
          command({
            type: "note",
            note: {
              id: canvasId("note"),
              text: t("canvasWorkspace.describeTheIntentOfThisWorkflowSection"),
              position: { x: 80, y: 400 },
            },
          })
        }
      >
        <StickyNote />
        {t("canvasWorkspace.addNote")}
      </Button>
    </div>
  )
  return (
    <div
      data-canvas-workspace
      data-layout={layout}
      className={layout === "fill" ? styles.fill : undefined}
      data-revision={graph.revision}
      data-node-count={graph.nodes.length}
      data-edge-count={graph.edges.length}
      onKeyDown={(event) => {
        if (
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          !(event.target instanceof Element) ||
          event.target.closest(
            "input, textarea, select, [contenteditable], [role=dialog], [role=menu], [role=listbox], [role=tablist]",
          )
        )
          return
        // Browser text selection and non-canvas regions retain native shortcuts.
        if (
          (window.getSelection() && !window.getSelection()!.isCollapsed) ||
          !event.target.closest("[data-canvas-editor-context]")
        )
          return
        if (activeLayout) return
        const modifier = event.metaKey || event.ctrlKey
        if (modifier && event.key.toLowerCase() === "k") {
          event.preventDefault()
          setCommandQuery("")
          setDialog("commands")
        } else if (modifier && event.key.toLowerCase() === "c") {
          event.preventDefault()
          copy()
        } else if (!locked && modifier && event.key.toLowerCase() === "v") {
          event.preventDefault()
          paste()
        } else if (!locked && modifier && event.key.toLowerCase() === "z") {
          event.preventDefault()
          if (event.shiftKey) onRedo?.()
          else onUndo?.()
        } else if (!locked && modifier && event.key.toLowerCase() === "a") {
          event.preventDefault()
          onSelectionChange({
            nodeIds: graph.nodes.map((node) => node.id),
            edgeIds: [],
          })
        } else if (
          !locked &&
          (event.key === "Delete" || event.key === "Backspace") &&
          anySelected
        ) {
          event.preventDefault()
          remove()
        } else if (event.key === "?") {
          event.preventDefault()
          setDialog("help")
        }
      }}
    >
      <WorkspaceShell
        className={styles.workspace}
        title={
          <span>
            Canvas ·{" "}
            {locked
              ? t("canvasWorkspace.readOnly")
              : t("canvasWorkspace.localDraft")}
            {dirty ? t("canvasWorkspace.changesNotExported") : ""}
          </span>
        }
        sidebar={
          <>
            <div className={styles.sidebarFull}>
              {palette}
              {nodeList}
            </div>
            <div className={styles.sidebarSmall}>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("canvasWorkspace.openNodePalette")}
                onClick={() => setDialog("palette")}
              >
                <Plus />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("canvasWorkspace.findNodesInGraph")}
                onClick={() => setDialog("nodes")}
              >
                <Search />
              </Button>
            </div>
          </>
        }
        toolbar={
          <div className={styles.toolbar}>
            <Button
              size="sm"
              variant={runtime ? "outline" : "default"}
              disabled={locked}
              onClick={() => setDialog("palette")}
            >
              <Plus />
              {t("canvasWorkspace.addNode")}
            </Button>
            <CommandToolbar
              className="w-28 min-w-11 shrink"
              label={t("toolbar.history")}
              actions={[
                {
                  id: "undo",
                  label: t("canvasWorkspace.undoEdit"),
                  icon: <Undo2 />,
                  iconOnly: true,
                  width: 44,
                  priority: 1,
                  disabled: locked || !canUndo,
                  onInvoke: () => onUndo?.(),
                },
                {
                  id: "redo",
                  label: t("canvasWorkspace.redoEdit"),
                  icon: <Redo2 />,
                  iconOnly: true,
                  width: 44,
                  disabled: locked || !canRedo,
                  onInvoke: () => onRedo?.(),
                },
              ]}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={locked}
              onClick={() => setDialog("connect")}
            >
              <Link2 />
              {t("canvasWorkspace.connectPorts")}
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label={t("canvasWorkspace.openCanvasActions")}
              onClick={() => setDialog("operations")}
            >
              <MoreHorizontal />
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label={t("canvasWorkspace.findNodesInGraph")}
              onClick={() => setDialog("nodes")}
            >
              <Search />
            </Button>
            <Menu>
              <MenuTrigger
                render={<Button variant="ghost" size="sm" />}
                aria-label={t("canvasWorkspace.moreTools")}
              >
                <MoreHorizontal />
                {t("canvasWorkspace.moreTools")}
              </MenuTrigger>
              <MenuContent>
                <MenuItem
                  disabled={locked || !!activeLayout || !graph.nodes.length}
                  onClick={() => {
                    void previewLayout()
                  }}
                >
                  {t("canvasWorkspace.arrangeDAG")}
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    setJson(exportCanvasDocument(graph))
                    setFileError("")
                    setDialog("json")
                  }}
                >
                  JSON
                </MenuItem>
                <MenuItem onClick={() => setDialog("help")}>
                  <Keyboard />
                  {t("canvasWorkspace.keyboardShortcuts")}
                </MenuItem>
              </MenuContent>
            </Menu>
            {persistence && (
              <div
                className={styles.actions}
                aria-label={t("canvasWorkspace.documentSaving")}
              >
                <span role="status">
                  {
                    {
                      saved: t("canvasWorkspace.saveConfirmedByService"),
                      dirty: t("canvasWorkspace.unsavedChanges"),
                      saving: t("canvasWorkspace.saving"),
                      error: t("canvasWorkspace.saveFailed"),
                      conflict: t("canvasWorkspace.revisionConflict"),
                      unknown: t("canvasWorkspace.saveOutcomeUnknown"),
                    }[persistence.state.status]
                  }{" "}
                  · {persistence.state.serverRevision}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    locked ||
                    !["dirty", "error"].includes(persistence.state.status)
                  }
                  onClick={persistence.save}
                >
                  {t("canvasWorkspace.saveDocument")}
                </Button>
                {persistence.state.status === "unknown" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={persistence.query}
                  >
                    {t("canvasWorkspace.querySaveReceipt")}
                  </Button>
                )}
                {persistence.state.message && (
                  <span className={styles.muted}>
                    {persistence.state.message}
                  </span>
                )}
              </div>
            )}
            {runtime && (
              <CanvasRunControls
                runtime={runtime}
                document={graph}
                definitions={definitions}
                nodeId={selection.nodeIds[0]}
                readOnly={locked}
              />
            )}
            {runtimeToolbar}
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setCommandQuery("")
                setDialog("commands")
              }}
            >
              {t("canvasWorkspace.commandSearch")}
            </Button>
            <span>
              {t("canvasWorkspace.graphCounts", {
                nodes: graph.nodes.length,
                edges: graph.edges.length,
              })}
            </span>
          </div>
        }
        inspectorTitle={t("canvasWorkspace.nodesAndConnections")}
        inspector={
          <>
            {(runtime || services) && (
              <div className={styles.actions}>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-pressed={inspectorView === "config"}
                  onClick={() => setInspectorView("config")}
                >
                  {t("canvasWorkspace.configuration")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-pressed={inspectorView === "execution"}
                  onClick={() => setInspectorView("execution")}
                >
                  {t("canvasWorkspace.executionDetails")}
                </Button>
              </div>
            )}
            {runtime && inspectorView === "execution" ? (
              <CanvasExecutionInspector
                runtime={runtime}
                document={graph}
                definitions={definitions}
                nodeId={selection.nodeIds[0]}
                readOnly={locked}
              />
            ) : edge ? (
              <Inspector
                object={{
                  id: edge.id,
                  title: edge.label ?? t("canvasWorkspace.edge"),
                  kind: "Edge",
                  metadata: [
                    { label: t("canvasWorkspace.source"), value: edge.source },
                    { label: t("canvasWorkspace.target"), value: edge.target },
                  ],
                }}
              >
                <CanvasConnectionForm
                  key={`${edge.id}:${graph.revision}`}
                  document={graph}
                  definitions={definitions}
                  edge={edge}
                  onCommand={command}
                  readOnly={locked}
                />
              </Inspector>
            ) : note ? (
              <NoteInspector
                key={note.id}
                note={note}
                onCommand={command}
                readOnly={locked}
              />
            ) : frame ? (
              <Inspector
                object={{
                  id: frame.id,
                  title: frame.title,
                  kind: "Frame",
                  metadata: [
                    {
                      label: t("canvasWorkspace.members"),
                      value: graph.nodes.filter(
                        (node) => node.parentId === frame.id,
                      ).length,
                    },
                  ],
                }}
              >
                <p className={styles.muted}>
                  {t("canvasWorkspace.thisGroupIsVisualOnlyMovingItMoves")}
                </p>
                <Button
                  variant="outline"
                  onClick={() =>
                    setCollapsed((current) =>
                      current.includes(frame.id)
                        ? current.filter((id) => id !== frame.id)
                        : [...current, frame.id],
                    )
                  }
                >
                  {collapsed.includes(frame.id)
                    ? t("canvasWorkspace.expandGroup")
                    : t("canvasWorkspace.collapseGroup")}
                </Button>
                <p className={styles.muted}>
                  {t("canvasWorkspace.relatedEdges")}
                  {
                    graph.edges.filter(
                      (edge) =>
                        nodeParents.get(edge.source) === frame.id ||
                        nodeParents.get(edge.target) === frame.id,
                    ).length
                  }{" "}
                  {t("canvasWorkspace.originalEndpointsPreserved")}
                </p>
                <Button variant="outline" disabled={locked} onClick={remove}>
                  {t("canvasWorkspace.deleteGroupAndUngroupMembers")}
                </Button>
              </Inspector>
            ) : (
              <NodeInspector
                document={graph}
                definitions={definitions}
                nodeId={selection.nodeIds[0]}
                catalogs={catalogs}
                draftStore={draftStore}
                onDraftStoreChange={setDraftStore}
                onCommand={command}
                readOnly={locked}
                issues={issues}
              />
            )}
          </>
        }
        bottomPanelResizable
        bottomPanelCollapsed={!bottomOpen}
        bottomPanel={
          <Tabs
            value={bottomView}
            onValueChange={(value) => {
              setBottomView(String(value))
              setBottomOpen(true)
            }}
            className={styles.bottom}
            data-collapsed={!bottomOpen}
          >
            <div className={styles.bottomTabs}>
              <TabsList
                aria-label={t("canvasWorkspace.bottomViews")}
                className="border-0"
              >
                <TabsTab value="validation" onClick={() => setBottomOpen(true)}>
                  {t("canvasWorkspace.documentValidation")}
                  {issues.length > 0 ? ` · ${issues.length}` : ""}
                </TabsTab>
                {runtime && (
                  <TabsTab
                    value="execution"
                    onClick={() => setBottomOpen(true)}
                  >
                    {t("canvasExecutionPanel.executionDebugger")}
                  </TabsTab>
                )}
                {services && (
                  <TabsTab value="services" onClick={() => setBottomOpen(true)}>
                    {t("canvasServicePanel.serviceIntegration")}
                  </TabsTab>
                )}
              </TabsList>
              {!bottomOpen && (localFeedback || feedback) && (
                <span role="status" className={styles.bottomFeedback}>
                  {localFeedback || feedback}
                </span>
              )}
              <Button
                size="icon-sm"
                variant="ghost"
                className={styles.bottomToggle}
                aria-label={
                  bottomOpen
                    ? t("canvasWorkspace.collapseBottomPanel")
                    : t("canvasWorkspace.expandBottomPanel")
                }
                aria-expanded={bottomOpen}
                aria-controls={bottomId}
                onClick={() => setBottomOpen((open) => !open)}
              >
                {bottomOpen ? <ChevronDown /> : <ChevronUp />}
              </Button>
            </div>
            <TabsPanel
              value={bottomView}
              id={bottomId}
              hidden={!bottomOpen}
              className={styles.bottomBody}
            >
              {services && bottomView === "services" ? (
                <CanvasServicePanel
                  {...services}
                  readOnly={locked || services.readOnly}
                />
              ) : runtime && bottomView === "execution" ? (
                <CanvasExecutionPanel
                  runtime={runtime}
                  document={graph}
                  definitions={definitions}
                />
              ) : (
                <>
                  <div className={styles.actions}>
                    <h3>
                      {t("canvasWorkspace.documentValidation2")}
                      {issues.length} {t("canvasWorkspace.issues")}
                    </h3>
                    <span className={styles.muted}>
                      {persistence ? (
                        persistence.state.status === "saved" ? (
                          t("canvasWorkspace.currentRevisionConfirmedByService")
                        ) : (
                          t(
                            "canvasWorkspace.localDraftAwaitingServiceConfirmation",
                          )
                        )
                      ) : (
                        <>
                          {dirty
                            ? t("canvasWorkspace.changesNotExported2")
                            : t(
                                "canvasWorkspace.initialOrExportedRevision",
                              )}{" "}
                          {t(
                            "canvasWorkspace.inMemoryDocumentLostOnReloadOrNavigation",
                          )}
                        </>
                      )}
                    </span>
                  </div>
                  <p role="status" aria-live="polite" className={styles.muted}>
                    {localFeedback ||
                      feedback ||
                      t("canvasWorkspace.addNodesFromThePaletteOrConnectThem")}
                  </p>
                  {issues.length ? (
                    <ul>
                      {issues.map((issue, index) => (
                        <li key={index}>
                          <button
                            className={styles.nodeLink}
                            onClick={() => {
                              if (issue.nodeId) selectNode(issue.nodeId)
                              else if (issue.edgeId)
                                onSelectionChange({
                                  nodeIds: [],
                                  edgeIds: [issue.edgeId],
                                })
                            }}
                          >
                            {issue.severity === "error"
                              ? t("canvasWorkspace.error")
                              : t("canvasWorkspace.notice")}{" "}
                            · {resolve(issue.messageI18n, issue.message)}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className={styles.muted}>
                      {t(
                        "canvasWorkspace.noStructuralOrConfigurationIssuesFoundThisDoes",
                      )}
                    </p>
                  )}
                </>
              )}
            </TabsPanel>
          </Tabs>
        }
      >
        <div className={styles.canvasRegion}>
          {activeLayout && (
            <div
              role="status"
              data-layout-preview={activeLayout.state}
              className={styles.layoutNotice}
            >
              <span>
                {activeLayout.state === "pending"
                  ? t("canvasWorkspace.layoutPending")
                  : activeLayout.state === "preview"
                    ? t("canvasWorkspace.layoutPreview")
                    : t(`canvasLayout.${activeLayout.reason ?? "invalid"}`)}
              </span>
              {activeLayout.state === "preview" && (
                <Button
                  size="sm"
                  disabled={locked}
                  onClick={() => {
                    if (
                      activeLayout.source === graph &&
                      activeLayout.positions &&
                      !locked
                    )
                      command({
                        type: "move",
                        positions: activeLayout.positions,
                      })
                    cancelLayout()
                  }}
                >
                  {t("canvasWorkspace.applyLayout")}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={cancelLayout}>
                {t("canvasWorkspace.cancelLayout")}
              </Button>
            </div>
          )}

          <DataRegion
            state={
              state === "success" &&
              !graph.nodes.length &&
              !graph.notes.length &&
              !graph.frames.length
                ? "empty"
                : state
            }
            hasContent={
              !!(
                graph.nodes.length ||
                graph.notes.length ||
                graph.frames.length
              )
            }
            error={error}
            onRetry={onRetry}
            refreshing={refreshing}
            emptyTitle={t("canvasWorkspace.startWithOneNode")}
            emptyDescription={t(
              "canvasWorkspace.addInputAgentToolAndOutputNodesAnd",
            )}
            emptyAction={
              <Button disabled={locked} onClick={() => setDialog("palette")}>
                {t("canvasWorkspace.addTheFirstNode")}
              </Button>
            }
            partialDescription={t(
              "canvasWorkspace.theGraphDocumentIsIncompleteAlreadyLoadedContent",
            )}
          >
            <div className={styles.canvasSurface}>
              <WorkflowCanvas
                document={previewGraph}
                definitions={definitions}
                onMeasurementsChange={setMeasurements}
                execution={runtime?.state.snapshot}
                executionVisuals={flowVisuals}
                collapsedFrameIds={collapsed}
                viewport={viewport}
                onViewportChange={onViewportChange}
                onOpenNode={onOpenNode}
                selection={selection}
                onSelectionChange={onSelectionChange}
                onCommand={command}
                readOnly={locked || !!activeLayout}
                issues={issues}
                focusRequest={locate}
                onContextMenu={() => setDialog("operations")}
              />
            </div>
          </DataRegion>
        </div>
      </WorkspaceShell>
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null)
        }}
      >
        <DialogContent className={styles.dialog}>
          <DialogTitle>
            {
              {
                palette: t("canvasWorkspace.addNode"),
                connect: t("canvasWorkspace.connectPorts"),
                operations: t("canvasWorkspace.canvasActions"),
                help: t("canvasWorkspace.keyboardShortcuts"),
                json: t("canvasWorkspace.graphDocumentJson"),
                nodes: t("canvasWorkspace.findNodesInGraph"),
                commands: t("canvasWorkspace.commandSearch"),
              }[dialog ?? "help"]
            }
          </DialogTitle>
          <DialogDescription>
            {dialog === "json"
              ? t(
                  "canvasWorkspace.exportsIncludeOnlyRedactedGraphConfigurationWithoutExecution",
                )
              : t("canvasWorkspace.allEditsAffectOnlyTheCurrentInMemory")}
          </DialogDescription>
          {dialog === "palette" && palette}
          {dialog === "nodes" && nodeList}
          {dialog === "commands" && (
            <div className={styles.form}>
              <Input
                aria-label={t("canvasWorkspace.searchCommandsOrNodes")}
                autoFocus
                value={commandQuery}
                onChange={(event) => setCommandQuery(event.target.value)}
                placeholder={t("canvasWorkspace.addLocateAlignUndo")}
              />
              {[
                ...definitions.map((def) => ({
                  id: `add-${def.type}`,
                  label: t("common.addValue", { value0: def.label }),
                  disabled: locked,
                  action: () => add(def),
                })),
                ...graph.nodes.map((node) => ({
                  id: `locate-${node.id}`,
                  label: t("common.locateValue", { value0: node.title }),
                  disabled: false,
                  action: () => selectNode(node.id),
                })),
                {
                  id: "undo",
                  label: t("canvasWorkspace.undoEdit"),
                  disabled: locked || !canUndo,
                  action: () => onUndo?.(),
                },
                {
                  id: "align",
                  label: t("canvasWorkspace.alignLeft"),
                  disabled: locked || selection.nodeIds.length < 2,
                  action: () => align("x"),
                },
              ]
                .filter((item) =>
                  item.label.toLowerCase().includes(commandQuery.toLowerCase()),
                )
                .slice(0, 50)
                .map((item) => (
                  <Button
                    key={item.id}
                    variant="ghost"
                    disabled={item.disabled}
                    onClick={() => {
                      item.action()
                      setDialog(null)
                    }}
                  >
                    {item.label}
                  </Button>
                ))}
              <p className={styles.muted}>
                {t("canvasWorkspace.showingTheFirst50MatchesTypeAName")}
              </p>
            </div>
          )}
          {dialog === "operations" && operations}
          {dialog === "connect" && (
            <CanvasConnectionForm
              document={graph}
              definitions={definitions}
              onCommand={command}
              readOnly={locked}
            />
          )}
          {dialog === "help" && (
            <dl className={styles.shortcut}>
              <dt>{t("canvasWorkspace.shiftClickMarqueeSelect")}</dt>
              <dd>{t("canvasWorkspace.selectMultipleNodes")}</dd>
              <dt>{t("canvasWorkspace.arrowKeysShiftArrowKeys")}</dt>
              <dd>{t("canvasWorkspace.moveFocusedNodeBy832px")}</dd>
              <dt>Ctrl / ⌘ + A</dt>
              <dd>{t("canvasWorkspace.selectAllNodes")}</dd>
              <dt>Ctrl / ⌘ + C / V</dt>
              <dd>{t("canvasWorkspace.copyPasteNodes")}</dd>
              <dt>Delete / Backspace</dt>
              <dd>{t("canvasWorkspace.deleteSelection")}</dd>
              <dt>Ctrl / ⌘ + Z / Shift + Z</dt>
              <dd>{t("canvasWorkspace.undoRedo")}</dd>
              <dt>Escape</dt>
              <dd>{t("canvasWorkspace.closeDialogAndReturnToTrigger")}</dd>
              <dt>{t("canvasWorkspace.connectPortsButton")}</dt>
              <dd>{t("canvasWorkspace.connectWithoutDraggingAnEdge")}</dd>
            </dl>
          )}
          {dialog === "json" && (
            <div className={styles.stack}>
              <label className={styles.field}>
                {t("canvasWorkspace.graphDocumentContent")}
                <textarea
                  aria-label={t("canvasWorkspace.graphDocumentContent")}
                  className={styles.json}
                  value={json}
                  readOnly={locked}
                  onChange={(event) => setJson(event.target.value)}
                  spellCheck={false}
                />
              </label>
              <label className={styles.field}>
                {t("canvasWorkspace.readJsonFile")}
                <input
                  type="file"
                  accept=".json,application/json"
                  disabled={locked}
                  onChange={async (event) => {
                    const file = event.target.files?.[0]
                    if (!file) return
                    try {
                      if (file.size > 524288)
                        throw new UiError(
                          "canvasWorkspace.fileExceedsThe512kibLimit",
                        )
                      setJson(await file.text())
                      setFileError("")
                    } catch (error) {
                      setFileError(
                        error instanceof UiError
                          ? error.messageI18n
                          : error instanceof Error
                            ? error.message
                            : uiMessage(
                                "canvasWorkspace.fileReadFailedTheOriginalGraphIsPreserved",
                              ),
                      )
                    }
                  }}
                />
              </label>
              <div className={styles.actions}>
                <Button
                  variant="outline"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(
                        exportCanvasDocument(graph),
                      )
                      setCheckpoint(fingerprint(graph))
                      setLocalFeedback(
                        uiMessage(
                          "canvasWorkspace.redactedGraphDocumentCopiedTheLocalDraftRemains",
                        ),
                      )
                      setFileError("")
                    } catch {
                      setFileError(
                        uiMessage(
                          "canvasWorkspace.copyFailedTheDraftIsPreservedDownloadThe",
                        ),
                      )
                    }
                  }}
                >
                  {t("canvasWorkspace.copyRedactedJson")}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    try {
                      const blob = new Blob([exportCanvasDocument(graph)], {
                        type: "application/json",
                      })
                      const url = URL.createObjectURL(blob)
                      const anchor = window.document.createElement("a")
                      anchor.href = url
                      anchor.download = `${graph.id}.json`
                      anchor.click()
                      setTimeout(() => URL.revokeObjectURL(url), 1000)
                      setCheckpoint(fingerprint(graph))
                      setLocalFeedback(
                        uiMessage(
                          "canvasWorkspace.graphDownloadRequestedKeepTheDownloadedFile",
                        ),
                      )
                      setFileError("")
                    } catch {
                      setFileError(
                        uiMessage(
                          "canvasWorkspace.exportFailedTheDraftIsPreserved",
                        ),
                      )
                    }
                  }}
                >
                  <Download />
                  {t("canvasWorkspace.downloadJson")}
                </Button>
                <Button
                  disabled={locked}
                  onClick={() => {
                    try {
                      const document = parseCanvasDocument(json, definitions)
                      command({ type: "replace", document })
                      setFileError("")
                      setDialog(null)
                    } catch (error) {
                      setFileError(
                        error instanceof Error
                          ? error.message
                          : uiMessage(
                              "canvasWorkspace.importFailedTheOriginalGraphIsPreserved",
                            ),
                      )
                    }
                  }}
                >
                  <Upload />
                  {t("canvasWorkspace.validateAndReplaceDraft")}
                </Button>
              </div>
              {fileError && (
                <p role="alert" className={styles.error}>
                  {fileError}{" "}
                  {t("canvasWorkspace.theOriginalDocumentWasNotOverwritten")}
                </p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
function NoteInspector({
  note,
  onCommand,
  readOnly,
}: {
  note: CanvasDocument["notes"][number]
  onCommand: (command: CanvasCommand) => void
  readOnly: boolean
}) {
  const { t } = useI18n()

  const [text, setText] = useState(note.text)
  return (
    <Inspector
      object={{
        id: note.id,
        title: "流程说明",
        kind: "StickyNote",
        metadata: [{ label: "ID", value: note.id }],
      }}
    >
      <label className={styles.field}>
        {t("canvasWorkspace.noteBody")}
        <textarea
          value={text}
          disabled={readOnly}
          maxLength={4000}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <Button
        disabled={readOnly || !text.trim()}
        onClick={() =>
          onCommand({ type: "update-note", noteId: note.id, text })
        }
      >
        {t("canvasWorkspace.applyNote")}
      </Button>
    </Inspector>
  )
}
