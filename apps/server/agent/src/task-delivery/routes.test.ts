import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { accessGuard } from '../access.ts';
import { taskDeliveryRoutes } from './index.ts';

test('HTTP rejects cross-origin, extra cwd/actor fields and missing PM authentication without external effects', async () => {
  const originalFetch = globalThis.fetch, token = process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
  process.env.AGENT_WORKSPACE_ACCESS_TOKEN = '';
  let pmCalls = 0;
  globalThis.fetch = async () => { pmCalls++; return new Response('', { status: 401 }); };
  try {
    const app = new Hono().use('/api/*', accessGuard).route('/api', taskDeliveryRoutes);
    const headers = { host: '127.0.0.1:4325', 'content-type': 'application/json' };
    const input = { id: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222', projectId: 'PRJ-001', taskId: 'TASK-001', taskRevision: 'rev', baseBranch: 'main' };
    const cross = await app.request('http://127.0.0.1:4325/api/task-deliveries', { method: 'POST', headers: { ...headers, origin: 'https://other.example' }, body: JSON.stringify(input) });
    assert.equal(cross.status, 403); assert.equal(pmCalls, 0);
    const extra = await app.request('http://127.0.0.1:4325/api/task-deliveries', { method: 'POST', headers, body: JSON.stringify({ ...input, cwd: '/etc', actorId: 'admin' }) });
    assert.equal(extra.status, 400); assert.equal(pmCalls, 0);
    const unauthenticated = await app.request('http://127.0.0.1:4325/api/task-deliveries', { method: 'POST', headers, body: JSON.stringify(input) });
    assert.equal(unauthenticated.status, 401); assert.equal(pmCalls, 1);
    const previewExtra = await app.request(`http://127.0.0.1:4325/api/task-deliveries/${input.id}/preview`, { method: 'POST', headers, body: JSON.stringify({ action: 'start', head: 'a'.repeat(40), confirm: true, cwd: '/root' }) });
    assert.equal(previewExtra.status, 400); assert.equal(pmCalls, 1);
    const previewCross = await app.request(`http://127.0.0.1:4325/api/task-deliveries/${input.id}/preview`, { method: 'POST', headers: { ...headers, origin: 'http://other.preview.localhost:4330' }, body: JSON.stringify({ action: 'stop', confirm: true }) });
    assert.equal(previewCross.status, 403); assert.equal(pmCalls, 1);
    const missingConfirm = await app.request(`http://127.0.0.1:4325/api/task-deliveries/${input.id}/actions`, { method: 'POST', headers, body: JSON.stringify({ action: 'push', head: 'a'.repeat(40) }) });
    assert.equal(missingConfirm.status, 400); assert.equal(pmCalls, 1);
    const projectQuery = new URLSearchParams({ workspaceId: input.workspaceId, projectId: input.projectId, releaseId: input.id }).toString();
    const projectRead = await app.request(`http://127.0.0.1:4325/api/project-roadmap-deliveries?${projectQuery}`, { headers });
    assert.equal(projectRead.status, 401); assert.equal(pmCalls, 2);
    const projectCross = await app.request(`http://127.0.0.1:4325/api/project-app-previews/${input.id}?${projectQuery}`, { method: 'POST', headers: { ...headers, origin: 'https://other.example' }, body: JSON.stringify({ action: 'start', head: 'a'.repeat(40), confirm: true }) });
    assert.equal(projectCross.status, 403); assert.equal(pmCalls, 2);
    const projectExtra = await app.request(`http://127.0.0.1:4325/api/project-roadmap-deliveries?${projectQuery}&cwd=/root`, { headers });
    assert.equal(projectExtra.status, 400); assert.equal(pmCalls, 2);
  } finally { globalThis.fetch = originalFetch; if (token === undefined) delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN; else process.env.AGENT_WORKSPACE_ACCESS_TOKEN = token; }
});
