"use client"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  MousePointer2,
  Hand,
  Square,
  Circle,
  Scan,
  Minus,
  PenLine,
  Pentagon,
  Undo2,
  Redo2,
  Trash2,
  Group,
  Ungroup,
  ArrowUp,
  ArrowDown,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  X,
} from "lucide-react"
import { WorkspaceShell } from "./workspace-shell"
import { Button } from "../ui/button"
import { Tabs, TabsList, TabsTab } from "../ui/tabs"
import { Tree, type TreeNode } from "../ui/tree"
import { Textarea } from "../ui/textarea"
import { NativeSelect } from "../ui/native-select"
import { Field } from "../ui/field"
import { Slider } from "../ui/slider"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetBody,
} from "../ui/sheet"
import { useSvgI18n as useI18n } from "../../lib/i18n-svg"
import {
  svgUiMessage as uiMessage,
  type SvgUiMessage as UiMessage,
} from "../../lib/i18n-svg"
import {
  SVG_LIMITS,
  blankSvgDocument,
  copySvgNodes,
  editableSvgIds,
  findSvgNode,
  uniqueSvgId,
  originalIconUsage,
  serializeSvg,
  topSvgSelection,
  type SvgDocument,
  type SvgNode,
  type SvgTool,
  type EditCommand,
  type SourceDraft,
  type SvgDiagnostic,
} from "../../lib/svg-workbench-model"
import { svgWorkbenchTask, type SvgTaskResult } from "../../lib/svg-workbench-task"
import type { SvgTaskInput } from "../../lib/svg-workbench-worker"
import type { SvgIconAsset } from "../../lib/svg-workbench-assets"
import { parseSvg } from "../../lib/svg-workbench-parse"
import { SvgCanvas, SvgArtwork } from "./svg-canvas"
import { SvgProperties } from "./svg-properties"
import { SvgIconLibrary, type SvgIconLibraryProps } from "./svg-icon-library"
import styles from "./svg-workbench.module.css"

export type SvgWorkbenchProps = {
  document: SvgDocument
  selectedIds: string[]
  onSelectionChange: (ids: string[]) => void
  onCommand: (command: EditCommand) => void
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  library: Omit<SvgIconLibraryProps, "onInsert">
  layout?: "fill" | "preview"
  onExport?: (
    file: { name: string; content: string; mime: string },
    signal: AbortSignal,
  ) => Promise<void>
}
const toolIcons = {
  select: MousePointer2,
  pan: Hand,
  rect: Square,
  circle: Circle,
  ellipse: Scan,
  line: Minus,
  polyline: PenLine,
  polygon: Pentagon,
}
const diagnosticKey = (code: SvgDiagnostic["code"]) =>
  code === "geometry"
    ? "svg.geometryError"
    : code === "unsupported"
      ? "svg.unsupported"
      : code === "unsafe"
        ? "svg.unsafe"
        : code === "capacity"
          ? "svg.capacity"
          : code === "reference"
            ? "svg.reference"
            : code === "timeout"
              ? "svg.timeout"
              : "svg.xml"
