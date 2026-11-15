import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DashboardToolResultSchema, type DashboardToolResult } from '../packages/agent-contracts/src/pm-tool-dashboard.ts';
import { dashboardFamily } from '../packages/pm-cli/dashboard.ts';
import type { CliRuntime, PmRequestOptions, PmScope } from '../packages/pm-cli/runtime.ts';
import type { Entity } from '../packages/domain/src/core.ts';
import type { TimeDashboard } from '../packages/domain/src/dashboard-time.ts';
import type { PersonalDashboard } from '../packages/domain/src/dashboard-personal.ts';
import type { PortfolioDashboard } from '../packages/domain/src/dashboard-portfolio.ts';
import { sprintRecordVersion } from '../packages/domain/src/dashboard-sprints.ts';
import { requestHash } from '../packages/application/src/kernel.ts';
import { createDashboardFixture, dashboardDatabaseUrl, type DashboardFixture } from './dashboard-fixture.ts';

async function projectTask(f: DashboardFixture, title: string) {
  const project = await f.command<Entity>('CreateProject', { name: title, goal: 'Dashboard CLI behavior', ownerId: f.owner.id, completionCriteria: ['Actual source and receipts'] });
  const task = await f.command<Entity>('CreateWorkItem', { title: `${title} task`, description: 'Authoritative source', acceptanceCriteria: [{ id: randomUUID(), text: 'Do it' }], assigneeId: f.owner.id }, { extra: { projectId: project.id } });
  return { project, task };
}
type DashboardToolRequest = { name: string; arguments: unknown; operationId: string; target: { workspaceId: string; projectId: string | null }; threadId: string; messageId: string; generationId: string };
function request(name: string, args: unknown, workspaceId: string, projectId: string | null, operationId = randomUUID()): DashboardToolRequest {
  return { name, arguments: args, operationId, target: { workspaceId, projectId }, threadId: 'dashboard-cli-tools-test', messageId: 'dashboard-source', generationId: 'isolated' };
}
async function call(f: DashboardFixture, envelope: DashboardToolRequest, cookie = f.ownerCookie): Promise<DashboardToolResult> {
  const response = await f.request<{ status: string; result: unknown }>(`/api/v1/workspaces/${f.workspaceId}/agent-tools/call`, { method: 'POST', cookie, body: envelope });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.status, 'succeeded', JSON.stringify(response.body));
  return DashboardToolResultSchema.parse(response.body.result);
}
/** This transport invokes the actual authenticated HTTP server; it never echoes or mocks application results. */
function cli(f: DashboardFixture, cookie = f.ownerCookie) {
  let printed: unknown;
  const runtime: CliRuntime = {
    async authentication() { return { origin: f.origin, headers: { cookie } }; },
    async connection() { return { origin: f.origin, workspaceId: f.workspaceId, headers: { cookie } }; },
    async json<T>(scope: PmScope, endpoint: string, options: PmRequestOptions = {}) {
      assert.equal(scope, 'workspace');
      const response = await f.request<T>(`/api/v1/workspaces/${f.workspaceId}${endpoint}`, { cookie, ...(options.method ? { method: options.method } : {}), ...(options.body === undefined ? {} : { body: options.body }) });
      if (response.status >= 400) throw new Error(`HTTP ${response.status}: ${JSON.stringify(response.body)}`);
      return response.body;
    },
    async response() { throw new Error('Dashboard JSON commands must not require a raw transport'); },
    print(value) { printed = value; },
  };
  return async (args: string[]) => {
    assert.equal(await dashboardFamily.dispatch(args, runtime), true);
    return DashboardToolResultSchema.parse(printed);
  };
}

