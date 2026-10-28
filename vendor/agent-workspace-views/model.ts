import type {
  ConnectionStatus,
  DataStatus,
  RunStatus,
  SourceReference,
  WorkspaceApproval,
  WorkspaceCapabilities,
  WorkspaceMessage,
  WorkspaceMessagePart,
  WorkspaceOperationReceipt,
  WorkspaceResourceReference,
  WorkspaceRun,
} from "@easyuse-ui/workspace-protocol"

export type Copy = { "zh-CN": string; en: string }
export type Locale = keyof Copy
export type ContextItem = {
  id: string
  name: string
  description: Copy
  kind: Copy
}
export type ChatEntry = {
  id: string
  role: WorkspaceMessage["role"]
  text: string | Copy
  contexts?: string[]
  /** Source facts are retained, including unsupported parts; no generated evidence. */
  sourceParts?: WorkspaceMessagePart[]
  source?: SourceReference
  tools?: Extract<WorkspaceMessagePart, { type: "tool" }>["tool"][]
  approvals?: WorkspaceApproval[]
  resources?: WorkspaceResourceReference[]
  state?: RunStatus
}
export type ComposerSession = {
  id: string
  projectId: string
  title: string | Copy
  messages: ChatEntry[]
}

export type Draft = {
  text: string
  contextIds: string[]
  model: string
  blocks: boolean
}
export type ComposerExecutionState = {
  connection: ConnectionStatus
  data: DataStatus
  runs: WorkspaceRun[]
  operations: WorkspaceOperationReceipt[]
}

export type ComposerSource = {
  initialReadingPosition?: "start" | "latest"
  sessions: ComposerSession[]
  selectedId: string
  projectId: string
  drafts: Record<string, Draft>
  projects: { id: string; name: string }[]
  contextItems: ContextItem[]
  models: string[]
  suggestions: Copy[]
  runtime?: { status: string; message: string | Copy }
  capabilities?: WorkspaceCapabilities
  execution?: ComposerExecutionState
  canSend: boolean
}
export const newTitle: Copy = { "zh-CN": "新会话", en: "New session" }
