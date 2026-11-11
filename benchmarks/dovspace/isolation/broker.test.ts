import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseBenchmarkConfig } from '../benchmark.config.ts';
import type { FixtureHandle } from '../schemas/types.ts';
import { authoritativeProviderUsage, boundedProviderRequest, publicAddress, startBroker } from './broker.ts';
import { cleanEnvironment, safeProcessDiagnostic } from './docker.ts';
import { automationServiceHeaders, verifyAutomationServiceRequest } from '../../../packages/infrastructure/src/automation-execution-client.ts';

async function listening(server: Server): Promise<number> {
  const ready = Promise.withResolvers<number>();
  server.listen(0, '127.0.0.1', () => { const address = server.address(); if (address && typeof address !== 'string') ready.resolve(address.port); else ready.reject(new Error('No test address')); });
  return ready.promise;
}
async function close(server: Server): Promise<void> { const done = Promise.withResolvers<void>(); server.close(() => done.resolve()); server.closeAllConnections(); await done.promise; }
function call(socketPath: string, route: string, input: unknown, cookie = 'fixture-cookie', headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const done = Promise.withResolvers<{ status: number; body: unknown }>();
  const child = request({ socketPath, path: route, method: 'POST', headers: { cookie, 'content-type': 'application/json', ...headers } }, response => {
    const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.once('end', () => done.resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }));
  });
  child.once('error', done.reject); child.end(JSON.stringify(input)); return done.promise;
}
test('child environment never inherits HOME credentials, database URLs or injection variables', () => {
  const env = cleanEnvironment({ HOME: '/explicit-fixture-home' });
  assert.equal(env.HOME, '/explicit-fixture-home');
  for (const key of ['DATABASE_URL', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'LD_PRELOAD', 'PM_API_URL', 'DOCKER_HOST']) assert.equal(env[key], undefined);
});
test('bounded startup diagnostics retain OCI causes without credentials or process configuration', () => {
  const secret = 'synthetic-credential-for-diagnostic-test';
  const diagnostic = safeProcessDiagnostic(`OCI runtime create failed: read-only file system; token=${secret}; Bearer hidden-value; postgresql://operator:hidden-password@localhost/db\nargv=["sensitive-command"]\n${'x'.repeat(20_000)}`, [secret]);
  assert.match(diagnostic, /OCI runtime create failed: read-only file system/);
  for (const value of [secret, 'hidden-value', 'hidden-password', 'sensitive-command']) assert.ok(!diagnostic.includes(value));
  assert.ok(diagnostic.length <= 16_384);
});
test('provider egress refuses local, private, mapped and metadata addresses', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true);
});
test('provider budget accepts inline native text/tool transcripts but refuses referenced context and hosted billing', () => {
  const valid = { model: 'pinned', stream: true, store: false, service_tier: 'default', client_metadata: {}, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fictional' }] }, { type: 'function_call', call_id: 'call', name: 'exec_command', arguments: '{}' }, { type: 'function_call_output', call_id: 'call', output: 'done' }], tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object' } }] };
  assert.equal(boundedProviderRequest(valid), true);
  assert.equal(boundedProviderRequest({ ...valid, previous_response_id: 'hidden-server-context' }), false);
  assert.equal(boundedProviderRequest({ ...valid, conversation: 'unbounded' }), false);
  assert.equal(boundedProviderRequest({ ...valid, input: [{ type: 'input_image', image_url: 'https://example.test/image' }] }), false);
  assert.equal(boundedProviderRequest({ ...valid, tools: [{ type: 'web_search' }] }), false);
  assert.equal(boundedProviderRequest({ ...valid, service_tier: 'priority' }), false);
});
test('only terminal provider usage may settle the cost reservation', () => {
  assert.equal(authoritativeProviderUsage({ type: 'response.created', response: { usage: { input_tokens: 1, output_tokens: 0 } } }, true), undefined);
  assert.deepEqual(authoritativeProviderUsage({ type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 50 } } }, true), { input_tokens: 100, output_tokens: 50 });
  assert.equal(authoritativeProviderUsage({ type: 'response.completed', response: {} }, true), undefined);
  assert.deepEqual(authoritativeProviderUsage({ usage: { input_tokens: 100, output_tokens: 50 } }, false), { input_tokens: 100, output_tokens: 50 });
});
test('PM broker denies wrong credentials/targets/direct writes, drops only a proven commit, and reconciles original identity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dovspace-broker-'));
  let requests = 0;
  const authority = createServer((incoming, outgoing) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk as Uint8Array));
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { operationId: string };
      requests++;
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ status: 'succeeded', result: { kind: 'task', items: [], receipt: { kind: 'core', operationId: input.operationId, commandId: 'original-command', targetId: 'TASK-001', revision: 'real-result-revision' } } }));
    })();
  });
  const port = await listening(authority), socketPath = path.join(root, 'broker.sock');
  const target = { key: 'assigned', workspaceId: '11111111-1111-4111-8111-111111111111', projectId: 'PRJ-001', entityId: 'TASK-001', revision: 'original-revision', kind: 'work_item' };
  const fixture: FixtureHandle = { fixtureId: 'test-only-transport', fixtureVersion: 'test', root, publicRoot: root, authorityRoot: root, agentDataRoot: root, workspaceId: target.workspaceId, actorId: 'owner', targets: { assigned: target }, pm: { baseUrl: `http://127.0.0.1:${port}`, token: 'fixture-cookie' }, runtime: null, isolation: null };
  const config = parseBenchmarkConfig();
  const broker = await startBroker(config, fixture, { runId: 'unit', budget: config.budget, allowedTools: ['pm_update_task'], allowedTargets: [target], providerToken: 'synthetic-only', socketPath });
  const input = { operationId: 'original-operation', name: 'pm_update_task', target: { workspaceId: target.workspaceId, projectId: target.projectId }, threadId: 'original-session', arguments: { id: 'TASK-001', revision: 'original-revision', priority: 'high' } };
  const route = `/api/v1/workspaces/${target.workspaceId}/agent-tools/call`;
  try {
    assert.equal((await call(socketPath, route, input, 'wrong-cookie')).status, 403);
    assert.equal((await call(socketPath, route, { ...input, arguments: { id: 'TASK-999' } })).status, 403);
    assert.equal((await call(socketPath, `/api/v1/workspaces/${target.workspaceId}/core/entities`, input)).status, 403);
    assert.equal(requests, 0);
    broker.armResponseLoss('TASK-001');
    await assert.rejects(call(socketPath, route, input));
    assert.equal(requests, 1);
    const lost = broker.events.find(event => event.type === 'response_lost');
    assert.equal(lost?.operationId, input.operationId);
    assert.equal(lost?.data.revision, 'real-result-revision');
    assert.equal(lost?.data.receiptIdentity, 'original-command');
    await call(socketPath, route.replace('/call', '/result'), input);
    assert.equal(broker.events.find(event => event.type === 'receipt_reconciled')?.operationId, input.operationId);
    assert.ok(!JSON.stringify(broker.events).includes('fixture-cookie'));
    assert.ok(!JSON.stringify(broker.events).includes('synthetic-only'));
  } finally { await broker.close(); await close(authority); await rm(root, { recursive: true, force: true }); }
});
test('signed platform signals require owned scope and actual prior Session/generation; forwarding retains exact HMAC bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dovspace-signal-'));
  const secret = 'explicit-benchmark-platform-secret-32-bytes', workspaceId = '11111111-1111-4111-8111-111111111111', actorId = '22222222-2222-4222-8222-222222222222';
  let forwardedSignals = 0;
  const authority = createServer((incoming, outgoing) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk as Uint8Array));
    const raw = Buffer.concat(chunks).toString('utf8'), input = JSON.parse(raw) as { eventId?: string };
    outgoing.setHeader('content-type', 'application/json');
    if (incoming.url?.endsWith('/automations/pm/signals')) {
      const signed = new Headers();
      for (const name of ['x-pm-automation-timestamp', 'x-pm-automation-signature']) { const value = incoming.headers[name]; if (typeof value === 'string') signed.set(name, value); }
      if (incoming.headers.cookie !== undefined || !verifyAutomationServiceRequest('POST', incoming.url, raw, signed, secret)) { outgoing.writeHead(401); outgoing.end('{}'); return; }
      forwardedSignals++; outgoing.end(JSON.stringify({ eventId: input.eventId, accepted: true }));
    } else outgoing.end(JSON.stringify({ status: 'succeeded', result: { kind: 'task', items: [{ id: 'TASK-001', revision: 'revision' }] } }));
  })(); });
  const port = await listening(authority), socketPath = path.join(root, 'host.sock');
  const target = { key: 'assigned', workspaceId, projectId: 'PRJ-001', entityId: 'TASK-001', revision: 'revision', kind: 'work_item' };
  const fixture: FixtureHandle = { fixtureId: 'signed-signal-policy', fixtureVersion: 'test', root, publicRoot: root, authorityRoot: root, agentDataRoot: root, workspaceId, actorId, targets: { assigned: target }, pm: { baseUrl: `http://127.0.0.1:${port}`, token: 'fixture-cookie' }, runtime: null, isolation: null };
  const config = parseBenchmarkConfig();
  const broker = await startBroker(config, fixture, { runId: 'signed-signal', budget: config.budget, allowedTools: ['pm_read'], allowedTargets: [target], providerToken: 'provider-only', socketPath, pmServiceSecret: secret });
  const route = `/api/v1/workspaces/${workspaceId}/automations/pm/signals`, revision = 'a'.repeat(64), at = new Date().toISOString();
  const signal = { eventId: `agent:agent.run.terminal:generation-known:${revision.slice(0, 20)}`, source: 'pm', key: 'agent.run.terminal', actorId, workspaceId, projectId: 'PRJ-001', at, sourceRef: { refId: `agent:agent.run.terminal:${revision}`, kind: 'execution', id: 'generation-known', revision, actorId, workspaceId, projectId: 'PRJ-001', label: 'Agent generation succeeded', url: '/agent/workspace?threadId=session-known', updatedAt: at }, originExecutionId: null, before: null, after: null, lastVisitAt: null, visitedAt: null };
  const send = (value: typeof signal, forged = false) => call(socketPath, route, value, '', Object.fromEntries(forged ? new Headers({ 'x-pm-automation-timestamp': String(Date.now()), 'x-pm-automation-signature': 'forged' }) : automationServiceHeaders('POST', route, JSON.stringify(value), secret)));
  try {
    assert.equal((await send(signal, true)).status, 401);
    assert.equal((await send(signal)).status, 403, 'No Session/generation authority was observed yet');
    await call(socketPath, `/api/v1/workspaces/${workspaceId}/agent-tools/call`, { operationId: 'read-operation', name: 'pm_read', target: { workspaceId, projectId: 'PRJ-001' }, threadId: 'session-known', generationId: 'generation-known', arguments: { id: 'TASK-001' } });
    assert.equal((await send({ ...signal, actorId: '33333333-3333-4333-8333-333333333333' })).status, 403);
    assert.equal((await send({ ...signal, workspaceId: '44444444-4444-4444-8444-444444444444' })).status, 403);
    assert.equal((await send({ ...signal, projectId: 'PRJ-999', sourceRef: { ...signal.sourceRef, projectId: 'PRJ-999' } })).status, 403);
    assert.equal((await send({ ...signal, eventId: `agent:agent.run.terminal:unknown-generation:${revision.slice(0, 20)}`, sourceRef: { ...signal.sourceRef, id: 'unknown-generation' } })).status, 403);
    assert.equal(forwardedSignals, 0);
    assert.equal((await send(signal)).status, 200);
    const accepted = broker.events.find(event => event.type === 'platform_signal_accepted');
    assert.equal(accepted?.sessionId, 'session-known'); assert.equal(accepted?.generationId, 'generation-known');
    assert.deepEqual(accepted?.data.payload, signal);
    assert.equal(forwardedSignals, 1);
    assert.ok(!JSON.stringify(broker.events).includes(secret));
  } finally { await broker.close(); await close(authority); await rm(root, { recursive: true, force: true }); }
});
