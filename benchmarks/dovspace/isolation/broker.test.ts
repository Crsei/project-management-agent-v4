import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, request, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBenchmarkConfig } from '../benchmark.config.ts';
import type { FixtureHandle } from '../schemas/types.ts';
import { authoritativeProviderUsage, boundedProviderRequest, publicAddress, startBroker } from './broker.ts';
import { cleanEnvironment, safeProcessDiagnostic } from './docker.ts';
import { automationServiceHeaders, verifyAutomationServiceRequest } from '../../../packages/infrastructure/src/automation-execution-client.ts';
import { createControlledOmpProvider } from './controlled-provider.ts';

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
  const input = { operationId: '22222222-2222-4222-8222-222222222222', name: 'pm_update_task', target: { workspaceId: target.workspaceId, projectId: target.projectId }, threadId: 'original-session', arguments: { id: 'TASK-001', revision: 'original-revision', priority: 'high' } };
  const route = `/api/v1/workspaces/${target.workspaceId}/agent-tools/call`;
  try {
    assert.equal((await call(socketPath, route, input, 'wrong-cookie')).status, 403);
    assert.equal((await call(socketPath, route, { ...input, arguments: { id: 'TASK-999' } })).status, 403);
    assert.equal((await call(socketPath, route, { ...input, arguments: { id: 'TASK-001', status: 'done' } })).status, 403);
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
    assert.equal(broker.events.find(event => event.type === 'pm_reconcile_request')?.data.mutation, false, 'Reading an original write result is not a second mutation');
    assert.equal(requests, 2);
    assert.ok(!JSON.stringify(broker.events).includes('fixture-cookie'));
    assert.ok(!JSON.stringify(broker.events).includes('synthetic-only'));
  } finally { await broker.close(); await close(authority); await rm(root, { recursive: true, force: true }); }
});

