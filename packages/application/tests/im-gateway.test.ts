import assert from 'node:assert/strict';
import test from 'node:test';
import { deterministicImId, truncateImText } from '../src/im-gateway.ts';

test('IM command IDs are stable UUIDs and bind every causal component', () => {
  const id = deterministicImId('telegram\0bot\0user\0workspace\0TASK-001');
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(id, deterministicImId('telegram\0bot\0user\0workspace\0TASK-001'));
  assert.notEqual(id, deterministicImId('telegram\0bot\0user\0workspace\0TASK-002'));
  assert.notEqual(id, deterministicImId('telegram\0bot\0other\0workspace\0TASK-001'));
});

test('IM text is bounded and never emits a zero-length delivery payload', () => {
  assert.equal(truncateImText('  '), '（空消息）');
  assert.equal(truncateImText('hello'), 'hello');
  const bounded = truncateImText('x'.repeat(100), 10);
  assert.equal(bounded.length, 10);
  assert.ok(bounded.endsWith('…'));
});
