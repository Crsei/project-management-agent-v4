import assert from 'node:assert/strict';
import test from 'node:test';
import type { Entity } from '../../domain/src/core.ts';
import type { ProjectTeam } from '../../domain/src/project-directory.ts';
import { createMarkdown, parseMarkdown } from '../../pm-markdown/index.ts';
import { defaultConfiguration, type FileRecord } from '../../pm-schema/index.ts';
import type { DashboardReadContext } from '../src/dashboard-read.ts';
import { readTeamDirectory } from '../src/team-directory.ts';

const actorId = '11111111-1111-4111-8111-111111111111';
const hiddenId = '22222222-2222-4222-8222-222222222222';
const teamId = '33333333-3333-4333-8333-333333333333';
const workspaceId = '44444444-4444-4444-8444-444444444444';

function readerFixture(scope: 'scoped' | 'workspace' | 'access-only' = 'scoped') {
  const configuration = structuredClone(defaultConfiguration);
  configuration.workflows.work_item = { initial: 'done', states: [
    { id: 'done', label: 'Still working despite its name', category: 'started' },
    { id: 'sent', label: 'Actually complete', category: 'completed' },
    { id: 'stopped', label: 'Actually canceled', category: 'canceled' },
  ], transitions: [] };
  const caps = scope === 'access-only' ? ['access.manage'] as const : scope === 'workspace' ? ['domain.read', 'access.manage'] as const : ['domain.read'] as const;
  const membership = { userId: actorId, workspaceId, capabilities: [...caps], projectIds: scope === 'scoped' ? ['PRJ-1'] : null, version: 1, revokedAt: null };
  const team: ProjectTeam = { name: 'Real collaboration', identifier: null, description: '', focus: null, responseTargetHours: null,
    memberIds: [actorId, hiddenId], maintainerIds: [actorId, hiddenId], archivedAt: null };
  const teamRow = { id: teamId, workspace_id: workspaceId, project_id: null, kind: 'project_team', owner_id: null, version: 3, data: team,
    created_at: new Date('2020-01-01T00:00:00.000Z'), updated_at: new Date('2020-01-02T00:00:00.000Z'), created_by: hiddenId };
  const assignments = [
    { id: '55555555-5555-4555-8555-555555555555', project_id: 'PRJ-1', version: 2, data: { teamIds: [teamId] }, updated_at: new Date('2020-01-03T00:00:00.000Z') },
    { id: '66666666-6666-4666-8666-666666666666', project_id: 'PRJ-2', version: 1, data: { teamIds: [teamId] }, updated_at: new Date('2090-01-01T00:00:00.000Z') },
  ];
  const identities = [{ id: actorId, name: 'Reader' }, { id: hiddenId, name: 'Hidden member' }];
  const projects: Entity[] = ['PRJ-1', 'PRJ-2'].map(id => ({ id, workspaceId, projectId: null, kind: 'project', version: 9,
    data: { name: id, ownerId: actorId, status: 'planning' }, createdAt: null, updatedAt: null, createdBy: hiddenId }));
  function source(id: string, entity: string, project?: string, status?: string, archived = false): FileRecord {
    const raw = createMarkdown({ id, entity, title: id, ...(project ? { project } : {}), ...(status ? { status } : {}), archived }, configuration);
    return { id, path: `${id}.md`, raw, revision: 'a'.repeat(64), entity: parseMarkdown(raw, configuration) };
  }
  const open = source('TASK-1', 'work_item', 'PRJ-1', 'done');
  const records = [source('PRJ-1', 'project'), source('PRJ-2', 'project'), open, open,
    source('TASK-2', 'work_item', 'PRJ-1', 'sent'), source('TASK-3', 'work_item', 'PRJ-1', 'stopped'),
    source('TASK-4', 'work_item', 'PRJ-1', 'done', true), source('TASK-5', 'work_item', 'PRJ-2', 'done')];
  const tasks: Entity[] = records.filter(record => record.entity.entity === 'work_item').map(record => ({ id: record.id, workspaceId, projectId: record.entity.project!, kind: 'work_item',
    version: 1, data: { assigneeId: record.entity.project === 'PRJ-1' ? actorId : hiddenId }, createdAt: null, updatedAt: null, createdBy: hiddenId }));
  let revoked = false;
  const ctx: DashboardReadContext = {
    actor: { id: actorId, name: 'Reader', email: 'reader@example.test' }, workspaceId, membership, now: new Date('2026-01-01T00:00:00Z'),
    sql: { async query<T>(sql: string, values: unknown[] = []) {
      let rows: object[];
      if (sql.startsWith('SELECT m.*')) rows = revoked ? [] : [{ user_id: actorId, workspace_id: workspaceId, capabilities: [...caps], project_ids: membership.projectIds, version: 1, revoked_at: null }];
      else if (sql.includes('FROM memberships m JOIN users u')) {
        const requested = values[1] as string[] | undefined;
        rows = identities.filter(identity => (!requested || requested.includes(identity.id)) && (values[2] !== 'PRJ-1' || identity.id === actorId));
      } else if (sql.startsWith('SELECT id,project_id,version,data') || sql.startsWith('SELECT project_id,data,updated_at')) {
        rows = assignments.filter(assignment => (values[1] as string[]).includes(assignment.project_id));
      } else if (sql.startsWith('SELECT id,data')) rows = (values[1] as string[]).includes(teamId) ? [teamRow] : [];
      else if (sql.startsWith('SELECT * FROM dashboard_records')) rows = values[1] === 'project_team' || (Array.isArray(values[1]) && values[1].includes(teamId)) ? [teamRow] : [];
      else throw new Error(`Unexpected reader SQL: ${sql}`);
      return { rows: rows as T[], rowCount: rows.length };
    } },
    core: {
      async list(kind) { assert.notEqual(scope, 'access-only', 'management alone must not read core entities'); return kind === 'project' ? projects : kind === 'work_item' ? tasks : []; },
      async records() { assert.notEqual(scope, 'access-only', 'management alone must not read core records'); return records; },
      configuration() { assert.notEqual(scope, 'access-only', 'management alone must not read core configuration'); return configuration; },
      async get() { throw new Error('Team reads do not fetch individual core entities'); },
      async sprintHistory() { throw new Error('Team reads do not invent task activity from history'); },
    },
  };
  return { ctx, records, open, revoke() { revoked = true; } };
}

