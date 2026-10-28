"use client"

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react"
import {
  ChangeSet as EditorChanges,
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  type StateEffect,
} from "@codemirror/state"
import {
  Decoration,
  EditorView,
  drawSelection,
  keymap,
  lineNumbers,
} from "@codemirror/view"
import {
  defaultHighlightStyle,
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language"
import { tags } from "@lezer/highlight"
import { javascript } from "@codemirror/lang-javascript"
import { css } from "@codemirror/lang-css"
import { html } from "@codemirror/lang-html"
import { json } from "@codemirror/lang-json"
import { markdown } from "@codemirror/lang-markdown"
import {
  closeSearchPanel,
  getSearchQuery,
  openSearchPanel,
  search,
  searchKeymap,
  searchPanelOpen,
  setSearchQuery,
} from "@codemirror/search"
import {
  getOriginalDoc,
  MergeView,
  originalDocChangeEffect,
  unifiedMergeView,
} from "@codemirror/merge"
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  Search,
  Trash2,
} from "lucide-react"
import {
  Button,
  Input,
  Textarea,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "./ui"
import {
  inferResourceLanguage,
  resolveDiffDocuments,
  type ChangedFile,
  type ChangeSet,
  type ResourceLanguage,
  type ReviewComment,
  type WorkbenchFile,
} from "./resource-model"
import styles from "./resources.module.css"
import { useConversationLocale } from "./locale"

export { inferResourceLanguage } from "./resource-model"

const PREVIEW_LIMIT = 200_000
const languageNames: Record<ResourceLanguage, string> = {
  text: "Plain text",
  javascript: "JavaScript",
  jsx: "JSX",
  typescript: "TypeScript",
  tsx: "TSX",
  json: "JSON",
  css: "CSS",
  html: "HTML",
  markdown: "Markdown",
}
const searchPhrases: Record<string, string> = {
  Find: "查找",
  Replace: "替换",
  next: "下一个",
  previous: "上一个",
  all: "全部",
  "match case": "区分大小写",
  regexp: "正则表达式",
  "by word": "全词匹配",
  close: "关闭",
  "current match": "当前匹配",
  "on line": "位于行",
  "Go to line": "跳转到行",
  go: "跳转",
}

// CSS resolves the scoped palette; theme changes never reconfigure or recreate a reader.
const readerHighlightStyle = HighlightStyle.define([
  ...defaultHighlightStyle.specs.filter((spec) => !spec.color),
  { tag: tags.meta, color: "var(--resource-syntax-meta)" },
  { tag: tags.keyword, color: "var(--resource-syntax-keyword)" },
  {
    tag: [
      tags.atom,
      tags.bool,
      tags.url,
      tags.contentSeparator,
      tags.labelName,
    ],
    color: "var(--resource-syntax-atom)",
  },
  {
    tag: [tags.literal, tags.inserted],
    color: "var(--resource-syntax-literal)",
  },
  { tag: [tags.string, tags.deleted], color: "var(--resource-syntax-string)" },
  {
    tag: [tags.regexp, tags.escape, tags.special(tags.string)],
    color: "var(--resource-syntax-regexp)",
  },
  {
    tag: tags.definition(tags.variableName),
    color: "var(--resource-syntax-definition)",
  },
  { tag: tags.local(tags.variableName), color: "var(--resource-syntax-local)" },
  {
    tag: [tags.typeName, tags.namespace],
    color: "var(--resource-syntax-type)",
  },
  { tag: tags.className, color: "var(--resource-syntax-class)" },
  {
    tag: [tags.special(tags.variableName), tags.macroName],
    color: "var(--resource-syntax-special)",
  },
  {
    tag: tags.definition(tags.propertyName),
    color: "var(--resource-syntax-property)",
  },
  { tag: tags.comment, color: "var(--resource-syntax-comment)" },
  { tag: tags.invalid, color: "var(--resource-syntax-invalid)" },
])

function languageExtension(language: ResourceLanguage): Extension {
  switch (language) {
    case "javascript":
      return javascript()
    case "jsx":
      return javascript({ jsx: true })
    case "typescript":
      return javascript({ typescript: true })
    case "tsx":
      return javascript({ typescript: true, jsx: true })
    case "json":
      return json()
    case "css":
      return css()
    case "html":
      return html()
    case "markdown":
      return markdown({
        addKeymap: false,
        completeHTMLTags: false,
        pasteURLAsLink: false,
      })
    default:
      return []
  }
}

function readOnlyExtensions(
  label: string,
  locale: "zh-CN" | "en",
): Extension[] {
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.contentAttributes.of({ "aria-label": label, tabindex: "0" }),
    EditorState.phrases.of(locale === "zh-CN" ? searchPhrases : {}),
    drawSelection(),
    lineNumbers(),
    syntaxHighlighting(readerHighlightStyle),
    search({ top: true }),
    keymap.of(searchKeymap),
  ]
}

