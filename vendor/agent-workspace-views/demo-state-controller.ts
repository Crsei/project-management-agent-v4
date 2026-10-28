"use client"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { newTitle, type Copy, type Draft, type ComposerSession } from "./model"
import type { ComposerDialog } from "./controller"
import type { ComposerDemoSource } from "./demo-source"

/** Local scenario composition only; mutable stores are not part of the View contract. */
import type { ComposerDemoController } from "./demo-controller"
export interface ComposerLocaleControls {
  locale: "zh-CN" | "en"
  setLocale: (locale: "zh-CN" | "en") => void
}

/** Local-only controller. Product adapters must supply their own controller and authority. */
export function useComposerStateController(
  source: ComposerDemoSource,
  preferences: ComposerLocaleControls,
  active = true,
  shortcutsEnabled = true,
): ComposerDemoController {
  const { locale, setLocale } = preferences
  const { projects, contextItems, models, suggestions } = source
  const emptyDraft: Draft = {
    text: "",
    contextIds: [],
    model: models[0],
    blocks: false,
  }
  const nextId = () => `local-${crypto.randomUUID()}`
  const copy = (value: string | Copy) =>
    typeof value === "string" ? value : value[locale]
  const label = (zh: string, en: string) => (locale === "en" ? en : zh)
  const [globalCollapsed, setGlobalCollapsed] = useState(false)
  const [sessionsVisible, setSessionsVisible] = useState(true)
  const [sessions, setSessions] = useState<ComposerSession[]>(() =>
    structuredClone(source.sessions),
  )
  const [selectedId, setSelectedId] = useState(source.selectedId)
  const [projectId, setProjectId] = useState(source.projectId)
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    structuredClone(source.drafts),
  )
  const [dialog, setDialog] = useState<ComposerDialog>(null)
  const [query, setQuery] = useState("")
  const [renameValue, setRenameValue] = useState("")
  const [suggestionsVisible, setSuggestionsVisible] = useState(true)
  const [feedback, setFeedback] = useState("")
  const textarea = useRef<HTMLTextAreaElement>(null)
  const history = useRef<HTMLDivElement>(null)
  const positions = useRef(
    new Map<string, number>(
      source.initialReadingPosition === "start" ? [[source.selectedId, 0]] : [],
    ),
  )
  const selections = useRef(new Map<string, { start: number; end: number }>())
  const projectSelection = useRef<Record<string, string>>({
    [source.projectId]: source.selectedId,
  })
  const selected = sessions.find((session) => session.id === selectedId)!
  const draft = drafts[selectedId] ?? emptyDraft
  const hasMessages = selected.messages.length > 0
  function sessionTitle(session: ComposerSession) {
    if (!session.messages.length && typeof session.title !== "string")
      return drafts[session.id]?.text.trim().slice(0, 80) || copy(session.title)
    return copy(session.title)
  }
  const chats = sessions.filter(
    (session) =>
      session.projectId === projectId &&
      (session.messages.length > 0 ||
        typeof session.title === "string" ||
        !!drafts[session.id]?.text.trim() ||
        !!drafts[session.id]?.contextIds.length ||
        !!drafts[session.id]?.blocks ||
        (drafts[session.id] && drafts[session.id].model !== models[0])),
  )
  const searchResults = chats.filter((session) =>
    sessionTitle(session)
      .toLocaleLowerCase(locale)
      .includes(query.toLocaleLowerCase(locale)),
  )
  const activeContexts = contextItems.filter((item) =>
    draft.contextIds.includes(item.id),
  )

  useLayoutEffect(() => {
    if (!active) return
    if (history.current)
      history.current.scrollTop =
        positions.current.get(selectedId) ?? history.current.scrollHeight
    const selection = selections.current.get(selectedId)
    if (!selection) return
    // Restore after React has finished restoring the previous DOM selection.
    const frame = requestAnimationFrame(() => {
      textarea.current?.setSelectionRange(selection.start, selection.end)
    })
    return () => cancelAnimationFrame(frame)
  }, [selectedId, active])

  useEffect(() => {
    if (!feedback) return
    const timeout = setTimeout(() => setFeedback(""), 4000)
    return () => clearTimeout(timeout)
  }, [feedback])

  useEffect(() => {
    if (!shortcutsEnabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !active ||
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat
      )
        return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        if (
          event.target instanceof HTMLElement &&
          event.target.closest('[role="dialog"]')
        )
          return
        event.preventDefault()
        setQuery("")
        setDialog("search")
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [active, shortcutsEnabled])

  function updateDraft(update: Partial<Draft>) {
    setDrafts((previous) => ({
      ...previous,
      [selectedId]: { ...(previous[selectedId] ?? emptyDraft), ...update },
    }))
  }
  function rememberPosition() {
    if (history.current && history.current.getClientRects().length)
      positions.current.set(selectedId, history.current.scrollTop)
    if (textarea.current)
      selections.current.set(selectedId, {
        start: textarea.current.selectionStart,
        end: textarea.current.selectionEnd,
      })
  }
  function selectSession(session: ComposerSession) {
    rememberPosition()
    setProjectId(session.projectId)
    setSelectedId(session.id)
    projectSelection.current[session.projectId] = session.id
  }
  function newSession(nextProject = projectId) {
    rememberPosition()
    const id = nextId()
    setSessions((previous) => [
      { id, projectId: nextProject, title: newTitle, messages: [] },
      ...previous,
    ])
    setSelectedId(id)
    setProjectId(nextProject)
    projectSelection.current[nextProject] = id
    requestAnimationFrame(() => textarea.current?.focus())
  }
  function selectProject(id: string) {
    const previous = sessions.find(
      (session) => session.id === projectSelection.current[id],
    )
    if (previous) selectSession(previous)
    else newSession(id)
  }
  function renameSession(sessionId: string, title: string) {
    if (!title.trim()) return
    setSessions((previous) =>
      previous.map((session) =>
        session.id === sessionId
          ? { ...session, title: title.trim() }
          : session,
      ),
    )
  }
  function clearSession(sessionId: string) {
    setSessions((previous) =>
      previous.map((session) =>
        session.id === sessionId
          ? { ...session, title: newTitle, messages: [] }
          : session,
      ),
    )
    positions.current.delete(sessionId)
  }
  function scrollToLatest() {
    if (history.current)
      history.current.scrollTop = history.current.scrollHeight
    rememberPosition()
  }
  function sendMessage() {
    const text = draft.text.trim()
    if (!text || !source.canSend) return
    const contexts = [
      ...activeContexts.map((item) => item.name),
      ...(draft.blocks ? ["EasyuseUI Blocks"] : []),
    ]
    setSessions((previous) =>
      previous.map((session) =>
        session.id === selectedId
          ? {
              ...session,
              title: session.messages.length
                ? session.title
                : text.slice(0, 80),
              messages: [
                ...session.messages,
                { id: nextId(), role: "user", text, contexts },
                {
                  id: nextId(),
                  role: "assistant",
                  text: source.reply,
                },
              ],
            }
          : session,
      ),
    )
    updateDraft({ text: "", contextIds: [] })
    requestAnimationFrame(() => {
      scrollToLatest()
      textarea.current?.focus()
    })
  }
  function toggleContext(id: string) {
    updateDraft({
      contextIds: draft.contextIds.includes(id)
        ? draft.contextIds.filter((value) => value !== id)
        : [...draft.contextIds, id],
    })
  }
  function focusComposer() {
    requestAnimationFrame(() =>
      textarea.current?.focus({ preventScroll: true }),
    )
  }
  function removeContext(id: string) {
    toggleContext(id)
    focusComposer()
  }
  function exportConversation() {
    const content = `# ${copy(selected.title)}\n\n${selected.messages.map((message) => `## ${message.role === "user" ? label("你", "You") : label("示例回复", "Example response")}\n\n${copy(message.text)}${message.contexts?.length ? `\n\n${label("上下文引用", "Context references")}: ${message.contexts.join(", ")}` : ""}`).join("\n\n")}`
    const url = URL.createObjectURL(
      new Blob([content], { type: "text/markdown;charset=utf-8" }),
    )
    const link = document.createElement("a")
    link.href = url
    link.download = "agent-conversation.md"
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setFeedback(label("对话已导出", "Conversation exported"))
  }
  const openSettings = () => setDialog("settings")
  return {
    active,
    locale,
    setLocale,
    copy,
    label,
    globalCollapsed,
    setGlobalCollapsed,
    sessionsVisible,
    setSessionsVisible,
    sessions,
    setSessions,
    selectedId,
    projectId,
    drafts,
    dialog,
    setDialog,
    query,
    setQuery,
    renameValue,
    setRenameValue,
    suggestionsVisible,
    setSuggestionsVisible,
    feedback,
    textarea,
    history,
    positions,
    selected,
    draft,
    hasMessages,
    chats,
    searchResults,
    activeContexts,
    sessionTitle,
    selectSession,
    newSession,
    selectProject,
    renameSession,
    clearSession,
    sendMessage,
    updateDraft,
    toggleContext,
    focusComposer,
    rememberPosition,
    scrollToLatest,
    removeContext,
    exportConversation,
    openSettings,
    projects,
    contextItems,
    models,
    suggestions,
    runtime: source.runtime,
    canSend: source.canSend,
    capabilities: source.capabilities,
    execution: source.execution,
    messageMode: "demo",
  }
}
