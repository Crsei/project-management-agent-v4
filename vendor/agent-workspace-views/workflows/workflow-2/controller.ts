import type { CanvasDocument, CanvasExecutionSnapshot, CanvasSelection } from "@easyuse-ui/ui/lib/canvas-model"
import { createWorkflowDocument, workflowSteps } from "./fixtures.ts"

export type WorkflowRun = {
  id: number
  sequence: number
  completed: number
  phase: "running" | "paused" | "completed" | "blocked" | "unknown" | "idle"
  playing: boolean
}
export type WorkflowState = {
  document: CanvasDocument
  run: WorkflowRun
  selection: CanvasSelection
  selectedEvent: string
  following: boolean
  workspaceOpen: boolean
  expanded: boolean
  traceOpen: boolean
  threadWidth: number
  readState: "ready" | "loading" | "error"
}
export function createWorkflowState(scenario: string): WorkflowState {
  const completed = scenario === "completed" ? 6 : scenario === "empty" ? 0 : 2
  const phase = scenario === "completed" ? "completed" : scenario === "blocked" ? "blocked" : scenario === "unknown" ? "unknown" : scenario === "empty" ? "idle" : "running"
  return {
    document: createWorkflowDocument(), run: { id: 1, sequence: 0, completed, phase, playing: false },
    selection: { nodeIds: [], edgeIds: [] }, selectedEvent: completed === 6 ? "complete" : "build", following: true,
    workspaceOpen: true, expanded: false, traceOpen: true, threadWidth: 405,
    readState: scenario === "loading" ? "loading" : scenario === "refresh-error" ? "error" : "ready",
  }
}
export function stepStatus(run: WorkflowRun, stepId: string): string {
  const index = workflowSteps.findIndex(step => step.id === stepId)
  if (index < 0) return "idle"
  if (index < run.completed) return "completed"
  const parallelReview = run.completed === 3 && stepId === "review" && ["running", "paused"].includes(run.phase)
  if ((index > run.completed && !parallelReview) || run.phase === "idle") return "waiting"
  if (run.phase === "blocked") return "failed"
  if (run.phase === "unknown") return "waiting"
  return run.phase === "paused" ? "paused" : "running"
}
export function executionSnapshot(state: WorkflowState): CanvasExecutionSnapshot {
  const { document, run } = state
  return {
    documentId: document.id, documentRevision: document.revision, runId: `local-run-${run.id}`,
    nodes: Object.fromEntries(workflowSteps.map(step => [step.id, { status: stepStatus(run, step.id), attemptId: `attempt-${run.id}-${step.id}`, outcome: run.phase === "unknown" && step.id === workflowSteps[run.completed]?.id ? "unknown" : "known" }])),
    edges: Object.fromEntries(document.edges.map(edge => [edge.id, { status: stepStatus(run, edge.target) === "running" && stepStatus(run, edge.source) === "completed" ? "running" : stepStatus(run, edge.target) === "completed" ? "completed" : "waiting" }])),
  }
}
/** Fixture events are scoped to a run; stale timer ticks cannot advance a restart. */
export function advanceWorkflow(state: WorkflowState, runId = state.run.id): WorkflowState {
  if (state.run.id !== runId || state.run.phase !== "running" || state.run.completed >= 6) return state
  const completed = state.run.completed + 1
  const finished = completed === 6
  return {
    ...state,
    run: { ...state.run, completed, sequence: state.run.sequence + 1, phase: finished ? "completed" : "running", playing: finished ? false : state.run.playing },
    selectedEvent: state.following ? workflowSteps[Math.min(completed, 5)].id : state.selectedEvent,
  }
}
export function restartWorkflow(state: WorkflowState): WorkflowState {
  if (state.run.phase === "unknown") return state
  return { ...state, run: { id: state.run.id + 1, sequence: 0, completed: 0, phase: "running", playing: true }, selectedEvent: "context", following: true, selection: { nodeIds: [], edgeIds: [] } }
}
export function inspectWorkflowEvent(state: WorkflowState, id: string): WorkflowState {
  if (!workflowSteps.some(step => step.id === id)) return state
  return { ...state, selectedEvent: id, selection: { nodeIds: [id], edgeIds: [] }, following: false, traceOpen: true }
}
export function followWorkflow(state: WorkflowState): WorkflowState {
  return { ...state, following: true, selectedEvent: workflowSteps[Math.min(state.run.completed, 5)].id }
}
/** Querying the local event ledger confirms interruption, not successful execution. */
export function reconcileWorkflow(state: WorkflowState): WorkflowState {
  if (state.run.phase !== "unknown") return state
  return { ...state, run: { ...state.run, phase: "paused", playing: false, sequence: state.run.sequence + 1 } }
}
