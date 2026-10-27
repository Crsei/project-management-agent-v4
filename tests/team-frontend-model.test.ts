import test from 'node:test';
import assert from 'node:assert/strict';
import type { TeamWorkload } from '../packages/domain/src/team-workload.ts';
import { directoryTeams, peopleDirectoryRows, teamRecord, workloadProjection, type TeamProjectionFilters } from '../apps/web/src/features/pm/service/pm-team-model.ts';

const interaction: TeamProjectionFilters = { query: '', teamId: null, workloadStateFilter: 'all' };
const member = { membershipId: 'person-a', userId: 'person-a', name: 'Actual person', email: '', role: 4, scope: 'unknown', projectId: null, isActive: true, isOwner: false, version: '', presence: 'away' as const, teams: [{ id: 'team-a', name: 'Actual team' }] };
function workload(): TeamWorkload {
  return {
    serverNow: '2026-10-20T12:00:00.000Z', unit: 'concurrent_open_points',
    members: [{ userId: member.userId, teamIds: ['team-a'], taskIds: ['TASK-1', 'TASK-2'], openCount: 1, doneCount: 1, knownOpenPoints: 0, unknownEstimateCount: 1, capacity: { id: 'capacity-a', version: 7, capacityPoints: 0 }, capacityPoints: 0, overloaded: null, scope: { complete: false, reason: 'partial' } }],
    tasks: [
      { id: 'TASK-1', title: 'Actual open task', projectId: 'PRJ-1', assigneeId: member.userId, assigneeStatus: 'assigned', teamIds: ['team-a'], status: 'building', statusCategory: 'started', open: true, done: false, estimatePoints: null },
      { id: 'TASK-2', title: 'Actual delivered task', projectId: 'PRJ-1', assigneeId: member.userId, assigneeStatus: 'assigned', teamIds: ['team-a'], status: 'shipped', statusCategory: 'completed', open: false, done: true, estimatePoints: 0 },
      { id: 'TASK-3', title: 'Visible pool task', projectId: 'PRJ-1', assigneeId: null, assigneeStatus: 'unavailable', teamIds: ['team-a'], status: 'building', statusCategory: 'started', open: true, done: false, estimatePoints: 2 },
      { id: 'TASK-4', title: 'Other team pool task', projectId: 'PRJ-2', assigneeId: null, assigneeStatus: 'unassigned', teamIds: ['team-b'], status: 'building', statusCategory: 'started', open: true, done: false, estimatePoints: 4 },
    ],
    unassignedTaskIds: ['TASK-3', 'TASK-4'],
    teams: [{ id: 'team-a', name: 'Actual team', memberIds: [member.userId], taskIds: ['TASK-1', 'TASK-2', 'TASK-3'] }, { id: 'team-b', name: 'Another team', memberIds: [], taskIds: ['TASK-4'] }],
    summary: { openCount: 3, doneCount: 1, knownOpenPoints: 6, unknownEstimateCount: 1, unknownAssigneeCount: 1, overloadedMemberCount: 0, unknownOverloadMemberCount: 1 },
    scope: { complete: false, projectIds: ['PRJ-1', 'PRJ-2'], reason: 'projects' },
  };
}

test('team projection preserves explicit zero targets, unknown work and visible maintainer facts', () => {
  const team = teamRecord({ id: 'team-a', workspaceId: 'workspace', projectId: null, kind: 'project_team', ownerId: null, version: 4, createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z', createdBy: null,
    data: { name: 'Actual team', identifier: null, description: 'Real responsibility', focus: 'Delivery', responseTargetHours: 0, memberIds: [member.userId], maintainerIds: [member.userId], archivedAt: null },
    projectIds: ['PRJ-1'], activityAt: '2026-10-20T00:00:00.000Z', openWorkCount: null, scopeComplete: false });
  assert.equal(team.identifier, null);
  assert.equal(team.responseTarget, '0h');
  assert.equal(team.openWorkCount, null);
  assert.equal(team.scopeComplete, false);
  assert.equal(team.members[0]?.role, 'maintainer');
  assert.equal(team.version, '4');
});