function reconfigureReader(
  view: EditorView,
  effects: readonly StateEffect<unknown>[],
  locale: "zh-CN" | "en",
) {
  const refreshSearch =
    searchPanelOpen(view.state) &&
    view.state.phrase("Find") !== (locale === "zh-CN" ? "查找" : "Find")
  const query = refreshSearch ? getSearchQuery(view.state) : undefined
  const selection = view.state.selection
  const scroll = view.scrollSnapshot()
  const active = view.dom.ownerDocument.activeElement
  const searchControl =
    active instanceof HTMLElement &&
    active.closest(".cm-search") &&
    view.dom.contains(active)
      ? active.getAttribute("name")
      : null
  const inputSelection =
    active instanceof HTMLInputElement && active.type === "text"
      ? [active.selectionStart, active.selectionEnd]
      : undefined
  if (refreshSearch) closeSearchPanel(view)
  view.dispatch({ effects })
  if (refreshSearch && query) {
    openSearchPanel(view)
    view.dispatch({ selection, effects: [setSearchQuery.of(query), scroll] })
    const replacement = searchControl
      ? view.dom.querySelector<HTMLElement>(
          `.cm-search [name="${searchControl}"]`,
        )
      : null
    const target =
      replacement ??
      (active instanceof HTMLElement && active.isConnected ? active : null)
    target?.focus({ preventScroll: true })
    if (target instanceof HTMLInputElement && inputSelection)
      target.setSelectionRange(inputSelection[0], inputSelection[1])
  }
}

function updateReaderDocument(
  view: EditorView,
  doc: string,
  effects: readonly StateEffect<unknown>[] = [],
) {
  if (view.state.doc.toString() === doc) {
    if (effects.length) view.dispatch({ effects })
    return
  }
  const selection = EditorSelection.create(
    view.state.selection.ranges.map((range) =>
      EditorSelection.range(
        Math.min(range.anchor, doc.length),
        Math.min(range.head, doc.length),
      ),
    ),
    view.state.selection.mainIndex,
  )
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: doc },
    selection,
    effects: [...effects, view.scrollSnapshot()],
  })
}

interface EditorPosition {
  state: EditorState
  top: number
  left: number
}
interface EditorEngine {
  view: EditorView
  language: Compartment
  highlight: Compartment
  presentation: Compartment
}

function restoreReaderPosition(
  view: EditorView,
  position: EditorPosition | undefined,
) {
  if (position)
    view.requestMeasure({
      read: () => position,
      write: (saved) => {
        view.scrollDOM.scrollTop = saved.top
        view.scrollDOM.scrollLeft = saved.left
      },
    })
}
export interface ReadOnlyEditorProps {
  identity: string
  revision: string
  code: string
  path?: string
  language?: ResourceLanguage
  ariaLabel?: string
  highlightRange?: { start: number; end: number }
  maxPreviewCharacters?: number
  maxHeight?: number | string
  className?: string
}