test('PM broker accepts only the fixture native bearer and retains bearer precedence and route scope', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dovspace-broker-auth-'));
  const token = 'p'.repeat(43), cookie = `pm_v4_session=${token}`;
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  const seen: Array<{ authorization: string | undefined; path: string | undefined }> = [];
  const authority = createServer((incoming, outgoing) => {
    incoming.resume();
    seen.push({ authorization: incoming.headers.authorization, path: incoming.url });
    outgoing.writeHead(200, { 'content-type': 'application/json' });
    outgoing.end(JSON.stringify({ allowed: true }));
  });
  const port = await listening(authority), socketPath = path.join(root, 'broker.sock');
  const target = { key: 'assigned', workspaceId, projectId: 'PRJ-001', entityId: 'TASK-001', revision: 'original', kind: 'work_item' };
  const fixture: FixtureHandle = { fixtureId: 'native-bearer-boundary', fixtureVersion: 'test', root, publicRoot: root, authorityRoot: root, agentDataRoot: root, workspaceId, actorId: 'owner', targets: { assigned: target }, pm: { baseUrl: `http://127.0.0.1:${port}`, token: cookie }, runtime: null, isolation: null };
  const config = parseBenchmarkConfig();
  const broker = await startBroker(config, fixture, { runId: 'native-bearer', budget: config.budget, allowedTools: ['pm_read'], allowedTargets: [target], providerToken: 'provider-only', agentAccessToken: 'agent-only', socketPath });
  const context = { workspaceId, projectId: target.projectId };
  try {
    assert.equal((await call(socketPath, '/api/v1/agent-contexts/authorize', context, '', { authorization: `Bearer ${token}` })).status, 200);
    assert.deepEqual(seen, [{ authorization: `Bearer ${token}`, path: '/api/v1/agent-contexts/authorize' }]);
    assert.equal((await call(socketPath, '/api/v1/agent-contexts/authorize', context, cookie, { authorization: 'Bearer another-identity' })).status, 403);
    assert.equal((await call(socketPath, '/api/v1/agent-contexts/authorize', context, '', { authorization: 'Bearer provider-only' })).status, 403);
    assert.equal((await call(socketPath, '/api/v1/agent-contexts/authorize', { ...context, projectId: 'PRJ-999' }, '', { authorization: `Bearer ${token}` })).status, 403);
    assert.equal((await call(socketPath, `/api/v1/workspaces/${workspaceId}/core/entities`, {}, '', { authorization: `Bearer ${token}` })).status, 403);
    assert.equal(seen.length, 1, 'Rejected identity, target and direct-write requests never reach PM authority');
    assert.equal((await call(socketPath, '/api/v1/agent-contexts/authorize', context, cookie)).status, 200);
    assert.equal(seen.length, 2);
    assert.equal((await call(socketPath, '/api/v1/agent-contexts/authorize', context, cookie, { authorization: 'Bearer agent-only' })).status, 200);
    assert.deepEqual(seen[2], { authorization: undefined, path: '/api/v1/agent-contexts/authorize' }, 'HTTP Agent credentials are stripped before PM authority');
    assert.equal((await call(socketPath, '/api/v1/agent-contexts/authorize', context, '', { authorization: 'Bearer agent-only' })).status, 403);
    assert.ok(!JSON.stringify(broker.events).includes(token));
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
    await call(socketPath, `/api/v1/workspaces/${workspaceId}/agent-tools/call`, { operationId: '22222222-2222-4222-8222-222222222222', name: 'pm_read', target: { workspaceId, projectId: 'PRJ-001' }, threadId: 'session-known', generationId: 'generation-known', arguments: { id: 'TASK-001' } });
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

test('authorized workflow and original-result reads preserve scope, revision and unresolved outcomes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dovspace-broker-read-contract-'));
  const seen: Array<{ route: string | undefined; input: Record<string, unknown> }> = [];
  let resultStatus = 'unknown';
  const authority = createServer((incoming, outgoing) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk as Uint8Array));
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    seen.push({ route: incoming.url, input });
    outgoing.setHeader('content-type', 'application/json');
    if (input.name === 'pm_update_task') {
      outgoing.writeHead(409);
      outgoing.end(JSON.stringify({ status: 'failed', error: { code: 'revision_conflict' } }));
    } else outgoing.end(JSON.stringify({ operationId: input.operationId, status: incoming.url?.endsWith('/result') ? resultStatus : 'succeeded', result: { kind: 'workflow', items: [], workflow: { projectId: 'PRJ-001', revision: 'current-workflow' } } }));
  })(); });
  const port = await listening(authority), socketPath = path.join(root, 'broker.sock');
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  const target = { key: 'assigned', workspaceId, projectId: 'PRJ-001', entityId: 'TASK-001', revision: 'original', kind: 'work_item' };
  const fixture: FixtureHandle = { fixtureId: 'read-contract', fixtureVersion: 'test', root, publicRoot: root, authorityRoot: root, agentDataRoot: root, workspaceId, actorId: 'owner', targets: { assigned: target }, pm: { baseUrl: `http://127.0.0.1:${port}`, token: 'fixture-cookie' }, runtime: null, isolation: null };
  const config = parseBenchmarkConfig();
  const broker = await startBroker(config, fixture, { runId: 'read-contract', budget: config.budget, allowedTools: ['pm_read_workflow', 'pm_get_operation_result', 'pm_update_task', 'pm_read_future_mutation'], allowedTargets: [target], providerToken: 'synthetic-only', socketPath });
  const route = `/api/v1/workspaces/${workspaceId}/agent-tools/call`;
  const original = { name: 'pm_read_workflow', operationId: '22222222-2222-4222-8222-222222222222', target: { workspaceId, projectId: 'PRJ-001' }, arguments: { projectId: 'PRJ-001' } };
  try {
    assert.equal((await call(socketPath, route, original)).status, 200);
    assert.equal(broker.events.find(event => event.type === 'pm_request')?.data.mutation, false);
    const unresolved = await call(socketPath, route.replace('/call', '/result'), original);
    assert.equal(unresolved.status, 200);
    assert.equal(broker.events.filter(event => event.type === 'receipt_reconciled').length, 0);
    assert.equal(broker.events.find(event => event.type === 'receipt_reconciliation_unresolved')?.operationId, original.operationId);
    resultStatus = 'succeeded';
    assert.equal((await call(socketPath, route.replace('/call', '/result'), original)).status, 200);
    assert.equal(broker.events.find(event => event.type === 'receipt_reconciled')?.operationId, original.operationId);
    assert.deepEqual(seen.map(entry => entry.input), [original, original, original], 'Result queries retain the server-owned original name/target/arguments');
    assert.deepEqual(seen.map(entry => entry.route), [route, route.replace('/call', '/result'), route.replace('/call', '/result')]);
    const conflict = await call(socketPath, route, { ...original, name: 'pm_update_task', arguments: { id: target.entityId, revision: 'stale-revision', priority: 'high' } });
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.body, { status: 'failed', error: { code: 'revision_conflict' } }, 'PM authority still owns revision validation');
    const forwarded = seen.length;
    for (const input of [
      { ...original, arguments: { projectId: 'PRJ-999' } },
      { ...original, target: { workspaceId, projectId: 'PRJ-999' }, arguments: { projectId: 'PRJ-999' } },
      { ...original, target: { workspaceId, projectId: null } },
      { ...original, name: 'pm_delete_task' },
      { ...original, name: 'pm_get_operation_result', arguments: { operationId: original.operationId } },
      { ...original, name: 'pm_read_future_mutation', arguments: { id: 'TASK-999' } },
    ]) assert.equal((await call(socketPath, route, input)).status, 403);
    assert.equal(seen.length, forwarded, 'No denied target, control or read-prefix lookalike reaches authority');
  } finally { await broker.close(); await close(authority); await rm(root, { recursive: true, force: true }); }
});

