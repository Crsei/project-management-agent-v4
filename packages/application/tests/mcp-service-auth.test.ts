import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { assertMcpEndpoint, authorizeMcpService } from '../src/mcp-service-auth.ts';
import { createMcpServiceBearer, mcpMac, mcpServiceHeaders, verifyMcpServiceBearer, verifyMcpServiceRequest, type McpInvocationIdentity } from '../../infrastructure/src/mcp-service-auth.ts';
import type { SqlExecutor } from '../src/ports.ts';

const identity: McpInvocationIdentity = { grantId: '11111111-1111-4111-8111-111111111111', actorId: '22222222-2222-4222-8222-222222222222', scope: { workspaceId: '33333333-3333-4333-8333-333333333333', projectId: 'PRJ-001' }, threadIds: ['granted-thread'], access: 'read-only', version: 1 };
const base = `/api/v1/workspaces/${identity.scope.workspaceId}/agent-tools`;
const body = { name: 'pm_read', arguments: { id: 'TASK-001' }, target: { ...identity.scope }, threadId: 'granted-thread', messageId: 'message', generationId: 'generation', operationId: 'operation' };
const oldSecret = process.env.PM_AUTOMATION_SERVICE_SECRET, oldUrl = process.env.PM_MCP_AGENT_URL;
afterEach(() => { mock.restoreAll(); if (oldSecret === undefined) delete process.env.PM_AUTOMATION_SERVICE_SECRET; else process.env.PM_AUTOMATION_SERVICE_SECRET = oldSecret; if (oldUrl === undefined) delete process.env.PM_MCP_AGENT_URL; else process.env.PM_MCP_AGENT_URL = oldUrl; });