/** DOM ownership stays with CodeMirror. Identity/revision isolate reading positions. */
export function ReadOnlyEditor({
  identity,
  revision,
  code,
  path,
  language = inferResourceLanguage(path),
  ariaLabel,
  highlightRange,
  maxPreviewCharacters = PREVIEW_LIMIT,
  maxHeight = 520,
  className,
}: ReadOnlyEditorProps) {
  const { locale } = useConversationLocale()
  const label = (zh: string, en: string) => (locale === "zh-CN" ? zh : en)
  const editorLabel = ariaLabel ?? path ?? label("只读源码", "Read-only source")
  const host = useRef<HTMLDivElement>(null)
  const engine = useRef<EditorEngine | null>(null)
  const positions = useRef(new Map<string, EditorPosition>())
  const key = JSON.stringify([identity, revision])
  const limit = Math.min(
    PREVIEW_LIMIT,
    Math.max(1, Math.floor(maxPreviewCharacters) || PREVIEW_LIMIT),
  )
  const preview = code.slice(0, limit)
  const [languageOverrides, setLanguageOverrides] = useState<
    Record<string, ResourceLanguage>
  >({})
  const selectedLanguage = languageOverrides[key] ?? language
  const languageId = useId()

  const initialize = useEffectEvent((parent: HTMLDivElement) => {
    const languageCompartment = new Compartment()
    const highlight = new Compartment()
    const presentation = new Compartment()
    const savedPositions = positions.current
    const saved = savedPositions.get(key)
    const state = EditorState.create({
      doc: preview,
      selection:
        saved && saved.state.doc.toString() === preview
          ? saved.state.selection
          : undefined,
      extensions: [
        presentation.of(readOnlyExtensions(editorLabel, locale)),
        languageCompartment.of(languageExtension(selectedLanguage)),
        highlight.of([]),
      ],
    })
    const view = new EditorView({ state, parent })
    restoreReaderPosition(view, saved)
    engine.current = {
      view,
      language: languageCompartment,
      highlight,
      presentation,
    }
    const observer = new ResizeObserver(() => view.requestMeasure())
    observer.observe(parent)
    return () => {
      savedPositions.set(key, {
        state: view.state,
        top: view.scrollDOM.scrollTop,
        left: view.scrollDOM.scrollLeft,
      })
      observer.disconnect()
      view.destroy()
      if (engine.current?.view === view) engine.current = null
    }
  })

  useEffect(() => {
    const parent = host.current
    if (parent) return initialize(parent)
  }, [key])

  useEffect(() => {
    const current = engine.current
    if (!current) return
    updateReaderDocument(current.view, preview)
    reconfigureReader(
      current.view,
      [
        current.language.reconfigure(languageExtension(selectedLanguage)),
        current.presentation.reconfigure(
          readOnlyExtensions(editorLabel, locale),
        ),
      ],
      locale,
    )
  }, [key, preview, selectedLanguage, limit, editorLabel, locale])

  const highlightStart = highlightRange?.start
  const highlightEnd = highlightRange?.end
  useEffect(() => {
    const current = engine.current
    if (!current) return
    const marks = []
    if (
      highlightStart !== undefined &&
      highlightEnd !== undefined &&
      highlightStart >= 1 &&
      highlightStart <= current.view.state.doc.lines
    ) {
      const end = Math.min(
        current.view.state.doc.lines,
        Math.max(highlightStart, highlightEnd),
      )
      for (let number = highlightStart; number <= end; number++)
        marks.push(
          Decoration.line({ class: styles.referenceLine }).range(
            current.view.state.doc.line(number).from,
          ),
        )
      current.view.dispatch({
        effects: [
          current.highlight.reconfigure(
            EditorView.decorations.of(Decoration.set(marks)),
          ),
          EditorView.scrollIntoView(
            current.view.state.doc.line(highlightStart).from,
            { y: "center" },
          ),
        ],
      })
    } else current.view.dispatch({ effects: current.highlight.reconfigure([]) })
  }, [key, preview, highlightStart, highlightEnd, limit])

  return (
    <section
      className={`${styles.preview} ${className ?? ""}`}
      data-resource-identity={identity}
      data-resource-revision={revision}
    >
      <div className={styles.toolbar}>
        <span className={styles.path} title={path}>
          {path ?? label("只读", "Read-only")}
        </span>
        <label htmlFor={languageId} className={styles.srOnly}>
          {label("源码语言", "Source language")}
        </label>
        <select
          id={languageId}
          value={selectedLanguage}
          onChange={(event) =>
            setLanguageOverrides((previous) => ({
              ...previous,
              [key]: event.target.value as ResourceLanguage,
            }))
          }
        >
          {Object.entries(languageNames).map(([value, name]) => (
            <option key={value} value={value}>
              {value === "text" ? label("纯文本", name) : name}
            </option>
          ))}
        </select>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label("在源码中查找", "Find in source")}
          onClick={() => {
            if (engine.current) openSearchPanel(engine.current.view)
          }}
        >
          <Search aria-hidden="true" />
        </Button>
      </div>
      <div
        ref={host}
        className={styles.editor}
        style={
          {
            "--resource-editor-height":
              typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight,
          } as CSSProperties
        }
      />
      {code.length > preview.length && (
        <p role="status" className={styles.notice}>
          {label(
            `预览仅显示 ${preview.length.toLocaleString()} / ${code.length.toLocaleString()} 个字符；完整输入仍保留，这不是完整文件。`,
            `Preview limited to ${preview.length.toLocaleString()} of ${code.length.toLocaleString()} characters. The supplied source is retained; this is not the complete file.`,
          )}
        </p>
      )}
    </section>
  )
}

export function CodePreview(props: ReadOnlyEditorProps) {
  return <ReadOnlyEditor {...props} />
}

export function FileViewer({
  file,
  revision = "local-snapshot",
  identity,
  maxHeight,
}: {
  file: WorkbenchFile
  revision?: string
  identity?: string
  maxHeight?: number | string
}) {
  const { locale } = useConversationLocale()
  return file.content === undefined ? (
    <p role="status" className={styles.notice}>
      {locale === "zh-CN"
        ? `源码不可用：${file.path}`
        : `Source unavailable for ${file.path}.`}
    </p>
  ) : (
    <ReadOnlyEditor
      identity={identity ?? file.fileId}
      revision={revision}
      code={file.content}
      path={file.path}
      language={file.language ?? inferResourceLanguage(file.path)}
      maxHeight={maxHeight}
    />
  )
}

export interface DiffViewerProps {
  file: ChangedFile
  mode?: "split" | "unified"
  revision?: string
  identity?: string
  baseLabel?: string
  headLabel?: string
  maxHeight?: number | string
}
interface DiffEngine {
  merge?: MergeView
  views: EditorView[]
  languages: Compartment[]
  presentations: Compartment[]
}