describe('Dashboard native CLI and PM tools: real authority and original receipts', { skip: !dashboardDatabaseUrl, timeout: 240_000 }, () => {
  it('keeps notes actor-private, changes actual watches, validates/cancels meetings and never heartbeats on read', async t => {
    const f = await createDashboardFixture({ signal: t.signal }); t.after(() => f.close());
    const { project, task } = await projectTask(f, 'Collaboration');
    const member = await f.member('Readable collaborator');
    await f.command('SetWorkspaceMember', { userId: member.user.id, capabilities: ['domain.read', 'planning.edit'], projectIds: [project.id] });
    const create = request('pm_create_private_note', { projectId: null, targetId: null, expectedVersions: null, payload: { content: 'Only the owner can read this note' } }, f.workspaceId, project.id);
    const created = await call(f, create);
    assert.equal(created.receipt?.commandId, create.operationId);
    assert.equal(created.receipt?.action, 'CreatePrivateNote');
    const notes = await cli(f)(['notes', 'list', '--limit', '1']);
    assert.equal(notes.kind, 'dashboard_notes');
    if (notes.kind !== 'dashboard_notes') throw new Error('Wrong note projection');
    assert.equal(notes.items[0]?.ownerId, f.owner.id);
    assert.equal(notes.items[0]?.data.content, 'Only the owner can read this note');
    const other = await call(f, request('pm_read_private_notes', { after: null, limit: 20 }, f.workspaceId, project.id), member.cookie);
    assert.equal(other.kind, 'dashboard_notes');
    if (other.kind === 'dashboard_notes') assert.deepEqual(other.items, []);
    const watch = await call(f, request('pm_watch_task', { projectId: project.id, targetId: null, expectedVersions: null, payload: { taskId: task.id } }, f.workspaceId, project.id));
    const personal = await f.read<PersonalDashboard>('personal');
    assert.equal(personal.watches[0]?.id, watch.receipt?.targetId);
    await call(f, request('pm_unwatch_task', { projectId: project.id, targetId: personal.watches[0]!.id, expectedVersions: { [personal.watches[0]!.id]: personal.watches[0]!.version }, payload: {} }, f.workspaceId, project.id));
    assert.deepEqual((await f.read<PersonalDashboard>('personal')).watches, []);
    const startsAt = new Date(Date.now() + 3_600_000).toISOString(), endsAt = new Date(Date.now() + 7_200_000).toISOString();
    const meeting = await call(f, request('pm_create_project_meeting', { projectId: project.id, targetId: null, expectedVersions: null, payload: { title: 'Saved meeting', description: 'Real participant guard', startsAt, endsAt, participantIds: [f.owner.id, member.user.id] } }, f.workspaceId, project.id));
    const meetingRecord = (await f.read<PersonalDashboard>('personal')).meetings.find(row => row.id === meeting.receipt?.targetId)!;
    await call(f, request('pm_cancel_project_meeting', { projectId: project.id, targetId: meetingRecord.id, expectedVersions: { [meetingRecord.id]: meetingRecord.version }, payload: { reason: 'Explicit cancellation' } }, f.workspaceId, project.id));
    assert.equal((await f.read<PersonalDashboard>('personal')).meetings[0]?.data.cancellationReason, 'Explicit cancellation');
    const before = await f.pool.query<{ count: string }>("SELECT count(*)::text AS count FROM dashboard_records WHERE kind='presence_heartbeat'");
    await cli(f)(['presence', 'read']);
    await call(f, request('pm_read_presence', { after: null, limit: 20 }, f.workspaceId, null));
    const after = await f.pool.query<{ count: string }>("SELECT count(*)::text AS count FROM dashboard_records WHERE kind='presence_heartbeat'");
    assert.deepEqual(after.rows, before.rows);
    const heartbeat = await call(f, request('pm_heartbeat_presence', { projectId: null, targetId: null, expectedVersions: null, payload: {} }, f.workspaceId, null));
    const preference = await call(f, request('pm_set_presence_preference', { projectId: null, targetId: null, expectedVersions: null, payload: { preference: 'away' } }, f.workspaceId, null));
    const presence = (await f.read<TimeDashboard>('time')).presence.self;
    assert.equal(presence.heartbeatId, heartbeat.receipt?.targetId);
    assert.equal(presence.preferenceId, preference.receipt?.targetId);
    assert.equal(presence.status, 'away');
    let note = notes.items[0]!;
    for (const [name, payload] of [
      ['pm_update_private_note', { content: 'Updated private fact' }],
      ['pm_complete_private_note', {}],
      ['pm_reopen_private_note', {}],
    ] as const) {
      await call(f, request(name, { projectId: null, targetId: note.id, expectedVersions: { [note.id]: note.version }, payload }, f.workspaceId, project.id));
      const current = await cli(f)(['notes', 'list']);
      if (current.kind !== 'dashboard_notes') throw new Error('Wrong note projection');
      note = current.items[0]!;
    }
    const savedRead = request('pm_read_private_notes', { after: null, limit: 20 }, f.workspaceId, project.id);
    await call(f, savedRead);
    await call(f, request('pm_delete_private_note', { projectId: null, targetId: note.id, expectedVersions: { [note.id]: note.version }, payload: {} }, f.workspaceId, project.id));
    const hidden = await f.request(`/api/v1/workspaces/${f.workspaceId}/agent-tools/result`, { method: 'POST', body: savedRead });
    assert.equal(hidden.status, 404, JSON.stringify(hidden.body));
    assert.ok(!JSON.stringify(hidden.body).includes(note.data.content));
    const persisted = await f.pool.query<{ status: string }>('SELECT status FROM pm_agent_tool_operations WHERE operation_id=$1', [savedRead.operationId]);
    assert.equal(persisted.rows[0]?.status, 'succeeded');
    const remaining = await call(f, request('pm_read_private_notes', { after: null, limit: 20 }, f.workspaceId, project.id));
    if (remaining.kind === 'dashboard_notes') assert.deepEqual(remaining.items, []);
  });

  it('retains timer command IDs across duplicate/recovery, records once and leaves a running timer after CLI read exits', async t => {
    const f = await createDashboardFixture({ signal: t.signal }); t.after(() => f.close());
    const { project, task } = await projectTask(f, 'Timer');
    const original = request('pm_start_timer', { projectId: null, targetId: null, expectedVersions: null, payload: { taskId: task.id, note: 'One actual server timer' } }, f.workspaceId, project.id);
    const started = await call(f, original);
    assert.deepEqual(await call(f, original), started);
    const read = await cli(f)(['timer', 'read']);
    assert.equal(read.kind, 'dashboard_timer');
    assert.equal((await f.read<TimeDashboard>('time')).activeTimer?.id, started.receipt?.targetId);
    const competing = await f.send({ commandId: randomUUID(), commandType: 'StartTimer', payload: { taskId: task.id } });
    assert.equal(competing.body.status, 'rejected');
    const timers = await f.pool.query<{ count: string }>("SELECT count(*)::text AS count FROM dashboard_records WHERE kind='time_timer' AND data->>'stoppedAt' IS NULL");
    assert.equal(timers.rows[0]?.count, '1');
    const active = (await f.read<TimeDashboard>('time')).activeTimer!;
    const stopping = request('pm_stop_timer', { projectId: null, targetId: active.id, expectedVersions: { [active.id]: active.version }, payload: {} }, f.workspaceId, project.id);
    const stopped = await call(f, stopping);
    assert.deepEqual(await call(f, stopping), stopped);
    assert.equal((await f.read<TimeDashboard>('time')).worklogs.length, 1);
    await f.pool.query("UPDATE pm_agent_tool_operations SET status='unknown',result=NULL,finished_at=NULL WHERE operation_id=$1", [stopping.operationId]);
    const recovered = await f.request<{ status: string; result: unknown }>(`/api/v1/workspaces/${f.workspaceId}/agent-tools/result`, { method: 'POST', body: stopping });
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.equal(recovered.body.status, 'succeeded');
    assert.deepEqual(DashboardToolResultSchema.parse(recovered.body.result).receipt, stopped.receipt);
    const receipts = await f.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM command_receipts WHERE command_id=$1', [stopping.operationId]);
    assert.equal(receipts.rows[0]?.count, '1');
    const nativeReceipt = await f.pool.query<{ request_hash: string }>('SELECT request_hash FROM command_receipts WHERE command_id=$1', [stopping.operationId]);
    assert.equal(nativeReceipt.rows[0]?.request_hash, requestHash({ commandId: stopping.operationId, commandType: 'StopTimer', targetId: active.id, expectedVersions: { [active.id]: active.version }, payload: {} }));
    assert.equal((await f.read<TimeDashboard>('time')).worklogs.length, 1);
    const manual = request('pm_record_manual_worklog', { projectId: null, targetId: null, expectedVersions: null, payload: { taskId: task.id, startedAt: '2026-01-01T23:30:00Z', endedAt: '2026-01-02T00:30:00Z', note: 'Cross-day actual interval' } }, f.workspaceId, project.id);
    await call(f, manual);
    const logs = await cli(f)(['worklog', 'list', '--project', project.id]);
    if (logs.kind !== 'dashboard_worklogs') throw new Error('Wrong worklog projection');
    assert.equal(logs.items.find(row => row.note === 'Cross-day actual interval')?.durationMs, 3_600_000);
    assert.deepEqual(logs.totals, (await f.read<TimeDashboard>('time')).totals);
  });

  it('keeps manual health separate, preserves budget/spend versions and reports real forecasts without CLI calculation', async t => {
    const f = await createDashboardFixture({ signal: t.signal }); t.after(() => f.close());
    const first = await projectTask(f, 'Portfolio first'), second = await projectTask(f, 'Portfolio hidden');
    await call(f, request('pm_set_project_health', { projectId: first.project.id, targetId: first.project.id, expectedVersions: { [first.project.id]: first.project.version }, payload: { status: 'at_risk', confidence: null, rationale: 'Human assessment', risks: [{ description: 'Capacity', severity: 'high', mitigation: 'Explicit mitigation' }] } }, f.workspaceId, first.project.id));
    await call(f, request('pm_set_project_budget', { projectId: first.project.id, targetId: first.project.id, expectedVersions: { [first.project.id]: first.project.version }, payload: { currency: 'USD', budgetMinor: 10000, remainingEstimateMinor: 3000, asOfDate: '2026-01-01', reason: 'Manual budget' } }, f.workspaceId, first.project.id));
    const budget = (await f.read<PortfolioDashboard>('portfolio')).projects.find(row => row.projectId === first.project.id)!.budget!;
    await call(f, request('pm_record_project_spend', { projectId: first.project.id, targetId: first.project.id, expectedVersions: { [first.project.id]: first.project.version, [budget.id]: budget.version }, payload: { currency: 'USD', amountMinor: 1200, spentOn: '2026-01-01', description: 'Actual ledger spend' } }, f.workspaceId, first.project.id));
    const selected = await cli(f)(['portfolio', 'current', '--project', first.project.id]);
    if (selected.kind !== 'dashboard_portfolio') throw new Error('Wrong financial projection');
    const row = selected.items[0];
    if (row?.row !== 'current') throw new Error('Wrong portfolio section');
    assert.equal(row.health?.data.status, 'at_risk');
    assert.equal(row.health?.data.confidence, null);
    assert.equal(row.budget?.actualMinor, 1200);
    assert.equal(row.budget?.forecastMinor, 4200);
    assert.equal(selected.totals, null);
    const scoped = await call(f, request('pm_read_portfolio', { projectId: first.project.id, section: 'current', after: null, limit: 20 }, f.workspaceId, first.project.id));
    if (scoped.kind !== 'dashboard_portfolio') throw new Error('Wrong PM portfolio projection');
    assert.equal(scoped.totals?.[0]?.projectCount, 1);
    assert.ok(!JSON.stringify(scoped).includes(second.project.id));
  });

  it('projects changed native duration/dependency sources and real sprint observations, with hidden projects excluded', async t => {
    const f = await createDashboardFixture({ signal: t.signal }); t.after(() => f.close());
    const { project, task } = await projectTask(f, 'Planning actual source');
    const other = await projectTask(f, 'Outside explicit tool scope');
    const root = await mkdtemp(join(tmpdir(), 'dashboard-cli-input-')); t.after(() => rm(root, { recursive: true, force: true }));
    const file = join(root, 'duration.json');
    await writeFile(file, JSON.stringify({ projectId: project.id, targetId: task.id, expectedVersions: { [task.id]: task.version }, payload: { estimatedDurationDays: 3 } }));
    const saved = await cli(f)(['planning', 'set-duration', '--command-id', randomUUID(), '--file', file]);
    assert.equal(saved.receipt?.action, 'UpdateTaskDuration');
    const analysis = await cli(f)(['planning', 'critical-path', '--project', project.id]);
    if (analysis.kind !== 'dashboard_critical_path') throw new Error('Wrong critical path projection');
    assert.equal(analysis.status, 'available');
    assert.equal(analysis.durationDays, 3);
    await writeFile(file, JSON.stringify({ projectId: project.id, targetId: project.id, expectedVersions: { [project.id]: project.version }, payload: { dependsOn: [other.project.id] } }));
    await cli(f)(['planning', 'set-dependencies', '--command-id', randomUUID(), '--file', file]);
    const follower = await f.command<Entity>('CreateWorkItem', { title: 'Downstream task', description: '', acceptanceCriteria: [{ id: randomUUID(), text: 'Follow source task' }], assigneeId: f.owner.id }, { extra: { projectId: project.id } });
    const followerSource = await f.request<{ revision: string }>(`/api/v1/workspaces/${f.workspaceId}/core/files/${follower.id}`);
    const linked = await f.request(`/api/v1/workspaces/${f.workspaceId}/core/entities/${follower.id}`, { method: 'PATCH', body: { revision: followerSource.body.revision, changes: { estimated_duration_days: 2, blocked_by: [task.id] } } });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    const linkedAnalysis = await cli(f)(['planning', 'critical-path', '--project', project.id]);
    if (linkedAnalysis.kind !== 'dashboard_critical_path') throw new Error('Wrong linked analysis projection');
    assert.equal(linkedAnalysis.durationDays, 5);
    const read = await call(f, request('pm_read_planning', { projectId: null, section: 'projects', after: null, limit: 20 }, f.workspaceId, project.id));
    assert.ok(!JSON.stringify(read).includes(other.project.id));
    if (read.kind === 'dashboard_planning' && read.items[0]?.row === 'project') assert.equal(read.items[0].hasUnavailableDependencies, true);
    const source = await f.request<{ revision: string; version?: number }>(`/api/v1/workspaces/${f.workspaceId}/core/files/${task.id}`);
    assert.equal(source.status, 200);
    const patch = await f.request<{ revision: string }>(`/api/v1/workspaces/${f.workspaceId}/core/entities/${task.id}`, { method: 'PATCH', body: { revision: source.body.revision, changes: { estimated_duration_days: 7 } } });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));
    const changed = await cli(f)(['planning', 'critical-path', '--project', project.id]);
    if (changed.kind === 'dashboard_critical_path') assert.equal(changed.durationDays, 9);
    const sprint = await f.command<{ id: string }>('CreateSprint', { projectId: project.id, title: 'Observed cycle' }, { extra: { projectId: project.id } });
    await f.command('SetTaskSprint', { workItemId: task.id, sprintId: sprint.id }, { extra: { projectId: project.id, targetId: task.id, expectedVersions: { [task.id]: sprintRecordVersion(patch.body.revision) } } });
    const history = await cli(f)(['sprint-metrics', 'history', '--project', project.id, '--sprint', sprint.id]);
    if (history.kind !== 'dashboard_sprint_metrics') throw new Error('Wrong sprint projection');
    assert.equal(history.semantics, 'observed_snapshots');
    assert.ok(history.items.some(row => row.row === 'history' && row.sprint?.id === sprint.id && row.sprint.total === 1));
  });
});
