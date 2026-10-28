import type { Copy } from "../../model"
import {
  createDocuments,
  type ComparisonDocument,
  type Passage,
} from "./fixtures.ts"

export type Difference = {
  id: string
  heading: Copy
  before?: Passage
  after?: Passage
  kind: "unchanged" | "changed" | "added" | "removed"
}
export type DiffToken = { text: string; kind: "equal" | "removed" | "added" }
export type LocalMessage = {
  id: number
  role: "user" | "assistant"
  text: string | Copy
}
export type ComparisonState = {
  scenario: string
  documents: ComparisonDocument[]
  beforeId: string
  afterId: string
  selectedId: string | null
  changesOnly: boolean
  reviewed: Record<string, string[]>
  drafts: Record<string, string>
  messages: Record<string, LocalMessage[]>
  panelOpen: boolean
  scrollTop: number
  chatScrollTop: number
  dataState: "ready" | "loading" | "empty" | "refresh-error"
  readonly: boolean
  longContent: boolean
}
export function compareDocuments(
  before?: ComparisonDocument,
  after?: ComparisonDocument,
): Difference[] {
  if (!before || !after) return []
  const left = new Map(before.passages.map((p) => [p.id, p]))
  const right = new Map(after.passages.map((p) => [p.id, p]))
  const orderedIds = [...left.keys()]
  const rightIds = [...right.keys()]
  rightIds.forEach((id, index) => {
    if (left.has(id)) return
    const nextShared = rightIds.find(
      (nextId, nextIndex) => nextIndex > index && left.has(nextId),
    )
    if (nextShared) orderedIds.splice(orderedIds.indexOf(nextShared), 0, id)
    else orderedIds.push(id)
  })
  return orderedIds.map((id) => {
    const before = left.get(id),
      after = right.get(id)
    return {
      id,
      heading: (after ?? before)!.heading,
      before,
      after,
      kind: !before
        ? "added"
        : !after
          ? "removed"
          : before.text.en === after.text.en
            ? "unchanged"
            : "changed",
    }
  })
}
export function differences(state: ComparisonState) {
  return compareDocuments(
    state.documents.find((d) => d.id === state.beforeId),
    state.documents.find((d) => d.id === state.afterId),
  )
}
export function pairKey(state: ComparisonState) {
  return `${state.beforeId}>${state.afterId}`
}
export function contextKey(state: ComparisonState) {
  return `${pairKey(state)}:${state.selectedId ?? "none"}`
}
export function createComparisonState(scenario: string): ComparisonState {
  const documents =
    scenario === "empty" ? [] : createDocuments(scenario === "long-content")
  return {
    scenario,
    documents,
    beforeId: "original",
    afterId: "proposed",
    selectedId: documents.length ? "session" : null,
    changesOnly: false,
    reviewed: {},
    drafts: {},
    messages: {},
    panelOpen: false,
    scrollTop: 0,
    chatScrollTop: 0,
    dataState:
      scenario === "loading"
        ? "loading"
        : scenario === "empty"
          ? "empty"
          : scenario === "refresh-error"
            ? "refresh-error"
            : "ready",
    readonly: scenario === "readonly",
    longContent: scenario === "long-content",
  }
}

/** Word-level LCS keeps equal words unmarked and supports insertions and removals. */
export function diffText(before: string, after: string): DiffToken[] {
  const left = before.match(/\S+\s*|\s+/gu) ?? []
  const right = after.match(/\S+\s*|\s+/gu) ?? []
  const table = Array.from(
    { length: left.length + 1 },
    () => new Uint32Array(right.length + 1),
  )
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i]![j] =
        left[i] === right[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  const output: DiffToken[] = []
  let i = 0,
    j = 0
  const add = (kind: DiffToken["kind"], text: string) => {
    const previous = output.at(-1)
    if (previous?.kind === kind) previous.text += text
    else output.push({ kind, text })
  }
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      add("equal", left[i++]!)
      j++
    } else if (
      i < left.length &&
      (j >= right.length || table[i + 1]![j]! >= table[i]![j + 1]!)
    )
      add("removed", left[i++]!)
    else add("added", right[j++]!)
  }
  return output
}
export type ComparisonAction =
  | { type: "documents"; side: "before" | "after"; id: string }
  | { type: "swap" }
  | { type: "select"; id: string }
  | { type: "navigate"; direction: -1 | 1 }
  | { type: "filter"; value: boolean }
  | { type: "review" }
  | { type: "panel"; open: boolean }
  | { type: "draft"; text: string }
  | { type: "ask"; text: string; locale: "zh-CN" | "en" }
  | { type: "scroll"; value: number; chat?: boolean }
  | { type: "load" }
  | { type: "reset" }

