import type { Copy } from "../../model"
import { cabinetFiles, type Deliverable } from "./fixtures.ts"

export type CabinetState = {
  files: readonly Deliverable[]
  conversationId: string
  conversationFilter: string
  typeFilter: "all" | "documents" | "data"
  query: string
  sort: "newest" | "name"
  selectedFileId: string | null
  panelOpen: boolean
  panelRatio: number
  drafts: Record<string, string>
  messages: Record<string, { id: string; prompt: string; reply: Copy }[]>
  positions: Record<string, number>
  selections: Record<string, { start: number; end: number }>
  readState: "ready" | "loading" | "error"
  readonly: boolean
}

export function createCabinetState(scenario: string): CabinetState {
  const files = scenario === "empty" || scenario === "loading" ? [] : scenario === "long-content"
    ? [...cabinetFiles, ...Array.from({ length: 30 }, (_, index) => ({
      ...cabinetFiles[index % cabinetFiles.length],
      id: "archive-" + index,
      name: "onboarding-pilot-research-handoff-version-" + String(index + 1).padStart(2, "0") + ".md",
      renderer: "markdown" as const,
      kind: "documents" as const,
      createdMinutes: 580 - index,
      content: {
        en: cabinetFiles[0].content.en + "\n" + cabinetFiles[3].content.en.repeat(8),
        "zh-CN": cabinetFiles[0].content["zh-CN"] + "\n" + cabinetFiles[3].content["zh-CN"].repeat(8),
      },
    }))]
    : cabinetFiles
  return {
    files, conversationId: "pilot", conversationFilter: "all", typeFilter: "all", query: "", sort: "newest",
    selectedFileId: null, panelOpen: true, panelRatio: 0.62, drafts: {}, messages: {}, positions: {}, selections: {},
    readState: scenario === "loading" ? "loading" : scenario === "refresh-error" ? "error" : "ready", readonly: scenario === "readonly",
  }
}

export function visibleDeliverables(state: CabinetState, locale: "zh-CN" | "en") {
  const query = state.query.trim().toLocaleLowerCase(locale)
  return state.files.filter(file =>
    (state.conversationFilter === "all" || file.conversationId === state.conversationFilter) &&
    (state.typeFilter === "all" || file.kind === state.typeFilter) &&
    (!query || (file.name + " " + file.title[locale]).toLocaleLowerCase(locale).includes(query)),
  ).sort((a, b) => state.sort === "name" ? a.name.localeCompare(b.name, locale) : b.createdMinutes - a.createdMinutes)
}

export function openDeliverable(state: CabinetState, fileId: string): CabinetState {
  return state.files.some(file => file.id === fileId)
    ? { ...state, selectedFileId: fileId, panelOpen: true }
    : state
}

export function sourceConversation(state: CabinetState): CabinetState {
  const file = state.files.find(item => item.id === state.selectedFileId)
  return file ? { ...state, conversationId: file.conversationId } : state
}

export function sendCabinetQuestion(state: CabinetState): CabinetState {
  const prompt = (state.drafts[state.conversationId] ?? "").trim()
  if (!prompt || state.readonly || state.readState === "loading") return state
  const file = state.files.find(item => item.id === state.selectedFileId)
  const ownFiles = state.files.filter(item => item.conversationId === state.conversationId)
  const reply: Copy = file
    ? {
      en: "Prepared file summary: " + file.title.en + ".\n\n" + file.content.en.replace(/^#+ /gm, "").slice(0, 640) + "\n\nThis is a local fixture response, not a live model result.",
      "zh-CN": "预先准备的文件摘要：" + file.title["zh-CN"] + "。\n\n" + file.content["zh-CN"].replace(/^#+ /gm, "").slice(0, 420) + "\n\n这是本地示例回复，并非实时模型结果。",
    }
    : {
      en: "This conversation has " + ownFiles.length + " prepared files" + (ownFiles.length ? ": " + ownFiles.map(item => item.name).join(", ") : "") + ". Review a file in the cabinet to ask about its contents. This response comes from local fixture data.",
      "zh-CN": "此会话包含 " + ownFiles.length + " 份示例文件" + (ownFiles.length ? "：" + ownFiles.map(item => item.name).join("、") : "") + "。在文件柜中打开文件后可询问其内容。本回复来自本地示例数据。",
    }
  const previous = state.messages[state.conversationId] ?? []
  return {
    ...state,
    drafts: { ...state.drafts, [state.conversationId]: "" },
    messages: { ...state.messages, [state.conversationId]: [...previous, { id: state.conversationId + "-question-" + (previous.length + 1), prompt, reply }] },
  }
}

export function deliverableBytes(file: Deliverable, locale: "zh-CN" | "en") {
  return new TextEncoder().encode(file.content[locale])
}

export function fileSize(file: Deliverable, locale: "zh-CN" | "en") {
  const size = deliverableBytes(file, locale).byteLength
  return size >= 1024 ? (size / 1024).toFixed(1) + " KB" : size + " B"
}

export function createdTime(file: Deliverable) {
  const hours = Math.floor(file.createdMinutes / 60)
  return (hours % 12 || 12) + ":" + String(file.createdMinutes % 60).padStart(2, "0") + (hours >= 12 ? " PM" : " AM")
}
