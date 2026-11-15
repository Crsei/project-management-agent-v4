import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, realpath, rm, symlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { PreviewManager } from './preview/manager.mjs';
import { parseBrowserCliAction, startBrowserCliBridge } from './preview/cli-bridge.mjs';
import { readPrivateJson, ensurePrivateDirectory } from './private-state.mjs';

// Native WebContents remains a platform-verification prerequisite. This fixture
// exercises the REAL PreviewManager state machine and REAL loopback HTTP/security,
// with a minimal Electron boundary whose loadURL actually reads a disposable page.
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'desktop-browser-cli-')));
  // The fixture just created this root. Elevated Windows tokens can own new
  // objects through the token's group, so only a freshly-created root may
  // legitimately transfer ownership to the current user.
  await ensurePrivateDirectory(root, { newlyCreated: true });
  const page = createServer((_request, response) => response.end('<title>Native preview fixture</title><p>actual page bytes</p>'));
  page.listen(0, '127.0.0.1'); await once(page, 'listening');
  const url = `http://127.0.0.1:${page.address().port}/page`;
  const sessions = new Map(), contents = new Map();
  const sessionFor = partition => {
    if (!sessions.has(partition)) sessions.set(partition, { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {}, webRequest: { onBeforeRequest() {} }, removeAllListeners() {}, on() {} });
    return sessions.get(partition);
  };
  const manager = new PreviewManager({
    electron: { ipcMain: new EventEmitter(), BrowserWindow: class {}, nativeTheme: {}, session: { fromPartition: sessionFor }, webContents: { fromId: id => contents.get(id) } },
    guestPreloadPath: join(root, 'picker.cjs'), pipPreloadPath: join(root, 'pip.cjs'), getWindow: () => null,
  });
  manager.setWorkspaceOrigin('http://127.0.0.1:3224');
  let nextId = 0;
  const file = join(root, 'browser-cli.json');
  const serviceUrl = 'http://127.0.0.1:3224/agent';
  const bridge = await startBrowserCliBridge({ descriptorFile: file, serviceUrl, async execute(command) {
    if (command.action === 'create') {
      const created = manager.createTab(command.tabId, { url: command.url });
      const wc = Object.assign(new EventEmitter(), {
        id: ++nextId, session: sessionFor(created.partition), ipc: new EventEmitter(), url: 'about:blank', title: '', bytes: '',
        isDestroyed: () => false, getURL() { return this.url; }, getTitle() { return this.title; }, isLoading: () => false,
        navigationHistory: { canGoBack: () => false, canGoForward: () => false }, setWindowOpenHandler() {},
        async loadURL(url) { this.url = url; this.bytes = await (await fetch(url)).text(); this.title = /<title>(.*?)<\/title>/u.exec(this.bytes)?.[1] ?? ''; this.emit('did-navigate', {}, url); this.emit('did-stop-loading'); },
      });
      contents.set(wc.id, wc); await manager.registerWebview(command.tabId, wc.id);
      return { state: manager.getState(command.tabId), attached: true };
    }
    if (command.action === 'navigate') return { state: await manager.navigate(command.tabId, command.url) };
    if (command.action === 'state') return { state: manager.getState(command.tabId) };
    if (command.action === 'close') { manager.closeTab(command.tabId); return { closed: true }; }
    throw new Error('Fixture does not pretend to support other native actions.');
  } });
  const descriptor = await readPrivateJson(file);
  const request = (action, fields = {}, headers = {}) => fetch(descriptor.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${descriptor.token}`, ...headers }, body: JSON.stringify({ instanceId: descriptor.instanceId, serviceUrl, action, ...fields }), redirect: 'error' });
  const wireRequest = headers => {
    // Fetch/Undici may normalize forbidden Host/Sec-* overrides. Use raw HTTP
    // for adversarial header cases so the exact requested headers reach the wire.
    const { promise, resolve, reject } = Promise.withResolvers();
    const outgoing = httpRequest(descriptor.endpoint, {
      method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${descriptor.token}`, ...headers },
    }, incoming => {
      incoming.once('error', reject);
      incoming.once('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers }));
      incoming.resume();
    });
    outgoing.once('error', reject);
    outgoing.end(JSON.stringify({ instanceId: descriptor.instanceId, serviceUrl, action: 'create', tabId: 'forbidden', url }));
    return promise;
  };
  t.after(async () => { await bridge.close(); manager.destroy(); const closed = once(page, 'close'); page.closeAllConnections(); page.close(); await closed; await rm(root, { recursive: true, force: true }); });
  return { root, file, manager, contents, url, bridge, descriptor, request, wireRequest };
}

