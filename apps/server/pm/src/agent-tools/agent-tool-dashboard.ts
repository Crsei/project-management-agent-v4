import type { Actor, Command, CommandReceipt } from '../../../../../packages/domain/src/core.ts';
import { DomainError } from '../../../../../packages/domain/src/core.ts';
import type { CoreAccess, SqlExecutor } from '../../../../../packages/application/src/ports.ts';
import type { DashboardReadContext } from '../../../../../packages/application/src/dashboard-read.ts';
import { readPersonalDashboard } from '../../../../../packages/application/src/dashboard-personal.ts';
import { readTimeDashboard } from '../../../../../packages/application/src/dashboard-time.ts';
import { readPortfolioDashboard } from '../../../../../packages/application/src/dashboard-portfolio.ts';
import { scopePortfolioDashboard } from '../../../../../packages/domain/src/dashboard-portfolio.ts';
import { readPlanningDashboard } from '../../../../../packages/application/src/dashboard-planning.ts';
import { readSprintsDashboard } from '../../../../../packages/application/src/dashboard-sprints.ts';
import { DashboardToolInputSchemas, DashboardCommandActions, type DashboardToolName, type DashboardWriteToolName } from '../../../../../packages/application/src/agent-tool-dashboard.ts';
import { projectDashboardRead, projectDashboardReceipt, type DashboardReadData } from '../../../../../packages/application/src/dashboard-tool-projection.ts';
import { assertAgentToolNotAborted, assertAgentToolProject, type AgentChatToolContext } from '../../../../../packages/application/src/agent-chat-tools.ts';
import { requestHash } from '../../../../../packages/application/src/kernel.ts';
import { DashboardToolResultSchema } from '../../../../../packages/agent-contracts/src/pm-tool-dashboard.ts';
import type { AgentChatToolFamily, AgentChatToolName } from './agent-chat-tools.ts';

export type DashboardToolDependencies = {
  readDashboard<T>(actor: Actor, workspaceId: string, reader: (ctx: DashboardReadContext) => Promise<T>): Promise<T>;
  coreAccessFor(actor: Actor, workspaceId: string, sql: SqlExecutor): Promise<CoreAccess>;
  executeCommand(actor: Actor, workspaceId: string, command: Command, checkAuthorization?: AgentChatToolContext['checkAuthorization']): Promise<CommandReceipt>;
  readCommandReceipt(actor: Actor, workspaceId: string, command: Command): Promise<CommandReceipt | null>;
};
function ownName(name: string): DashboardToolName {
  if (!Object.hasOwn(DashboardToolInputSchemas, name)) throw new DomainError('agent_tool_not_available', 'Not a dashboard tool', 403);
  return name as DashboardToolName;
}
function nativeCommand(name: DashboardToolName, input: unknown, operationId: string): Command | null {
  if (!Object.hasOwn(DashboardCommandActions, name)) return null;
  const args = DashboardToolInputSchemas[name].parse(input) as { projectId: string | null; targetId: string | null; expectedVersions: Record<string, number> | null; payload: Record<string, unknown> };
  return { commandId: operationId, commandType: DashboardCommandActions[name as DashboardWriteToolName], payload: args.payload,
    ...(args.projectId ? { projectId: args.projectId } : {}), ...(args.targetId ? { targetId: args.targetId } : {}),
    ...(args.expectedVersions ? { expectedVersions: args.expectedVersions } : {}) };
}
/** Same current membership, narrowed further by the explicit tool project set. */
function scopedRead(ctx: DashboardReadContext, context: AgentChatToolContext): DashboardReadContext {
  const allowed = new Set(context.scope.projectIds.filter(id => ctx.membership.projectIds === null || ctx.membership.projectIds.includes(id)));
  const allows = (projectId: string | null | undefined) => !!projectId && allowed.has(projectId);
  const membership = { ...ctx.membership, projectIds: context.scope.kind === 'workspace' && ctx.membership.projectIds === null ? null : [...allowed] };
  return { ...ctx, membership, core: {
    ...ctx.core,
    async get(id, kind) {
      const entity = await ctx.core.get(id, kind);
      if (!allows(entity.kind === 'project' ? entity.id : entity.projectId)) throw new DomainError('not_found_or_forbidden', 'Entity is outside the authorized tool scope', 404);
      return entity;
    },
    async list(kind) { return (await ctx.core.list(kind)).filter(entity => allows(entity.kind === 'project' ? entity.id : entity.projectId)); },
    async records() { return (await ctx.core.records()).filter(file => allows(file.entity.entity === 'project' ? file.id : file.entity.project)); },
    async sprintHistory() {
      const history = await ctx.core.sprintHistory(), current = new Map((await ctx.core.records()).map(file => [file.id, file]));
      const visibleNow = (id: string) => { const file = current.get(id); return !file || allows(file.entity.entity === 'project' ? file.id : file.entity.project); };
      return { ...history, observations: history.observations.map(observation => ({ ...observation,
        invalidRecordIds: observation.invalidRecordIds.filter(id => current.has(id) && visibleNow(id)),
        cycles: observation.cycles.filter(cycle => allows(cycle.projectId) && visibleNow(cycle.id)).map(cycle => ({ ...cycle, tasks: cycle.tasks.filter(task => allows(task.projectId) && visibleNow(task.id)) })),
      })) };
    },
  } };
}