test('tool denials expose bounded reasons and safe linkage without arguments or unauthorized identities', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dovspace-broker-denials-'));
  let requests = 0;
  const authority = createServer((incoming, outgoing) => { requests++; incoming.resume(); outgoing.end('{}'); });
  const port = await listening(authority), socketPath = path.join(root, 'broker.sock');
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  const target = { key: 'assigned', workspaceId, projectId: 'PRJ-001', entityId: 'TASK-001', revision: 'original', kind: 'work_item' };
  const fixture: FixtureHandle = { fixtureId: 'denial-metadata', fixtureVersion: 'test', root, publicRoot: root, authorityRoot: root, agentDataRoot: root, workspaceId, actorId: 'owner', targets: { assigned: target }, pm: { baseUrl: `http://127.0.0.1:${port}`, token: 'fixture-cookie' }, runtime: null, isolation: null };
  const config = parseBenchmarkConfig();
  const broker = await startBroker(config, fixture, { runId: 'denial-metadata', budget: config.budget, allowedTools: ['pm_update_task'], allowedTargets: [target], providerToken: 'synthetic-only', socketPath });
  const route = `/api/v1/workspaces/${workspaceId}/agent-tools/call`;
  const operationId = '22222222-2222-4222-8222-222222222222', threadId = 'bench-33333333-3333-4333-8333-333333333333', generationId = '44444444-4444-4444-8444-444444444444';
  const secret = 'PRIVATE-ARGUMENT-AND-INVALID-IDENTITY';
  const original = { name: 'pm_update_task', operationId, threadId, generationId, target: { workspaceId, projectId: 'PRJ-001' }, arguments: { id: 'TASK-001', body: secret } };
  const cases: Array<{ input: unknown; reason: string; toolName?: string; operationIdState?: string }> = [
    { input: null, reason: 'invalid-request' },
    { input: [], reason: 'invalid-request' },
    { input: { ...original, name: undefined }, reason: 'missing-tool-name' },
    { input: { ...original, name: { secret } }, reason: 'invalid-tool-name' },
    { input: { ...original, name: `pm_${'x'.repeat(1000)}` }, reason: 'invalid-tool-name' },
    { input: { ...original, name: 'pm_delete_task' }, reason: 'tool-not-allowed', toolName: 'pm_delete_task' },
    { input: { ...original, name: 'pm_private_unregistered_tool' }, reason: 'tool-not-allowed' },
    { input: { ...original, target: { workspaceId: secret, projectId: secret } }, reason: 'workspace-mismatch', toolName: original.name },
    { input: { ...original, operationId: undefined }, reason: 'missing-operation-id', toolName: original.name, operationIdState: 'missing' },
    { input: { ...original, operationId: 42 }, reason: 'invalid-operation-id', toolName: original.name, operationIdState: 'invalid' },
    { input: { ...original, operationId: secret, threadId: secret, generationId: secret }, reason: 'invalid-operation-id', toolName: original.name, operationIdState: 'invalid' },
    { input: { ...original, arguments: [secret] }, reason: 'invalid-arguments', toolName: original.name },
    { input: { ...original, arguments: { id: secret, body: secret } }, reason: 'target-out-of-scope', toolName: original.name },
    { input: { ...original, arguments: { id: 'TASK-001', status: 'done', body: secret } }, reason: 'forbidden-status', toolName: original.name },
  ];
  try {
    for (const scenario of cases) {
      const response = await call(socketPath, route, scenario.input);
      assert.equal(response.status, 403);
      assert.deepEqual(response.body, { error: 'benchmark_capability_denied', reason: scenario.reason });
      const event = broker.events.at(-1)!;
      assert.equal(event.type, 'safety_violation'); assert.equal(event.data.reason, scenario.reason);
      assert.equal(event.toolName, scenario.toolName);
      assert.equal(event.data.requestKind, 'call');
      if (scenario.operationIdState) assert.equal(event.data.operationIdState, scenario.operationIdState);
      assert.ok(JSON.stringify(event).length < 1024);
    }
    const attributed = broker.events.find(event => event.toolName === 'pm_delete_task')!;
    assert.equal(attributed.operationId, operationId);
    assert.equal(attributed.sessionId, threadId); assert.equal(attributed.threadId, threadId); assert.equal(attributed.generationId, generationId);
    await call(socketPath, route.replace(workspaceId, secret), original);
    assert.equal(broker.events.at(-1)?.data.reason, 'route-not-allowed');
    assert.equal(requests, 0);
    for (const value of [secret, 'fixture-cookie', 'synthetic-only', 'pm_private_unregistered_tool']) assert.ok(!JSON.stringify(broker.events).includes(value));
  } finally { await broker.close(); await close(authority); await rm(root, { recursive: true, force: true }); }
});

