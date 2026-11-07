import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recoveryFixture, type RecoveryFixture } from './recovery.testkit.ts';

for (const [name, mutate] of [
  ['Provider revision changes', (f: RecoveryFixture) => f.provider('account:2')],
  ['unknown failure revision', (f: RecoveryFixture) => f.mutate({ providerInstanceRevision: undefined })],
  ['request snapshot changes', (f: RecoveryFixture) => f.mutate({ requestBinding: 'different-snapshot' })],
  ['newer user turn exists', (f: RecoveryFixture) => f.mutate({ latest: false })],
  ['reset timestamp changes', (f: RecoveryFixture) => f.mutate({ resetAt: '2026-01-01T01:00:00.000Z' })],
  ['Session removed by cutover', (f: RecoveryFixture) => f.removeSource()],
] as const) {
  test(`${name} revokes waiting recovery before dispatch`, async () => {
    const f = recoveryFixture(), service = f.createService();
    service.setRecovery('quota', true); mutate(f); f.advance(60000); await service.tick();
    assert.equal(f.continuations.length, 0); assert.equal(service.recoveries()[0]!.state, 'blocked');
  });
}

test('invalid Provider identity is rejected before consent is persisted', () => {
  const f = recoveryFixture(), service = f.createService();
  f.provider(null); assert.throws(() => service.setRecovery('quota', true), /Provider/);
  assert.deepEqual(service.recoveries(), []);
});

test('response lost after exact Chat continuation acceptance is reconciled without a duplicate effect', async () => {
  const f = recoveryFixture(), service = f.createService();
  service.setRecovery('quota', true); f.advance(60000); f.fail(new Error('response lost'), true);
  await service.tick(); await service.tick();
  assert.equal(f.continuations.length, 1);
  assert.equal(service.dispatches()[0]!.status, 'dispatched');
  assert.equal(service.recoveries()[0]!.continuationRunId, 'continuation');
});

test('stopped recovery service never schedules a fresh continuation', async () => {
  const f = recoveryFixture(), service = f.createService();
  service.setRecovery('quota', true); await service.stop(); f.advance(60000); await service.tick();
  assert.equal(f.continuations.length, 0);
});
