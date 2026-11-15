import { z } from 'zod';
import type { Command, CommandReceipt } from '../domain/src/core.ts';
import { DashboardCommandActions, DashboardReadResources, DashboardToolInputSchemas, type DashboardToolName, type DashboardWriteToolName } from '../application/src/agent-tool-dashboard.ts';
import { projectDashboardRead, projectDashboardReceipt, type DashboardReadData } from '../application/src/dashboard-tool-projection.ts';
import { inputFile, nonempty, parseOptions, type CliFamily } from './runtime.ts';

const writes: Readonly<Record<string, Readonly<Record<string, DashboardWriteToolName>>>> = {
  notes: { create: 'pm_create_private_note', update: 'pm_update_private_note', complete: 'pm_complete_private_note', reopen: 'pm_reopen_private_note', delete: 'pm_delete_private_note' },
  meetings: { create: 'pm_create_project_meeting', update: 'pm_update_project_meeting', cancel: 'pm_cancel_project_meeting' },
  watch: { add: 'pm_watch_task', remove: 'pm_unwatch_task' },
  presence: { set: 'pm_set_presence_preference', heartbeat: 'pm_heartbeat_presence' },
  timer: { start: 'pm_start_timer', stop: 'pm_stop_timer' },
  worklog: { record: 'pm_record_manual_worklog' },
  portfolio: { 'set-health': 'pm_set_project_health', 'set-budget': 'pm_set_project_budget', 'set-remaining-estimate': 'pm_set_project_remaining_estimate', 'record-spend': 'pm_record_project_spend', 'void-spend': 'pm_void_project_spend', 'correct-spend': 'pm_correct_project_spend' },
  planning: { 'set-dependencies': 'pm_set_project_dependencies', 'set-duration': 'pm_update_task_duration', 'update-milestone': 'pm_update_planning_milestone' },
};
const reads: Readonly<Record<string, Readonly<Record<string, { name: DashboardToolName; endpoint: string; section?: string }>>>> = {
  notes: { list: { name: DashboardReadResources.notes, endpoint: 'personal' } },
  meetings: { list: { name: DashboardReadResources.meetings, endpoint: 'personal' }, participants: { name: DashboardReadResources['meeting-participants'], endpoint: 'personal' } },
  watch: { list: { name: DashboardReadResources.watch, endpoint: 'personal' } },
  presence: { read: { name: DashboardReadResources.presence, endpoint: 'time' } },
  timer: { read: { name: DashboardReadResources.timer, endpoint: 'time' } },
  worklog: { list: { name: DashboardReadResources.worklog, endpoint: 'time' }, totals: { name: DashboardReadResources.worklog, endpoint: 'time' } },
  portfolio: {
    current: { name: DashboardReadResources.portfolio, endpoint: 'portfolio', section: 'current' },
    'health-history': { name: DashboardReadResources.portfolio, endpoint: 'portfolio', section: 'health-history' },
    spend: { name: DashboardReadResources.portfolio, endpoint: 'portfolio', section: 'spend' },
    'financial-history': { name: DashboardReadResources.portfolio, endpoint: 'portfolio', section: 'financial-history' },
    totals: { name: DashboardReadResources.portfolio, endpoint: 'portfolio', section: 'current' },
  },
  planning: {
    projects: { name: DashboardReadResources.planning, endpoint: 'planning', section: 'projects' },
    dependencies: { name: DashboardReadResources.planning, endpoint: 'planning', section: 'dependencies' },
    tasks: { name: DashboardReadResources.planning, endpoint: 'planning', section: 'tasks' },
    milestones: { name: DashboardReadResources.planning, endpoint: 'planning', section: 'milestones' },
    'critical-path': { name: DashboardReadResources['critical-path'], endpoint: 'planning' },
  },
  'sprint-metrics': {
    sprints: { name: DashboardReadResources['sprint-metrics'], endpoint: 'sprints', section: 'sprints' },
    tasks: { name: DashboardReadResources['sprint-metrics'], endpoint: 'sprints', section: 'tasks' },
    history: { name: DashboardReadResources['sprint-metrics'], endpoint: 'sprints', section: 'history' },
    'history-members': { name: DashboardReadResources['sprint-metrics'], endpoint: 'sprints', section: 'history-members' },
  },
};

