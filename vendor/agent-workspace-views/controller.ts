import type { Dispatch, RefObject, SetStateAction } from "react"
import type { Locale } from "./model"
import type {
  ComposerSession,
  ComposerSource,
  ContextItem,
  Copy,
  Draft,
} from "./model"

export type ComposerDialog =
  | "search"
  | "settings"
  | "rename"
  | "clear"
  | "notifications"
  | null

/** UI-owned state and semantic actions shared by demo and product adapters.
 * DOM refs, folding, editor selection and reading position never become service DTOs.
 * Mutations are requests to the adapter, not permission to rewrite its collections.
 */
export interface ComposerController {
  active: boolean
  locale: Locale
  setLocale: (locale: Locale) => void
  copy: (value: string | Copy) => string
  label: (zh: string, en: string) => string
  globalCollapsed: boolean
  setGlobalCollapsed: Dispatch<SetStateAction<boolean>>
  sessionsVisible: boolean
  setSessionsVisible: Dispatch<SetStateAction<boolean>>
  sessions: ComposerSession[]
  selectedId: string
  projectId: string
  drafts: Record<string, Draft>
  dialog: ComposerDialog
  setDialog: Dispatch<SetStateAction<ComposerDialog>>
  query: string
  setQuery: Dispatch<SetStateAction<string>>
  renameValue: string
  setRenameValue: Dispatch<SetStateAction<string>>
  suggestionsVisible: boolean
  setSuggestionsVisible: Dispatch<SetStateAction<boolean>>
  feedback: string
  textarea: RefObject<HTMLTextAreaElement | null>
  history: RefObject<HTMLDivElement | null>
  selected: ComposerSession
  draft: Draft
  hasMessages: boolean
  chats: ComposerSession[]
  searchResults: ComposerSession[]
  activeContexts: ContextItem[]
  sessionTitle: (session: ComposerSession) => string
  selectSession: (session: ComposerSession) => void
  newSession: (projectId?: string) => void
  selectProject: (projectId: string) => void
  renameSession: (sessionId: string, title: string) => void
  /** Omit when the adapter cannot clear history; the View keeps the action disabled. */
  clearSession?: (sessionId: string) => void
  sendMessage: () => void
  updateDraft: (update: Partial<Draft>) => void
  toggleContext: (contextId: string) => void
  removeContext: (contextId: string) => void
  focusComposer: () => void
  rememberPosition: () => void
  scrollToLatest: () => void
  exportConversation: () => void
  openSettings: () => void
  projects: ComposerSource["projects"]
  contextItems: ContextItem[]
  models: string[]
  suggestions: Copy[]
  runtime: ComposerSource["runtime"]
  canSend: boolean
  capabilities?: ComposerSource["capabilities"]
  execution?: ComposerSource["execution"]
  /** Only the local demo adapter sets this; product messages are never labelled examples. */
  messageMode?: "demo"
}
