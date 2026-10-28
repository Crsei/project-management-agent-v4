import type { ImportCandidate, WorkspaceCommand } from "./commands.ts"
import type {
  ServerWorkspaceRecord, WorkspaceApproval, WorkspaceMessage, WorkspaceMessagePart,
  WorkspaceQuestion, WorkspaceResource, WorkspaceRun, WorkspaceSession, WorkspaceSettings, WorkspaceSkill,
} from "./entities.ts"
import type { EngineIdentity, EngineReference, WorkspaceCapabilities, WorkspaceError } from "./primitives.ts"
import type { EngineOperationLink, OperationEvidence, ServerOperationRecord } from "./operations.ts"

export type RuntimeCommand = Extract<WorkspaceCommand, { action: "create" | "send" | "steer" | "interrupt" | "approval" | "answer" | "import" | "update-settings" }>
export type RuntimeStatus = {
  status: "starting" | "ready" | "unavailable"
  authentication: "authenticated" | "required" | "unavailable"
  source: EngineIdentity
  version: string
  error: WorkspaceError | null
}
export type RuntimeExecutionContext = {
  // Host-resolved records, not client-provided owner/cwd/thread identities.
  workspace: ServerWorkspaceRecord
  session: WorkspaceSession | null
  run: WorkspaceRun | null
  approval: WorkspaceApproval | null
  question: WorkspaceQuestion | null
  settings: WorkspaceSettings | null
  // Host-resolved bytes/context only; never accept these paths from a browser command.
  preparedInput?: Array<{ type: "text"; text: string } | { type: "localImage"; path: string }>
  importCandidate: ImportCandidate | null
  operation: ServerOperationRecord
  // Stable persisted ID mapping supplied by the Host; never SDK optimistic IDs as product cursors.
  resolveProductId(kind: "session" | "run" | "message" | "part" | "approval" | "question" | "resource", sourceId: string): string
}
export type RuntimeDispatchResult =
  | { kind: "submitted"; link: EngineOperationLink }
  | { kind: "source-accepted"; evidence: Extract<OperationEvidence, { kind: "source-accepted" }> }
  | { kind: "source-rejected"; evidence: Extract<OperationEvidence, { kind: "source-rejected" }> }
  | { kind: "unknown"; error: WorkspaceError }
export type RuntimeReconciliationResult =
  | { kind: "evidenced"; evidence: Exclude<OperationEvidence, { kind: "prepared" | "dispatched" | "host-committed" | "host-rejected" }> }
  | { kind: "unresolved"; error: WorkspaceError }
export type RuntimeSessionRead = {
  session: WorkspaceSession
  messages: WorkspaceMessage[]
  runs: WorkspaceRun[]
  approvals: WorkspaceApproval[]
  questions: WorkspaceQuestion[]
  nextCursor: string | null
}
export type RuntimeFact = {
  source: EngineIdentity
  workspaceId: string
  sessionId: string
  observedAt: string
} & (
  | { type: "message"; message: WorkspaceMessage }
  | { type: "part"; messageId: string; part: WorkspaceMessagePart }
  | { type: "run"; run: WorkspaceRun }
  | { type: "approval"; approval: WorkspaceApproval }
  | { type: "question"; question: WorkspaceQuestion }
  | { type: "resource"; resource: WorkspaceResource }
  | { type: "settings"; settings: WorkspaceSettings }
  | { type: "operation-evidence"; operationId: string; evidence: OperationEvidence }
  | { type: "source-exited"; error: WorkspaceError }
)

// No Node, React, SDK, credential, arbitrary command, or JSON-RPC dependency leaks through this interface.
// Implementations belong to the server. Facts are not durable product events until the Host commits them.
export interface RuntimeAdapter {
  readonly adapter: string
  start(workspace: ServerWorkspaceRecord): Promise<RuntimeStatus>
  status(workspaceId: string): Promise<RuntimeStatus>
  capabilities(workspaceId: string): Promise<WorkspaceCapabilities>
  listImportCandidates(workspace: ServerWorkspaceRecord): Promise<ImportCandidate[]>
  readSession(source: EngineReference, context: RuntimeExecutionContext, page: { cursor: string | null; limit: number }): Promise<RuntimeSessionRead>
  resumeSession(source: EngineReference, context: RuntimeExecutionContext): Promise<RuntimeSessionRead>
  readSettings?(source: EngineReference, workspace: ServerWorkspaceRecord): Promise<WorkspaceSettings | null>
  listSkills?(workspace: ServerWorkspaceRecord): Promise<WorkspaceSkill[]>
  readSkill?(workspace: ServerWorkspaceRecord, skillId: string): Promise<WorkspaceSkill & { content: string }>
  // Only after Host writes prepared/dispatched evidence. Local SDK action completion is not source acceptance.
  dispatch(command: RuntimeCommand, context: RuntimeExecutionContext): Promise<RuntimeDispatchResult>
  // Must not execute/replay the stored operation while looking for evidence.
  reconcile(operation: ServerOperationRecord, context: RuntimeExecutionContext): Promise<RuntimeReconciliationResult>
  // Releasing browser subscribers is not interrupt; Host owns the Adapter's independent lifetime.
  subscribe(workspaceId: string, observer: (fact: RuntimeFact) => void): () => void
  close(workspaceId: string): Promise<void>
}
