"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Compartment, EditorState, StateEffect, StateField } from "@codemirror/state"
import { EditorView, Decoration, keymap, lineNumbers } from "@codemirror/view"
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { tags } from "@lezer/highlight"
import { javascript } from "@codemirror/lang-javascript"
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  openSearchPanel,
  search,
  setSearchQuery,
} from "@codemirror/search"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { DataRegion, type RegionError } from "../ui/data-region"
import type { DataState } from "../../lib/runtime-status"
import { redactText } from "../../lib/redact"
import { useI18n } from "../../lib/i18n-provider"
import { ArrowDown, ArrowUp, X } from "lucide-react"
import styles from "./code-preview.module.css"

const SOURCE_LIMIT = 1024 * 1024
const DEFAULT_LINES = 1000
const DEFAULT_LINE_LENGTH = 8192

export type CodePreviewProps = {
  /** Stable caller-owned object identity. A different identity starts at the top. */
  identity: string
  revision?: string
  code: string
  path?: string
  language?: "javascript" | "typescript" | "jsx" | "tsx" | "plain"
  ariaLabel?: string
  highlightRange?: { start: number; end: number }
  state?: DataState
  refreshing?: boolean
  updatedAt?: string
  error?: RegionError
  onRetry?: () => void
  maximumLines?: number
  maximumLineLength?: number
  /** Caller knows that its snapshot is incomplete even within this preview's bounds. */
  incomplete?: boolean
}

export function inferCodePreviewLanguage(path: string): CodePreviewProps["language"] {
  if (/\.tsx$/i.test(path)) return "tsx"
  if (/\.jsx$/i.test(path)) return "jsx"
  if (/\.(ts|mts|cts)$/i.test(path)) return "typescript"
  if (/\.(js|mjs|cjs)$/i.test(path)) return "javascript"
  return "plain"
}

/** Bound input before parsing; redact before sending any text to the editor DOM. */
export function prepareCodePreview(
  raw: string,
  maximumLines = DEFAULT_LINES,
  maximumLineLength = DEFAULT_LINE_LENGTH,
) {
  const maxLines = Math.max(1, Math.min(5000, Math.trunc(maximumLines) || DEFAULT_LINES))
  const maxLength = Math.max(1, Math.min(8192, Math.trunc(maximumLineLength) || DEFAULT_LINE_LENGTH))
  const source = raw.slice(0, SOURCE_LIMIT)
  const lines = redactText(source).split("\n")
  let truncated = raw.length > SOURCE_LIMIT || lines.length > maxLines
  const visible = lines.slice(0, maxLines).map((line) => {
    if (line.length > maxLength) truncated = true
    return line.slice(0, maxLength)
  })
  // A cut inside a source line is never represented as a complete final line.
  if (raw.length > SOURCE_LIMIT && !source.endsWith("\n") && visible.length === lines.length) {
    visible.pop()
    if (!visible.length) visible.push("…")
  }
  return { text: visible.join("\n"), truncated }
}

const highlightedRange = StateEffect.define<{ start: number; end: number } | null>()
function visibleRange(
  range: { start: number; end: number } | null | undefined,
  lineCount: number,
) {
  if (
    !range ||
    !Number.isSafeInteger(lineCount) ||
    lineCount < 1 ||
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start > range.end ||
    range.end < 1 ||
    range.start > lineCount
  ) return null
  return {
    start: Math.max(1, range.start),
    end: Math.min(lineCount, range.end),
  }
}

const rangeField = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    if (transaction.docChanged) value = Decoration.none
    for (const effect of transaction.effects) {
      if (!effect.is(highlightedRange)) continue
      const range = visibleRange(effect.value, transaction.state.doc.lines)
      if (!range) return Decoration.none
      const marks: ReturnType<ReturnType<typeof Decoration.line>["range"]>[] = []
      for (let line = range.start; line <= range.end; line++) {
        marks.push(
          Decoration.line({ attributes: { "data-highlighted": "true" } }).range(
            transaction.state.doc.line(line).from,
          ),
        )
      }
      return Decoration.set(marks)
    }
    return value
  },
  provide: (field) => EditorView.decorations.from(field),
})

