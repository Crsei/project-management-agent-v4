import test from 'node:test';
import assert from 'node:assert/strict';
import type { FixtureHandle, PrepareAdapterInput } from '../schemas/types.ts';
import { AgentChatAdapter } from './agent-chat.ts';

function input(): PrepareAdapterInput {
  const isolationPolicy = { networkMode: 'none', readOnlyRoot: true, user: '1000:1000', capDrop: ['ALL'], securityOpt: ['no-new-privileges:true', 'seccomp=unconfined', 'apparmor=unconfined'], pidMode: '', privileged: false, maskedPaths: [], readOnlyPaths: [], appArmorProfile: 'unconfined', nativeBoundary: 'test-only private namespace evidence' };
  const fixture: FixtureHandle = {
    fixtureId: 'f', fixtureVersion: '0.1', root: '/private', publicRoot: '/private/public', authorityRoot: '/private/authority', agentDataRoot: '/private/agent', workspaceId: 'workspace', actorId: 'actor', targets: {}, pm: { baseUrl: 'http://127.0.0.1:3902', token: 'private-pm-token' },
    isolation: { backend: 'docker', verified: true, containerId: 'container', networkId: 'none', checks: [], proofDigest: 'proof' },
    runtime: { environmentHash: 'test-environment', environmentEvidence: { sourceHash: 'test-source', sourceFileCount: 1, lockfileHash: 'test-lock', imageIds: {}, nodeVersion: '24.21.0', isolationPolicy }, agentBaseUrl: 'http://127.0.0.1:3903', agentAccessToken: 'private-agent-token', pmCookie: 'pm_session=private-cookie', workingDirectory: '/workspace', environment: {}, containerId: 'container', isolationVerified: true, auditEvents: [], providerConfig: { instanceId: 'codex', driver: 'codex', config: { setupMode: 'existing' }, environment: [] } },
  };
  return { runId: 'r', fixtureId: 'f', arm: 'raw', fixture, model: 'fixed-model', provider: 'codex', allowedTools: ['read', 'pm_read', 'pm_update', 'pm_receipt'], allowedTargets: [], budget: { maxDurationMinutes: 1, maxModelCalls: 5, maxToolCalls: 10, maxCostUsd: 1 } };
}

function mockTransport(options: { loseSubmit?: boolean } = {}) {
  const requests: { path: string; method: string; body: Record<string, unknown> }[] = [];
  let generations = 0;
  const transport = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const route = new URL(url instanceof Request ? url.url : url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    requests.push({ path: route, method: init?.method ?? 'GET', body });
    if (route === '/api/providers') return Response.json({ providers: [{ instanceId: 'codex', revision: 1 }] });
    if (route === '/api/providers/codex') return Response.json({ instanceId: 'codex', revision: 2 });
    if (route === '/api/providers/codex/test') return Response.json({ ok: true, nativeSessionReady: true });
    if (route === '/api/agent-workspaces/open') return Response.json({ workspace: { id: 'aw', revision: 1, path: '/workspace', status: 'available' } });
    if (route === '/api/chat/threads') return Response.json({ thread: { remoteId: body.id, revision: 1 } });
    if (/\/threads\/[^/]+$/.test(route)) return Response.json({ thread: { revision: 2 } });
    if (route === '/api/chat') {
      generations++;
      if (options.loseSubmit) throw new TypeError('response lost');
      return new Response('data: {"type":"finish","finishReason":"stop"}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-resumable-stream-id': `g${generations}` } });
    }
    if (route.endsWith('/generations')) return Response.json({ generations: Array.from({ length: generations }, (_, index) => ({ id: `g${index + 1}`, status: 'completed' })) });
    if (route.endsWith('/history')) return Response.json({ messages: [] });
    if (route.endsWith('/cancel')) return Response.json({ cancelled: true });
    if (route.endsWith('/output')) return new Response('data: {"kind":"status","status":"completed"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    throw new Error(`Unexpected mock request ${route}`);
  }) as typeof fetch;
  return { transport, requests };
}

test('lost submit response never automatically resends original input or creates replacement Session', async () => {
  const mock = mockTransport({ loseSubmit: true });
  const adapter = new AgentChatAdapter('raw', mock.transport);
  await adapter.prepare(input());
  await assert.rejects(adapter.start({ taskId: 'L02', instruction: 'mutate once' }), /outcome unknown/);
  assert.equal(mock.requests.filter(request => request.path === '/api/chat').length, 1);
  assert.equal(mock.requests.filter(request => request.path === '/api/chat/threads').length, 1);
});

test('resume creates a truly new Session without native continuation or copied messages', async () => {
  const mock = mockTransport();
  const adapter = new AgentChatAdapter('raw', mock.transport);
  await adapter.prepare(input());
  const first = await adapter.start({ taskId: 'L04', instruction: 'original' });
  for await (const _ of adapter.observe(first.sessionId)) { /* Consume real test protocol frames. */ }
  await assert.rejects(adapter.resume({ priorSessionId: first.sessionId, instruction: 'resume' }), /acknowledgement/);
  await adapter.interrupt(first.sessionId, 'test checkpoint');
  const second = await adapter.resume({ priorSessionId: first.sessionId, instruction: 'read current sources' });
  assert.notEqual(second.sessionId, first.sessionId);
  for await (const _ of adapter.observe(second.sessionId)) { /* Drain test protocol. */ }
  const submissions = mock.requests.filter(request => request.path === '/api/chat');
  assert.equal(submissions.length, 2);
  assert.equal((submissions[1]!.body.messages as unknown[]).length, 1);
  assert.equal(mock.requests.some(request => /\/(continue|fork)$/.test(request.path)), false);
  const configured = mock.requests.filter(request => request.method === 'PUT' && request.path.includes('/chat/threads/'));
  assert.deepEqual(configured[0]!.body.settings, configured[1]!.body.settings);
});

test('raw exposes the same PM tool capabilities and refuses host/non-isolated runtime', async () => {
  const mock = mockTransport();
  const adapter = new AgentChatAdapter('raw', mock.transport);
  const prepared = input();
  prepared.fixture.runtime!.isolationVerified = false;
  await assert.rejects(adapter.prepare(prepared), /OS-isolated/);
  assert.equal(mock.requests.length, 0);
  const unsafe = input();
  unsafe.fixture.runtime!.agentBaseUrl = 'http://127.0.0.1:4325';
  await assert.rejects(new AgentChatAdapter('raw', mock.transport).prepare(unsafe), /non-production/);
  assert.equal(mock.requests.length, 0);
});
