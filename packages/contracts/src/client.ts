// Browser/Node fetch client. Never imports server modules.
import type { PersonalDashboard } from '../../domain/src/dashboard-personal.ts';
import type { TimeDashboard } from '../../domain/src/dashboard-time.ts';
import type { SprintsDashboard } from '../../domain/src/dashboard-sprints.ts';
import type { PortfolioDashboard } from '../../domain/src/dashboard-portfolio.ts';
import type { PlanningDashboard } from '../../domain/src/dashboard-planning.ts';
import type { ProjectExtras } from '../../domain/src/project-extras.ts';
import type { ProjectDirectory } from '../../domain/src/project-directory.ts';
import type { ProjectAuditOptions, ProjectAuditPage } from '../../domain/src/project-audit.ts';
import type { MemberDirectory } from '../../domain/src/members.ts';
import type { InvitationListDto, InvitationInspectDto, InvitationAcceptPayload, InvitationAcceptDto, InvitationReceiptDto } from '../../domain/src/invitations.ts';
import type { TeamDirectory } from '../../domain/src/team-directory.ts';
import type { TeamWorkload } from '../../domain/src/team-workload.ts';
import type { CoreCreationAttempt } from './core-creation.ts';
import type { WorkspaceIdentity, WorkspaceIcon, WorkspaceColor } from '../../domain/src/workspace-identity.ts';
import type { TaskCommentsPage, TaskCommentHistoryPage, TaskCommentsOptions, TaskCommentHistoryOptions } from '../../domain/src/task-comments.ts';
import type { AccountSecurity, AccountSecurityAction, AccountSecurityActionKind, AccountSecurityActionLookup, ChangeOwnPassword, RevokeOwnSessions } from './account-security.ts';
import type { NotificationInboxOptions, NotificationInboxPage, MentionCandidatesPage } from './notifications.ts';
import type { ArtifactVisibility, ArtifactCopyOriginResponse } from './artifact-files.ts';
import type { WebhookOverview, WebhookDeliveryPage, WebhookDeliveryDetail } from '../../domain/src/webhooks.ts';
import { AccountRecoveryClient } from './account-recovery-client.ts';
import { createLocalProjectClient } from './local-project-client.ts';
import { agentChatAccessSchema, agentChatContextSourceSchema, agentChatToolCallSchema, type AgentChatAccess, type AgentChatAccessInput, type AgentChatMessage, type AgentChatReasoningEffort, type AgentChatStatus, type AgentChatStreamEvent, type AgentChatThreadDetail, type AgentChatThreadList } from './agent-chat.ts';
export type { DashboardRecord } from '../../domain/src/dashboard.ts';
export type { PersonalDashboard, SelfProfile, PrivateNote, PrivateNoteData, TaskWatch, TaskWatchData, ProjectMeeting, ProjectMeetingData, MeetingParticipant } from '../../domain/src/dashboard-personal.ts';
export type { TimeDashboard, TimeTimer, TimeWorklog, TimeTotals, TimePeriodTotal, TimeTaskReference, PresencePreference, PresenceStatus, PresenceMember, PresenceSelf, TimerData, WorklogData, PresencePreferenceData, PresenceHeartbeatData } from '../../domain/src/dashboard-time.ts';
export type { SprintsDashboard, SprintSummary, SprintTask, SprintDashboardObservation, SprintProgressPoint } from '../../domain/src/dashboard-sprints.ts';
export type { PortfolioDashboard, PortfolioProject, PortfolioBudgetView, PortfolioSpendView, PortfolioCurrencyTotal, PortfolioRisk, ProjectHealthStatus, ProjectDeliveryConfidence, ProjectHealthAssessment, ProjectBudget, ProjectSpend, ProjectSpendVoid, ProjectFinancialSnapshot, ProjectHealthCommandResult, ProjectBudgetCommandResult } from '../../domain/src/dashboard-portfolio.ts';
export type { PlanningDashboard, PlanningProject, PlanningTask, PlanningMilestone, CriticalPathAnalysis, CriticalPathTask, PlanningUnavailableReason, PlanningUnavailableCode } from '../../domain/src/dashboard-planning.ts';
export type { ProjectExtras, ProjectExtrasProject, ProjectFavoriteData, ProjectFavorite, ProjectCoverMediaType, ProjectCoverData, ProjectCover, ProjectScopeItem, ProjectScopeData, ProjectScope, ProjectSidebarOrderData, ProjectSidebarOrder } from '../../domain/src/project-extras.ts';
export type { ProjectDirectory, ProjectIdentity, ProjectDirectoryVersion, ProjectTeam, ProjectTeamAssignment, ProjectTeamFragment, ProjectDirectoryProject, ProjectDirectoryManagement } from '../../domain/src/project-directory.ts';
export type { ProjectAuditOptions, ProjectAuditPage, ProjectAuditEntry, ProjectAuditChange, ProjectAuditValue } from '../../domain/src/project-audit.ts';
export type { MemberDirectory, MemberDirectoryMember, MemberDirectoryAccess, MemberDirectoryTeam, MemberRole, MemberDirectoryRole } from '../../domain/src/members.ts';
export type { MemberInvitationDto, InvitationListDto, InvitationInspectDto, InvitationAcceptPayload, InvitationAcceptDto, InvitationReceiptDto, InvitationStatus, InvitationDeliveryStatus, InvitationFailureCode } from '../../domain/src/invitations.ts';
export type { TeamDirectory, TeamDirectoryTeam, TeamDirectoryProject } from '../../domain/src/team-directory.ts';
export type { TeamWorkload, TeamWorkloadCapacity, TeamWorkloadMemberScope, TeamWorkloadMember, TeamWorkloadTask, TeamWorkloadTeam, TeamWorkloadSummary, MemberCapacity, MemberCapacityData } from '../../domain/src/team-workload.ts';
export type { CoreCreationAttempt } from './core-creation.ts';
export type { WorkspaceIdentity, WorkspaceIcon, WorkspaceColor } from '../../domain/src/workspace-identity.ts';
export type { TaskComment, TaskCommentRevision, TaskCommentsPage, TaskCommentHistoryPage, TaskCommentsOptions, TaskCommentHistoryOptions } from '../../domain/src/task-comments.ts';
export type { AccountSecurity, AccountSession, AccountSecurityAction, AccountSecurityActionKind, AccountSecurityActionLookup, AccountSecurityErrorCode, ChangeOwnPassword, RevokeOwnSessions } from './account-security.ts';
export type { NotificationState, NotificationReason, NotificationOrigin, NotificationInboxItem, NotificationInboxOptions, NotificationInboxPage, MentionCandidatesPage } from './notifications.ts';
export type { ArtifactVisibility, ArtifactCopyOrigin, ArtifactCopyOriginResponse } from './artifact-files.ts';
export type { WebhookOverview, WebhookTargetDto, WebhookEndpointDto, WebhookDeliveryDto, WebhookDeliveryPage, WebhookDeliveryDetail } from '../../domain/src/webhooks.ts';
export type { LocalDirectory, LocalProjectInitialization, LocalProjectSettings, LocalProjectDirectoryListing, LocalProjectPreview, LocalProjectLocation, LocalProjectAttempt } from './local-projects.ts';
export type { AgentChatMessage, AgentChatMessageRole, AgentChatMessageStatus, AgentChatThread, AgentChatThreadList, AgentChatThreadDetail, AgentChatStatus, AgentChatReasoningEffort, AgentChatStreamEvent, AgentChatAccess, AgentChatAccessInput, AgentChatScope, AgentChatToolCapability, AgentChatContextSource, AgentChatToolCall, AgentChatToolResult, AgentChatToolEntity, AgentChatToolComment, AgentChatToolRelation, AgentChatToolReceipt } from './agent-chat.ts';
// BEGIN GENERATED COMMAND PAYLOAD TYPES
export type CommandPayloadMap = {
  AcceptIntent: { "revision": number; "reason": string; "basisRefs"?: Array<{ "kind": "project" | "work_item" | "milestone" | "conversation" | "intent" | "decision" | "upload" | "artifact" | "artifact_version" | "evidence" | "submission" | "review"; "id": string; }>; };
  AchieveMilestone: { "reason": string; "criteriaChecks": Array<{ "criterionIndex": number; "explanation": string; }>; };
  ActivateProject: Record<string, never>;
  AddArtifactVersion: { "uploadId": string; "sourceRunId"?: null; };
  AddDependency: { "prerequisiteId": string; };
  AppendMessage: { "content": string; };
  ArchiveObject: { "kind": "project" | "work_item"; "reason": string; };
  ArchiveProjectTeam: Record<string, never>;
  ArchiveSprint: { "sprintId": string; };
  AssignMilestone: { "milestoneId": string; };
  CancelMilestone: { "reason": string; };
  CancelProject: { "reason": string; };
  CancelProjectMeeting: { "reason": string; };
  CancelSprint: { "sprintId": string; };
  CancelWorkItem: { "reason": string; };
  CompletePrivateNote: Record<string, never>;
  CompleteProject: { "reason": string; "criteriaChecks": Array<{ "criterionIndex": number; "explanation": string; }>; };
  CompleteSprint: { "sprintId": string; };
  CompleteWorkItem: { "submissionId"?: string; "reviewId"?: string; };
  CopyArtifactVersion: { "targetTitle": string; "targetKind": string; };
  CorrectProjectSpend: { "spendId": string; "reason": string; "currency": string; "amountMinor": number; "spentOn": string; "description": string; };
  CreateConversation: { "title": string; };
  CreateMemberInvitation: { "email": string; "role": "admin" | "member" | "guest"; "projectIds": (Array<string>) | (null); };
  CreateMilestone: { "title": string; "criteria": Array<string>; "targetDate"?: (string) | (null); };
  CreatePrivateNote: { "content": string; };
  CreateProject: { "name": string; "goal": string; "ownerId": (string) | (null); "completionCriteria": Array<string>; "localDirectory"?: ({ "mode": "existing"; "path": string; }) | ({ "mode": "new"; "parentPath": string; "folderName": string; }); "startDate"?: string; "dueDate"?: string; "description"?: string; };
  CreateProjectMeeting: { "title": string; "description": string; "startsAt": string; "endsAt": string; "participantIds": Array<string>; };
  CreateProjectTeam: { "name": string; "memberIds"?: Array<string>; "maintainerIds"?: Array<string>; "identifier"?: (string) | (null); "description"?: string; "focus"?: (string) | (null); "responseTargetHours"?: (number) | (null); };
  CreateSprint: { "projectId": string; "title": string; "startDate"?: (string) | (null); "dueDate"?: (string) | (null); };
  CreateTaskComment: { "content": string; };
  CreateWebhookEndpoint: { "targetKey": string; "projectIds": Array<string>; "eventTypes": Array<"pm.project.changed.v1" | "pm.task.changed.v1" | "pm.milestone.changed.v1">; };
  CreateWorkItem: { "title": string; "description": string; "acceptanceCriteria": Array<{ "id": (string) | (string); "text": string; }>; "assigneeId"?: (string) | (null); "priority"?: ("low" | "normal" | "high" | "urgent") | (null); "startDate"?: (string) | (null); "dueDate"?: (string) | (null); "labels"?: Array<string>; "kind"?: "epic" | "task" | "bug" | "subtask"; "parentId"?: (string) | (null); "estimatePoints"?: (number) | (null); "location"?: (string) | (null); };
  CreateWorkItemFromIntent: { "title": string; "description": string; "acceptanceCriteria": Array<{ "id": (string) | (string); "text": string; }>; "assigneeId"?: (string) | (null); "priority"?: ("low" | "normal" | "high" | "urgent") | (null); "startDate"?: (string) | (null); "dueDate"?: (string) | (null); "labels"?: Array<string>; "kind"?: "epic" | "task" | "bug" | "subtask"; "parentId"?: (string) | (null); "estimatePoints"?: (number) | (null); "location"?: (string) | (null); "intentId": string; "acceptedRevision": number; "decisionId": string; };
  DeleteObject: { "kind": "project" | "work_item"; };
  DeletePrivateNote: Record<string, never>;
  DeleteTaskComment: { "commentId": string; };
  DuplicateProject: { "name": string; "includeTasks": boolean; "localDirectory"?: ({ "mode": "existing"; "path": string; }) | ({ "mode": "new"; "parentPath": string; "folderName": string; }); };
  HeartbeatPresence: Record<string, never>;
  HideArtifact: Record<string, never>;
  ProposeIntent: { "summary": string; "goal": string; "conversationId"?: (string) | (null); "sourceMessageRefs"?: Array<{ "messageId": string; "contentVersion": number; }>; };
  ReadyWorkItem: Record<string, never>;
  ReauthorizeWebhookEndpoint: Record<string, never>;
  ReconcileWebhookDelivery: Record<string, never>;
  RecordDecision: { "subjectRef": { "kind": "project" | "work_item" | "milestone" | "conversation" | "intent" | "decision" | "upload" | "artifact" | "artifact_version" | "evidence" | "submission" | "review"; "id": string; }; "decisionType": "note" | "supersede"; "reason": string; "basisRefs"?: Array<{ "kind": "project" | "work_item" | "milestone" | "conversation" | "intent" | "decision" | "upload" | "artifact" | "artifact_version" | "evidence" | "submission" | "review"; "id": string; }>; "supersedesDecisionId"?: (string) | (null); };
  RecordEvidence: { "subjectRefs": Array<string>; "method": string; "scope": string; "result": "pass" | "fail" | "inconclusive"; "observedAt": string; "artifactVersionRefs": Array<string>; "sourceRunId"?: null; };
  RecordManualWorklog: { "taskId": string; "startedAt": string; "endedAt": string; "note"?: string; };
  RecordProjectSpend: { "currency": string; "amountMinor": number; "spentOn": string; "description": string; };
  RecordReview: { "criterionResults": Array<{ "criterionId": string; "result": "pass" | "fail" | "inconclusive"; "basisRefs": Array<string>; "explanation": string; }>; "verdict": "passed" | "changes_requested"; "reason": string; };
  RegisterArtifact: { "title": string; "kind": string; "uploadId": string; "sourceRunId"?: null; };
  RejectIntent: { "revision": number; "reason": string; "basisRefs"?: Array<{ "kind": "project" | "work_item" | "milestone" | "conversation" | "intent" | "decision" | "upload" | "artifact" | "artifact_version" | "evidence" | "submission" | "review"; "id": string; }>; };
  RemoveDependency: { "prerequisiteId": string; };
  RenameArtifact: { "title": string; };
  RenameProjectTeam: { "name": string; };
  ReopenMilestone: { "reason": string; };
  ReopenPrivateNote: Record<string, never>;
  ReopenProject: { "reason": string; "definition"?: { "goal": string; "ownerId": string; "completionCriteria": Array<string>; }; };
  ReopenSprint: { "sprintId": string; };
  ReopenWorkItem: { "reason": string; };
  ResendMemberInvitation: Record<string, never>;
  RestoreArchivedObject: { "kind": "project" | "work_item"; "reason": string; };
  RestoreArtifact: Record<string, never>;
  RestoreSprint: { "sprintId": string; };
  RestoreTaskComment: { "commentId": string; };
  ResumeWebhookDelivery: { "receiptId": string; };
  ReturnWorkItemForChanges: { "reason": string; "reviewId"?: string; };
  ReviseIntent: { "summary": string; "goal": string; "conversationId"?: (string) | (null); "sourceMessageRefs"?: Array<{ "messageId": string; "contentVersion": number; }>; "revision": number; };
  RevokeMemberInvitation: Record<string, never>;
  RevokeWorkspaceMember: { "userId": string; };
  SetMemberCapacity: { "userId": string; "capacityPoints": (number) | (null); };
  SetMemberRole: { "userId": string; "role": "admin" | "member" | "guest"; "projectIds": (Array<string>) | (null); };
  SetNotificationArchived: { "archived": boolean; };
  SetNotificationRead: { "read": boolean; };
  SetPresencePreference: { "preference": "online" | "away"; };
  SetProjectBudget: { "currency": string; "budgetMinor": number; "remainingEstimateMinor": number; "asOfDate": string; "reason": string; };
  SetProjectCover: { "artifactVersionId": (string) | (null); };
  SetProjectDependencies: { "dependsOn": Array<string>; };
  SetProjectFavorite: { "favorite": boolean; };
  SetProjectHealth: { "status": "on_track" | "at_risk" | "off_track"; "confidence"?: ("high" | "medium" | "low") | (null); "rationale": string; "risks": Array<{ "description": string; "severity": "low" | "medium" | "high"; "mitigation": string; }>; };
  SetProjectRemainingEstimate: { "remainingEstimateMinor": number; "asOfDate": string; "reason": string; };
  SetProjectScope: { "items": Array<{ "id": string; "text": string; "completed": boolean; }>; };
  SetProjectSidebarOrder: { "projectIds": Array<string>; };
  SetProjectTeamMaintainers: { "maintainerIds": Array<string>; };
  SetProjectTeamMembers: { "memberIds": Array<string>; };
  SetProjectTeams: { "teamIds": Array<string>; };
  SetTaskSprint: { "workItemId": string; "sprintId": (string) | (null); };
  SetWebhookEndpointSigningKey: { "keyId": string; };
  SetWebhookEndpointState: { "state": "enabled" | "paused" | "retired"; };
  SetWorkItemBlockers: { "manualBlockReasons": Array<string>; };
  SetWorkspaceMember: { "userId": string; "capabilities": Array<"domain.read" | "directory.read" | "audit.read" | "intent.propose" | "intent.decide" | "planning.edit" | "planning.lifecycle" | "workitem.cancel_reopen" | "delivery.write" | "delivery.submit" | "delivery.review" | "workitem.complete" | "access.manage">; "projectIds": (Array<string>) | (null); };
  StageUpload: { "contentBase64": string; "fileName": string; "mediaType": string; };
  StartSprint: { "sprintId": string; };
  StartTimer: { "taskId": string; "note"?: string; };
  StartWorkItem: Record<string, never>;
  StopTimer: Record<string, never>;
  SubmitWorkItemResult: { "contentRevision": number; "artifactVersionIds": Array<string>; "evidenceIds": Array<string>; };
  UnassignMilestone: { "milestoneId": string; };
  UnwatchTask: Record<string, never>;
  UpdateMilestone: { "name"?: string; "targetDate"?: (string) | (null); "criteria"?: Array<string>; };
  UpdatePrivateNote: { "content": string; };
  UpdateProject: { "name": string; "goal": string; "ownerId": (string) | (null); "completionCriteria": Array<string>; "description"?: string; "dueDate"?: (string) | (null); "icon"?: (string) | (null); "color"?: (string) | (null); };
  UpdateProjectMeeting: { "title": string; "description": string; "startsAt": string; "endsAt": string; "participantIds": Array<string>; };
  UpdateProjectTeamDetails: { "name": string; "identifier": (string) | (null); "description": string; "focus": (string) | (null); "responseTargetHours": (number) | (null); };
  UpdateSelfProfile: { "name"?: string; "timeZone"?: string; "jobTitle"?: (string) | (null); "phone"?: (string) | (null); "avatarDataUrl"?: (string) | (null); };
  UpdateSprint: { "sprintId": string; "title"?: string; "startDate"?: (string) | (null); "dueDate"?: (string) | (null); };
  UpdateTaskComment: { "commentId": string; "content": string; };
  UpdateTaskDuration: { "estimatedDurationDays": (number) | (null); };
  UpdateWorkItemContent: { "title": string; "description": string; "acceptanceCriteria": Array<{ "id": (string) | (string); "text": string; }>; };
  UpdateWorkItemMetadata: { "assigneeId"?: (string) | (null); "priority"?: ("low" | "normal" | "high" | "urgent") | (null); "startDate"?: (string) | (null); "dueDate"?: (string) | (null); };
  UpdateWorkspaceIdentity: { "name": string; "icon": "building" | "grid" | "briefcase" | "layers" | "rocket" | "globe"; "color": "#2F2E2A" | "#5A67D8" | "#3B82C4" | "#23918A" | "#C54B78" | "#C48A1E"; };
  VoidProjectSpend: { "spendId": string; "reason": string; };
  WatchTask: { "taskId": string; };
  WithdrawIntent: { "reason": string; };
};
// END GENERATED COMMAND PAYLOAD TYPES

