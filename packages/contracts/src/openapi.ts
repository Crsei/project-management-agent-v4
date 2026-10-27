import { z } from 'zod';
import type { CommandRegistry } from '../../application/src/ports.ts';
import { projectAuditPageSchema } from '../../domain/src/project-audit.ts';
import { entityKinds } from '../../pm-schema/index.ts';
import { graphQuerySchema } from '../../pm-schema/graph.ts';
import { coreCreationAttemptSchema } from './core-creation.ts';
import { workspaceIdentitySchema } from './workspace-identity.ts';
import { WORKSPACE_COLORS, WORKSPACE_ICONS } from '../../domain/src/workspace-identity.ts';
import { accountSecuritySchemas } from './account-security-schemas.ts';
import { taskCommentSchema, taskCommentRevisionSchema, taskCommentsPageSchema, taskCommentHistoryPageSchema } from '../../domain/src/task-comments.ts';
import { notificationStateSchema, notificationInboxItemSchema, notificationInboxPageSchema, mentionCandidatesPageSchema } from './notifications.ts';
import { artifactCopyOriginResponseSchema } from './artifact-files.ts';
import { accountRecoverySchemas } from './account-recovery-schemas.ts';
import { accountRecoveryPaths } from './account-recovery-openapi.ts';
import { webhookResponseSchemas } from './webhook-schemas.ts';
import { localProjectPaths } from './local-project-openapi.ts';
import { automationPaths } from './automation-openapi.ts';
import { agentChatAccessSchema, agentChatAccessInputSchema, agentChatContextSourceSchema, agentChatToolCallSchema, agentChatToolResultSchema, agentChatMessageSchema, agentChatReasoningEffortSchema, agentChatReasoningSchema } from './agent-chat.ts';

// Payload validators remain owned by application commands. This module only
// describes their wire input and the HTTP adapter's public response envelopes.
export type JsonSchema = Record<string, any>;
export type OpenApiDocument = {
  openapi: '3.1.0'; info: { title: string; version: string; description: string };
  jsonSchemaDialect: string; servers: { url: string }[];
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, JsonSchema>; securitySchemes: Record<string, unknown> };
};
const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });
const uuid: JsonSchema = { type: 'string', format: 'uuid' };
const timestamp: JsonSchema = { type: 'string', format: 'date-time' };
const cursor: JsonSchema = { type: 'string', pattern: '^\\d{1,19}$', description: 'Workspace stream position as decimal int64 text (maximum 9223372036854775807). Never convert to a JavaScript number.' };
const nullableUuid: JsonSchema = { anyOf: [uuid, { type: 'null' }] };
const identifier: JsonSchema = { type: 'string', minLength: 1, maxLength: 80 };
const coreIdentifier: JsonSchema = { type: 'string', pattern: '^[A-Z][A-Z0-9]*-\\d+$' };
const nullableProject: JsonSchema = { anyOf: [coreIdentifier, { type: 'null' }] };
const object = (properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false });
const array = (items: JsonSchema): JsonSchema => ({ type: 'array', items });
const json = (schema: JsonSchema) => ({ 'application/json': { schema } });
const response = (description: string, schema: JsonSchema) => ({ description, content: json(schema) });
const param = (name: string, location: 'path' | 'query' | 'header', schema: JsonSchema, required = location === 'path', description?: string) => ({ name, in: location, required, schema, ...(description ? { description } : {}) });
const workspace = param('workspaceId', 'path', uuid);
const project = param('projectId', 'query', coreIdentifier, false, 'Restrict to a currently authorized project. Omission includes all authorized projects plus the current actor’s private notifications.');
const authenticated = [{ sessionCookie: [] }, { bearerAuth: [] }];
const kinds = ['project', 'work_item', 'milestone', 'conversation', 'intent', 'decision', 'upload', 'artifact', 'artifact_version', 'evidence', 'submission', 'review'];
const text: JsonSchema = { type: 'string' };
const boolean: JsonSchema = { type: 'boolean' };
const number: JsonSchema = { type: 'number' };
const nonnegativeInteger: JsonSchema = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const version: JsonSchema = { type: 'integer', minimum: 1 };
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: 'null' }] });
const dashboardRecord = (data: JsonSchema, extra: Record<string, JsonSchema> = {}): JsonSchema => object({
  id: uuid, workspaceId: uuid, projectId: nullableProject, kind: text, ownerId: nullableUuid, version,
  data, createdAt: timestamp, updatedAt: timestamp, createdBy: uuid, ...extra,
});