test('Browser loopback capability drives real manager lifecycle and does not return its secret', async t => {
  const f = await fixture(t);
  if (process.platform !== 'win32') assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  const created = await f.request('create', { tabId: 'cli-tab', url: f.url });
  assert.equal(created.status, 200);
  const text = await created.text(); assert.ok(!text.includes(f.descriptor.token));
  const value = JSON.parse(text); assert.equal(value.attached, true); assert.equal(value.state.title, 'Native preview fixture');
  assert.match(f.contents.get(1).bytes, /actual page bytes/u);
  const next = await f.request('navigate', { tabId: 'cli-tab', url: `${f.url}?second` });
  assert.equal((await next.json()).state.url, `${f.url}?second`);
  assert.equal((await f.request('close', { tabId: 'cli-tab' })).status, 200);
  assert.equal(f.manager.getState('cli-tab'), null);
  await f.bridge.close(); assert.equal(await readPrivateJson(f.file), null);
  await assert.rejects(fetch(f.descriptor.endpoint, { method: 'POST' }));
});

test('Browser rejects web origins, cookies, foreign lifetimes and all generic proxy/JS/IPC fields before mutation', async t => {
  const f = await fixture(t);
  for (const headers of [{ Authorization: 'Bearer wrong' }, { Origin: 'http://127.0.0.1:3224' }, { Cookie: 'agent_v4_access=not-a-desktop-capability' }, { 'Sec-Fetch-Site': 'same-origin' }, { Host: 'evil.invalid' }]) {
    const response = await f.wireRequest(headers);
    assert.equal(response.status, 403, `reject actual wire header ${Object.keys(headers).join(',')}`);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  for (const fields of [{ instanceId: 'foreign-instance' }, { serviceUrl: 'http://127.0.0.1:4325' }, { channel: 'desktop:action' }, { javascript: 'process.exit()' }, { path: '/etc/passwd' }, { url: 'file:///etc/passwd' }, { url: 'https://user:secret@example.invalid' }]) {
    const response = await f.request('create', { tabId: 'forbidden', url: f.url, ...fields });
    assert.ok([400, 409].includes(response.status)); await response.body.cancel();
  }
  const unknown = await f.request('invoke', { channel: 'desktop:action' }); assert.equal(unknown.status, 400); await unknown.body.cancel();
  assert.equal(f.manager.tabs.size, 0);
});

test('Browser descriptor cannot traverse symlinks or bind a remote Agent', async t => {
  const f = await fixture(t);
  const alias = join(f.root, 'alias'); await symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(startBrowserCliBridge({ descriptorFile: join(alias, 'other.json'), serviceUrl: f.descriptor.serviceUrl, execute() { throw new Error('must not execute'); } }), /redirected/u);
  await assert.rejects(startBrowserCliBridge({ descriptorFile: join(f.root, 'other.json'), serviceUrl: 'https://remote.invalid/agent', execute() { throw new Error('must not execute'); } }), /local desktop/u);
  assert.throws(() => parseBrowserCliAction({ action: 'register-webview', webContentsId: 1 }, f.descriptor), /Invalid Browser command/u);
});