export type CommandType = keyof CommandPayloadMap;
export type Command<K extends CommandType = CommandType> = { [P in K]: {
  commandId: string; commandType: P; targetId?: string; projectId?: string;
  expectedVersions?: Record<string, number>; payload: CommandPayloadMap[P];
} }[K];
export type ApiFailure = { error: { code: string; message?: string; details?: unknown }; requestId: string };
export type CommandReceipt =
  | { commandId: string; status: 'committed'; httpStatus: 200; result: unknown }
  | { commandId: string; status: 'rejected'; httpStatus: number; error: { code: string; message: string; details?: unknown } };
export type Actor = { id: string; email: string; name: string };
export type EntityKind = 'project' | 'work_item' | 'milestone' | 'conversation' | 'intent' | 'decision' | 'upload' | 'artifact' | 'artifact_version' | 'evidence' | 'submission' | 'review';
export type Entity = { id: string; workspaceId: string; projectId: string | null; kind: EntityKind; version: number; data: Record<string, unknown>; createdAt: string | null; updatedAt: string | null; createdBy: string };
export type EntityPage = { items: Entity[]; nextCursor: string | null; cursor: string };
export type Workspace = { id: string; name: string; icon: WorkspaceIcon; color: WorkspaceColor; identityVersion: number; ownerId: string; capabilities: string[]; projectIds: string[] | null; version: number; cursor: string };
export type Member = { userId: string; workspaceId: string; capabilities: string[]; projectIds: string[] | null; version: number; revokedAt: string | null; email: string; name: string };
export type ChangeNotification = { eventId: string; eventType: string; workspaceId: string; projectId: string | null; aggregateId: string; aggregateKind: string; aggregateVersion: number; occurredAt: string };
export type Changes = { events: { cursor: string; event: ChangeNotification }[]; cursor: string; head: string };
export type Readiness = { status: 'not_ready'; reason: 'backend_not_initialized' } | { status: 'ready' | 'not_ready'; checks: { database: boolean; storage: boolean; worker: boolean; core: boolean; quarantinedEvents: number } };
export type Capabilities = { stage: 'bootstrap' | 'backend'; business: { enabled: boolean }; database: { enabled: boolean }; storage: { enabled: boolean }; markdownCore: { enabled: boolean }; worker: { enabled: boolean }; realtime: { enabled: boolean }; localProjects: { enabled: boolean }; execution: { enabled: false }; accountRecovery: { request: { enabled: boolean }; verification: { enabled: boolean } } };
export type StreamEvent =
  | { type: 'change'; id: string; event: ChangeNotification }
  | { type: 'checkpoint'; id: string; cursor: string }
  | { type: 'stream_error'; code: string };
