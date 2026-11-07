import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recoveryFixture } from './recovery.testkit.ts';

test('explicit current Chat recovery consent waits for reset and dispatches exactly one immutable continuation', async () => {
  const f = recoveryFixture(), service = f.createService();
  const consent = service.setRecovery('quota', true);
  assert.equal(consent.state, 'waiting');
  assert.ok(!JSON.stringify(service.recoveries()).includes('immutable-request-snapshot'));
  await service.tick(); assert.equal(f.continuations.length, 0);
  f.advance(30000);
  await Promise.all([service.tick(), service.tick()]);
  assert.equal(f.continuations.length, 1);
  assert.equal(service.recoveries()[0]!.continuationRunId, 'continuation');
  assert.equal(service.dispatches('quota')[0]!.status, 'dispatched');
  await service.tick(); assert.equal(f.continuations.length, 1);
  assert.throws(() => service.setRecovery('quota', true), /已经自动续跑/);
});

test('cancelled consent and archived resource schedules/watches cannot reach the Chat dispatch adapter', async () => {
  const f = recoveryFixture(), service = f.createService();
  f.store.writeRecord('automation.schedules', 'old-schedule', { enabled: true, request: { threadId: 'session' } });
  f.store.writeRecord('automation.watches', 'old-watch', { enabled: true, request: { threadId: 'session' } });
  f.store.writeRecord('automation.recovery', 'old-resource-run', { runId: 'old-resource-run', kind: 'workspace', enabled: true, state: 'waiting', resetAt: f.source().resetAt });
  service.setRecovery('quota', true); service.setRecovery('quota', false); f.advance(60000);
  await service.tick(true);
  assert.equal(f.continuations.length, 0);
  assert.equal(service.recoveries().length, 1); assert.equal(service.recoveries()[0]!.state, 'cancelled');
  assert.ok(f.store.readRecord('automation.schedules', 'old-schedule'), 'Business definitions are retained, not silently migrated into executable Sessions');
});

test('a restart reconciles an already accepted exact continuation receipt without resending', async () => {
  const f = recoveryFixture(), service = f.createService();
  service.setRecovery('quota', true); f.advance(60000);
  const consent = f.store.readRecord<{ revision: number }>('automation.recovery', 'quota')!;
  f.store.writeRecord('automation.dispatches', 'pending', { id: 'pending', sourceType: 'recovery', sourceId: 'quota', sourceRevision: consent.revision, key: 'original', idempotencyKey: 'exact-accepted-key', threadId: 'session', reason: 'consented reset', status: 'pending', createdAt: '2026-01-01T00:01:00.000Z' });
  f.mutate({ continuationRunId: 'already-accepted', continuationIdempotencyKey: 'exact-accepted-key', latest: false });
  await f.createService().tick(true);
  assert.equal(f.continuations.length, 0);
  assert.equal(service.dispatches()[0]!.status, 'dispatched');
  assert.equal(service.recoveries()[0]!.continuationRunId, 'already-accepted');
});

test('unknown authorization or side-effect outcomes are visible and never automatically retried', async () => {
  const f = recoveryFixture(), service = f.createService();
  service.setRecovery('quota', true); f.advance(60000); f.fail(new Error('PM login expired before acceptance'));
  await service.tick(); await service.tick();
  assert.equal(f.continuations.length, 0);
  assert.equal(service.dispatches()[0]!.status, 'failed');
  assert.equal(service.recoveries()[0]!.state, 'blocked');
  assert.throws(() => service.setRecovery('quota', true), /恢复派发已失败/);
});
