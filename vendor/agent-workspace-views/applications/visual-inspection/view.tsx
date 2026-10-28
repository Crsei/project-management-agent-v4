"use client"

import { useLayoutEffect, useRef, useState, type PointerEvent } from "react"
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Image as ImageIcon,
  MessageSquare,
  Minus,
  Monitor,
  Moon,
  MousePointer2,
  Plus,
  ScanEye,
  SquareDashed,
  Trash2,
  Upload,
} from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import { NativeSelect } from "@easyuse-ui/ui/components/ui/native-select"
import { DataRegion } from "@easyuse-ui/ui/components/ui/data-region"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@easyuse-ui/ui/components/ui/dialog"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { safeResourceImage } from "@easyuse-ui/ui/lib/workbench-resource-model"
import {
  RemainingPageStateProvider,
  useRemainingPageState,
} from "../../showcase/state"
import {
  remainingPageScenarios,
  type RemainingPageProps,
} from "../../showcase/model"
import {
  createInspectionState,
  currentImage,
  selectedRegion,
  visibleRegions,
  inspectionTransition,
  exportInspection,
  type InspectionAction,
} from "./controller"
import { orderImageData } from "./image-data"
import type { Bounds, Copy } from "./fixtures"
import styles from "./view.module.css"

export const pageScenarios = remainingPageScenarios
export function RemainingPageView(props: RemainingPageProps) {
  return (
    <RemainingPageStateProvider cache={props.cache}>
      <VisualInspection {...props} />
    </RemainingPageStateProvider>
  )
}
function VisualInspection({
  scenario,
  active,
  host,
  cache,
}: RemainingPageProps) {
  const { locale } = useI18n(),
    en = locale === "en"
  const label = (zh: string, english: string) => (en ? english : zh)
  const copy = (value: Copy) => value[en ? "en" : "zh-CN"]
  const key = "visual-inspection:" + scenario
  const [state, setState] = useRemainingPageState(key, () =>
    createInspectionState(scenario, orderImageData),
  )
  const change = (action: InspectionAction) =>
    setState((previous) => inspectionTransition(previous, action))
  const [notice, setNotice] = useState<Copy | null>(null)
  const feedback = (zh: string, english: string) => setNotice({ "zh-CN": zh, en: english })
  const [imageError, setImageError] = useState(false)
  const [removing, setRemoving] = useState("")
  const [available, setAvailable] = useState(1091)
  const [drawing, setDrawing] = useState<Bounds | null>(null)
  const viewport = useRef<HTMLDivElement>(null),
    sidebar = useRef<HTMLElement>(null),
    canvas = useRef<HTMLDivElement>(null),
    fileInput = useRef<HTMLInputElement>(null),
    titleInput = useRef<HTMLInputElement>(null),
    addButton = useRef<HTMLButtonElement>(null)
  const pointer = useRef<{ x: number; y: number } | null>(null),
    uploadSequence = useRef(0)
  const restoredCanvas = useRef<{ x: number; y: number } | null>(null),
    restoredSidebar = useRef<number | null>(null)
  const image = currentImage(state),
    selected = selectedRegion(state),
    regions = visibleRegions(state)
  const editable = !state.readonly && state.dataState !== "loading"
  useLayoutEffect(() => {
    const node = viewport.current
    if (!node) return
    const observer = new ResizeObserver(() => setAvailable(node.clientWidth))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    if (!active) return
    if (viewport.current) {
      viewport.current.scrollLeft = Number(cache.get(key + ":canvas-x") ?? 0)
      viewport.current.scrollTop = Number(cache.get(key + ":canvas-y") ?? 0)
      restoredCanvas.current = {
        x: viewport.current.scrollLeft,
        y: viewport.current.scrollTop,
      }
    }
    if (sidebar.current) {
      sidebar.current.scrollTop = Number(cache.get(key + ":sidebar-y") ?? 0)
      // A shorter translation may clamp the DOM, not the saved reading position.
      restoredSidebar.current = sidebar.current.scrollTop
    }
  }, [active, available, cache, key, locale, host.resolvedTheme])
  const width = image
    ? (Math.max(160, Math.min(image.width, available - 48)) * state.zoom) / 100
    : 0
  const select = (id: string) => change({ type: "select", id })
  const add = (bounds?: Bounds) => {
    change({ type: "add", bounds })
    requestAnimationFrame(() => titleInput.current?.focus())
  }
  const position = (event: PointerEvent<HTMLDivElement>) => {
    const rect = canvas.current!.getBoundingClientRect()
    return {
      x: Math.max(
        0,
        Math.min(100, ((event.clientX - rect.left) / rect.width) * 100),
      ),
      y: Math.max(
        0,
        Math.min(100, ((event.clientY - rect.top) / rect.height) * 100),
      ),
    }
  }
  const startDraw = (event: PointerEvent<HTMLDivElement>) => {
    if (!editable || state.mode !== "draw" || event.button !== 0) return
    event.preventDefault()
    pointer.current = position(event)
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrawing({ ...pointer.current, width: 0, height: 0 })
  }
  const moveDraw = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointer.current) return
    const p = position(event),
      start = pointer.current
    setDrawing({
      x: Math.min(start.x, p.x),
      y: Math.min(start.y, p.y),
      width: Math.abs(p.x - start.x),
      height: Math.abs(p.y - start.y),
    })
  }
  const finishDraw = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointer.current) return
    const p = position(event),
      start = pointer.current,
      bounds = {
        x: Math.min(start.x, p.x),
        y: Math.min(start.y, p.y),
        width: Math.abs(p.x - start.x),
        height: Math.abs(p.y - start.y),
      }
    pointer.current = null
    setDrawing(null)
    if (bounds.width >= 2 && bounds.height >= 2) add(bounds)
    else
      feedback("区域宽高至少为图片的 2%。", "A region must span at least 2% of the image in each direction.")
  }
  const upload = async (file: File) => {
    const sequence = ++uploadSequence.current
    if (
      !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
        file.type,
      ) ||
      file.size > 5 * 1024 * 1024
    ) {
      feedback("请选择不超过 5 MB 的 PNG、JPEG、WebP 或 GIF 图片。原图已保留。", "Choose a PNG, JPEG, WebP, or GIF up to 5 MB. The current image is retained.")
      return
    }
    try {
      const src = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error("read"))
        reader.readAsDataURL(file)
      })
      if (!safeResourceImage(src)) throw new Error("unsafe")
      const dimensions = await new Promise<{ width: number; height: number }>(
        (resolve, reject) => {
          const preview = new window.Image()
          preview.onload = () =>
            resolve({
              width: preview.naturalWidth,
              height: preview.naturalHeight,
            })
          preview.onerror = () => reject(new Error("decode"))
          preview.src = src
        },
      )
      if (
        sequence !== uploadSequence.current ||
        !dimensions.width ||
        !dimensions.height
      )
        return
      change({
        type: "upload",
        image: {
          id: "image-" + crypto.randomUUID(),
          name: { "zh-CN": file.name, en: file.name },
          src,
          ...dimensions,
          regions: [],
        },
      })
      setImageError(false)
      feedback("图片仅在当前浏览器内打开，未上传。", "Image opened in browser memory only; nothing was uploaded.")
    } catch {
      if (sequence === uploadSequence.current)
        feedback("无法读取图片。原图和审阅标注已保留。", "Could not read the image. The current image and review annotations are retained.")
    }
  }
  const exportReview = () => {
    const blob = new Blob([exportInspection(state)], {
        type: "application/json",
      }),
      url = URL.createObjectURL(blob),
      a = document.createElement("a")
    a.href = url
    a.download = "visual-inspection-review.json"
    a.click()
    URL.revokeObjectURL(url)
    feedback("已发起本地审阅 JSON 下载。", "Local review JSON download started.")
  }
  const ready = state.dataState !== "loading"
  return (
    <div className={styles.root} data-visual-inspection>
      <header className={styles.pageHeader}>
        <div>
          <ScanEye aria-hidden="true" />
          <span>{label("视觉检查", "Visual inspection")}</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label("切换主题", "Toggle theme")}
          onClick={() =>
            host.setTheme(host.resolvedTheme === "dark" ? "light" : "dark")
          }
        >
          {host.resolvedTheme === "dark" ? (
            <Moon aria-hidden="true" />
          ) : (
            <Monitor aria-hidden="true" />
          )}
        </Button>
      </header>
      <section
        className={styles.hero}
        aria-label={label("设计审阅", "Design review")}
      >
        <div>
          <p>
            {label("商业体验", "Commerce experience")}
            <ChevronRight aria-hidden="true" />
            {label("设计审阅", "Design review")}
          </p>
          <h1>{label("看得更仔细。", "A closer look.")}</h1>
        </div>
        <div className={styles.actions}>
          <input
            ref={fileInput}
            className={styles.file}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            aria-label={label("打开待检查图片", "Open an image for inspection")}
            disabled={!editable}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              if (file) void upload(file)
              event.currentTarget.value = ""
            }}
          />
          <Button
            variant="outline"
            disabled={!editable}
            onClick={() => fileInput.current?.click()}
          >
            <Upload aria-hidden="true" />
            {label("打开图片", "Open image")}
          </Button>
          <Button
            variant="outline"
            disabled={!image || !ready}
            onClick={exportReview}
          >
            <Download aria-hidden="true" />
            {label("导出审阅", "Export review")}
          </Button>
          <Button
            disabled={!image || !editable}
            onClick={() => {
              change({ type: "review" })
              feedback("本地示例审阅已附加到图片区域；没有调用 AI 服务。", "Local sample review attached to image regions; no AI service was called.")
            }}
          >
            <Bot aria-hidden="true" />
            {label("审阅图片", "Review image")}
          </Button>
        </div>
      </section>
      {(notice || state.readonly || state.dataState === "refresh-error") && (
        <div
          className={styles.notice}
          role={state.dataState === "refresh-error" ? "alert" : "status"}
        >
          {state.dataState === "refresh-error" ? (
            <>
              {label(
                "刷新失败。已保留原图、区域与草稿。",
                "Refresh failed. The image, regions, and drafts are retained.",
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => change({ type: "load" })}
              >
                {label("重试", "Retry")}
              </Button>
            </>
          ) : state.readonly ? (
            label(
              "只读审阅：可以选择、筛选、缩放和导出；不能修改标注。",
              "Read-only review: select, filter, zoom, and export; annotations cannot be edited.",
            )
          ) : (
            notice && copy(notice)
          )}
        </div>
      )}
      <div className={styles.workspace}>
        <section
          className={styles.imagePanel}
          aria-label={label("图片审阅画布", "Image review canvas")}
        >
          <div className={styles.toolbar}>
            <div className={styles.imagePicker}>
              <ImageIcon aria-hidden="true" />
              <NativeSelect
                aria-label={label("审阅图片", "Review image")}
                value={state.imageId}
                disabled={!image}
                onChange={(event) => {
                  change({ type: "image", id: event.currentTarget.value })
                  setImageError(false)
                }}
              >
                {!image && (
                  <option value="">
                    {label("未打开图片", "No image open")}
                  </option>
                )}
                {state.images.map((i) => (
                  <option key={i.id} value={i.id}>
                    {copy(i.name)}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className={styles.tools}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={label("选择区域", "Select regions")}
                aria-pressed={state.mode === "select"}
                onClick={() => change({ type: "mode", mode: "select" })}
              >
                <MousePointer2 aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={label("绘制区域", "Draw a region")}
                aria-pressed={state.mode === "draw"}
                disabled={!editable || !image}
                onClick={() => {
                  change({ type: "mode", mode: "draw" })
                  canvas.current?.focus()
                }}
              >
                <SquareDashed aria-hidden="true" />
              </Button>
              <span className={styles.toolDivider} />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={label("缩小", "Zoom out")}
                disabled={!image || state.zoom <= 25}
                onClick={() => change({ type: "zoom", value: state.zoom - 25 })}
              >
                <Minus aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={styles.zoom}
                aria-label={label("适配视口", "Fit image to viewport")}
                disabled={!image}
                onClick={() => change({ type: "zoom", value: 100 })}
              >
                {state.zoom}%
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={label("放大", "Zoom in")}
                disabled={!image || state.zoom >= 200}
                onClick={() => change({ type: "zoom", value: state.zoom + 25 })}
              >
                <Plus aria-hidden="true" />
              </Button>
            </div>
          </div>
          <div
            ref={viewport}
            className={styles.viewport}
            onScroll={(event) => {
              const node = event.currentTarget
              if (!active || !node.clientHeight || !node.clientWidth) return
              if (
                restoredCanvas.current?.x === node.scrollLeft &&
                restoredCanvas.current.y === node.scrollTop
              ) return
              restoredCanvas.current = null
              cache.set(key + ":canvas-x", node.scrollLeft)
              cache.set(key + ":canvas-y", node.scrollTop)
            }}
          >
            <DataRegion
              state={
                !ready
                  ? "loading"
                  : imageError
                    ? "error"
                    : image
                      ? "success"
                      : "empty"
              }
              loadingLabel={label("正在读取图片", "Reading image")}
              error={{
                category: "request",
                message: label(
                  "图片无法显示。",
                  "The image cannot be displayed.",
                ),
                reason: label(
                  "区域和审阅笔记已保留。请重试或打开另一张图片。",
                  "Regions and review notes are retained. Retry or open another image.",
                ),
              }}
              onRetry={() => {
                setImageError(false)
                change({ type: "load" })
              }}
              emptyTitle={label(
                "打开图片开始审阅",
                "Open an image to begin review",
              )}
              emptyDescription={label(
                "图片和标注仅保存在当前浏览器内。",
                "Images and annotations stay in browser memory.",
              )}
              emptyAction={
                <Button
                  disabled={!editable}
                  onClick={() => fileInput.current?.click()}
                >
                  <Upload aria-hidden="true" />
                  {label("打开图片", "Open image")}
                </Button>
              }
            >
              {ready && image && (
                <div
                  className={styles.canvasWrap}
                  style={{ minWidth: width + 48 }}
                >
                  <div
                    ref={canvas}
                    className={styles.canvas}
                    data-mode={state.mode}
                    style={{
                      width,
                      aspectRatio: image.width + " / " + image.height,
                    }}
                    role="group"
                    tabIndex={0}
                    aria-label={label(
                      "图片画布。使用绘制区域或添加区域进行标注。",
                      "Image canvas. Use Draw a region or Add region to annotate.",
                    )}
                    onPointerDown={startDraw}
                    onPointerMove={moveDraw}
                    onPointerUp={finishDraw}
                    onPointerCancel={() => {
                      pointer.current = null
                      setDrawing(null)
                    }}
                    onKeyDown={(event) => {
                      if (!active) return
                      if (event.key === "Escape") {
                        pointer.current = null
                        setDrawing(null)
                        change({ type: "mode", mode: "select" })
                      }
                      if (
                        state.mode === "draw" &&
                        event.key === "Enter" &&
                        editable
                      ) {
                        event.preventDefault()
                        add()
                      }
                    }}
                  >
                    {/* Inert trusted raster source; the existing standalone file renderer has no annotation overlay slot. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={safeResourceImage(image.src)}
                      alt={label(
                        "待审阅订单详情画面；编号区域关联观察项",
                        "Order detail screen under review; numbered regions link to observations",
                      )}
                      draggable={false}
                      onError={() => setImageError(true)}
                    />
                    {image.regions.map((region) => (
                      <button
                        key={region.id}
                        type="button"
                        className={styles.region}
                        data-selected={region.id === state.selectedId}
                        data-resolved={region.resolved}
                        aria-label={
                          label("选择区域 ", "Select region ") +
                          region.number +
                          ": " +
                          copy(region.title)
                        }
                        aria-pressed={region.id === state.selectedId}
                        style={{
                          left: region.bounds.x + "%",
                          top: region.bounds.y + "%",
                          width: region.bounds.width + "%",
                          height: region.bounds.height + "%",
                        }}
                        onClick={() => select(region.id)}
                      >
                        <span>
                          {region.resolved ? (
                            <Check aria-hidden="true" />
                          ) : (
                            region.number
                          )}
                        </span>
                      </button>
                    ))}
                    {drawing && (
                      <div
                        className={styles.drawing}
                        style={{
                          left: drawing.x + "%",
                          top: drawing.y + "%",
                          width: drawing.width + "%",
                          height: drawing.height + "%",
                        }}
                      />
                    )}
                  </div>
                  {state.mode === "draw" && (
                    <p className={styles.drawHint}>
                      {label(
                        "拖动绘制区域，或按 Enter 添加居中区域。Esc 取消。",
                        "Drag to draw, or press Enter to add a centered region. Esc cancels.",
                      )}
                    </p>
                  )}
                </div>
              )}
            </DataRegion>
            {!ready && (
              <Button
                variant="outline"
                onClick={() => change({ type: "load" })}
              >
                {label("载入本地图片", "Load local image")}
              </Button>
            )}
          </div>
        </section>
        <aside
          ref={sidebar}
          className={styles.sidebar}
          aria-label={label("区域观察项", "Region observations")}
          onScroll={(event) => {
            const node = event.currentTarget
            if (!active || !node.clientHeight || !node.clientWidth) return
            if (restoredSidebar.current === node.scrollTop) return
            restoredSidebar.current = null
            cache.set(key + ":sidebar-y", node.scrollTop)
          }}
        >
          <div className={styles.observationHeader}>
            <h2>
              {label("观察项", "Observations")}{" "}
              <span>{image?.regions.length ?? 0}</span>
            </h2>
            <Button
              ref={addButton}
              variant="ghost"
              disabled={!editable || !image}
              onClick={() => add()}
            >
              <Plus aria-hidden="true" />
              {label("添加区域", "Add region")}
            </Button>
          </div>
          <div
            className={styles.filters}
            role="group"
            aria-label={label("筛选观察项", "Filter observations")}
          >
            {(["all", "open", "resolved"] as const).map((filter) => (
              <Button
                key={filter}
                variant="ghost"
                size="sm"
                aria-pressed={state.filter === filter}
                onClick={() => change({ type: "filter", filter })}
              >
                {filter === "all"
                  ? label("全部", "All")
                  : filter === "open"
                    ? label("待处理", "Open")
                    : label("已解决", "Resolved")}
              </Button>
            ))}
          </div>
          <div className={styles.regionList}>
            {regions.map((region) => (
              <Button
                key={region.id}
                variant="ghost"
                className={styles.observation}
                aria-pressed={region.id === state.selectedId}
                onClick={() => select(region.id)}
              >
                <span className={styles.number} data-resolved={region.resolved}>
                  {region.resolved ? (
                    <Check aria-hidden="true" />
                  ) : (
                    region.number
                  )}
                </span>
                <span className={styles.observationTitle}>
                  {copy(region.title)}
                </span>
                <MessageSquare aria-hidden="true" />
                <span className={styles.noteCount}>{region.notes.length}</span>
              </Button>
            ))}
            {regions.length === 0 && (
              <div className={styles.noRegions}>
                <p>
                  {image?.regions.length
                    ? label("没有匹配的观察项。", "No matching observations.")
                    : label("尚未标注区域。", "No regions annotated yet.")}
                </p>
                {image?.regions.length ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => change({ type: "filter", filter: "all" })}
                  >
                    {label("清除筛选", "Clear filter")}
                  </Button>
                ) : null}
              </div>
            )}
          </div>
          {selected ? (
            <section
              className={styles.detail}
              aria-label={label("所选区域详情", "Selected region details")}
            >
              <div className={styles.regionHeading}>
                <span>{label("区域 ", "Region ") + selected.number}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!editable}
                  aria-pressed={selected.resolved}
                  onClick={() => change({ type: "resolve" })}
                >
                  <Check aria-hidden="true" />
                  {selected.resolved
                    ? label("重新打开", "Reopen")
                    : label("解决", "Resolve")}
                </Button>
              </div>
              <Input
                ref={titleInput}
                className={styles.titleInput}
                aria-label={label("区域标题", "Region title")}
                value={copy(selected.title)}
                disabled={!editable}
                onChange={(event) =>
                  change({ type: "title", value: event.currentTarget.value })
                }
              />
              <Button
                variant="outline"
                disabled={!editable}
                onClick={() => change({ type: "suggest" })}
              >
                <Bot aria-hidden="true" />
                {label("起草观察项", "Draft observation")}
              </Button>
              <div
                className={styles.discussion}
                role="log"
                aria-label={label("区域讨论", "Region discussion")}
              >
                {selected.notes.map((note) => (
                  <div key={note.id} className={styles.note}>
                    <span>
                      {note.kind === "user"
                        ? label("审阅笔记", "REVIEW NOTE")
                        : note.kind === "draft"
                          ? label("本地示例草稿", "LOCAL SAMPLE DRAFT")
                          : label("审阅笔记", "REVIEW NOTE")}
                    </span>
                    <p>{copy(note.text)}</p>
                  </div>
                ))}
              </div>
              <div className={styles.noteComposer}>
                <Textarea
                  aria-label={label("所选区域笔记", "Note for selected region")}
                  placeholder={label(
                    "为此区域添加笔记…",
                    "Add a note about this region…",
                  )}
                  value={selected.draft}
                  disabled={!editable}
                  onChange={(event) =>
                    change({ type: "draft", value: event.currentTarget.value })
                  }
                />
                <div>
                  <span>
                    {label("仅附加到此区域", "Only attached to this region")}
                  </span>
                  <Button
                    size="sm"
                    disabled={!editable || !selected.draft.trim()}
                    onClick={() => change({ type: "note" })}
                  >
                    {label("添加笔记", "Add note")}
                  </Button>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className={styles.coordinateToggle}
                aria-expanded={state.coordinatesOpen}
                aria-controls={key + ":coordinates"}
                onClick={() =>
                  change({ type: "coordinates", open: !state.coordinatesOpen })
                }
              >
                {state.coordinatesOpen ? (
                  <ChevronDown aria-hidden="true" />
                ) : (
                  <ChevronRight aria-hidden="true" />
                )}
                {label("区域坐标", "Region coordinates")}
              </Button>
              <div
                id={key + ":coordinates"}
                hidden={!state.coordinatesOpen}
                className={styles.coordinates}
              >
                {(["x", "y", "width", "height"] as const).map((field) => (
                  <label key={field}>
                    <span>
                      {field === "width"
                        ? label("宽度 %", "width %")
                        : field === "height"
                          ? label("高度 %", "height %")
                          : field + " %"}
                    </span>
                    <Input
                      type="number"
                      min={field === "width" || field === "height" ? 2 : 0}
                      max={100}
                      step={1}
                      aria-label={label(field === "width" ? "区域宽度" : field === "height" ? "区域高度" : "区域 " + field, "Region " + field)}
                      value={Math.round(selected.bounds[field] * 100) / 100}
                      disabled={!editable}
                      onChange={(event) => {
                        if (event.currentTarget.value !== "")
                          change({
                            type: "bounds",
                            bounds: {
                              ...selected.bounds,
                              [field]: event.currentTarget.valueAsNumber,
                            },
                          })
                      }}
                    />
                  </label>
                ))}
              </div>
              <Button
                variant="ghost"
                className={styles.remove}
                disabled={!editable}
                onClick={() => setRemoving(selected.id)}
              >
                <Trash2 aria-hidden="true" />
                {label("移除区域", "Remove region")}
              </Button>
            </section>
          ) : (
            <div className={styles.noSelection}>
              {label(
                "选择或添加区域以记录观察项。",
                "Select or add a region to record observations.",
              )}
            </div>
          )}
        </aside>
      </div>
      <Dialog
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open) setRemoving("")
        }}
      >
        <DialogContent finalFocus={addButton}>
          <DialogTitle>
            {label("移除此区域？", "Remove this region?")}
          </DialogTitle>
          <DialogDescription>
            {label(
              "此区域及其笔记将从当前本地审阅中移除。",
              "This region and its notes will be removed from the current local review.",
            )}
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving("")}>
              {label("取消", "Cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                change({ type: "remove", id: removing })
                setRemoving("")
              }}
            >
              {label("移除区域", "Remove region")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