export function DiffViewer({
  file,
  mode = "unified",
  revision = "local-snapshot",
  identity = file.fileId,
  baseLabel,
  headLabel,
  maxHeight = 620,
}: DiffViewerProps) {
  const { locale } = useConversationLocale()
  const label = (zh: string, en: string) => (locale === "zh-CN" ? zh : en)
  const displayBase = baseLabel ?? label("原版本", "Base")
  const displayHead = headLabel ?? label("新版本", "Head")
  const host = useRef<HTMLDivElement>(null)
  const engine = useRef<DiffEngine | null>(null)
  const positions = useRef(new Map<string, EditorPosition[]>())
  const documents = useMemo(() => resolveDiffDocuments(file), [file])
  const [languageOverrides, setLanguageOverrides] = useState<
    Record<string, ResourceLanguage>
  >({})
  const key = JSON.stringify([identity, revision, mode])
  const languageKey = JSON.stringify([identity, revision])
  const language =
    languageOverrides[languageKey] ??
    file.language ??
    inferResourceLanguage(file.path)
  const languageId = useId()
  const bounded =
    documents.base.length <= PREVIEW_LIMIT &&
    documents.head.length <= PREVIEW_LIMIT

  const available = documents.complete && bounded
  const initialize = useEffectEvent((parent: HTMLDivElement) => {
    const savedPositions = positions.current
    const saved = savedPositions.get(key)
    const languages = [new Compartment(), new Compartment()]
    const presentations = [new Compartment(), new Compartment()]
    const configs = [documents.base, documents.head].map((doc, index) => ({
      doc,
      selection:
        saved?.[index] && saved[index].state.doc.toString() === doc
          ? saved[index].state.selection
          : undefined,
      extensions: [
        presentations[index].of(
          readOnlyExtensions(
            `${file.path}: ${index ? displayHead : displayBase}`,
            locale,
          ),
        ),
        languages[index].of(languageExtension(language)),
      ],
    }))
    let merge: MergeView | undefined
    let views: EditorView[]
    if (mode === "split") {
      merge = new MergeView({
        a: configs[0],
        b: configs[1],
        parent,
        highlightChanges: true,
        gutter: true,
        diffConfig: { scanLimit: 2000 },
      })
      views = [merge.a, merge.b]
    } else {
      const config = configs[1]
      const view = new EditorView({
        parent,
        state: EditorState.create({
          ...config,
          selection:
            saved?.[0] && saved[0].state.doc.toString() === config.doc
              ? saved[0].state.selection
              : undefined,
          extensions: [
            ...config.extensions,
            unifiedMergeView({
              original: documents.base,
              mergeControls: false,
              highlightChanges: true,
              gutter: true,
              diffConfig: { scanLimit: 2000 },
            }),
          ],
        }),
      })
      views = [view]
    }
    views.forEach((view, index) => restoreReaderPosition(view, saved?.[index]))
    const current = {
      merge,
      views,
      languages: mode === "split" ? languages : [languages[1]],
      presentations: mode === "split" ? presentations : [presentations[1]],
    }
    engine.current = current
    const observer = new ResizeObserver(() =>
      views.forEach((view) => view.requestMeasure()),
    )
    observer.observe(parent)
    return () => {
      savedPositions.set(
        key,
        views.map((view) => ({
          state: view.state,
          top: view.scrollDOM.scrollTop,
          left: view.scrollDOM.scrollLeft,
        })),
      )
      observer.disconnect()
      if (merge) merge.destroy()
      else views.forEach((view) => view.destroy())
      if (engine.current === current) engine.current = null
    }
  })

  useEffect(() => {
    const parent = host.current
    if (parent && available) return initialize(parent)
  }, [key, available])

  useEffect(() => {
    const current = engine.current
    if (!current) return
    current.views.forEach((view, index) => {
      const effects: StateEffect<unknown>[] = []
      if (mode === "unified") {
        const original = getOriginalDoc(view.state)
        if (original.toString() !== documents.base)
          effects.push(
            originalDocChangeEffect(
              view.state,
              EditorChanges.of(
                { from: 0, to: original.length, insert: documents.base },
                original.length,
              ),
            ),
          )
      }
      updateReaderDocument(
        view,
        mode === "split" && index === 0 ? documents.base : documents.head,
        effects,
      )
      reconfigureReader(
        view,
        [
          current.languages[index].reconfigure(languageExtension(language)),
          current.presentations[index].reconfigure(
            readOnlyExtensions(
              `${file.path}: ${mode === "split" && index === 0 ? displayBase : displayHead}`,
              locale,
            ),
          ),
        ],
        locale,
      )
    })
  }, [
    key,
    available,
    language,
    documents.base,
    documents.head,
    file.path,
    displayBase,
    displayHead,
    locale,
    mode,
  ])

  if (!documents.complete) {
    const patch =
      file.patch ??
      file.lines
        .map(
          (line) =>
            `${String(line.oldLine ?? "").padStart(5)} ${String(line.newLine ?? "").padStart(5)} ${line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}${line.text}`,
        )
        .join("\n")
    return (
      <section>
        <p className={styles.notice}>
          {label(
            "局部补丁：未提供完整原版本/新版本快照。",
            "Partial patch · complete base/head snapshots were not supplied.",
          )}{" "}
          {file.patch
            ? label("仅显示提供的补丁。", "Showing the supplied patch only.")
            : label(
                "列：原版本行号 / 新版本行号 / 提供的变更。",
                "Columns: original base line / original head line / supplied change.",
              )}
        </p>
        {patch ? (
          <CodePreview
            identity={`${identity}:patch`}
            revision={revision}
            code={patch}
            path={file.path}
            language="text"
            maxHeight={maxHeight}
          />
        ) : (
          <p className={styles.notice}>
            {label("未提供补丁内容。", "No patch content supplied.")}
          </p>
        )}
      </section>
    )
  }
  if (!bounded)
    return (
      <section>
        <p role="status" className={styles.notice}>
          {label(
            `Diff 超过 ${PREVIEW_LIMIT.toLocaleString()} 字符预览边界。下方仅为有界源码预览，不是完整比较。`,
            `Diff exceeds the ${PREVIEW_LIMIT.toLocaleString()}-character preview boundary. Showing bounded source previews, not a complete comparison.`,
          )}
        </p>
        <CodePreview
          identity={`${identity}:base`}
          revision={revision}
          code={documents.base}
          path={file.previousPath ?? file.path}
          maxHeight={maxHeight}
        />
        <CodePreview
          identity={`${identity}:head`}
          revision={revision}
          code={documents.head}
          path={file.path}
          maxHeight={maxHeight}
        />
      </section>
    )
  return (
    <section
      className={styles.diff}
      data-diff-mode={mode}
      data-resource-identity={identity}
      data-resource-revision={revision}
    >
      <div className={styles.toolbar}>
        <span className={styles.path} title={file.path}>
          {file.path}
        </span>
        <label htmlFor={languageId} className={styles.srOnly}>
          {label("Diff 语言", "Diff language")}
        </label>
        <select
          id={languageId}
          value={language}
          onChange={(event) =>
            setLanguageOverrides((previous) => ({
              ...previous,
              [languageKey]: event.target.value as ResourceLanguage,
            }))
          }
        >
          {Object.entries(languageNames).map(([value, name]) => (
            <option key={value} value={value}>
              {value === "text" ? label("纯文本", name) : name}
            </option>
          ))}
        </select>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label("在 Diff 中查找", "Find in diff")}
          onClick={() => {
            const view = engine.current?.views.at(-1)
            if (view) openSearchPanel(view)
          }}
        >
          <Search aria-hidden="true" />
        </Button>
      </div>
      <div className={styles.diffLabels}>
        <span>
          {displayBase} ·{" "}
          {file.kind === "added"
            ? label("空（新增文件）", "empty (added file)")
            : (file.previousPath ?? file.path)}
        </span>
        <span>
          {displayHead} ·{" "}
          {file.kind === "deleted"
            ? label("空（删除文件）", "empty (deleted file)")
            : file.path}
        </span>
      </div>
      <div
        ref={host}
        className={styles.merge}
        style={
          {
            "--resource-editor-height":
              typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight,
          } as CSSProperties
        }
      />
      {documents.base === documents.head && (
        <p role="status" className={styles.notice}>
          {label(
            "所提供的两份快照没有差异。",
            "No differences between the supplied snapshots.",
          )}
        </p>
      )}
    </section>
  )
}

