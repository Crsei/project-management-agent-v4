import test from 'node:test';
import assert from 'node:assert/strict';
import type { BenchEvent } from '../schemas/types.ts';
import { makeEvent } from './telemetry.ts';
import { reworkFromEvents } from './rework.ts';

function attempt(operationId: string, status: 'failed' | 'succeeded', currentRevision = 'r1'): BenchEvent[] {
  return [makeEvent('r', 'transport', 'pm_request', { mutation: true, targetId: 'TASK-1', revision: 'r1', argumentsHash: 'same-input' }, { operationId, toolName: 'pm_update_task' }), makeEvent('r', 'transport', 'pm_response', { status }, { operationId }), ...(status === 'failed' ? [makeEvent('r', 'runner', 'pm_failure_checkpoint', { authorityRevision: currentRevision }, { operationId })] : [])];
}

test('same failed mutation at independently unchanged revision yields a bounded repeat proportion', () => {
  const metric = reworkFromEvents([...attempt('one', 'failed'), ...attempt('two', 'failed'), ...attempt('three', 'succeeded')], true);
  assert.equal(metric.count, 1);
  assert.equal(metric.denominator, 3);
  assert.equal(metric.proportion, 1 / 3);
});

test('stale revision conflicts and intentional loss/receipt lookup are not counted as wasted replay', () => {
  const lost = makeEvent('r', 'transport', 'response_lost', { committed: true }, { operationId: 'lost' });
  const events = [...attempt('lost', 'succeeded'), lost, ...attempt('conflict-one', 'failed', 'changed'), ...attempt('conflict-two', 'failed', 'changed'), makeEvent('r', 'transport', 'receipt_reconciled', {}, { operationId: 'lost' })];
  const metric = reworkFromEvents(events, true);
  assert.equal(metric.count, 0);
  assert.equal(metric.denominator, 0);
  assert.equal(metric.proportion, null);
});

test('unknown write outcomes and incomplete traces never invent zero rework', () => {
  assert.equal(reworkFromEvents([], false).count, null);
  const events = attempt('one', 'failed').slice(0, 1);
  assert.equal(reworkFromEvents(events, true).count, null);
  const noAuthority = [...attempt('one', 'failed').slice(0, 2), ...attempt('two', 'failed')];
  assert.equal(reworkFromEvents(noAuthority, true).count, null);
});
