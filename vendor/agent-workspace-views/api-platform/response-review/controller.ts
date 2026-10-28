import type { ApScenario, ApOperationResult } from "../model"
import { apScope } from "../model.ts"
import {
  createReviewRecords,
  reviewDataset,
  type ReviewRecord,
} from "./fixtures.ts"

export type Accuracy = "accurate" | "partly" | "incorrect"
export type Resolution = "resolved" | "partially" | "unresolved"
export type ReviewDraft = {
  accuracy: Accuracy | null
  resolution: Resolution | null
  correction: string
  notes: string
  sourceId: string
  sourceOpen: boolean
  notesSelection: [number, number]
  correctionSelection: [number, number]
}
export type ReviewPayload = {
  reviewId: string
  responseId: string
  exampleId: string
  datasetId: string
  datasetVersion: number
  sourceId: string
  sourceVersion: string | null
  annotations: Pick<
    ReviewDraft,
    "accuracy" | "resolution" | "correction" | "notes"
  >
}
export type FixtureOutcome = "confirmed" | "rejected" | "unknown"
export type SaveMode =
  | "confirmed"
  | "rejected"
  | "unknown-confirmed"
  | "unknown-rejected"
  | "unknown-unresolved"
export type ReviewOperation = {
  status: ApOperationResult
  intent: "save" | "query"
  operationId: string
  payload: ReviewPayload
  outcome: FixtureOutcome
  recordedOutcome: FixtureOutcome
}
export type ReviewState = {
  records: ReviewRecord[]
  selectedId: string | null
  drafts: Record<string, ReviewDraft>
  saved: Record<string, ReviewPayload>
  operation: ReviewOperation | null
  sequence: number
  mode: SaveMode
  canWrite: boolean
  loaded: boolean
  refreshError: boolean
  errors: { accuracy?: true; resolution?: true; correction?: true }
  notice: "idle" | "saved" | "skipped" | "complete" | "rejected" | "unknown"
}
function blankDraft(record: ReviewRecord): ReviewDraft {
  return {
    accuracy: null,
    resolution: null,
    correction: "",
    notes: "",
    sourceId: record.source.sourceId,
    sourceOpen: true,
    notesSelection: [0, 0],
    correctionSelection: [0, 0],
  }
}
export function createReviewState(scenario: ApScenario): ReviewState {
  const records = createReviewRecords(scenario)
  return {
    records,
    selectedId: records[0]?.reviewId ?? null,
    drafts: Object.fromEntries(
      records.map((record) => [record.reviewId, blankDraft(record)]),
    ),
    saved: {},
    operation: null,
    sequence: 0,
    mode: "confirmed",
    canWrite: apScope.canWrite && scenario !== "readonly",
    loaded: scenario !== "loading",
    refreshError: scenario === "refresh-error",
    errors: {},
    notice: "idle",
  }
}
export function reviewLocked(state: ReviewState) {
  return (
    state.operation?.status === "pending" ||
    state.operation?.status === "unknown"
  )
}
export function reviewCount(state: ReviewState) {
  return state.records.filter((record) => state.saved[record.reviewId]).length
}
export function selectReview(
  state: ReviewState,
  reviewId: string,
): ReviewState {
  if (
    reviewLocked(state) ||
    !state.records.some((record) => record.reviewId === reviewId)
  )
    return state
  return { ...state, selectedId: reviewId, errors: {}, notice: "idle" }
}
export function moveReview(state: ReviewState, direction: -1 | 1): ReviewState {
  const index = state.records.findIndex(
    (record) => record.reviewId === state.selectedId,
  )
  const next = state.records[index + direction]
  return next ? selectReview(state, next.reviewId) : state
}
export function updateReviewDraft(
  state: ReviewState,
  patch: Partial<ReviewDraft>,
): ReviewState {
  if (!state.selectedId || !state.canWrite || reviewLocked(state)) return state
  return {
    ...state,
    drafts: {
      ...state.drafts,
      [state.selectedId]: { ...state.drafts[state.selectedId], ...patch },
    },
    errors: {},
    notice: "idle",
  }
}
export function toggleReviewSource(
  state: ReviewState,
  open?: boolean,
): ReviewState {
  if (!state.selectedId) return state
  const draft = state.drafts[state.selectedId]
  return {
    ...state,
    drafts: {
      ...state.drafts,
      [state.selectedId]: { ...draft, sourceOpen: open ?? !draft.sourceOpen },
    },
  }
}
function nextUnreviewed(state: ReviewState, fromId: string) {
  const from = state.records.findIndex((record) => record.reviewId === fromId)
  for (let offset = 1; offset < state.records.length; offset++) {
    const candidate = state.records[(from + offset) % state.records.length]
    if (!state.saved[candidate.reviewId]) return candidate.reviewId
  }
  return fromId
}
export function skipReview(state: ReviewState): ReviewState {
  if (!state.selectedId || reviewLocked(state)) return state
  const next = nextUnreviewed(state, state.selectedId)
  return { ...state, selectedId: next, errors: {}, notice: "skipped" }
}
export function beginReviewSave(state: ReviewState): ReviewState {
  if (
    !state.loaded ||
    !state.canWrite ||
    !state.selectedId ||
    reviewLocked(state)
  )
    return state
  const record = state.records.find(
    (record) => record.reviewId === state.selectedId,
  )
  if (!record) return state
  const draft = state.drafts[record.reviewId]
  const errors: ReviewState["errors"] = {}
  if (!draft.accuracy) errors.accuracy = true
  if (!draft.resolution) errors.resolution = true
  if (
    draft.accuracy &&
    draft.accuracy !== "accurate" &&
    !draft.correction.trim()
  )
    errors.correction = true
  if (Object.keys(errors).length) return { ...state, errors }
  const sequence = state.sequence + 1
  const payload: ReviewPayload = {
    reviewId: record.reviewId,
    responseId: record.responseId,
    exampleId: record.exampleId,
    datasetId: reviewDataset.datasetId,
    datasetVersion: reviewDataset.version,
    sourceId: draft.sourceId,
    sourceVersion: record.source.version,
    annotations: {
      accuracy: draft.accuracy,
      resolution: draft.resolution,
      correction: draft.correction,
      notes: draft.notes,
    },
  }
  const outcome = state.mode.startsWith("unknown")
    ? "unknown"
    : (state.mode as FixtureOutcome)
  const recordedOutcome =
    state.mode === "unknown-confirmed"
      ? "confirmed"
      : state.mode === "unknown-rejected"
        ? "rejected"
        : outcome
  return {
    ...state,
    sequence,
    errors: {},
    notice: "idle",
    operation: {
      status: "pending",
      intent: "save",
      operationId: "review-" + record.reviewId + "-" + sequence,
      payload,
      outcome,
      recordedOutcome,
    },
  }
}
export function beginReviewQuery(state: ReviewState): ReviewState {
  if (state.operation?.status !== "unknown") return state
  return {
    ...state,
    operation: { ...state.operation, status: "pending", intent: "query" },
  }
}
export function settleReviewOperation(
  state: ReviewState,
  operationId: string,
): ReviewState {
  const operation = state.operation
  if (
    !operation ||
    operation.operationId !== operationId ||
    operation.status !== "pending"
  )
    return state
  const outcome =
    operation.intent === "query" ? operation.recordedOutcome : operation.outcome
  const settled = {
    ...state,
    operation: { ...operation, status: outcome },
    notice: outcome === "confirmed" ? ("saved" as const) : outcome,
  }
  if (outcome !== "confirmed") return settled
  const saved = {
    ...state.saved,
    [operation.payload.reviewId]: operation.payload,
  }
  const confirmed = { ...settled, saved }
  const complete = reviewCount(confirmed) === confirmed.records.length
  return {
    ...confirmed,
    selectedId: nextUnreviewed(confirmed, operation.payload.reviewId),
    notice: complete ? "complete" : "saved",
  }
}