export interface ResourceTreeNode {
  id: string
  label: string
  icon?: ReactNode
  children?: readonly ResourceTreeNode[]
  disabled?: boolean
}
interface VisibleTreeNode {
  node: ResourceTreeNode
  parent?: string
  level: number
  position: number
  size: number
}
export interface TreeProps {
  label: string
  nodes: readonly ResourceTreeNode[]
  selectedId?: string
  onSelect?: (node: ResourceTreeNode) => void
  defaultExpandedIds?: readonly string[]
  expandedIds?: readonly string[]
  onExpandedChange?: (ids: string[]) => void
  className?: string
}

interface TreeItemsProps {
  nodes: readonly ResourceTreeNode[]
  byId: ReadonlyMap<string, VisibleTreeNode>
  expanded: ReadonlySet<string>
  selectedId?: string
  tabId?: string
  registerNode: (id: string, element: HTMLLIElement | null) => void
  onFocusNode: (id: string) => void
  onActivate: (node: ResourceTreeNode) => void
  onKey: (event: KeyboardEvent<HTMLLIElement>, item: VisibleTreeNode) => void
}

function TreeItems({
  nodes,
  byId,
  expanded,
  selectedId,
  tabId,
  registerNode,
  onFocusNode,
  onActivate,
  onKey,
}: TreeItemsProps) {
  return nodes.map((node) => {
    const item = byId.get(node.id)!
    const open = expanded.has(node.id)
    return (
      <li
        key={node.id}
        ref={(element) => registerNode(node.id, element)}
        role="treeitem"
        aria-level={item.level}
        aria-posinset={item.position}
        aria-setsize={item.size}
        aria-selected={selectedId === node.id}
        aria-expanded={node.children ? open : undefined}
        aria-disabled={node.disabled || undefined}
        tabIndex={!node.disabled && tabId === node.id ? 0 : -1}
        onFocus={(event) => {
          if (event.target === event.currentTarget) onFocusNode(node.id)
        }}
        onKeyDown={(event) => onKey(event, item)}
      >
        <div
          className={styles.treeRow}
          style={{ paddingLeft: 8 + (item.level - 1) * 16 }}
          onClick={() => onActivate(node)}
        >
          <span className={styles.chevron}>
            {node.children ? (
              open ? (
                <ChevronDown aria-hidden="true" />
              ) : (
                <ChevronRight aria-hidden="true" />
              )
            ) : null}
          </span>
          {node.icon ??
            (node.children ? (
              <Folder aria-hidden="true" />
            ) : (
              <FileCode2 aria-hidden="true" />
            ))}
          <span className={styles.treeLabel} title={node.label}>
            {node.label}
          </span>
        </div>
        {node.children && open && (
          <ul role="group">
            <TreeItems
              nodes={node.children}
              byId={byId}
              expanded={expanded}
              selectedId={selectedId}
              tabId={tabId}
              registerNode={registerNode}
              onFocusNode={onFocusNode}
              onActivate={onActivate}
              onKey={onKey}
            />
          </ul>
        )}
      </li>
    )
  })
}

