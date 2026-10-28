import {
  openingMessages,
  previewReply,
  type MobileCopy,
  type MobileMessage,
} from "./fixtures.ts"

export type WorkspaceView = "preview" | "source" | "changes"
export type MobileState = {
  view: WorkspaceView
  dataState: "ready" | "loading" | "empty"
  refreshError: boolean
  readonly: boolean
  model: "Focus" | "Fast"
  menuOpen: boolean
  draft: string
  noteDraft: string
  notes: { id: string; text: string }[]
  messages: MobileMessage[]
  nextId: number
  reading: { conversation: number; mobile: number; changes: number }
  selection: Record<
    string,
    { start: number; end: number; direction: "forward" | "backward" | "none" }
  >
}
export type MobileAction =
  | { type: "view"; value: WorkspaceView }
  | { type: "draft" | "note-draft"; value: string }
  | { type: "model" }
  | { type: "menu"; open: boolean }
  | { type: "send"; text: string }
  | { type: "save-note"; text: string }
  | { type: "reset" }
  | { type: "load" }
  | { type: "retry" }
  | { type: "scroll"; region: keyof MobileState["reading"]; value: number }
  | {
      type: "selection"
      field: string
      value: MobileState["selection"][string]
    }

export function createMobileState(scenario: string): MobileState {
  const messages =
    scenario === "empty" || scenario === "loading"
      ? []
      : openingMessages.map((message) => ({ ...message }))
  if (scenario === "long-content") {
    for (let i = 1; i <= 24; i++) {
      messages.push({
        id: `history-${i}`,
        role: i % 2 ? "user" : "assistant",
        text: {
          "zh-CN": `交接事项 ${i}：复核负责人、未完成检查和发布状态。保留阅读位置，不因新的预览消息跳回底部。`,
          en: `Handoff item ${i}: review owners, open checks, and release status. Keep the reading position instead of jumping to the bottom when another preview message arrives.`,
        },
      })
    }
  }
  return {
    view: "source",
    dataState:
      scenario === "loading"
        ? "loading"
        : scenario === "empty"
          ? "empty"
          : "ready",
    refreshError: scenario === "refresh-error",
    readonly: scenario === "readonly",
    model: "Focus",
    menuOpen: false,
    draft: "",
    noteDraft: "",
    notes: [],
    messages,
    nextId: 1,
    reading: { conversation: 0, mobile: 0, changes: 0 },
    selection: {},
  }
}

export function reduceMobile(
  state: MobileState,
  action: MobileAction,
): MobileState {
  switch (action.type) {
    case "view":
      return state.view === action.value
        ? state
        : { ...state, view: action.value }
    case "draft":
      return { ...state, draft: action.value.slice(0, 1000) }
    case "note-draft":
      return { ...state, noteDraft: action.value.slice(0, 2000) }
    case "model":
      return { ...state, model: state.model === "Focus" ? "Fast" : "Focus" }
    case "menu":
      return { ...state, menuOpen: action.open }
    case "scroll":
      return {
        ...state,
        reading: {
          ...state.reading,
          [action.region]: Math.max(0, action.value),
        },
      }
    case "selection":
      return {
        ...state,
        selection: { ...state.selection, [action.field]: action.value },
      }
    case "retry":
      return { ...state, refreshError: false }
    case "load":
      return {
        ...state,
        dataState: "ready",
        messages: openingMessages.map((message) => ({ ...message })),
        refreshError: false,
      }
    case "reset":
      if (state.readonly || state.dataState === "loading") return state
      return {
        ...state,
        dataState: "ready",
        messages: openingMessages.map((message) => ({ ...message })),
        draft: "",
        menuOpen: false,
        reading: { ...state.reading, mobile: 0 },
        selection: {
          ...state.selection,
          Message: { start: 0, end: 0, direction: "none" },
        },
      }
    case "send": {
      const text = action.text.trim().slice(0, 1000)
      if (!text || state.readonly || state.dataState === "loading") return state
      const literal: MobileCopy = { "zh-CN": text, en: text }
      return {
        ...state,
        dataState: "ready",
        draft: "",
        nextId: state.nextId + 1,
        messages: [
          ...state.messages,
          { id: `user-${state.nextId}`, role: "user", text: literal },
          {
            id: `reply-${state.nextId}`,
            role: "assistant",
            text: previewReply(text, state.model),
          },
        ],
        selection: {
          ...state.selection,
          Message: { start: 0, end: 0, direction: "none" },
        },
      }
    }
    case "save-note": {
      const text = action.text.trim().slice(0, 2000)
      if (!text || state.readonly || state.dataState !== "ready") return state
      return {
        ...state,
        nextId: state.nextId + 1,
        notes: [...state.notes, { id: `note-${state.nextId}`, text }],
        noteDraft: "",
        selection: {
          ...state.selection,
          "Review note": { start: 0, end: 0, direction: "none" },
        },
      }
    }
  }
}