export type ClientAuth =
  | { type: 'none' }
  | { type: 'bearer'; token: string | (() => string | Promise<string>) }
  | { type: 'cookie'; credentials: 'same-origin' | 'include'; cookie?: () => string | undefined | Promise<string | undefined>; onSetCookie?: (cookies: readonly string[]) => void };
export type ClientOptions = { baseUrl: string; auth: ClientAuth; fetch?: typeof globalThis.fetch };
export type RequestOptions = { signal?: AbortSignal };
export type StreamOptions = RequestOptions & { after?: string; projectId?: string; lastEventId?: string };

export class ApiError extends Error {
  status: number;
  code: string;
  body: unknown;
  requestId: string | undefined;
  constructor(status: number, body: unknown) {
    const failure = body as Partial<ApiFailure> | undefined;
    const code = failure?.error?.code ?? 'invalid_response';
    super(failure?.error?.message ?? code);
    this.name = 'ApiError'; this.status = status; this.code = code;
    this.body = body; this.requestId = failure?.requestId;
  }
}
export class CommandOutcomeUnknown extends Error {
  commandId: string;
  workspaceId: string;
  constructor(workspaceId: string, commandId: string, cause: unknown) {
    super('Command outcome is unknown; query the original commandId before deciding what to do next.', { cause });
    this.name = 'CommandOutcomeUnknown'; this.workspaceId = workspaceId; this.commandId = commandId;
  }
}
const segment = encodeURIComponent;
function isReceipt(value: unknown): value is CommandReceipt {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<CommandReceipt>;
  return typeof item.commandId === 'string' && typeof item.httpStatus === 'number' && (item.status === 'committed' || item.status === 'rejected');
}
const agentChatContextSourcesSchema = agentChatContextSourceSchema.array();
const agentChatToolCallsSchema = agentChatToolCallSchema.array();
function isAgentChatMessage(value: unknown): value is AgentChatMessage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<AgentChatMessage>;
  return typeof item.id === 'string' && typeof item.threadId === 'string'
    && (item.role === 'user' || item.role === 'assistant')
    && typeof item.content === 'string'
    && (item.status === 'complete' || item.status === 'streaming' || item.status === 'cancelled' || item.status === 'error' || item.status === 'interrupted')
    && (item.errorCode === null || typeof item.errorCode === 'string')
    && (item.model === null || typeof item.model === 'string')
    && typeof item.createdAt === 'string' && typeof item.updatedAt === 'string'
    && (item.toolCalls === undefined || agentChatToolCallsSchema.safeParse(item.toolCalls).success)
    && (item.contextSources === undefined || agentChatContextSourcesSchema.safeParse(item.contextSources).success);
}