export function Tree({
  label,
  nodes,
  selectedId,
  onSelect,
  defaultExpandedIds = [],
  expandedIds,
  onExpandedChange,
  className,
}: TreeProps) {
  const [localExpanded, setLocalExpanded] =
    useState<readonly string[]>(defaultExpandedIds)
  const expanded = useMemo(
    () => new Set(expandedIds ?? localExpanded),
    [expandedIds, localExpanded],
  )
  const [focusedId, setFocusedId] = useState<string | undefined>(selectedId)
  const root = useRef<HTMLUListElement>(null)
  const refs = useRef(new Map<string, HTMLLIElement>())
  const focusWithin = useRef(false)
  const typeahead = useRef({ text: "", time: 0 })
  const { visible, byId, parents } = useMemo(() => {
    const visible: VisibleTreeNode[] = []
    const byId = new Map<string, VisibleTreeNode>()
    const parents = new Map<string, string>()
    function collect(
      items: readonly ResourceTreeNode[],
      level = 1,
      parent?: string,
      shown = true,
    ) {
      items.forEach((node, index) => {
        const item = {
          node,
          level,
          parent,
          position: index + 1,
          size: items.length,
        }
        if (parent) parents.set(node.id, parent)
        if (shown) {
          visible.push(item)
          byId.set(node.id, item)
        }
        if (node.children)
          collect(
            node.children,
            level + 1,
            node.id,
            shown && expanded.has(node.id),
          )
      })
    }
    collect(nodes)
    return { visible, byId, parents }
  }, [nodes, expanded])
  let candidate = focusedId
  while (
    candidate &&
    (!byId.has(candidate) || byId.get(candidate)?.node.disabled)
  )
    candidate = parents.get(candidate)
  const tabId =
    candidate ??
    visible.find((item) => item.node.id === selectedId && !item.node.disabled)
      ?.node.id ??
    visible.find((item) => !item.node.disabled)?.node.id
  useEffect(() => {
    if (focusedId === tabId || !tabId || !focusWithin.current) return
    const tree = root.current
    const active = tree?.ownerDocument.activeElement
    if (
      tree &&
      (active === tree.ownerDocument.body || (active && tree.contains(active)))
    )
      refs.current.get(tabId)?.focus()
  }, [focusedId, tabId])
  const registerNode = useCallback(
    (id: string, element: HTMLLIElement | null) => {
      if (element) refs.current.set(id, element)
      else refs.current.delete(id)
    },
    [],
  )
  const focus = (id: string | undefined) => {
    if (id && !byId.get(id)?.node.disabled) refs.current.get(id)?.focus()
  }
  const toggle = (id: string) => {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    const ids = [...next]
    if (expandedIds === undefined) setLocalExpanded(ids)
    onExpandedChange?.(ids)
  }
  const activate = (node: ResourceTreeNode) => {
    if (!node.disabled) {
      focus(node.id)
      if (node.children) toggle(node.id)
      else onSelect?.(node)
    }
  }
  const handleKey = (
    event: KeyboardEvent<HTMLLIElement>,
    item: VisibleTreeNode,
  ) => {
    if (event.target !== event.currentTarget || item.node.disabled) return
    const navigable = visible.filter((entry) => !entry.node.disabled)
    const index = navigable.findIndex((entry) => entry.node.id === item.node.id)
    let handled = true
    switch (event.key) {
      case "ArrowDown":
        focus(navigable[Math.min(index + 1, navigable.length - 1)]?.node.id)
        break
      case "ArrowUp":
        focus(navigable[Math.max(0, index - 1)]?.node.id)
        break
      case "Home":
        focus(navigable[0]?.node.id)
        break
      case "End":
        focus(navigable.at(-1)?.node.id)
        break
      case "ArrowRight":
        if (item.node.children?.length) {
          if (!expanded.has(item.node.id)) toggle(item.node.id)
          else focus(item.node.children.find((node) => !node.disabled)?.id)
        }
        break
      case "ArrowLeft":
        if (item.node.children && expanded.has(item.node.id))
          toggle(item.node.id)
        else focus(item.parent)
        break
      case "Enter":
      case " ":
        activate(item.node)
        break
      default:
        handled = false
    }
    if (handled) event.preventDefault()
    else if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      const now = Date.now()
      const text =
        (now - typeahead.current.time < 700 ? typeahead.current.text : "") +
        event.key.toLowerCase()
      typeahead.current = { text, time: now }
      const ordered = [
        ...navigable.slice(index + 1),
        ...navigable.slice(0, index + 1),
      ]
      focus(
        ordered.find((entry) => entry.node.label.toLowerCase().startsWith(text))
          ?.node.id,
      )
      event.preventDefault()
    }
  }
  return (
    <ul
      ref={root}
      role="tree"
      aria-label={label}
      className={`${styles.tree} ${className ?? ""}`}
      onFocus={() => {
        focusWithin.current = true
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          focusWithin.current = false
      }}
    >
      <TreeItems
        nodes={nodes}
        byId={byId}
        expanded={expanded}
        selectedId={selectedId}
        tabId={tabId}
        registerNode={registerNode}
        onFocusNode={setFocusedId}
        onActivate={activate}
        onKey={handleKey}
      />
    </ul>
  )
}

