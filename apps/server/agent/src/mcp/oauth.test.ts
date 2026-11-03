import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { closeStore, listRecords, readRecord, writeRecord } from '../durable/store.ts';
import { mcpIntrospectionRoutes, mcpOAuthRoutes } from './routes.ts';
import { authenticateMcpRequest, mcpIdentityHeaders, mcpIdentityFromHeaders } from './identity.ts';
import { currentGrant, grantIdentity, MCP_GRANTS, type Grant } from './grants.ts';
import { redirectMatches } from './oauth.ts';
import type { Authorization } from './oauth.ts';
import { mcpServiceHeaders, verifyMcpServiceBearer } from '../../../../../packages/infrastructure/src/mcp-service-auth.ts';

const origin = 'https://pm.example', workspaceId = '11111111-1111-4111-8111-111111111111', actorId = '22222222-2222-4222-8222-222222222222';
const verifier = 'a'.repeat(43), challenge = createHash('sha256').update(verifier).digest('base64url');
const scope = { workspaceId, projectId: 'PRJ-001' };
const savedEnv = { directory: process.env.AGENT_WORKSPACE_DATA_DIR, origin: process.env.MCP_PUBLIC_ORIGIN, secret: process.env.PM_AUTOMATION_SERVICE_SECRET, pmApi: process.env.PM_API_URL };
let directory: string;
const app = new Hono().route('/', mcpOAuthRoutes).route('/', mcpIntrospectionRoutes);
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mcp-oauth-test-'));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory; process.env.MCP_PUBLIC_ORIGIN = origin; process.env.PM_AUTOMATION_SERVICE_SECRET = 'test-only-mcp-domain-secret-'.repeat(3);
  process.env.PM_API_URL = 'http://127.0.0.1:4194';
  mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    const headers = new Headers(init?.headers);
    if (path === '/api/v1/auth/me') return headers.get('cookie') === 'pm_v4_session=valid-test-session' ? Response.json({ actor: { id: actorId } }) : Response.json({}, { status: 401 });
    if (path === '/api/v1/agent-contexts') return Response.json({ workspaces: [{ id: workspaceId, name: 'Workspace', workspaceAllowed: true, projects: [{ id: 'PRJ-001', name: 'One' }, { id: 'PRJ-002', name: 'Two' }] }] });
    throw new Error(`Unexpected PM request: ${path}`);
  });
  for (const [id, projectId] of [['thread-one', 'PRJ-001'], ['thread-two', 'PRJ-002']]) writeRecord('chat:threads', id!, { remoteId: id, scope: { workspaceId, projectId }, title: id, status: 'regular', updatedAt: '2026-01-01T00:00:00Z' });
  writeRecord('chat:threads', 'legacy', { remoteId: 'legacy', title: 'Legacy', status: 'regular', updatedAt: '2026-01-01T00:00:00Z' });
});
afterEach(async () => {
  mock.restoreAll(); closeStore(); await rm(directory, { recursive: true, force: true });
  for (const [key, value] of Object.entries({ AGENT_WORKSPACE_DATA_DIR: savedEnv.directory, MCP_PUBLIC_ORIGIN: savedEnv.origin, PM_AUTOMATION_SERVICE_SECRET: savedEnv.secret, PM_API_URL: savedEnv.pmApi })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
const post = (path: string, body: unknown, cookie = 'pm_v4_session=valid-test-session', requestOrigin = origin) => app.request(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: requestOrigin, cookie }, body: JSON.stringify(body) });
async function authorize() {
  const registered = await post('/oauth/mcp/register', { client_name: 'Test client', redirect_uris: ['http://localhost:1234/callback'] });
  assert.equal(registered.status, 201);
  const client = await registered.json() as { client_id: string };
  const authorization = { client_id: client.client_id, redirect_uri: 'http://localhost:4567/callback', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'test-state', resource: `${origin}/mcp` };
  const response = await post('/oauth/mcp/approval', authorization); assert.equal(response.status, 200);
  const details = await response.json() as { csrfToken: string; threads: { id: string }[] };
  return { authorization, details };
}
async function approve() {
  const { authorization, details } = await authorize();
  const response = await post('/oauth/mcp/decision', { authorization, decision: { _tag: 'approve', csrfToken: details.csrfToken, scope, threadIds: ['thread-one'] } });
  assert.equal(response.status, 200);
  const redirect = new URL((await response.json() as { redirectTo: string }).redirectTo);
  assert.equal(redirect.searchParams.get('state'), authorization.state); assert.equal(redirect.searchParams.get('iss'), origin);
  return { authorization, code: redirect.searchParams.get('code')! };
}
const token = (authorization: Pick<Authorization, 'client_id' | 'redirect_uri'>, code: string, extra: Record<string, string> = {}) => app.request(`${origin}/oauth/mcp/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: authorization.client_id, redirect_uri: authorization.redirect_uri, code, code_verifier: verifier, resource: `${origin}/mcp`, ...extra }) });

test('native redirect constraints reject fragments, credentials, insecure remote and path changes', () => {
  assert.equal(redirectMatches('http://localhost:1/cb', 'http://localhost:2/cb'), true);
  for (const uri of ['http://evil.example/cb', 'http://localhost:2/other', 'http://localhost:2/cb#', 'http://user@localhost:2/cb', 'https://localhost/cb']) assert.equal(redirectMatches('http://localhost:1/cb', uri), false);
});
test('fixed issuer ignores hostile Host and supports no refresh grant', async () => {
  const response = await app.request('https://attacker.example/.well-known/oauth-authorization-server', { headers: { host: 'attacker.example', 'x-forwarded-host': 'attacker.example' } });
  const metadata = await response.json() as { issuer: string; grant_types_supported: string[] };
  assert.equal(metadata.issuer, origin); assert.deepEqual(metadata.grant_types_supported, ['authorization_code']);
  const { authorization, code } = await approve(); assert.equal((await token(authorization, code, { grant_type: 'refresh_token' })).status, 400);
});
test('shared Agent cookie, foreign Origin, forged client and missing state cannot approve', async () => {
  const { authorization } = await authorize();
  assert.equal((await post('/oauth/mcp/approval', authorization, 'agent_access=shared')).status, 401);
  assert.equal((await post('/oauth/mcp/approval', authorization, undefined, 'https://attacker.example')).status, 403);
  assert.equal((await post('/oauth/mcp/approval', { ...authorization, client_id: authorization.client_id + 'x' })).status, 400);
  assert.equal((await post('/oauth/mcp/approval', { ...authorization, state: '' })).status, 400);
});
test('CSRF is authorization/session-bound and only explicit same-scope threads may be granted', async () => {
  const { authorization, details } = await authorize();
  assert.equal(details.threads.some(item => item.id === 'legacy'), false);
  const decision = { _tag: 'approve', csrfToken: details.csrfToken, scope, threadIds: ['thread-one'], access: 'read-only' };
  assert.equal((await post('/oauth/mcp/decision', { authorization: { ...authorization, state: 'changed' }, decision })).status, 403);
  assert.equal((await post('/oauth/mcp/decision', { authorization, decision: { ...decision, csrfToken: 'forged' } })).status, 403);
  for (const id of ['thread-two', 'legacy']) assert.equal((await post('/oauth/mcp/decision', { authorization, decision: { ...decision, threadIds: [id] } })).status, 403);
  assert.equal((await post('/oauth/mcp/decision', { authorization, decision })).status, 200);
  assert.equal((await post('/oauth/mcp/decision', { authorization, decision })).status, 403);
});
test('S256 failure and resource mismatch consume authorization codes; successful codes cannot replay', async () => {
  const failures: Record<string, string>[] = [{ code_verifier: 'b'.repeat(43) }, { resource: 'https://other.example/mcp' }];
  for (const extra of failures) {
    const { authorization, code } = await approve(); assert.equal((await token(authorization, code, extra)).status, 400); assert.equal((await token(authorization, code)).status, 400);
  }
  const { authorization, code } = await approve(); const response = await token(authorization, code); assert.equal(response.status, 200);
  const result = await response.json() as { access_token: string; scope: string };
  assert.equal(result.scope, 'orchestration:read'); assert.equal((await token(authorization, code)).status, 400);
  const identity = await authenticateMcpRequest(new Request(`${origin}/mcp`, { headers: { authorization: `Bearer ${result.access_token}` } }));
  assert.deepEqual(identity.threadIds, ['thread-one']); assert.equal(identity.access, 'read-only');
  await assert.rejects(authenticateMcpRequest(new Request(`${origin}/api/threads`, { headers: { authorization: `Bearer ${result.access_token}` } })));
  const internal = await mcpIdentityHeaders(identity);
  await assert.rejects(authenticateMcpRequest(new Request(`${origin}/mcp`, { headers: internal })));
  const grant = readRecord<Grant>(MCP_GRANTS, identity.grantId)!;
  writeRecord(MCP_GRANTS, grant.grantId, { ...grant, revokedAt: new Date().toISOString(), version: grant.version + 1 });
  await assert.rejects(authenticateMcpRequest(new Request(`${origin}/mcp`, { headers: { authorization: `Bearer ${result.access_token}` } })));
  assert.throws(() => mcpIdentityFromHeaders(internal));
});
test('authenticated introspection is storage-only and rejects expired grants and unsigned requests', async () => {
  await approve(); const grant = listRecords<Grant>(MCP_GRANTS)[0]!;
  const headers = await mcpIdentityHeaders(grantIdentity(grant)), signed = verifyMcpServiceBearer(headers.get('authorization')!.slice(7))!;
  mock.restoreAll(); mock.method(globalThis, 'fetch', async () => { throw new Error('Introspection must never call PM'); });
  const body = JSON.stringify(signed), path = '/internal/mcp/introspect';
  assert.equal((await app.request(origin + path, { method: 'POST', body, headers: mcpServiceHeaders('POST', path, body) })).status, 200);
  assert.equal((await app.request(origin + path, { method: 'POST', body })).status, 401);
  for (const changed of [
    { actorId: '33333333-3333-4333-8333-333333333333' },
    { scope: { ...signed.scope, projectId: 'PRJ-002' } },
    { access: 'full' },
    { version: signed.version + 1 },
    { threadIds: ['thread-two'] },
    { expiresAt: Date.now() - 1 },
  ]) {
    const altered = JSON.stringify({ ...signed, ...changed });
    assert.equal((await app.request(origin + path, { method: 'POST', body: altered, headers: mcpServiceHeaders('POST', path, altered) })).status, 401);
  }
  writeRecord(MCP_GRANTS, grant.grantId, { ...grant, expiresAt: new Date(0).toISOString() });
  assert.throws(() => currentGrant(grant));
  assert.equal((await app.request(origin + path, { method: 'POST', body, headers: mcpServiceHeaders('POST', path, body) })).status, 401);
  writeRecord(MCP_GRANTS, grant.grantId, { ...grant, revokedAt: new Date().toISOString(), version: grant.version + 1 });
  assert.equal((await app.request(origin + path, { method: 'POST', body, headers: mcpServiceHeaders('POST', path, body) })).status, 401);
});
test('management requires PM identity and CSRF and revokes only the current actor grant', async () => {
  await approve(); const grant = listRecords<Grant>(MCP_GRANTS)[0]!;
  assert.equal((await app.request(origin + '/api/mcp/clients', { headers: { cookie: 'agent_access=shared' } })).status, 401);
  const response = await app.request(origin + '/api/mcp/clients', { headers: { cookie: 'pm_v4_session=valid-test-session' } });
  const management = await response.json() as { csrfToken: string; items: { id: string }[] };
  assert.equal(management.items[0]!.id, grant.grantId);
  assert.equal((await post(`/api/mcp/clients/${grant.grantId}/revoke`, { csrfToken: 'forged' })).status, 403);
  assert.equal((await post(`/api/mcp/clients/${grant.grantId}/revoke`, { csrfToken: management.csrfToken })).status, 200);
  assert.throws(() => currentGrant(grant));
});
test('authorization errors only redirect to verified clients; bounded requests reject oversized bodies', async () => {
  const { authorization } = await authorize();
  const badPkce = await app.request(origin + '/oauth/mcp/authorize?' + new URLSearchParams({ ...authorization, code_challenge_method: 'plain' }));
  assert.equal(badPkce.status, 302);
  assert.equal(new URL(badPkce.headers.get('location')!).searchParams.get('error'), 'invalid_request');
  const badRedirect = await app.request(origin + '/oauth/mcp/authorize?' + new URLSearchParams({ ...authorization, redirect_uri: 'https://attacker.example/cb' }));
  assert.equal(badRedirect.status, 400); assert.equal(badRedirect.headers.get('location'), null);
  assert.equal((await post('/oauth/mcp/register', { redirect_uris: ['https://client.example/cb'], extra: 'x'.repeat(70_000) })).status, 413);
});
test('read-only OAuth scope advertises no full choice and cannot be escalated at decision', async () => {
  const { authorization } = await authorize();
  const readonly = { ...authorization, scope: 'orchestration:read' };
  const response = await post('/oauth/mcp/approval', readonly);
  const details = await response.json() as { allowedAccess: string[]; csrfToken: string };
  assert.deepEqual(details.allowedAccess, ['read-only']);
  assert.equal((await post('/oauth/mcp/decision', { authorization: readonly, decision: { _tag: 'approve', csrfToken: details.csrfToken, scope, threadIds: ['thread-one'], access: 'full' } })).status, 400);
});
test('public rate saturation cannot prevent authenticated client revocation', async () => {
  const now = Date.now() + 60_001;
  mock.method(Date, 'now', () => now);
  const { authorization, code } = await approve();
  const issued = await token(authorization, code);
  const access = (await issued.json() as { access_token: string }).access_token;
  const request = () => new Request(`${origin}/mcp`, { headers: { authorization: `Bearer ${access}` } });
  const identity = await authenticateMcpRequest(request());
  let saturated: Response | undefined;
  for (let index = 0; index <= 600; index++) saturated = await app.request(origin + '/.well-known/oauth-authorization-server');
  assert.equal(saturated!.status, 429);
  const delegation = verifyMcpServiceBearer((await mcpIdentityHeaders(identity)).get('authorization')!.slice(7))!;
  const path = '/internal/mcp/introspect', body = JSON.stringify(delegation);
  assert.equal((await app.request(origin + path, { method: 'POST', body, headers: mcpServiceHeaders('POST', path, body) })).status, 200);
  await authenticateMcpRequest(request());
  // Anonymous management attempts neither allocate an actor budget nor spend reserved capacity.
  for (let index = 0; index < 65; index++) assert.equal((await app.request(origin + '/api/mcp/clients')).status, 401);
  const response = await app.request(origin + '/api/mcp/clients', { headers: { cookie: 'pm_v4_session=valid-test-session' } });
  assert.equal(response.status, 200);
  const management = await response.json() as { csrfToken: string };
  assert.equal((await post(`/api/mcp/clients/${identity.grantId}/revoke`, { csrfToken: management.csrfToken })).status, 200);
  await assert.rejects(authenticateMcpRequest(request()));
});

test('public concurrency saturation leaves authenticated management capacity reserved', { timeout: 10_000 }, async () => {
  const now = Date.now() + 120_002;
  mock.method(Date, 'now', () => now);
  const { authorization } = await approve();
  const grant = listRecords<Grant>(MCP_GRANTS)[0]!;
  const listing = await app.request(origin + '/api/mcp/clients', { headers: { cookie: 'pm_v4_session=valid-test-session' } });
  const management = await listing.json() as { csrfToken: string };
  const pmFetch = globalThis.fetch;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let waiting = 0;
  mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(input instanceof Request ? input.url : String(input)).pathname === '/api/v1/agent-contexts') {
      if (++waiting === 32) entered.resolve();
      await release.promise;
    }
    return pmFetch(input, init);
  });
  const pending = Array.from({ length: 32 }, () => post('/oauth/mcp/approval', authorization));
  try {
    await entered.promise;
    assert.equal((await app.request(origin + '/.well-known/oauth-authorization-server')).status, 429);
    assert.equal((await post(`/api/mcp/clients/${grant.grantId}/revoke`, { csrfToken: management.csrfToken })).status, 200);
    assert.throws(() => currentGrant(grant));
  } finally {
    release.resolve();
    await Promise.all(pending);
  }
});
