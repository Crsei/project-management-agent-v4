import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { accessGuard } from '../access.ts';
import { taskWorkflowRoutes } from './index.ts';
import { workflowTemplates } from '../../../../../packages/contracts/src/task-workflow.ts';

test('HTTP denies cross-origin, forged config and missing PM authorization; startup unavailable is explicit', async () => {
  const original = globalThis.fetch, old = process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
  process.env.AGENT_WORKSPACE_ACCESS_TOKEN = '';
  let calls = 0; globalThis.fetch = async () => { calls++; return new Response('', { status: 401 }); };
  try {
    const app = new Hono().use('/api/*', accessGuard).route('/api', taskWorkflowRoutes), url = 'http://127.0.0.1:4325/api/task-workflows';
    const headers = { host: '127.0.0.1:4325', 'content-type': 'application/json' };
    const input = { id: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222', projectId: 'PRJ-001', taskId: 'TASK-001', expectedRevision: 0, graph: workflowTemplates[0]!.draft, publish: true };
    assert.equal((await app.request(`${url}/definitions`, { method: 'POST', headers: { ...headers, origin: 'https://evil.invalid' }, body: JSON.stringify(input) })).status, 403);
    assert.equal(calls, 0);
    assert.equal((await app.request(`${url}/definitions`, { method: 'POST', headers, body: JSON.stringify({ ...input, actorId: 'admin' }) })).status, 400);
    assert.equal(calls, 0);
    assert.equal((await app.request(`${url}/definitions`, { method: 'POST', headers, body: JSON.stringify(input) })).status, 401);
    assert.equal(calls, 1);
    assert.equal((await app.request(`${url}?workspaceId=${input.workspaceId}&projectId=PRJ-001&taskId=TASK-001`, { headers })).status, 401);
    assert.equal((await app.request(`${url}/runs`, { method: 'POST', headers, body: '{}' })).status, 503);
  } finally { globalThis.fetch = original; if (old === undefined) delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN; else process.env.AGENT_WORKSPACE_ACCESS_TOKEN = old; }
});
