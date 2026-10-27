import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Command, Entity } from '../packages/domain/src/core.ts';
import type { PortfolioDashboard, ProjectBudgetCommandResult, ProjectHealthCommandResult } from '../packages/domain/src/dashboard-portfolio.ts';
import type { Membership } from '../packages/application/src/access.ts';
import { createDashboardFixture, dashboardDatabaseUrl } from './dashboard-fixture.ts';
import type { DashboardFixture } from './dashboard-fixture.ts';

const asOfDate = '2024-02-29';
function scope(project: Entity, ...records: { id: string; version: number }[]) {
  return { extra: { targetId: project.id, projectId: project.id, expectedVersions: Object.fromEntries([project, ...records].map(record => [record.id, record.version])) } };
}
function command(commandType: string, payload: Record<string, unknown>, project: Entity, ...records: { id: string; version: number }[]): Command {
  return { commandId: randomUUID(), commandType, payload, ...scope(project, ...records).extra };
}

describe('dashboard portfolio: real Markdown authority, PostgreSQL, HTTP and durable history', { skip: !dashboardDatabaseUrl, timeout: 180_000 }, () => {
  let fixture: DashboardFixture;
  before(async () => { fixture = await createDashboardFixture(); });
  after(async () => { await fixture?.close(); });

  async function project(name: string): Promise<Entity> {
    return fixture.command('CreateProject', { name, goal: 'Explicit portfolio evidence', ownerId: fixture.owner.id, completionCriteria: ['Reviewed'] });
  }
  async function budget(project: Entity, currency = 'USD', budgetMinor = 10000, remainingEstimateMinor = 6000): Promise<ProjectBudgetCommandResult> {
    return fixture.command('SetProjectBudget', { currency, budgetMinor, remainingEstimateMinor, asOfDate, reason: 'Approved baseline' }, scope(project));
  }

  it('unassessed is null; explicit risk assessments retain author, date and immutable history', async () => {
    const p = await project('Health history');
    const empty = (await fixture.read<PortfolioDashboard>('portfolio')).projects.find(row => row.projectId === p.id)!;
    assert.equal(empty.health, null);
    assert.deepEqual(empty.healthHistory, []);
    const first = await fixture.command<ProjectHealthCommandResult>('SetProjectHealth', { status: 'at_risk', rationale: 'Supplier delay', risks: [{ description: 'Parts unavailable', severity: 'high', mitigation: 'Qualify backup supplier' }] }, scope(p));
    const saved = structuredClone(first.assessment);
    const second = await fixture.command<ProjectHealthCommandResult>('SetProjectHealth', { status: 'on_track', rationale: 'Backup qualified', risks: [] }, scope(p, first.health));
    assert.equal(second.health.version, first.health.version + 1);
    const current = (await fixture.read<PortfolioDashboard>('portfolio')).projects.find(row => row.projectId === p.id)!;
    assert.equal(current.health?.data.status, 'on_track');
    assert.equal(current.healthHistory.length, 2);
    assert.deepEqual(current.healthHistory.find(row => row.id === first.assessment.id), saved);
    assert.equal(saved.createdBy, fixture.owner.id);
    assert.equal(saved.data.assessedBy, fixture.owner.id);
    assert.ok(Number.isFinite(Date.parse(saved.data.assessedAt)));
    await assert.rejects(fixture.pool.query('UPDATE dashboard_records SET version=version+1,data=$1::jsonb WHERE id=$2', [JSON.stringify({ ...saved.data, rationale: 'Tampered' }), saved.id]), /immutable/);
    await assert.rejects(fixture.pool.query('DELETE FROM dashboard_records WHERE id=$1', [saved.id]), /retained/);
    const stale = await fixture.send(command('SetProjectHealth', { status: 'off_track', rationale: 'Stale overwrite', risks: [] }, p, first.health));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error?.code, 'version_conflict');
  });

  it('records independent manual confidence, preserves omitted values, clears explicitly, and keeps CAS and replay atomic', async () => {
    const p = await project('Manual confidence');
    const assess = command('SetProjectHealth', { status: 'on_track', confidence: 'low', rationale: 'Healthy now, uncertain delivery window', risks: [] }, p);
    const low = await fixture.command<ProjectHealthCommandResult>(assess.commandType, assess.payload, { extra: { ...scope(p).extra, commandId: assess.commandId } });
    const savedLow = structuredClone(low.assessment);
    assert.equal(low.health.data.confidence, 'low');
    assert.equal(low.health.data.status, 'on_track');
    assert.deepEqual((await fixture.send(assess)).body.result, low);
    const different = await fixture.send({ ...assess, payload: { ...assess.payload, confidence: 'high' } });
    assert.equal(different.status, 409);
    assert.equal((await fixture.read<PortfolioDashboard>('portfolio')).projects.find(row => row.projectId === p.id)?.healthHistory.length, 1);

    const high = await fixture.command<ProjectHealthCommandResult>('SetProjectHealth', { status: 'off_track', confidence: 'high', rationale: 'Recovery commitment reviewed despite current delay', risks: [] }, scope(p, low.health));
    assert.equal(high.health.data.confidence, 'high');
    const omitted = await fixture.command<ProjectHealthCommandResult>('SetProjectHealth', { status: 'at_risk', rationale: 'Legacy caller revises health only', risks: [] }, scope(p, high.health));
    assert.equal(omitted.health.data.confidence, 'high');
    assert.equal(omitted.assessment.data.confidence, 'high');

    const stale = await fixture.send(command('SetProjectHealth', { status: 'on_track', confidence: 'medium', rationale: 'Must not overwrite a newer assessment', risks: [] }, p, high.health));
    assert.equal(stale.body.error?.code, 'version_conflict');
    const missingHead = await fixture.send(command('SetProjectHealth', { status: 'on_track', confidence: 'medium', rationale: 'Missing assessment version', risks: [] }, p));
    assert.equal(missingHead.body.error?.code, 'version_conflict');
    for (const confidence of ['unknown', 100, false]) {
      const invalid = await fixture.send(command('SetProjectHealth', { status: 'on_track', confidence, rationale: 'Not a supported manual value', risks: [] }, p, omitted.health));
      assert.equal(invalid.body.status, 'rejected');
    }
    await assert.rejects(fixture.pool.query("UPDATE dashboard_records SET data=jsonb_set(data,'{confidence}','\"guessed\"'::jsonb),version=version+1 WHERE id=$1", [omitted.health.id]), /dashboard_portfolio_confidence/);

    const cleared = await fixture.command<ProjectHealthCommandResult>('SetProjectHealth', { status: 'on_track', confidence: null, rationale: 'No current delivery confidence assessment', risks: [] }, scope(p, omitted.health));
    assert.equal(cleared.health.data.confidence, null);
    const stillUnknown = await fixture.command<ProjectHealthCommandResult>('SetProjectHealth', { status: 'off_track', rationale: 'Status alone never supplies confidence', risks: [] }, scope(p, cleared.health));
    assert.equal(stillUnknown.health.data.confidence, null);
    const current = (await fixture.read<PortfolioDashboard>('portfolio')).projects.find(row => row.projectId === p.id)!;
    assert.equal(current.healthHistory.length, 5);
    assert.deepEqual(current.healthHistory.find(row => row.id === savedLow.id), savedLow);
    assert.equal(current.healthHistory.find(row => row.id === high.assessment.id)?.data.confidence, 'high');
    assert.equal(current.healthHistory.find(row => row.id === cleared.assessment.id)?.data.confidence, null);
    assert.ok(current.healthHistory.every(row => row.data.assessedBy === fixture.owner.id && Number.isFinite(Date.parse(row.data.assessedAt))));
    await assert.rejects(fixture.pool.query("UPDATE dashboard_records SET data=jsonb_set(data,'{confidence}','\"high\"'::jsonb),version=version+1 WHERE id=$1", [savedLow.id]), /immutable/);
    const task = await fixture.command<Entity>('CreateWorkItem', { title: 'Completion is not confidence', description: 'Manual assessment remains separate', acceptanceCriteria: [], assigneeId: fixture.owner.id }, { extra: { projectId: p.id } });
    const started = await fixture.command<Entity>('StartWorkItem', {}, { extra: { targetId: task.id, projectId: p.id, expectedVersions: { [task.id]: task.version } } });
    const completed = await fixture.command<Entity>('CompleteWorkItem', {}, { extra: { targetId: started.id, projectId: p.id, expectedVersions: { [started.id]: started.version } } });
    assert.equal(completed.data.status, 'done');
    const afterCompletion = (await fixture.read<PortfolioDashboard>('portfolio')).projects.find(row => row.projectId === p.id)!;
    assert.deepEqual(afterCompletion.health, current.health);
    assert.deepEqual(afterCompletion.healthHistory, current.healthHistory);
    const rereadProject = await fixture.request<Entity>(`/api/v1/workspaces/${fixture.workspaceId}/entities/${p.id}`);
    assert.equal(rereadProject.status, 200);
    assert.equal(rereadProject.body.data.status, p.data.status);
  });

  it('reads legacy confidence omission as unknown without rewriting immutable history', async () => {
    const p = await project('Legacy confidence');
    const headId = randomUUID();
    const assessmentId = randomUUID();
    const legacyData = { status: 'on_track', rationale: 'Assessment before confidence existed', risks: [], assessedBy: fixture.owner.id, assessedAt: new Date().toISOString() };
    await fixture.pool.query(`INSERT INTO dashboard_records(id,workspace_id,project_id,kind,owner_id,data,created_by) VALUES
      ($1,$3,$4,'portfolio_health',NULL,$5::jsonb,$6),
      ($2,$3,$4,'portfolio_health_assessment',NULL,$5::jsonb,$6)`, [headId, assessmentId, fixture.workspaceId, p.id, JSON.stringify(legacyData), fixture.owner.id]);
    const before = (await fixture.read<PortfolioDashboard>('portfolio')).projects.find(row => row.projectId === p.id)!;
    assert.ok(before.health);
    assert.equal(Object.hasOwn(before.health.data, 'confidence'), false);
    assert.equal(before.health.data.confidence ?? null, null);
    const originalHistory = before.healthHistory.find(row => row.id === assessmentId)!;
    assert.equal(Object.hasOwn(originalHistory.data, 'confidence'), false);
    const next = await fixture.command<ProjectHealthCommandResult>('SetProjectHealth', { status: 'off_track', rationale: 'Legacy command leaves confidence unknown', risks: [] }, scope(p, before.health));
    assert.equal(next.health.data.confidence, null);
    assert.equal(next.assessment.data.confidence, null);
    const after = (await fixture.read<PortfolioDashboard>('portfolio')).projects.find(row => row.projectId === p.id)!;
    assert.deepEqual(after.healthHistory.find(row => row.id === assessmentId), originalHistory);
    assert.equal(after.healthHistory.length, 2);
  });

  it('records actual dated spend, explicit remaining estimate, corrections and voids without rewriting snapshots', async () => {
    const p = await project('Auditable ledger');
    const baseline = await budget(p);
    assert.equal(baseline.budget.actualMinor, 0);
    assert.equal(baseline.budget.forecastMinor, 6000);
    const paid = await fixture.command<ProjectBudgetCommandResult>('RecordProjectSpend', { currency: 'USD', amountMinor: 3000, spentOn: asOfDate, description: 'Supplier invoice' }, scope(p, baseline.budget));
    assert.ok(paid.spend);
    assert.equal(paid.budget.actualMinor, 3000);
    assert.equal(paid.budget.forecastMinor, 9000);
    const forecast = await fixture.command<ProjectBudgetCommandResult>('SetProjectRemainingEstimate', { remainingEstimateMinor: 2000, asOfDate, reason: 'Remaining purchase order reviewed' }, scope(p, paid.budget));
    assert.equal(forecast.budget.forecastMinor, 5000);
    const corrected = await fixture.command<ProjectBudgetCommandResult>('CorrectProjectSpend', { spendId: paid.spend.id, reason: 'Invoice amount corrected', currency: 'USD', amountMinor: 2500, spentOn: asOfDate, description: 'Corrected supplier invoice' }, scope(p, forecast.budget));
    assert.equal(corrected.budget.actualMinor, 2500);
    assert.equal(corrected.budget.forecastMinor, 4500);
    assert.equal(corrected.spend?.data.correctsSpendId, paid.spend.id);
    assert.equal(corrected.void?.data.spendId, paid.spend.id);
    assert.ok(corrected.spend);
    const voided = await fixture.command<ProjectBudgetCommandResult>('VoidProjectSpend', { spendId: corrected.spend.id, reason: 'Invoice withdrawn' }, scope(p, corrected.budget));
    assert.equal(voided.budget.actualMinor, 0);
    assert.equal(voided.budget.forecastMinor, 2000);
    const current = (await fixture.read<PortfolioDashboard>('portfolio')).projects.find(row => row.projectId === p.id)!;
    assert.equal(current.spend.length, 2);
    assert.equal(current.spend.filter(row => row.void).length, 2);
    assert.equal(current.financialHistory.length, 5);
    assert.deepEqual(current.financialHistory.find(row => row.id === baseline.snapshot.id), baseline.snapshot);
    assert.deepEqual(current.financialHistory.find(row => row.id === paid.snapshot.id), paid.snapshot);
    assert.equal(current.financialHistory.find(row => row.id === paid.snapshot.id)?.data.actualMinor, 3000);
    assert.equal(current.financialHistory.find(row => row.id === paid.snapshot.id)?.data.forecastMinor, 9000);
    await assert.rejects(fixture.pool.query('UPDATE dashboard_records SET version=version+1 WHERE id=$1', [paid.spend.id]), /immutable/);
    await assert.rejects(fixture.pool.query('UPDATE dashboard_records SET version=version+1 WHERE id=$1', [paid.snapshot.id]), /immutable/);
    const lockedCurrency = await fixture.send(command('SetProjectBudget', { currency: 'JPY', budgetMinor: 10000, remainingEstimateMinor: 2000, asOfDate, reason: 'Not an FX conversion' }, p, voided.budget));
    assert.equal(lockedCurrency.body.error?.code, 'currency_locked_by_ledger');
    const duplicateVoid = await fixture.send(command('VoidProjectSpend', { spendId: paid.spend.id, reason: 'Cannot void twice' }, p, voided.budget));
    assert.equal(duplicateVoid.body.error?.code, 'spend_already_voided');
    assert.equal(current.spend[0]?.createdBy, fixture.owner.id);
  });

  it('keeps currency groups separate and never derives money from task progress', async () => {
    const dollarProject = await project('USD currency group');
    const yenProject = await project('JPY currency group');
    const usd = await budget(dollarProject, 'USD', 12345, 3456);
    await budget(yenProject, 'JPY', 54321, 6543);
    const before = await fixture.read<PortfolioDashboard>('portfolio');
    assert.equal(before.totals.find(row => row.currency === 'JPY')?.budgetMinor, 54321);
    assert.ok(before.totals.some(row => row.currency === 'USD'));
    const mismatch = await fixture.send(command('RecordProjectSpend', { currency: 'JPY', amountMinor: 1, spentOn: asOfDate, description: 'Wrong currency' }, dollarProject, usd.budget));
    assert.equal(mismatch.body.error?.code, 'currency_mismatch');
    await fixture.command('CreateWorkItem', { title: 'No implicit cost', description: 'Task state is not financial data', acceptanceCriteria: [], assigneeId: fixture.owner.id }, { extra: { projectId: dollarProject.id } });
    const after = await fixture.read<PortfolioDashboard>('portfolio');
    assert.deepEqual(after.projects.find(row => row.projectId === dollarProject.id)?.budget, before.projects.find(row => row.projectId === dollarProject.id)?.budget);
    assert.deepEqual(after.totals, before.totals);
  });

  it('rejects invalid dates and amounts, detects safe integer forecast overflow and rolls back ledger writes', async () => {
    const p = await project('Money boundaries');
    const baseline = await budget(p, 'EUR', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const badPayloads = [
      { currency: 'EUR', amountMinor: -1, spentOn: asOfDate, description: 'Negative' },
      { currency: 'EUR', amountMinor: 0.5, spentOn: asOfDate, description: 'Fraction' },
      { currency: 'EUR', amountMinor: Number.MAX_SAFE_INTEGER + 1, spentOn: asOfDate, description: 'Unsafe' },
      { currency: 'EUR', amountMinor: 1, spentOn: '2025-02-29', description: 'Invalid day' },
      { currency: 'EUR', amountMinor: 1, spentOn: '2099-01-01', description: 'Future actual' },
    ];
    for (const payload of badPayloads) {
      const response = await fixture.send(command('RecordProjectSpend', payload, p, baseline.budget));
      assert.equal(response.body.status, 'rejected');
    }
    const overflow = await fixture.send(command('RecordProjectSpend', { currency: 'EUR', amountMinor: 1, spentOn: asOfDate, description: 'Forecast overflow' }, p, baseline.budget));
    assert.equal(overflow.body.error?.code, 'money_overflow');
    const current = (await fixture.read<PortfolioDashboard>('portfolio')).projects.find(row => row.projectId === p.id)!;
    assert.equal(current.spend.length, 0);
    assert.equal(current.budget?.version, baseline.budget.version);
    assert.equal(current.financialHistory.length, 1);
    assert.equal((await fixture.pool.query('SELECT count(*)::text AS count FROM outbox WHERE command_id=$1', [overflow.body.commandId])).rows[0].count, '0');
  });

  it('serializes competing financial mutations, requires head CAS, and replays one durable receipt', async () => {
    const p = await project('Financial concurrency');
    const baseline = await budget(p);
    const first = command('RecordProjectSpend', { currency: 'USD', amountMinor: 100, spentOn: asOfDate, description: 'Concurrent invoice A' }, p, baseline.budget);
    const second = command('RecordProjectSpend', { currency: 'USD', amountMinor: 200, spentOn: asOfDate, description: 'Concurrent invoice B' }, p, baseline.budget);
    const results = await Promise.all([fixture.send(first), fixture.send(second)]);
    assert.deepEqual(results.map(row => row.status).sort(), [200, 409]);
    const winnerIndex = results.findIndex(row => row.status === 200);
    const winningCommand = [first, second][winnerIndex]!;
    const winner = results[winnerIndex]!;
    assert.deepEqual((await fixture.send(winningCommand)).body, winner.body);
    const changedRequest = await fixture.send({ ...winningCommand, payload: { ...winningCommand.payload, description: 'Different same-key request' } });
    assert.equal(changedRequest.status, 409);
    const current = (await fixture.read<PortfolioDashboard>('portfolio')).projects.find(row => row.projectId === p.id)!;
    assert.equal(current.spend.length, 1);
    assert.equal(current.financialHistory.length, 2);
    const missingHead = await fixture.send(command('RecordProjectSpend', { currency: 'USD', amountMinor: 1, spentOn: asOfDate, description: 'No head version' }, p));
    assert.equal(missingHead.body.error?.code, 'version_conflict');
    const receipt = await fixture.request(`/api/v1/workspaces/${fixture.workspaceId}/commands/${winningCommand.commandId}`);
    assert.deepEqual(receipt.body, winner.body);
    const events = await fixture.pool.query<{ payload: Record<string, unknown>; project_id: string }>('SELECT payload,project_id FROM outbox WHERE command_id=$1', [winningCommand.commandId]);
    assert.equal(events.rows.length, 1);
    assert.equal(events.rows[0]?.project_id, p.id);
    assert.equal(JSON.stringify(events.rows[0]?.payload).includes('Concurrent invoice'), false);
    assert.equal((await fixture.pool.query("SELECT count(*)::text AS count FROM entities WHERE kind='project'")).rows[0].count, '0');
  });

  it('enforces current project authorization, receipt revocation and authoritative core archive/version guards', async () => {
    const accessible = await project('Scoped portfolio');
    const hidden = await project('Hidden portfolio');
    await budget(hidden);
    const editor = await fixture.member('Portfolio editor');
    const membership = await fixture.command<Membership>('SetWorkspaceMember', { userId: editor.user.id, capabilities: ['domain.read', 'planning.edit'], projectIds: [accessible.id] });
    const permitted = await fixture.read<PortfolioDashboard>('portfolio', { cookie: editor.cookie });
    assert.deepEqual(permitted.projects.map(row => row.projectId), [accessible.id]);
    const ownCommand = command('SetProjectHealth', { status: 'off_track', confidence: 'medium', rationale: 'Authorized explicit assessment', risks: [] }, accessible);
    const owned = await fixture.send(ownCommand, { cookie: editor.cookie });
    assert.equal(owned.status, 200);
    const editorAssessment = (await fixture.read<PortfolioDashboard>('portfolio', { cookie: editor.cookie })).projects.find(row => row.projectId === accessible.id)!.health!;
    assert.equal(editorAssessment.data.assessedBy, editor.user.id);
    assert.equal(editorAssessment.createdBy, editor.user.id);
    assert.equal(editorAssessment.data.confidence, 'medium');
    const forbidden = await fixture.send(command('SetProjectHealth', { status: 'on_track', confidence: 'high', rationale: 'Forbidden hidden project', risks: [] }, hidden), { cookie: editor.cookie });
    assert.ok([403, 404].includes(forbidden.status));
    const readerMembership = await fixture.command<Membership>('SetWorkspaceMember', { userId: editor.user.id, capabilities: ['domain.read'], projectIds: [hidden.id] }, { extra: { expectedVersions: { [editor.user.id]: membership.version } } });
    assert.ok([403, 404].includes((await fixture.request(`/api/v1/workspaces/${fixture.workspaceId}/commands/${ownCommand.commandId}`, { cookie: editor.cookie })).status));
    const readonly = await fixture.send(command('SetProjectHealth', { status: 'at_risk', confidence: null, rationale: 'No edit capability', risks: [] }, hidden), { cookie: editor.cookie });
    assert.equal(readonly.status, 403);
    await fixture.command('RevokeWorkspaceMember', { userId: editor.user.id }, { extra: { expectedVersions: { [editor.user.id]: readerMembership.version } } });
    assert.equal((await fixture.request(`/api/v1/workspaces/${fixture.workspaceId}/dashboard/portfolio`, { cookie: editor.cookie })).status, 404);
    const mismatch = await fixture.send({ ...command('SetProjectHealth', { status: 'on_track', rationale: 'Wrong scope', risks: [] }, accessible), projectId: hidden.id });
    assert.equal(mismatch.body.error?.code, 'project_mismatch');
    const newer = await fixture.command<Entity>('UpdateProject', { name: 'Core changed', goal: accessible.data.goal, ownerId: fixture.owner.id, completionCriteria: accessible.data.completionCriteria }, scope(accessible));
    const stale = await fixture.send(command('SetProjectBudget', { currency: 'USD', budgetMinor: 100, remainingEstimateMinor: 50, asOfDate, reason: 'Old core revision' }, accessible));
    assert.equal(stale.body.error?.code, 'version_conflict');
    const archived = await fixture.command<Entity>('ArchiveObject', { kind: 'project', reason: 'Archive guard' }, scope(newer));
    const blocked = await fixture.send(command('SetProjectBudget', { currency: 'USD', budgetMinor: 100, remainingEstimateMinor: 50, asOfDate, reason: 'Archived project' }, archived));
    assert.equal(blocked.body.error?.code, 'object_archived');
  });
});