test('controlled native prewrite command discovers the existing CLI and persists identity before one call', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dovspace-prewrite-cli-'));
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  const target = { key: 'beacon-receipt', workspaceId, projectId: 'PRJ-002', entityId: 'TASK-009', revision: 'current-revision', kind: 'work_item' };
  let discoveries = 0, writes = 0;
  const observed: Array<{ invocation: Record<string, unknown>; handoff: Record<string, unknown>; saved: Record<string, unknown> }> = [];
  const bridge = createServer((incoming, outgoing) => { void (async () => {
    outgoing.setHeader('content-type', 'application/json');
    if (incoming.method === 'GET' && incoming.url === '/tools/list') { discoveries++; outgoing.end(JSON.stringify({ tools: [{ name: 'pm_update_task' }] })); return; }
    if (incoming.method !== 'POST' || incoming.url !== '/tools/call') { outgoing.writeHead(403); outgoing.end('{}'); return; }
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk as Uint8Array));
    const invocation = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    const handoff = JSON.parse(await readFile(path.join(root, 'artifacts/handoff.json'), 'utf8')) as Record<string, unknown>;
    const saved = JSON.parse(await readFile(path.join(root, 'artifacts/original-invocation.json'), 'utf8')) as Record<string, unknown>;
    observed.push({ invocation, handoff, saved }); writes++;
    outgoing.end(JSON.stringify({ operationId: invocation.operationId, status: 'unknown', result: null }));
  })().catch(() => { outgoing.writeHead(500); outgoing.end(JSON.stringify({ error: 'prewrite evidence unavailable' })); }); });
  const bridgePort = await listening(bridge);
  const fixture: FixtureHandle = { fixtureId: 'prewrite-cli', fixtureVersion: 'test', root, publicRoot: root, authorityRoot: root, agentDataRoot: root, workspaceId, actorId: 'owner', targets: { 'beacon-receipt': target }, pm: { baseUrl: 'http://unused.invalid', token: 'not-exposed' }, runtime: null, isolation: null };
  const controlled = createControlledOmpProvider(fixture), controlledPort = await listening(controlled);
  try {
    const cli = fileURLToPath(new URL('../../../packages/pm-cli/agent-tools.mjs', import.meta.url));
    const response = await fetch(`http://127.0.0.1:${controlledPort}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      model: 'omp-controlled-protocol', tools: [{ function: { name: 'bash' } }],
      messages: [
        { role: 'user', content: `OMP_CONTROLLED_WRITE: existing CLI '${cli}' 'http://127.0.0.1:${bridgePort}' tools list` },
        { role: 'assistant', tool_calls: [{ id: 'brief', function: { name: 'pm_task_brief', arguments: '{}' } }, { id: 'read', function: { name: 'pm_read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'read', content: JSON.stringify({ revision: target.revision }) },
      ],
    }) });
    assert.equal(response.status, 200);
    const frame = JSON.parse((await response.text()).split('\n').find(line => line.startsWith('data: {'))!.slice(6)) as { choices: Array<{ delta: { tool_calls: Array<{ function: { name: string; arguments: string } }> } }> };
    const action = frame.choices[0]!.delta.tool_calls[0]!.function;
    assert.equal(action.name, 'bash');
    const { command } = JSON.parse(action.arguments) as { command: string };
    const executed = Promise.withResolvers<string>();
    execFile('/bin/sh', ['-c', command], { cwd: root, env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' }, timeout: 5000 }, (error, stdout) => error ? executed.reject(error) : executed.resolve(stdout));
    const output = await executed.promise;
    assert.equal(discoveries, 1); assert.equal(writes, 1);
    const evidence = observed[0]!;
    assert.deepEqual(evidence.invocation, evidence.saved);
    assert.match(String(evidence.invocation.operationId), /^[a-f0-9-]{36}$/);
    assert.equal(evidence.handoff.operationId, evidence.invocation.operationId);
    assert.equal(evidence.handoff.observedRevision, target.revision);
    assert.equal(evidence.handoff.outcome, 'not dispatched; preserve original identity');
    assert.deepEqual(evidence.invocation.target, { workspaceId, projectId: target.projectId });
    assert.equal((evidence.invocation.arguments as Record<string, unknown>).priority, 'high');
    assert.deepEqual(JSON.parse(output), { operationId: evidence.invocation.operationId, status: 'unknown', result: null });
  } finally { await close(controlled); await close(bridge); await rm(root, { recursive: true, force: true }); }
});