export function buildOpenApi(registry: CommandRegistry): OpenApiDocument {
  const schemas: Record<string, JsonSchema> = {
    Actor: object({ id: uuid, email: { type: 'string' }, name: { type: 'string' } }),
    Error: object({ code: { type: 'string' }, message: { type: 'string' }, details: {} }, ['code']),
    ErrorResponse: object({ error: ref('Error'), requestId: { type: 'string' } }),
    CommandReceipt: {
      oneOf: [
        object({ commandId: uuid, status: { const: 'committed' }, httpStatus: { const: 200 }, result: {} }),
        object({ commandId: uuid, status: { const: 'rejected' }, httpStatus: { type: 'integer', minimum: 400, maximum: 599 }, error: { ...ref('Error') } }),
      ],
      discriminator: { propertyName: 'status' },
      description: 'Durable result scoped by workspace, actor and commandId. Rejections are also recorded. Query the original commandId after a transport failure; the effect may already have committed. Permission and request-envelope failures can instead return ErrorResponse without a receipt.',
    },
    EntityKind: { type: 'string', enum: kinds },
    Entity: object({ id: identifier, workspaceId: uuid, projectId: nullableProject, kind: ref('EntityKind'), version, data: { type: 'object', additionalProperties: true, description: 'Aggregate-specific current data. Core project/task/milestone identities and data are authoritative Markdown objects.' }, createdAt: { ...nullable(timestamp), description: 'Explicit source creation timestamp; null when a Markdown source does not record it. Never inferred from scan or filesystem times.' }, updatedAt: { ...nullable(timestamp), description: 'Explicit source update timestamp; null when a Markdown source does not record it. Never inferred from scan or filesystem times.' }, createdBy: text }),
    EntityPage: object({ items: array(ref('Entity')), nextCursor: { type: ['string', 'null'], description: 'Opaque pagination token bound to kind, projectId and artifact visibility. Pass unchanged as after; null ends pagination.' }, cursor }),
    Workspace: object({ id: uuid, name: text, icon: { type: 'string', enum: [...WORKSPACE_ICONS] }, color: { type: 'string', enum: [...WORKSPACE_COLORS] }, identityVersion: version, ownerId: uuid, capabilities: array(text), projectIds: nullable(array(coreIdentifier)), version, cursor }),
    Member: object({ userId: uuid, workspaceId: uuid, capabilities: array(text), projectIds: nullable(array(coreIdentifier)), version, revokedAt: nullable(timestamp), email: text, name: text }),
    ChangeNotification: object({ eventId: uuid, eventType: text, workspaceId: uuid, projectId: nullableProject, aggregateId: identifier, aggregateKind: { type: 'string', description: 'Core/entity, membership or dashboard record kind. Private audiences are filtered server-side and are not exposed.' }, aggregateVersion: version, occurredAt: timestamp }),
    Changes: object({ events: array(object({ cursor, event: ref('ChangeNotification') })), cursor, head: cursor }),
    Readiness: { oneOf: [object({ status: { const: 'not_ready' }, reason: { const: 'backend_not_initialized' } }), object({ status: { enum: ['ready', 'not_ready'] }, checks: object({ database: { type: 'boolean' }, storage: { type: 'boolean' }, worker: { type: 'boolean' }, core: { type: 'boolean' }, quarantinedEvents: { type: 'integer', minimum: 0 } }) })] },
    Capabilities: object({ stage: { enum: ['bootstrap', 'backend'] }, ...Object.fromEntries(['business', 'database', 'storage', 'markdownCore', 'worker', 'realtime', 'localProjects'].map(name => [name, object({ enabled: { type: 'boolean' } })])), execution: object({ enabled: { const: false } }), accountRecovery: object({ request: object({ enabled: boolean }), verification: object({ enabled: boolean }) }) }),
  };
  const workspaceIdentity = z.toJSONSchema(workspaceIdentitySchema, { io: 'output', target: 'draft-2020-12' });
  delete workspaceIdentity.$schema;
  schemas.WorkspaceIdentity = workspaceIdentity;
  for (const [name, validator] of Object.entries({
    ...accountSecuritySchemas,
    ...accountRecoverySchemas, ...webhookResponseSchemas,
    ArtifactCopyOriginResponse: artifactCopyOriginResponseSchema,
    TaskComment: taskCommentSchema, TaskCommentRevision: taskCommentRevisionSchema,
    TaskCommentsPage: taskCommentsPageSchema, TaskCommentHistoryPage: taskCommentHistoryPageSchema,
    NotificationState: notificationStateSchema, NotificationInboxItem: notificationInboxItemSchema,
    NotificationInboxPage: notificationInboxPageSchema, MentionCandidatesPage: mentionCandidatesPageSchema,
    AgentChatAccess: agentChatAccessSchema, AgentChatAccessInput: agentChatAccessInputSchema,
    AgentChatContextSource: agentChatContextSourceSchema, AgentChatToolCall: agentChatToolCallSchema,
    AgentChatToolResult: agentChatToolResultSchema, AgentChatMessage: agentChatMessageSchema,
    AgentChatReasoningEffort: agentChatReasoningEffortSchema, AgentChatReasoning: agentChatReasoningSchema,
  })) {
    const schema = z.toJSONSchema(validator, { io: 'output', target: 'draft-2020-12' });
    delete schema.$schema;
    schemas[name] = schema;
  }
  schemas.AgentChatMessageStatus = { type: 'string', enum: ['complete', 'streaming', 'cancelled', 'error', 'interrupted'] };
  schemas.AgentChatThread = object({
    id: uuid, title: text, createdAt: timestamp, updatedAt: timestamp,
    lastMessageAt: nullable(timestamp), messageCount: nonnegativeInteger,
  });
  schemas.AgentChatThreadList = object({ items: array(ref('AgentChatThread')) });
  schemas.AgentChatThreadDetail = object({ thread: ref('AgentChatThread'), messages: array(ref('AgentChatMessage')) });
  schemas.AgentChatStatus = object({ enabled: boolean, provider: { const: 'openai-compatible' }, model: nullable(text), reasoning: ref('AgentChatReasoning') });
  schemas.AgentChatStreamError = object({ messageId: nullable(uuid), code: text, message: text });
  schemas.AgentChatStreamDelta = object({ messageId: uuid, delta: text });
  schemas.SelfProfile = object({ userId: uuid, name: text, timeZone: { type: 'string', description: 'Validated IANA time zone.' }, jobTitle: nullable(text), phone: nullable(text), avatarDataUrl: nullable(text), version, joinedAt: timestamp, updatedAt: timestamp });
  schemas.MemberRole = { type: 'string', enum: ['admin', 'member', 'guest'] };
  schemas.MemberDirectoryAccess = object({ capabilities: array(text), projectIds: nullable(array(coreIdentifier)), version, revokedAt: nullable(timestamp) });
  schemas.MemberDirectoryTeam = object({ id: uuid, name: text });
  schemas.MemberDirectoryMember = object({
    userId: uuid, name: text, email: nullable(text), jobTitle: nullable(text), phone: nullable(text), avatarDataUrl: nullable(text),
    joinedAt: timestamp, isSelf: boolean, role: { enum: ['admin', 'member', 'guest', 'custom', 'unknown'] },
    teams: array(ref('MemberDirectoryTeam')), presence: object({ status: { enum: ['online', 'away', 'offline'] }, lastHeartbeatAt: nullable(timestamp) }),
    twoFactorEnabled: { type: 'null' }, access: nullable(ref('MemberDirectoryAccess')),
  });
  schemas.MemberDirectory = object({
    serverNow: timestamp, presenceTtlMs: nonnegativeInteger,
    capabilities: object({ canReadDirectory: { const: true }, canManageMembers: boolean, canEditSelfProfile: boolean, twoFactor: object({ supported: { const: false } }) }),
    selfProfile: ref('SelfProfile'), members: array(ref('MemberDirectoryMember')),
  });
  schemas.InvitationDelivery = object({
    status: { enum: ['queued', 'sending', 'smtp_accepted', 'failed', 'unknown', 'cancelled'] },
    failureCode: nullable({ enum: ['smtp_rejected', 'smtp_unavailable', 'smtp_configuration', 'send_outcome_unknown', 'send_lease_expired', 'token_unavailable'] }), updatedAt: timestamp,
  });
  schemas.MemberInvitation = object({
    id: uuid, workspaceId: uuid, email: text, role: ref('MemberRole'), projectIds: nullable(array(coreIdentifier)),
    status: { enum: ['pending', 'accepted', 'revoked', 'expired'] }, version, expiresAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
    invitedBy: uuid, acceptedAt: nullable(timestamp), delivery: nullable(ref('InvitationDelivery')),
  });
  schemas.InvitationList = object({ enabled: boolean, items: array(ref('MemberInvitation')) });
  schemas.InvitationInspect = object({ workspaceId: uuid, workspaceName: text, email: text, role: ref('MemberRole'), projectIds: nullable(array(coreIdentifier)), expiresAt: timestamp, accountExists: boolean });
  schemas.InvitationAccept = object({ workspaceId: uuid, userId: uuid, email: text, alreadyAccepted: boolean });
  schemas.InvitationReceipt = object({ outcome: nullable(ref('InvitationAccept')) });
  schemas.TaskWatch = dashboardRecord(object({ taskId: coreIdentifier, watching: boolean }));
  schemas.PrivateNote = dashboardRecord(object({ content: text, completedAt: nullable(timestamp), deletedAt: nullable(timestamp) }));
  schemas.ProjectMeeting = dashboardRecord(object({ title: text, description: text, startsAt: timestamp, endsAt: timestamp, participantIds: array(uuid), cancelledAt: nullable(timestamp), cancelledBy: nullableUuid, cancellationReason: nullable(text) }));
  schemas.MeetingParticipant = object({ userId: uuid, name: text, projectIds: nullable(array(coreIdentifier)) });
  schemas.PersonalDashboard = object({ profile: ref('SelfProfile'), watches: array(ref('TaskWatch')), notes: array(ref('PrivateNote')), meetings: array(ref('ProjectMeeting')), meetingParticipants: array(ref('MeetingParticipant')), canListParticipants: boolean });
  schemas.TimeTaskReference = object({ taskId: nullable(coreIdentifier), projectId: nullableProject, title: nullable(text), unavailable: boolean });
  schemas.TimeTimer = object({ id: uuid, version, startedAt: timestamp, stoppedAt: nullable(timestamp), worklogId: nullableUuid, task: ref('TimeTaskReference') });
  schemas.TimeWorklog = object({ id: uuid, source: { enum: ['timer', 'manual'] }, timerId: nullableUuid, startedAt: timestamp, endedAt: timestamp, durationMs: nonnegativeInteger, note: text, task: ref('TimeTaskReference') });
  schemas.TimePeriodTotal = object({ start: timestamp, end: timestamp, durationMs: nonnegativeInteger });
  const presenceMember = { userId: uuid, name: text, preference: { enum: ['online', 'away'] }, status: { enum: ['online', 'away', 'offline'] }, lastHeartbeatAt: nullable(timestamp) };
  schemas.PresenceMember = object(presenceMember);
  schemas.PresenceSelf = object({ ...presenceMember, preferenceId: nullableUuid, preferenceVersion: nullable(version), heartbeatId: nullableUuid, heartbeatVersion: nullable(version) });
  schemas.TimeDashboard = object({ serverNow: timestamp, timeZone: text, activeTimer: nullable(ref('TimeTimer')), worklogs: array(ref('TimeWorklog')), totals: object({ day: ref('TimePeriodTotal'), week: ref('TimePeriodTotal'), month: ref('TimePeriodTotal') }), presence: object({ self: ref('PresenceSelf'), members: array(ref('PresenceMember')), directoryVisible: boolean, ttlMs: nonnegativeInteger }) });
  const sprintProgress = { id: coreIdentifier, projectId: nullableProject, title: text, status: nullable(text), startDate: nullable({ type: 'string', format: 'date' }), dueDate: nullable({ type: 'string', format: 'date' }), archived: boolean, taskIds: array(coreIdentifier), total: nonnegativeInteger, completed: nonnegativeInteger, remaining: nonnegativeInteger };
  schemas.SprintProgressPoint = object(sprintProgress);
  schemas.SprintSummary = object({ ...sprintProgress, category: nullable(text), version, revision: text, readOnly: boolean });
  schemas.SprintTask = object({ id: coreIdentifier, projectId: nullableProject, title: text, status: nullable(text), sprintId: nullable(coreIdentifier), archived: boolean, version, readOnly: boolean });
  schemas.SprintDashboardObservation = object({ sequence: version, observedAt: timestamp, previousObservedAt: nullable(timestamp), source: { enum: ['startup', 'external', 'core_command', 'scan'] }, reason: text, gap: nullable({ enum: ['initial', 'restart', 'invalid_scan'] }), complete: boolean, sprints: array(ref('SprintProgressPoint')) });
  schemas.SprintsDashboard = object({ sprints: array(ref('SprintSummary')), tasks: array(ref('SprintTask')), currentSprintIds: array(coreIdentifier), history: object({ status: { enum: ['ok', 'error'] }, error: nullable(text), semantics: { const: 'observed_snapshots' }, observations: array(ref('SprintDashboardObservation')) }) });
  schemas.PortfolioRisk = object({ description: text, severity: { enum: ['low', 'medium', 'high'] }, mitigation: text });
  schemas.ProjectDeliveryConfidence = { type: 'string', enum: ['high', 'medium', 'low'] };
  const health = object({ status: { enum: ['on_track', 'at_risk', 'off_track'] }, rationale: text, risks: array(ref('PortfolioRisk')), assessedBy: uuid, assessedAt: timestamp, confidence: nullable(ref('ProjectDeliveryConfidence')) }, ['status', 'rationale', 'risks', 'assessedBy', 'assessedAt']);
  const budget = { currency: { type: 'string', pattern: '^[A-Z]{3}$' }, budgetMinor: nonnegativeInteger, remainingEstimateMinor: nonnegativeInteger, asOfDate: { type: 'string', format: 'date' } };
  schemas.ProjectHealthAssessment = health;
  schemas.ProjectHealthRecord = dashboardRecord(ref('ProjectHealthAssessment'));
  schemas.ProjectBudget = object(budget);
  schemas.PortfolioBudgetView = dashboardRecord(ref('ProjectBudget'), { actualMinor: nonnegativeInteger, forecastMinor: nonnegativeInteger });
  schemas.ProjectSpendVoid = object({ spendId: uuid, reason: text });
  schemas.ProjectSpendVoidRecord = dashboardRecord(ref('ProjectSpendVoid'));
  schemas.ProjectSpend = object({ currency: budget.currency, amountMinor: nonnegativeInteger, spentOn: { type: 'string', format: 'date' }, description: text, correctsSpendId: nullableUuid });
  schemas.PortfolioSpendView = dashboardRecord(ref('ProjectSpend'), { void: nullable(ref('ProjectSpendVoidRecord')) });
  schemas.ProjectFinancialSnapshot = object({ ...budget, actualMinor: nonnegativeInteger, forecastMinor: nonnegativeInteger, reason: text, cause: { enum: ['budget', 'remaining_estimate', 'spend', 'void', 'correction'] }, budgetVersion: version, spendId: nullableUuid });
  schemas.ProjectFinancialSnapshotRecord = dashboardRecord(ref('ProjectFinancialSnapshot'));
  schemas.PortfolioProject = object({ projectId: coreIdentifier, health: nullable(ref('ProjectHealthRecord')), healthHistory: array(ref('ProjectHealthRecord')), budget: nullable(ref('PortfolioBudgetView')), spend: array(ref('PortfolioSpendView')), financialHistory: array(ref('ProjectFinancialSnapshotRecord')) });
  schemas.PortfolioCurrencyTotal = object({ currency: budget.currency, projectCount: nonnegativeInteger, budgetMinor: nullable(nonnegativeInteger), actualMinor: nullable(nonnegativeInteger), remainingEstimateMinor: nullable(nonnegativeInteger), forecastMinor: nullable(nonnegativeInteger), overflow: boolean });
  schemas.PortfolioDashboard = object({ projects: array(ref('PortfolioProject')), totals: array(ref('PortfolioCurrencyTotal')) });
  schemas.CriticalPathTask = object({ id: coreIdentifier, title: text, projectId: coreIdentifier, estimatedDurationDays: number, earlyStart: number, earlyFinish: number, lateStart: number, lateFinish: number, totalFloat: number, freeFloat: number, critical: boolean });
  schemas.PlanningUnavailableReason = object({ code: { enum: ['project_unavailable', 'no_tasks', 'invalid_source', 'missing_duration', 'invalid_duration', 'dependency_unavailable', 'dependency_cycle', 'duration_overflow'] }, taskId: coreIdentifier, message: text }, ['code', 'message']);
  schemas.CriticalPathAnalysis = { oneOf: [object({ status: { const: 'available' }, durationDays: number, tasks: array(ref('CriticalPathTask')), criticalPaths: array(array(coreIdentifier)), model: { const: 'continuous_calendar_days_finish_to_start_zero_lag' } }), object({ status: { const: 'unavailable' }, reasons: array(ref('PlanningUnavailableReason')) })] };
  schemas.PlanningProject = object({ id: coreIdentifier, title: text, version, dependsOn: array(coreIdentifier), hasUnavailableDependencies: boolean, editable: boolean, criticalPath: ref('CriticalPathAnalysis') });
  schemas.PlanningTask = object({ id: coreIdentifier, projectId: coreIdentifier, title: text, version, estimatedDurationDays: nullable(number), editable: boolean });
  schemas.PlanningMilestone = object({ id: coreIdentifier, projectId: coreIdentifier, title: text, version, targetDate: nullable({ type: 'string', format: 'date' }), editable: boolean });
  schemas.PlanningDashboard = object({ projects: array(ref('PlanningProject')), tasks: array(ref('PlanningTask')), milestones: array(ref('PlanningMilestone')) });
  schemas.ProjectFavoriteData = object({ favorite: boolean });
  schemas.ProjectFavorite = dashboardRecord(ref('ProjectFavoriteData'));
  schemas.ProjectSidebarOrderData = object({ projectIds: { ...array(coreIdentifier), uniqueItems: true } });
  schemas.ProjectSidebarOrder = dashboardRecord(ref('ProjectSidebarOrderData'));
  schemas.ProjectCoverMediaType = { type: 'string', enum: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] };
  schemas.ProjectCoverData = object({ artifactVersionId: nullableUuid, mediaType: nullable(ref('ProjectCoverMediaType')) });
  schemas.ProjectCover = dashboardRecord(ref('ProjectCoverData'));
  schemas.ProjectScopeItem = object({ id: uuid, text, completed: boolean });
  schemas.ProjectScopeData = object({ items: array(ref('ProjectScopeItem')) });
  schemas.ProjectScope = dashboardRecord(ref('ProjectScopeData'));
  schemas.ProjectExtrasProject = object({ projectId: coreIdentifier, favorite: nullable(ref('ProjectFavorite')), cover: nullable(ref('ProjectCover')), scope: nullable(ref('ProjectScope')) });
  schemas.ProjectExtras = object({ projects: array(ref('ProjectExtrasProject')), sidebarOrder: nullable(ref('ProjectSidebarOrder')) });
  schemas.ProjectIdentity = object({ id: uuid, name: text });
  schemas.ProjectTeam = object({ name: text, memberIds: array(uuid), archivedAt: nullable(timestamp), identifier: nullable(text), description: text, focus: nullable(text), responseTargetHours: nullable({ type: 'number', minimum: 0, maximum: 8760 }), maintainerIds: array(uuid) });
  schemas.ProjectTeamRecord = dashboardRecord(ref('ProjectTeam'));
  schemas.ProjectTeamAssignment = object({ teamIds: array(uuid) });
  schemas.ProjectDirectoryVersion = object({ id: uuid, version });
  schemas.ProjectTeamFragment = object({ id: uuid, name: text, members: array(ref('ProjectIdentity')) });
  schemas.ProjectDirectoryProject = object({ projectId: coreIdentifier, identities: array(ref('ProjectIdentity')), teams: array(ref('ProjectTeamFragment')), assignment: nullable(ref('ProjectDirectoryVersion')) });
  schemas.ProjectDirectoryManagement = object({ members: array(ref('ProjectIdentity')), teams: array(ref('ProjectTeamRecord')) });
  schemas.ProjectDirectory = object({ projects: array(ref('ProjectDirectoryProject')), management: nullable(ref('ProjectDirectoryManagement')) });
  schemas.TeamDirectoryTeam = dashboardRecord(ref('ProjectTeam'), { createdBy: nullableUuid, projectIds: array(coreIdentifier), activityAt: timestamp, openWorkCount: nullable(nonnegativeInteger), scopeComplete: boolean });
  schemas.TeamDirectoryProject = object({ id: coreIdentifier, name: text, version, canManage: boolean, assignment: nullable(ref('ProjectDirectoryVersion')) });
  schemas.TeamDirectory = object({ canManage: boolean, teams: array(ref('TeamDirectoryTeam')), projects: array(ref('TeamDirectoryProject')) });
  const points = { type: 'number', minimum: 0, maximum: 1_000_000 };
  schemas.MemberCapacityData = object({ userId: uuid, capacityPoints: nullable(points) });
  schemas.MemberCapacity = dashboardRecord(ref('MemberCapacityData'));
  schemas.TeamWorkloadCapacity = object({ id: uuid, version, capacityPoints: nullable(points) });
  schemas.TeamWorkloadMemberScope = object({ complete: boolean, reason: { enum: ['workspace', 'partial'] } });
  schemas.TeamWorkloadMember = object({ userId: uuid, teamIds: array(uuid), taskIds: array(coreIdentifier), openCount: nonnegativeInteger, doneCount: nonnegativeInteger, knownOpenPoints: { type: 'number', minimum: 0 }, unknownEstimateCount: nonnegativeInteger, capacity: nullable(ref('TeamWorkloadCapacity')), capacityPoints: nullable(points), overloaded: nullable(boolean), scope: ref('TeamWorkloadMemberScope') });
  schemas.TeamWorkloadTask = object({ id: coreIdentifier, title: text, projectId: coreIdentifier, assigneeId: nullableUuid, assigneeStatus: { enum: ['assigned', 'unassigned', 'unavailable'] }, teamIds: array(uuid), status: text, statusCategory: { enum: ['backlog', 'unstarted', 'started', 'completed', 'canceled'] }, open: boolean, done: boolean, estimatePoints: nullable(points) });
  schemas.TeamWorkloadTeam = object({ id: uuid, name: text, memberIds: array(uuid), taskIds: array(coreIdentifier) });
  schemas.TeamWorkloadSummary = object({ openCount: nonnegativeInteger, doneCount: nonnegativeInteger, knownOpenPoints: { type: 'number', minimum: 0 }, unknownEstimateCount: nonnegativeInteger, overloadedMemberCount: nonnegativeInteger, unknownOverloadMemberCount: nonnegativeInteger, unknownAssigneeCount: nonnegativeInteger });
  schemas.TeamWorkload = object({ serverNow: timestamp, unit: { const: 'concurrent_open_points' }, members: array(ref('TeamWorkloadMember')), tasks: array(ref('TeamWorkloadTask')), unassignedTaskIds: array(coreIdentifier), teams: array(ref('TeamWorkloadTeam')), summary: ref('TeamWorkloadSummary'), scope: object({ complete: boolean, projectIds: array(coreIdentifier), reason: { enum: ['workspace', 'projects'] } }) });
  const auditPage = z.toJSONSchema(projectAuditPageSchema, { io: 'output', target: 'draft-2020-12' });
  delete auditPage.$schema;
  schemas.ProjectAuditPage = auditPage;
  const graphQuery = z.toJSONSchema(graphQuerySchema, { io: 'input', target: 'draft-2020-12' });
  delete graphQuery.$schema;
  schemas.GraphQuery = { ...graphQuery, description: 'Read-only graph query. View fields and bounded where expressions use the current protocol query DSL and are semantically validated by the server. Depth is an undirected 1..3-hop neighborhood over selected relation kinds; omitted relations selects all, [] selects none. Archive defaults to exclude.' };
  schemas.GraphNode = object({ id: coreIdentifier, title: text, entity: { type: 'string', enum: entityKinds }, status: text, archived: boolean, stale: boolean }, ['id', 'title', 'entity', 'archived', 'stale']);
  schemas.GraphLink = object({ id: text, source: coreIdentifier, target: coreIdentifier, kind: text });
  schemas.GraphData = object({
    nodes: array(ref('GraphNode')), links: array(ref('GraphLink')),
    unresolved: array(object({ source: coreIdentifier, target: text, reason: { enum: ['missing', 'ambiguous'] } })),
    availableRelations: array(text),
  });
  const creationAttempt = z.toJSONSchema(coreCreationAttemptSchema, { io: 'output', target: 'draft-2020-12' });
  delete creationAttempt.$schema;
  const rebaseCreationReferences = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    if ('$ref' in value && typeof value.$ref === 'string' && (value.$ref === '#' || value.$ref.startsWith('#/')))
      value.$ref = `#/components/schemas/CoreCreationAttempt${value.$ref.slice(1)}`;
    for (const child of Object.values(value)) rebaseCreationReferences(child);
  };
  rebaseCreationReferences(creationAttempt);
  schemas.CoreCreationAttempt = { ...creationAttempt, description: 'Actor-scoped outcome of a native CreateCoreEntity request. This is not a PM command receipt. A missing record or pending write never proves that sending a new creation is safe. A committed revision describes the original write; current source state is reported separately.' };
  schemas.CoreErrorResponse = {
    oneOf: [
      ref('ErrorResponse'),
      object({
        error: text,
        diagnostics: array(object({ code: text, severity: { enum: ['error', 'warning'] }, path: text, message: text, entityId: text, field: text, targetId: text, line: nonnegativeInteger }, ['code', 'severity', 'path', 'message'])),
        current: { type: 'object', additionalProperties: true },
      }, ['error', 'diagnostics']),
    ],
  };
  const mapping: Record<string, string> = {};
  for (const name of Object.keys(registry).sort()) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) throw new Error(`Invalid command schema name: ${name}`);
    const payload = z.toJSONSchema(registry[name]!.payload, { io: 'input', target: 'draft-2020-12' });
    delete payload.$schema;
    if (payload.type !== 'object' || payload.additionalProperties !== false) throw new Error(`Command ${name} must have a strict object payload`);
    schemas[`${name}Payload`] = payload;
    schemas[`${name}Command`] = object({
      commandId: { ...uuid, description: 'Caller-generated stable idempotency key. Reuse only with the identical request; never replace it after an unknown outcome.' },
      commandType: { type: 'string', const: name }, targetId: identifier, projectId: coreIdentifier,
      expectedVersions: { type: 'object', propertyNames: identifier, additionalProperties: version, description: 'Initial version of every existing aggregate changed, keyed by entity ID. Membership and self-profile changes use userId. Missing/stale versions reject with version_conflict; a profile version is global across workspaces.' },
      payload: ref(`${name}Payload`),
    }, ['commandId', 'commandType', 'payload']);
    mapping[name] = `#/components/schemas/${name}Command`;
  }
  schemas.Command = { oneOf: Object.values(mapping).map($ref => ({ $ref })), discriminator: { propertyName: 'commandType', mapping }, description: 'Only registered phase-one commands. Payload defaults and structural constraints come from Zod input schemas. Custom refinements, authority, target/project requirements, state transitions and cross-aggregate business rules are validated by the application. StageUpload accepts canonical base64 up to 8 MiB decoded; HTTP bodies are limited to 12 MiB. Execution commands are disabled with capability_not_enabled.' };
  const errors = (...statuses: number[]) => Object.fromEntries(statuses.map(status => [status, response(status === 410 ? 'cursor_expired: reload an authorized entity snapshot, then resume from its cursor. error.details.head is the stream head.' : 'Request rejected before a successful response. See error.code; authorization is checked against current membership.', ref('ErrorResponse'))]));
  const secured = (summary: string, result: JsonSchema, parameters: unknown[] = []) => ({ summary, security: authenticated, parameters, responses: { 200: response('Success', result), ...errors(400, 401, 403, 404, 409, 503) } });
  const paths: OpenApiDocument['paths'] = {
    ...accountRecoveryPaths,
    ...localProjectPaths(),
    ...automationPaths(),
    '/health/live': { get: { operationId: 'getLiveness', summary: 'Process liveness only', security: [], responses: { 200: response('Process responds; no business-readiness guarantee.', object({ status: { const: 'alive' } })) } } },
    '/health/ready': { get: { operationId: 'getReadiness', summary: 'Database, storage, live Worker heartbeat and quarantined outbox readiness', security: [], responses: { 200: response('All readiness checks passed.', ref('Readiness')), 503: response('Backend is uninitialized or at least one readiness check failed.', ref('Readiness')) } } },
    '/api/v1/capabilities': { get: { operationId: 'getCapabilities', summary: 'Configured phase-one capabilities; enabled does not imply readiness', security: [], responses: { 200: response('Execution remains disabled. Check /health/ready before business traffic.', ref('Capabilities')) } } },
    '/api/v1/workspaces/{workspaceId}/agent/status': { get: {
      ...secured('Read whether the server has an OpenAI-compatible chat model configured; this is not a live provider probe', ref('AgentChatStatus'), [workspace]),
      operationId: 'getAgentChatStatus',
      description: 'Requires current domain.read. The API key is server-only and never returned. enabled only means configuration exists; a provider failure is reported when a message is sent. reasoning lists the distinct documented effort options for this exact provider/model. Unknown compatible providers/models and retired aliases advertise only auto, supported=false; auto always omits the provider override.',
    } },
    '/api/v1/workspaces/{workspaceId}/agent/threads': {
      get: { ...secured('List the current actor’s private agent conversations', ref('AgentChatThreadList'), [workspace]), operationId: 'listAgentThreads' },
      post: {
        ...secured('Create or idempotently return one private agent conversation', object({ thread: ref('AgentChatThread') }), [workspace]),
        operationId: 'createAgentThread',
        requestBody: { required: true, content: json(object({ id: uuid, title: { type: 'string', minLength: 1, maxLength: 200 } }, ['id'])) },
        description: 'Reusing an existing id owned by the same actor returns the existing thread. An id owned by another actor is rejected without disclosure.',
      },
    },
    '/api/v1/workspaces/{workspaceId}/agent/threads/{threadId}': {
      get: { ...secured('Read one private agent conversation and its persisted messages', ref('AgentChatThreadDetail'), [workspace, param('threadId', 'path', uuid)]), operationId: 'getAgentThread' },
      delete: { ...secured('Delete one private agent conversation and its messages', object({ deleted: { const: true } }), [workspace, param('threadId', 'path', uuid)]), operationId: 'deleteAgentThread', description: 'Stops an in-flight reply owned by this API process before deleting the thread. Model side effects outside this service cannot be undone.' },
    },
    '/api/v1/workspaces/{workspaceId}/agent/threads/{threadId}/access': {
      get: { ...secured('Read current private-chat authorization and effective tool capabilities', ref('AgentChatAccess'), [workspace, param('threadId', 'path', uuid)]), operationId: 'getAgentThreadAccess' },
      put: {
        ...secured('Explicitly enable or revoke scoped Full access using the current revision', ref('AgentChatAccess'), [workspace, param('threadId', 'path', uuid)]),
        operationId: 'setAgentThreadAccess', requestBody: { required: true, content: json(ref('AgentChatAccessInput')) },
        description: 'Initial access is disabled. Enabling freezes the selected authorized project IDs and tool version for a finite grant. Allowed tools are auto-approved within that scope only. A disabled input may save scope without enabling tools. Revocation prevents new dispatch, not rollback of committed effects. A stale expectedRevision is rejected; after a lost response read access before retrying.',
      },
    },
    '/api/v1/workspaces/{workspaceId}/agent/threads/{threadId}/messages': { post: {
      operationId: 'streamAgentChatMessage',
      summary: 'Persist a user message and stream one untrusted model reply over SSE',
      security: authenticated,
      parameters: [workspace, param('threadId', 'path', uuid)],
      requestBody: { required: true, content: json(object({ messageId: uuid, content: { type: 'string', minLength: 1, maxLength: 16000 }, reasoningEffort: { ...ref('AgentChatReasoningEffort'), default: 'auto' } }, ['messageId', 'content'])) },
      description: 'SSE events: user, assistant, delta, capabilities, context, tool, done, cancelled, error. capabilities carries {messageId,access}, context {messageId,sources}, tool {messageId,toolCall}; assistant snapshots retain actual tool calls and sources, never raw model thinking. reasoningEffort applies to every model round of this message only; auto omits the override. A non-auto value not advertised by status is rejected with 400 agent_reasoning_unsupported before either message is persisted. The client messageId is idempotent within the thread. Only one reply may stream per thread. Closing the reader does not cancel generation; POST cancel is explicit. EOF without done/cancelled/error leaves the result unknown; reconcile via GET thread, never blindly resend. Model text is not a business fact; only scoped, server-authorized native tools can write PM data.',
      responses: {
        200: { description: 'SSE. user/assistant/done/cancelled carry {message}; delta carries {messageId,delta}; error carries {messageId,code,message}.', content: { 'text/event-stream': { schema: { type: 'string' } } } },
        ...errors(400, 401, 403, 404, 409, 503),
      },
    } },
    '/api/v1/workspaces/{workspaceId}/agent/threads/{threadId}/cancel': { post: {
      ...secured('Explicitly cancel the current reply; partial text is retained', object({ cancelled: boolean }), [workspace, param('threadId', 'path', uuid)]),
      operationId: 'cancelAgentThread',
      requestBody: { required: false, content: json(object({ messageId: uuid }, [])) },
      description: 'Cancellation is explicit. The server aborts the provider request and waits for the generation handler to persist both partial text and terminal status. cancelled=true confirms persisted cancellation; false means no matching active reply or another terminal outcome won the race. Persistence failure returns 503. Clients must reconcile unknown outcomes via GET thread and must not infer cancellation from a disconnected reader. External provider usage already incurred is not reversible.',
    } },
    '/openapi.json': { get: { operationId: 'getOpenApi', summary: 'Live contract generated from the command registry', security: [], responses: { 200: response('OpenAPI 3.1 document', { type: 'object', additionalProperties: true }) } } },
    '/api/v1/auth/login': { post: { operationId: 'login', summary: 'Create a server-side session', security: [], requestBody: { required: true, content: json(object({ email: { type: 'string', maxLength: 254 }, password: { type: 'string', maxLength: 256 } })) }, responses: { 200: { ...response('Session actor and expiry; token is only returned in Set-Cookie.', object({ actor: ref('Actor'), expiresAt: timestamp })), headers: { 'Set-Cookie': { description: 'pm_session opaque token; HttpOnly; SameSite=Strict; Path=/; Expires; Secure when configured.', schema: { type: 'string' } } } }, ...errors(400, 401, 403, 429, 503) } } },
    '/api/v1/auth/logout': { post: { ...secured('Revoke the current session and clear pm_session', object({ loggedOut: { const: true } })), operationId: 'logout' } },
    '/api/v1/auth/me': { get: { ...secured('Read the authenticated actor', object({ actor: ref('Actor') })), operationId: 'getMe' } },
    '/api/v1/auth/security': { get: { ...secured('Read own credential version and active sessions; token hashes and unobserved device metadata are never exposed', ref('AccountSecurity')), operationId: 'getAccountSecurity' } },
    '/api/v1/auth/security/password': { post: {
      ...secured('Change own password with current-password verification and revoke all other sessions', ref('AccountSecurityAction')),
      operationId: 'changeOwnPassword', requestBody: { required: true, content: json(ref('ChangeOwnPassword')) },
      description: 'Keep the current session without extending expiry. Never persist passwords in client journals or retry the write automatically. After an unknown outcome query the original actionId; explicit recovery can fence an absent delayed action.',
      responses: { 200: response('Immutable private security action receipt.', ref('AccountSecurityAction')), ...errors(401, 429, 503), ...Object.fromEntries([400, 403, 404, 409].map(status => [status, response('Durable rejected action or request/authentication error.', { oneOf: [ref('AccountSecurityAction'), ref('ErrorResponse')] })])) },
    } },
    '/api/v1/auth/security/sessions/revoke': { post: {
      ...secured('Revoke one own noncurrent session or all other sessions', ref('AccountSecurityAction')),
      operationId: 'revokeOwnSessions', requestBody: { required: true, content: json(ref('RevokeOwnSessions')) },
      responses: { 200: response('Immutable private security action receipt.', ref('AccountSecurityAction')), ...errors(401, 429, 503), ...Object.fromEntries([400, 403, 404, 409].map(status => [status, response('Durable rejected action or request/authentication error.', { oneOf: [ref('AccountSecurityAction'), ref('ErrorResponse')] })])) },
    } },
    '/api/v1/auth/security/actions/{actionId}': { get: {
      ...secured('Read own original security action without replaying credentials; null does not prove a delayed write cannot commit', ref('AccountSecurityActionLookup'), [param('actionId', 'path', uuid)]),
      operationId: 'getAccountSecurityAction',
    } },
    '/api/v1/auth/security/actions/{actionId}/recover': { post: {
      ...secured('Explicitly recover the original action or atomically fence an absent delayed action', ref('AccountSecurityActionLookup'), [param('actionId', 'path', uuid)]),
      operationId: 'recoverAccountSecurityAction', requestBody: { required: true, content: json(ref('RecoverAccountSecurityAction')) },
      responses: { 200: response('Existing action or immutable cancellation fence; no credentials replayed.', ref('AccountSecurityActionLookup')), ...errors(400, 401, 403, 404, 409, 429, 503) },
    } },
    '/api/v1/workspaces': { get: { ...secured('List current memberships and workspace stream cursors', object({ items: array(ref('Workspace')) })), operationId: 'listWorkspaces' } },
    '/api/v1/workspaces/{workspaceId}/identity': { get: { ...secured('Read presentation identity for a current authorized workspace; its version is independent of membership versions', ref('WorkspaceIdentity'), [workspace]), operationId: 'getWorkspaceIdentity' } },
    '/api/v1/workspaces/{workspaceId}/members': { get: { ...secured('List members, including revoked memberships; requires workspace access.manage', array(ref('Member')), [workspace]), operationId: 'listMembers' } },
    '/api/v1/workspaces/{workspaceId}/members/directory': { get: { ...secured('Read the current scoped and redacted member directory; directory.read or workspace access.manage required', ref('MemberDirectory'), [workspace]), operationId: 'getMemberDirectory', description: 'Other members contact and authorization fields are redacted for non-managers. Team membership grants no permission. Presence is derived from authoritative heartbeats and TTL; twoFactorEnabled remains null while no trusted MFA source exists.' } },
    '/api/v1/workspaces/{workspaceId}/members/invitations': { get: { ...secured('Read workspace invitations and delivery state; requires workspace access.manage', ref('InvitationList'), [workspace]), operationId: 'listMemberInvitations', description: 'enabled reflects configured SMTP support, not successful delivery. SMTP acceptance does not imply inbox delivery. Raw invitation tokens are never returned.' } },
    '/api/v1/invitations/inspect': { post: {
      operationId: 'inspectMemberInvitation', summary: 'Inspect a valid invitation using its secret token in the body', security: [],
      requestBody: { required: true, content: json(object({ token: { type: 'string', minLength: 43, maxLength: 43 } })) },
      responses: { 200: response('Invitation details for the token holder.', ref('InvitationInspect')), 410: response('The unconsumed invitation has expired.', ref('ErrorResponse')), ...errors(400, 403, 404, 409, 429, 503) },
    } },
    '/api/v1/invitations/accept': { post: {
      operationId: 'acceptMemberInvitation', summary: 'Atomically accept an invitation; confirm existing password or create the invited account', security: [],
      description: 'No session is issued. A transport failure may mean the acceptance committed: query receipt with the original commandId before deciding to retry. Credentials and token are never stored in a receipt. Replaying an accepted command never restores later-revoked membership.',
      requestBody: { required: true, content: json(object({ commandId: uuid, token: { type: 'string', minLength: 43, maxLength: 43 }, password: { type: 'string', maxLength: 256 }, name: { type: 'string', minLength: 1, maxLength: 200 } }, ['commandId', 'token', 'password'])) },
      responses: { 200: response('Durable accepted result. Sign in normally afterward.', ref('InvitationAccept')), 410: response('The unconsumed invitation has expired.', ref('ErrorResponse')), ...errors(400, 401, 403, 404, 409, 429, 503) },
    } },
    '/api/v1/invitations/receipt': { post: {
      operationId: 'getMemberInvitationAcceptance', summary: 'Query the original invitation acceptance outcome with token and account credentials', security: [],
      requestBody: { required: true, content: json(object({ token: { type: 'string', minLength: 43, maxLength: 43 }, commandId: uuid, password: { type: 'string', maxLength: 256 } })) },
      responses: { 200: response('Original result or null. Null is not proof an in-flight operation cannot still commit.', ref('InvitationReceipt')), 410: response('The unconsumed invitation has expired; an already committed original acceptance remains recoverable.', ref('ErrorResponse')), ...errors(400, 401, 403, 404, 409, 429, 503) },
    } },
    '/api/v1/workspaces/{workspaceId}/dashboard/personal': { get: { ...secured('Read self profile, private watches/notes and authorized project meetings', ref('PersonalDashboard'), [workspace]), operationId: 'getPersonalDashboard' } },
    '/api/v1/workspaces/{workspaceId}/dashboard/time': { get: { ...secured('Read own timer/worklogs, local-calendar totals and authorized presence directory', ref('TimeDashboard'), [workspace]), operationId: 'getTimeDashboard' } },
    '/api/v1/workspaces/{workspaceId}/dashboard/sprints': { get: { ...secured('Read scoped native cycles and durable observed sprint snapshots', ref('SprintsDashboard'), [workspace]), operationId: 'getSprintsDashboard' } },
    '/api/v1/workspaces/{workspaceId}/dashboard/portfolio': { get: { ...secured('Read authorized explicit health and financial history grouped by currency', ref('PortfolioDashboard'), [workspace]), operationId: 'getPortfolioDashboard' } },
    '/api/v1/workspaces/{workspaceId}/dashboard/planning': { get: { ...secured('Read scoped native project dependencies, durations, critical paths and milestone dates', ref('PlanningDashboard'), [workspace]), operationId: 'getPlanningDashboard' } },
    '/api/v1/workspaces/{workspaceId}/projects/extras': { get: { ...secured('Read authorized project favorites for the current actor, validated cover versions and scope annotations', ref('ProjectExtras'), [workspace]), operationId: 'getProjectExtras', description: 'Requires current domain.read. Projects are authoritative Markdown objects; revoked and inaccessible projects are omitted. Favorites, private receipts and notifications belong only to the authenticated actor. No actor selector or arbitrary cover URLs are accepted.' } },
    '/api/v1/workspaces/{workspaceId}/projects/directory': { get: { ...secured('Read minimal project identities or authorized workspace team administration', ref('ProjectDirectory'), [workspace]), operationId: 'getProjectDirectory', description: 'Requires current domain.read or unrestricted workspace access.manage. Without domain.read the projects branch is empty; access.manage does not grant business read. Project identity fragments contain ID and name only, not email or capabilities. Team membership does not grant project access. The management branch is null unless the current actor has unrestricted workspace access.manage.' } },
    '/api/v1/workspaces/{workspaceId}/teams/directory': { get: { ...secured('Read real teams with scoped memberships, project associations and open-work counts', ref('TeamDirectory'), [workspace]), operationId: 'getTeamDirectory', description: 'Requires current domain.read or unrestricted workspace access.manage. Team responsibilities grant no permission. Project-scoped readers receive only authorized relations and scopeComplete=false; management without business read yields no projects and null open-work counts. Activity uses actual team and visible association record timestamps.' } },
    '/api/v1/workspaces/{workspaceId}/teams/workload': { get: { ...secured('Read authorized member workload and explicit concurrent open-work point capacities', ref('TeamWorkload'), [workspace]), operationId: 'getTeamWorkload', description: 'Requires domain.read and directory.read or unrestricted workspace access.manage. Estimates come from authoritative Markdown x-pm-estimate. Missing estimates or incomplete scope cannot prove absence of overload; zero and unknown remain distinct. Team membership does not expand readable projects.' } },
    '/api/v1/workspaces/{workspaceId}/projects/{projectId}/audit': { get: { ...secured('Read one stable cursor page of authorized project business audit history', ref('ProjectAuditPage'), [workspace, param('projectId', 'path', coreIdentifier), param('cursor', 'query', { type: 'string', minLength: 1, maxLength: 2048 }, false, 'Opaque ProjectAuditPage.nextCursor; pass unchanged. Bound to the authenticated actor, workspace, project and initial history high-water mark. Current permission is checked on every page.'), param('limit', 'query', { type: 'integer', minimum: 1, maximum: 100, default: 30 })]), operationId: 'getProjectAudit', description: 'Requires current audit.read and domain.read for this project on every page. Follow nextCursor until null; the first page is not the complete history. Safe allowlisted field changes only; private entries are visible solely to their actor. History starts with controlled writes after audit activation; it does not claim attribution for external file edits or rely on retained SSE notifications.' } },
    '/api/v1/workspaces/{workspaceId}/tasks/{taskId}/comments': { get: {
      ...secured('Read authorized comments on the current task and pinned project; deletion is a recoverable tombstone, not erasure', ref('TaskCommentsPage'), [workspace, param('taskId', 'path', coreIdentifier), param('projectId', 'query', coreIdentifier, true), param('after', 'query', uuid), param('limit', 'query', { type: 'integer', minimum: 1, maximum: 100, default: 30 })]),
      operationId: 'getTaskComments',
    } },
    '/api/v1/workspaces/{workspaceId}/tasks/{taskId}/comments/{commentId}/history': { get: {
      ...secured('Read immutable authorized comment revisions, including deleted content; project relocation never silently transfers history', ref('TaskCommentHistoryPage'), [workspace, param('taskId', 'path', coreIdentifier), param('commentId', 'path', uuid), param('projectId', 'query', coreIdentifier, true), param('after', 'query', version), param('limit', 'query', { type: 'integer', minimum: 1, maximum: 100, default: 30 })]),
      operationId: 'getTaskCommentHistory',
    } },
    '/api/v1/workspaces/{workspaceId}/notification-inbox': { get: {
      ...secured('Read the current actor’s routed notifications with current task/project authorization', ref('NotificationInboxPage'), [workspace, param('origin', 'query', { type: 'string', enum: ['routed', 'legacy_activity'], default: 'routed' }), param('after', 'query', cursor), param('through', 'query', cursor)]),
      operationId: 'getNotificationInbox',
      description: 'The default contains actual watch/mention deliveries, not the general event stream. Legacy explicitly read/archived rows are a separate origin; implicit unread history is not imported. Preserve head and membershipVersion across pages. Empty items may advance over currently hidden deliveries. Processing status distinguishes pending/error from current.',
    } },
    '/api/v1/workspaces/{workspaceId}/tasks/{taskId}/mention-candidates': { get: {
      ...secured('Read eligible personal mention identities for a current authorized task', ref('MentionCandidatesPage'), [workspace, param('taskId', 'path', coreIdentifier), param('projectId', 'query', coreIdentifier, true), param('q', 'query', { type: 'string', maxLength: 100 }), param('after', 'query', uuid), param('limit', 'query', { type: 'integer', minimum: 1, maximum: 50, default: 20 })]), operationId: 'getTaskMentionCandidates',
    } },
    '/api/v1/workspaces/{workspaceId}/projects/{projectId}/mention-candidates': { get: {
      ...secured('Read eligible personal mention identities for an authorized project; directory.read required', ref('MentionCandidatesPage'), [workspace, param('projectId', 'path', coreIdentifier), param('q', 'query', { type: 'string', maxLength: 100 }), param('after', 'query', uuid), param('limit', 'query', { type: 'integer', minimum: 1, maximum: 50, default: 20 })]), operationId: 'getProjectMentionCandidates',
    } },
    '/api/v1/workspaces/{workspaceId}/webhooks': { get: {
      ...secured('Read approved outbound targets, endpoint state and independent Worker availability', ref('WebhookOverview'), [workspace]), operationId: 'getWebhooks',
    } },
    '/api/v1/workspaces/{workspaceId}/webhooks/{endpointId}/deliveries': { get: {
      ...secured('Read authorized immutable delivery identities and outcomes', ref('WebhookDeliveryPage'), [workspace, param('endpointId', 'path', uuid), param('cursor', 'query', { type: 'string', minLength: 1, maxLength: 2048 }), param('limit', 'query', { type: 'integer', minimum: 1, maximum: 100, default: 30 })]), operationId: 'getWebhookDeliveries',
    } },
    '/api/v1/workspaces/{workspaceId}/webhook-deliveries/{deliveryId}': { get: {
      ...secured('Read a delivery’s attempts and durable receiver reconciliation evidence without secrets', ref('WebhookDeliveryDetail'), [workspace, param('deliveryId', 'path', uuid)]), operationId: 'getWebhookDelivery',
    } },
    '/api/v1/workspaces/{workspaceId}/core/graph': { post: {
      ...secured('Read the authorized Markdown knowledge graph', ref('GraphData'), [workspace]),
      operationId: 'queryCoreGraph',
      description: 'Requires current domain.read. Resolves formal/custom references and normalized wikilinks against the full workspace before authorization and global filters. Hidden endpoints, relations, counts and unresolved diagnostics are not returned. Scoped readers receive no unresolved diagnostics. An inaccessible or missing center returns the same 404; an authorized center excluded by the query returns an empty graph. Does not change source, business state or graph positions.',
      requestBody: { required: true, content: json(ref('GraphQuery')) },
      responses: { 200: response('Authorized graph only, including eligible isolated nodes.', ref('GraphData')), ...errors(400, 401, 403, 404, 422, 503) },
    } },
    '/api/v1/workspaces/{workspaceId}/core/creation-attempts/{key}': { get: {
      ...secured('Read the original native entity creation outcome without replaying or repairing it', ref('CoreCreationAttempt'), [workspace, param('key', 'path', { type: 'string', minLength: 1, maxLength: 512 }, true, 'The original Idempotency-Key sent to POST core/entities. The authenticated actor and workspace scope are implicit.')]),
      operationId: 'getCoreCreationAttempt',
      description: 'Rechecks current authorization. Never creates an entity or repairs audit data. Pending or not_found outcomes must retain the original request; never replace its key to bypass uncertainty. The response does not expose another actor’s attempt.',
      responses: { 200: response('Original native creation outcome.', ref('CoreCreationAttempt')), ...Object.fromEntries([400, 401, 403, 404, 409, 422, 500, 503].map(status => [status, response('Native diagnostic or authorized request error. Retain the original creation attempt.', ref('CoreErrorResponse'))])) },
    } },
    '/api/v1/workspaces/{workspaceId}/core/creation-attempts/{key}/recover': { post: {
      ...secured('Explicitly reconcile a native creation from durable file and audit evidence', ref('CoreCreationAttempt'), [workspace, param('key', 'path', { type: 'string', minLength: 1, maxLength: 512 })]),
      operationId: 'recoverCoreCreationAttempt',
      description: 'Repairs only the original attempt’s recoverable audit state after current authorization. Does not resend entity creation, match by title, or allocate a replacement ID. Unresolved file outcomes remain pending. After a transport failure query the same key.',
      requestBody: { required: true, content: json(object({})) },
      responses: { 200: response('Original outcome after explicit reconciliation; pending remains unresolved.', ref('CoreCreationAttempt')), ...Object.fromEntries([400, 401, 403, 404, 409, 422, 500, 503].map(status => [status, response('Native diagnostic or authorized request error. No replacement creation was dispatched.', ref('CoreErrorResponse'))])) },
    } },
    '/api/v1/workspaces/{workspaceId}/commands': { post: { operationId: 'executeCommand', summary: 'Execute one command atomically with receipt and outbox', security: authenticated, parameters: [workspace], requestBody: { required: true, content: json(ref('Command')) }, responses: { 200: response('Committed command or identical prior receipt. POST returns receipt.httpStatus; no automatic write retry.', ref('CommandReceipt')), ...Object.fromEntries([400, 401, 403, 404, 409, 413, 503].map(status => [status, response('Durable rejection receipt, or a request/authorization/infrastructure ErrorResponse. idempotency_conflict means this commandId represents a different request.', { oneOf: [ref('CommandReceipt'), ref('ErrorResponse')] })])) } } },
    '/api/v1/workspaces/{workspaceId}/commands/{commandId}': { get: { ...secured('Query the original commandId after an unknown write outcome', ref('CommandReceipt'), [workspace, param('commandId', 'path', uuid)]), operationId: 'getCommandReceipt', description: 'Only the original actor can read a receipt, subject to current scope and read/manage permission. GET returns 200 even when its stored receipt.httpStatus represents a rejection. 404 is not proof that a concurrent command will never commit.' } },
    '/api/v1/workspaces/{workspaceId}/commands/{commandId}/recover': { post: {
      ...secured('Explicitly resume the original durable project duplication', ref('CommandReceipt'), [workspace, param('commandId', 'path', uuid)]),
      operationId: 'recoverCommand',
      description: 'Only the original actor can recover a saved DuplicateProject request under current authorization. Resumes its frozen inputs and reserved IDs; accepts no replacement command or payload. Receipt GET never resumes writes. After a transport failure query the original commandId again.',
      requestBody: { required: true, content: json(object({})) },
      responses: { 200: response('Original committed receipt, without allocating a second copy.', ref('CommandReceipt')), ...Object.fromEntries([400, 401, 403, 404, 409, 422, 500, 503].map(status => [status, response('Original rejected receipt or authorized recovery error; unresolved outcomes must not be retried with a new commandId.', { oneOf: [ref('CommandReceipt'), ref('ErrorResponse')] })])) },
    } },
    '/api/v1/workspaces/{workspaceId}/entities': { get: { ...secured('Read an authorized page and stream cursor from one consistent snapshot', ref('EntityPage'), [workspace, param('kind', 'query', ref('EntityKind'), true), project, param('visibility', 'query', { type: 'string', enum: ['visible', 'hidden', 'all'], default: 'visible' }, false, 'Artifact and artifact_version lists only; other kinds reject a nondefault value. Filtering occurs before pagination.'), param('limit', 'query', { type: 'integer', minimum: 1, maximum: 100, default: 50 }), param('after', 'query', { type: 'string', maxLength: 500 }, false, 'Opaque EntityPage.nextCursor bound to kind, projectId and visibility; distinct from stream cursors.')]), operationId: 'listEntities', description: 'The PM project directory includes authorized archived projects for restore and guarded deletion. Native core query archive defaults and task-list behavior are unchanged.' } },
    '/api/v1/workspaces/{workspaceId}/entities/{id}': { get: { ...secured('Read one current entity with current read permission', ref('Entity'), [workspace, param('id', 'path', identifier)]), operationId: 'getEntity' } },
    '/api/v1/workspaces/{workspaceId}/artifact-versions/{id}/copy-origin': { get: { ...secured('Read copy provenance only while both source and target projects remain readable; otherwise origin is redacted', ref('ArtifactCopyOriginResponse'), [workspace, param('id', 'path', uuid)]), operationId: 'getArtifactCopyOrigin' } },
    '/api/v1/workspaces/{workspaceId}/artifact-versions/{id}/content': { get: { operationId: 'downloadArtifactVersion', summary: 'Download immutable content after current authorization and integrity verification', security: authenticated, parameters: [workspace, param('id', 'path', uuid)], responses: { 200: { description: 'Raw bytes. Always served as an attachment with application/octet-stream, regardless of stored mediaType.', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } }, headers: { ETag: { description: 'Quoted SHA-256 digest of the content.', schema: { type: 'string' } }, 'Content-Disposition': { schema: { type: 'string' }, description: "attachment; filename*=UTF-8'' plus percent-encoded original filename" }, 'Cache-Control': { schema: { const: 'private, no-store' } }, 'X-Content-Type-Options': { schema: { const: 'nosniff' } } } }, ...errors(400, 401, 403, 404, 503) } } },
    '/api/v1/workspaces/{workspaceId}/changes': { get: { ...secured('Read at most 200 stream positions, filtered to authorized project notifications', ref('Changes'), [workspace, project, param('after', 'query', { ...cursor, default: '0' })]), operationId: 'getChanges', description: 'Notifications invalidate cached entities; they do not carry business/audit payloads. cursor advances over scanned positions even if filtering yields no events. Continue until cursor=head. Membership is checked on every batch.', responses: { 200: response('Change batch, scanned cursor and current head.', ref('Changes')), ...errors(400, 401, 403, 404, 409, 410, 503) } } },
    '/api/v1/workspaces/{workspaceId}/events': { get: { operationId: 'subscribeEvents', summary: 'SSE invalidation stream with durable workspace cursor', description: 'after query takes precedence over Last-Event-ID; default is 0. Authorization and cursor are checked before headers and again every batch. change frames carry ChangeNotification and id=cursor; checkpoint frames carry {cursor} and advance over filtered positions. Comments are heartbeats. After headers, failures are stream_error frames with {code}, followed by closure. Slow streams close once the pending write buffer exceeds 1 MiB; reconnect explicitly from the last checkpoint. No automatic replay of commands. For cursor_expired (HTTP 410, or stream_error), reload an authorized entity snapshot and subscribe from its cursor; invalid/ahead cursors return 400/409.', security: authenticated, parameters: [workspace, project, param('after', 'query', cursor), param('Last-Event-ID', 'header', cursor)], responses: { 200: { description: 'SSE stream: change, checkpoint, stream_error events; reconnect using the last received id.', content: { 'text/event-stream': { schema: { type: 'string' }, example: 'id: 12\nevent: change\ndata: {"eventId":"00000000-0000-4000-8000-000000000001","eventType":"ProjectCreated","workspaceId":"00000000-0000-4000-8000-000000000002","projectId":null,"aggregateId":"00000000-0000-4000-8000-000000000003","aggregateKind":"project","aggregateVersion":1,"occurredAt":"2026-10-16T00:00:00.000Z"}\n\nid: 12\nevent: checkpoint\ndata: {"cursor":"12"}\n\n' } } }, ...errors(400, 401, 403, 404, 409, 410, 503) } } },
  };
  return {
    openapi: '3.1.0', jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: { title: 'Project Management API', version: '0.1.0', description: 'Phase-one modular backend. Supersedes the historical bootstrap.openapi.yaml contract. Server-side sessions accept either pm_session cookie or Authorization: Bearer; an Authorization header takes precedence. Origin must match configured PUBLIC_ORIGIN, cross-site writes are rejected, and this server does not enable cross-origin browser CORS. Disabled execution is not represented as available commands.' },
    servers: [{ url: '/' }], paths,
    components: { schemas, securitySchemes: { sessionCookie: { type: 'apiKey', in: 'cookie', name: 'pm_session' }, bearerAuth: { type: 'http', scheme: 'bearer', description: 'The same opaque server-side session token, not a JWT. Inject explicitly; never store in a generated client.' } } },
  };
}
