import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createMcpServiceBearer, introspectMcpGrant, trustedMcpOrigin, trustedMcpServiceOrigin, verifyMcpServiceBearer, verifyMcpServiceRequest, type McpInvocationIdentity } from '../src/mcp-service-auth.ts';

const keys = ['MCP_INTERNAL_HTTP_ORIGINS', 'PM_MCP_AGENT_URL', 'PM_AUTOMATION_AGENT_URL', 'PM_AUTOMATION_SERVICE_SECRET'] as const;
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const identity: McpInvocationIdentity = { grantId: '11111111-1111-4111-8111-111111111111', actorId: '22222222-2222-4222-8222-222222222222', scope: { workspaceId: '33333333-3333-4333-8333-333333333333', projectId: 'PRJ-001' }, access: 'read-only', threadIds: [], version: 1 };
beforeEach(() => {
  for (const key of keys) delete process.env[key];
  process.env.PM_AUTOMATION_SERVICE_SECRET = 'disposable-mcp-private-transport-secret'.repeat(2);
});
afterEach(() => {
  mock.restoreAll();
  for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
});
const signedIdentity = () => verifyMcpServiceBearer(createMcpServiceBearer(identity))!;

// These transport fixtures use disposable service authority, never deployment credentials.
test('internal HTTP opt-in never relaxes the public issuer policy', () => {
  process.env.MCP_INTERNAL_HTTP_ORIGINS = JSON.stringify(['http://api:4194', 'http://custom-pm.internal:7411']);
  for (const value of ['http://api:4194', 'http://custom-pm.internal:7411']) {
    assert.equal(trustedMcpServiceOrigin(value).origin, value);
    assert.throws(() => trustedMcpOrigin(value));
  }
  for (const value of ['https://pm.example', 'http://localhost:4194', 'http://127.0.0.1:4325', 'http://[::1]:4325']) {
    assert.equal(trustedMcpServiceOrigin(value).origin, value);
    assert.equal(trustedMcpOrigin(value).origin, value);
  }
});

test('internal HTTP defaults closed and matches only exact configured origins', () => {
  assert.throws(() => trustedMcpServiceOrigin('http://api:4194'));
  process.env.MCP_INTERNAL_HTTP_ORIGINS = '[]';
  assert.throws(() => trustedMcpServiceOrigin('http://api:4194'));
  process.env.MCP_INTERNAL_HTTP_ORIGINS = JSON.stringify(['http://api:4194']);
  for (const value of ['http://api:4195', 'http://api.evil.invalid:4194', 'http://other:4194', 'http://169.254.169.254', 'http://10.0.0.1', 'http://api:4194/path', 'http://user:secret@api:4194', 'http://api:4194/?secret=value', 'http://api:4194/#fragment', 'file:///tmp/config']) {
    assert.throws(() => trustedMcpServiceOrigin(value));
  }
});

test('malformed allowlists fail closed instead of ignoring unsafe entries', () => {
  for (const value of ['', 'null', '{}', 'true', '[1]', '["http://api:4194",null]', '["http://api:4194/path"]', '["http://user:secret@api:4194"]', '["http://api:4194?query=value"]', '["http://api:4194#fragment"]', '["https://api:4194"]']) {
    process.env.MCP_INTERNAL_HTTP_ORIGINS = value;
    assert.throws(() => trustedMcpServiceOrigin('http://api:4194'), /MCP_INTERNAL_HTTP_ORIGINS/);
  }
});

test('configured private introspection signs only the fixed request and preserves the original identity', async () => {
  process.env.PM_MCP_AGENT_URL = 'http://custom-agent.internal:7432';
  process.env.MCP_INTERNAL_HTTP_ORIGINS = '["http://custom-agent.internal:7432"]';
  let calls = 0;
  mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    calls++;
    const endpoint = new URL(String(input)), headers = new Headers(init?.headers), body = String(init?.body);
    assert.equal(endpoint.href, 'http://custom-agent.internal:7432/internal/mcp/introspect');
    assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
    assert.equal(verifyMcpServiceRequest('POST', endpoint.pathname, body, headers), true);
    assert.equal(verifyMcpServiceRequest('POST', '/internal/other', body, headers), false);
    assert.equal(JSON.parse(body).grantId, identity.grantId);
    for (const name of ['cookie', 'authorization', 'origin', 'host', 'forwarded', 'x-forwarded-host']) assert.equal(headers.has(name), false);
    return Response.json(identity);
  });
  assert.deepEqual(await introspectMcpGrant(signedIdentity()), identity);
  assert.equal(calls, 1);
  process.env.PM_MCP_AGENT_URL = 'http://other-agent.internal:7432';
  await assert.rejects(introspectMcpGrant(signedIdentity()));
  assert.equal(calls, 1);
});

test('introspection keeps the existing explicit fallback but never guesses an absent or invalid destination', async () => {
  let calls = 0;
  mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    calls++; assert.equal(String(input), 'http://127.0.0.1:4325/internal/mcp/introspect');
    return Response.json(identity);
  });
  await assert.rejects(introspectMcpGrant(signedIdentity()));
  assert.equal(calls, 0);
  process.env.PM_AUTOMATION_AGENT_URL = 'http://127.0.0.1:4325';
  assert.deepEqual(await introspectMcpGrant(signedIdentity()), identity);
  process.env.PM_MCP_AGENT_URL = '';
  await assert.rejects(introspectMcpGrant(signedIdentity()));
  assert.equal(calls, 1);
});

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  const closed = once(server, 'close'); server.closeAllConnections(); server.close(); await closed;
}

test('real HTTP introspection refuses redirects without forwarding its service signature', async () => {
  let sourceCalls = 0, redirectedCalls = 0;
  const destination = createServer((_request, response) => { redirectedCalls++; response.end('{}'); });
  const target = await listen(destination);
  const source = createServer((_request, response) => { sourceCalls++; response.writeHead(307, { location: `${target}/internal/mcp/introspect` }).end(); });
  try {
    process.env.PM_MCP_AGENT_URL = await listen(source);
    await assert.rejects(introspectMcpGrant(signedIdentity()));
    assert.equal(sourceCalls, 1); assert.equal(redirectedCalls, 0);
  } finally { await Promise.all([close(source), close(destination)]); }
});
