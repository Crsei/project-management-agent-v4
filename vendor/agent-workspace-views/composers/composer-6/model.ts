import type { ComposerSession, Copy, Draft } from "../../model"
import { chatTitle, createComposer6Source, emptyDraft, exampleReply, suggestionItems } from "./fixtures.ts"

export type Composer6State = {
  sessions: ComposerSession[]
  drafts: Record<string, Draft>
  selectedId: string
  tabIds: string[]
  nextId: number
  sidebarVisible: boolean
  searchOpen: boolean
  query: string
  suggestionOffsets: Record<string, number>
  reading: Record<string, number>
  selections: Record<string, { start: number; end: number }>
  dataState: "ready" | "loading" | "error"
}
export type Composer6Action =
  | { type: "new" }
  | { type: "select"; id: string }
  | { type: "close"; id: string }
  | { type: "draft"; patch: Partial<Draft> }
  | { type: "send"; text?: string | Copy; canSend: boolean }
  | { type: "shuffle" }
  | { type: "ready" }

export function createComposer6State(scenario: string): Composer6State {
  const source = createComposer6Source(scenario)
  return { sessions: source.sessions, drafts: source.drafts, selectedId: source.selectedId, tabIds: [source.selectedId], nextId: 1, sidebarVisible: true, searchOpen: false, query: "", suggestionOffsets: {}, reading: {}, selections: {}, dataState: scenario === "loading" ? "loading" : scenario === "refresh-error" ? "error" : "ready" }
}
/** Closing a tab never deletes its conversation or draft. */
export function transitionComposer6(state: Composer6State, action: Composer6Action): Composer6State {
  switch (action.type) {
    case "new": {
      const id = `composer-6-local-${state.nextId}`
      return { ...state, nextId: state.nextId + 1, selectedId: id, sessions: [{ id, title: chatTitle, messages: [], projectId: "workspace" }, ...state.sessions], drafts: { ...state.drafts, [id]: emptyDraft() }, tabIds: [...state.tabIds, id] }
    }
    case "select":
      return state.sessions.some(session => session.id === action.id) ? { ...state, selectedId: action.id, tabIds: state.tabIds.includes(action.id) ? state.tabIds : [...state.tabIds, action.id] } : state
    case "close": {
      if (!state.tabIds.includes(action.id)) return state
      const index = state.tabIds.indexOf(action.id)
      const tabIds = state.tabIds.filter(id => id !== action.id)
      if (!tabIds.length) return transitionComposer6({ ...state, tabIds }, { type: "new" })
      return { ...state, tabIds, selectedId: state.selectedId === action.id ? tabIds[Math.min(index, tabIds.length - 1)] : state.selectedId }
    }
    case "draft":
      return { ...state, drafts: { ...state.drafts, [state.selectedId]: { ...(state.drafts[state.selectedId] ?? emptyDraft()), ...action.patch } } }
    case "send": {
      const draft = state.drafts[state.selectedId] ?? emptyDraft()
      const text = action.text ?? draft.text.trim()
      if (!action.canSend || (typeof text === "string" && !text.trim())) return state
      const messageId = `composer-6-message-${state.nextId}`
      return { ...state, nextId: state.nextId + 1, sessions: state.sessions.map(session => session.id !== state.selectedId ? session : { ...session, title: session.messages.length ? session.title : text, messages: [...session.messages, { id: `${messageId}-user`, role: "user", text }, { id: `${messageId}-assistant`, role: "assistant", text: exampleReply }] }), drafts: { ...state.drafts, [state.selectedId]: { ...draft, text: "", contextIds: [] } } }
    }
    case "shuffle":
      return { ...state, suggestionOffsets: { ...state.suggestionOffsets, [state.selectedId]: ((state.suggestionOffsets[state.selectedId] ?? 0) + 4) % suggestionItems.length } }
    case "ready":
      return { ...state, dataState: "ready" }
  }
}
