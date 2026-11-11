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
  const names = ['dataDir', 'projectRoot', 'nodePath'];
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

test('update UI keeps versions, unsupported reasons and errors visible without enabling install', async () => {
  const page = await connectionPage();
  page.receiveState({ ...page.state, update: {
    status: 'unavailable', enabled: false, currentVersion: '0.1.1-preview.1', targetVersion: '', channel: 'preview',
    message: 'Unsigned macOS updates are unavailable.', error: '', canCheck: false, canDownload: false, canInstall: false,
  } });
  assert.match(page.element('#update-versions').textContent, /0.1.1-preview.1.*preview/);
  assert.match(page.element('#update-detail').textContent, /Unsigned macOS/);
  for (const action of ['check', 'download', 'install']) assert.equal(page.element(`#update-${action}`).disabled, true);
  await page.click('#update-install');
  assert.equal(page.calls.length, 0);
  page.receiveState({ ...page.state, update: {
    status: 'error', currentVersion: '0.1.1-preview.1', targetVersion: '0.1.1-preview.2', channel: 'preview',
    error: 'Migration fingerprint differs. Installation blocked.', testPackage: true, canCheck: true,
  } });
  assert.match(page.element('#update-versions').textContent, /0.1.1-preview.2/);
  assert.match(page.element('#update-error').textContent, /Migration fingerprint/);
  assert.equal(page.element('#update-test-warning').hidden, false);
  assert.equal(page.element('#update-install').disabled, true);
});

test('update progress blocks connection and maintenance but preserves explicit download cancellation', async () => {
  const page = await connectionPage();
  page.receiveState({ ...page.state, update: {
    status: 'downloading', busy: true, currentVersion: '0.1.1-preview.1', targetVersion: '0.1.1-preview.2',
    canCancel: true, progress: { percent: 25, transferred: 1_048_576, total: 4_194_304, bytesPerSecond: 524_288 },
  } });
  assert.equal(page.element('#continue').disabled, true);
  assert.equal(page.element('#manage-workspace').disabled, true);
  assert.equal(page.element('#backup').disabled, true);
  assert.equal(page.element('#update-install').disabled, true);
  assert.equal(page.element('#update-progress').hidden, false);
  assert.equal(page.element('#update-progress').value, 25);
  assert.match(page.element('#update-transfer').textContent, /25.0%.*1.0 \/ 4.0 MiB/);
  await page.click('#update-cancel');
  assert.equal(page.calls[0].action, 'update-cancel');
});

test('verified update requires an explicit restart action and UI does not infer success after IPC errors', async () => {
  const page = await connectionPage();
  const ready = { ...page.state, update: {
    status: 'downloaded', busy: false, currentVersion: '0.1.1-preview.1', targetVersion: '0.1.1-preview.2', canInstall: true,
  } };
  page.receiveState(ready);
  assert.equal(page.calls.length, 0);
  assert.equal(page.element('#update-install').disabled, false);
  page.setResponse(async () => { throw new Error('Draft cancellation preserved the workspace.'); });
  await page.click('#update-install');
  assert.equal(page.calls[0].action, 'update-install');
  assert.match(page.element('#error').textContent, /Draft cancellation/);
  assert.doesNotMatch(page.element('#update-status').textContent, /正在启动安装器/);
});
