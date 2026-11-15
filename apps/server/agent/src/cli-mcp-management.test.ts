import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { mcpOAuthRoutes } from './mcp/routes.ts';
import { currentGrant, MCP_GRANTS, putGrant, type Grant } from './mcp/grants.ts';
import { closeStore, readRecord } from './durable/store.ts';
import { agentMcpClients, type AgentPmContext } from '../../../../packages/pm-cli/agent-connection.ts';

const actorId = '22222222-2222-4222-8222-222222222222';
const workspaceId = '11111111-1111-4111-8111-111111111111';

test('standalone CLI MCP management uses real PM browser authority, CSRF and durable revocation, not Agent identity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-cli-mcp-'));
  const saved = { AGENT_WORKSPACE_DATA_DIR: process.env.AGENT_WORKSPACE_DATA_DIR, MCP_PUBLIC_ORIGIN: process.env.MCP_PUBLIC_ORIGIN, PM_AUTOMATION_SERVICE_SECRET: process.env.PM_AUTOMATION_SERVICE_SECRET, PM_API_URL: process.env.PM_API_URL };
  const pmToken = 'p'.repeat(43);
  let validPmIdentity = true, pmRequests = 0;
  const pm = createServer((request, response) => {
    // This fixture models only the PM identity authority; grant reads/revocation below
    // execute the real MCP routes, pmBrowser, CSRF MAC and SQLite store over HTTP.
    pmRequests++;
    if (request.url !== '/api/v1/auth/me' || !validPmIdentity || request.headers.cookie !== `pm_v4_session=${pmToken}`) { response.writeHead(401).end('{}'); return; }
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ actor: { id: actorId } }));
  });
  const managementHeaders: Headers[] = [];
  let redirect: string | undefined;
  const app = new Hono().route('/', mcpOAuthRoutes);
  const agent = createServer(async (incoming, outgoing) => {
    if (redirect) { outgoing.writeHead(307, { location: redirect }).end(); return; }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    managementHeaders.push(headers);
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const route = incoming.url?.startsWith('/agent/') ? incoming.url.slice('/agent'.length) : incoming.url!;
    const response = await app.fetch(new Request(`http://${incoming.headers.host}${route}`, { method: incoming.method ?? 'GET', headers, ...(body ? { body } : {}) }));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries())); outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  pm.listen(0, '127.0.0.1'); agent.listen(0, '127.0.0.1');
  await Promise.all([once(pm, 'listening'), once(agent, 'listening')]);
  const pmAddress = pm.address(), agentAddress = agent.address(); assert.ok(pmAddress && typeof pmAddress === 'object'); assert.ok(agentAddress && typeof agentAddress === 'object');
  const pmOrigin = `http://127.0.0.1:${pmAddress.port}`, origin = `http://127.0.0.1:${agentAddress.port}`;
  process.env.AGENT_WORKSPACE_DATA_DIR = root; process.env.MCP_PUBLIC_ORIGIN = origin; process.env.PM_API_URL = pmOrigin; process.env.PM_AUTOMATION_SERVICE_SECRET = 'disposable-mcp-management-only-'.repeat(3);
  const pmContext: AgentPmContext = { origin: pmOrigin, headers: { Authorization: `Bearer ${pmToken}` } };
  const options = { origin: `${origin}/agent`, environment: { PM_AGENT_SESSION_DIR: path.join(root, 'never-created-agent-identity') }, pmContext };
  const grant: Grant = { grantId: '33333333-3333-4333-8333-333333333333', actorId, clientHash: 'disposable-client-hash', clientName: 'Disposable CLI grant', audience: `${origin}/mcp`, scope: { workspaceId, projectId: 'PRJ-001' }, access: 'read-only', threadIds: [], version: 1, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null };
  try {
    putGrant(grant);
    const list = await agentMcpClients<{ csrfToken: string; items: { id: string }[] }>({ ...options, action: 'list' });
    assert.equal(list.items[0]!.id, grant.grantId); assert.equal(JSON.stringify(list).includes(pmToken), false);
    assert.ok(pmRequests > 0); assert.equal(managementHeaders[0]!.get('authorization'), null);
    assert.equal(managementHeaders[0]!.get('cookie') === `pm_v4_session=${pmToken}`, true); assert.equal(managementHeaders[0]!.get('origin'), origin);
    await assert.rejects(agentMcpClients({ ...options, action: 'revoke', id: grant.grantId, csrfToken: 'forged' }), { code: 'AGENT_MCP_MANAGEMENT_DENIED', status: 403 });
    assert.equal(readRecord<Grant>(MCP_GRANTS, grant.grantId)!.revokedAt, null);
    assert.deepEqual(await agentMcpClients({ ...options, action: 'revoke', id: grant.grantId, csrfToken: list.csrfToken }), { revoked: true });
    assert.ok(readRecord<Grant>(MCP_GRANTS, grant.grantId)!.revokedAt); assert.throws(() => currentGrant(grant));
    validPmIdentity = false;
    await assert.rejects(agentMcpClients({ ...options, action: 'list' }), { code: 'AGENT_MCP_MANAGEMENT_DENIED', status: 401 });
    validPmIdentity = true;
    const before = managementHeaders.length;
    await assert.rejects(agentMcpClients({ ...options, action: 'list', pmContext: { ...pmContext, origin: 'https://unrelated.example.invalid' } }), { code: 'AGENT_PM_ORIGIN_MISMATCH' });
    await assert.rejects(agentMcpClients({ ...options, action: 'list', pmContext: { ...pmContext, headers: { Authorization: `Bearer pm-mcp-access-v1.${'x'.repeat(43)}` } } }), { code: 'AGENT_PM_IDENTITY_REQUIRED' });
    await assert.rejects(agentMcpClients({ ...options, action: 'revoke', id: '../escape', csrfToken: list.csrfToken }), { code: 'AGENT_MCP_MANAGEMENT_INVALID' });
    assert.equal(managementHeaders.length, before);
    redirect = `${pmOrigin}/api/v1/auth/me`;
    const pmBefore = pmRequests;
    await assert.rejects(agentMcpClients({ ...options, action: 'list' }), { code: 'AGENT_REDIRECT_REJECTED' });
    assert.equal(pmRequests, pmBefore);
  } finally {
    closeStore();
    await Promise.all([pm, agent].map(async server => { const closed = once(server, 'close'); server.closeAllConnections(); server.close(); await closed; }));
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
});
