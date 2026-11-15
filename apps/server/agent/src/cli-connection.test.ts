import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { Hono } from 'hono';
import { accessGuard, accessRoutes, authorizeHeaders } from './access.ts';
import { agentLogin, agentLogout, agentServiceOrigin, agentServiceUrl, agentStatus, connectAgent, AgentConnectionError } from '../../../../packages/pm-cli/agent-connection.ts';

const originalToken = process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
const originalApproval = process.env.AGENT_APPROVAL_MODE;
after(() => {
  if (originalToken === undefined) delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN; else process.env.AGENT_WORKSPACE_ACCESS_TOKEN = originalToken;
  if (originalApproval === undefined) delete process.env.AGENT_APPROVAL_MODE; else process.env.AGENT_APPROVAL_MODE = originalApproval;
});

/** Real accessRoutes/accessGuard over HTTP, with disposable operator configuration only. */
async function fixture() {
  const temporaryParent = await realpath(process.platform === 'win32' ? tmpdir() : '/tmp');
  const root = await mkdtemp(path.join(temporaryParent, 'pm-agent-cli-'));
  const token = 'disposable-agent-operator-' + 'a'.repeat(40);
  process.env.AGENT_WORKSPACE_ACCESS_TOKEN = token;
  process.env.AGENT_APPROVAL_MODE = 'ask';
  let requests = 0, redirect: string | undefined, failLogout = false;
  const protectedHeaders: Headers[] = [];
  const app = new Hono().route('/api', accessRoutes).use('/api/*', accessGuard)
    .get('/api/private', c => { protectedHeaders.push(new Headers(c.req.raw.headers)); return c.json({ identity: 'agent_operator', value: 7 }); })
    .get('/api/chat/threads', c => { protectedHeaders.push(new Headers(c.req.raw.headers)); return c.json({ threads: [] }); })
    .get('/api/name/:id', c => c.json({ name: c.req.param('id') }))
    .get('/api/events', () => new Response('data: {"seq":1}\n\n', { headers: { 'content-type': 'text/event-stream' } }))
    .get('/api/ndjson', () => new Response('{"seq":1}\n', { headers: { 'content-type': 'application/x-ndjson' } }))
    .get('/api/stream', () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"seq":1}\n\n')); },
    }), { headers: { 'content-type': 'text/event-stream' } }))
    .get('/api/error', c => c.json({ error: token }, 500));
  const server = createServer(async (incoming, outgoing) => {
    requests++;
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    const gateway = incoming.url?.startsWith('/agent/');
    const route = gateway ? incoming.url!.slice('/agent'.length) : incoming.url!;
    if (redirect && (route === '/api/access' || route === '/api/private')) { outgoing.writeHead(307, { location: redirect }); outgoing.end(); return; }
    if (failLogout && route === '/api/access' && incoming.method === 'DELETE') { outgoing.writeHead(503); outgoing.end('{}'); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const controller = new AbortController();
    outgoing.once('close', () => controller.abort());
    const request = new Request(`http://${incoming.headers.host}${route}`, { method: incoming.method ?? 'GET', headers, signal: controller.signal, ...(body ? { body } : {}) });
    const response = await app.fetch(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    const reader = response.body?.getReader();
    const cancel = (): void => { void reader?.cancel().catch(() => undefined); };
    outgoing.once('close', cancel);
    try {
      if (reader) for (;;) {
        const { done, value } = await reader.read();
        if (done || outgoing.destroyed) break;
        if (!outgoing.write(value)) await once(outgoing, 'drain', { signal: controller.signal });
      }
      if (!outgoing.destroyed) outgoing.end();
    } catch { outgoing.destroy(); }
    finally { outgoing.removeListener('close', cancel); reader?.releaseLock(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const directory = path.join(root, 'credentials');
  const environment = { PM_AGENT_URL: origin, PM_AGENT_SESSION_DIR: directory };
  const filename = (serviceUrl = origin): string => path.join(directory, `${createHash('sha256').update(serviceUrl).digest('hex')}.json`);
  return {
    root, token, origin, directory, environment, filename, protectedHeaders,
    requestCount() { return requests; },
    redirectTo(value: string | undefined) { redirect = value; },
    failLogout() { failLogout = true; },
    async close() {
      await agentLogout({ environment }).catch(() => undefined);
      await agentLogout({ environment, origin: `${origin}/agent` }).catch(() => undefined);
      const closed = once(server, 'close'); server.closeAllConnections(); server.close(); await closed;
      await rm(root, { recursive: true, force: true });
    },
  };
}

// No server is started merely by importing this test or the Agent auth module.
test('Agent target requires explicit safe origin and preserves gateway service base', () => {
  assert.equal(agentServiceOrigin('http://127.0.0.1:3224/agent/api/'), 'http://127.0.0.1:3224');
  assert.equal(agentServiceUrl('http://127.0.0.1:3224/agent/api/'), 'http://127.0.0.1:3224/agent');
  assert.equal(agentServiceUrl('https://EXAMPLE.invalid:443/api'), 'https://example.invalid');
  assert.equal(agentServiceUrl('http://[::1]:4325'), 'http://[::1]:4325');
  for (const value of ['', 'http://remote.invalid', 'http://127.0.0.1.evil.invalid', 'https://user:secret@example.invalid', 'https://example.invalid/private', 'https://example.invalid/?token=hidden', 'https://example.invalid/#hidden']) {
    assert.throws(() => agentServiceOrigin(value), AgentConnectionError);
  }
});

test('real operator login stores only issued private cookie and sends no PM identity', async () => {
  const f = await fixture();
  try {
    const tokenFile = path.join(f.root, 'explicit-token'); await writeFile(tokenFile, `${f.token}\n`, { mode: 0o600 });
    const environment = { ...f.environment, PM_SESSION_TOKEN: 'p'.repeat(43), PM_EMAIL: 'not-an-agent@example.invalid', PM_PASSWORD: 'not-an-agent-password', AGENT_WORKSPACE_ACCESS_TOKEN: 'not-imported' };
    const result = await agentLogin({ environment, tokenFile });
    assert.equal(result.identity, 'agent_operator'); assert.equal(result.serverExpiresAt, null); assert.equal(result.serverRevocation, 'deployment_token_rotation');
    assert.ok(typeof result.localExpiresAt === 'string');
    assert.ok(Date.parse(result.localExpiresAt) > Date.now());
    const raw = await readFile(f.filename(), 'utf8');
    const stored = JSON.parse(raw) as { cookie: string };
    assert.equal(raw.includes(f.token), false); assert.equal(raw.includes(environment.PM_SESSION_TOKEN), false);
    assert.equal((await stat(f.filename())).mode & 0o777, 0o600); assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
    const connection = await connectAgent({ environment });
    try {
      assert.deepEqual(await connection.json('/api/private'), { identity: 'agent_operator', value: 7 });
      const headers = f.protectedHeaders.at(-1)!;
      assert.equal(headers.get('authorization'), null); assert.equal(headers.get('cookie') === stored.cookie, true); assert.equal(headers.get('origin'), f.origin);
      assert.equal(JSON.stringify({ result, connection }).includes(stored.cookie), false); assert.equal(inspect(connection).includes(stored.cookie), false);
      await assert.rejects(connection.json('/api/error'), (error: unknown) => error instanceof AgentConnectionError && error.code === 'AGENT_REQUEST_FAILED' && !error.message.includes(f.token));
      assert.equal((await agentStatus({ environment })).approvalMode, 'ask');
    } finally { connection.close(); }
  } finally { await f.close(); }
});

test('PM credentials, delegated tokens, missing and invalid Agent identity never grant CLI access', async () => {
  const f = await fixture();
  try {
    const environment = { ...f.environment, PM_SESSION_TOKEN: 'p'.repeat(43), PM_EMAIL: 'pm@example.invalid', PM_PASSWORD: f.token, AGENT_WORKSPACE_ACCESS_TOKEN: f.token };
    await assert.rejects(connectAgent({ environment }), { code: 'AGENT_IDENTITY_REQUIRED' });
    assert.deepEqual(f.protectedHeaders, []);
    for (const token of ['wrong-disposable-' + 'x'.repeat(40), 'p'.repeat(43), 'pm-mcp-access-v1.' + 'x'.repeat(43), 'pm-mcp-service-v1.' + 'x'.repeat(43)]) {
      await assert.rejects(agentLogin({ environment, token }), (error: unknown) => error instanceof AgentConnectionError && ['AGENT_LOGIN_DENIED', 'AGENT_TOKEN_INVALID'].includes(error.code) && !error.message.includes(token));
    }
    assert.deepEqual(await readdir(f.directory), []);
    delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
    assert.equal((await fetch(`${f.origin}/api/access`)).status, 200);
    await assert.rejects(agentLogin({ environment, token: f.token }), { code: 'AGENT_LOGIN_DENIED' });
  } finally { await f.close(); }
});

test('service origin and /agent base are independently bound and cannot import a saved identity', async () => {
  const f = await fixture();
  try {
    await agentLogin({ environment: f.environment, token: f.token });
    await assert.rejects(connectAgent({ environment: f.environment, origin: 'https://other.example.invalid' }), { code: 'AGENT_IDENTITY_REQUIRED' });
    await assert.rejects(connectAgent({ environment: f.environment, origin: `${f.origin}/agent` }), { code: 'AGENT_IDENTITY_REQUIRED' });
    assert.deepEqual(f.protectedHeaders, []);
    await agentLogin({ environment: f.environment, origin: `${f.origin}/agent`, token: f.token });
    const connection = await connectAgent({ environment: f.environment, origin: `${f.origin}/agent/api/` });
    try { assert.deepEqual(await connection.json('/api/private'), { identity: 'agent_operator', value: 7 }); assert.equal(connection.serviceUrl, `${f.origin}/agent`); }
    finally { connection.close(); }
    await agentLogout({ environment: f.environment, origin: `${f.origin}/agent` });
    assert.equal((await agentStatus({ environment: f.environment })).serviceUrl, f.origin);
    const content = await readFile(f.filename(), 'utf8');
    await writeFile(f.filename(), content.replace(f.origin, 'https://wrong.example.invalid'));
    await assert.rejects(connectAgent({ environment: f.environment }), { code: 'AGENT_CREDENTIAL_INVALID' });
  } finally { await f.close(); }
});

test('local expiry and logout are not fabricated server revocation; rotation actually rejects old cookie', async () => {
  const f = await fixture();
  try {
    await agentLogin({ environment: f.environment, token: f.token });
    const saved = JSON.parse(await readFile(f.filename(), 'utf8')) as { cookie: string; createdAt: string; localExpiresAt: string };
    saved.createdAt = new Date(Date.now() - 60_000).toISOString(); saved.localExpiresAt = new Date(Date.now() - 1_000).toISOString();
    await writeFile(f.filename(), JSON.stringify(saved));
    await assert.rejects(connectAgent({ environment: f.environment }), { code: 'AGENT_CREDENTIAL_EXPIRED' });
    assert.equal(authorizeHeaders(new Headers({ host: '127.0.0.1', cookie: saved.cookie })), true);
    assert.equal((await agentLogout({ environment: f.environment })).serverRevoked, false);
    await assert.rejects(connectAgent({ environment: f.environment }), { code: 'AGENT_IDENTITY_REQUIRED' });
    assert.equal(authorizeHeaders(new Headers({ host: '127.0.0.1', cookie: saved.cookie })), true);
    await agentLogin({ environment: f.environment, token: f.token });
    process.env.AGENT_WORKSPACE_ACCESS_TOKEN = 'rotated-disposable-operator-' + 'b'.repeat(40);
    assert.equal(authorizeHeaders(new Headers({ host: '127.0.0.1', cookie: saved.cookie })), false);
    await assert.rejects(connectAgent({ environment: f.environment }), { code: 'AGENT_ACCESS_DENIED' });
    assert.equal((await agentLogout({ environment: f.environment })).status, 'logged_out');
  } finally { await f.close(); }
});

test('unconfigured loopback and gateway connect without login, credentials or PM authority', async () => {
  const f = await fixture();
  try {
    delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
    const environment = { ...f.environment, PM_SESSION_TOKEN: 'p'.repeat(43), PM_PASSWORD: 'not-an-agent-credential' };
    for (const origin of [f.origin, `${f.origin}/agent`]) {
      const connection = await connectAgent({ environment, origin });
      try {
        assert.equal(connection.info.identity, 'local_unprotected');
        assert.equal(connection.info.credentialSource, 'none');
        assert.equal(connection.info.localExpiresAt, null);
        assert.equal(connection.info.serverRevocation, null);
        assert.equal(connection.serviceUrl, origin);
        assert.equal((await connection.json<{ value: number }>('/api/private')).value, 7);
        const headers = f.protectedHeaders.at(-1)!;
        assert.equal(headers.get('cookie'), null);
        assert.equal(headers.get('authorization'), null);
        assert.equal(headers.get('origin'), f.origin);
        await assert.rejects(readFile(f.filename(origin)), { code: 'ENOENT' });
        const response = await connection.request('/api/events');
        assert.equal(await response.text(), 'data: {"seq":1}\n\n');
        assert.equal((await agentLogout({ environment, origin })).status, 'no_session');
        await assert.rejects(connection.request('/api/private'), { code: 'AGENT_CONNECTION_CLOSED' });
      } finally { connection.close(); }
      assert.equal((await agentStatus({ environment, origin })).identity, 'local_unprotected');
    }
    await assert.rejects(stat(f.directory), { code: 'ENOENT' });
    await assert.rejects(connectAgent({ environment, origin: 'https://remote.example.invalid' }), { code: 'AGENT_IDENTITY_REQUIRED' });
  } finally { await f.close(); }
});

test('local mode ignores old credentials but never bypasses newly configured or invalid access', async () => {
  const f = await fixture();
  try {
    await agentLogin({ environment: f.environment, token: f.token });
    const saved = await readFile(f.filename(), 'utf8');
    delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
    // Local mode neither reads an obsolete identity nor replaces/removes it.
    await chmod(f.filename(), 0o644);
    const connection = await connectAgent({ environment: f.environment });
    try {
      assert.equal(connection.info.identity, 'local_unprotected');
      await connection.json('/api/private');
      assert.equal(f.protectedHeaders.at(-1)!.get('cookie'), null);
      assert.equal(await readFile(f.filename(), 'utf8'), saved);
      process.env.AGENT_WORKSPACE_ACCESS_TOKEN = f.token;
      const denial = await connection.request('/api/private');
      assert.equal(denial.status, 401);
      assert.equal((await denial.json() as { code: string }).code, 'access_required');
      await assert.rejects(connection.request('/api/private'), { code: 'AGENT_CONNECTION_CLOSED' });
      await assert.rejects(connectAgent({ environment: f.environment }), { code: 'AGENT_STORAGE_UNSAFE' });
      await chmod(f.filename(), 0o600);
      assert.equal((await agentStatus({ environment: f.environment })).identity, 'agent_operator');
      process.env.AGENT_WORKSPACE_ACCESS_TOKEN = 'too-short';
      await assert.rejects(connectAgent({ environment: f.environment }), { code: 'AGENT_ACCESS_DENIED' });
    } finally { connection.close(); }
  } finally { await f.close(); }
});

test('local Agent access forwards PM identity only for explicitly authorized PM-context routes', async () => {
  const f = await fixture();
  try {
    delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
    const connection = await connectAgent({ environment: f.environment });
    const pmToken = 'p'.repeat(43);
    try {
      await connection.json('/api/chat/threads', {}, { origin: f.origin, headers: { Authorization: `Bearer ${pmToken}` } });
      const headers = f.protectedHeaders.at(-1)!;
      assert.equal(headers.get('cookie'), `pm_v4_session=${pmToken}`);
      assert.equal(headers.get('authorization'), `Bearer ${pmToken}`);
      await connection.json('/api/private');
      assert.equal(f.protectedHeaders.at(-1)!.get('cookie'), null);
      assert.equal(f.protectedHeaders.at(-1)!.get('authorization'), null);
      await assert.rejects(connection.json('/api/private', {}, { origin: f.origin, headers: { Authorization: `Bearer ${pmToken}` } }), { code: 'AGENT_PM_CONTEXT_ROUTE_DENIED' });
      await assert.rejects(connection.json('/api/chat/threads', {}, { origin: f.origin, headers: { Authorization: `Bearer pm-mcp-access-v1.${pmToken}` } }), { code: 'AGENT_PM_IDENTITY_REQUIRED' });
      await assert.rejects(stat(f.directory), { code: 'ENOENT' });
    } finally { connection.close(); }
  } finally { await f.close(); }
});

test('cross-origin, credential overrides, namespace escapes, and secret query values are refused', async () => {
  const f = await fixture();
  try {
    await agentLogin({ environment: f.environment, token: f.token });
    const connection = await connectAgent({ environment: f.environment });
    try {
      const before = f.requestCount();
      for (const route of ['https://evil.invalid/api/private', '//evil.invalid/api/private', '/api/../api/v1/auth/me', '/api/%76%31/auth/me', '/api/access', '/api/mcp/clients', '/api/internal/secret', '/api/%2e%2e/private', '/api/name/a%2fb', '/api/private#fragment']) await assert.rejects(connection.request(route), { code: 'AGENT_INVALID_ROUTE' });
      for (const key of ['token', 'access_token', 'password', 'authorization', 'cookie']) await assert.rejects(connection.request(`/api/private?${key}=never-send`), { code: 'AGENT_SECRET_IN_URL' });
      for (const name of ['Authorization', 'Cookie', 'Host', 'Origin', 'X-Pm-Automation-Signature', 'X-Forwarded-Host']) await assert.rejects(connection.request('/api/private', { headers: { [name]: 'never-send' } }), { code: 'AGENT_IDENTITY_OVERRIDE' });
      await assert.rejects(connection.request('/api/private', { redirect: 'follow' }), { code: 'AGENT_IDENTITY_OVERRIDE' });
      assert.equal(f.requestCount(), before);
      assert.deepEqual(await connection.json('/api/name/a%20b'), { name: 'a b' });
      const crossSite = await fetch(`${f.origin}/api/access`, { method: 'POST', headers: { Origin: 'https://evil.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: f.token }) });
      assert.equal(crossSite.status, 403);
    } finally { connection.close(); }
  } finally { await f.close(); }
});

test('login and resource redirects do not forward credentials or retry', async () => {
  const f = await fixture();
  let leakedRequests = 0;
  const destination = createServer((_request, response) => { leakedRequests++; response.end('{}'); });
  destination.listen(0, '127.0.0.1'); await once(destination, 'listening');
  const address = destination.address(); assert.ok(address && typeof address === 'object');
  try {
    f.redirectTo(`http://127.0.0.1:${address.port}/api/access`);
    await assert.rejects(agentLogin({ environment: f.environment, token: f.token }), { code: 'AGENT_REDIRECT_REJECTED' });
    assert.equal(leakedRequests, 0);
    f.redirectTo(undefined); await agentLogin({ environment: f.environment, token: f.token });
    const connection = await connectAgent({ environment: f.environment });
    f.redirectTo(`http://127.0.0.1:${address.port}/api/private`);
    try { await assert.rejects(connection.json('/api/private'), { code: 'AGENT_REDIRECT_REJECTED' }); assert.equal(leakedRequests, 0); }
    finally { connection.close(); }
  } finally {
    const closed = once(destination, 'close'); destination.closeAllConnections(); destination.close(); await closed;
    await f.close();
  }
});

test('raw stream protocols and header-only WS attachments close on local logout', async () => {
  const f = await fixture();
  try {
    await agentLogin({ environment: f.environment, token: f.token });
    const connection = await connectAgent({ environment: f.environment });
    const sse = await connection.request('/api/events'); assert.match(sse.headers.get('content-type')!, /text\/event-stream/); assert.equal(await sse.text(), 'data: {"seq":1}\n\n');
    const ndjson = await connection.request('/api/ndjson'); assert.equal(await ndjson.text(), '{"seq":1}\n');
    let closed = false;
    const socket = connection.webSocket('/api/inspector/terminal?terminalId=fixture&clientId=fixture&afterSeq=3', (url, options) => {
      assert.equal(new URL(url).protocol, 'ws:'); assert.equal(new URL(url).pathname, '/api/inspector/terminal');
      assert.equal(url.includes(f.token), false); assert.equal(url.includes('agent_v4_access'), false); assert.equal(options.followRedirects, false);
      assert.match(options.headers.Cookie!, /^agent_v4_access=[a-f0-9]{64}$/); assert.equal(options.headers.Origin, f.origin);
      return { close() { closed = true; } };
    });
    assert.ok(socket);
    assert.throws(() => connection.webSocket('/api/elsewhere', () => socket), { code: 'AGENT_INVALID_ROUTE' });
    const streaming = await connection.request('/api/stream');
    const reader = streaming.body!.getReader(); assert.equal((await reader.read()).done, false);
    const pending = reader.read();
    const cancelled = assert.rejects(pending);
    assert.equal((await agentLogout({ environment: f.environment })).serverRevoked, false); assert.equal(closed, true);
    await cancelled; reader.releaseLock();
    await assert.rejects(connection.request('/api/private'), { code: 'AGENT_CONNECTION_CLOSED' });
  } finally { await f.close(); }
});

test('unsafe storage/input are denied before authentication and failed logout still erases local identity', async () => {
  const f = await fixture();
  try {
    const input = path.join(f.root, 'token-input'); await writeFile(input, f.token, { mode: 0o644 });
    const before = f.requestCount();
    await assert.rejects(agentLogin({ environment: f.environment, tokenFile: input }), { code: 'AGENT_TOKEN_FILE_UNSAFE' });
    await assert.rejects(agentLogin({ environment: f.environment, token: f.token, tokenFile: input }), { code: 'AGENT_TOKEN_AMBIGUOUS' });
    await assert.rejects(agentLogin({ environment: { ...f.environment, PM_AGENT_SESSION_DIR: 'relative' }, token: f.token }), { code: 'AGENT_STORAGE_UNSAFE' });
    assert.equal(f.requestCount(), before);
    await chmod(input, 0o600); await agentLogin({ environment: f.environment, tokenFile: input });
    await chmod(f.filename(), 0o644); await assert.rejects(connectAgent({ environment: f.environment }), { code: 'AGENT_STORAGE_UNSAFE' });
    await chmod(f.filename(), 0o600); await rm(f.filename()); await symlink(input, f.filename());
    await assert.rejects(connectAgent({ environment: f.environment }), { code: 'AGENT_STORAGE_UNSAFE' });
    await rm(f.filename()); await agentLogin({ environment: f.environment, tokenFile: input });
    f.failLogout(); await assert.rejects(agentLogout({ environment: f.environment }), { code: 'AGENT_LOGOUT_UNCONFIRMED' });
    await assert.rejects(readFile(f.filename()), { code: 'ENOENT' });
    await assert.rejects(connectAgent({ environment: f.environment }), { code: 'AGENT_IDENTITY_REQUIRED' });
  } finally { await f.close(); }
});

test('explicit PM context remains request-local, route-bounded and independent from Agent identity', async () => {
  const f = await fixture();
  try {
    await agentLogin({ environment: f.environment, token: f.token });
    const connection = await connectAgent({ environment: f.environment });
    const pmToken = 'p'.repeat(43), pmContext = { origin: 'http://127.0.0.1:4194', headers: { Authorization: `Bearer ${pmToken}` } };
    try {
      await connection.json('/api/chat/threads', {}, pmContext);
      const headers = f.protectedHeaders.at(-1)!;
      assert.equal(headers.get('authorization') === `Bearer ${pmToken}`, true);
      assert.equal(headers.get('cookie')?.includes(`; pm_v4_session=${pmToken}`), true);
      assert.equal(authorizeHeaders(headers), true);
      headers.delete('cookie'); assert.equal(authorizeHeaders(headers), false);
      const stored = await readFile(f.filename(), 'utf8');
      assert.equal(stored.includes(pmToken), false); assert.equal(JSON.stringify(connection).includes(pmToken), false);
      const before = f.requestCount();
      await assert.rejects(connection.request('/api/private', {}, pmContext), { code: 'AGENT_PM_CONTEXT_ROUTE_DENIED' });
      await assert.rejects(connection.request('/api/chat/threads', {}, { ...pmContext, origin: 'https://unrelated.example.invalid' }), { code: 'AGENT_PM_ORIGIN_MISMATCH' });
      await assert.rejects(connection.request('/api/chat/threads', {}, { ...pmContext, headers: { Authorization: `Bearer pm-mcp-access-v1.${'x'.repeat(43)}` } }), { code: 'AGENT_PM_IDENTITY_REQUIRED' });
      await assert.rejects(connection.request('/api/chat/threads', {}, { ...pmContext, headers: { Cookie: `pm_v4_session=${pmToken}` } }), { code: 'AGENT_PM_IDENTITY_REQUIRED' });
      await assert.rejects(connection.request('/api/extensions/future-operation', { method: 'POST' }, pmContext), { code: 'AGENT_PM_CONTEXT_ROUTE_DENIED' });
      assert.equal(f.requestCount(), before);
    } finally { connection.close(); }
  } finally { await f.close(); }
});

test('raw authorization denial retains the real response body while closing stale access', async () => {
  const f = await fixture();
  try {
    await agentLogin({ environment: f.environment, token: f.token });
    const connection = await connectAgent({ environment: f.environment });
    try {
      process.env.AGENT_WORKSPACE_ACCESS_TOKEN = 'rotated-disposable-operator-' + 'b'.repeat(40);
      const response = await connection.request('/api/private');
      assert.equal(response.status, 401);
      const denial = await response.json() as { code: string };
      assert.equal(denial.code, 'access_required');
      await assert.rejects(connection.request('/api/private'), { code: 'AGENT_CONNECTION_CLOSED' });
    } finally { connection.close(); }
  } finally { await f.close(); }
});