test('directory uses lawful member summaries without inventing roles or full team rosters', () => {
  const teams = directoryTeams([member], []);
  assert.equal(teams[0]?.name, 'Actual team');
  assert.deepEqual(teams[0]?.members, []);
  assert.equal(teams[0]?.scopeComplete, false);
  const rows = peopleDirectoryRows([member], teams, { ...interaction, teamId: 'team-a', presenceFilter: 'away', query: 'Actual team' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.member.role, 4);
  assert.equal(rows[0]?.membership, null);
  assert.equal(peopleDirectoryRows([member], teams, { ...interaction, presenceFilter: 'available' }).length, 0);
  assert.equal(peopleDirectoryRows([], teams, interaction).length, 0);
});

test('workload state and team filters agree for member rows, team groups and the pool', () => {
  const source = workload();
  const done = workloadProjection(source, [member], { ...interaction, teamId: 'team-a', workloadStateFilter: 'done' });
  assert.deepEqual(done.rows[0]?.issues.map(task => task.id), ['TASK-2']);
  assert.deepEqual(done.groups[0]?.issues.map(task => task.id), ['TASK-2']);
  assert.deepEqual(done.pool, []);
  const open = workloadProjection(source, [member], { ...interaction, teamId: 'team-a', workloadStateFilter: 'open', query: 'pool' });
  assert.deepEqual(open.pool.map(task => task.id), ['TASK-3']);
  assert.deepEqual(open.groups[0]?.issues.map(task => task.id), ['TASK-3']);
  assert.equal(open.summary.uniqueTaskCount, 1);
  assert.equal(open.unassigned.unknownAssigneeCount, 1);
});

test('person search is consistent across task projections and never turns unknown overload into false', () => {
  const source = workload();
  const result = workloadProjection(source, [member], { ...interaction, query: 'Actual person' });
  assert.deepEqual(result.rows[0]?.issues.map(task => task.id), ['TASK-1', 'TASK-2']);
  assert.deepEqual(result.groups[0]?.issues.map(task => task.id), ['TASK-1', 'TASK-2']);
  assert.equal(result.rows[0]?.overloaded, null);
  assert.equal(result.rows[0]?.capacityPoints, 0);
  assert.equal(result.rows[0]?.knownOpenPoints, 0);
  assert.equal(result.summary.unknownOverloadMembers, 1);
  assert.equal(result.rows[0]?.issues[1]?.estimatePointId, null);
  assert.equal(result.rows[0]?.issues[1]?.sourceRevision, null);
  source.members[0]!.overloaded = true;
  assert.equal(workloadProjection(source, [member], interaction).rows[0]?.overloaded, true);
});

test('a team filter retains authorized tasks assigned to someone outside that team', () => {
  const source = workload();
  source.members[0]!.teamIds = ['another-team'];
  const result = workloadProjection(source, [member], { ...interaction, teamId: 'team-a' });
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.rows[0]?.issues.map(task => task.id), ['TASK-1', 'TASK-2']);
});

test('member workload links filter by identity across rows and groups without shrinking capacity totals', () => {
  const source = workload();
  const namesake = { ...member, membershipId: 'person-b', userId: 'person-b' };
  source.members.push({ ...source.members[0]!, userId: namesake.userId, taskIds: ['TASK-5'] });
  source.tasks.push({ ...source.tasks[0]!, id: 'TASK-5', title: 'Namesake task', assigneeId: namesake.userId });
  source.teams[0]!.taskIds.push('TASK-5');
  source.members[0]!.knownOpenPoints = 8;
  source.members[0]!.capacityPoints = 5;
  source.members[0]!.overloaded = true;
  const result = workloadProjection(source, [member, namesake], {
    ...interaction, memberId: member.userId, teamId: 'team-a', workloadStateFilter: 'done',
  });
  assert.deepEqual(result.rows.map(row => row.id), [member.userId]);
  assert.deepEqual(result.rows[0]!.issues.map(task => task.id), ['TASK-2']);
  assert.deepEqual(result.groups.flatMap(group => group.issues.map(task => task.id)), ['TASK-2']);
  assert.deepEqual(result.pool, []);
  assert.deepEqual(result.unassigned.issues, []);
  assert.equal(result.rows[0]!.knownOpenPoints, 8);
  assert.equal(result.rows[0]!.capacityPoints, 5);
  assert.equal(result.rows[0]!.overloaded, true);
  const disjoint = workloadProjection(source, [member, namesake], {
    ...interaction, memberId: member.userId, teamId: 'team-b',
  });
  assert.deepEqual(disjoint.rows, []);
  assert.deepEqual(disjoint.groups.flatMap(group => group.issues), []);
  assert.deepEqual(disjoint.pool, []);
});

test('an inaccessible member deep link stays empty instead of revealing the full workload', () => {
  const result = workloadProjection(workload(), [member], { ...interaction, memberId: 'hidden-person' });
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.groups.flatMap(group => group.issues), []);
  assert.deepEqual(result.pool, []);
  assert.deepEqual(result.unassigned.issues, []);
  assert.equal(result.summary.uniqueTaskCount, 0);
});