export function createDashboardToolFamily(options: DashboardToolDependencies): AgentChatToolFamily {
  async function read(name: DashboardToolName, input: unknown, context: AgentChatToolContext): Promise<DashboardReadData> {
    const args = DashboardToolInputSchemas[name].parse(input) as { projectId?: string | null };
    if (args.projectId) assertAgentToolProject(context.scope, args.projectId);
    return options.readDashboard(context.actor, context.workspaceId, async native => {
      const ctx = scopedRead(native, context);
      if (name === 'pm_read_private_notes' || name === 'pm_read_project_meetings' || name === 'pm_read_task_watches' || name === 'pm_read_meeting_participants') return readPersonalDashboard(ctx);
      if (name === 'pm_read_presence' || name === 'pm_read_timer' || name === 'pm_read_worklogs') return readTimeDashboard(ctx);
      if (name === 'pm_read_portfolio') {
        const dashboard = await readPortfolioDashboard(ctx);
        return scopePortfolioDashboard(dashboard, context.scope.projectIds, args.projectId ?? undefined);
      }
      if (name === 'pm_read_sprint_metrics') return readSprintsDashboard(ctx);
      return readPlanningDashboard(ctx);
    });
  }
  async function authorizeCommand(command: Command, context: AgentChatToolContext, sql?: SqlExecutor): Promise<void> {
    if (command.projectId) assertAgentToolProject(context.scope, command.projectId);
    const validateCore = async (core: Omit<CoreAccess, 'handles'>) => {
      const taskId = typeof command.payload.taskId === 'string' ? command.payload.taskId : null;
      if (taskId) {
        const task = await core.get(taskId, 'work_item');
        assertAgentToolProject(context.scope, task.projectId ?? undefined);
        if (command.projectId && command.projectId !== task.projectId) throw new DomainError('project_mismatch', 'Task does not belong to the supplied project', 409);
      }
      if (command.commandType === 'UpdateTaskDuration' || command.commandType === 'UpdateMilestone') {
        const target = await core.get(command.targetId!, command.commandType === 'UpdateTaskDuration' ? 'work_item' : 'milestone');
        assertAgentToolProject(context.scope, target.projectId ?? undefined);
        if (target.projectId !== command.projectId) throw new DomainError('project_mismatch', 'Target does not belong to the supplied project', 409);
      }
      if (command.commandType === 'SetProjectDependencies') {
        const project = await core.get(command.targetId!, 'project');
        assertAgentToolProject(context.scope, project.id);
        const records = await core.records(), before = records.find(row => row.id === project.id);
        for (const dependency of new Set([...(before?.entity.depends_on ?? []), ...command.payload.dependsOn as string[]])) {
          assertAgentToolProject(context.scope, dependency);
          await core.get(dependency, 'project');
        }
      }
    };
    if (sql) await validateCore(await options.coreAccessFor(context.actor, context.workspaceId, sql));
    else await options.readDashboard(context.actor, context.workspaceId, ctx => validateCore(scopedRead(ctx, context).core));
  }
  return {
    names: Object.keys(DashboardToolInputSchemas) as AgentChatToolName[],
    async execute(rawName, input, context) {
      const name = ownName(rawName);
      assertAgentToolNotAborted(context);
      const command = nativeCommand(name, input, context.operationId);
      if (!command) return projectDashboardRead(name, input, await read(name, input, context), true);
      await authorizeCommand(command, context);
      assertAgentToolNotAborted(context);
      const native = await options.executeCommand(context.actor, context.workspaceId, command, async sql => {
        await context.checkAuthorization?.(sql);
        assertAgentToolNotAborted(context);
        await authorizeCommand(command, context, sql);
      });
      return projectDashboardReceipt(command, native, context.operationId, context.linkage);
    },
    recoveryIdentity(rawName, input, context) {
      const command = nativeCommand(ownName(rawName), input, context.operationId);
      return command ? { kind: 'command', commandId: command.commandId, action: command.commandType, hash: requestHash(command as unknown as Record<string, unknown>) } : null;
    },
    async recover(rawName, input, context) {
      const command = nativeCommand(ownName(rawName), input, context.operationId);
      if (!command) return null;
      // Do not require a still-visible task to stop/recover a private timer. The native receipt enforces actor ownership and its original scopes.
      if (command.projectId) assertAgentToolProject(context.scope, command.projectId);
      const native = await options.readCommandReceipt(context.actor, context.workspaceId, command);
      if (!native) return null;
      if (native.status !== 'committed' && /unknown|pending|recovered/i.test(native.error?.code ?? '')) return null;
      if (native.status !== 'committed') throw new DomainError('agent_tool_recovered_rejection', 'The original dashboard command was durably rejected', 409);
      return projectDashboardReceipt(command, native, context.operationId, context.linkage);
    },
    async authorizeResult(rawName, input, stored, context) {
      const name = ownName(rawName), result = DashboardToolResultSchema.parse(stored);
      const command = nativeCommand(name, input, context.operationId);
      if (command) {
        if (command.projectId) assertAgentToolProject(context.scope, command.projectId);
        const receipt = await options.readCommandReceipt(context.actor, context.workspaceId, command);
        if (!receipt || receipt.status !== 'committed') throw new DomainError('not_found_or_forbidden', 'Original command result is not currently accessible', 404);
        return;
      }
      const denied = () => { throw new DomainError('not_found_or_forbidden', 'Saved dashboard result is not currently accessible', 404); };
      await options.readDashboard(context.actor, context.workspaceId, async native => {
        const ctx = scopedRead(native, context);
        if (result.kind === 'dashboard_notes') {
          const current = await readPersonalDashboard(ctx);
          if (result.items.some(item => item.ownerId !== context.actor.id || !current.notes.some(row => row.id === item.id))) denied();
        } else if (result.kind === 'dashboard_meetings' || result.kind === 'dashboard_watches') {
          const current = await readPersonalDashboard(ctx), rows = result.kind === 'dashboard_meetings' ? current.meetings : current.watches;
          if (result.items.some(item => !rows.some(row => row.id === item.id && row.projectId === item.projectId))) denied();
        } else if (result.kind === 'dashboard_presence') {
          const current = await readTimeDashboard(ctx);
          if (result.self.userId !== context.actor.id || result.items.some(item => !current.presence.members.some(row => row.userId === item.userId)) || result.directoryVisible && !current.presence.directoryVisible) denied();
        } else if (result.kind === 'dashboard_meeting_participants') {
          const current = await readPersonalDashboard(ctx);
          if (result.canListParticipants && !current.canListParticipants || result.items.some(item => !current.meetingParticipants.some(row => row.userId === item.userId))) denied();
        } else if (result.kind === 'dashboard_timer' || result.kind === 'dashboard_worklogs') {
          const current = await readTimeDashboard(ctx);
          if (result.kind === 'dashboard_worklogs' && result.items.some(item => !current.worklogs.some(row => row.id === item.id && row.task.taskId === item.task.taskId && row.task.projectId === item.task.projectId && (!row.task.unavailable || item.note === '')))) denied();
          if (result.kind === 'dashboard_timer' && result.activeTimer) {
            const timer = result.activeTimer;
            if (current.activeTimer?.id !== timer.id && !current.worklogs.some(row => row.timerId === timer.id)) denied();
            if (timer.task.taskId) await ctx.core.get(timer.task.taskId, 'work_item');
          }
        } else if (result.kind === 'dashboard_portfolio') {
          for (const row of result.items) await ctx.core.get(row.projectId, 'project');
          const args = DashboardToolInputSchemas.pm_read_portfolio.parse(input);
          const current = scopePortfolioDashboard(await readPortfolioDashboard(ctx), context.scope.projectIds, args.projectId ?? undefined);
          const projected = projectDashboardRead(name, input, current, true);
          if (projected.kind !== 'dashboard_portfolio' || result.totalsProjectScope !== projected.totalsProjectScope) denied();
        } else if (result.kind === 'dashboard_planning') {
          for (const row of result.items) {
            if (row.row === 'dependency') { await ctx.core.get(row.projectId, 'project'); await ctx.core.get(row.dependsOnProjectId, 'project'); }
            else await ctx.core.get(row.id);
          }
        } else if (result.kind === 'dashboard_critical_path') {
          await ctx.core.get(result.projectId, 'project');
          for (const row of result.items) {
            if (row.row === 'task') await ctx.core.get(row.id, 'work_item');
            else if (row.row === 'path-node' || row.taskId) await ctx.core.get(row.taskId!, 'work_item');
          }
        } else if (result.kind === 'dashboard_sprint_metrics') {
          const current = await readSprintsDashboard(ctx);
          for (const row of result.items) {
            if (row.row === 'sprint') { if (!current.sprints.some(item => item.id === row.id && item.projectId === row.projectId)) denied(); }
            else if (row.row === 'task') { if (!current.tasks.some(item => item.id === row.id && item.projectId === row.projectId)) denied(); }
            else {
              const observation = current.history.observations.find(item => item.sequence === row.sequence);
              if (!observation) denied();
              if (row.row === 'history' && row.sprint && !observation!.sprints.some(item => item.id === row.sprint!.id && item.projectId === row.sprint!.projectId)) denied();
              if (row.row === 'history-member' && !observation!.sprints.some(item => item.id === row.sprintId && item.projectId === row.projectId && item.taskIds.includes(row.taskId))) denied();
            }
          }
        } else denied();
      });
    },
  };
}