test('delegation rejects generic APIs, readonly execution, cross-project and ungranted thread/action', () => {
  assert.doesNotThrow(() => assertMcpEndpoint(identity, { method: 'POST', url: base + '/call', body }));
  for (const request of [
    { method: 'GET', url: '/api/v1/auth/me', body: null },
    { method: 'GET', url: '/api/v1/workspaces', body: null },
    { method: 'POST', url: '/api/v1/agent-contexts/resolve', body: identity.scope },
    { method: 'POST', url: base + '/call', body: { ...body, threadId: 'other-thread' } },
    { method: 'POST', url: base + '/call', body: { ...body, name: 'pm_create_task' } },
    { method: 'POST', url: base + '/call', body: { ...body, target: { workspaceId: identity.scope.workspaceId, projectId: null } } },
    { method: 'POST', url: base + '/call', body: { ...body, target: { workspaceId: identity.scope.workspaceId, projectId: 'PRJ-002' } } },
    { method: 'POST', url: base + '/call', body: { ...body, target: { workspaceId: '44444444-4444-4444-8444-444444444444', projectId: 'PRJ-001' } } },
    { method: 'POST', url: base + '/call', body: { ...body, target: undefined, scope: { kind: 'projects', projectIds: ['PRJ-001'] } } },
    { method: 'POST', url: base + '/result', body: { ...body, target: { workspaceId: identity.scope.workspaceId, projectId: 'PRJ-002' } } },
    { method: 'GET', url: base + '/core-files?projectId=PRJ-002', body: null },
    { method: 'GET', url: base + '?broaden=true', body: null },
  ]) assert.throws(() => assertMcpEndpoint(identity, request));
  assert.doesNotThrow(() => assertMcpEndpoint({ ...identity, access: 'full' }, { method: 'POST', url: '/api/v1/agent-contexts/resolve', body: identity.scope }));
});
test('workspace grants accept explicit targets without acquiring any directory endpoint', () => {
  const workspaceGrant = { ...identity, scope: { ...identity.scope, projectId: null } };
  for (const projectId of [null, 'PRJ-001', 'PRJ-002']) {
    assert.doesNotThrow(() => assertMcpEndpoint(workspaceGrant, { method: 'POST', url: base + '/call', body: { ...body, target: { ...identity.scope, projectId } } }));
  }
  assert.doesNotThrow(() => assertMcpEndpoint(identity, { method: 'GET', url: '/api/v1/agent-tools', body: null }));
  for (const url of ['/api/v1/agent-tools?workspaceId=forged', '/api/agent-workspaces', '/api/agent-workspaces/directories', '/api/v1/agent-tools/core-files']) {
    assert.throws(() => assertMcpEndpoint(workspaceGrant, { method: 'GET', url, body: null }));
  }
});
test('reference delegation requires explicit workspace and rejects forged project ceilings', () => {
  const url = `/api/v1/workspaces/${identity.scope.workspaceId}/agent-references/resolve`;
  const reference = { kind: 'issue', id: 'TASK-001', workspaceId: identity.scope.workspaceId, projectId: 'PRJ-001', revision: null };
  assert.doesNotThrow(() => assertMcpEndpoint(identity, { method: 'POST', url, body: { references: [reference] } }));
  for (const changed of [
    { ...reference, workspaceId: '44444444-4444-4444-8444-444444444444' },
    { ...reference, projectId: 'PRJ-002' },
    { ...reference, workspaceId: undefined },
  ]) assert.throws(() => assertMcpEndpoint(identity, { method: 'POST', url, body: { references: [changed] } }));
});
test('signed service identity is audience/domain/expiry bound and signed requests bind method path body', () => {
  process.env.PM_AUTOMATION_SERVICE_SECRET = 'test-only-mcp-secret'.repeat(4);
  const bearer = createMcpServiceBearer(identity); assert.ok(verifyMcpServiceBearer(bearer));
  assert.equal(verifyMcpServiceBearer(bearer.replace('pm-mcp-service-v1.', 'pm-automation-v1.')), null);
  const signed = verifyMcpServiceBearer(bearer)!;
  for (const changed of [{ ...signed, audience: 'native-pm' }, { ...signed, issuedAt: Date.now() - 120000, expiresAt: Date.now() - 60000 }]) {
    const payload = Buffer.from(JSON.stringify(changed)).toString('base64url');
    assert.equal(verifyMcpServiceBearer(`pm-mcp-service-v1.${payload}.${mcpMac('delegate', payload)}`), null);
  }
  const headers = mcpServiceHeaders('POST', '/internal/mcp/introspect', '{}');
  assert.equal(verifyMcpServiceRequest('POST', '/internal/mcp/introspect', '{}', headers), true);
  for (const [method, path, payload] of [['GET', '/internal/mcp/introspect', '{}'], ['POST', '/internal/automation-executions/dispatch', '{}'], ['POST', '/internal/mcp/introspect', '{"grant":"changed"}']]) assert.equal(verifyMcpServiceRequest(method!, path!, payload!, headers), false);
});
test('final authorization uses supplied executor without nested transaction and fails closed on live revoke', async () => {
  process.env.PM_AUTOMATION_SERVICE_SECRET = 'test-only-mcp-secret'.repeat(4); process.env.PM_MCP_AGENT_URL = 'http://127.0.0.1:4123';
  let revoked = false, current = identity;
  mock.method(globalThis, 'fetch', async () => revoked ? Response.json({ error: 'revoked' }, { status: 401 }) : Response.json(current));
  const queries: string[] = [];
  const sql = { query: async (query: string) => {
    queries.push(query);
    if (query.includes('FROM users')) return { rows: [{ id: identity.actorId, email: 'test@example.invalid', name: 'Test' }] };
    if (query.includes('FROM memberships')) return { rows: [{ user_id: identity.actorId, workspace_id: identity.scope.workspaceId, capabilities: ['domain.read'], project_ids: ['PRJ-001'], version: 1, revoked_at: null }] };
    throw new Error('Unexpected SQL; authorization must not open a nested transaction');
  } } as unknown as SqlExecutor;
  const signed = verifyMcpServiceBearer(createMcpServiceBearer(identity))!;
  await authorizeMcpService(sql, signed, { method: 'POST', url: base + '/call', body });
  assert.equal(queries.length, 2);
  revoked = true;
  await assert.rejects(authorizeMcpService(sql, signed, { method: 'POST', url: base + '/call', body }));
  assert.equal(queries.length, 2);
  revoked = false;
  current = { ...identity, threadIds: ['different-thread'] };
  await assert.rejects(authorizeMcpService(sql, signed, { method: 'POST', url: base + '/result', body }));
  current = { ...identity, scope: { ...identity.scope, projectId: 'PRJ-002' } };
  await assert.rejects(authorizeMcpService(sql, signed, { method: 'POST', url: base + '/call', body }));
  assert.equal(queries.length, 2);
});
