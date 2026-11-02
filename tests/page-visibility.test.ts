import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPageVisibilityStore } from '../apps/web/src/features/pm/service/page-visibility.ts';

test('hidden documents cannot open streams and visibility changes notify all consumers without losing state', () => {
  const listeners = new Set<() => void>();
  const source = { visibilityState: 'hidden', addEventListener: (_: 'visibilitychange', f: () => void) => { listeners.add(f); }, removeEventListener: (_: 'visibilitychange', f: () => void) => { listeners.delete(f); } };
  const store = createPageVisibilityStore(source);
  assert.equal(store.getSnapshot(), false);
  const observed: boolean[] = [];
  const unsubscribe = store.subscribe(() => observed.push(store.getSnapshot()));
  for (const state of ['visible', 'hidden', 'visible']) { source.visibilityState = state; listeners.forEach(f => f()); }
  assert.deepEqual(observed, [true, false, true]);
  unsubscribe(); unsubscribe(); assert.equal(listeners.size, 0);
  assert.equal(createPageVisibilityStore().getServerSnapshot(), false);
  assert.equal(createPageVisibilityStore().getSnapshot(), false);
});
