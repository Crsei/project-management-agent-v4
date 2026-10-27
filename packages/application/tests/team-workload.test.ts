import assert from 'node:assert/strict';
import test from 'node:test';
import { teamWorkloadCommands } from '../src/team-workload.ts';
import { MAX_MEMBER_CAPACITY_POINTS, memberOverloaded } from '../../domain/src/team-workload.ts';

const userId = '11111111-1111-4111-8111-111111111111';

test('member capacity validates explicit unknown, zero, fractional points and bounded numeric values', () => {
  const payload = teamWorkloadCommands.SetMemberCapacity!.payload;
  for (const capacityPoints of [null, 0, 0.5, 15, MAX_MEMBER_CAPACITY_POINTS]) assert.equal(payload.safeParse({ userId, capacityPoints }).success, true);
  for (const capacityPoints of [-1, Number.NaN, Infinity, -Infinity, MAX_MEMBER_CAPACITY_POINTS + 1, '0', '', undefined, false]) assert.equal(payload.safeParse({ userId, capacityPoints }).success, false);
  for (const value of [{ userId: 'someone@example.test', capacityPoints: 1 }, { userId, capacityPoints: 1, projectId: 'PRJ-1' }, { userId, capacityPoints: 1, capabilities: ['access.manage'] }]) assert.equal(payload.safeParse(value).success, false);
});

test('overload is a conservative proof, not a guess from missing estimates or hidden scope', () => {
  assert.equal(memberOverloaded(0, 0, null, true), null);
  assert.equal(memberOverloaded(0, 0, 0, true), false);
  assert.equal(memberOverloaded(0.5, 0, 0, true), true);
  assert.equal(memberOverloaded(4, 0, 5, true), false);
  assert.equal(memberOverloaded(5, 0, 5, true), false);
  assert.equal(memberOverloaded(4, 1, 5, true), null);
  assert.equal(memberOverloaded(4, 0, 5, false), null);
  assert.equal(memberOverloaded(6, 2, 5, false), true);
});
