import assert from 'node:assert/strict';
import test from 'node:test';
import { projectDirectoryCommands } from '../src/project-directory.ts';

const member = '11111111-1111-4111-8111-111111111111';
const team = '22222222-2222-4222-8222-222222222222';

test('team commands reject permission grants, spoofed identities and unknown payload fields', () => {
  for (const [commandType, payload] of [
    ['CreateProjectTeam', { name: 'Real team', memberIds: [member], capabilities: ['access.manage'] }],
    ['CreateProjectTeam', { name: 'Real team', memberIds: [member], actorId: member }],
    ['SetProjectTeamMembers', { memberIds: [member], projectIds: ['PRJ-1'] }],
    ['SetProjectTeams', { teamIds: [team], grantProjectAccess: true }],
    ['ArchiveProjectTeam', { archivedAt: '2000-01-01T00:00:00.000Z' }],
    ['RenameProjectTeam', { name: 'Renamed', memberIds: [] }],
    ['UpdateProjectTeamDetails', { name: 'Details', identifier: null, description: '', focus: null, responseTargetHours: null, memberIds: [] }],
    ['SetProjectTeamMaintainers', { maintainerIds: [], capabilities: ['access.manage'] }],
  ] as const) assert.equal(projectDirectoryCommands[commandType]!.payload.safeParse(payload).success, false, commandType);
});

test('team rosters and assignments reject duplicates, invalid IDs and unbounded input', () => {
  const roster = projectDirectoryCommands.SetProjectTeamMembers!.payload;
  for (const memberIds of [[member, member], ['someone@example.test'], ['PRJ-1'], Array.from({ length: 1001 }, () => member)]) assert.equal(roster.safeParse({ memberIds }).success, false);
  const assignment = projectDirectoryCommands.SetProjectTeams!.payload;
  for (const teamIds of [[team, team], ['PRJ-1'], Array.from({ length: 101 }, () => team)]) assert.equal(assignment.safeParse({ teamIds }).success, false);
  const rename = projectDirectoryCommands.RenameProjectTeam!.payload;
  for (const name of ['', '   ', 'x'.repeat(161)]) assert.equal(rename.safeParse({ name }).success, false);
});

test('team details have explicit unknown defaults and bounded nullable facts', () => {
  const create = projectDirectoryCommands.CreateProjectTeam!.payload;
  assert.deepEqual(create.parse({ name: '  Support  ' }), {
    name: 'Support', memberIds: [], maintainerIds: [], identifier: null, description: '', focus: null, responseTargetHours: null,
  });
  const update = projectDirectoryCommands.UpdateProjectTeamDetails!.payload;
  const valid = { name: 'Support', identifier: 'SUP', description: 'Shared support', focus: 'Triage', responseTargetHours: 0 };
  assert.equal(update.safeParse(valid).success, true);
  assert.equal(update.safeParse({ ...valid, identifier: null, focus: null, responseTargetHours: null }).success, true);
  for (const responseTargetHours of [-1, 8761, Number.NaN, Number.POSITIVE_INFINITY, '2']) {
    assert.equal(update.safeParse({ ...valid, responseTargetHours }).success, false);
  }
  for (const invalid of [
    { ...valid, identifier: '' }, { ...valid, identifier: 'x'.repeat(65) }, { ...valid, description: 'x'.repeat(5001) },
    { ...valid, focus: ' ' }, { ...valid, focus: 'x'.repeat(501) }, { name: 'Not a full update' }, { ...valid, maintainerIds: [] },
  ]) assert.equal(update.safeParse(invalid).success, false);
});

test('maintainer roles reject duplicate, malformed and unbounded identities without accepting permission fields', () => {
  const role = projectDirectoryCommands.SetProjectTeamMaintainers!.payload;
  assert.equal(role.safeParse({ maintainerIds: [member] }).success, true);
  assert.equal(role.safeParse({ maintainerIds: [] }).success, true);
  for (const maintainerIds of [[member, member], ['not-a-user'], Array.from({ length: 1001 }, () => member)]) {
    assert.equal(role.safeParse({ maintainerIds }).success, false);
  }
  assert.equal(role.safeParse({ maintainerIds: [member], role: 'admin' }).success, false);
});
