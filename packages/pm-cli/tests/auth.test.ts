import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticate, CliAuthError, loginCli, logoutCli, serviceOrigin } from '../auth.ts';
import { createPrivateFile, privateDirectory, readPrivateFile, PrivateFileError } from '../private-files.ts';

const execute = promisify(execFile);
const entrypoint = fileURLToPath(new URL('../index.ts', import.meta.url));
const fixtureEmail = 'cli-fixture@example.invalid';
const fixturePassword = 'only-a-disposable-test-password';

async function fixture() {
  // A caller-controlled TMPDIR may have writable ancestors; never relax the
  // production private-path checks merely to accommodate a test location.
  const temporaryParent = await realpath(process.platform === 'win32' ? tmpdir() : '/tmp');
  const root = await mkdtemp(path.join(temporaryParent, 'pm-cli-auth-'));
  try { await privateDirectory(root, false); }
  catch {
    await rm(root, { recursive: true, force: true });
    throw new Error('CLI authentication tests require a trusted temporary root with safe ancestors and an owned 0700 fixture directory.');
  }
  const sessions = new Map<string, number>();
  let logoutStatus = 200;
  let loginRedirect: string | undefined;
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests++;
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/v1/auth/login') {
      if (loginRedirect) { response.writeHead(302, { Location: loginRedirect }); response.end(); return; }
      const parts: Buffer[] = [];
      for await (const chunk of request) parts.push(Buffer.from(chunk));
      const body: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
      if (!body || typeof body !== 'object' || !('email' in body) || body.email !== fixtureEmail || !('password' in body) || body.password !== fixturePassword) {
        response.writeHead(401); response.end(JSON.stringify({ error: { message: fixturePassword } })); return;
      }
      const token = randomBytes(32).toString('base64url');
      const expires = Date.now() + 60_000;
      sessions.set(token, expires);
      response.setHeader('Set-Cookie', `pm_v4_session=${token}; HttpOnly; Path=/; SameSite=Strict; Expires=${new Date(expires).toUTCString()}`);
      response.end(JSON.stringify({ actor: { id: 'actor-fixture', email: fixtureEmail, name: 'CLI Fixture' }, expiresAt: new Date(expires).toISOString() }));
      return;
    }
    const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    if ((sessions.get(token) ?? 0) <= Date.now()) { response.writeHead(401); response.end('{}'); return; }
    if (request.url === '/api/v1/auth/logout') {
      if (logoutStatus !== 200) { response.writeHead(logoutStatus); response.end('{}'); return; }
      sessions.delete(token);
      response.end(JSON.stringify({ loggedOut: true })); return;
    }
    if (request.url === '/api/v1/workspaces') { response.end(JSON.stringify({ items: [{ id: 'workspace-fixture', name: 'CLI Fixture' }] })); return; }
    if (request.url === '/api/v1/workspaces/workspace-fixture/core/protocol') { response.end(JSON.stringify({ fixture: 'authenticated-business-read' })); return; }
    response.writeHead(404); response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const sessionDirectory = path.join(root, 'sessions');
  const environment = { ...process.env, PM_API_URL: origin, PM_CLI_SESSION_DIR: sessionDirectory, PM_SESSION_TOKEN: '', PM_EMAIL: '', PM_PASSWORD: '', PM_WORKSPACE_ID: '' };
  const filename = path.join(sessionDirectory, `${createHash('sha256').update(origin).digest('hex')}.json`);
  return {
    root, origin, filename, sessionDirectory, environment, sessions,
    failLogout(status: number) { logoutStatus = status; },
    redirectLogin(target: string) { loginRedirect = target; },
    requestCount() { return requests; },
    async close() {
      const closed = once(server, 'close');
      server.closeAllConnections();
      server.close();
      await closed;
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('service origins require remote HTTPS and normalize only safe loopback URLs', () => {
  assert.equal(serviceOrigin('http://127.0.0.1:4194/api/'), 'http://127.0.0.1:4194');
  assert.equal(serviceOrigin('http://[::1]:4194'), 'http://[::1]:4194');
  assert.equal(serviceOrigin('https://EXAMPLE.invalid:443/'), 'https://example.invalid');
  for (const value of ['http://example.invalid', 'http://127.0.0.1.example.invalid', 'https://user:password@example.invalid', 'https://example.invalid/private', 'https://example.invalid/?secret=hidden', 'https://example.invalid/#secret']) {
    assert.throws(() => serviceOrigin(value), CliAuthError);
  }
});

test('login persists a finite private session for cross-process reads and logout revokes it', async () => {
  const f = await fixture();
  try {
    const login = await execute(process.execPath, [entrypoint, 'login'], { env: { ...f.environment, PM_EMAIL: fixtureEmail, PM_PASSWORD: fixturePassword } });
    assert.ok(!login.stdout.includes(fixturePassword) && !login.stderr.includes(fixturePassword));
    const raw = await readFile(f.filename, 'utf8');
    assert.ok(!raw.includes(fixturePassword) && !raw.includes(fixtureEmail));
    assert.equal((await stat(f.filename)).mode & 0o777, 0o600);
    assert.equal((await stat(f.sessionDirectory)).mode & 0o777, 0o700);
    const saved = await authenticate(f.origin, f.environment);
    assert.equal(saved.source, 'saved');
    assert.ok(Date.parse(saved.expiresAt!) > Date.now());
    assert.ok(!login.stdout.includes(saved.token) && !login.stderr.includes(saved.token));
    const read = await execute(process.execPath, [entrypoint, 'protocol'], { env: f.environment });
    assert.match(read.stdout, /authenticated-business-read/);
    await execute(process.execPath, [entrypoint, 'logout'], { env: f.environment });
    assert.equal(f.sessions.has(saved.token), false);
    await assert.rejects(readFile(f.filename), { code: 'ENOENT' });
    await assert.rejects(execute(process.execPath, [entrypoint, 'protocol'], { env: f.environment }), /CLI_AUTH_REQUIRED/);
  } finally { await f.close(); }
});

test('explicit token and complete password inputs outrank saved sessions; partial pairs do not mix sources', async () => {
  const f = await fixture();
  try {
    await loginCli(undefined, { ...f.environment, PM_EMAIL: fixtureEmail, PM_PASSWORD: fixturePassword });
    const saved = await authenticate(f.origin, f.environment);
    const token = randomBytes(32).toString('base64url');
    const explicit = await authenticate(f.origin, { ...f.environment, PM_SESSION_TOKEN: token, PM_EMAIL: fixtureEmail, PM_PASSWORD: fixturePassword });
    assert.equal(explicit.source, 'token');
    assert.equal(explicit.token === token, true);
    const password = await authenticate(f.origin, { ...f.environment, PM_EMAIL: fixtureEmail, PM_PASSWORD: fixturePassword });
    assert.equal(password.source, 'password');
    assert.notEqual(password.token === saved.token, true);
    assert.equal((await authenticate(f.origin, { ...f.environment, PM_EMAIL: fixtureEmail })).source, 'saved');
    assert.equal((await authenticate(f.origin, { ...f.environment, PM_PASSWORD: fixturePassword })).source, 'saved');
    await assert.rejects(authenticate('https://another-service.invalid', f.environment), { code: 'CLI_AUTH_REQUIRED' });
  } finally { await f.close(); }
});

test('logout failure retains this origin and success preserves another origin', async () => {
  const f = await fixture();
  const other = await fixture();
  try {
    const environment = { ...other.environment, PM_CLI_SESSION_DIR: f.sessionDirectory, PM_EMAIL: fixtureEmail, PM_PASSWORD: fixturePassword };
    await loginCli(undefined, { ...f.environment, PM_EMAIL: fixtureEmail, PM_PASSWORD: fixturePassword });
    await loginCli(undefined, environment);
    f.failLogout(503);
    await assert.rejects(logoutCli(f.environment), { code: 'CLI_LOGOUT_FAILED' });
    assert.ok(await readPrivateFile(f.filename));
    assert.equal((await authenticate(f.origin, f.environment)).source, 'saved');
    f.failLogout(200);
    await logoutCli(f.environment);
    assert.equal((await authenticate(other.origin, { ...environment, PM_EMAIL: '', PM_PASSWORD: '' })).source, 'saved');
    await assert.rejects(authenticate(f.origin, f.environment), { code: 'CLI_AUTH_REQUIRED' });
  } finally { await Promise.all([f.close(), other.close()]); }
});

test('expired saved sessions are rejected locally, while logout can remove an already invalid session', async () => {
  const f = await fixture();
  try {
    await loginCli(undefined, { ...f.environment, PM_EMAIL: fixtureEmail, PM_PASSWORD: fixturePassword });
    const saved = await authenticate(f.origin, f.environment);
    await writeFile(f.filename, JSON.stringify({ version: 1, origin: f.origin, token: saved.token, expiresAt: new Date(Date.now() - 1_000).toISOString() }));
    const before = f.requestCount();
    await assert.rejects(authenticate(f.origin, f.environment), { code: 'CLI_SESSION_EXPIRED' });
    assert.equal(f.requestCount(), before);
    f.sessions.delete(saved.token);
    await logoutCli(f.environment);
    await assert.rejects(readFile(f.filename), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('private storage refuses symlinks, hardlinks, unsafe file modes and unsafe directories', async () => {
  const f = await fixture();
  try {
    await loginCli(undefined, { ...f.environment, PM_EMAIL: fixtureEmail, PM_PASSWORD: fixturePassword });
    await chmod(f.filename, 0o644);
    await assert.rejects(authenticate(f.origin, f.environment), { code: 'CLI_SESSION_UNSAFE' });
    await chmod(f.filename, 0o600);
    await chmod(f.sessionDirectory, 0o755);
    await assert.rejects(authenticate(f.origin, f.environment), { code: 'CLI_SESSION_UNSAFE' });
    await chmod(f.sessionDirectory, 0o700);
    const target = path.join(f.root, 'credential-target');
    await writeFile(target, 'private-test-value', { mode: 0o600 });
    await rm(f.filename);
    await symlink(target, f.filename);
    await assert.rejects(authenticate(f.origin, f.environment), { code: 'CLI_SESSION_UNSAFE' });
    await assert.rejects(logoutCli(f.environment), { code: 'CLI_SESSION_UNSAFE' });
    assert.equal(await readFile(target, 'utf8'), 'private-test-value');
    await rm(f.filename);
    await link(target, f.filename);
    await assert.rejects(readPrivateFile(f.filename), PrivateFileError);
    const linkedDirectory = path.join(f.root, 'linked-directory');
    await symlink(f.sessionDirectory, linkedDirectory);
    await assert.rejects(readPrivateFile(path.join(linkedDirectory, 'anything')), PrivateFileError);
    await mkdir(path.join(f.root, 'unsafe-parent'), { mode: 0o777 });
    await chmod(path.join(f.root, 'unsafe-parent'), 0o777);
    await assert.rejects(createPrivateFile(path.join(f.root, 'unsafe-parent', 'nested', 'token'), 'never-written'), PrivateFileError);
  } finally { await f.close(); }
});

test('login rejects redirects without forwarding credentials and does not echo server errors', async () => {
  const f = await fixture();
  const target = await fixture();
  try {
    const environment = { ...f.environment, PM_EMAIL: fixtureEmail, PM_PASSWORD: fixturePassword };
    const before = target.requestCount();
    f.redirectLogin(`${target.origin}/api/v1/auth/login`);
    await assert.rejects(loginCli(undefined, environment), { code: 'CLI_CONNECTION_FAILED' });
    assert.equal(target.requestCount(), before);
    await assert.rejects(readFile(f.filename), { code: 'ENOENT' });
    const result = await execute(process.execPath, [entrypoint, 'login'], { env: { ...target.environment, PM_EMAIL: fixtureEmail, PM_PASSWORD: 'wrong-test-password' } }).catch(error => error as { stdout: string; stderr: string });
    assert.ok(!result.stdout.includes(fixturePassword) && !result.stderr.includes(fixturePassword));
    assert.match(result.stderr, /CLI_AUTH_FAILED/);
  } finally { await Promise.all([f.close(), target.close()]); }
});
