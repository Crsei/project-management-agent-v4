import {
  conciseRecommendation,
  documentHtml,
  documentText,
  longDocumentHtml,
  recommendation,
} from "./fixtures.ts"

export type DocumentSnapshot = { html: string; text: string }
export type Passage = { from: number; to: number; text: string }
export type Revision = {
  id: number
  passage: Passage
  replacement: string
  instruction: string
  status: "pending" | "accepted" | "dismissed"
}
export type WritingState = {
  document: DocumentSnapshot
  undo: DocumentSnapshot[]
  redo: DocumentSnapshot[]
  selection: Passage | null
  revisions: Revision[]
  instruction: string
  style: "concise" | "direct"
  open: boolean
  expanded: boolean
  threadWidth: number | null
  readState: "ready" | "loading" | "error"
  notice: "" | "stale" | "exported"
  chatScroll: number
  documentScroll: number
  inputSelection: [number, number]
  resetOpen: boolean
}
export function createWritingState(scenario: string): WritingState {
  const html =
    scenario === "empty"
      ? "<p><br></p>"
      : scenario === "long-content"
        ? longDocumentHtml
        : documentHtml
  const text =
    scenario === "empty"
      ? ""
      : scenario === "long-content"
        ? html.replace(/<[^>]*>/g, "")
        : documentText
  const from = text.indexOf(recommendation)
  return {
    document: { html, text },
    undo: [],
    redo: [],
    selection: null,
    revisions:
      from < 0
        ? []
        : [
            {
              id: 1,
              passage: {
                from,
                to: from + recommendation.length,
                text: recommendation,
              },
              replacement: conciseRecommendation,
              instruction: "Make the recommendation shorter and more direct.",
              status: "pending",
            },
          ],
    instruction: "",
    style: "concise",
    open: true,
    expanded: false,
    threadWidth: null,
    readState:
      scenario === "loading"
        ? "loading"
        : scenario === "refresh-error"
          ? "error"
          : "ready",
    notice: "",
    chatScroll: 0,
    documentScroll: 0,
    inputSelection: [0, 0],
    resetOpen: false,
  }
}
export function commitDocument(
  state: WritingState,
  document: DocumentSnapshot,
): WritingState {
  if (document.html === state.document.html) return state
  return {
    ...state,
    document,
    undo: [...state.undo.slice(-99), state.document],
    redo: [],
    notice: "",
  }
}
export function undoDocument(state: WritingState): WritingState {
  const previous = state.undo.at(-1)
  return previous
    ? {
        ...state,
        document: previous,
        undo: state.undo.slice(0, -1),
        redo: [...state.redo, state.document],
        selection: null,
        notice: "",
      }
    : state
}
export function redoDocument(state: WritingState): WritingState {
  const next = state.redo.at(-1)
  return next
    ? {
        ...state,
        document: next,
        redo: state.redo.slice(0, -1),
        undo: [...state.undo, state.document],
        selection: null,
        notice: "",
      }
    : state
}
export function passageIsCurrent(
  document: DocumentSnapshot,
  passage: Passage,
): boolean {
  return (
    passage.from >= 0 &&
    passage.to > passage.from &&
    passage.to <= document.text.length &&
    document.text.slice(passage.from, passage.to) === passage.text
  )
}
export function suggestRevision(state: WritingState): WritingState {
  const passage = state.selection
  if (
    !state.instruction.trim() ||
    !passage ||
    !passageIsCurrent(state.document, passage)
  )
    return state
  const replacement =
    passage.text === recommendation
      ? state.style === "concise"
        ? conciseRecommendation
        : "Create a project, invite a teammate, and complete a shared task. Make this three-step checklist the first-run experience. Introduce advanced settings only when teams need them."
      : state.style === "concise"
        ? passage.text
            .replace(
              /\b(We recommend |in order to |really |very |basically )/gi,
              "",
            )
            .trim()
            .split(/(?<=[.!?])\s+/)
            .slice(0, 2)
            .join(" ")
        : passage.text
            .replace(/^We recommend introducing /, "Introduce ")
            .replace(/should focus on /gi, "must prioritize ")
            .replace(/can wait until /gi, "must wait until ")
  return {
    ...state,
    revisions: [
      ...state.revisions,
      {
        id: (state.revisions.at(-1)?.id ?? 0) + 1,
        passage: { ...passage },
        replacement,
        instruction: state.instruction.trim(),
        status: "pending",
      },
    ],
    instruction: "",
    notice: "",
  }
}
export function acceptRevision(
  state: WritingState,
  id: number,
  document: DocumentSnapshot,
): WritingState {
  const revision = state.revisions.find((item) => item.id === id)
  if (!revision || revision.status !== "pending") return state
  if (
    !passageIsCurrent(state.document, revision.passage) ||
    !revision.replacement.trim()
  )
    return { ...state, notice: "stale" }
  const expected =
    state.document.text.slice(0, revision.passage.from) +
    revision.replacement +
    state.document.text.slice(revision.passage.to)
  if (document.text !== expected) return { ...state, notice: "stale" }
  return {
    ...commitDocument(state, document),
    selection: {
      from: revision.passage.from,
      to: revision.passage.from + revision.replacement.length,
      text: revision.replacement,
    },
    revisions: state.revisions.map((item) =>
      item.id === id ? { ...item, status: "accepted" } : item,
    ),
  }
}
export const wordCount = (text: string) =>
  text.trim() ? (text.match(/[^\s]+/g) ?? []).length : 0
