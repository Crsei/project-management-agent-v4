import type { UiMessage } from "./i18n-core"
import type { ReactNode } from "react"

export type CanvasValue =
  | null
  | boolean
  | number
  | string
  | CanvasValue[]
  | { [key: string]: CanvasValue }
export type CanvasPoint = { x: number; y: number }
export type CanvasPortType =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "message"
  | "tool"
  | "model"
export type CanvasPortDefinition = {
  id: string
  label: string
  labelI18n?: UiMessage
  direction: "input" | "output"
  type: CanvasPortType
  required?: boolean
  maxConnections?: number
}
export type CanvasCatalogEntry = {
  id: string
  name: string
  available: boolean
}
export type CanvasCatalogs = Partial<
  Record<"models" | "tools" | "credentials", CanvasCatalogEntry[]>
>
export type CanvasField = {
  key: string
  label: string
  labelI18n?: UiMessage
  kind:
    | "text"
    | "textarea"
    | "number"
    | "select"
    | "json"
    | "key-value"
    | "condition"
    | "schema"
    | "expression"
    | "code"
  required?: boolean
  catalog?: keyof CanvasCatalogs
  options?: { value: string; label: string; labelI18n?: UiMessage }[]
  min?: number
  max?: number
  variableType?: CanvasPortType
}
export type CanvasVariable = {
  nodeId: string
  portId: string
  path: string[]
  type: CanvasPortType
}
export type CanvasNodeRecord = {
  id: string
  type: string
  title: string
  position: CanvasPoint
  config: Record<string, CanvasValue>
  bindings?: Record<string, CanvasVariable>
  parentId?: string
}
export type CanvasEdgeRecord = {
  id: string
  source: string
  sourcePort: string
  target: string
  targetPort: string
  label?: string
}
export type CanvasFrameRecord = {
  id: string
  title: string
  position: CanvasPoint
  width: number
  height: number
}
export type CanvasNoteRecord = {
  id: string
  text: string
  position: CanvasPoint
}
export type CanvasDocument = {
  schemaVersion: 1
  id: string
  revision: number
  nodes: CanvasNodeRecord[]
  edges: CanvasEdgeRecord[]
  frames: CanvasFrameRecord[]
  notes: CanvasNoteRecord[]
  viewport?: CanvasPoint & { zoom: number }
}
export type CanvasNodeDefinition = {
  type: string
  label: string
  labelI18n?: UiMessage
  category: string
  categoryI18n?: UiMessage
  icon?: ReactNode
  ports: CanvasPortDefinition[]
  defaults: Record<string, CanvasValue>
  fields?: CanvasField[]
  summaryI18n?: UiMessage
  summary?: (node: CanvasNodeRecord) => string
  validate?: (node: CanvasNodeRecord) => string[]
}
export type CanvasSelection = {
  nodeIds: string[]
  edgeIds: string[]
  frameId?: string
  noteId?: string
}
export const emptyCanvasSelection: CanvasSelection = {
  nodeIds: [],
  edgeIds: [],
}
export type CanvasIssue = {
  messageI18n?: UiMessage
  code: string
  message: string
  nodeId?: string
  portId?: string
  edgeId?: string
  severity: "error" | "warning"
}
export type CanvasConnectionPolicy = (
  source: CanvasPortDefinition,
  target: CanvasPortDefinition,
) => boolean
/** Presentation only; these options never advance or pause an execution service. */
export type CanvasExecutionVisuals = {
  edgeEffect?: "flow" | "particles" | "none"
  speed?: 0.5 | 1 | 2
  paused?: boolean
}
export type CanvasExecutionSnapshot = {
  documentId: string
  runId: string
  documentRevision: number
  nodes: Record<
    string,
    {
      status: string
      attemptId: string
      outcome?: "known" | "unknown"
      duration?: string
      tokens?: number
      model?: string
    }
  >
  edges?: Record<string, { status: string }>
}
export const canvasLimits = {
  bytes: 524288,
  nodes: 500,
  edges: 1000,
  annotations: 200,
  history: 100,
} as const
export type CanvasFragment = {
  nodes: CanvasNodeRecord[]
  edges: CanvasEdgeRecord[]
}
export type CanvasCommand =
  | { type: "add"; node: CanvasNodeRecord }
  | { type: "move"; positions: Record<string, CanvasPoint> }
  | { type: "delete"; selection: CanvasSelection }
  | {
      type: "configure"
      nodeId: string
      title: string
      config: Record<string, CanvasValue>
      bindings?: Record<string, CanvasVariable>
    }
  | { type: "connect"; edge: CanvasEdgeRecord }
  | { type: "reconnect"; edgeId: string; edge: CanvasEdgeRecord }
  | {
      type: "insert"
      edgeId: string
      node: CanvasNodeRecord
      inputPort: string
      outputPort: string
    }
  | { type: "paste"; fragment: CanvasFragment; offset?: CanvasPoint }
  | { type: "frame"; frame: CanvasFrameRecord; nodeIds: string[] }
  | { type: "move-frame"; frameId: string; position: CanvasPoint }
  | { type: "delete-frame"; frameId: string }
  | { type: "note"; note: CanvasNoteRecord }
  | { type: "update-note"; noteId: string; text: string }
  | { type: "move-note"; noteId: string; position: CanvasPoint }
  | { type: "delete-note"; noteId: string }
  | { type: "replace"; document: CanvasDocument }
export function createCanvasDocument(id = "local-workflow"): CanvasDocument {
  return {
    schemaVersion: 1,
    id,
    revision: 0,
    nodes: [],
    edges: [],
    frames: [],
    notes: [],
  }
}
export function canvasId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`
}