test('team directory deduplicates visible tasks with canonical categories and never exposes hidden identities or assignment activity', async () => {
  const { ctx } = readerFixture();
  const result = await readTeamDirectory(ctx);
  assert.equal(result.canManage, false);
  assert.deepEqual(result.projects.map(project => project.id), ['PRJ-1']);
  const team = result.teams[0]!;
  assert.deepEqual(team.projectIds, ['PRJ-1']);
  assert.deepEqual(team.data.memberIds, [actorId]);
  assert.deepEqual(team.data.maintainerIds, [actorId]);
  assert.equal(team.createdBy, null);
  assert.equal(team.openWorkCount, 1, 'the custom started state named done remains open; sent/stopped/archived do not');
  assert.equal(team.scopeComplete, false);
  assert.equal(team.activityAt, '2020-01-03T00:00:00.000Z');
  for (const hidden of [hiddenId, 'PRJ-2', 'TASK-5', '2090-01-01']) assert.equal(JSON.stringify(result).includes(hidden), false, hidden);
});

test('unrestricted reader statistics include only authoritative distinct open work', async () => {
  const { ctx } = readerFixture('workspace');
  const result = await readTeamDirectory(ctx);
  assert.equal(result.canManage, true);
  assert.deepEqual(result.teams[0]?.projectIds, ['PRJ-1', 'PRJ-2']);
  assert.equal(result.teams[0]?.openWorkCount, 2);
  assert.equal(result.teams[0]?.scopeComplete, true);
  assert.equal(result.projects.every(project => project.canManage), true);
});

test('stale or unclassified task facts yield unknown counts rather than optimistic zero', async () => {
  for (const failure of ['stale', 'unclassified'] as const) {
    const { ctx, open } = readerFixture('workspace');
    if (failure === 'stale') open.stale = true;
    else open.entity.status = 'not-in-current-workflow';
    const result = await readTeamDirectory(ctx);
    assert.equal(result.teams[0]?.openWorkCount, null);
    assert.equal(result.teams[0]?.scopeComplete, false);
  }
});

test('access-only managers maintain teams without reading core or disclosing project IDs/statistics', async () => {
  const { ctx } = readerFixture('access-only');
  const result = await readTeamDirectory(ctx);
  assert.equal(result.canManage, true);
  assert.deepEqual(result.projects, []);
  assert.deepEqual(result.teams[0]?.projectIds, []);
  assert.equal(result.teams[0]?.openWorkCount, null);
  assert.equal(result.teams[0]?.scopeComplete, false);
  assert.equal(result.teams[0]?.activityAt, '2020-01-02T00:00:00.000Z');
  assert.equal(JSON.stringify(result).includes('PRJ-'), false);
});

test('the team directory refreshes revocation instead of trusting the route snapshot', async () => {
  const fixture = readerFixture();
  fixture.revoke();
  await assert.rejects(readTeamDirectory(fixture.ctx), { code: 'not_found_or_forbidden' });
});