const codeColors = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--agent)" },
  { tag: [tags.string, tags.regexp], color: "var(--success)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--info)" },
  { tag: tags.comment, color: "var(--text-muted)" },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: "var(--primary)" },
  { tag: tags.invalid, color: "var(--destructive)" },
])

function languageExtension(language: CodePreviewProps["language"]) {
  switch (language) {
    case "javascript": return javascript()
    case "typescript": return javascript({ typescript: true })
    case "jsx": return javascript({ jsx: true })
    case "tsx": return javascript({ typescript: true, jsx: true })
    default: return []
  }
}

export function CodePreview({
  identity,
  revision,
  code,
  path,
  language,
  ariaLabel,
  highlightRange,
  state,
  refreshing,
  updatedAt,
  error,
  onRetry,
  maximumLines,
  maximumLineLength,
  incomplete = false,
}: CodePreviewProps) {
  const { t } = useI18n()
  const prepared = useMemo(
    () => prepareCodePreview(code, maximumLines, maximumLineLength),
    [code, maximumLines, maximumLineLength],
  )
  const hasText = Boolean(prepared.text)
  const dataState = state === "success" && !prepared.text
    ? "empty"
    : state ?? (prepared.text ? "success" : "empty")
  const showEditor = hasText && dataState !== "empty"
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const languageCompartment = useRef(new Compartment())
  const snapshot = useRef({ identity, revision, text: prepared.text })
  const initial = useRef({ identity, revision, text: prepared.text, language, path })
  const queryCurrent = useRef("")
  const queryRef = useRef<HTMLInputElement>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [searchStatus, setSearchStatus] = useState("")

  useEffect(() => {
    initial.current = { identity, revision, text: prepared.text, language, path }
  }, [identity, revision, prepared.text, language, path])

  useEffect(() => {
    if (!host.current || view.current || !showEditor) return
    const source = initial.current
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: source.text,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ tabindex: "0", role: "textbox", "aria-readonly": "true" }),
          EditorView.lineWrapping,
          lineNumbers(),
          rangeField,
          search({
            // Search state drives CodeMirror's viewport highlights. The visible
            // controls are our portable Input/Button toolbar with no replace UI.
            createPanel: () => {
              const dom = document.createElement("div")
              dom.hidden = true
              dom.setAttribute("aria-hidden", "true")
              return { dom }
            },
          }),
          syntaxHighlighting(codeColors),
          languageCompartment.current.of(languageExtension(source.language ?? inferCodePreviewLanguage(source.path ?? ""))),
          keymap.of([
            { key: "Mod-f", run: () => { setSearchOpen(true); return true } },
            { key: "F3", run: (active) => findNext(active) },
            { key: "Shift-F3", run: (active) => findPrevious(active) },
          ]),
        ],
      }),
    })
    view.current = editor
    snapshot.current = { identity: source.identity, revision: source.revision, text: source.text }
    if (queryCurrent.current)
      editor.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: queryCurrent.current, literal: true })) })
    return () => { editor.destroy(); view.current = null }
  }, [showEditor])

  useEffect(() => {
    const editor = view.current
    if (!editor) return
    const previous = snapshot.current
    if (previous.text !== prepared.text || previous.identity !== identity) {
      const sameObject = previous.identity === identity
      const selection = sameObject
        ? {
            anchor: Math.min(editor.state.selection.main.anchor, prepared.text.length),
            head: Math.min(editor.state.selection.main.head, prepared.text.length),
          }
        : { anchor: 0 }
      const top = host.current?.scrollTop ?? 0
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: prepared.text },
        selection,
      })
      if (host.current) host.current.scrollTop = sameObject ? top : 0
      if (!sameObject) {
        setQuery("")
        queryCurrent.current = ""
        editor.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) })
      }
    }
    snapshot.current = { identity, revision, text: prepared.text }
  }, [identity, revision, prepared.text])

  useEffect(() => {
    const editor = view.current
    if (editor) editor.dispatch({ effects: languageCompartment.current.reconfigure(languageExtension(language ?? inferCodePreviewLanguage(path ?? ""))) })
  }, [language, path])

  useEffect(() => {
    const editor = view.current
    if (!editor) return
    editor.contentDOM.setAttribute("aria-label", ariaLabel ?? `${t("codePreview.editor")}${path ? `: ${path}` : ""}`)
  }, [showEditor, ariaLabel, t, path])

  const rangeStart = highlightRange?.start
  const rangeEnd = highlightRange?.end
  useEffect(() => {
    const editor = view.current
    if (!editor) return
    const range = visibleRange(
      rangeStart !== undefined && rangeEnd !== undefined
        ? { start: rangeStart, end: rangeEnd }
        : null,
      editor.state.doc.lines,
    )
    editor.dispatch({ effects: highlightedRange.of(range) })
    if (range) {
      editor.dispatch({ effects: EditorView.scrollIntoView(editor.state.doc.line(range.start).from, { y: "center" }) })
    }
  }, [showEditor, rangeStart, rangeEnd, prepared.text])

  useEffect(() => {
    const editor = view.current
    if (editor) {
      if (searchOpen) {
        openSearchPanel(editor)
        editor.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: queryCurrent.current, literal: true })) })
      } else closeSearchPanel(editor)
    }
    if (searchOpen) queryRef.current?.focus()
  }, [searchOpen, showEditor])

  function updateQuery(value: string) {
    setQuery(value)
    queryCurrent.current = value
    setSearchStatus("")
    view.current?.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: value, literal: true })) })
  }
  function moveMatch(direction: "next" | "previous") {
    const editor = view.current
    if (!editor || !query) return
    const found = direction === "next" ? findNext(editor) : findPrevious(editor)
    setSearchStatus(found ? "" : t("codePreview.noMatches"))
    queryRef.current?.focus()
  }

  return (
    <DataRegion
      state={dataState}
      hasContent={Boolean(prepared.text)}
      refreshing={refreshing}
      updatedAt={updatedAt}
      error={error}
      onRetry={onRetry}
      emptyTitle={t("codePreview.empty")}
      emptyDescription={t("codePreview.empty")}
    >
      {showEditor && (
        <div className={styles.root} data-code-preview data-identity={identity} data-revision={revision} data-preview-lines={prepared.text.split("\n").length}>
          <div className={styles.toolbar}>
            <Button size="sm" variant="ghost" onClick={() => setSearchOpen(true)}>
              {t("codePreview.search")}
            </Button>
            {searchOpen && (
              <div className={styles.search}>
                <Input
                  ref={queryRef}
                  type="search"
                  value={query}
                  aria-label={t("codePreview.search")}
                  onChange={(event) => updateQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") { event.preventDefault(); moveMatch(event.shiftKey ? "previous" : "next") }
                    if (event.key === "Escape") { setSearchOpen(false); view.current?.focus() }
                  }}
                />
                <Button size="icon-sm" variant="ghost" aria-label={t("codePreview.previous")} onClick={() => moveMatch("previous")}><ArrowUp aria-hidden="true" /></Button>
                <Button size="icon-sm" variant="ghost" aria-label={t("codePreview.next")} onClick={() => moveMatch("next")}><ArrowDown aria-hidden="true" /></Button>
                <Button size="icon-sm" variant="ghost" aria-label={t("codePreview.close")} onClick={() => { setSearchOpen(false); view.current?.focus() }}><X aria-hidden="true" /></Button>
              </div>
            )}
          </div>
          <div ref={host} className={styles.editor} />
          {searchStatus && <p role="status" className={styles.notice}>{searchStatus}</p>}
          {(prepared.truncated || incomplete) && <p role="status" className={styles.notice}>{t("workbench.truncated")}</p>}
        </div>
      )}
    </DataRegion>
  )
}
