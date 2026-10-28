import type { DataState } from "./runtime-status"

/** Display snapshots only. Services own authority, storage and execution. */
export type RunStage = {
  name?: string
  completedSteps?: number
  totalSteps?: number
  planVersion?: string
  durationMs?: number
  waitingReason?: string
}
export type ReviewSnapshot = {
  state: "unreviewed" | "changes-requested" | "approved" | "unknown"
  acceptance: "pending" | "accepted" | "rejected" | "unknown"
  evidence?: string
  pr?: { state: "created" | "merged" | "closed"; href: string }
}
export type AgentRunSnapshot = {
  runId: string
  title: string
  agentId: string
  agentName: string
  agentStatus?: string
  model?: string
  sessionId?: string
  sessionTitle?: string
  sessionHref?: string
  workItemRef?: { id: string; title: string; href?: string; state?: string }
  attempt?: number
  previousRunId?: string
  parentRunId?: string
  runtimeStatus: string
  stage?: RunStage
  queuedAt?: string
  startedAt?: string
  endedAt?: string
  updatedAt: string
  revision: number
  source: string
  completeness: "complete" | "partial"
  error?: string
  artifactCount?: number
  toolCount?: number
  review?: ReviewSnapshot
}
export type AttentionAction =
  "accept" | "reject" | "edit" | "respond" | "ignore"
export type ActionReceipt = {
  outcome: "confirmed" | "rejected" | "unknown"
  message?: string
}
export type AttentionRecord = {
  attentionId: string
  runId: string
  revision: number
  kind: "approval" | "input" | "failure" | "unknown" | "disconnect"
  title: string
  reason: string
  target?: string
  parameters?: unknown
  scope?: string
  risk?: string
  deadline?: string
  expired?: boolean
  allowedActions: AttentionAction[]
  disabledReason?: string
  operation?: {
    state: "pending" | "confirmed" | "rejected" | "unknown"
    message?: string
  }
  tool?: {
    status?: string
    id: string
    name: string
    arguments?: unknown
    output?: unknown
  }
}
export type AttentionIntent = {
  attentionId: string
  runId: string
  baseRevision: number
  operationId: string
  action: AttentionAction | "reconcile"
  response?: string
}
export type AgentBoardCapabilities = {
  onAttentionAction?: (intent: AttentionIntent) => Promise<ActionReceipt>
  onReconcile?: (intent: AttentionIntent) => Promise<ActionReceipt>
}
export type ArtifactRecord = {
  artifactId: string
  /** Optional host resource identity for a typed preview adapter. */
  resourceId?: string
  runId: string
  name: string
  kind: string
  createdAt?: string
  href?: string
  availability: "available" | "removed" | "unavailable"
  review: ReviewSnapshot
}
export type TraceStep = {
  stepId: string
  parentStepId?: string
  name: string
  status: string
  summary?: string
  tool?: {
    status?: string
    id: string
    name: string
    arguments?: unknown
    output?: unknown
    outcome?: "known" | "unknown"
  }
}
export type RunRelationship = {
  id: string
  sourceRunId: string
  targetRunId: string
  kind: "parent" | "child" | "handoff"
  label: string
}
export type UsageObservation = {
  observationId: string
  runId: string
  timestamp: string
  tokens?: number
  cost?: number
  currency?: string
  durationMs?: number
  estimated?: boolean
  includesRunIds?: string[]
  inclusion: "exclusive" | "inclusive" | "unknown"
}
export type AgentBoardViewState = {
  view: "board" | "list" | "inbox" | "insights" | "dependencies"
  query: string
  agentId: string
  model: string
  status: string
  workItemId: string
  inboxKind: string
}
export type AgentBoardConnection = {
  state: "connected" | "disconnected"
  updatedAt: string
}
export type RunCollectionData = {
  state: DataState
  totalCount?: number
  loadedCount?: number
}
export const defaultAgentBoardView: AgentBoardViewState = {
  view: "board",
  query: "",
  agentId: "",
  model: "",
  status: "",
  workItemId: "",
  inboxKind: "",
}

/** Explicit service-reported dependency. Runtime does not determine whether it is satisfied. */
export type AgentRunDependency = {
  dependencyId: string
  revision: number
  prerequisiteRunId: string
  dependentRunId: string
  label: string
  state: "blocked" | "satisfied" | "unknown"
}
export type AgentUsageMetric = "tokens" | "cost" | "durationMs"
/** One source-reported interval observation, not a cumulative counter or interpolated sample. */
export type AgentUsageHistoryPoint = {
  pointId: string
  revision: number
  runId: string
  timestamp: string
  intervalStart: string
  metric: AgentUsageMetric
  value?: number
  currency?: string
  estimated?: boolean
}
