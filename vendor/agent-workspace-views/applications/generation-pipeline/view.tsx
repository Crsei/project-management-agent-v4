"use client"

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react"
import type { Dispatch, RefObject, SetStateAction } from "react"
import type { PipelineState } from "./controller"
import { SheetContent } from "@easyuse-ui/ui/components/ui/sheet"
import {
  ArrowUpRight,
  Check,
  Copy,
  Download,
  FileUp,
  ImagePlus,
  Link2,
  Minus,
  Monitor,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  SkipForward,
  Square,
  Undo2,
  Youtube,
} from "lucide-react"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import { Skeleton } from "@easyuse-ui/ui/components/ui/skeleton"
import { NativeSelect } from "@easyuse-ui/ui/components/ui/native-select"
import { Field } from "@easyuse-ui/ui/components/ui/field"
import { RuntimeStatusBadge } from "@easyuse-ui/ui/components/ui/runtime-status-badge"
import { WorkflowCanvas } from "@easyuse-ui/ui/components/blocks/workflow-canvas"
import { CanvasPort } from "@easyuse-ui/ui/components/ui/canvas-port"
import type { CanvasNodeProps } from "@easyuse-ui/ui/components/ui/canvas-node"
import {
  Sheet,
  SheetBody,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@easyuse-ui/ui/components/ui/sheet"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@easyuse-ui/ui/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@easyuse-ui/ui/components/ui/dropdown-menu"
import { CanvasConnectionForm } from "@easyuse-ui/ui/components/blocks/canvas-connection-form"
import { exportCanvasDocument } from "@easyuse-ui/ui/lib/canvas-validation"
import type {
  CanvasCommand,
  CanvasDocument,
  CanvasNodeRecord,
  CanvasSelection,
} from "@easyuse-ui/ui/lib/canvas-model"
import {
  RemainingPageStateProvider,
  useRemainingPageState,
} from "../../showcase/state"
import {
  remainingPageScenarios,
  type RemainingPageProps,
} from "../../showcase/model"
import {
  addThumbnail,
  advanceDemo,
  changePipeline,
  chooseThumbnail,
  chooseTitle,
  createPipelineState,
  importPipeline,
  queryDemo,
  redoPipeline,
  savePipeline,
  startDemo,
  undoPipeline,
  updateObject,
} from "./controller"
import {
  createPipeline,
  definitionsByLocale,
  description,
  headlines,
  kindLabels,
  mediaSizes,
  objectLabels,
  titleIdeas,
  transcript,
  type MediaKind,
} from "./fixtures"
import styles from "./view.module.css"

export const pageScenarios = [
  ...remainingPageScenarios,
  {
    id: "running",
    name: { "zh-CN": "本地演示运行中", en: "Local demo running" },
  },
  { id: "failed", name: { "zh-CN": "演示失败", en: "Demo failed" } },
  { id: "unknown", name: { "zh-CN": "结果未知", en: "Unknown outcome" } },
] as const

function PodcastArtwork({
  headline = "",
  image = "",
  color = "amber",
  source = false,
}: {
  headline?: string
  image?: string
  color?: string
  source?: boolean
}) {
  const { locale } = useI18n()
  const id = useId().replaceAll(":", "")
  const lines = headline.split("\n")
  return (
    <svg
      viewBox="0 0 1280 720"
      role="img"
      aria-label={
        source
          ? locale === "en"
            ? "Original podcast studio illustration"
            : "原创播客录音室插画"
          : headline
      }
      className={styles.artwork}
      data-color={color}
    >
      <defs>
        <linearGradient id={`studio-${id}`}>
          <stop stopColor="var(--foreground)" />
          <stop offset="1" stopColor="var(--text-secondary)" />
        </linearGradient>
      </defs>
      <rect width="1280" height="720" fill={`url(#studio-${id})`} />
      {[0, 1, 2, 3, 4, 5, 6].map((index) => (
        <rect
          key={index}
          x={560 + index * 110}
          width="36"
          height="720"
          fill="var(--background)"
          opacity=".12"
        />
      ))}
      {image ? (
        <image
          href={image}
          x="0"
          y="0"
          width="1280"
          height="720"
          preserveAspectRatio="xMidYMid slice"
        />
      ) : (
        <g>
          <path
            d="M740 695 Q660 550 810 447 L1054 449 Q1210 563 1240 720Z"
            fill="var(--surface-raised)"
          />
          <path
            d="M794 350 Q738 109 897 92 Q1083 56 1132 356 L1090 489 L824 468Z"
            fill="var(--foreground)"
          />
          <ellipse cx="945" cy="290" rx="113" ry="153" fill="var(--chart-4)" />
          <path
            d="M825 262 Q813 79 952 91 Q1074 97 1086 240 Q996 161 953 165 Q903 244 825 262Z"
            fill="var(--foreground)"
          />
          <path
            d="M898 356 Q942 381 985 347"
            fill="none"
            stroke="var(--foreground)"
            strokeWidth="9"
            strokeLinecap="round"
          />
          <circle cx="903" cy="274" r="8" fill="var(--foreground)" />
          <circle cx="983" cy="272" r="8" fill="var(--foreground)" />
          <path
            d="M1280 536 L1056 423 L975 467"
            fill="none"
            stroke="var(--text-muted)"
            strokeWidth="28"
          />
          <rect
            x="981"
            y="372"
            width="68"
            height="180"
            rx="32"
            transform="rotate(-25 1015 462)"
            fill="var(--foreground)"
            stroke="var(--text-muted)"
            strokeWidth="6"
          />
          <path
            d="M106 647 Q45 417 132 299 Q194 418 184 643"
            fill="none"
            stroke="var(--chart-4)"
            strokeWidth="35"
          />
          <rect
            x="68"
            y="644"
            width="143"
            height="76"
            fill="var(--text-muted)"
          />
        </g>
      )}
      {!source && (
        <>
          <rect width="750" height="720" className={styles.treatment} />
          <text
            x="52"
            y="92"
            fontSize="30"
            letterSpacing="6"
            fill="var(--foreground)"
          >
            STUDIO NOTES
          </text>
          {lines.map((line, index) => (
            <text
              key={index}
              x="50"
              y={227 + index * 120}
              fontSize={lines.length > 2 ? "95" : "110"}
              fontWeight="600"
              fill="var(--foreground)"
            >
              {line}
            </text>
          ))}
          <rect
            x="50"
            y="589"
            width="201"
            height="58"
            rx="5"
            fill="none"
            stroke="var(--foreground)"
            strokeWidth="3"
          />
          <text x="74" y="628" fontSize="25" fill="var(--foreground)">
            EPISODE 01
          </text>
        </>
      )}
    </svg>
  )
}
function downloadText(text: string, name: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
export function RemainingPageView(props: RemainingPageProps) {
  return (
    <RemainingPageStateProvider cache={props.cache}>
      <PipelineView key={props.scenario} {...props} />
    </RemainingPageStateProvider>
  )
}
function PipelineView({ scenario, active, host, cache }: RemainingPageProps) {
  const { locale } = useI18n()
  const definitions = definitionsByLocale[locale]
  const label = useCallback(
    (zh: string, en: string) => (locale === "en" ? en : zh),
    [locale],
  )
  const [state, setState] = useRemainingPageState(
    `generation-pipeline:${scenario}:state`,
    () => createPipelineState(scenario),
  )
  const [dialog, setDialog] = useState<"reset" | "import" | "connect" | null>(
    null,
  )
  const [importDraft, setImportDraft] = useRemainingPageState(
    `generation-pipeline:${scenario}:import`,
    () => "",
  )
  const [urlDraft, setUrlDraft] = useRemainingPageState(
    `generation-pipeline:${scenario}:url-draft`,
    () =>
      String(
        state.document.nodes.find((node) => node.id === "source")?.config.url ??
          "",
      ),
  )
  const regionRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const inspectRef = useRef<HTMLDivElement>(null)
  const originFocus = useRef<HTMLElement | null>(null)
  const [focusRequest, setFocusRequest] = useState<{
    id: string
    request: number
  }>()
  const readonly = scenario === "readonly"
  const locked =
    readonly ||
    state.readState === "loading" ||
    state.run?.outcome === "unknown"
  const selectedThumbnailId = String(
    state.document.nodes.find((node) => node.id === "publish")?.config
      .thumbnailId ?? "thumb-1",
  )
  const thumbnail = state.document.nodes.find(
    (node) => node.id === selectedThumbnailId,
  )
  const selectedTitle = Number(
    state.document.nodes.find((node) => node.id === "titles")?.config
      .selected ?? 0,
  )
  const sourceImage = String(
    state.document.nodes.find((node) => node.id === "source")?.config.image ??
      "",
  )
  const inspected = state.document.nodes.find(
    (node) => node.id === state.inspectorId,
  )
  const heading = useCallback(
    (node: CanvasNodeRecord) =>
      node.title === objectLabels[node.id]?.en
        ? objectLabels[node.id][locale]
        : node.type === "thumbnail" &&
            /^Thumbnail \/ \d+$/.test(node.title) &&
            locale === "zh-CN"
          ? node.title.replace("Thumbnail", "缩略图")
          : node.title,
    [locale],
  )
  const textFor = useCallback(
    (node: CanvasNodeRecord) =>
      String(
        node.config.text ??
          (node.type === "transcript"
            ? transcript[locale]
            : description[locale]),
      ) +
      (scenario === "long-content" && node.config.text === undefined
        ? `\n\n${transcript[locale].repeat(8)}`
        : ""),
    [locale, scenario],
  )
  const headlineFor = useCallback(
    (node: CanvasNodeRecord | undefined) =>
      String(
        node?.config.headline ??
          headlines[node?.id === "thumb-2" ? 1 : 0][locale],
      ),
    [locale],
  )
  const command = useCallback(
    (command: CanvasCommand) =>
      setState((previous) => changePipeline(previous, command, locked)),
    [setState, locked],
  )
  const select = useCallback(
    (selection: CanvasSelection) =>
      setState((previous) => ({ ...previous, selection })),
    [setState],
  )
  const viewport = useCallback(
    (viewport: NonNullable<CanvasDocument["viewport"]>) =>
      setState((previous) =>
        previous.document.nodes.length
          ? { ...previous, document: { ...previous.document, viewport } }
          : previous,
      ),
    [setState],
  )
  const inspect = useCallback(
    (id: string) => {
      if (!state.inspectorId)
        originFocus.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null
      setState((previous) => ({
        ...previous,
        inspectorId: id,
        selection: { nodeIds: [id], edgeIds: [] },
      }))
    },
    [state.inspectorId, setState],
  )
  useLayoutEffect(() => {
    const region = regionRef.current
    if (!active || !region || state.document.viewport || !state.document.nodes.length)
      return
    const fit = () => {
      const size = region.getBoundingClientRect()
      if (size.width <= 120 || size.height <= 60) return
      const zoom = Math.min((size.width - 120) / 1640, (size.height - 60) / 1025)
      viewport({ x: (size.width - 1640 * zoom) / 2, y: 30, zoom })
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(region)
    return () => observer.disconnect()
  }, [active, state.document.viewport, state.document.nodes.length, viewport])
  useLayoutEffect(() => {
    if (active && inspectRef.current && state.inspectorId)
      inspectRef.current.scrollTop = Number(
        cache.get(
          `generation-pipeline:${scenario}:reading:${state.inspectorId}`,
        ) ?? 0,
      )
  }, [active, state.inspectorId, cache, scenario])
  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        !(event.target instanceof Element) ||
        event.target.closest(
          "input,textarea,select,[contenteditable=true],[role=dialog],[role=menu]",
        )
      )
        return
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "z" &&
        event.target.closest("[data-canvas-editor-context]")
      ) {
        event.preventDefault()
        setState((previous) =>
          event.shiftKey
            ? redoPipeline(previous, locked)
            : undoPipeline(previous, locked),
        )
      }
      if (event.key === "Enter" && event.target.matches(".react-flow__node")) {
        const id = event.target.getAttribute("data-id")
        if (id) {
          event.preventDefault()
          inspect(id)
        }
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [active, locked, setState, inspect])
  async function replaceImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file || locked) return
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 300 * 1024
    ) {
      setState((previous) => ({
        ...previous,
        feedback: {
          "zh-CN":
            "请选择不超过 300 KiB 的 PNG、JPEG 或 WebP 图片，以便安全导出本地图。",
          en: "Choose a PNG, JPEG, or WebP image up to 300 KiB so the local graph can be safely exported.",
        },
      }))
      return
    }
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = reject
      reader.readAsDataURL(file)
    }).catch(() => null)
    if (!data) {
      setState((previous) => ({
        ...previous,
        feedback: {
          "zh-CN": "无法读取图片，保留原图。",
          en: "The image could not be read. The original was preserved.",
        },
      }))
      return
    }
    setState((previous) =>
      updateObject(previous, "source", { config: { image: data } }, locked),
    )
  }
  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setState((previous) => ({
        ...previous,
        feedback: { "zh-CN": "已复制文本。", en: "Text copied." },
      }))
    } catch {
      setState((previous) => ({
        ...previous,
        feedback: {
          "zh-CN": "剪贴板不可用，请在文本框中选择并复制。",
          en: "Clipboard unavailable. Select and copy the text in its field.",
        },
      }))
    }
  }
  function downloadThumbnail(id: string) {
    const svg = document.querySelector(
      `[data-media-object="${id}"] svg[role="img"]`,
    )
    if (!(svg instanceof SVGSVGElement)) return
    const clone = svg.cloneNode(true) as SVGSVGElement
    const originals = [svg, ...svg.querySelectorAll("*")]
    const copies = [clone, ...clone.querySelectorAll("*")]
    originals.forEach((element, index) => {
      const style = getComputedStyle(element)
      for (const key of ["fill", "stroke", "stop-color"])
        if (
          style.getPropertyValue(key) &&
          !style.getPropertyValue(key).includes("url(")
        )
          copies[index].setAttribute(key, style.getPropertyValue(key))
    })
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg")
    clone.setAttribute("width", "1280")
    clone.setAttribute("height", "720")
    downloadText(
      new XMLSerializer().serializeToString(clone),
      `${id}.svg`,
      "image/svg+xml",
    )
  }
  const renderNode = useCallback(
    ({ node, definition, selected, readOnly }: CanvasNodeProps) => {
      const kind = node.type as MediaKind
      const size = mediaSizes[kind]
      const runStatus =
        state.run?.revision === state.document.revision
          ? state.run.finished.includes(node.id)
            ? "completed"
            : state.run.order[state.run.index] === node.id
              ? state.run.status
              : "queued"
          : undefined
      return (
        <article
          className={styles.mediaObject}
          style={size}
          data-media-object={node.id}
          data-canvas-node={node.id}
          data-selected={selected || undefined}
          aria-label={`${kindLabels[kind][locale]}: ${heading(node)}`}
        >
          <div className={styles.objectHeading} data-media-drag>
            <span>
              <i data-kind={kind} />
              {heading(node)}
            </span>
            {runStatus && <RuntimeStatusBadge status={runStatus} />}
            <Button
              variant="ghost"
              size="icon-sm"
              className="nodrag"
              aria-label={`${label("检查", "Inspect")} ${heading(node)}`}
              onClick={() => inspect(node.id)}
            >
              <ArrowUpRight />
            </Button>
          </div>
          <div className={styles.objectBody}>
            {kind === "source" && (
              <>
                <div className={styles.sourceFrame}>
                  <PodcastArtwork source image={sourceImage} />
                  <span>08:24</span>
                </div>
                <div className={styles.sourceDetails}>
                  <p>
                    {label(
                      "录制你的第一期播客",
                      "Recording your first podcast",
                    )}
                  </p>
                  <small>
                    {label(
                      "示例节目 · 粘贴 URL 试用流程",
                      "Sample episode · paste a URL to try the workflow",
                    )}
                  </small>
                  <div className={`${styles.url} nodrag nopan`}>
                    <Input
                      aria-label={label(
                        "YouTube 视频 URL",
                        "YouTube video URL",
                      )}
                      placeholder={label(
                        "粘贴 YouTube URL",
                        "Paste YouTube URL",
                      )}
                      value={urlDraft}
                      readOnly={locked}
                      onChange={(event) => setUrlDraft(event.target.value)}
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={locked || !urlDraft.trim()}
                      aria-label={label("使用 YouTube URL", "Use YouTube URL")}
                      onClick={() =>
                        setState((previous) => ({
                          ...updateObject(
                            previous,
                            node.id,
                            { config: { url: urlDraft.trim() } },
                            locked,
                          ),
                          feedback: {
                            "zh-CN":
                              "URL 已保留为本地来源引用。示例不会下载视频或调用 YouTube。",
                            en: "The URL is retained as a local source reference. This example does not fetch video or call YouTube.",
                          },
                        }))
                      }
                    >
                      <Link2 />
                    </Button>
                  </div>
                  <Button
                    className={`nodrag ${styles.transcribe}`}
                    disabled={locked}
                    onClick={() =>
                      setState((previous) =>
                        startDemo(previous, "source", locked),
                      )
                    }
                  >
                    <FileUp />
                    {label("转录视频", "Transcribe video")}
                  </Button>
                </div>
              </>
            )}
            {(kind === "transcript" || kind === "description") && (
              <>
                <div className={styles.textHeading}>
                  <span>{kindLabels[kind][locale]}</span>
                  <span>
                    {kind === "transcript"
                      ? label("中文 · 示例", "EN · sample")
                      : label("来自转录", "From transcript")}
                  </span>
                </div>
                <Textarea
                  className={`${styles.canvasText} nodrag nopan nowheel`}
                  aria-label={`${kindLabels[kind][locale]}: ${heading(node)}`}
                  value={textFor(node)}
                  readOnly={locked}
                  onScroll={(event) =>
                    cache.set(
                      `generation-pipeline:${scenario}:text:${node.id}`,
                      event.currentTarget.scrollTop,
                    )
                  }
                  ref={(element) => {
                    if (element)
                      element.scrollTop = Number(
                        cache.get(
                          `generation-pipeline:${scenario}:text:${node.id}`,
                        ) ?? 0,
                      )
                  }}
                  onChange={(event) =>
                    setState((previous) =>
                      updateObject(
                        previous,
                        node.id,
                        { config: { text: event.target.value } },
                        locked,
                      ),
                    )
                  }
                />
              </>
            )}
            {kind === "titles" && (
              <>
                <div className={styles.textHeading}>
                  <span>{label("标题", "Titles")}</span>
                  <span>{label("来自转录", "From transcript")}</span>
                </div>
                <div className={styles.titleList}>
                  {titleIdeas.map((title, index) => (
                    <Button
                      key={index}
                      variant="ghost"
                      className="nodrag"
                      aria-pressed={selectedTitle === index}
                      disabled={locked}
                      onClick={() =>
                        setState((previous) =>
                          chooseTitle(previous, index, locked),
                        )
                      }
                    >
                      <small>{String(index + 1).padStart(2, "0")}</small>
                      <span>{title[locale]}</span>
                      {selectedTitle === index && <Check />}
                    </Button>
                  ))}
                </div>
              </>
            )}
            {kind === "thumbnail" && (
              <>
                <PodcastArtwork
                  image={sourceImage}
                  color={String(node.config.color)}
                  headline={headlineFor(node)}
                />
                <div className={styles.thumbnailFooter}>
                  <small>1280 × 720</small>
                  <Button
                    variant={
                      selectedThumbnailId === node.id ? "secondary" : "ghost"
                    }
                    className="nodrag"
                    disabled={locked}
                    aria-pressed={selectedThumbnailId === node.id}
                    onClick={() =>
                      setState((previous) =>
                        chooseThumbnail(previous, node.id, locked),
                      )
                    }
                  >
                    {selectedThumbnailId === node.id && <Check />}
                    {selectedThumbnailId === node.id
                      ? label("已选择", "Selected")
                      : label("使用缩略图", "Use thumbnail")}
                  </Button>
                </div>
              </>
            )}
            {kind === "publish" && (
              <>
                <PodcastArtwork
                  image={sourceImage}
                  color={String(thumbnail?.config.color ?? "amber")}
                  headline={headlineFor(thumbnail)}
                />
                <div className={styles.previewMeta}>
                  <span>SN</span>
                  <div>
                    <p>
                      {titleIdeas[selectedTitle]?.[locale] ??
                        titleIdeas[0][locale]}
                    </p>
                    <small>
                      {label("Studio Notes · 预览", "Studio Notes · Preview")}
                    </small>
                  </div>
                </div>
              </>
            )}
          </div>
          <div className={styles.ports}>
            {definition?.ports.map((port) => (
              <CanvasPort key={port.id} port={port} readOnly={readOnly} />
            ))}
          </div>
        </article>
      )
    },
    [
      state.run,
      state.document.revision,
      selectedTitle,
      selectedThumbnailId,
      thumbnail,
      locale,
      label,
      heading,
      inspect,
      sourceImage,
      locked,
      setState,
      textFor,
      headlineFor,
      cache,
      scenario,
      urlDraft,
      setUrlDraft,
    ],
  )
  return (
    <div className={styles.root} data-remaining-page="generation-pipeline">
      <section className={styles.main}
      id={host.mainContentId ?? "generation-pipeline-content"}><header className={styles.header}>
        <Youtube />
        <h1>{label("YouTube 内容", "YouTube content")}</h1>
        <span className={styles.project}>
          {label("播客设置", "Podcast setup")}
        </span>
        <div className={styles.headerActions}>
          <Button
            variant="ghost"
            size="icon"
            aria-label={label("撤销", "Undo")}
            disabled={locked || !state.past.length}
            onClick={() =>
              setState((previous) => undoPipeline(previous, locked))
            }
          >
            <Undo2 />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={label("重做", "Redo")}
            disabled={locked || !state.future.length}
            onClick={() =>
              setState((previous) => redoPipeline(previous, locked))
            }
          >
            <Redo2 />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={label("工作区操作", "Workspace actions")}
                />
              }
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem
                onClick={() =>
                  downloadText(
                    exportCanvasDocument(state.document),
                    "youtube-content-pipeline.json",
                    "application/json",
                  )
                }
              >
                <Download />
                {label("导出项目", "Export project")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={locked}
                onClick={() => setDialog("import")}
              >
                <FileUp />
                {label("导入项目", "Import project")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={locked}
                onClick={() => setDialog("connect")}
              >
                <Link2 />
                {label("连接对象", "Connect objects")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon"
            disabled={locked}
            aria-label={label("保存画布", "Save canvas")}
            onClick={() =>
              setState((previous) => savePipeline(previous, locked))
            }
          >
            <Save />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            disabled={locked}
            aria-label={label("重置示例", "Reset example")}
            onClick={() => setDialog("reset")}
          >
            <RotateCcw />
          </Button>
          <Button
            variant="ghost"
            disabled={locked}
            onClick={() =>
              setState((previous) => addThumbnail(previous, locked))
            }
          >
            <Plus />
            {label("缩略图", "Thumbnail")}
          </Button>
          <Button
            disabled={locked || state.run?.status === "running"}
            onClick={() =>
              setState((previous) => startDemo(previous, "source", locked))
            }
          >
            <Play />
            {label("运行演示", "Run demo")}
          </Button>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label("切换主题", "Toggle theme")}
          onClick={() =>
            host.setTheme(host.resolvedTheme === "dark" ? "light" : "dark")
          }
        >
          <Monitor />
        </Button>
      </header>
      {(state.readState !== "ready" ||
        readonly ||
        state.run?.outcome === "unknown") && (
        <div className={styles.notice} role="status">
          <span>
            {state.readState === "error"
              ? label(
                  "刷新失败 · 保留已有草稿",
                  "Refresh failed · existing draft retained",
                )
              : state.readState === "loading"
                ? label(
                    "正在读取本地流程快照…",
                    "Reading the local pipeline snapshot…",
                  )
                : readonly
                  ? label(
                      "只读 · 可检查与缩放，不允许编辑或运行",
                      "Read only · inspect and zoom; editing and running are disabled",
                    )
                  : label(
                      "结果未知 · 先查询，不自动重放",
                      "Unknown outcome · query first; no automatic replay",
                    )}
          </span>
          {state.readState !== "ready" && (
            <Button
              variant="secondary"
              onClick={() =>
                setState((previous) => ({
                  ...previous,
                  readState: "ready",
                  document: previous.document.nodes.length
                    ? previous.document
                    : createPipeline("default"),
                }))
              }
            >
              {label("读取本地快照", "Read local snapshot")}
            </Button>
          )}
          {state.run?.outcome === "unknown" && (
            <Button variant="secondary" onClick={() => setState(queryDemo)}>
              {label("查询本地快照", "Query local snapshot")}
            </Button>
          )}
        </div>
      )}
      <div
        className={styles.canvasRegion}
        ref={regionRef}
        aria-busy={state.readState === "loading"}
      >
        {(!state.document.nodes.length || state.document.viewport) && <WorkflowCanvas
          className={styles.canvas}
          presentation="media"
          showBackground={false}
          showMiniMap={false}
          defaultInteractionMode="select"
          nodeDragHandle="[data-media-drag]"
          toolbarActions={
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label={label("添加缩略图分支", "Add thumbnail branch")}
                disabled={locked}
                onClick={() =>
                  setState((previous) => addThumbnail(previous, locked))
                }
              >
                <Plus />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={label("替换来源图片", "Replace source image")}
                disabled={locked || !state.document.nodes.length}
                onClick={() => fileRef.current?.click()}
              >
                <ImagePlus />
              </Button>
            </>
          }
          document={state.document}
          definitions={definitions}
          selection={state.selection}
          onSelectionChange={select}
          onCommand={command}
          readOnly={locked}
          renderNode={renderNode}
          viewport={state.document.viewport}
          onViewportChange={viewport}
          onOpenNode={inspect}
          focusRequest={focusRequest}
        />}
        {!state.document.nodes.length && (
          <div className={styles.empty}>
            {state.readState === "loading" ? (
              <div className="flex w-80 flex-col gap-4">
                <Skeleton className="h-20" />
                <Skeleton className="h-20" />
                <Skeleton className="h-20" />
              </div>
            ) : (
              <Youtube />
            )}
            <h2>
              {state.readState === "loading"
                ? label("正在加载媒体流程", "Loading media pipeline")
                : label("尚无媒体对象", "No media objects yet")}
            </h2>
            <p>
              {label(
                "使用本地示例创建来源、转录与预览。不连接外部服务。",
                "Use the local example to create a source, transcript, and preview. No external service is connected.",
              )}
            </p>
            <Button
              disabled={locked}
              onClick={() =>
                setState((previous) =>
                  changePipeline(
                    previous,
                    { type: "replace", document: createPipeline("default") },
                    locked,
                  ),
                )
              }
            >
              {label("使用本地示例", "Use local example")}
            </Button>
          </div>
        )}
      </div>
      <footer className={styles.footer}>
        <span>
          {label(
            "脚本演示 · 原创示例插画",
            "Scripted demo · original sample illustration",
          )}
          <span>
            {" "}
            · {label("拖动标题 · 连接端口", "Drag headings · connect ports")}
          </span>
        </span>
        <div className={styles.runControls}>
          {state.run && (
            <>
              <RuntimeStatusBadge status={state.run.status} />
              <span>
                {state.run.outcome === "unknown"
                  ? label("结果未知", "Unknown outcome")
                  : `${state.run.finished.length}/${state.run.order.length}`}
              </span>
              {state.run.status === "running" && (
                <>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={label(
                      "推进本地演示一步",
                      "Advance local demo one step",
                    )}
                    onClick={() => setState(advanceDemo)}
                  >
                    <SkipForward />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={label("暂停演示", "Pause demo")}
                    onClick={() =>
                      setState((previous) => ({
                        ...previous,
                        run: previous.run && {
                          ...previous.run,
                          status: "paused",
                        },
                      }))
                    }
                  >
                    <Pause />
                  </Button>
                </>
              )}
              {state.run.status === "paused" &&
                state.run.outcome === "known" && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={label("继续演示", "Resume demo")}
                    onClick={() =>
                      setState((previous) => ({
                        ...previous,
                        run: previous.run && {
                          ...previous.run,
                          status: "running",
                        },
                      }))
                    }
                  >
                    <Play />
                  </Button>
                )}
              {["running", "paused"].includes(state.run.status) &&
                state.run.outcome === "known" && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={label("取消演示", "Cancel demo")}
                    onClick={() =>
                      setState((previous) => ({
                        ...previous,
                        run: previous.run && {
                          ...previous.run,
                          status: "cancelled",
                        },
                      }))
                    }
                  >
                    <Square />
                  </Button>
                )}
              {state.run.status === "failed" && (
                <Button
                  variant="ghost"
                  onClick={() => setState((previous) => startDemo(previous))}
                >
                  {label("重试本地演示", "Retry local demo")}
                </Button>
              )}
            </>
          )}
          <span role="status">
            {state.feedback?.[locale] ??
              (state.saved?.revision === state.document.revision
                ? label("已保存到本页内存", "Saved in page memory")
                : label("本地草稿 · 未保存", "Local draft · unsaved"))}
          </span>
        </div>
      </footer>
      <input
        ref={fileRef}
        className="sr-only"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        aria-label={label("选择本地来源图片", "Choose local source image")}
        onChange={replaceImage}
        disabled={locked}
      /></section>
      <Sheet
        open={!!inspected}
        onOpenChange={(open) => {
          if (!open) {
            setState((previous) => ({ ...previous, inspectorId: null }))
            requestAnimationFrame(() => originFocus.current?.focus())
          }
        }}
      >
        <SheetContentLocal
          inspected={inspected}
          heading={heading}
          label={label}
          locale={locale}
          locked={locked}
          state={state}
          setState={setState}
          textFor={textFor}
          headlineFor={headlineFor}
          sourceImage={sourceImage}
          cache={cache}
          scenario={scenario}
          inspectRef={inspectRef}
          inspect={inspect}
          fileRef={fileRef}
          copyText={copyText}
          downloadThumbnail={downloadThumbnail}
          setFocusRequest={setFocusRequest}
        />
      </Sheet>
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null)
        }}
      >
        <DialogContent>
          <DialogTitle>
            {dialog === "reset"
              ? label("重置本地示例？", "Reset the local example?")
              : dialog === "import"
                ? label("导入项目", "Import project")
                : label("连接媒体对象", "Connect media objects")}
          </DialogTitle>
          <DialogDescription>
            {dialog === "reset"
              ? label(
                  "只重置当前场景的画布草稿，其他场景不受影响。",
                  "Reset only the current scenario's draft; other scenarios are unaffected.",
                )
              : label(
                  "所有修改仅发生在本页内存中，不执行外部服务。",
                  "All edits stay in page memory and do not execute an external service.",
                )}
          </DialogDescription>
          {dialog === "reset" ? (
            <div className={styles.dialogActions}>
              <Button variant="secondary" onClick={() => setDialog(null)}>
                {label("取消", "Cancel")}
              </Button>
              <Button
                disabled={locked}
                onClick={() => {
                  for (const key of cache.keys())
                    if (
                      key.startsWith(
                        `generation-pipeline:${scenario}:reading:`,
                      ) ||
                      key.startsWith(`generation-pipeline:${scenario}:text:`)
                    )
                      cache.delete(key)
                  setState(createPipelineState("default"))
                  setUrlDraft("")
                  setImportDraft("")
                  setDialog(null)
                }}
              >
                {label("重置本场景", "Reset this scenario")}
              </Button>
            </div>
          ) : dialog === "import" ? (
            <>
              <Field label={label("项目 JSON", "Project JSON")}>
                {(controlProps) => (
                  <Textarea
                    {...controlProps}
                    value={importDraft}
                    className={styles.importText}
                    onChange={(event) => setImportDraft(event.target.value)}
                  />
                )}
              </Field>
              <p role="status">{state.feedback?.[locale]}</p>
              <div className={styles.dialogActions}>
                <Button variant="secondary" onClick={() => setDialog(null)}>
                  {label("取消", "Cancel")}
                </Button>
                <Button
                  disabled={locked || !importDraft.trim()}
                  onClick={() => {
                    const next = importPipeline(state, importDraft, locked)
                    setState(next)
                    if (next.document !== state.document) {
                      setUrlDraft(
                        String(
                          next.document.nodes.find(
                            (node) => node.id === "source",
                          )?.config.url ?? "",
                        ),
                      )
                      setDialog(null)
                    }
                  }}
                >
                  {label("导入并替换", "Import and replace")}
                </Button>
              </div>
            </>
          ) : (
            <CanvasConnectionForm
              document={state.document}
              definitions={definitions}
              onCommand={command}
              readOnly={locked}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

type InspectorProps = {
  inspected: CanvasNodeRecord | undefined
  heading: (node: CanvasNodeRecord) => string
  label: (zh: string, en: string) => string
  locale: "en" | "zh-CN"
  locked: boolean
  state: PipelineState
  setState: Dispatch<SetStateAction<PipelineState>>
  textFor: (node: CanvasNodeRecord) => string
  headlineFor: (node: CanvasNodeRecord | undefined) => string
  sourceImage: string
  cache: Map<string, unknown>
  scenario: string
  inspectRef: RefObject<HTMLDivElement | null>
  inspect: (id: string) => void
  fileRef: RefObject<HTMLInputElement | null>
  copyText: (text: string) => void
  downloadThumbnail: (id: string) => void
  setFocusRequest: Dispatch<
    SetStateAction<{ id: string; request: number } | undefined>
  >
}
function SheetContentLocal({
  inspected,
  heading,
  label,
  locale,
  locked,
  state,
  setState,
  textFor,
  headlineFor,
  sourceImage,
  cache,
  scenario,
  inspectRef,
  inspect,
  fileRef,
  copyText,
  downloadThumbnail,
  setFocusRequest,
}: InspectorProps) {
  if (!inspected) return null
  const kind = inspected.type as MediaKind
  const inputs = state.document.edges.filter(
    (edge) => edge.target === inspected.id,
  )
  const selected = String(
    state.document.nodes.find((node) => node.id === "publish")?.config
      .thumbnailId ?? "thumb-1",
  )
  return (
    <SheetContent size={384} className={styles.sheet}>
      <SheetHeader>
        <SheetTitle>{heading(inspected)}</SheetTitle>
        <SheetDescription>
          {label(
            "检查并编辑工作区对象。",
            "Inspect and edit this workspace object.",
          )}
        </SheetDescription>
      </SheetHeader>
      <SheetBody
        ref={inspectRef}
        onScroll={(event) =>
          cache.set(
            `generation-pipeline:${scenario}:reading:${inspected.id}`,
            event.currentTarget.scrollTop,
          )
        }
        className={styles.inspectorBody}
      >
        <div className={styles.objectStatus}>
          <i />
          {kindLabels[kind][locale]} ·{" "}
          {label("就绪 · 本地示例", "Ready · local example")}
        </div>
        {kind === "thumbnail" && (
          <PodcastArtwork
            image={sourceImage}
            color={String(inspected.config.color)}
            headline={headlineFor(inspected)}
          />
        )}
        <Field label={label("名称", "Name")}>
          {(controlProps) => (
            <Input
              {...controlProps}
              value={heading(inspected)}
              readOnly={locked}
              onChange={(event) =>
                setState((previous) =>
                  updateObject(
                    previous,
                    inspected.id,
                    { title: event.target.value },
                    locked,
                  ),
                )
              }
            />
          )}
        </Field>
        {kind === "source" && (
          <>
            <p>{label("内置原创示例来源", "Bundled original sample source")}</p>
            <Button
              variant="secondary"
              disabled={locked}
              onClick={() => fileRef.current?.click()}
            >
              <ImagePlus />
              {label("替换图片", "Replace image")}
            </Button>
            <Button
              variant="ghost"
              disabled={locked || !sourceImage}
              onClick={() =>
                setState((previous) =>
                  updateObject(
                    previous,
                    inspected.id,
                    { config: { image: "" } },
                    locked,
                  ),
                )
              }
            >
              {label("使用示例图片", "Use sample image")}
            </Button>
          </>
        )}
        {(kind === "transcript" || kind === "description") && (
          <>
            <Field label={kindLabels[kind][locale]}>
              {(controlProps) => (
                <Textarea
                  {...controlProps}
                  className={`${styles.inspectorText} nowheel`}
                  value={textFor(inspected)}
                  readOnly={locked}
                  onChange={(event) =>
                    setState((previous) =>
                      updateObject(
                        previous,
                        inspected.id,
                        { config: { text: event.target.value } },
                        locked,
                      ),
                    )
                  }
                />
              )}
            </Field>
            <Button
              variant="secondary"
              onClick={() => copyText(textFor(inspected))}
            >
              <Copy />
              {label("复制文本", "Copy text")}
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                downloadText(textFor(inspected), `${inspected.id}.txt`)
              }
            >
              <Download />
              {label("下载文本", "Download text")}
            </Button>
          </>
        )}
        {kind === "thumbnail" && (
          <>
            <Field label={label("主标题", "Headline")}>
              {(controlProps) => (
                <Textarea
                  {...controlProps}
                  value={headlineFor(inspected)}
                  readOnly={locked}
                  onChange={(event) =>
                    setState((previous) =>
                      updateObject(
                        previous,
                        inspected.id,
                        { config: { headline: event.target.value } },
                        locked,
                      ),
                    )
                  }
                />
              )}
            </Field>
            <Field label={label("色彩处理", "Color treatment")}>
              {(controlProps) => (
                <NativeSelect
                  {...controlProps}
                  value={String(inspected.config.color)}
                  disabled={locked}
                  onChange={(event) =>
                    setState((previous) =>
                      updateObject(
                        previous,
                        inspected.id,
                        { config: { color: event.target.value } },
                        locked,
                      ),
                    )
                  }
                >
                  <option value="amber">{label("琥珀", "Amber")}</option>
                  <option value="mint">{label("薄荷", "Mint")}</option>
                  <option value="rose">{label("玫瑰", "Rose")}</option>
                </NativeSelect>
              )}
            </Field>
            <Button
              variant="secondary"
              onClick={() => downloadThumbnail(inspected.id)}
            >
              <Download />
              {label("下载缩略图", "Download thumbnail")}
            </Button>
            <Button
              variant="secondary"
              disabled={locked || selected === inspected.id}
              onClick={() =>
                setState((previous) =>
                  chooseThumbnail(previous, inspected.id, locked),
                )
              }
            >
              <Check />
              {selected === inspected.id
                ? label("已选择", "Selected")
                : label("使用缩略图", "Use thumbnail")}
            </Button>
          </>
        )}
        {kind === "titles" && (
          <div className={styles.inspectorTitles}>
            {titleIdeas.map((title, index) => (
              <Button
                key={index}
                variant="secondary"
                disabled={locked}
                aria-pressed={Number(inspected.config.selected ?? 0) === index}
                onClick={() =>
                  setState((previous) => chooseTitle(previous, index, locked))
                }
              >
                {title[locale]}
              </Button>
            ))}
          </div>
        )}
        {kind !== "source" && (
          <Button
            variant="secondary"
            disabled={locked || state.run?.status === "running"}
            onClick={() =>
              setState((previous) => startDemo(previous, inspected.id, locked))
            }
          >
            <Play />
            {label("从此对象运行演示", "Run demo from this object")}
          </Button>
        )}
        <section className={styles.connected}>
          <h3>{label("已连接的输入", "Connected inputs")}</h3>
          {inputs.length ? (
            inputs.map((edge) => {
              const node = state.document.nodes.find(
                (node) => node.id === edge.source,
              )
              return (
                <div key={edge.id}>
                  <Button variant="ghost" onClick={() => inspect(edge.source)}>
                    {node ? heading(node) : edge.source}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`${label("断开", "Disconnect")} ${edge.source} → ${edge.target}`}
                    disabled={locked}
                    onClick={() =>
                      setState((previous) =>
                        changePipeline(
                          previous,
                          {
                            type: "delete",
                            selection: { nodeIds: [], edgeIds: [edge.id] },
                          },
                          locked,
                        ),
                      )
                    }
                  >
                    <Minus />
                  </Button>
                </div>
              )
            })
          ) : (
            <p>
              {kind === "source"
                ? label(
                    "来源对象 · 无上游输入",
                    "Source object · no upstream inputs",
                  )
                : label("没有连接的输入", "No connected inputs")}
            </p>
          )}
        </section>
        <Button
          variant="ghost"
          onClick={() => {
            setFocusRequest({ id: inspected.id, request: Date.now() })
            setState((previous) => ({ ...previous, inspectorId: null }))
          }}
        >
          {label("在画布中定位", "Locate on canvas")}
        </Button>
      </SheetBody>
    </SheetContent>
  )
}
