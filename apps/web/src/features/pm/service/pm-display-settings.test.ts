import assert from 'node:assert/strict';
import test from 'node:test';
import { pmDisplayDefaults, readPmDisplaySettings, readPmDisplayStorage, resetPmDisplaySettings, subscribePmDisplaySettings, writePmDisplaySettings } from './pm-display-settings.ts';

test('workspace layout persistence retains current session choices through real storage failure boundaries', async t => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const values = new Map<string, string>();
  const events = new EventTarget();
  let failRead = false;
  let failWrite = false;
  let failRemove = false;
  let denyAccess = false;
  const storage: Storage = {
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => { if (failRead) throw new Error('Read denied'); return values.get(key) ?? null; },
    setItem: (key, value) => { if (failWrite) throw new Error('Quota exceeded'); values.set(key, value); },
    removeItem: key => { if (failRemove) throw new Error('Removal denied'); values.delete(key); },
    clear: () => { values.clear(); },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    get localStorage() { if (denyAccess) throw new Error('Storage access denied'); return storage; },
    addEventListener: events.addEventListener.bind(events),
  } });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const key = (workspace: string) => `pm.display-settings.v1:${workspace}`;
  const notify = (changedKey: string | null) => events.dispatchEvent(Object.assign(new Event('storage'), { key: changedKey, storageArea: storage }));

  await t.test('successful changes and reset persist only the selected workspace and notify subscribers', context => {
    let changes = 0;
    const unsubscribe = subscribePmDisplaySettings('saved', () => { changes++; });
    context.after(unsubscribe);
    const next = { ...pmDisplayDefaults, dashboardView: 'dashboard3' as const };
    writePmDisplaySettings('saved', next);
    assert.deepEqual(JSON.parse(values.get(key('saved'))!), next);
    assert.deepEqual(readPmDisplaySettings('saved'), next);
    assert.equal(readPmDisplayStorage('saved'), 'available');
    assert.deepEqual(readPmDisplaySettings('untouched'), pmDisplayDefaults);
    resetPmDisplaySettings('saved');
    assert.equal(values.has(key('saved')), false);
    assert.deepEqual(readPmDisplaySettings('saved'), pmDisplayDefaults);
    assert.equal(changes, 2);
  });

  await t.test('quota failure keeps newer choices through rereads, cross-tab updates and clear until explicit save', context => {
    const old = { ...pmDisplayDefaults, dashboardView: 'dashboard2' as const };
    values.set(key('quota'), JSON.stringify(old));
    assert.deepEqual(readPmDisplaySettings('quota'), old);
    const unsubscribe = subscribePmDisplaySettings('quota', () => {});
    context.after(unsubscribe);
    const next = { ...old, dashboardView: 'dashboard4' as const };
    failWrite = true;
    writePmDisplaySettings('quota', next);
    failWrite = false;
    assert.equal(values.get(key('quota')), JSON.stringify(old));
    assert.equal(readPmDisplayStorage('quota'), 'unavailable');
    assert.deepEqual(readPmDisplaySettings('quota'), next);
    notify(key('quota'));
    assert.deepEqual(readPmDisplaySettings('quota'), next);
    storage.clear();
    notify(null);
    assert.deepEqual(readPmDisplaySettings('quota'), next);
    assert.equal(readPmDisplayStorage('quota'), 'unavailable');
    assert.equal(readPmDisplayStorage('untouched'), 'available');
    writePmDisplaySettings('quota', readPmDisplaySettings('quota'));
    assert.equal(readPmDisplayStorage('quota'), 'available');
    assert.deepEqual(JSON.parse(values.get(key('quota'))!), next);
  });

  await t.test('read and storage-access failures are reported without throwing or discarding in-memory writes', () => {
    failRead = true;
    assert.deepEqual(readPmDisplaySettings('read-denied'), pmDisplayDefaults);
    assert.equal(readPmDisplayStorage('read-denied'), 'unavailable');
    failRead = false;
    writePmDisplaySettings('read-denied', readPmDisplaySettings('read-denied'));
    assert.equal(readPmDisplayStorage('read-denied'), 'available');
    denyAccess = true;
    const next = { ...pmDisplayDefaults, issueView: 'board2' as const };
    writePmDisplaySettings('access-denied', next);
    assert.deepEqual(readPmDisplaySettings('access-denied'), next);
    assert.equal(readPmDisplayStorage('access-denied'), 'unavailable');
    denyAccess = false;
    writePmDisplaySettings('access-denied', readPmDisplaySettings('access-denied'));
    assert.deepEqual(JSON.parse(values.get(key('access-denied'))!), next);
    assert.equal(readPmDisplayStorage('access-denied'), 'available');
  });

  await t.test('failed removal keeps reset defaults rather than reviving the old saved layout', () => {
    const old = { ...pmDisplayDefaults, projectListView: 'list3' as const };
    values.set(key('reset-denied'), JSON.stringify(old));
    assert.deepEqual(readPmDisplaySettings('reset-denied'), old);
    failRemove = true;
    resetPmDisplaySettings('reset-denied');
    failRemove = false;
    assert.equal(readPmDisplayStorage('reset-denied'), 'unavailable');
    assert.equal(values.get(key('reset-denied')), JSON.stringify(old));
    notify(key('reset-denied'));
    assert.deepEqual(readPmDisplaySettings('reset-denied'), pmDisplayDefaults);
    resetPmDisplaySettings('reset-denied');
    assert.equal(values.has(key('reset-denied')), false);
    assert.equal(readPmDisplayStorage('reset-denied'), 'available');
  });

  await t.test('damaged values recover safely and normal cross-tab updates remain workspace-specific', context => {
    values.set(key('malformed'), '{broken');
    assert.deepEqual(readPmDisplaySettings('malformed'), pmDisplayDefaults);
    assert.equal(readPmDisplayStorage('malformed'), 'recovered');
    values.set(key('partial'), JSON.stringify({ dashboardView: 'dashboard2', issueView: 'unsupported' }));
    assert.deepEqual(readPmDisplaySettings('partial'), { ...pmDisplayDefaults, dashboardView: 'dashboard2' });
    assert.equal(readPmDisplayStorage('partial'), 'recovered');
    writePmDisplaySettings('partial', readPmDisplaySettings('partial'));
    assert.equal(readPmDisplayStorage('partial'), 'available');
    let firstChanges = 0;
    let secondChanges = 0;
    context.after(subscribePmDisplaySettings('first-tab', () => { firstChanges++; }));
    context.after(subscribePmDisplaySettings('second-tab', () => { secondChanges++; }));
    assert.deepEqual(readPmDisplaySettings('first-tab'), pmDisplayDefaults);
    assert.deepEqual(readPmDisplaySettings('second-tab'), pmDisplayDefaults);
    const next = { ...pmDisplayDefaults, notificationView: 'inbox4' as const };
    values.set(key('first-tab'), JSON.stringify(next));
    notify(key('first-tab'));
    assert.deepEqual(readPmDisplaySettings('first-tab'), next);
    assert.deepEqual(readPmDisplaySettings('second-tab'), pmDisplayDefaults);
    assert.equal(firstChanges, 1);
    assert.equal(secondChanges, 0);
    storage.clear();
    notify(null);
    assert.deepEqual(readPmDisplaySettings('first-tab'), pmDisplayDefaults);
    assert.equal(firstChanges, 2);
    assert.equal(secondChanges, 1);
  });
});
