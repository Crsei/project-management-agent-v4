import type {
  AttentionRecord,
  ArtifactRecord,
  AgentRunSnapshot,
} from "./agent-board-model"
import type { DataState } from "./runtime-status"
import type { AgentAttachment, ToolDisplay } from "./agent-elements-model"
import type { AgentQuestionRequest } from "./questionnaire-model"

/** Service identities and UI preferences remain separate. No transport or persistence. */
export type ProjectRef = {
  projectId: string
  name: string
  repositoryId: string
  directory?: string
  readOnly?: boolean
}
export type EnvironmentRef = {
  environmentId: string
  name: string
  branch?: string
  worktree?: string
  connection: "connected" | "disconnected" | "unknown"
  capabilities: string[]
}
export type WorkbenchChoice = {
  id: string
  label: string
  disabledReason?: string
  version?: string
  description?: string
}
export type ContextReference = {
  id: string
  kind: "file" | "selection" | "rule" | "skill" | "link" | "image"
  label: string
  source?: string
  version?: string
  range?: { start: number; end: number }
  availability:
    "available" | "uploading" | "failed" | "stale" | "denied" | "unknown"
  included: boolean
  removable: boolean
  reason?: string
  usage?: {
    value: number
    unit: "characters" | "tokens"
    source: string
    estimated: boolean
  }
}
export type DraftState = {
  draftId: string
  version: number
  text: string
  context: ContextReference[]
  modelId: string
  permissionId: string
  environmentId: string
  mode: "send" | "queue" | "steer"
  /** Host-defined agent/plan behavior, independent of delivery and permissions. */
  behaviorMode?: string
}
export type MessagePart = {
  partId: string
  sequence: number
  revision: number
} & (
  | { kind: "text"; text: string }
  | { kind: "code"; text: string; language?: string }
  | { kind: "phase"; phase: "thinking" | "action" | "output"; label: string }
  | { kind: "error"; text: string; title?: string }
  | { kind: "image" | "file"; attachment: AgentAttachment; label: string }
  | {
      kind: "tool" | "artifact" | "plan" | "citation" | "question"
      referenceId: string
      label: string
    }
)
export type WorkbenchMessage = {
  timestamp?: string
  messageId: string
  turnId: string
  role: "user" | "agent" | "system"
  sequence: number
  revision: number
  state:
    | "pending"
    | "streaming"
    | "completed"
    | "interrupted"
    | "failed"
    | "cancelled"
  parts: MessagePart[]
}
export type WorkbenchTool = {
  id: string
  name: string
  status: string
  target?: string
  arguments?: unknown
  output?: unknown
  error?: string
  exitCode?: number
  outputTruncated?: boolean
  outcome?: "known" | "unknown"
  /** Explicit source associations; never inferred from output text. */
  fileIds?: string[]
  changeRevision?: string
  duration?: string
  startedAt?: string
  parentId?: string
  revision?: string
  receipt?: string
  detailsState?: DataState
  display?: ToolDisplay
}
export type ChangeLine = {
  id: string
  kind: "context" | "add" | "remove"
  text: string
  oldLine?: number
  newLine?: number
}
export type ChangedFile = {
  fileId: string
  path: string
  previousPath?: string
  kind: "modified" | "added" | "deleted" | "renamed" | "binary"
  lines: ChangeLine[]
  content?: string
  truncated?: boolean
}
export type ChangeSet = {
  repositoryId: string
  scope: string
  base: string
  head: string
  revision: string
  files: ChangedFile[]
  partial?: boolean
}
export type ReviewComment = {
  repositoryId: string
  base: string
  head: string
  commentId: string
  fileId: string
  lineId: string
  oldLine?: number
  newLine?: number
  revision: string
  text: string
}
export function reviewCommentIsCurrent(
  changes: ChangeSet,
  comment: ReviewComment,
) {
  return (
    comment.repositoryId === changes.repositoryId &&
    comment.base === changes.base &&
    comment.head === changes.head &&
    comment.revision === changes.revision &&
    changes.files.some(
      (file) =>
        file.fileId === comment.fileId &&
        file.lines.some((line) => line.id === comment.lineId),
    )
  )
}
export type OperationReceipt = {
  requestId: string
  targetId: string
  action: string
  state: "pending" | "confirmed" | "failed" | "unknown"
  draftId?: string
  draftVersion?: number
  submittedDraft?: DraftState
  receipt?: string
  reason?: string
}
export const workbenchPanels = [
  "context",
  "files",
  "changes",
  "artifacts",
  "plan",
  "activity",
  "terminal",
  "preview",
  "git",
  "pr",
  "notes",
  "browser",
  "editor",
] as const
export type WorkbenchPanelId = (typeof workbenchPanels)[number]
export type PanelState = {
  activePanel: WorkbenchPanelId
  selectedFileId?: string
  sidebarCollapsed: boolean
  inspectorOpen: boolean
  bottomOpen: boolean
  inspectorWidth: number
  bottomHeight: number
  readingMessageId?: string
  reviewSplit?: number
}
export type SessionSnapshot = {
  sessionId: string
  projectId: string
  threadId?: string
  source: string
  agent: { id: string; name: string }
  title: string
  activeRunId: string
  revision: number
  cursor: number
  status: string
  updatedAt: string
  favorite?: boolean
  archived?: boolean
  unread?: boolean
  environment: EnvironmentRef
  capabilities: {
    send: boolean
    queue: boolean
    steer: boolean
    interrupt: boolean
    contextLimit?: number
  }
  contextSources: ContextReference[]
  messages: WorkbenchMessage[]
  questions?: readonly AgentQuestionRequest[]
  history: { hasMore: boolean; cursor?: string; loading?: boolean }
  tools: WorkbenchTool[]
  attention: AttentionRecord[]
  artifacts: ArtifactRecord[]
  changes: ChangeSet
  plan: { id: string; title: string; status: string; toolId?: string }[]
  output: {
    text: string
    source: string
    timestamp: string
    truncated?: boolean
  }
  dataState: DataState
  error?: string
}
export type WorkbenchState = {
  projects: ProjectRef[]
  sessions: SessionSnapshot[]
  drafts: Record<string, DraftState>
  receipts: OperationReceipt[]
  panels: PanelState
}
export function activeReceipt(
  receipts: readonly OperationReceipt[],
  targetId: string,
) {
  return receipts.find(
    (r) =>
      r.targetId === targetId &&
      (r.state === "pending" || r.state === "unknown"),
  )
}
export function draftCanSubmit(
  session: SessionSnapshot,
  draft: DraftState,
  receipts: readonly OperationReceipt[],
) {
  const tokenUsage = draft.context
    .filter((r) => r.included && r.usage?.unit === "tokens")
    .reduce((sum, r) => sum + (r.usage?.value ?? 0), 0)
  const withinLimit =
    session.capabilities.contextLimit === undefined ||
    tokenUsage <= session.capabilities.contextLimit
  const running = ["running", "thinking", "queued", "waiting"].includes(
    session.status,
  )
  return Boolean(
    withinLimit &&
    draft.text.trim() &&
    session.environment.connection === "connected" &&
    session.capabilities[draft.mode] &&
    !(draft.mode === "send" && running) &&
    !activeReceipt(receipts, session.sessionId) &&
    draft.context.every((r) => !r.included || r.availability === "available"),
  )
}
/** Apply contiguous source order. A gap is retained for caller replay; duplicates and other objects are rejected. */
export function applySessionEvent(
  session: SessionSnapshot,
  event: { sessionId: string; cursor: number; message: WorkbenchMessage },
): SessionSnapshot {
  if (
    event.sessionId !== session.sessionId ||
    event.cursor !== session.cursor + 1
  )
    return session
  const previous = session.messages.find(
    (m) => m.messageId === event.message.messageId,
  )
  if (previous && previous.revision >= event.message.revision)
    return { ...session, cursor: event.cursor }
  const parts = new Map<string, MessagePart>()
  for (const part of event.message.parts) {
    const before = parts.get(part.partId)
    if (!before || part.revision > before.revision) parts.set(part.partId, part)
  }
  const uniqueParts = [...parts.values()].sort(
    (a, b) => a.sequence - b.sequence,
  )
  return {
    ...session,
    cursor: event.cursor,
    revision: session.revision + 1,
    messages: [
      ...session.messages.filter(
        (m) => m.messageId !== event.message.messageId,
      ),
      { ...event.message, parts: uniqueParts },
    ].sort((a, b) => a.sequence - b.sequence),
  }
}
/** Clear only the submitted version after source acknowledgement. */
export function acknowledgeDraft(
  draft: DraftState,
  receipt: OperationReceipt,
): DraftState {
  return receipt.state === "confirmed" &&
    (receipt.draftId ?? receipt.submittedDraft?.draftId) === draft.draftId &&
    receipt.draftVersion === draft.version
    ? { ...draft, text: "", context: [], version: draft.version + 1 }
    : draft
}
export function sessionRun(session: SessionSnapshot): AgentRunSnapshot {
  return {
    runId: session.activeRunId,
    title: session.title,
    agentId: session.agent.id,
    agentName: session.agent.name,
    sessionId: session.sessionId,
    sessionTitle: session.title,
    runtimeStatus: session.status,
    updatedAt: session.updatedAt,
    revision: session.revision,
    source: session.source,
    completeness: session.dataState === "partial" ? "partial" : "complete",
    toolCount: session.tools.length,
    artifactCount: session.artifacts.length,
  }
}
export const workbenchRegions = [
  "sidebar",
  "context",
  "conversation",
  "composer",
  "header",
  "tools",
  "files",
  "output",
  "artifacts",
  "settings",
] as const
export const workbenchLayouts = ["conversation", "review", "tasks"] as const
export const workbenchTemplates = ["coding", "artifacts", "console"] as const
export const workbenchPages = [
  "home",
  "new",
  "session",
  "review",
  "inbox",
  "project",
  "artifacts",
  "settings",
] as const
export const workbenchScenarios = [
  "default",
  "loading",
  "empty",
  "partial",
  "error",
  "long",
  "unknown",
  "disconnected",
  "limited",
] as const
export type WorkbenchLayout = (typeof workbenchLayouts)[number]
export function parseWorkbenchQuery(
  query: URLSearchParams,
  sessionIds: readonly string[],
) {
  const fields = {
    region: workbenchRegions,
    layout: workbenchLayouts,
    template: workbenchTemplates,
    page: workbenchPages,
    panel: workbenchPanels,
    scenario: workbenchScenarios,
  } as const
  const defaults = {
    region: "sidebar",
    layout: "conversation",
    template: "coding",
    page: "home",
    panel: "context",
    scenario: "default",
  }
  const errors: string[] = []
  const result = {
    ...defaults,
    session: query.get("session") ?? sessionIds[0] ?? "",
  }
  for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
    const value = query.get(key)
    if (value && !(fields[key] as readonly string[]).includes(value))
      errors.push(key)
    else if (value) result[key] = value
  }
  if (result.session && !sessionIds.includes(result.session))
    errors.push("session")
  return { ...result, errors }
}
