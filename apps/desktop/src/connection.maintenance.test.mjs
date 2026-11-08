import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

// Small DOM adapter executes the actual renderer handlers. It offers no native
// filesystem or storage fallback, and deliberately does not inspect source text.
async function connectionPage() {
  const elements = new Map(), calls = [], windowEvents = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      value: '', checked: false, hidden: false, disabled: false, dataset: {}, textContent: '', handlers: new Map(),
      classList: { toggle() {} }, setAttribute() {}, removeAttribute() {}, focus() {},
      addEventListener(event, handler) { this.handlers.set(event, handler); },
    });
    return elements.get(selector);
  };
  const form = element('#connection-form');
  const names = ['dataDir', 'projectRoot', 'nodePath', 'email', 'name', 'password', 'workspaceName', 'createAccount'];
  form.elements = names.map(name => { const value = element(`form:${name}`); value.name = name; return value; });
  form.elements.namedItem = name => element(`form:${name}`);
  form.querySelector = element;
  const secrets = ['#backup-password', '#backup-password-confirm', '#restore-password'].map(element);
  let receiveState;
  let response = async () => undefined;
  const state = { status: 'idle', maintenanceAllowed: true, localRunning: false, configuration: { mode: 'local', dataDir: '/private/workspace', projectRoot: '/private/projects' } };
  const bridge = {
    platform: 'linux', onState(listener) { receiveState = listener; },
    async invoke(action, options) {
      if (action === 'state') return state;
      calls.push({ action, options: options ? JSON.parse(JSON.stringify(options)) : undefined, secretsAtInvoke: secrets.map(input => input.value) });
      return response(action, options);
    },
  };
  const document = {
    documentElement: { dataset: {} }, body: { dataset: {} }, querySelector: element,
    querySelectorAll(selector) { return selector === '#backup-password, #backup-password-confirm, #restore-password' ? secrets : []; },
  };
  const window = { desktopConnection: bridge, addEventListener(event, handler) { windowEvents.set(event, handler); } };
  vm.runInNewContext(await readFile(new URL('./connection.mjs', import.meta.url), 'utf8'), { window, document });
  await new Promise(resolve => setImmediate(resolve));
  receiveState(state);
  return {
    element, calls, windowEvents, receiveState, state,
    setResponse(handler) { response = handler; },
    click(selector) { return element(selector).handlers.get('click')(); },
  };
}

test('data manager requires matching strong passwords and clears secrets before the backup IPC/dialog phase', async () => {
  const page = await connectionPage();
  await page.click('#manage-workspace');
  page.element('#backup-password').value = 'independent backup passphrase';
  page.element('#backup-password-confirm').value = 'different';
  await page.click('#backup');
  assert.equal(page.calls.length, 0);
  page.element('#backup-password-confirm').value = page.element('#backup-password').value;
  let release;
  page.setResponse(() => new Promise(resolve => { release = resolve; }));
  const pending = page.click('#backup');
  assert.equal(page.calls[0].action, 'backup');
  assert.equal(page.calls[0].options.password, 'independent backup passphrase');
  assert.deepEqual(page.calls[0].secretsAtInvoke, ['', '', '']);
  assert.equal(page.element('#restore').disabled, true);
  assert.equal(page.element('#maintenance-back').disabled, true);
  release(); await pending;
  assert.equal(page.element('#backup-password').value, '');
  assert.equal(page.element('#backup-password-confirm').value, '');
});

test('encrypted restore also requires a fresh trusted-source acknowledgement independently of a valid password', async () => {
  const page = await connectionPage(); await page.click('#manage-workspace');
  page.element('#restore-password').value = 'valid synthetic backup password';
  await page.click('#restore'); assert.equal(page.calls.length, 0);
  page.element('#restore-trusted-source').checked = true;
  await page.click('#restore');
  assert.deepEqual(page.calls[0].options, { password: 'valid synthetic backup password', allowLegacyUnencrypted: false, trustedSourceAcknowledged: true });
  assert.equal(page.element('#restore-trusted-source').checked, false);
  assert.equal(page.element('#restore-password').value, '');
  page.element('#restore-password').value = 'another valid backup password';
  await page.click('#restore'); assert.equal(page.calls.length, 1);
});

test('legacy permission is opt-in for one restore and is reset on cancellation, failure and navigation', async () => {
  const page = await connectionPage(); await page.click('#manage-workspace');
  await page.click('#restore'); assert.equal(page.calls.length, 0);
  page.element('#restore-legacy').checked = true;
  await page.click('#restore'); assert.equal(page.calls.length, 0);
  page.element('#restore-trusted-source').checked = true;
  await page.click('#restore');
  assert.deepEqual(page.calls[0].options, { password: '', allowLegacyUnencrypted: true, trustedSourceAcknowledged: true });
  assert.equal(page.element('#restore-legacy').checked, false);
  assert.equal(page.element('#restore-trusted-source').checked, false);
  page.element('#restore-password').value = 'synthetic restore password';
  page.element('#restore-trusted-source').checked = true;
  page.setResponse(async () => { throw new Error('Backup authentication failed.'); });
  await page.click('#restore');
  assert.deepEqual(page.calls[1].options, { password: 'synthetic restore password', allowLegacyUnencrypted: false, trustedSourceAcknowledged: true });
  assert.equal(page.element('#restore-password').value, '');
  assert.equal(page.element('#restore-trusted-source').checked, false);
  assert.equal(page.element('#maintenance-error').hidden, false);
  page.element('#restore-password').value = 'never retain on navigation';
  page.element('#restore-legacy').checked = true;
  page.element('#restore-trusted-source').checked = true;
  await page.click('#maintenance-back');
  assert.equal(page.element('#restore-password').value, '');
  assert.equal(page.element('#restore-legacy').checked, false);
  assert.equal(page.element('#restore-trusted-source').checked, false);
  page.element('#backup-password').value = 'never retain on pagehide';
  page.element('#restore-trusted-source').checked = true;
  page.windowEvents.get('pagehide')();
  assert.equal(page.element('#backup-password').value, '');
  assert.equal(page.element('#restore-trusted-source').checked, false);
});
