import { z } from 'zod';
import type { Capability } from '../../domain/src/core.ts';
import { dashboardPersonalCommands } from './dashboard-personal.ts';
import { dashboardTimeCommands } from './dashboard-time.ts';
import { dashboardPortfolioCommands } from './dashboard-portfolio.ts';
import { dashboardPlanningCommands } from './dashboard-planning.ts';

const id = z.string().regex(/^(?:[A-Z][A-Z0-9]*-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/).max(80);
const uuid = z.uuid().toLowerCase();
const page = { after: z.string().regex(/^(?:0|[1-9]\d{0,9})$/).nullable(), limit: z.number().int().min(1).max(20) };
const project = { projectId: id.nullable() };
const versions = z.record(id, z.number().int().positive()).refine(value => Object.keys(value).length <= 100, 'At most 100 expected versions');
const command = (payload: z.ZodType, scope: 'self' | 'project' | 'task', target: 'none' | 'record' | 'project' | 'optional') => z.strictObject({
  projectId: scope === 'project' || scope === 'task' ? id : z.null(),
  targetId: target === 'none' ? z.null() : target === 'optional' ? uuid.nullable() : target === 'project' ? id : uuid,
  expectedVersions: versions.nullable(), payload,
});
const personal = (name: string) => dashboardPersonalCommands[name]!.payload;
const time = (name: string) => dashboardTimeCommands[name]!.payload;
const portfolio = (name: string) => dashboardPortfolioCommands[name]!.payload;
const planning = (name: string) => dashboardPlanningCommands[name]!.payload;

export const DashboardToolInputSchemas = {
  pm_read_private_notes: z.strictObject(page),
  pm_read_project_meetings: z.strictObject({ ...project, ...page }),
  pm_read_meeting_participants: z.strictObject({ projectId: id, ...page }),
  pm_read_task_watches: z.strictObject({ ...project, ...page }),
  pm_read_presence: z.strictObject(page),
  pm_read_timer: z.strictObject({}),
  pm_read_worklogs: z.strictObject({ ...project, ...page }),
  pm_read_portfolio: z.strictObject({ ...project, section: z.enum(['current', 'health-history', 'spend', 'financial-history']), ...page }),
  pm_read_planning: z.strictObject({ ...project, section: z.enum(['projects', 'dependencies', 'tasks', 'milestones']), ...page }),
  pm_read_critical_path: z.strictObject({ projectId: id, section: z.enum(['tasks', 'paths', 'reasons']), ...page }),
  pm_read_sprint_metrics: z.strictObject({ ...project, sprintId: id.nullable(), section: z.enum(['sprints', 'tasks', 'history', 'history-members']), ...page }),
  pm_create_private_note: command(personal('CreatePrivateNote'), 'self', 'none'),
  pm_update_private_note: command(personal('UpdatePrivateNote'), 'self', 'record'),
  pm_complete_private_note: command(personal('CompletePrivateNote'), 'self', 'record'),
  pm_reopen_private_note: command(personal('ReopenPrivateNote'), 'self', 'record'),
  pm_delete_private_note: command(personal('DeletePrivateNote'), 'self', 'record'),
  pm_create_project_meeting: command(personal('CreateProjectMeeting'), 'project', 'none'),
  pm_update_project_meeting: command(personal('UpdateProjectMeeting'), 'project', 'record'),
  pm_cancel_project_meeting: command(personal('CancelProjectMeeting'), 'project', 'record'),
  pm_watch_task: command(personal('WatchTask'), 'task', 'none'),
  pm_unwatch_task: command(personal('UnwatchTask'), 'project', 'record'),
  pm_start_timer: command(time('StartTimer'), 'self', 'none'),
  pm_stop_timer: command(time('StopTimer'), 'self', 'record'),
  pm_record_manual_worklog: command(time('RecordManualWorklog'), 'self', 'none'),
  pm_set_presence_preference: command(time('SetPresencePreference'), 'self', 'optional'),
  pm_heartbeat_presence: command(time('HeartbeatPresence'), 'self', 'optional'),
  pm_set_project_health: command(portfolio('SetProjectHealth'), 'project', 'project'),
  pm_set_project_budget: command(portfolio('SetProjectBudget'), 'project', 'project'),
  pm_set_project_remaining_estimate: command(portfolio('SetProjectRemainingEstimate'), 'project', 'project'),
  pm_record_project_spend: command(portfolio('RecordProjectSpend'), 'project', 'project'),
  pm_void_project_spend: command(portfolio('VoidProjectSpend'), 'project', 'project'),
  pm_correct_project_spend: command(portfolio('CorrectProjectSpend'), 'project', 'project'),
  pm_set_project_dependencies: command(planning('SetProjectDependencies'), 'project', 'project'),
  pm_update_task_duration: z.strictObject({ projectId: id, targetId: id, expectedVersions: versions, payload: planning('UpdateTaskDuration') }),
  pm_update_planning_milestone: z.strictObject({ projectId: id, targetId: id, expectedVersions: versions, payload: planning('UpdateMilestone') }),
} as const;
export type DashboardToolName = keyof typeof DashboardToolInputSchemas;
export const DashboardReadResources = {
  notes: 'pm_read_private_notes', meetings: 'pm_read_project_meetings', 'meeting-participants': 'pm_read_meeting_participants',
  watch: 'pm_read_task_watches', presence: 'pm_read_presence', timer: 'pm_read_timer', worklog: 'pm_read_worklogs',
  portfolio: 'pm_read_portfolio', planning: 'pm_read_planning', 'critical-path': 'pm_read_critical_path', 'sprint-metrics': 'pm_read_sprint_metrics',
} as const satisfies Record<string, DashboardToolName>;
export const DashboardCommandActions = {
  pm_create_private_note: 'CreatePrivateNote', pm_update_private_note: 'UpdatePrivateNote', pm_complete_private_note: 'CompletePrivateNote',
  pm_reopen_private_note: 'ReopenPrivateNote', pm_delete_private_note: 'DeletePrivateNote', pm_create_project_meeting: 'CreateProjectMeeting',
  pm_update_project_meeting: 'UpdateProjectMeeting', pm_cancel_project_meeting: 'CancelProjectMeeting', pm_watch_task: 'WatchTask', pm_unwatch_task: 'UnwatchTask',
  pm_start_timer: 'StartTimer', pm_stop_timer: 'StopTimer', pm_record_manual_worklog: 'RecordManualWorklog', pm_set_presence_preference: 'SetPresencePreference',
  pm_heartbeat_presence: 'HeartbeatPresence', pm_set_project_health: 'SetProjectHealth', pm_set_project_budget: 'SetProjectBudget',
  pm_set_project_remaining_estimate: 'SetProjectRemainingEstimate', pm_record_project_spend: 'RecordProjectSpend', pm_void_project_spend: 'VoidProjectSpend',
  pm_correct_project_spend: 'CorrectProjectSpend', pm_set_project_dependencies: 'SetProjectDependencies', pm_update_task_duration: 'UpdateTaskDuration',
  pm_update_planning_milestone: 'UpdateMilestone',
} as const satisfies Partial<Record<DashboardToolName, string>>;
export type DashboardWriteToolName = keyof typeof DashboardCommandActions;
const selfWrites: Readonly<Record<string, true>> = { pm_create_private_note: true, pm_update_private_note: true, pm_complete_private_note: true, pm_reopen_private_note: true, pm_delete_private_note: true, pm_watch_task: true, pm_unwatch_task: true, pm_start_timer: true, pm_stop_timer: true, pm_record_manual_worklog: true, pm_set_presence_preference: true, pm_heartbeat_presence: true };
const descriptions: Record<DashboardToolName, string> = {
  pm_read_private_notes: 'Read a bounded page of the current actor’s private notes. Never reads another user’s notes.',
  pm_read_project_meetings: 'Read saved authorized project meetings, including cancellation facts; does not join or create a meeting.',
  pm_read_meeting_participants: 'Read the existing meeting-participant directory projection. Restricted members see only themselves; this is not an access grant.',
  pm_read_task_watches: 'Read the actor’s currently visible active task watches. Watching is a server subscription fact, not task completion.',
  pm_read_presence: 'Read current presence preference, heartbeat and TTL-derived status without creating a heartbeat. Not durable task state.',
  pm_read_timer: 'Read the actor’s actual active server timer, redacting unavailable task references. Cancelling this read does not stop a timer.',
  pm_read_worklogs: 'Read immutable personal worklogs and server-computed personal calendar totals; totals are actor-wide, not page or project sums.',
  pm_read_portfolio: 'Read manual health/risk/confidence and financial records separately from computed actual/forecast totals. Sections are bounded; amounts retain currency and minor units.',
  pm_read_planning: 'Read the authoritative planning aggregate. Dependencies and tasks are separate bounded sections; unknown duration is not zero.',
  pm_read_critical_path: 'Read the existing server critical-path analysis; tasks, path nodes and unavailability reasons have separate pages. Missing data never receives invented estimates.',
  pm_read_sprint_metrics: 'Read current sprint counts and retained observed history. History is not reconstructed pre-capture burndown; history-members pages retain exact observed membership.',
  pm_create_private_note: 'Create an actor-owned private note through the original command service.',
  pm_update_private_note: 'Update an actor-owned private note at the supplied original expected version.',
  pm_complete_private_note: 'Complete an actor-owned note at the supplied expected version; not a PM task transition.',
  pm_reopen_private_note: 'Reopen an actor-owned completed note at the supplied expected version.',
  pm_delete_private_note: 'Soft-delete an actor-owned private note at the supplied expected version.',
  pm_create_project_meeting: 'Create a project meeting with active authorized participants and a valid interval through the original service.',
  pm_update_project_meeting: 'Update a noncancelled project meeting at its expected version, retaining original participant validation.',
  pm_cancel_project_meeting: 'Cancel a project meeting with an explicit reason and expected version; does not delete history.',
  pm_watch_task: 'Persist the actor’s task watch through the existing subscription service; duplicate watches reuse the existing fact.',
  pm_unwatch_task: 'Stop the actor’s existing task watch using the watch record ID and expected version.',
  pm_start_timer: 'Start the actor’s single server timer for an authorized task. The server serializes competing starts; no automatic retry.',
  pm_stop_timer: 'Stop the original actor-owned server timer once at its expected version, even after task access is revoked. CLI cancellation never implies stop.',
  pm_record_manual_worklog: 'Record an actual past work interval through the server’s immutable worklog service. No edit/delete operation exists.',
  pm_set_presence_preference: 'Set only the actor’s online/away intent using its independent expected version; does not manufacture a heartbeat.',
  pm_heartbeat_presence: 'Explicitly record the actor’s heartbeat using its independent expected version; ordinary reads never heartbeat.',
  pm_set_project_health: 'Append a manual health/risk/confidence assessment using original project and health-record expected versions. Null confidence means unknown.',
  pm_set_project_budget: 'Set currency, budget and remaining estimate in integer minor units; preserve native currency-lock, calendar-date and CAS rules.',
  pm_set_project_remaining_estimate: 'Set an explicit manual remaining estimate; native service computes the forecast and appends immutable financial history.',
  pm_record_project_spend: 'Append real spend to an existing project budget with original expected versions; no floating-point currency conversion.',
  pm_void_project_spend: 'Append a void fact for an existing spend entry; immutable ledger history remains intact.',
  pm_correct_project_spend: 'Atomically void the original spend and append its explicit correction through the native ledger service.',
  pm_set_project_dependencies: 'Change project dependencies through the authoritative Markdown command adapter with original CAS; never recomputes validators.',
  pm_update_task_duration: 'Set or explicitly clear task duration through the authoritative native planning command; unknown is distinct from zero.',
  pm_update_planning_milestone: 'Update supported milestone name/date/criteria through the original native planning adapter, preserving omitted metadata.',
};
export const DashboardToolMetadata = Object.fromEntries((Object.keys(DashboardToolInputSchemas) as DashboardToolName[]).map(name => {
  const write = Object.hasOwn(DashboardCommandActions, name);
  return [name, { description: descriptions[name], write, capabilities: (write && !Object.hasOwn(selfWrites, name) ? ['domain.read', 'planning.edit'] : ['domain.read']) as Capability[], scope: 'project' as const }];
})) as Record<DashboardToolName, { description: string; write: boolean; capabilities: Capability[]; scope: 'project' }>;
