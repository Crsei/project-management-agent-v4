import test from 'node:test';
import assert from 'node:assert/strict';
import { threadSettingsSchema } from '../../../packages/agent-contracts/src/chat.ts';
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

function mockTransport(options: { loseSubmit?: boolean; provider?: 'codex' | 'omp'; omitModel?: boolean; submit?: (body: Record<string, unknown>, init?: RequestInit) => Response | Promise<Response> } = {}) {
  const requests: { path: string; method: string; body: Record<string, unknown> }[] = [];
  let generations = 0;
  const transport = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const route = new URL(url instanceof Request ? url.url : url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    requests.push({ path: route, method: init?.method ?? 'GET', body });
    const provider = options.provider ?? 'codex';
    if (route === '/api/providers' && init?.method === 'POST') return Response.json({ instanceId: provider, revision: 2 });
    if (route === '/api/providers') return Response.json({ providers: provider === 'omp' ? [] : [{ instanceId: 'codex', revision: 1 }] });
    if (route === `/api/providers/${provider}`) return Response.json({ instanceId: provider, revision: 2 });
    if (route === `/api/providers/${provider}/test`) return Response.json({ ok: true, nativeSessionReady: true, authentication: 'unknown', models: options.omitModel ? [] : [{ id: provider === 'omp' ? 'bench/fixed-model' : 'fixed-model' }] });
    if (route === '/api/agent-workspaces/open') return Response.json({ workspace: { id: 'aw', revision: 1, path: '/workspace', status: 'available' } });
    if (route === '/api/chat/threads') return Response.json({ thread: { remoteId: body.id, revision: 1 } });
    if (/\/threads\/[^/]+$/.test(route)) {
      threadSettingsSchema.parse(body.settings);
      return Response.json({ thread: { revision: 2 } });
    }
    if (route === '/api/chat') {
      generations++;
      if (options.submit) return options.submit(body, init);
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
  const prepared = input();
  await adapter.prepare(prepared);
  await assert.rejects(adapter.start({ taskId: 'L02', instruction: 'mutate once' }), /outcome unknown/);
  assert.equal(mock.requests.filter(request => request.path === '/api/chat').length, 1);
  assert.equal(mock.requests.filter(request => request.path === '/api/chat/threads').length, 1);
  assert.equal(prepared.fixture.runtime!.activeGenerationAdmission, undefined);
  assert.equal(prepared.fixture.runtime!.activeGenerationId, undefined);
});

test('HTTP publishes an exact pending Session admission before POST and settles only its accepted generation', async () => {
  const prepared = input(), submitted = Promise.withResolvers<Record<string, unknown>>(), release = Promise.withResolvers<Response>();
  const mock = mockTransport({ submit(body) { submitted.resolve(body); return release.promise; } });
  const adapter = new AgentChatAdapter('raw', mock.transport);
  await adapter.prepare(prepared);
  const starting = adapter.start({ taskId: 'L02', instruction: 'one original input' });
  const body = await submitted.promise, runtime = prepared.fixture.runtime!, admission = runtime.activeGenerationAdmission!;
  assert.ok(admission); assert.equal(admission.sessionId, body.id); assert.equal(runtime.activeGenerationId, undefined);
  release.resolve(new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-resumable-stream-id': 'g1', 'x-accepted-input-message-id': String((body.messages as Record<string, unknown>[])[0]!.id) } }));
  const started = await starting;
  assert.equal(await admission.accepted, 'g1');
  assert.deepEqual(adapter.sessionIdentity(started.sessionId), { sessionId: body.id, generationId: 'g1' });
  for await (const _ of adapter.observe(started.sessionId)) { /* Drain protocol-only acceptance. */ }
  assert.equal(mock.requests.filter(request => request.path === '/api/chat').length, 1);
});

for (const failure of ['rejected', 'missing-identity', 'wrong-input', 'superseded'] as const) {
  test(`HTTP ${failure} acceptance settles pending admission without replay or native generation authority`, async () => {
    const prepared = input(), submitted = Promise.withResolvers<void>(), release = Promise.withResolvers<Response>();
    const mock = mockTransport({ submit() { submitted.resolve(); return release.promise; } });
    const adapter = new AgentChatAdapter('raw', mock.transport);
    await adapter.prepare(prepared);
    const starting = adapter.start({ taskId: 'L02', instruction: 'original input' });
    await submitted.promise;
    const runtime = prepared.fixture.runtime!, admission = runtime.activeGenerationAdmission!;
    if (failure === 'superseded') runtime.activeSessionId = 'another-session';
    const rejected = assert.rejects(starting, failure === 'rejected' ? /HTTP 500/ : /original|cancelled|expired|superseded/);
    release.resolve(failure === 'rejected' ? new Response('submit rejected', { status: 500 }) : new Response('data: [DONE]\n\n', { headers: {
      'content-type': 'text/event-stream',
      ...(failure === 'missing-identity' ? {} : { 'x-resumable-stream-id': 'g1' }),
      ...(failure === 'wrong-input' ? { 'x-accepted-input-message-id': 'unrelated-input' } : {}),
    } }));
    await rejected;
    assert.equal(await admission.accepted, null);
    assert.equal(runtime.activeGenerationAdmission, undefined); assert.equal(runtime.activeGenerationId, undefined);
    assert.equal(admission.signal.aborted, true);
    assert.equal(mock.requests.filter(request => request.path === '/api/chat').length, 1);
    assert.equal(mock.requests.filter(request => request.path === '/api/chat/threads').length, 1);
  });
}

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

test('OMP provisions its own native instance and discovers the exact broker model, never Codex/custom/default fallback', async () => {
  const prepared = input();
  prepared.provider = 'omp';
  prepared.fixture.runtime!.providerConfig = { instanceId: 'omp', driver: 'omp', config: { binaryPath: '/boot/provider-wrapper.sh', launchArgs: '--no-skills' }, environment: [] };
  const mock = mockTransport({ provider: 'omp' }), adapter = new AgentChatAdapter('raw', mock.transport);
  await adapter.prepare(prepared);
  const session = await adapter.start({ taskId: 'L02', instruction: 'native fixture' });
  for await (const _ of adapter.observe(session.sessionId)) { /* Boundary-only regression, not real OMP proof. */ }
  const provisioned = mock.requests.find(request => request.path === '/api/providers' && request.method === 'POST');
  assert.equal(provisioned?.body.driver, 'omp');
  assert.deepEqual(provisioned?.body.customModels, []);
  assert.equal(mock.requests.some(request => request.path.includes('/providers/codex')), false);
  const sent = mock.requests.find(request => request.path === '/api/chat');
  const config = sent?.body.config as Record<string, unknown>;
  assert.equal(config.providerInstanceId, 'omp'); assert.equal(config.modelName, 'bench/fixed-model');
  const failed = mockTransport({ provider: 'omp', omitModel: true });
  await assert.rejects(new AgentChatAdapter('raw', failed.transport).prepare(prepared), /not discovered/);
  assert.equal(failed.requests.some(request => request.path === '/api/chat'), false);
});

test('runtime/provider mismatch and unknown provider fail before any discovery or paid request', async () => {
  const prepared = input(), mock = mockTransport();
  prepared.provider = 'omp';
  await assert.rejects(new AgentChatAdapter('raw', mock.transport).prepare(prepared), /does not match/);
  prepared.provider = 'pi';
  await assert.rejects(new AgentChatAdapter('raw', mock.transport).prepare(prepared), /no provider fallback/);
  assert.equal(mock.requests.length, 0);
});