export interface ChangeReviewPanelProps {
  scopeId: string
  changes: ChangeSet
  selectedFileId: string
  onSelectFile: (id: string) => void
  comments: ReviewComment[]
  onCommentsChange: (comments: ReviewComment[]) => void
  onFeedback?: (text: string) => void
}

export function ChangeReviewPanel({
  scopeId,
  changes,
  selectedFileId,
  onSelectFile,
  comments,
  onCommentsChange,
  onFeedback,
}: ChangeReviewPanelProps) {
  const { locale } = useConversationLocale()
  const label = (zh: string, en: string) => (locale === "zh-CN" ? zh : en)
  const file = changes.files.find(
    (candidate) => candidate.fileId === selectedFileId,
  )
  const [mode, setMode] = useState("split")
  const [drafts, setDrafts] = useState<
    Record<string, { text: string; side: ReviewComment["side"]; line: string }>
  >({})
  const [notice, setNotice] = useState<"" | "saved" | "feedback">("")
  const draftKey = JSON.stringify([scopeId, changes.revision, selectedFileId])
  const draft = drafts[draftKey] ?? { text: "", side: "file", line: "" }
  const id = useId()
  const scopedComments = comments.filter(
    (comment) =>
      comment.scopeId === scopeId && comment.revision === changes.revision,
  )
  const fileComments = scopedComments.filter(
    (comment) => comment.fileId === selectedFileId,
  )
  const documents = file ? resolveDiffDocuments(file) : undefined
  const lineNumber = Number(draft.line)
  const sideText = draft.side === "base" ? documents?.base : documents?.head
  const validLine =
    draft.side === "file" ||
    (!!documents?.complete &&
      Number.isInteger(lineNumber) &&
      lineNumber >= 1 &&
      lineNumber <= (sideText ?? "").split("\n").length &&
      sideText !== "")
  const kindLabels: Record<ChangedFile["kind"], string> = {
    added: label("新增", "added"),
    modified: label("修改", "modified"),
    deleted: label("删除", "deleted"),
    renamed: label("重命名", "renamed"),
  }
  return (
    <section
      className={styles.review}
      aria-label={label("本地变更审阅", "Local change review")}
      data-review-scope={scopeId}
    >
      <header className={styles.reviewHeader}>
        <strong>
          {changes.files.length} {label("个变更文件", "changed files")}
        </strong>
        <span>{changes.scope}</span>
        <span className={styles.path}>
          {changes.base} → {changes.head} · {changes.revision}
        </span>
      </header>
      <div className={styles.reviewGrid}>
        <aside className={styles.reviewFiles}>
          <Tree
            label={label("变更文件", "Changed files")}
            nodes={changes.files.map((candidate) => ({
              id: candidate.fileId,
              label: candidate.path,
              icon: <FileCode2 aria-hidden="true" />,
            }))}
            selectedId={selectedFileId}
            onSelect={(node) => onSelectFile(node.id)}
          />
          <ul className={styles.fileStats}>
            {changes.files.map((candidate) => (
              <li key={candidate.fileId}>
                <span>
                  {candidate.path.split("/").at(-1)} ·{" "}
                  {kindLabels[candidate.kind]}
                </span>
                <span className={styles.additions}>
                  +
                  {candidate.lines.filter((line) => line.kind === "add").length}
                </span>
                <span className={styles.deletions}>
                  −
                  {
                    candidate.lines.filter((line) => line.kind === "remove")
                      .length
                  }
                </span>
              </li>
            ))}
          </ul>
          <p className={styles.notice}>
            {label(
              "计数对应提供的补丁行，不是 Git 操作结果。",
              "Counts describe supplied patch lines, not a Git operation.",
            )}
          </p>
        </aside>
        <main className={styles.reviewBody}>
          {file ? (
            <>
              <Tabs value={mode} onValueChange={setMode}>
                <TabsList aria-label={label("Diff 布局", "Diff layout")}>
                  <TabsTrigger value="split">
                    {label("并排", "Side by side")}
                  </TabsTrigger>
                  <TabsTrigger value="unified">
                    {label("统一", "Unified")}
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="split" forceMount>
                  <DiffViewer
                    file={file}
                    mode="split"
                    revision={changes.revision}
                    identity={JSON.stringify([scopeId, file.fileId])}
                    baseLabel={changes.base}
                    headLabel={changes.head}
                  />
                </TabsContent>
                <TabsContent value="unified" forceMount>
                  <DiffViewer
                    file={file}
                    mode="unified"
                    revision={changes.revision}
                    identity={JSON.stringify([scopeId, file.fileId])}
                    baseLabel={changes.base}
                    headLabel={changes.head}
                  />
                </TabsContent>
              </Tabs>
              <section
                className={styles.comments}
                aria-label={label("审阅意见", "Review comments")}
              >
                <h3>
                  {label("意见", "Comments")} · {fileComments.length}
                </h3>
                {fileComments.map((comment) => (
                  <article key={comment.id} className={styles.comment}>
                    <header>
                      <span>
                        {comment.side === "file"
                          ? file.path
                          : (comment.side === "base"
                              ? label("原版本", "Base")
                              : label("新版本", "Head")) +
                            ":" +
                            comment.line}{" "}
                        ·{" "}
                        {comment.resolved
                          ? label("已解决", "Resolved")
                          : label("待处理", "Open")}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          onCommentsChange(
                            comments.map((candidate) =>
                              candidate.id === comment.id
                                ? {
                                    ...candidate,
                                    resolved: !candidate.resolved,
                                  }
                                : candidate,
                            ),
                          )
                        }
                      >
                        {comment.resolved
                          ? label("重新打开", "Reopen")
                          : label("解决", "Resolve")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={label(
                          "删除审阅意见",
                          "Delete review comment",
                        )}
                        onClick={() =>
                          onCommentsChange(
                            comments.filter(
                              (candidate) => candidate.id !== comment.id,
                            ),
                          )
                        }
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </header>
                    <p>{comment.text}</p>
                  </article>
                ))}
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (!draft.text.trim() || !validLine) return
                    const comment: ReviewComment = {
                      id: scopeId + ":" + crypto.randomUUID(),
                      scopeId,
                      fileId: file.fileId,
                      revision: changes.revision,
                      side: draft.side,
                      line: draft.side === "file" ? undefined : lineNumber,
                      text: draft.text.trim(),
                      resolved: false,
                    }
                    onCommentsChange([...comments, comment])
                    setDrafts((previous) => ({
                      ...previous,
                      [draftKey]: { ...draft, text: "" },
                    }))
                    setNotice("saved")
                  }}
                >
                  <label htmlFor={id + "-comment"}>
                    {label("添加审阅意见", "Add review comment")}
                  </label>
                  <Textarea
                    id={id + "-comment"}
                    value={draft.text}
                    onChange={(event) =>
                      setDrafts((previous) => ({
                        ...previous,
                        [draftKey]: { ...draft, text: event.target.value },
                      }))
                    }
                    placeholder={label(
                      "描述需要修改的内容…",
                      "Describe the requested change…",
                    )}
                  />
                  <div className={styles.commentActions}>
                    <label htmlFor={id + "-side"}>
                      {label("位置", "Location")}
                    </label>
                    <select
                      id={id + "-side"}
                      value={draft.side}
                      onChange={(event) =>
                        setDrafts((previous) => ({
                          ...previous,
                          [draftKey]: {
                            ...draft,
                            side: event.target.value as ReviewComment["side"],
                          },
                        }))
                      }
                    >
                      <option value="file">
                        {label("整个文件", "Whole file")}
                      </option>
                      <option value="base" disabled={!documents?.complete}>
                        {label("原版本行", "Base line")}
                      </option>
                      <option value="head" disabled={!documents?.complete}>
                        {label("新版本行", "Head line")}
                      </option>
                    </select>
                    {draft.side !== "file" && (
                      <>
                        <label htmlFor={id + "-line"}>
                          {label("行号", "Line")}
                        </label>
                        <Input
                          id={id + "-line"}
                          type="number"
                          min={1}
                          value={draft.line}
                          aria-invalid={!validLine}
                          onChange={(event) =>
                            setDrafts((previous) => ({
                              ...previous,
                              [draftKey]: {
                                ...draft,
                                line: event.target.value,
                              },
                            }))
                          }
                        />
                      </>
                    )}
                    <Button
                      type="submit"
                      disabled={!draft.text.trim() || !validLine}
                    >
                      {label("添加意见", "Add comment")}
                    </Button>
                  </div>
                  {!validLine && (
                    <p role="alert" className={styles.notice}>
                      {label(
                        "请选择所提供版本内的有效行号。",
                        "Choose a line within the supplied snapshot.",
                      )}
                    </p>
                  )}
                </form>
              </section>
            </>
          ) : (
            <p className={styles.notice}>
              {label(
                "选择变更文件开始审阅。",
                "Select a changed file to review.",
              )}
            </p>
          )}
          {onFeedback && (
            <Button
              variant="outline"
              disabled={!scopedComments.some((comment) => !comment.resolved)}
              onClick={() => {
                const feedback = scopedComments
                  .filter((comment) => !comment.resolved)
                  .map(
                    (comment) =>
                      (changes.files.find(
                        (candidate) => candidate.fileId === comment.fileId,
                      )?.path ?? comment.fileId) +
                      (comment.line
                        ? " (" + comment.side + ":" + comment.line + ")"
                        : "") +
                      ": " +
                      comment.text,
                  )
                  .join("\n\n")
                onFeedback(feedback)
                setNotice("feedback")
              }}
            >
              {label(
                "把待处理意见加入对话草稿",
                "Add open comments to conversation draft",
              )}
            </Button>
          )}
          <p role="status" className={styles.notice}>
            {notice === "saved"
              ? label(
                  "意见已保存到本地审阅；没有写入文件。",
                  "Comment saved to this local review; no file writes.",
                )
              : notice === "feedback"
                ? label(
                    "待处理意见已加入本地对话草稿；尚未提交。",
                    "Open review comments added to the local conversation draft; not submitted.",
                  )
                : label(
                    "仅本地审阅；不会修改仓库文件或提交。",
                    "Review is local only; no repository files or commits are changed.",
                  )}
          </p>
        </main>
      </div>
    </section>
  )
}