export function reduceComparison(
  state: ComparisonState,
  action: ComparisonAction,
): ComparisonState {
  const changes = differences(state).filter((d) => d.kind !== "unchanged")
  const selected = changes.find((d) => d.id === state.selectedId)
  const key = contextKey(state)
  switch (action.type) {
    case "documents": {
      if (!state.documents.some((d) => d.id === action.id)) return state
      const next = {
        ...state,
        [action.side === "before" ? "beforeId" : "afterId"]: action.id,
        panelOpen: false,
        scrollTop: 0,
      }
      return {
        ...next,
        selectedId:
          differences(next).find((d) => d.kind !== "unchanged")?.id ?? null,
      }
    }
    case "swap": {
      const next = {
        ...state,
        beforeId: state.afterId,
        afterId: state.beforeId,
        panelOpen: false,
        scrollTop: 0,
      }
      return {
        ...next,
        selectedId:
          differences(next).find(
            (d) => d.id === state.selectedId && d.kind !== "unchanged",
          )?.id ??
          differences(next).find((d) => d.kind !== "unchanged")?.id ??
          null,
      }
    }
    case "select":
      return changes.some((d) => d.id === action.id)
        ? { ...state, selectedId: action.id, chatScrollTop: 0 }
        : state
    case "navigate": {
      if (!changes.length) return state
      const index = changes.findIndex((d) => d.id === state.selectedId)
      return {
        ...state,
        selectedId:
          changes[(index + action.direction + changes.length) % changes.length]!
            .id,
        chatScrollTop: 0,
      }
    }
    case "filter":
      return { ...state, changesOnly: action.value }
    case "review": {
      if (state.readonly || !selected || state.dataState === "loading")
        return state
      const pair = pairKey(state),
        current = state.reviewed[pair] ?? []
      return {
        ...state,
        reviewed: {
          ...state.reviewed,
          [pair]: current.includes(selected.id)
            ? current.filter((id) => id !== selected.id)
            : [...current, selected.id],
        },
      }
    }
    case "panel":
      return { ...state, panelOpen: action.open && !!selected }
    case "draft":
      return { ...state, drafts: { ...state.drafts, [key]: action.text } }
    case "ask": {
      const text = action.text.trim()
      if (!selected || !text || state.dataState === "loading") return state
      const passage = selected.after?.explanation
        ? selected.after
        : selected.before
      const explanation = passage?.explanation
      const checklist = passage?.checklist
      const check = /check|review|risk|验证|检查|审阅|风险/iu.test(text)
      const answer: Copy = {
        en: `${state.beforeId === "proposed" ? "The comparison is reversed: the proposal is on the left and the original is on the right. " : ""}${explanation?.en ?? "This passage differs between the selected documents."}${check ? ` ${checklist?.en ?? "Review both passages in their surrounding document context."}` : ""}`,
        "zh-CN": `${state.beforeId === "proposed" ? "比较方向已反转：左侧是提议稿，右侧是原稿。" : ""}${explanation?.["zh-CN"] ?? "所选文档的这一段存在差异。"}${check ? (checklist?.["zh-CN"] ?? "请结合相邻文档上下文审阅两段内容。") : ""}`,
      }
      const current = state.messages[key] ?? []
      return {
        ...state,
        drafts: { ...state.drafts, [key]: "" },
        messages: {
          ...state.messages,
          [key]: [
            ...current,
            { id: current.length + 1, role: "user", text },
            { id: current.length + 2, role: "assistant", text: answer },
          ],
        },
      }
    }
    case "scroll":
      return {
        ...state,
        [action.chat ? "chatScrollTop" : "scrollTop"]: Math.max(
          0,
          action.value,
        ),
      }
    case "load": {
      if (state.dataState === "refresh-error")
        return { ...state, dataState: "ready" }
      const documents = createDocuments(state.longContent)
      return { ...state, documents, selectedId: "session", dataState: "ready" }
    }
    case "reset":
      return createComparisonState(state.scenario)
  }
}