export class ProjectManagementClient {
  #baseUrl: URL;
  #auth: ClientAuth;
  #fetch: typeof globalThis.fetch;
  readonly accountRecovery = new AccountRecoveryClient((path, input) => this.#send('POST', path, { signal: AbortSignal.timeout(20_000) }, input));
  readonly localProjects = createLocalProjectClient(async <T>(method: string, path: string, body?: unknown, headers?: Record<string, string>, signal?: AbortSignal): Promise<T> => {
    const queryStart = path.indexOf('?');
    const query = queryStart < 0 ? undefined : Object.fromEntries(new URLSearchParams(path.slice(queryStart + 1)));
    const response = await this.#send(method, queryStart < 0 ? path : path.slice(0, queryStart), signal ? { signal } : {}, body, query, headers);
    const result: unknown = await response.json();
    if (!response.ok) throw new ApiError(response.status, result);
    return result as T;
  });
  constructor(options: ClientOptions) {
    this.#baseUrl = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(this.#baseUrl.protocol) || this.#baseUrl.username || this.#baseUrl.password || this.#baseUrl.search || this.#baseUrl.hash) throw new TypeError('baseUrl must be an HTTP(S) URL without embedded credentials, query or fragment');
    this.#auth = options.auth;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }
  async #send(method: string, path: string, options: RequestOptions = {}, body?: unknown, query: Record<string, string | number | undefined> = {}, extraHeaders: Record<string, string> = {}): Promise<Response> {
    const url = new URL(this.#baseUrl);
    url.pathname = this.#baseUrl.pathname.replace(/\/$/, '') + path;
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    const headers = new Headers({ Accept: 'application/json', ...extraHeaders });
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const auth = this.#auth;
    if (auth.type === 'bearer') headers.set('Authorization', `Bearer ${typeof auth.token === 'function' ? await auth.token() : auth.token}`);
    if (auth.type === 'cookie' && auth.cookie) { const cookie = await auth.cookie(); if (cookie) headers.set('Cookie', cookie); }
    const response = await this.#fetch(url, { method, headers, credentials: auth.type === 'cookie' ? auth.credentials : 'omit', ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(options.signal ? { signal: options.signal } : {}) });
    if (auth.type === 'cookie' && auth.onSetCookie) auth.onSetCookie(response.headers.getSetCookie());
    return response;
  }
  async #json<T>(method: string, path: string, options: RequestOptions = {}, body?: unknown, query?: Record<string, string | number | undefined>, acceptedStatuses: readonly number[] = []): Promise<T> {
    const response = await this.#send(method, path, options, body, query);
    const result: unknown = await response.json();
    if (!response.ok && !acceptedStatuses.includes(response.status)) throw new ApiError(response.status, result);
    return result as T;
  }
  getLiveness(options?: RequestOptions) { return this.#json<{ status: 'alive' }>('GET', '/health/live', options); }
  getReadiness(options?: RequestOptions) { return this.#json<Readiness>('GET', '/health/ready', options, undefined, undefined, [503]); }
  getCapabilities(options?: RequestOptions) { return this.#json<Capabilities>('GET', '/api/v1/capabilities', options); }
  getOpenApi(options?: RequestOptions) { return this.#json<Record<string, unknown>>('GET', '/openapi.json', options); }
  login(credentials: { email: string; password: string }, options?: RequestOptions) { return this.#json<{ actor: Actor; expiresAt: string }>('POST', '/api/v1/auth/login', options, credentials); }
  logout(options?: RequestOptions) { return this.#json<{ loggedOut: true }>('POST', '/api/v1/auth/logout', options); }
  getMe(options?: RequestOptions) { return this.#json<{ actor: Actor }>('GET', '/api/v1/auth/me', options); }
  getAgentChatStatus(workspaceId: string, options?: RequestOptions): Promise<AgentChatStatus> { return this.#json<AgentChatStatus>('GET', `/api/v1/workspaces/${segment(workspaceId)}/agent/status`, options); }
  listAgentThreads(workspaceId: string, options?: RequestOptions): Promise<AgentChatThreadList> { return this.#json<AgentChatThreadList>('GET', `/api/v1/workspaces/${segment(workspaceId)}/agent/threads`, options); }
  createAgentThread(workspaceId: string, input: { id: string; title?: string }, options?: RequestOptions): Promise<{ thread: AgentChatThreadDetail['thread'] }> { return this.#json('POST', `/api/v1/workspaces/${segment(workspaceId)}/agent/threads`, options, input); }
  getAgentThread(workspaceId: string, threadId: string, options?: RequestOptions): Promise<AgentChatThreadDetail> { return this.#json<AgentChatThreadDetail>('GET', `/api/v1/workspaces/${segment(workspaceId)}/agent/threads/${segment(threadId)}`, options); }
  deleteAgentThread(workspaceId: string, threadId: string, options?: RequestOptions): Promise<{ deleted: true }> { return this.#json('DELETE', `/api/v1/workspaces/${segment(workspaceId)}/agent/threads/${segment(threadId)}`, options); }
  cancelAgentThread(workspaceId: string, threadId: string, input: { messageId?: string } = {}, options?: RequestOptions): Promise<{ cancelled: boolean }> { return this.#json('POST', `/api/v1/workspaces/${segment(workspaceId)}/agent/threads/${segment(threadId)}/cancel`, options, input); }
  async getAgentThreadAccess(workspaceId: string, threadId: string, options?: RequestOptions): Promise<AgentChatAccess> {
    const result = agentChatAccessSchema.safeParse(await this.#json('GET', `/api/v1/workspaces/${segment(workspaceId)}/agent/threads/${segment(threadId)}/access`, options));
    if (!result.success) throw new ApiError(502, { error: { code: 'invalid_agent_access_response' } });
    return result.data;
  }
  async setAgentThreadAccess(workspaceId: string, threadId: string, input: AgentChatAccessInput, options?: RequestOptions): Promise<AgentChatAccess> {
    const result = agentChatAccessSchema.safeParse(await this.#json('PUT', `/api/v1/workspaces/${segment(workspaceId)}/agent/threads/${segment(threadId)}/access`, options, input));
    if (!result.success) throw new ApiError(502, { error: { code: 'invalid_agent_access_response' } });
    return result.data;
  }
  getAccountSecurity(options?: RequestOptions): Promise<AccountSecurity> { return this.#json<AccountSecurity>('GET', '/api/v1/auth/security', options); }
  async #securityAction(path: string, input: ChangeOwnPassword | RevokeOwnSessions, kind: AccountSecurityActionKind, options?: RequestOptions): Promise<AccountSecurityAction> {
    const response = await this.#send('POST', path, options, input);
    const result: unknown = await response.json();
    if (result !== null && typeof result === 'object') {
      const action = result as Partial<AccountSecurityAction>;
      if (action.actionId === input.actionId.toLowerCase() && action.kind === kind && action.httpStatus === response.status && ['committed', 'rejected', 'cancelled'].includes(action.status ?? '') && Number.isInteger(action.credentialVersion) && Number.isInteger(action.revokedCount) && typeof action.occurredAt === 'string') return action as AccountSecurityAction;
    }
    throw new ApiError(response.status, result);
  }
  changeOwnPassword(input: ChangeOwnPassword, options?: RequestOptions): Promise<AccountSecurityAction> { return this.#securityAction('/api/v1/auth/security/password', input, 'password_change', options); }
  revokeOwnSessions(input: RevokeOwnSessions, options?: RequestOptions): Promise<AccountSecurityAction> { return this.#securityAction('/api/v1/auth/security/sessions/revoke', input, 'revoke_sessions', options); }
  getAccountSecurityAction(actionId: string, options?: RequestOptions): Promise<AccountSecurityActionLookup> { return this.#json<AccountSecurityActionLookup>('GET', `/api/v1/auth/security/actions/${segment(actionId)}`, options); }
  recoverAccountSecurityAction(actionId: string, input: { kind: AccountSecurityActionKind }, options?: RequestOptions): Promise<AccountSecurityActionLookup> { return this.#json<AccountSecurityActionLookup>('POST', `/api/v1/auth/security/actions/${segment(actionId)}/recover`, options, input); }
  getTaskComments(workspaceId: string, taskId: string, query: TaskCommentsOptions, options?: RequestOptions): Promise<TaskCommentsPage> { return this.#json<TaskCommentsPage>('GET', `/api/v1/workspaces/${segment(workspaceId)}/tasks/${segment(taskId)}/comments`, options, undefined, query); }
  getTaskCommentHistory(workspaceId: string, taskId: string, commentId: string, query: TaskCommentHistoryOptions, options?: RequestOptions): Promise<TaskCommentHistoryPage> { return this.#json<TaskCommentHistoryPage>('GET', `/api/v1/workspaces/${segment(workspaceId)}/tasks/${segment(taskId)}/comments/${segment(commentId)}/history`, options, undefined, query); }
  getNotificationInbox(workspaceId: string, query: NotificationInboxOptions = {}, options?: RequestOptions): Promise<NotificationInboxPage> { return this.#json<NotificationInboxPage>('GET', `/api/v1/workspaces/${segment(workspaceId)}/notification-inbox`, options, undefined, query); }
  getMentionCandidates(workspaceId: string, projectId: string, query: { taskId?: string; q?: string; after?: string; limit?: number } = {}, options?: RequestOptions): Promise<MentionCandidatesPage> {
    const target = query.taskId ? `tasks/${segment(query.taskId)}` : `projects/${segment(projectId)}`;
    return this.#json<MentionCandidatesPage>('GET', `/api/v1/workspaces/${segment(workspaceId)}/${target}/mention-candidates`, options, undefined, { ...(query.taskId ? { projectId } : {}), q: query.q, after: query.after, limit: query.limit });
  }
  getWebhooks(workspaceId: string, options?: RequestOptions): Promise<WebhookOverview> { return this.#json<WebhookOverview>('GET', `/api/v1/workspaces/${segment(workspaceId)}/webhooks`, options); }
  getWebhookDeliveries(workspaceId: string, endpointId: string, query: { cursor?: string; limit?: number } = {}, options?: RequestOptions): Promise<WebhookDeliveryPage> { return this.#json<WebhookDeliveryPage>('GET', `/api/v1/workspaces/${segment(workspaceId)}/webhooks/${segment(endpointId)}/deliveries`, options, undefined, query); }
  getWebhookDelivery(workspaceId: string, deliveryId: string, options?: RequestOptions): Promise<WebhookDeliveryDetail> { return this.#json<WebhookDeliveryDetail>('GET', `/api/v1/workspaces/${segment(workspaceId)}/webhook-deliveries/${segment(deliveryId)}`, options); }
  listWorkspaces(options?: RequestOptions) { return this.#json<{ items: Workspace[] }>('GET', '/api/v1/workspaces', options); }
  getWorkspaceIdentity(workspaceId: string, options?: RequestOptions): Promise<WorkspaceIdentity> { return this.#json<WorkspaceIdentity>('GET', `/api/v1/workspaces/${segment(workspaceId)}/identity`, options); }
  listMembers(workspaceId: string, options?: RequestOptions) { return this.#json<Member[]>('GET', `/api/v1/workspaces/${segment(workspaceId)}/members`, options); }
  getMemberDirectory(workspaceId: string, options?: RequestOptions): Promise<MemberDirectory> { return this.#json<MemberDirectory>('GET', `/api/v1/workspaces/${segment(workspaceId)}/members/directory`, options); }
  listMemberInvitations(workspaceId: string, options?: RequestOptions): Promise<InvitationListDto> { return this.#json<InvitationListDto>('GET', `/api/v1/workspaces/${segment(workspaceId)}/members/invitations`, options); }
  inspectMemberInvitation(input: { token: string }, options?: RequestOptions): Promise<InvitationInspectDto> { return this.#json<InvitationInspectDto>('POST', '/api/v1/invitations/inspect', options, input); }
  acceptMemberInvitation(input: InvitationAcceptPayload, options?: RequestOptions): Promise<InvitationAcceptDto> { return this.#json<InvitationAcceptDto>('POST', '/api/v1/invitations/accept', options, input); }
  getMemberInvitationAcceptance(input: { token: string; commandId: string; password: string }, options?: RequestOptions): Promise<InvitationReceiptDto> { return this.#json<InvitationReceiptDto>('POST', '/api/v1/invitations/receipt', options, input); }
  getPersonalDashboard(workspaceId: string, options?: RequestOptions): Promise<PersonalDashboard> { return this.#json<PersonalDashboard>('GET', `/api/v1/workspaces/${segment(workspaceId)}/dashboard/personal`, options); }
  getTimeDashboard(workspaceId: string, options?: RequestOptions): Promise<TimeDashboard> { return this.#json<TimeDashboard>('GET', `/api/v1/workspaces/${segment(workspaceId)}/dashboard/time`, options); }
  getSprintsDashboard(workspaceId: string, options?: RequestOptions): Promise<SprintsDashboard> { return this.#json<SprintsDashboard>('GET', `/api/v1/workspaces/${segment(workspaceId)}/dashboard/sprints`, options); }
  getPortfolioDashboard(workspaceId: string, options?: RequestOptions): Promise<PortfolioDashboard> { return this.#json<PortfolioDashboard>('GET', `/api/v1/workspaces/${segment(workspaceId)}/dashboard/portfolio`, options); }
  getPlanningDashboard(workspaceId: string, options?: RequestOptions): Promise<PlanningDashboard> { return this.#json<PlanningDashboard>('GET', `/api/v1/workspaces/${segment(workspaceId)}/dashboard/planning`, options); }
  getProjectExtras(workspaceId: string, options?: RequestOptions): Promise<ProjectExtras> { return this.#json<ProjectExtras>('GET', `/api/v1/workspaces/${segment(workspaceId)}/projects/extras`, options); }
  getProjectDirectory(workspaceId: string, options?: RequestOptions): Promise<ProjectDirectory> { return this.#json<ProjectDirectory>('GET', `/api/v1/workspaces/${segment(workspaceId)}/projects/directory`, options); }
  getProjectAudit(workspaceId: string, projectId: string, query: ProjectAuditOptions = {}, options?: RequestOptions): Promise<ProjectAuditPage> { return this.#json<ProjectAuditPage>('GET', `/api/v1/workspaces/${segment(workspaceId)}/projects/${segment(projectId)}/audit`, options, undefined, query); }
  getTeamDirectory(workspaceId: string, options?: RequestOptions): Promise<TeamDirectory> { return this.#json<TeamDirectory>('GET', `/api/v1/workspaces/${segment(workspaceId)}/teams/directory`, options); }
  getTeamWorkload(workspaceId: string, options?: RequestOptions): Promise<TeamWorkload> { return this.#json<TeamWorkload>('GET', `/api/v1/workspaces/${segment(workspaceId)}/teams/workload`, options); }
  getCoreCreationAttempt(workspaceId: string, key: string, options?: RequestOptions): Promise<CoreCreationAttempt> { return this.#json<CoreCreationAttempt>('GET', `/api/v1/workspaces/${segment(workspaceId)}/core/creation-attempts/${segment(key)}`, options); }
  recoverCoreCreationAttempt(workspaceId: string, key: string, options?: RequestOptions): Promise<CoreCreationAttempt> { return this.#json<CoreCreationAttempt>('POST', `/api/v1/workspaces/${segment(workspaceId)}/core/creation-attempts/${segment(key)}/recover`, options, {}); }
  async executeCommand<K extends CommandType>(workspaceId: string, command: Command<K>, options?: RequestOptions): Promise<CommandReceipt> {
    try {
      const response = await this.#send('POST', `/api/v1/workspaces/${segment(workspaceId)}/commands`, options, command);
      const result: unknown = await response.json();
      if (isReceipt(result) && result.commandId.toLowerCase() === command.commandId.toLowerCase()) return result;
      if (response.ok || response.status >= 500) throw new CommandOutcomeUnknown(workspaceId, command.commandId, new ApiError(response.status, result));
      throw new ApiError(response.status, result);
    } catch (error) {
      if (error instanceof ApiError || error instanceof CommandOutcomeUnknown) throw error;
      throw new CommandOutcomeUnknown(workspaceId, command.commandId, error);
    }
  }
  getCommandReceipt(workspaceId: string, commandId: string, options?: RequestOptions) { return this.#json<CommandReceipt>('GET', `/api/v1/workspaces/${segment(workspaceId)}/commands/${segment(commandId)}`, options); }
  async recoverCommand(workspaceId: string, commandId: string, options?: RequestOptions): Promise<CommandReceipt> {
    try {
      const response = await this.#send('POST', `/api/v1/workspaces/${segment(workspaceId)}/commands/${segment(commandId)}/recover`, options, {});
      const result: unknown = await response.json();
      if (isReceipt(result) && result.commandId.toLowerCase() === commandId.toLowerCase()) return result;
      if (response.ok || response.status >= 500) throw new CommandOutcomeUnknown(workspaceId, commandId, new ApiError(response.status, result));
      throw new ApiError(response.status, result);
    } catch (error) {
      if (error instanceof ApiError || error instanceof CommandOutcomeUnknown) throw error;
      throw new CommandOutcomeUnknown(workspaceId, commandId, error);
    }
  }
  listEntities(workspaceId: string, query: { kind: EntityKind; projectId?: string; limit?: number; after?: string; visibility?: ArtifactVisibility }, options?: RequestOptions) { return this.#json<EntityPage>('GET', `/api/v1/workspaces/${segment(workspaceId)}/entities`, options, undefined, query); }
  getArtifactCopyOrigin(workspaceId: string, versionId: string, options?: RequestOptions): Promise<ArtifactCopyOriginResponse> { return this.#json<ArtifactCopyOriginResponse>('GET', `/api/v1/workspaces/${segment(workspaceId)}/artifact-versions/${segment(versionId)}/copy-origin`, options); }
  getEntity(workspaceId: string, id: string, options?: RequestOptions) { return this.#json<Entity>('GET', `/api/v1/workspaces/${segment(workspaceId)}/entities/${segment(id)}`, options); }
  getChanges(workspaceId: string, query: { after?: string; projectId?: string } = {}, options?: RequestOptions) { return this.#json<Changes>('GET', `/api/v1/workspaces/${segment(workspaceId)}/changes`, options, undefined, query); }
  async downloadArtifactVersion(workspaceId: string, versionId: string, options?: RequestOptions): Promise<{ bytes: Uint8Array; etag: string | null; contentDisposition: string | null; mediaType: string | null }> {
    const response = await this.#send('GET', `/api/v1/workspaces/${segment(workspaceId)}/artifact-versions/${segment(versionId)}/content`, options);
    if (!response.ok) throw new ApiError(response.status, await response.json());
    return { bytes: new Uint8Array(await response.arrayBuffer()), etag: response.headers.get('etag'), contentDisposition: response.headers.get('content-disposition'), mediaType: response.headers.get('content-type') };
  }
  async *streamAgentMessage(workspaceId: string, threadId: string, input: { messageId: string; content: string; reasoningEffort?: AgentChatReasoningEffort }, options: RequestOptions = {}): AsyncGenerator<AgentChatStreamEvent> {
    const response = await this.#send('POST', `/api/v1/workspaces/${segment(workspaceId)}/agent/threads/${segment(threadId)}/messages`, options, input, undefined, { Accept: 'text/event-stream' });
    if (!response.ok) {
      const result: unknown = await response.json().catch(() => ({ error: { code: 'invalid_response' } }));
      throw new ApiError(response.status, result);
    }
    if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) throw new ApiError(502, { error: { code: 'invalid_event_stream' } });
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '', eventType = '', data: string[] = [];
    const frame = (): AgentChatStreamEvent | undefined => {
      if (data.length === 0) { eventType = ''; return; }
      const raw = data.join('\n'), type = eventType;
      eventType = ''; data = [];
      let value: Record<string, unknown>;
      try { value = JSON.parse(raw) as Record<string, unknown>; }
      catch { throw new ApiError(502, { error: { code: 'invalid_event_stream' } }); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(502, { error: { code: 'invalid_event_stream' } });
      if (type === 'capabilities' || type === 'context' || type === 'tool') {
        if (typeof value.messageId !== 'string') throw new ApiError(502, { error: { code: 'invalid_event_stream' } });
        if (type === 'capabilities') {
          const access = agentChatAccessSchema.safeParse(value.access);
          if (access.success) return { type, messageId: value.messageId, access: access.data };
        } else if (type === 'context') {
          const sources = agentChatContextSourcesSchema.safeParse(value.sources);
          if (sources.success) return { type, messageId: value.messageId, sources: sources.data };
        } else {
          const toolCall = agentChatToolCallSchema.safeParse(value.toolCall);
          if (toolCall.success) return { type, messageId: value.messageId, toolCall: toolCall.data };
        }
        throw new ApiError(502, { error: { code: 'invalid_event_stream' } });
      }
      if (type === 'delta' && typeof value.messageId === 'string' && typeof value.delta === 'string') return { type, messageId: value.messageId, delta: value.delta };
      if (type === 'error' && typeof value.code === 'string' && typeof value.message === 'string') return { type, code: value.code, message: value.message, messageId: typeof value.messageId === 'string' ? value.messageId : null };
      if (type === 'user' || type === 'assistant' || type === 'done' || type === 'cancelled') {
        if (!isAgentChatMessage(value.message)) throw new ApiError(502, { error: { code: 'invalid_event_stream' } });
        return { type, message: value.message };
      }
    };
    try {
      while (true) {
        const chunk = await reader.read();
        pending += decoder.decode(chunk.value, { stream: !chunk.done });
        let end: number;
        while ((end = pending.search(/[\r\n]/)) !== -1) {
          if (pending[end] === '\r' && end === pending.length - 1 && !chunk.done) break;
          const line = pending.slice(0, end);
          const width = pending[end] === '\r' && pending[end + 1] === '\n' ? 2 : 1;
          pending = pending.slice(end + width);
          if (!line) {
            const event = frame();
            if (event) {
              yield event;
              if (event.type === 'done' || event.type === 'cancelled' || event.type === 'error') return;
            }
          } else if (!line.startsWith(':')) {
            const colon = line.indexOf(':'), field = colon === -1 ? line : line.slice(0, colon);
            const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
            if (field === 'event') eventType = value;
            else if (field === 'data') data.push(value);
          }
        }
        if (pending.length > 1024 * 1024 || data.reduce((total, part) => total + part.length, 0) > 1024 * 1024) throw new ApiError(502, { error: { code: 'invalid_event_stream' } });
        if (chunk.done) throw new ApiError(502, { error: { code: 'agent_stream_incomplete' } });
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  async *subscribeEvents(workspaceId: string, options: StreamOptions = {}): AsyncGenerator<StreamEvent> {
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const response = await this.#send('GET', `/api/v1/workspaces/${segment(workspaceId)}/events`, { ...options, signal }, undefined, { after: options.after, projectId: options.projectId }, { Accept: 'text/event-stream', ...(options.lastEventId === undefined ? {} : { 'Last-Event-ID': options.lastEventId }) });
    if (!response.ok) throw new ApiError(response.status, await response.json());
    if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) throw new ApiError(response.status, { error: { code: 'invalid_event_stream' } });
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '', eventType = '', eventId = '', data: string[] = [];
    function frame(): StreamEvent | undefined {
      if (data.length === 0) { eventType = ''; return; }
      const value = JSON.parse(data.join('\n')) as Record<string, unknown>;
      const type = eventType; eventType = ''; data = [];
      if (type === 'change') return { type, id: eventId, event: value as ChangeNotification };
      if (type === 'checkpoint' && typeof value.cursor === 'string') return { type, id: eventId, cursor: value.cursor };
      if (type === 'stream_error' && typeof value.code === 'string') return { type, code: value.code };
    }
    try {
      while (true) {
        // Heartbeat comments count as traffic. A proxy can leave the downstream
        // open after its upstream dies; do not report that silent stream as live.
        const readDeadline = setTimeout(() => controller.abort(new Error('event_stream_idle_timeout')), 45_000);
        let chunk: { done: boolean; value?: Uint8Array };
        try { chunk = await reader.read(); }
        finally { clearTimeout(readDeadline); }
        pending += decoder.decode(chunk.value, { stream: !chunk.done });
        let end: number;
        while ((end = pending.search(/[\r\n]/)) !== -1) {
          if (pending[end] === '\r' && end === pending.length - 1 && !chunk.done) break;
          const line = pending.slice(0, end);
          const width = pending[end] === '\r' && pending[end + 1] === '\n' ? 2 : 1;
          pending = pending.slice(end + width);
          if (!line) { const event = frame(); if (event) { yield event; if (event.type === 'stream_error') return; } }
          else if (!line.startsWith(':')) {
            const colon = line.indexOf(':'), field = colon === -1 ? line : line.slice(0, colon);
            const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
            if (field === 'event') eventType = value;
            else if (field === 'data') data.push(value);
            else if (field === 'id' && !value.includes('\0')) eventId = value;
          }
        }
        if (pending.length > 1024 * 1024 || data.reduce((total, part) => total + part.length, 0) > 1024 * 1024) throw new Error('SSE frame exceeds 1 MiB');
        if (chunk.done) break; // An unterminated frame is deliberately not dispatched.
      }
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
