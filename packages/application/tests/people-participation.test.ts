import assert from 'node:assert/strict';
import test from 'node:test';
import { peopleCandidateQuerySchema, peopleCommands } from '../src/people.ts';
import { projectDirectoryCommands } from '../src/project-directory.ts';

const member = '11111111-1111-4111-8111-111111111111';
test('participation accepts only an explicit bounded unique roster, never grants or task mutations', () => {
  const payload = peopleCommands.SetProjectParticipants!.payload;
  assert.deepEqual(payload.parse({ memberIds: [] }), { memberIds: [] });
  assert.deepEqual(payload.parse({ memberIds: [member] }), { memberIds: [member] });
  for (const invalid of [
    { memberIds: [member, member] }, { memberIds: ['person@example.test'] },
    { memberIds: Array.from({ length: 1001 }, () => member) },
    { memberIds: [member], capabilities: ['access.manage'] }, { memberIds: [], assigneeId: null },
  ]) assert.equal(payload.safeParse(invalid).success, false);
});

test('candidate queries bind purpose to scope and enforce bounded paging', () => {
  for (const purpose of ['assignee', 'participant']) {
    assert.equal(peopleCandidateQuerySchema.safeParse({ purpose }).success, false);
    assert.equal(peopleCandidateQuerySchema.safeParse({ purpose, projectId: 'PRJ-001', limit: '100' }).success, true);
  }
  for (const purpose of ['team', 'project_owner']) {
    assert.equal(peopleCandidateQuerySchema.safeParse({ purpose }).success, true);
    assert.equal(peopleCandidateQuerySchema.safeParse({ purpose, projectId: 'PRJ-001' }).success, false);
  }
  for (const invalid of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { after: '' }, { q: 'x'.repeat(201) }]) {
    assert.equal(peopleCandidateQuerySchema.safeParse({ purpose: 'team', ...invalid }).success, false);
  }
});

test('team restoration has no authority or roster-injection payload', () => {
  const payload = projectDirectoryCommands.RestoreProjectTeam!.payload;
  assert.deepEqual(payload.parse({}), {});
  for (const invalid of [{ memberIds: [member] }, { capabilities: ['access.manage'] }, { projectIds: null }]) assert.equal(payload.safeParse(invalid).success, false);
});
