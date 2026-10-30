import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { buildApp } from '../apps/server/pm/src/app.ts';
import { publishOutboxBatch } from '../packages/application/src/outbox.ts';
import type { Command, Entity } from '../packages/domain/src/core.ts';
import type { TimeDashboard, TimeTimer, TimeWorklog } from '../packages/domain/src/dashboard-time.ts';
import { createDashboardFixture, dashboardDatabaseUrl, type DashboardFixture } from './dashboard-fixture.ts';
import { LocalBlobStore } from '../packages/infrastructure/src/blobs.ts';
import { unlink } from 'node:fs/promises';

async function task(f: DashboardFixture, name = 'Private timed task'): Promise<Entity> {
  const project = await f.command<Entity>('CreateProject', { name, goal: 'Time tracking acceptance', ownerId: f.owner.id, completionCriteria: ['A real task'] });
  return f.command<Entity>('CreateWorkItem', { title: name, description: 'Do the work', acceptanceCriteria: [{ id: randomUUID(), text: 'Done' }], assigneeId: f.owner.id }, { extra: { projectId: project.id } });
}

describe('dashboard time: real PostgreSQL and HTTP behavior', { skip: !dashboardDatabaseUrl }, () => {
  it('serializes concurrent starts, enforces the DB constraint and atomically stops once', { timeout: 180_000 }, async t => {
    const f = await createDashboardFixture({ signal: t.signal });
    t.after(() => f.close());
    const item = await task(f);
    const starts = await Promise.all(Array.from({ length: 5 }, () => f.send({ commandId: randomUUID(), commandType: 'StartTimer', payload: { taskId: item.id } })));
    assert.equal(starts.filter(result => result.body.status === 'committed').length, 1);
    const snapshot = await f.read<TimeDashboard>('time');
    const active = snapshot.activeTimer!;
    assert.ok(active.startedAt);
    await assert.rejects(f.pool.query(`INSERT INTO dashboard_records(id,workspace_id,kind,owner_id,data,created_by)
      SELECT $1,workspace_id,kind,owner_id,data,created_by FROM dashboard_records WHERE id=$2`, [randomUUID(), active.id]), (error: unknown) => error !== null && typeof error === 'object' && 'constraint' in error && error.constraint === 'dashboard_time_active_timer_unique');
    const command: Command = { commandId: randomUUID(), commandType: 'StopTimer', targetId: active.id, expectedVersions: { [active.id]: active.version }, payload: {} };
    const competingStop = { ...command, commandId: randomUUID() };
    const stops = await Promise.all([f.send(command), f.send(command), f.send(competingStop)]);
    assert.deepEqual(stops[0]!.body, stops[1]!.body);
    const winningCommand = stops[0]!.body.status === 'committed' ? command : competingStop;
    const winner = stops.find(result => result.body.status === 'committed');
    assert.ok(winner);
    assert.deepEqual((await f.send(winningCommand)).body, winner.body);
    const stopped = await f.read<TimeDashboard>('time');
    assert.equal(stopped.activeTimer, null);
    assert.equal(stopped.worklogs.length, 1);
    assert.equal(stopped.worklogs[0]!.timerId, active.id);
    assert.equal(stopped.worklogs[0]!.startedAt, active.startedAt);
    assert.ok(stopped.worklogs[0]!.durationMs >= 0);
    const replayStopped = await f.command<{ worklogId: string }>('StopTimer', {}, { extra: { targetId: active.id, expectedVersions: { [active.id]: active.version + 1 } } });
    assert.equal(replayStopped.worklogId, stopped.worklogs[0]!.id);
    await assert.rejects(f.pool.query('UPDATE dashboard_records SET version=version+1,data=jsonb_set(data,\'{note}\',\'"rewritten"\') WHERE id=$1', [stopped.worklogs[0]!.id]), (error: unknown) => error !== null && typeof error === 'object' && 'constraint' in error && error.constraint === 'dashboard_time_worklog_immutable');
    const counts = await f.pool.query<{ count: string }>("SELECT count(*)::text FROM outbox WHERE event_type='WorklogRecorded'");
    assert.equal(counts.rows[0]!.count, '1');
  });

  it('recovers a server start from a fresh API instance without resetting the timer', { timeout: 180_000 }, async t => {
    const f = await createDashboardFixture({ signal: t.signal });
    t.after(() => f.close());
    const item = await task(f, 'Restart timer task');
    const active = await f.command<TimeTimer>('StartTimer', { taskId: item.id });
    await f.app.close();
    const blobRoot = join(dirname(f.coreRoot), 'blobs');
    const restart = f.ownApp(() => buildApp({ databaseUrl: f.pool.options.connectionString!, blobStore: new LocalBlobStore(blobRoot), blobStorageLocator: { provider: 'local', root: blobRoot }, coreWorkspaceRoot: f.coreRoot, signal: t.signal }));
    const origin = await restart.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${origin}/api/v1/workspaces/${f.workspaceId}/dashboard/time`, { signal: t.signal, headers: { cookie: f.ownerCookie } });
    assert.equal(response.status, 200);
    const recovered = z.object({ activeTimer: z.object({ id: z.string(), startedAt: z.iso.datetime() }).nullable() }).parse(await response.json());
    assert.equal(recovered.activeTimer?.id, active.id);
    assert.equal(recovered.activeTimer?.startedAt, active.startedAt);
    const stop = await fetch(`${origin}/api/v1/workspaces/${f.workspaceId}/commands`, { signal: t.signal, method: 'POST', headers: { cookie: f.ownerCookie, 'content-type': 'application/json' }, body: JSON.stringify({ commandId: randomUUID(), commandType: 'StopTimer', targetId: active.id, expectedVersions: { [active.id]: active.version }, payload: {} }) });
    assert.equal(stop.status, 200);
  });

  it('keeps logs private and permits stopping after task scope revocation without hidden references', { timeout: 180_000 }, async t => {
    const f = await createDashboardFixture({ signal: t.signal });
    t.after(() => f.close());
    const first = await task(f, 'Revoked secret timer title');
    const second = await task(f, 'Still accessible task');
    const member = await f.member('Restricted timer owner');
    const grant = await f.command<{ version: number }>('SetWorkspaceMember', { userId: member.user.id, capabilities: ['domain.read'], projectIds: [first.projectId, second.projectId] });
    const timer = await f.command<TimeTimer>('StartTimer', { taskId: first.id, note: 'Secret task note' }, { cookie: member.cookie });
    await f.command('SetWorkspaceMember', { userId: member.user.id, capabilities: ['domain.read'], projectIds: [second.projectId] }, { extra: { expectedVersions: { [member.user.id]: grant.version } } });
    const hidden = await f.read<TimeDashboard>('time', { cookie: member.cookie });
    assert.equal(hidden.activeTimer!.task.unavailable, true);
    const serialized = JSON.stringify(hidden);
    assert.ok(!serialized.includes(first.id));
    assert.ok(!serialized.includes(first.projectId!));
    assert.ok(!serialized.includes('Revoked secret timer title'));
    assert.ok(!serialized.includes('Secret task note'));
    const stopCommand: Command = { commandId: randomUUID(), commandType: 'StopTimer', targetId: timer.id, expectedVersions: { [timer.id]: timer.version }, payload: {} };
    const stop = await f.send(stopCommand, { cookie: member.cookie });
    assert.equal(stop.body.status, 'committed');
    const receipt = await f.request(`/api/v1/workspaces/${f.workspaceId}/commands/${stopCommand.commandId}`, { cookie: member.cookie });
    assert.equal(receipt.status, 200);
    assert.ok(!JSON.stringify(receipt.body).includes(first.id));
    const ownerRead = await f.read<TimeDashboard>('time');
    assert.equal(ownerRead.worklogs.length, 0);
    const own = await f.read<TimeDashboard>('time', { cookie: member.cookie });
    assert.equal(own.worklogs.length, 1);
    assert.equal(own.worklogs[0]!.task.taskId, null);
    assert.equal(own.worklogs[0]!.note, '');
    assert.equal(own.presence.directoryVisible, false);
    assert.deepEqual(own.presence.members.map(value => value.userId), [member.user.id]);
    assert.equal((await f.request(`/api/v1/workspaces/${f.workspaceId}/members`, { cookie: member.cookie })).status, 404);
    const stolenStop = await f.send({ commandId: randomUUID(), commandType: 'StopTimer', targetId: timer.id, payload: {}, expectedVersions: { [timer.id]: 2 } });
    assert.equal(stolenStop.body.status, 'rejected');
    while (await publishOutboxBatch(f.pool, 500)) { /* Publish only this isolated schema. */ }
    const changes = await f.request<{ events: { event: { aggregateId: string } }[] }>(`/api/v1/workspaces/${f.workspaceId}/changes`);
    assert.ok(!changes.body.events.some(value => value.event.aggregateId === timer.id || value.event.aggregateId === own.worklogs[0]!.id));
  });

  it('protects retained timer history and redacts an externally removed task while permitting stop', { timeout: 180_000 }, async t => {
    const f = await createDashboardFixture({ signal: t.signal });
    t.after(() => f.close());
    const item = await task(f, 'Deleted task reference');
    const timer = await f.command<TimeTimer>('StartTimer', { taskId: item.id });
    const source = await f.request<{ revision: string; path: string }>(`/api/v1/workspaces/${f.workspaceId}/core/files/${item.id}`);
    assert.equal(source.status, 200);
    const archived = await f.request<{ revision: string }>(`/api/v1/workspaces/${f.workspaceId}/core/entities/${item.id}/archive`, { method: 'POST', body: { revision: source.body.revision } });
    assert.equal(archived.status, 200);
    const deleted = await f.request<{ error: { code: string } }>(`/api/v1/workspaces/${f.workspaceId}/core/entities/${item.id}`, { method: 'DELETE', body: { revision: archived.body.revision } });
    assert.equal(deleted.status, 422);
    assert.equal(deleted.body.error.code, 'DELETE_REFERENCED');
    // External source loss remains possible even though the API retains history.
    await unlink(join(f.coreRoot, f.workspaceId, source.body.path));
    const snapshot = await f.read<TimeDashboard>('time');
    assert.equal(snapshot.activeTimer?.task.taskId, null);
    assert.equal(snapshot.activeTimer?.task.unavailable, true);
    await f.command('StopTimer', {}, { extra: { targetId: timer.id, expectedVersions: { [timer.id]: timer.version } } });
    const stopped = await f.read<TimeDashboard>('time');
    assert.equal(stopped.worklogs.length, 1);
    assert.equal(stopped.worklogs[0]!.task.unavailable, true);
  });

  it('records real manual intervals and clips totals in the personal IANA zone', { timeout: 180_000 }, async t => {
    const f = await createDashboardFixture({ signal: t.signal });
    t.after(() => f.close());
    const item = await task(f, 'Manual work task');
    await f.pool.query("UPDATE users SET time_zone='America/New_York',profile_version=profile_version+1 WHERE id=$1", [f.owner.id]);
    const initial = await f.read<TimeDashboard>('time');
    const start = Date.parse(initial.totals.month.start) - 3_600_000;
    const end = Date.parse(initial.totals.month.start) + 3_600_000;
    // The first hour of the current month is safely in the past except during
    // that hour; choose a prior month's full interval for that boundary case.
    const endedAt = end <= Date.parse(initial.serverNow) ? end : start;
    const startedAt = end <= Date.parse(initial.serverNow) ? start : start - 3_600_000;
    const manual = await f.command<TimeWorklog>('RecordManualWorklog', { taskId: item.id, startedAt: new Date(startedAt).toISOString(), endedAt: new Date(endedAt).toISOString(), note: 'Actual historical interval' });
    assert.equal(manual.durationMs, endedAt - startedAt);
    const snapshot = await f.read<TimeDashboard>('time');
    assert.equal(snapshot.timeZone, 'America/New_York');
    assert.equal(snapshot.totals.month.durationMs, end <= Date.parse(initial.serverNow) ? 3_600_000 : 0);
    const invalid = await f.send({ commandId: randomUUID(), commandType: 'RecordManualWorklog', payload: { taskId: item.id, startedAt: '2026-01-02T00:00:00Z', endedAt: '2026-01-01T00:00:00Z' } });
    assert.equal(invalid.body.status, 'rejected');
    const future = await f.send({ commandId: randomUUID(), commandType: 'RecordManualWorklog', payload: { taskId: item.id, startedAt: new Date(Date.now() + 3_600_000).toISOString(), endedAt: new Date(Date.now() + 7_200_000).toISOString() } });
    assert.equal(future.body.status, 'rejected');
    assert.equal((await f.read<TimeDashboard>('time')).worklogs.length, 1);
  });

  it('keeps heartbeat and preference versions independent, honors TTL and rejects stale tabs', { timeout: 180_000 }, async t => {
    const f = await createDashboardFixture({ signal: t.signal });
    t.after(() => f.close());
    const preference = await f.command<{ id: string; version: number }>('SetPresencePreference', { preference: 'away' });
    const heartbeat = await f.command<{ id: string; version: number; heartbeatAt: string }>('HeartbeatPresence', {});
    const concurrent = await Promise.all([
      f.send({ commandId: randomUUID(), commandType: 'HeartbeatPresence', targetId: heartbeat.id, expectedVersions: { [heartbeat.id]: heartbeat.version }, payload: {} }),
      f.send({ commandId: randomUUID(), commandType: 'SetPresencePreference', targetId: preference.id, expectedVersions: { [preference.id]: preference.version }, payload: { preference: 'online' } }),
    ]);
    assert.ok(concurrent.every(value => value.body.status === 'committed'));
    const stale = await f.send({ commandId: randomUUID(), commandType: 'SetPresencePreference', targetId: preference.id, expectedVersions: { [preference.id]: preference.version }, payload: { preference: 'away' } });
    assert.equal(stale.body.status, 'rejected');
    const snapshot = await f.read<TimeDashboard>('time');
    assert.equal(snapshot.presence.self.preference, 'online');
    assert.equal(snapshot.presence.self.status, 'online');
    assert.equal(snapshot.presence.self.preferenceVersion, 2);
    assert.equal(snapshot.presence.self.heartbeatVersion, 2);
    const races = await Promise.all(Array.from({ length: 3 }, () => f.send({ commandId: randomUUID(), commandType: 'HeartbeatPresence', targetId: heartbeat.id, expectedVersions: { [heartbeat.id]: 2 }, payload: {} })));
    assert.equal(races.filter(value => value.body.status === 'committed').length, 1);
    const recoveryCommand: Command = { commandId: randomUUID(), commandType: 'HeartbeatPresence', targetId: heartbeat.id, expectedVersions: { [heartbeat.id]: 3 }, payload: {} };
    const recoveredWrite = await f.send(recoveryCommand);
    assert.equal(recoveredWrite.body.status, 'committed');
    const recoveredReceipt = await f.request(`/api/v1/workspaces/${f.workspaceId}/commands/${recoveryCommand.commandId}`);
    assert.deepEqual(recoveredReceipt.body, recoveredWrite.body);
    assert.deepEqual((await f.send(recoveryCommand)).body, recoveredWrite.body);
    assert.equal((await f.read<TimeDashboard>('time')).presence.self.heartbeatVersion, 4);
    // A second member has no heartbeat; directory access does not invent online.
    const other = await f.member('Offline directory member');
    await f.command('SetWorkspaceMember', { userId: other.user.id, capabilities: ['domain.read'], projectIds: null });
    const directory = await f.read<TimeDashboard>('time');
    assert.equal(directory.presence.directoryVisible, true);
    assert.equal(directory.presence.members.find(value => value.userId === other.user.id)?.status, 'offline');
    const ownOnly = await f.read<TimeDashboard>('time', { cookie: other.cookie });
    assert.equal(ownOnly.presence.members.length, 1);
    assert.equal(ownOnly.presence.members[0]!.userId, other.user.id);
    const spoof = await f.send({ commandId: randomUUID(), commandType: 'HeartbeatPresence', payload: { userId: f.owner.id } }, { cookie: other.cookie });
    assert.equal(spoof.body.status, 'rejected');
    const oldTime = new Date(Date.now() - 90_001).toISOString();
    // Insert a real historical heartbeat for the other member. No clock mocking
    // or backwards update of a live heartbeat is needed to exercise read-time TTL.
    await f.pool.query("INSERT INTO dashboard_records(id,workspace_id,kind,owner_id,data,created_by) VALUES($1,$2,'presence_heartbeat',$3,$4::jsonb,$3)", [randomUUID(), f.workspaceId, other.user.id, JSON.stringify({ heartbeatAt: oldTime })]);
    const expired = await f.read<TimeDashboard>('time', { cookie: other.cookie });
    assert.equal(expired.presence.self.status, 'offline');
  });
});