function downloadLocal(file: { name: string; content: string; mime: string }) {
  const url = URL.createObjectURL(new Blob([file.content], { type: file.mime }))
  const a = globalThis.document.createElement("a")
  a.href = url
  a.download = file.name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function SvgWorkbench({
  document,
  selectedIds,
  onSelectionChange,
  onCommand,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  library,
  layout = "preview",
  onExport,
}: SvgWorkbenchProps) {
  const { t, locale, setLocale, resolve } = useI18n()
  const [tool, setTool] = useState<SvgTool>("select"),
    [zoom, setZoom] = useState(1),
    [pan, setPan] = useState({ x: 0, y: 0 }),
    [grid, setGrid] = useState(true),
    [background, setBackground] = useState<"transparent" | "light" | "dark">(
      "transparent",
    ),
    [leftPanel, setLeftPanel] = useState("library"),
    [bottomOpen, setBottomOpen] = useState(false),
    [mobilePanel, setMobilePanel] = useState<
      "library" | "source" | "properties" | null
    >(null)
  const [storedDraft, setDraft] = useState<SourceDraft>(() => ({
      text: serializeSvg(document),
      baseRevision: document.revision,
      dirty: false,
      diagnostics: [],
    })),
    [feedback, setFeedback] = useState<UiMessage>(),
    [busy, setBusy] = useState(false),
    [exportOpen, setExportOpen] = useState(false),
    [exportType, setExportType] = useState("svg"),
    [tsx, setTsx] = useState<{ revision: number; code: string }>(),
    [optimized, setOptimized] = useState<{
      revision: number
      document: SvgDocument
      before: string
      after: string
    }>()
  const importInput = useRef<HTMLInputElement>(null),
    task = useRef<{ controller: AbortController; revision: number } | null>(
      null,
    ),
    latest = useRef(document),
    sequence = useRef(0)
  useLayoutEffect(() => {
    latest.current = document
  }, [document])
  useEffect(() => () => task.current?.controller.abort(), [])
  const draft: SourceDraft = storedDraft.dirty
    ? storedDraft
    : {
        text: serializeSvg(document),
        baseRevision: document.revision,
        dirty: false,
        diagnostics:
          storedDraft.baseRevision === document.revision
            ? storedDraft.diagnostics
            : [],
      }
  const dirty = document.revision > 0 || draft.dirty
  useEffect(() => {
    if (!dirty) return
    const before = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ""
    }
    window.addEventListener("beforeunload", before)
    return () => window.removeEventListener("beforeunload", before)
  }, [dirty])
  const serialized = useMemo(() => serializeSvg(document), [document]),
    selected =
      selectedIds.length === 1
        ? findSvgNode(document, selectedIds[0])
        : undefined,
    editable = editableSvgIds(document),
    stale = draft.baseRevision !== document.revision
  const topSelection = topSvgSelection(document, selectedIds)
  function selectedSiblings(nodes: SvgNode[]): SvgNode[] | undefined {
    if (nodes.some((n) => n.id === selectedIds[0])) return nodes
    for (const node of nodes) {
      const found = selectedSiblings(node.children)
      if (found) return found
    }
  }
  const siblings = selectedIds.length
    ? selectedSiblings(document.nodes)
    : undefined
  const canGroup =
    topSelection.length > 1 &&
    topSelection.every(
      (id) => editable.has(id) && siblings?.some((n) => n.id === id),
    )
  async function process(
    input: SvgTaskInput,
    accept: (result: SvgTaskResult) => void,
  ) {
    task.current?.controller.abort()
    const operation = {
      controller: new AbortController(),
      revision: document.revision,
    }
    task.current = operation
    setBusy(true)
    setFeedback(undefined)
    try {
      const result = await svgWorkbenchTask(input, operation.controller.signal)
      if (task.current !== operation) return
      if (latest.current.revision !== operation.revision) {
        setFeedback(uiMessage("svg.staleTask"))
        return
      }
      if (result.diagnostics.length) {
        setDraft((current) => ({ ...current, diagnostics: result.diagnostics }))
        setFeedback(uiMessage("svg.invalid"))
        return
      }
      accept(result)
    } catch (e) {
      if (task.current === operation)
        setFeedback(
          uiMessage(
            e instanceof Error && e.name === "AbortError"
              ? "svg.cancelled"
              : "svg.taskFailed",
          ),
        )
    } finally {
      if (task.current === operation) {
        task.current = null
        setBusy(false)
      }
    }
  }
  function replace(documentNext: SvgDocument, preserveSources: boolean) {
    onCommand({
      type: "replace",
      document: {
        ...documentNext,
        sources: preserveSources
          ? document.sources.map((s) => ({ ...s, modified: true }))
          : documentNext.sources,
      },
    })
    onSelectionChange([])
  }
  function applySource() {
    if (stale) {
      setFeedback(uiMessage("svg.stale"))
      return
    }
    void process({ type: "parse", text: draft.text }, (result) => {
      if (!result.document) return
      replace(result.document, true)
      setDraft((current) => ({
        ...current,
        dirty: false,
        baseRevision: document.revision + 1,
        diagnostics: [],
      }))
    })
  }
  const insert = useCallback(
    (asset: SvgIconAsset) => {
      const parsed = parseSvg(asset.svg)
      if (!parsed.document) {
        setFeedback(uiMessage("svg.invalid"))
        return
      }
      const source = asset.source
      parsed.document.sources = [source]
      const prefix = uniqueSvgId(
          document,
          `asset-${document.revision}-${++sequence.current}`,
        ),
        nodes = copySvgNodes(parsed.document, prefix)
      if (document.nodes.length) {
        const [sx, sy, sw, sh] = parsed.document.viewBox,
          [tx, ty, tw, th] = document.viewBox
        const factor = Math.min(tw / sw, th / sh)
        nodes[0].attrs.transform =
          `translate(${tx + (tw - sw * factor) / 2 - sx * factor} ${ty + (th - sh * factor) / 2 - sy * factor}) scale(${factor}) ${nodes[0].attrs.transform ?? ""}`.trim()
      }
      const command: EditCommand =
        document.nodes.length === 0
          ? {
              type: "replace",
              document: { ...parsed.document, nodes, attrs: {} },
            }
          : { type: "add", nodes, sources: [source] }
      onCommand(command)
      onSelectionChange([nodes[0].id])
      setLeftPanel("layers")
      setMobilePanel(null)
    },
    [document, onCommand, onSelectionChange],
  )
  function treeNodes(nodes: SvgNode[]): TreeNode[] {
    return nodes.map((n) => ({
      id: n.id,
      label: `${n.tag} · ${n.id}`,
      metadata: `${selectedIds.includes(n.id) ? "● " : ""}${n.locked ? t("svg.lock") : ""}${n.attrs.display === "none" ? ` (${t("svg.hide")})` : ""}`,
      ...(n.children.length ? { children: treeNodes(n.children) } : {}),
    }))
  }
  const layerActions = (
    <div className={styles.layerActions}>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("svg.selectSiblings")}
        disabled={!selected}
        onClick={() => {
          const id = selectedIds[0]
          const all = document.nodes.filter((n) => n.id !== id).map((n) => n.id)
          onSelectionChange([...selectedIds, ...all])
        }}
      >
        <Group />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("svg.group")}
        disabled={!canGroup}
        onClick={() => {
          const id = uniqueSvgId(
            document,
            `group-${document.revision}-${++sequence.current}`,
          )
          onCommand({ type: "group", ids: selectedIds, id })
          onSelectionChange([id])
        }}
      >
        <Group />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("svg.ungroup")}
        disabled={
          !selected ||
          selected.tag !== "g" ||
          Number(selected.attrs.opacity ?? 1) !== 1
        }
        onClick={() =>
          selected && onCommand({ type: "ungroup", id: selected.id })
        }
      >
        <Ungroup />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("svg.raise")}
        disabled={!selected || !editable.has(selected.id)}
        onClick={() =>
          selected &&
          onCommand({ type: "reorder", id: selected.id, direction: 1 })
        }
      >
        <ArrowUp />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("svg.lower")}
        disabled={!selected || !editable.has(selected.id)}
        onClick={() =>
          selected &&
          onCommand({ type: "reorder", id: selected.id, direction: -1 })
        }
      >
        <ArrowDown />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t(
          selected?.attrs.display === "none" ? "svg.show" : "svg.hide",
        )}
        disabled={!selected || !editable.has(selected.id)}
        onClick={() =>
          selected &&
          onCommand({
            type: "update",
            ids: [selected.id],
            attrs: {
              display: selected.attrs.display === "none" ? "inline" : "none",
            },
          })
        }
      >
        {selected?.attrs.display === "none" ? <Eye /> : <EyeOff />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t(selected?.locked ? "svg.unlock" : "svg.lock")}
        disabled={!selected}
        onClick={() =>
          selected &&
          onCommand({
            type: "update",
            ids: [selected.id],
            locked: !selected.locked,
          })
        }
      >
        {selected?.locked ? <Unlock /> : <Lock />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("svg.delete")}
        disabled={!selectedIds.some((id) => editable.has(id))}
        onClick={() => {
          onCommand({ type: "remove", ids: selectedIds })
          onSelectionChange([])
        }}
      >
        <Trash2 />
      </Button>
    </div>
  )
  const sidebar = (
    <div className={styles.sidebar}>
      <Tabs
        value={leftPanel}
        onValueChange={(value) => setLeftPanel(String(value))}
      >
        <TabsList>
          <TabsTab value="library">{t("svg.library")}</TabsTab>
          <TabsTab value="layers">{t("svg.layers")}</TabsTab>
        </TabsList>
      </Tabs>
      {leftPanel === "library" ? (
        <SvgIconLibrary {...library} onInsert={insert} />
      ) : (
        <>
          {layerActions}
          <p className={styles.notice}>
            {t("svg.selection", { count: selectedIds.length })}
          </p>
          <Tree
            label={t("svg.layers")}
            nodes={treeNodes(document.nodes)}
            selectedId={selectedIds.at(-1)}
            onSelect={(node) => onSelectionChange([node.id])}
            onActivate={(node) =>
              onSelectionChange(
                selectedIds.includes(node.id)
                  ? selectedIds.filter((id) => id !== node.id)
                  : [...selectedIds, node.id],
              )
            }
            onMove={(move) => onCommand({ type: "move", ...move })}
            canMove={(move) =>
              move.position !== "inside" &&
              editable.has(move.sourceId) &&
              editable.has(move.targetId)
            }
          />
          <p className={styles.notice}>{t("svg.limitedUngroup")}</p>
        </>
      )}
    </div>
  )
  const sourcePanel = (
    <section className={styles.sourcePanel} aria-label={t("svg.source")}>
      <div className={styles.sourceActions}>
        <Button onClick={applySource} disabled={busy || stale || !draft.dirty}>
          {t("svg.apply")}
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() =>
            setDraft({
              text: serialized,
              baseRevision: document.revision,
              dirty: false,
              diagnostics: [],
            })
          }
        >
          {t("svg.reload")}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("svg.close")}
          onClick={() => {
            setBottomOpen(false)
            setMobilePanel(null)
          }}
        >
          <X />
        </Button>
      </div>
      <Field
        label={t("svg.source")}
        description={t(
          stale ? "svg.stale" : draft.dirty ? "svg.draft" : "svg.sourceReady",
        )}
        error={draft.diagnostics.length ? t("svg.invalid") : undefined}
      >
        {(p) => (
          <Textarea
            {...p}
            className={styles.code}
            spellCheck={false}
            disabled={busy}
            value={draft.text}
            onChange={(e) =>
              setDraft({
                ...draft,
                text: e.target.value,
                dirty: true,
                diagnostics: [],
              })
            }
          />
        )}
      </Field>
      {stale && (
        <details open>
          <summary>{t("svg.compare")}</summary>
          <pre className={styles.code}>{serialized}</pre>
        </details>
      )}
      {draft.diagnostics.length > 0 && (
        <ul aria-label={t("svg.diagnostics")}>
          {draft.diagnostics.map((d, index) => (
            <li key={index}>
              {t(diagnosticKey(d.code))}: {d.detail}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
  const properties = (
    <SvgProperties
      document={document}
      selectedIds={selectedIds}
      onCommand={onCommand}
    />
  )
  const exportCode =
    exportType === "svg"
      ? serialized
      : exportType === "tsx"
        ? tsx?.revision === document.revision
          ? tsx.code
          : ""
        : exportType === "sources"
          ? JSON.stringify(
              {
                schemaVersion: 1,
                documentId: document.documentId,
                revision: document.revision,
                sources: document.sources,
              },
              null,
              2,
            )
          : (originalIconUsage(document) ?? t("svg.noUsage"))
  async function save() {
    const file = {
      name:
        exportType === "tsx"
          ? "artwork.tsx"
          : exportType === "sources"
            ? "artwork.sources.json"
            : exportType === "usage"
              ? "usage.tsx"
              : "artwork.svg",
      content: exportCode,
      mime: exportType === "svg" ? "image/svg+xml" : "text/plain;charset=utf-8",
    }
    task.current?.controller.abort()
    const operation = {
      controller: new AbortController(),
      revision: document.revision,
    }
    task.current = operation
    setBusy(true)
    try {
      if (onExport) await onExport(file, operation.controller.signal)
      else downloadLocal(file)
    } catch (e) {
      if (task.current === operation)
        setFeedback(
          uiMessage(
            e instanceof Error && e.name === "AbortError"
              ? "svg.cancelled"
              : "svg.saveFailed",
          ),
        )
    } finally {
      if (task.current === operation) {
        task.current = null
        setBusy(false)
      }
    }
  }
  return (
    <div
      className={styles.workbench}
      data-svg-workbench
      data-layout={layout}
      data-revision={document.revision}
      data-node-count={document.nodes.length}
    >
      <WorkspaceShell
        className={styles.shell}
        title={<h1>{t("svg.title")}</h1>}
        defaultInspectorWidth={320}
        sidebar={sidebar}
        inspector={properties}
        inspectorTitle={t("svg.properties")}
        bottomPanelResizable
        bottomPanelOpen={bottomOpen}
        onBottomPanelOpenChange={setBottomOpen}
        bottomPanelCollapsed={!bottomOpen}
        bottomPanel={
          bottomOpen ? (
            sourcePanel
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setBottomOpen(true)}
            >
              {t("svg.source")}
            </Button>
          )
        }
        toolbar={
          <>
            <div className={styles.tools}>
              {(Object.keys(toolIcons) as SvgTool[]).map((value) => {
                const Icon = toolIcons[value]
                return (
                  <Button
                    key={value}
                    variant="ghost"
                    size="icon"
                    aria-label={t(`svg.${value}`)}
                    aria-pressed={tool === value}
                    onClick={() => setTool(value)}
                  >
                    <Icon />
                  </Button>
                )
              })}
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("svg.undo")}
                disabled={!canUndo}
                onClick={onUndo}
              >
                <Undo2 />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("svg.redo")}
                disabled={!canRedo}
                onClick={onRedo}
              >
                <Redo2 />
              </Button>
            </div>
            <div className={styles.documentActions}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  replace(blankSvgDocument(), false)
                  if (!draft.dirty)
                    setDraft({
                      text: serializeSvg(blankSvgDocument()),
                      baseRevision: document.revision + 1,
                      dirty: false,
                      diagnostics: [],
                    })
                }}
              >
                {t("svg.new")}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => importInput.current?.click()}
              >
                {t("svg.import")}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setExportOpen(true)
                  setExportType("svg")
                }}
              >
                {t("svg.export")}
              </Button>
              <NativeSelect
                aria-label={t("svg.language")}
                className={styles.language}
                value={locale}
                onChange={(e) =>
                  setLocale(e.target.value === "en" ? "en" : "zh-CN")
                }
              >
                <option value="zh-CN">{t("svg.chinese")}</option>
                <option value="en">{t("svg.english")}</option>
              </NativeSelect>
            </div>
          </>
        }
      >
        <div className={styles.main}>
          <div className={styles.mobileNav}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMobilePanel("library")}
            >
              {t("svg.library")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMobilePanel("source")}
            >
              {t("svg.source")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMobilePanel("properties")}
            >
              {t("svg.properties")}
            </Button>
          </div>
          <div className={styles.previewControls}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setZoom(1)
                setPan({ x: 0, y: 0 })
              }}
            >
              {t("svg.fit")}
            </Button>
            <span>{Math.round(zoom * 100)}%</span>
            <Slider
              label={t("svg.zoom")}
              value={zoom}
              min={0.25}
              max={8}
              step={0.25}
              onChange={setZoom}
              className={styles.zoom}
            />
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={grid}
              onClick={() => setGrid(!grid)}
            >
              {t("svg.grid")}
            </Button>
            <NativeSelect
              aria-label={t("svg.background")}
              className={styles.backgroundSelect}
              value={background}
              onChange={(e) =>
                setBackground(e.target.value as typeof background)
              }
            >
              <option value="transparent">{t("svg.transparent")}</option>
              <option value="light">{t("svg.light")}</option>
              <option value="dark">{t("svg.dark")}</option>
            </NativeSelect>
          </div>
          <SvgCanvas
            document={document}
            selectedIds={selectedIds}
            onSelectionChange={onSelectionChange}
            onCommand={onCommand}
            tool={tool}
            zoom={zoom}
            onZoomChange={setZoom}
            pan={pan}
            onPanChange={setPan}
            grid={grid}
            background={background}
          />
          <div className={styles.status}>
            <p role="status">
              {busy
                ? t("svg.busy")
                : feedback
                  ? resolve(feedback)
                  : t("svg.local")}
            </p>
            {busy && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => task.current?.controller.abort()}
              >
                {t("svg.cancel")}
              </Button>
            )}
          </div>
        </div>
      </WorkspaceShell>
      <input
        hidden
        ref={importInput}
        type="file"
        accept=".svg,image/svg+xml"
        aria-label={t("svg.import")}
        onChange={async (e) => {
          const file = e.target.files?.[0]
          e.target.value = ""
          if (!file) return
          if (file.size > SVG_LIMITS.bytes) {
            setFeedback(uiMessage("svg.importTooLarge"))
            return
          }
          const revision = latest.current.revision
          try {
            const text = await file.text()
            if (latest.current.revision !== revision) {
              setFeedback(uiMessage("svg.staleTask"))
              return
            }
            setDraft({
              text,
              baseRevision: document.revision,
              dirty: true,
              diagnostics: [],
            })
            setBottomOpen(true)
            setFeedback(undefined)
          } catch {
            setFeedback(uiMessage("svg.taskFailed"))
          }
        }}
      />
      <Sheet
        open={mobilePanel !== null}
        onOpenChange={(open) => {
          if (!open) setMobilePanel(null)
        }}
      >
        <SheetContent size={360}>
          <SheetHeader>
            <SheetTitle>
              {t(
                mobilePanel === "source"
                  ? "svg.source"
                  : mobilePanel === "properties"
                    ? "svg.properties"
                    : "svg.library",
              )}
            </SheetTitle>
            <SheetDescription>{t("svg.local")}</SheetDescription>
          </SheetHeader>
          <SheetBody>
            {mobilePanel === "source"
              ? sourcePanel
              : mobilePanel === "properties"
                ? properties
                : sidebar}
          </SheetBody>
        </SheetContent>
      </Sheet>
      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent className={styles.exportDialog}>
          <DialogTitle>{t("svg.export")}</DialogTitle>
          <DialogDescription>{t("svg.modifiedNotice")}</DialogDescription>
          <Tabs
            value={exportType}
            onValueChange={(value) => {
              setExportType(String(value))
              if (value === "tsx" && tsx?.revision !== document.revision)
                void process({ type: "tsx", document }, (result) =>
                  setTsx({
                    revision: document.revision,
                    code: result.code ?? "",
                  }),
                )
            }}
          >
            <TabsList>
              <TabsTab value="svg">SVG</TabsTab>
              <TabsTab value="tsx">TSX</TabsTab>
              <TabsTab value="usage">{t("svg.usage")}</TabsTab>
              <TabsTab value="sources">{t("svg.sources")}</TabsTab>
            </TabsList>
          </Tabs>
          <Textarea
            className={styles.code}
            aria-label={t("svg.export")}
            readOnly
            value={exportCode}
          />
          <div className={styles.exportActions}>
            <Button
              disabled={
                busy ||
                !exportCode ||
                (exportType === "usage" && !originalIconUsage(document))
              }
              onClick={() => void save()}
            >
              {t("svg.download")}
            </Button>
            <Button
              variant="secondary"
              disabled={!exportCode}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(exportCode)
                  setFeedback(uiMessage("svg.copied"))
                } catch {
                  setFeedback(uiMessage("svg.copyFailed"))
                }
              }}
            >
              {t("svg.copy")}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void process({ type: "optimize", document }, (result) => {
                  if (result.document)
                    setOptimized({
                      revision: document.revision,
                      document: result.document,
                      before: serialized,
                      after: result.code ?? serializeSvg(result.document),
                    })
                })
              }
            >
              {t("svg.optimize")}
            </Button>
            {busy && (
              <Button
                variant="secondary"
                onClick={() => task.current?.controller.abort()}
              >
                {t("svg.cancel")}
              </Button>
            )}
          </div>
          <p role="status">
            {busy ? t("svg.busy") : feedback ? resolve(feedback) : ""}
          </p>
          <section
            aria-label={t("svg.preview")}
            className={styles.sizePreviews}
          >
            {[16, 24, 32, 48].map((size) => (
              <figure key={size}>
                <SvgArtwork
                  document={document}
                  prefix={`preview-${size}`}
                  className={styles.sizePreview}
                />
                <figcaption>{size}px</figcaption>
              </figure>
            ))}
          </section>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(optimized)}
        onOpenChange={(open) => {
          if (!open) setOptimized(undefined)
        }}
      >
        <DialogContent className={styles.exportDialog}>
          <DialogTitle>{t("svg.optimizeTitle")}</DialogTitle>
          <DialogDescription>{t("svg.replaceConfirm")}</DialogDescription>
          {optimized && (
            <>
              <div className={styles.optimizeCompare}>
                <figure>
                  <SvgArtwork document={document} prefix="before" />
                  <figcaption>
                    {t("svg.before", {
                      bytes: new TextEncoder().encode(optimized.before).length,
                    })}
                  </figcaption>
                </figure>
                <figure>
                  <SvgArtwork document={optimized.document} prefix="after" />
                  <figcaption>
                    {t("svg.after", {
                      bytes: new TextEncoder().encode(optimized.after).length,
                    })}
                  </figcaption>
                </figure>
              </div>
              <Button
                disabled={optimized.revision !== document.revision}
                onClick={() => {
                  replace(optimized.document, true)
                  setOptimized(undefined)
                }}
              >
                {t("svg.applyOptimize")}
              </Button>
              {optimized.revision !== document.revision && (
                <p role="alert">{t("svg.staleTask")}</p>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