export const dashboardFamily: CliFamily = {
  help: `  notes list [--after OFFSET] [--limit 1..20]
  notes create|update|complete|reopen|delete --command-id UUID --file JSON_OR_YAML
  meetings list [--project ID] [--after OFFSET] [--limit 1..20]
  meetings participants --project ID [--after OFFSET] [--limit 1..20]
  meetings create|update|cancel --command-id UUID --file JSON_OR_YAML
  watch list [--project ID] [--after OFFSET] [--limit 1..20]
  watch add|remove --command-id UUID --file JSON_OR_YAML
  presence read [--after OFFSET] [--limit 1..20]
  presence set|heartbeat --command-id UUID --file JSON_OR_YAML
  timer read
  timer start|stop --command-id UUID --file JSON_OR_YAML
  worklog list [--project ID] [--after OFFSET] [--limit 1..20]
  worklog totals
  worklog record --command-id UUID --file JSON_OR_YAML
  portfolio current|health-history|spend|financial-history [--project ID] [--after OFFSET] [--limit 1..20]
  portfolio totals
  portfolio set-health|set-budget|set-remaining-estimate|record-spend|void-spend|correct-spend --command-id UUID --file JSON_OR_YAML
  planning projects|dependencies|tasks|milestones [--project ID] [--after OFFSET] [--limit 1..20]
  planning critical-path --project ID [--section tasks|paths|reasons] [--after OFFSET] [--limit 1..20]
  planning set-dependencies|set-duration|update-milestone --command-id UUID --file JSON_OR_YAML
  sprint-metrics sprints|tasks|history|history-members [--project ID] [--sprint ID] [--after OFFSET] [--limit 1..20]
  Dashboard writes: file has payload plus projectId/targetId/expectedVersions when required.
  IDs/expected versions are original service values. No write retries; retain --command-id for receipt lookup.
  Presence reads do not heartbeat. Exiting/cancelling the CLI does not stop a server timer.
  Worklog totals are actor-wide server facts; portfolio --project omits all-project totals (use portfolio totals separately).`,
  async dispatch(args, runtime) {
    const [resource, action, ...rest] = args;
    if (!resource || !Object.hasOwn(reads, resource) && !Object.hasOwn(writes, resource)) return false;
    const write = action && Object.hasOwn(writes[resource] ?? {}, action) ? writes[resource]![action] : undefined;
    if (write) {
      const options = parseOptions(rest, ['command-id', 'file']);
      const commandId = z.uuid().toLowerCase().parse(nonempty(options['command-id'], '--command-id'));
      const input = DashboardToolInputSchemas[write].parse({ projectId: null, targetId: null, expectedVersions: null, ...await inputFile(options.file) }) as { projectId: string | null; targetId: string | null; expectedVersions: Record<string, number> | null; payload: Record<string, unknown> };
      const command: Command = { commandId, commandType: DashboardCommandActions[write], payload: input.payload,
        ...(input.projectId ? { projectId: input.projectId } : {}), ...(input.targetId ? { targetId: input.targetId } : {}), ...(input.expectedVersions ? { expectedVersions: input.expectedVersions } : {}) };
      runtime.print(projectDashboardReceipt(command, await runtime.json<CommandReceipt>('workspace', '/commands', { method: 'POST', body: command }), commandId));
      return true;
    }
    const read = action && Object.hasOwn(reads[resource] ?? {}, action) ? reads[resource]![action] : undefined;
    if (!read) throw new Error(`Unknown ${resource} action.\n${dashboardFamily.help.split('\n').filter(line => line.trimStart().startsWith(`${resource} `)).join('\n')}`);
    const paged = read.name !== 'pm_read_timer' && action !== 'totals';
    const projectScoped = ['pm_read_project_meetings', 'pm_read_meeting_participants', 'pm_read_task_watches', 'pm_read_worklogs', 'pm_read_portfolio', 'pm_read_planning', 'pm_read_critical_path', 'pm_read_sprint_metrics'].includes(read.name) && action !== 'totals';
    const options = parseOptions(rest, [...(paged ? ['after', 'limit'] : []), ...(projectScoped ? ['project'] : []), ...(read.name === 'pm_read_critical_path' ? ['section'] : []), ...(read.name === 'pm_read_sprint_metrics' ? ['sprint'] : [])]);
    const input = read.name === 'pm_read_timer' ? {} : {
      after: options.after ?? null, limit: options.limit === undefined ? 20 : Number(options.limit),
      ...(projectScoped || read.name === 'pm_read_worklogs' || read.name === 'pm_read_portfolio' ? { projectId: options.project ?? null } : {}),
      ...(read.section ? { section: read.section } : {}),
      ...(read.name === 'pm_read_critical_path' ? { section: options.section ?? 'tasks' } : {}),
      ...(read.name === 'pm_read_sprint_metrics' ? { sprintId: options.sprint ?? null } : {}),
    };
    const parsed = DashboardToolInputSchemas[read.name].parse(input);
    const data = await runtime.json<DashboardReadData>('workspace', `/dashboard/${read.endpoint}`);
    const result = projectDashboardRead(read.name, parsed, data);
    if (action === 'totals' && (result.kind === 'dashboard_worklogs' || result.kind === 'dashboard_portfolio')) runtime.print({ ...result, items: [], nextCursor: null, truncated: false });
    else runtime.print(result);
    return true;
  },
};
