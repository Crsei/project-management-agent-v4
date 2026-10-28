import {
  applyCanvasCommand,
  copyCanvasFragment,
} from "@easyuse-ui/ui/lib/canvas-commands"
import { validateCanvasDocument } from "@easyuse-ui/ui/lib/canvas-validation"
import type {
  CanvasCommand,
  CanvasDocument,
  CanvasIssue,
  CanvasSelection,
} from "@easyuse-ui/ui/lib/canvas-model"
import { createWorkflow, definitions } from "./fixtures"
import type { StepKind } from "./fixtures"

export type WorkflowState = {
  document: CanvasDocument
  selection: CanvasSelection
  focusRequest?: { id: string; request: number }
  past: CanvasDocument[]
  future: CanvasDocument[]
  panelOpen: boolean
  expanded: boolean
  panelWidth: number | null
  issues: CanvasIssue[]
  validatedRevision: number | null
  feedback: { "zh-CN": string; en: string } | null
  readState: "ready" | "loading" | "error"
  editorDrafts: Record<
    string,
    { title: string; description: string; owner: string; condition: string }
  >
}
export function createWorkflowState(scenario: string): WorkflowState {
  return {
    document: createWorkflow(scenario),
    selection: { nodeIds: [], edgeIds: [] },
    past: [],
    future: [],
    panelOpen: true,
    expanded: false,
    panelWidth: null,
    issues: [],
    validatedRevision: null,
    feedback: null,
    readState:
      scenario === "loading"
        ? "loading"
        : scenario === "refresh-error"
          ? "error"
          : "ready",
    editorDrafts: {},
  }
}
export function changeWorkflow(
  state: WorkflowState,
  command: CanvasCommand,
  readOnly = false,
): WorkflowState {
  const result = applyCanvasCommand(state.document, command, definitions, {
    readOnly,
  })
  if (!result.ok)
    return {
      ...state,
      feedback: { "zh-CN": result.message, en: result.message },
    }
  return {
    ...state,
    document: result.document,
    selection: command.type === "move" ? state.selection : result.selection,
    focusRequest:
      command.type === "add" || command.type === "paste"
        ? { id: result.selection.nodeIds[0], request: result.document.revision }
        : state.focusRequest,
    past: [...state.past.slice(-49), state.document],
    future: [],
    issues: [],
    validatedRevision: null,
    feedback: null,
  }
}
export function addStep(
  state: WorkflowState,
  type: StepKind,
  title: string,
  readOnly = false,
): WorkflowState {
  const index = state.document.nodes.length
  const node = {
    id: `step-${state.document.revision + 1}-${index}`,
    type,
    title,
    position: { x: 340 * (index % 4), y: 520 + 260 * Math.floor(index / 4) },
    config: {
      description: "",
      owner: "",
      condition: "risk == high",
      required: true,
      tasks: [],
    },
  }
  return changeWorkflow(state, { type: "add", node }, readOnly)
}
export function duplicateStep(
  state: WorkflowState,
  readOnly = false,
): WorkflowState {
  return changeWorkflow(
    state,
    {
      type: "paste",
      fragment: copyCanvasFragment(state.document, state.selection.nodeIds),
      offset: { x: 40, y: 40 },
    },
    readOnly,
  )
}
export function undoWorkflow(state: WorkflowState): WorkflowState {
  const previous = state.past.at(-1)
  if (!previous) return state
  return {
    ...state,
    document: { ...previous, revision: state.document.revision + 1 },
    past: state.past.slice(0, -1),
    future: [state.document, ...state.future],
    selection: { nodeIds: [], edgeIds: [] },
    issues: [],
    validatedRevision: null,
  }
}
export function redoWorkflow(state: WorkflowState): WorkflowState {
  const next = state.future[0]
  if (!next) return state
  return {
    ...state,
    document: { ...next, revision: state.document.revision + 1 },
    past: [...state.past, state.document],
    future: state.future.slice(1),
    selection: { nodeIds: [], edgeIds: [] },
    issues: [],
    validatedRevision: null,
  }
}
export function inspectWorkflow(document: CanvasDocument): CanvasIssue[] {
  const issues = validateCanvasDocument(document, definitions)
  if (!document.nodes.length)
    issues.push({
      code: "empty",
      message: "Add an input and a verification step before validating.",
      severity: "error",
    })
  const connected = new Set(
    document.edges.flatMap((edge) => [edge.source, edge.target]),
  )
  for (const node of document.nodes)
    if (!connected.has(node.id) && document.nodes.length > 1)
      issues.push({
        code: "unconnected",
        nodeId: node.id,
        message: "This step is not connected to the workflow.",
        severity: "warning",
      })
  return issues
}
export function workflowIntent(
  text: string,
):
  | { type: "add"; kind: StepKind }
  | { type: "validate" }
  | { type: "discussion" } {
  if (/^(validate( flow)?|验证(流程)?)$/i.test(text.trim()))
    return { type: "validate" }
  const add =
    /^(?:add|添加|新增)\s*(?:an?\s+)?(input|agent(?: task)?|decision|approval|输入|代理(?:任务)?|决策|审批)(?:\s+step|步骤)?[.!。]?$/i.exec(
      text.trim(),
    )
  if (!add) return { type: "discussion" }
  const value = add[1].toLowerCase()
  return {
    type: "add",
    kind: /input|输入/.test(value)
      ? "input"
      : /decision|决策/.test(value)
        ? "decision"
        : /approval|审批/.test(value)
          ? "approval"
          : "agent",
  }
}
