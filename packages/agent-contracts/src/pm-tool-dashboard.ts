import { z } from 'zod';
import { agentChatToolResultFields } from './pm-tool-shared.ts';

const id = z.string().min(1).max(80);
const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const date = z.iso.date();
const text = z.string().max(16000);
const count = z.number().int().nonnegative();
const version = z.number().int().positive();
const money = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const record = { id: uuid, workspaceId: uuid, projectId: id.nullable(), ownerId: uuid.nullable(), version, createdAt: timestamp, updatedAt: timestamp, createdBy: uuid };
const note = z.strictObject({ ...record, kind: z.literal('private_note'), data: z.strictObject({ content: text, completedAt: timestamp.nullable(), deletedAt: timestamp.nullable() }) });
const watch = z.strictObject({ ...record, kind: z.literal('task_watch'), data: z.strictObject({ taskId: id, watching: z.boolean() }) });
const meeting = z.strictObject({ ...record, kind: z.literal('project_meeting'), data: z.strictObject({ title: z.string().max(300), description: text, startsAt: timestamp, endsAt: timestamp, participantIds: z.array(uuid).max(100), cancelledAt: timestamp.nullable(), cancelledBy: uuid.nullable(), cancellationReason: text.nullable() }) });
const taskReference = z.strictObject({ taskId: id.nullable(), projectId: id.nullable(), title: z.string().nullable(), unavailable: z.boolean() });
const timer = z.strictObject({ id: uuid, version, startedAt: timestamp, stoppedAt: timestamp.nullable(), worklogId: uuid.nullable(), task: taskReference });
const worklog = z.strictObject({ id: uuid, source: z.enum(['timer', 'manual']), timerId: uuid.nullable(), startedAt: timestamp, endedAt: timestamp, durationMs: z.number().nonnegative(), note: z.string().max(4000), task: taskReference });
const period = z.strictObject({ start: timestamp, end: timestamp, durationMs: z.number().nonnegative() });
const totals = z.strictObject({ day: period, week: period, month: period });
const member = { userId: uuid, name: z.string(), preference: z.enum(['online', 'away']), status: z.enum(['online', 'away', 'offline']), lastHeartbeatAt: timestamp.nullable() };
const healthData = z.strictObject({ status: z.enum(['on_track', 'at_risk', 'off_track']), confidence: z.enum(['high', 'medium', 'low']).nullable().optional(), rationale: text, risks: z.array(z.strictObject({ description: text, severity: z.enum(['low', 'medium', 'high']), mitigation: text })).max(100), assessedBy: uuid, assessedAt: timestamp });
const health = z.strictObject({ ...record, kind: z.enum(['portfolio_health', 'portfolio_health_assessment']), data: healthData });
const budgetData = { currency: z.string().regex(/^[A-Z]{3}$/), budgetMinor: money, remainingEstimateMinor: money, asOfDate: date };
const budget = z.strictObject({ ...record, kind: z.literal('portfolio_budget'), data: z.strictObject(budgetData), actualMinor: money, forecastMinor: money });
const spendVoid = z.strictObject({ ...record, kind: z.literal('portfolio_spend_void'), data: z.strictObject({ spendId: uuid, reason: text }) });
const spend = z.strictObject({ ...record, kind: z.literal('portfolio_spend'), data: z.strictObject({ currency: z.string().regex(/^[A-Z]{3}$/), amountMinor: money, spentOn: date, description: text, correctsSpendId: uuid.nullable() }), void: spendVoid.nullable() });
const financial = z.strictObject({ ...record, kind: z.literal('portfolio_financial_snapshot'), data: z.strictObject({ ...budgetData, actualMinor: money, forecastMinor: money, reason: text, cause: z.enum(['budget', 'remaining_estimate', 'spend', 'void', 'correction']), budgetVersion: version, spendId: uuid.nullable() }) });
const portfolioTotal = z.strictObject({ currency: z.string().regex(/^[A-Z]{3}$/), projectCount: count, budgetMinor: money.nullable(), actualMinor: money.nullable(), remainingEstimateMinor: money.nullable(), forecastMinor: money.nullable(), overflow: z.boolean() });
const portfolioRow = z.discriminatedUnion('row', [
  z.strictObject({ row: z.literal('current'), projectId: id, health: health.nullable(), budget: budget.nullable() }),
  z.strictObject({ row: z.literal('health-history'), projectId: id, assessment: health }),
  z.strictObject({ row: z.literal('spend'), projectId: id, spend }),
  z.strictObject({ row: z.literal('financial-history'), projectId: id, snapshot: financial }),
]);
const planningRow = z.discriminatedUnion('row', [
  z.strictObject({ row: z.literal('project'), id, title: z.string(), version, hasUnavailableDependencies: z.boolean(), editable: z.boolean(), criticalPathStatus: z.enum(['available', 'unavailable']), durationDays: z.number().finite().nonnegative().nullable() }),
  z.strictObject({ row: z.literal('dependency'), projectId: id, dependsOnProjectId: id }),
  z.strictObject({ row: z.literal('task'), id, projectId: id, title: z.string(), version, estimatedDurationDays: z.number().finite().nonnegative().nullable(), editable: z.boolean() }),
  z.strictObject({ row: z.literal('milestone'), id, projectId: id, title: z.string(), version, targetDate: date.nullable(), editable: z.boolean() }),
]);
const reasonCode = z.enum(['project_unavailable', 'no_tasks', 'invalid_source', 'missing_duration', 'invalid_duration', 'dependency_unavailable', 'dependency_cycle', 'duration_overflow']);
const criticalRow = z.discriminatedUnion('row', [
  z.strictObject({ row: z.literal('task'), id, title: z.string(), projectId: id, estimatedDurationDays: z.number().finite().nonnegative(), earlyStart: z.number().finite(), earlyFinish: z.number().finite(), lateStart: z.number().finite(), lateFinish: z.number().finite(), totalFloat: z.number().finite(), freeFloat: z.number().finite(), critical: z.boolean() }),
  z.strictObject({ row: z.literal('path-node'), pathIndex: count, position: count, taskId: id }),
  z.strictObject({ row: z.literal('reason'), code: reasonCode, taskId: id.optional(), message: z.string() }),
]);
const sprintBase = { id, projectId: id.nullable(), title: z.string(), status: z.string().nullable(), startDate: date.nullable(), dueDate: date.nullable(), archived: z.boolean(), total: count, completed: count, remaining: count };
const observation = { sequence: count, observedAt: timestamp, previousObservedAt: timestamp.nullable(), source: z.enum(['startup', 'external', 'core_command', 'scan']), reason: z.string(), gap: z.enum(['initial', 'restart', 'invalid_scan']).nullable(), complete: z.boolean() };
const sprintRow = z.discriminatedUnion('row', [
  z.strictObject({ row: z.literal('sprint'), ...sprintBase, category: z.string().nullable(), version, revision: z.string(), readOnly: z.boolean(), current: z.boolean() }),
  z.strictObject({ row: z.literal('task'), id, projectId: id.nullable(), title: z.string(), status: z.string().nullable(), sprintId: id.nullable(), archived: z.boolean(), version, readOnly: z.boolean() }),
  z.strictObject({ row: z.literal('history'), ...observation, sprint: z.strictObject(sprintBase).nullable() }),
  z.strictObject({ row: z.literal('history-member'), ...observation, sprintId: id, projectId: id.nullable(), taskId: id }),
]);
export const dashboardCommandActionSchema = z.enum(['CreatePrivateNote', 'UpdatePrivateNote', 'CompletePrivateNote', 'ReopenPrivateNote', 'DeletePrivateNote', 'CreateProjectMeeting', 'UpdateProjectMeeting', 'CancelProjectMeeting', 'WatchTask', 'UnwatchTask', 'StartTimer', 'StopTimer', 'RecordManualWorklog', 'SetPresencePreference', 'HeartbeatPresence', 'SetProjectHealth', 'SetProjectBudget', 'SetProjectRemainingEstimate', 'RecordProjectSpend', 'VoidProjectSpend', 'CorrectProjectSpend', 'SetProjectDependencies', 'UpdateTaskDuration', 'UpdateMilestone']);
export const DashboardToolResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('dashboard_notes'), items: z.array(note).max(20), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('dashboard_meetings'), items: z.array(meeting).max(20), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('dashboard_meeting_participants'), items: z.array(z.strictObject({ userId: uuid, name: z.string() })).max(20), canListParticipants: z.boolean(), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('dashboard_watches'), items: z.array(watch).max(20), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('dashboard_presence'), self: z.strictObject({ ...member, preferenceId: uuid.nullable(), preferenceVersion: version.nullable(), heartbeatId: uuid.nullable(), heartbeatVersion: version.nullable() }), items: z.array(z.strictObject(member)).max(20), serverNow: timestamp, directoryVisible: z.boolean(), ttlMs: count, ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('dashboard_timer'), activeTimer: timer.nullable(), serverNow: timestamp, ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('dashboard_worklogs'), items: z.array(worklog).max(20), totals, totalsScope: z.literal('actor'), timeZone: z.string(), serverNow: timestamp, ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('dashboard_portfolio'), section: z.enum(['current', 'health-history', 'spend', 'financial-history']), items: z.array(portfolioRow).max(20), totals: z.array(portfolioTotal).max(200).nullable(), totalsProjectScope: z.string().regex(/^[a-f0-9]{64}$/).nullable(), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('dashboard_planning'), section: z.enum(['projects', 'dependencies', 'tasks', 'milestones']), items: z.array(planningRow).max(20), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('dashboard_critical_path'), projectId: id, section: z.enum(['tasks', 'paths', 'reasons']), status: z.enum(['available', 'unavailable']), durationDays: z.number().finite().nonnegative().nullable(), model: z.literal('continuous_calendar_days_finish_to_start_zero_lag').nullable(), items: z.array(criticalRow).max(20), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('dashboard_sprint_metrics'), section: z.enum(['sprints', 'tasks', 'history', 'history-members']), historyStatus: z.enum(['ok', 'error']), historyError: z.string().nullable(), semantics: z.literal('observed_snapshots'), items: z.array(sprintRow).max(20), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('dashboard_receipt'), action: dashboardCommandActionSchema, ...agentChatToolResultFields }),
]);
export type DashboardToolResult = z.infer<typeof DashboardToolResultSchema>;
