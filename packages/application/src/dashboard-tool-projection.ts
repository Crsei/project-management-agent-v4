import { createHash } from 'node:crypto';
import { DomainError, type Command, type CommandReceipt } from '../../domain/src/core.ts';
import type { PersonalDashboard } from '../../domain/src/dashboard-personal.ts';
import type { TimeDashboard } from '../../domain/src/dashboard-time.ts';
import type { PortfolioDashboard } from '../../domain/src/dashboard-portfolio.ts';
import type { PlanningDashboard } from '../../domain/src/dashboard-planning.ts';
import type { SprintsDashboard } from '../../domain/src/dashboard-sprints.ts';
import { DashboardToolResultSchema, type DashboardToolResult } from '../../agent-contracts/src/pm-tool-dashboard.ts';
import type { AgentChatToolReceipt } from '../../agent-contracts/src/pm-tool-shared.ts';
import { DashboardToolInputSchemas, type DashboardToolName } from './agent-tool-dashboard.ts';

type Page = { after: string | null; limit: number };
/** Projection offsets select an existing service result; they are not business revisions or snapshot guarantees. */
function page<T>(items: readonly T[], input: Page) {
  const start = input.after === null ? 0 : Number(input.after);
  if (!Number.isSafeInteger(start) || start < 0) throw new DomainError('invalid_cursor', 'Invalid dashboard projection cursor');
  const selected = items.slice(start, start + input.limit);
  const next = start + selected.length;
  return { items: selected, nextCursor: next < items.length ? String(next) : null, truncated: next < items.length, sources: [] };
}
export type DashboardReadData = PersonalDashboard | TimeDashboard | PortfolioDashboard | PlanningDashboard | SprintsDashboard;
/** Bounded selections only. All counts, durations, forecasts and critical paths come from the native service. */
export function projectDashboardRead(name: DashboardToolName, input: unknown, data: DashboardReadData, selectedPortfolioTotals = false): DashboardToolResult {
  let result: unknown;
  switch (name) {
    case 'pm_read_private_notes': {
      const args = DashboardToolInputSchemas[name].parse(input);
      result = { kind: 'dashboard_notes', ...page((data as PersonalDashboard).notes, args) }; break;
    }
    case 'pm_read_project_meetings': {
      const args = DashboardToolInputSchemas[name].parse(input);
      result = { kind: 'dashboard_meetings', ...page((data as PersonalDashboard).meetings.filter(row => !args.projectId || row.projectId === args.projectId), args) }; break;
    }
    case 'pm_read_meeting_participants': {
      const args = DashboardToolInputSchemas[name].parse(input), dashboard = data as PersonalDashboard;
      const participants = dashboard.meetingParticipants.filter(row => row.projectIds === null || row.projectIds.includes(args.projectId)).map(({ userId, name }) => ({ userId, name }));
      result = { kind: 'dashboard_meeting_participants', canListParticipants: dashboard.canListParticipants, ...page(participants, args) }; break;
    }
    case 'pm_read_task_watches': {
      const args = DashboardToolInputSchemas[name].parse(input);
      result = { kind: 'dashboard_watches', ...page((data as PersonalDashboard).watches.filter(row => !args.projectId || row.projectId === args.projectId), args) }; break;
    }
    case 'pm_read_timer': {
      DashboardToolInputSchemas[name].parse(input);
      const dashboard = data as TimeDashboard;
      result = { kind: 'dashboard_timer', activeTimer: dashboard.activeTimer, serverNow: dashboard.serverNow, nextCursor: null, truncated: false, sources: [] }; break;
    }
    case 'pm_read_presence': {
      const args = DashboardToolInputSchemas[name].parse(input), dashboard = data as TimeDashboard;
      result = { kind: 'dashboard_presence', self: dashboard.presence.self, serverNow: dashboard.serverNow, directoryVisible: dashboard.presence.directoryVisible, ttlMs: dashboard.presence.ttlMs, ...page(dashboard.presence.members, args) }; break;
    }
    case 'pm_read_worklogs': {
      const args = DashboardToolInputSchemas[name].parse(input), dashboard = data as TimeDashboard;
      result = { kind: 'dashboard_worklogs', totals: dashboard.totals, totalsScope: 'actor', timeZone: dashboard.timeZone, serverNow: dashboard.serverNow, ...page(dashboard.worklogs.filter(row => !args.projectId || row.task.projectId === args.projectId), args) }; break;
    }
    case 'pm_read_portfolio': {
      const args = DashboardToolInputSchemas[name].parse(input), dashboard = data as PortfolioDashboard;
      const projects = dashboard.projects.filter(row => !args.projectId || row.projectId === args.projectId);
      const items = projects.flatMap((row): unknown[] => {
        if (args.section === 'current') return [{ row: 'current', projectId: row.projectId, health: row.health, budget: row.budget }];
        if (args.section === 'health-history') return row.healthHistory.map(assessment => ({ row: 'health-history', projectId: row.projectId, assessment }));
        if (args.section === 'spend') return row.spend.map(spend => ({ row: 'spend', projectId: row.projectId, spend }));
        return row.financialHistory.map(snapshot => ({ row: 'financial-history', projectId: row.projectId, snapshot }));
      });
      // A client selecting one project must not relabel all-project totals as filtered totals.
      const includeTotals = !args.projectId || selectedPortfolioTotals;
      const totalsProjectScope = includeTotals ? createHash('sha256').update(JSON.stringify(projects.map(row => row.projectId).sort())).digest('hex') : null;
      result = { kind: 'dashboard_portfolio', section: args.section, totals: includeTotals ? dashboard.totals : null, totalsProjectScope, ...page(items, args) }; break;
    }
    case 'pm_read_planning': {
      const args = DashboardToolInputSchemas[name].parse(input), dashboard = data as PlanningDashboard;
      let items: unknown[];
      if (args.section === 'projects') items = dashboard.projects.filter(row => !args.projectId || row.id === args.projectId).map(({ id, title, version, hasUnavailableDependencies, editable, criticalPath }) => ({ row: 'project', id, title, version, hasUnavailableDependencies, editable, criticalPathStatus: criticalPath.status, durationDays: criticalPath.status === 'available' ? criticalPath.durationDays : null }));
      else if (args.section === 'dependencies') items = dashboard.projects.filter(row => !args.projectId || row.id === args.projectId).flatMap(row => row.dependsOn.map(dependsOnProjectId => ({ row: 'dependency', projectId: row.id, dependsOnProjectId })));
      else if (args.section === 'tasks') items = dashboard.tasks.filter(row => !args.projectId || row.projectId === args.projectId).map(row => ({ row: 'task', ...row }));
      else items = dashboard.milestones.filter(row => !args.projectId || row.projectId === args.projectId).map(row => ({ row: 'milestone', ...row }));
      result = { kind: 'dashboard_planning', section: args.section, ...page(items, args) }; break;
    }
    case 'pm_read_critical_path': {
      const args = DashboardToolInputSchemas[name].parse(input), dashboard = data as PlanningDashboard;
      const project = dashboard.projects.find(row => row.id === args.projectId);
      if (!project) throw new DomainError('not_found_or_forbidden', 'Project is not accessible', 404);
      const analysis = project.criticalPath;
      let items: unknown[] = [];
      if (analysis.status === 'available' && args.section === 'tasks') items = analysis.tasks.map(row => ({ row: 'task', ...row }));
      if (analysis.status === 'available' && args.section === 'paths') items = analysis.criticalPaths.flatMap((path, pathIndex) => path.map((taskId, position) => ({ row: 'path-node', pathIndex, position, taskId })));
      if (analysis.status === 'unavailable' && args.section === 'reasons') items = analysis.reasons.map(reason => ({ row: 'reason', ...reason }));
      result = { kind: 'dashboard_critical_path', projectId: args.projectId, section: args.section, status: analysis.status, durationDays: analysis.status === 'available' ? analysis.durationDays : null, model: analysis.status === 'available' ? analysis.model : null, ...page(items, args) }; break;
    }
    case 'pm_read_sprint_metrics': {
      const args = DashboardToolInputSchemas[name].parse(input), dashboard = data as SprintsDashboard;
      let items: unknown[];
      if (args.section === 'sprints') items = dashboard.sprints.filter(row => (!args.projectId || row.projectId === args.projectId) && (!args.sprintId || row.id === args.sprintId)).map(({ taskIds: _taskIds, ...row }) => ({ row: 'sprint', ...row, current: dashboard.currentSprintIds.includes(row.id) }));
      else if (args.section === 'tasks') items = dashboard.tasks.filter(row => (!args.projectId || row.projectId === args.projectId) && (!args.sprintId || row.sprintId === args.sprintId)).map(row => ({ row: 'task', ...row }));
      else items = dashboard.history.observations.flatMap((observation): unknown[] => {
        const { sprints, ...metadata } = observation;
        const selected = sprints.filter(row => (!args.projectId || row.projectId === args.projectId) && (!args.sprintId || row.id === args.sprintId));
        if (args.section === 'history-members') return selected.flatMap(sprint => sprint.taskIds.map(taskId => ({ row: 'history-member', ...metadata, sprintId: sprint.id, projectId: sprint.projectId, taskId })));
        if (!selected.length && !observation.complete) return [{ row: 'history', ...metadata, sprint: null }];
        return selected.map(({ taskIds: _taskIds, ...sprint }) => ({ row: 'history', ...metadata, sprint }));
      });
      result = { kind: 'dashboard_sprint_metrics', section: args.section, historyStatus: dashboard.history.status, historyError: dashboard.history.error, semantics: dashboard.history.semantics, ...page(items, args) }; break;
    }
    default: throw new DomainError('agent_tool_not_available', 'Not a dashboard read', 403);
  }
  return DashboardToolResultSchema.parse(result);
}

/** Receipt-only writes never re-expose historical private text or revoked task references. */
export function projectDashboardReceipt(command: Command, native: CommandReceipt, operationId: string, linkage?: AgentChatToolReceipt['linkage']): DashboardToolResult {
  if (native.commandId !== command.commandId) throw new DomainError('command_id_conflict', 'The native receipt has a different command identity', 409);
  if (native.status !== 'committed') throw new DomainError(native.error?.code ?? 'command_rejected', native.error?.message ?? 'The original command was rejected', native.httpStatus);
  const result = native.result && typeof native.result === 'object' ? native.result as { id?: unknown; version?: unknown; timerId?: unknown } : null;
  const targetId = command.targetId ?? (typeof result?.id === 'string' ? result.id : typeof result?.timerId === 'string' ? result.timerId : null);
  const revision = typeof result?.version === 'number' ? String(result.version) : null;
  return DashboardToolResultSchema.parse({ kind: 'dashboard_receipt', action: command.commandType, nextCursor: null, truncated: false, sources: [], receipt: { kind: 'command', operationId, commandId: native.commandId, action: command.commandType, targetId, revision, ...(linkage ? { linkage } : {}) } });
}
