import type { ChatEntry, Copy, Draft } from "../../model"
import { createComposerSource, reviewNodes, text, workflowTitle, type ReviewNodeId } from "./fixtures.ts"

export type ReviewState = {
  title: string | Copy
  messages: ChatEntry[]
  draft: Draft
  selectedId: ReviewNodeId | null
  inspector: "node" | "evidence"
  panelOpen: boolean
  expanded: boolean
  threadWidth: number
  viewport?: { x: number; y: number; zoom: number }
  readingPosition: number
  inspectorPosition: number
  readState: "ready" | "empty" | "loading" | "error"
  readonly: boolean
  replaying: boolean
  paused: boolean
  stage: number
  revisionResolved: boolean
  revisionCount: number
  approval: "approved" | "pending" | "unknown"
  historicalAudit: { approval: "approved" | "pending" | "unknown"; revisionCount: number; source: "local-fixture" }
  revisionDraft: string
  revisionNotes: string[]
  owners: Partial<Record<ReviewNodeId, string>>
  sequence: number
}
export function createReviewState(scenario: string): ReviewState {
  const source = createComposerSource()
  return {
    title: workflowTitle, messages: scenario === "empty" ? [] : source.sessions[0].messages,
    draft: { text: "", contextIds: [], model: source.models[0], blocks: false },
    selectedId: scenario === "revision" ? "implementer" : scenario === "approval" || scenario === "unknown-outcome" ? "approval" : null,
    inspector: "node", panelOpen: true, expanded: false, threadWidth: 0, readingPosition: 0, inspectorPosition: 0,
    readState: scenario === "empty" ? "empty" : scenario === "loading" ? "loading" : scenario === "refresh-error" ? "error" : "ready",
    readonly: scenario === "readonly", replaying: false, paused: false,
    stage: scenario === "empty" || scenario === "loading" ? 0 : scenario === "revision" ? 3 : scenario === "approval" || scenario === "unknown-outcome" ? 4 : 5,
    revisionResolved: !["revision", "empty", "loading"].includes(scenario), revisionCount: scenario === "empty" || scenario === "loading" ? 0 : 1,
    approval: scenario === "unknown-outcome" ? "unknown" : ["approval", "revision", "empty", "loading"].includes(scenario) ? "pending" : "approved",
    historicalAudit: { approval: scenario === "unknown-outcome" ? "unknown" : ["approval", "revision", "empty", "loading"].includes(scenario) ? "pending" : "approved", revisionCount: scenario === "empty" || scenario === "loading" ? 0 : 1, source: "local-fixture" },
    revisionDraft: "", revisionNotes: [], owners: {}, sequence: 0,
  }
}
export function nodeStatus(state: ReviewState, id: ReviewNodeId): string {
  if (state.readState === "empty" || state.readState === "loading") return "queued"
  if (id === "published") return state.approval === "approved" && state.stage === 5 ? "completed" : "queued"
  if (id === "approval") return state.approval === "approved" ? "completed" : state.stage >= 4 ? "waiting" : "queued"
  if (state.stage === 3 && !state.revisionResolved && (id === "implementer" || id === "reviewer")) return "waiting"
  const completionStage = { planner: 0, researcher: 1, implementer: 1, tester: 2, reviewer: 2 }[id]
  if (state.stage > completionStage || state.stage === 5) return "completed"
  return state.stage === completionStage ? "running" : "queued"
}
export function replayReview(state: ReviewState): ReviewState {
  if (state.approval === "unknown" || (state.readState !== "ready" && state.readState !== "error")) return state
  return { ...state, stage: 0, replaying: true, paused: false, revisionResolved: false, approval: "pending", selectedId: null }
}
export function advanceReview(state: ReviewState): ReviewState {
  if (state.approval === "unknown" || state.stage === 5 || (state.stage === 3 && !state.revisionResolved) || (state.stage === 4 && state.approval !== "approved")) return state
  const next = state.stage + 1
  return { ...state, stage: next, selectedId: next === 3 ? "implementer" : next === 4 ? "approval" : state.selectedId, replaying: next === 5 ? false : state.replaying }
}
export function requestRevision(state: ReviewState): ReviewState {
  if (state.readonly || !state.revisionDraft.trim() || state.approval === "unknown") return state
  return { ...state, stage: 3, revisionResolved: false, approval: "pending", replaying: false, selectedId: "implementer", inspector: "node", revisionCount: state.revisionCount + 1, revisionNotes: [...state.revisionNotes, state.revisionDraft.trim()], revisionDraft: "" }
}
export function resolveRevision(state: ReviewState): ReviewState {
  if (state.readonly || state.stage !== 3 || state.revisionResolved || state.approval === "unknown") return state
  return { ...state, revisionResolved: true, stage: 4, selectedId: "approval" }
}
export function approveReview(state: ReviewState): ReviewState {
  if (state.readonly || !state.revisionResolved || state.stage !== 4 || state.approval !== "pending") return state
  return { ...state, approval: "approved", stage: 5, replaying: false }
}
export function reconcileReview(state: ReviewState): ReviewState {
  if (state.readonly || state.approval !== "unknown") return state
  // Reconciliation reads the fixed historical fixture; it does not retry a release.
  return { ...state, approval: "approved", stage: 5, revisionResolved: true, replaying: false }
}
export function addReviewNote(state: ReviewState): ReviewState {
  const value = state.draft.text.trim()
  if (state.readonly || state.readState === "loading" || !value) return state
  const id = state.sequence + 1
  const target = reviewNodes.find((node) => node.id === state.selectedId)
  return { ...state, sequence: id, revisionNotes: [...state.revisionNotes, value], messages: [...state.messages,
    { id: `note-${id}`, role: "user", text: value, contexts: state.draft.contextIds.length ? ["Release migration · run review"] : [] },
    { id: `note-result-${id}`, role: "assistant", text: target ? text(`笔记已附到「${target.title["zh-CN"]}」的本地审阅记录。运行与审批状态未改变。`, `The note is attached to the local review record for “${target.title.en}”. Run and approval states are unchanged.`) : text("笔记已附到本地运行审阅记录。运行与审批状态未改变。", "The note is attached to the local run review record. Run and approval states are unchanged.") },
  ], draft: { ...state.draft, text: "", contextIds: [] } }
}
export function reviewExport(state: ReviewState): string {
  if (state.readState === "empty" || state.readState === "loading") return JSON.stringify({ source: "local-fixture", runId: null, dataState: state.readState, notes: state.revisionNotes, nodes: [] }, null, 2)
  return JSON.stringify({ source: "local-fixture", runId: "release-migration-003", stage: state.stage, approval: state.approval, historicalAudit: state.historicalAudit, revisions: state.revisionCount, revisionResolved: state.revisionResolved, notes: state.revisionNotes, nodes: reviewNodes.map(node => ({ id: node.id, owner: state.owners[node.id] ?? node.owner, status: nodeStatus(state, node.id), evidence: node.evidence })) }, null, 2)
}
export function loadReviewFixture(state: ReviewState): ReviewState {
  if (state.readState !== "empty" && state.readState !== "loading") return state
  return { ...state, readState: "ready", stage: 5, approval: "approved", revisionResolved: true, revisionCount: 1, historicalAudit: { approval: "approved", revisionCount: 1, source: "local-fixture" }, messages: [...createComposerSource().sessions[0].messages, ...state.messages.filter(message => message.id.startsWith("note-"))] }
}
