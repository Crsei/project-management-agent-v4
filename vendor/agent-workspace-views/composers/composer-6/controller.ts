"use client"

import { useEffect, useLayoutEffect, useRef, useState, type SetStateAction } from "react"
import { useComposerDemoController } from "../../demo-controller"
import { newTitle, type ComposerSession, type Copy, type Draft } from "../../model"
import { useRemainingPageState } from "../../showcase/state"
import { createComposer6Source, emptyDraft, suggestionItems } from "./fixtures"
import { createComposer6State, transitionComposer6, type Composer6Action } from "./model"
export function useComposer6Controller(scenario: string, active: boolean) {
  const [state, setState] = useRemainingPageState(`composer-6:${scenario}`, () => createComposer6State(scenario))
  const [source] = useState(() => createComposer6Source(scenario))
  const base = useComposerDemoController(source, active, false)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const history = useRef<HTMLDivElement>(null)
  const [positionMap] = useState(() => new Map(Object.entries(state.reading)))
  const [selectionMap] = useState(() => new Map(Object.entries(state.selections)))
  const positions = useRef(positionMap)
  const selections = useRef(selectionMap)
  const selected = state.sessions.find(session => session.id === state.selectedId)!
  const draft = state.drafts[state.selectedId] ?? emptyDraft()
  const canSend = scenario !== "readonly" && state.dataState !== "loading"
  const dispatch = (action: Composer6Action) => setState(previous => transitionComposer6(previous, action))
  function rememberPosition() {
    if (history.current) positions.current.set(state.selectedId, history.current.scrollTop)
    if (textarea.current) selections.current.set(state.selectedId, { start: textarea.current.selectionStart, end: textarea.current.selectionEnd })
    setState(previous => {
      const scroll = positions.current.get(state.selectedId)
      const selection = selections.current.get(state.selectedId)
      const priorSelection = previous.selections[state.selectedId]
      if (previous.reading[state.selectedId] === scroll && priorSelection?.start === selection?.start && priorSelection?.end === selection?.end) return previous
      return { ...previous, reading: Object.fromEntries(positions.current), selections: Object.fromEntries(selections.current) }
    })
  }
  function selectSession(session: ComposerSession) {
    rememberPosition()
    dispatch({ type: "select", id: session.id })
  }
  function newSession() {
    rememberPosition()
    dispatch({ type: "new" })
    requestAnimationFrame(() => textarea.current?.focus())
  }
  function closeTab(id: string) {
    rememberPosition()
    dispatch({ type: "close", id })
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[data-page="composer-6"] [data-composer6-tab][data-active]')?.focus())
  }
  function sendMessage(text?: string | Copy) {
    if (!canSend || (!text && !draft.text.trim())) return
    dispatch({ type: "send", text, canSend })
    requestAnimationFrame(() => {
      if (history.current) history.current.scrollTop = history.current.scrollHeight
      textarea.current?.focus()
    })
  }
  useLayoutEffect(() => {
    if (!active) return
    if (history.current) history.current.scrollTop = positions.current.get(state.selectedId) ?? history.current.scrollHeight
    const selection = selections.current.get(state.selectedId)
    if (!selection) return
    const frame = requestAnimationFrame(() => textarea.current?.setSelectionRange(selection.start, selection.end))
    return () => cancelAnimationFrame(frame)
  }, [active, state.selectedId, history, textarea, positions, selections])
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k" || (event.target instanceof HTMLElement && event.target.closest('[role="dialog"]'))) return
      event.preventDefault()
      setState(previous => ({ ...previous, searchOpen: true, sidebarVisible: true }))
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-composer6-search]')?.focus())
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [active, setState])
  const chats = state.sessions.filter(session => session.messages.length || state.drafts[session.id]?.text.trim() || (state.drafts[session.id]?.model !== undefined && state.drafts[session.id]?.model !== source.models[0]))
  const offset = state.suggestionOffsets[state.selectedId] ?? 0
  return {
    ...base, state, setState, dispatch, canSend, sessions: state.sessions, textarea, history,
    focusComposer: () => requestAnimationFrame(() => textarea.current?.focus({ preventScroll: true })),
    drafts: state.drafts, selectedId: state.selectedId, selected, draft,
    hasMessages: selected.messages.length > 0, chats,
    searchResults: chats.filter(session => base.copy(session.title).toLocaleLowerCase().includes(state.query.toLocaleLowerCase())),
    renameSession: (id: string, title: string) => {
      if (!title.trim()) return
      setState(previous => ({ ...previous, sessions: previous.sessions.map(session => session.id === id ? { ...session, title: title.trim() } : session) }))
    },
    clearSession: (id: string) => {
      positions.current.delete(id)
      setState(previous => ({ ...previous, sessions: previous.sessions.map(session => session.id === id ? { ...session, title: newTitle, messages: [] } : session), reading: Object.fromEntries(positions.current) }))
    },
    scrollToLatest: () => {
      if (history.current) history.current.scrollTop = history.current.scrollHeight
      rememberPosition()
    },
    query: state.query, setQuery: (action: SetStateAction<string>) => setState(previous => ({ ...previous, query: typeof action === "function" ? action(previous.query) : action })),
    sessionsVisible: state.sidebarVisible, setSessionsVisible: (action: SetStateAction<boolean>) => setState(previous => ({ ...previous, sidebarVisible: typeof action === "function" ? action(previous.sidebarVisible) : action })),
    updateDraft: (patch: Partial<Draft>) => dispatch({ type: "draft", patch }),
    newSession, selectSession, closeTab, sendMessage, rememberPosition,
    startingPoints: Array.from({ length: 4 }, (_, index) => suggestionItems[(offset + index) % suggestionItems.length]),
    positions,
  }
}
