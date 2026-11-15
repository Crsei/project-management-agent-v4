import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type RequestListener, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseBenchmarkConfig } from '../benchmark.config.ts';
import type { FixtureHandle, GenerationAdmission } from '../schemas/types.ts';
import { authoritativeProviderUsage, boundedProviderRequest, startBroker } from './broker.ts';
import { normalizeProviderUsage } from './provider-transport.ts';
import { beginGenerationAdmission } from '../adapters/agent-chat.ts';

const metadata = { contextWindow: 200000, maxTokens: 4096, reasoning: false };
const body = { model: 'omp-controlled-protocol', stream: true, messages: [{ role: 'user', content: 'Fictional text' }], tools: [] };
function fixture(root: string): FixtureHandle { return { fixtureId: 'boundary-only-not-native-proof', fixtureVersion: 'test', root, publicRoot: root, authorityRoot: root, agentDataRoot: root, workspaceId: 'owned-workspace', actorId: 'owned-actor', targets: {}, pm: { baseUrl: 'http://127.0.0.1:1', token: 'fixture-cookie' }, runtime: null, isolation: null }; }
async function close(server: Server): Promise<void> { const done = Promise.withResolvers<void>(); server.close(() => done.resolve()); server.closeAllConnections(); await done.promise; }
function post(socketPath: string, route: string, input: unknown, token = 'synthetic-capability', headers: Record<string, string> = {}) {
  const result = Promise.withResolvers<{ status: number; text: string }>();
  const outgoing = request({ socketPath, path: route, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers } }, response => {
    let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += String(chunk); });
    response.once('end', () => result.resolve({ status: response.statusCode ?? 0, text })); response.once('error', result.reject);
  });
  outgoing.once('error', result.reject); outgoing.end(JSON.stringify(input)); return result.promise;
}
test('OMP and Codex config select distinct executable/API paths without implicit model metadata', () => {
  assert.equal(parseBenchmarkConfig().providerBinary, '/usr/local/bin/codex');
  const omp = parseBenchmarkConfig({ provider: 'omp', model: 'explicit', ompModel: metadata });
  assert.equal(omp.providerBinary, '/usr/local/bin/omp'); assert.equal(omp.providerApi, 'openai-responses');
  assert.equal(parseBenchmarkConfig({ provider: 'omp' }).ompModel, undefined, 'No invented catalog limits, reasoning flags or rates');
  assert.equal(omp.prices, undefined);
  assert.throws(() => parseBenchmarkConfig({ provider: 'codex', providerApi: 'openai-completions' }), /Codex requires/);
  assert.throws(() => parseBenchmarkConfig({ provider: 'codex', ompModel: metadata }), /cannot configure a Codex/);
  assert.throws(() => parseBenchmarkConfig({ provider: 'omp', modelOptions: { temperature: '0.5' } }), /only the thinking/);
  assert.throws(() => parseBenchmarkConfig({ providerEndpoint: 'http://127.0.0.1:3901/v1' }), /HTTPS/);
  assert.throws(() => parseBenchmarkConfig({ providerEndpoint: 'https://localhost/v1' }), /Host-local/);
  assert.throws(() => parseBenchmarkConfig({ providerEndpoint: 'https://example.test/v1/responses' }), /API base URL/);
});
test('OpenAI Completions usage is terminal only; missing counters/rates stay unknown', () => {
  assert.equal(authoritativeProviderUsage({ choices: [{ delta: {} }], usage: { prompt_tokens: 999 } }, true, 'openai-completions'), undefined);
  assert.deepEqual(authoritativeProviderUsage({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }, true, 'openai-completions'), { prompt_tokens: 7, completion_tokens: 3 });
  const unknown = normalizeProviderUsage(undefined);
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd']) assert.equal(unknown[key], null);
  const partial = normalizeProviderUsage({ prompt_tokens: 7, completion_tokens: 3 }, { inputPerMillion: 1, outputPerMillion: 2, maxOutputTokens: 100 });
  assert.equal(partial.inputTokens, 7); assert.equal(partial.cacheReadTokens, null); assert.equal(partial.cacheWriteTokens, null); assert.equal(partial.costUsd, null);
  assert.equal(normalizeProviderUsage({ input_tokens: -1, output_tokens: Number.NaN }).inputTokens, null);
});
test('Completions remains inline text/local tools only, never hidden context or multimodal/hosted tools', () => {
  assert.equal(boundedProviderRequest(body, 'openai-completions'), true);
  assert.equal(boundedProviderRequest({ ...body, previous_response_id: 'hidden' }, 'openai-completions'), false);
  assert.equal(boundedProviderRequest({ ...body, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: 'https://example.test/private' }] }] }, 'openai-completions'), false);
  assert.equal(boundedProviderRequest({ ...body, tools: [{ type: 'web_search' }] }, 'openai-completions'), false);
  assert.equal(boundedProviderRequest(body, 'openai-responses'), false);
});
test('controlled HTTP capability rejects wrong model/route/auth, and logs exact wire with explicit missing usage', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dovspace-provider-boundary-'));
  const socketPath = path.join(root, 'broker.sock'), controlledPath = path.join(root, 'controlled.sock');
  let forwarded = 0;
  const controlled = createServer((incoming, outgoing) => { incoming.resume(); forwarded++; outgoing.writeHead(200, { 'content-type': 'text/event-stream' }); outgoing.end('data: {"choices":[{"index":0,"delta":{"content":"边界"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); });
  const listening = Promise.withResolvers<void>(); controlled.listen(controlledPath, listening.resolve); await listening.promise;
  const config = parseBenchmarkConfig({ provider: 'omp', providerApi: 'openai-completions', model: 'omp-controlled-protocol', ompModel: metadata });
  const broker = await startBroker(config, fixture(root), { runId: 'wire-boundary', budget: config.budget, providerToken: 'synthetic-capability', socketPath, controlledProviderSocketPath: controlledPath });
  try {
    assert.equal((await post(socketPath, '/provider/v1/responses', body)).status, 403);
    assert.equal((await post(socketPath, '/provider/v1/chat/completions', body, 'wrong')).status, 403);
    assert.equal((await post(socketPath, '/provider/v1/chat/completions', { ...body, model: 'unapproved' })).status, 403);
    assert.equal(forwarded, 0);
    const result = await post(socketPath, '/provider/v1/chat/completions', body);
    assert.equal(result.status, 200); assert.match(result.text, /边界/); assert.equal(forwarded, 1);
    const sent = broker.events.find(event => event.type === 'provider_request');
    assert.equal(sent?.data.api, 'openai-completions'); assert.equal(sent?.data.correlation, 'missing-generation-identity');
    assert.equal(sent?.data.requestBytes, Buffer.byteLength(JSON.stringify({ ...body, service_tier: 'default' })));
    const usage = broker.events.find(event => event.type === 'provider_usage');
    assert.equal(usage?.data.requestId, sent?.data.requestId); assert.equal(usage?.data.inputTokens, null); assert.equal(usage?.data.costUsd, null); assert.equal(usage?.data.missingReason, 'terminal-usage-absent');
    assert.ok(!JSON.stringify(broker.events).includes('synthetic-capability'));
  } finally { await broker.close(); await close(controlled); await rm(root, { recursive: true, force: true }); }
});
test('missing real credentials never falls back to controlled HTTP or a different runtime', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dovspace-provider-missing-'));
  const config = parseBenchmarkConfig({ provider: 'omp', model: 'paid-model', ompModel: metadata });
  const socketPath = path.join(root, 'broker.sock');
  const broker = await startBroker(config, fixture(root), { runId: 'missing', budget: config.budget, providerToken: 'synthetic-capability', socketPath });
  try {
    assert.equal((await post(socketPath, '/provider/v1/responses', { model: 'paid-model', input: [] })).status, 403);
    assert.equal(broker.events.some(event => event.type === 'provider_request'), false);
    await assert.rejects(startBroker(config, fixture(root), { runId: 'wrong-controlled', budget: config.budget, providerToken: 'synthetic-capability', socketPath: path.join(root, 'other.sock'), controlledProviderSocketPath: path.join(root, 'not-authorized.sock') }), /cannot configure real-provider/);
  } finally { await broker.close(); await rm(root, { recursive: true, force: true }); }
});

test('a provider stream without its terminal frame cannot claim complete observation or zero usage', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dovspace-provider-truncated-'));
  const socketPath = path.join(root, 'broker.sock'), controlledPath = path.join(root, 'controlled.sock');
  const controlled = createServer((incoming, outgoing) => { incoming.resume(); outgoing.writeHead(200, { 'content-type': 'text/event-stream' }); outgoing.end('data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n'); });
  const listening = Promise.withResolvers<void>(); controlled.listen(controlledPath, listening.resolve); await listening.promise;
  const config = parseBenchmarkConfig({ provider: 'omp', providerApi: 'openai-completions', model: 'omp-controlled-protocol', ompModel: metadata });
  const broker = await startBroker(config, fixture(root), { runId: 'truncated', budget: config.budget, providerToken: 'synthetic-capability', socketPath, controlledProviderSocketPath: controlledPath });
  try {
    await post(socketPath, '/provider/v1/chat/completions', body);
    await broker.close();
    const missing = broker.events.find(event => event.type === 'provider_usage');
    assert.equal(missing?.data.missingReason, 'stream-ended-without-terminal'); assert.equal(missing?.data.outputTokens, null);
    const complete = broker.events.find(event => event.type === 'observation_complete');
    assert.equal(complete?.data.providerRequests, false); assert.equal(complete?.data.nativeTools, false);
  } finally { await broker.close(); await close(controlled); await rm(root, { recursive: true, force: true }); }
});

const nativeBody = { model: 'gpt-6.1-sol', store: false, stream: true, reasoning: { effort: 'xhigh' }, input: [{ role: 'user', content: 'Boundary-only test, not a real model or account.' }] };
function nativeConfig(maxCostUsd = 10) {
  return parseBenchmarkConfig({
    provider: 'omp', model: 'gpt-6.1-sol', providerApi: 'openai-codex-responses', providerEndpoint: 'https://chatgpt.com/backend-api', modelOptions: { thinking: 'xhigh' },
    hostAuthBoundary: { kind: 'omp-native-account', provider: 'openai-codex', accountRowId: 17, accountFingerprint: 'a'.repeat(64), sdkVersion: '18.15.0', sdkLockSha256: 'b'.repeat(64), catalogSha256: 'c'.repeat(64) },
    ompModel: { contextWindow: 500000, maxTokens: 128000, reasoning: true, thinking: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'], mode: 'effort' }, omitMaxOutputTokens: true },
    prices: { inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 0.1, cacheWritePerMillion: 0, maxOutputTokens: 128000, version: 'boundary-unit-catalog-not-billing', basis: 'catalog-estimate' },
    budget: { maxDurationMinutes: 1, maxModelCalls: 5, maxToolCalls: 10, maxCostUsd },
  });
}
async function nativeBoundary(listener: RequestListener, maxCostUsd = 10) {
  const root = await mkdtemp(path.join(tmpdir(), 'dovspace-native-boundary-'));
  const relayPath = path.join(root, 'relay.sock'), socketPath = path.join(root, 'broker.sock');
  const server = createServer(listener), listening = Promise.withResolvers<void>();
  server.listen(relayPath, listening.resolve); await listening.promise;
  const config = nativeConfig(maxCostUsd), handle = fixture(root);
  handle.runtime = { activeSessionId: 'owned-session', activeGenerationId: 'owned-generation' } as NonNullable<FixtureHandle['runtime']>;
  const relay = { socketPath: relayPath, capability: 'trusted-host-relay-capability', evidence: { selection: config.hostAuthBoundary } };
  const broker = await startBroker(config, handle, { runId: 'native-boundary-unit-not-model-proof', budget: config.budget, providerToken: 'synthetic-capability', socketPath, nativeAccountRelay: relay });
  return { broker, config, relay, handle, socketPath, async close() { await broker.close(); await close(server); await rm(root, { recursive: true, force: true }); } };
}
function pendingAdmission(handle: FixtureHandle, timeoutMs = 45_000) {
  const controller = new AbortController(), entered = Promise.withResolvers<void>();
  const admission = beginGenerationAdmission(handle.runtime!, 'pending-session', controller.signal, timeoutMs), accepted = admission.accepted;
  // Observe the actual broker wait, not a sleep that might precede request arrival.
  Object.defineProperty(admission, 'accepted', { get() { entered.resolve(); return accepted; } });
  return { admission, controller, entered: entered.promise };
}
test('native account auth cannot be inferred, relabeled as ordinary API, redirected, downgraded, or given an imaginary output cap', () => {
  const config = nativeConfig();
  assert.throws(() => parseBenchmarkConfig({ ...config, hostAuthBoundary: undefined }), /explicitly selected/);
  assert.throws(() => parseBenchmarkConfig({ ...config, providerApi: 'openai-responses' }), /exact openai-codex/);
  assert.throws(() => parseBenchmarkConfig({ ...config, model: 'gpt-5.6-sol' }), /exact openai-codex/);
  assert.throws(() => parseBenchmarkConfig({ ...config, modelOptions: { thinking: 'high' } }), /xhigh/);
  assert.throws(() => parseBenchmarkConfig({ ...config, providerEndpoint: 'https://elsewhere.invalid/backend-api' }), /official Codex origin/);
  assert.throws(() => parseBenchmarkConfig({ ...config, providerApiKey: 'forbidden-key-fallback' }), /no API-key fallback/);
  assert.throws(() => parseBenchmarkConfig({ ...config, prices: { ...config.prices!, maxOutputTokens: 4096 } }), /full catalog output limit/);
});
test('native account proxy configuration rejects credential-bearing, non-loopback and ambiguous URLs', () => {
  const config = nativeConfig();
  for (const httpProxy of ['http://user:secret@127.0.0.1:17891', 'http://localhost:17891', 'http://10.0.0.1:17891', 'https://127.0.0.1:17891', 'http://127.0.0.1:17891/path', 'http://127.0.0.1:17891?token=secret', 'http://127.0.0.1:17891#fragment', 'http://127.0.0.1:0', 'http://127.0.0.1:65536']) {
    assert.throws(() => parseBenchmarkConfig({ ...config, hostAuthBoundary: { ...config.hostAuthBoundary!, httpProxy } }));
  }
});
test('native boundary preserves actual request/generation identity and terminal catalog estimates, rejects origin/account/model overrides before forwarding', async () => {
  let forwarded = 0, sent: Record<string, unknown> = {}, requestId: unknown;
  const runtime = await nativeBoundary((incoming, outgoing) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    sent = JSON.parse(Buffer.concat(chunks).toString('utf8')); requestId = incoming.headers['x-bench-request-id']; forwarded++;
    assert.equal(incoming.headers.authorization, 'Bearer trusted-host-relay-capability');
    outgoing.writeHead(200, { 'content-type': 'text/event-stream', 'x-bench-request-id': String(requestId), 'x-request-id': 'provider-request-unit' });
    outgoing.end('data: {"type":"response.completed","response":{"id":"native-response-unit","model":"gpt-6.1-sol","usage":{"input_tokens":100,"output_tokens":20,"input_tokens_details":{"cached_tokens":20}}}}\n\n');
  })(); });
  try {
    assert.equal((await post(runtime.socketPath, '/provider/v1/responses', nativeBody)).status, 403);
    assert.equal((await post(runtime.socketPath, '/provider/v1/codex/responses', { ...nativeBody, model: 'fallback' })).status, 403);
    assert.equal((await post(runtime.socketPath, '/provider/v1/codex/responses', { ...nativeBody, reasoning: { effort: 'high' } })).status, 403);
    assert.equal((await post(runtime.socketPath, '/provider/v1/codex/responses', nativeBody, 'synthetic-capability', { origin: 'https://unauthorized.invalid' })).status, 403);
    assert.equal((await post(runtime.socketPath, '/provider/v1/codex/responses', nativeBody, 'synthetic-capability', { 'chatgpt-account-id': 'unauthorized-account' })).status, 403);
    delete runtime.handle.runtime!.activeGenerationId;
    assert.equal((await post(runtime.socketPath, '/provider/v1/codex/responses', nativeBody)).status, 403);
    runtime.handle.runtime!.activeGenerationId = 'owned-generation';
    assert.equal(forwarded, 0);
    const result = await post(runtime.socketPath, '/provider/v1/codex/responses', nativeBody);
    assert.equal(result.status, 200); assert.equal(forwarded, 1);
    assert.equal(sent.model, 'gpt-6.1-sol'); assert.equal(sent.max_output_tokens, undefined);
    const observed = runtime.broker.events.find(event => event.type === 'provider_request')!;
    assert.equal(observed.data.requestId, requestId); assert.equal(observed.sessionId, 'owned-session'); assert.equal(observed.generationId, 'owned-generation');
    assert.equal(runtime.broker.events.find(event => event.type === 'provider_response')?.data.upstreamRequestId, 'provider-request-unit');
    assert.equal(observed.data.outputCapEnforced, false); assert.equal(observed.data.reservedMaxOutputTokens, 128000);
    const usage = runtime.broker.events.find(event => event.type === 'provider_usage')!;
    assert.equal(usage.data.costBasis, 'catalog-estimate'); assert.equal(usage.data.costUsd, 0.000362); assert.equal(usage.data.actualSubscriptionBillingUsd, null);
    assert.equal(usage.data.cacheWriteTokens, null, 'Unreported cache-write tokens stay unknown even though their catalog rate is explicitly zero');
    assert.ok(!JSON.stringify(runtime.broker.events).includes('trusted-host-relay-capability'));
    await assert.rejects(startBroker(runtime.config, runtime.handle, { runId: 'wrong-account-relay', budget: runtime.config.budget, providerToken: 'synthetic-capability', socketPath: runtime.socketPath + '-other', nativeAccountRelay: { ...runtime.relay, evidence: { selection: { ...runtime.config.hostAuthBoundary!, accountRowId: 18 } } } }), /account selection differs/);
    await assert.rejects(startBroker(runtime.config, runtime.handle, { runId: 'wrong-proxy-relay', budget: runtime.config.budget, providerToken: 'synthetic-capability', socketPath: runtime.socketPath + '-proxy', nativeAccountRelay: { ...runtime.relay, evidence: { selection: { ...runtime.config.hostAuthBoundary!, httpProxy: 'http://127.0.0.1:17891' } } } }), /account selection differs/);
  } finally { await runtime.close(); }
});
test('native request arriving before acceptance waits for only the same trusted accepted generation', { timeout: 5000 }, async () => {
  let forwarded = 0;
  const runtime = await nativeBoundary((incoming, outgoing) => {
    incoming.resume(); forwarded++;
    outgoing.writeHead(200, { 'content-type': 'text/event-stream', 'x-bench-request-id': String(incoming.headers['x-bench-request-id']) });
    outgoing.end('data: {"type":"response.done","response":{"model":"gpt-6.1-sol"}}\n\n');
  });
  const pending = pendingAdmission(runtime.handle);
  try {
    const response = post(runtime.socketPath, '/provider/v1/codex/responses', nativeBody, 'synthetic-capability', { 'session-id': 'attacker-session', 'thread-id': 'attacker-generation' });
    await pending.entered;
    assert.equal(forwarded, 0);
    assert.equal(runtime.broker.events.some(event => ['provider_request', 'provider_usage', 'provider_settings'].includes(event.type)), false);
    assert.equal(runtime.handle.runtime!.activeGenerationId, undefined);
    assert.equal(pending.admission.settle('accepted-generation'), true);
    assert.equal((await response).status, 200); assert.equal(forwarded, 1);
    const observed = runtime.broker.events.find(event => event.type === 'provider_request')!;
    assert.equal(observed.sessionId, 'pending-session'); assert.equal(observed.generationId, 'accepted-generation');
    assert.equal(runtime.broker.events.some(event => event.type === 'safety_violation'), false);
  } finally { pending.admission.settle(null); pending.controller.abort(); await runtime.close(); }
});
for (const failure of ['null', 'abort', 'deadline', 'superseded'] as const) {
  test(`native pending ${failure} acceptance cannot dispatch or adopt a later generation`, { timeout: 5000 }, async () => {
    let forwarded = 0, next: GenerationAdmission | undefined;
    const runtime = await nativeBoundary((incoming, outgoing) => {
      incoming.resume(); forwarded++;
      outgoing.writeHead(200, { 'content-type': 'text/event-stream', 'x-bench-request-id': String(incoming.headers['x-bench-request-id']) });
      outgoing.end('data: {"type":"response.done","response":{"model":"gpt-6.1-sol"}}\n\n');
    });
    const pending = pendingAdmission(runtime.handle, failure === 'deadline' ? 1000 : 45_000);
    try {
      const response = post(runtime.socketPath, '/provider/v1/codex/responses', nativeBody);
      await pending.entered;
      assert.equal(forwarded, 0);
      if (failure === 'null') pending.admission.settle(null);
      if (failure === 'abort') pending.controller.abort();
      if (failure === 'superseded') {
        next = beginGenerationAdmission(runtime.handle.runtime!, 'next-session', new AbortController().signal);
        assert.equal(next.settle('next-generation'), true);
      }
      assert.equal((await response).status, 403);
      assert.equal(pending.admission.settle('late-unrelated-generation'), false);
      assert.equal(forwarded, 0);
      assert.equal(runtime.broker.events.some(event => ['provider_request', 'provider_usage', 'provider_settings'].includes(event.type)), false);
      if (failure === 'superseded') {
        assert.equal((await post(runtime.socketPath, '/provider/v1/codex/responses', nativeBody)).status, 200);
        assert.equal(forwarded, 1);
        const observed = runtime.broker.events.find(event => event.type === 'provider_request')!;
        assert.equal(observed.sessionId, 'next-session'); assert.equal(observed.generationId, 'next-generation');
      }
    } finally { pending.admission.settle(null); next?.settle(null); pending.controller.abort(); await runtime.close(); }
  });
}
test('native response.done accounts nested terminal usage once and releases reservation for the next request', async () => {
  let forwarded = 0;
  const runtime = await nativeBoundary((incoming, outgoing) => {
    incoming.resume(); forwarded++;
    outgoing.writeHead(200, { 'content-type': 'text/event-stream', 'x-bench-request-id': String(incoming.headers['x-bench-request-id']) });
    outgoing.end('data: {"type":"response.done","response":{"model":"gpt-6.1-sol","usage":{"input_tokens":100,"output_tokens":20,"input_tokens_details":{"cached_tokens":20}}}}\n\ndata: {"type":"response.done","response":{"model":"gpt-6.1-sol","usage":{"input_tokens":9000,"output_tokens":9000,"input_tokens_details":{"cached_tokens":0}}}}\n\n');
  }, 1.3);
  try {
    assert.equal((await post(runtime.socketPath, '/provider/v1/codex/responses', nativeBody)).status, 200);
    assert.equal((await post(runtime.socketPath, '/provider/v1/codex/responses', nativeBody)).status, 200);
    assert.equal(forwarded, 2);
    const usage = runtime.broker.events.filter(event => event.type === 'provider_usage');
    assert.equal(usage.length, 2);
    assert.equal(new Set(usage.map(event => event.data.requestId)).size, 2);
    for (const event of usage) {
      assert.equal(event.data.costUsd, 0.000362); assert.equal(event.data.costBasis, 'catalog-estimate');
      assert.equal(event.data.inputTokens, 100); assert.equal(event.data.actualSubscriptionBillingUsd, null);
    }
    assert.equal(runtime.broker.events.some(event => event.type === 'budget_exceeded'), false);
    const responses = runtime.broker.events.filter(event => event.type === 'provider_response');
    assert.equal(responses.length, 2); assert.ok(responses.every(event => event.data.terminal === true && event.data.usageRecorded === true));
    await runtime.broker.close();
    assert.equal(runtime.broker.events.find(event => event.type === 'observation_complete')?.data.providerRequests, true);
  } finally { await runtime.close(); }
});
test('response.done is a native-only terminal usage contract, not an ordinary Responses or Completions extension', () => {
  const usage = { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 20 } };
  const frame = { type: 'response.done', response: { usage } };
  assert.deepEqual(authoritativeProviderUsage(frame, true, 'openai-codex-responses'), usage);
  assert.equal(authoritativeProviderUsage(frame, true, 'openai-responses'), undefined);
  assert.equal(authoritativeProviderUsage(frame, true, 'openai-completions'), undefined);
  assert.equal(authoritativeProviderUsage({ type: 'response.done', usage }, true, 'openai-codex-responses'), undefined);
});
for (const invalid of ['nonterminal', 'malformed', 'misplaced'] as const) {
  test(`native ${invalid} usage stays unknown and cannot release its reservation`, async () => {
    let forwarded = 0;
    const usage = { input_tokens: invalid === 'malformed' ? '100' : 100, output_tokens: 20, input_tokens_details: { cached_tokens: 20 } };
    const frame = { type: invalid === 'nonterminal' ? 'response.created' : 'response.done', response: { model: 'gpt-6.1-sol', ...(invalid === 'misplaced' ? {} : { usage }) }, ...(invalid === 'misplaced' ? { usage } : {}) };
    const runtime = await nativeBoundary((incoming, outgoing) => {
      incoming.resume(); forwarded++;
      outgoing.writeHead(200, { 'content-type': 'text/event-stream', 'x-bench-request-id': String(incoming.headers['x-bench-request-id']) });
      outgoing.end(`data: ${JSON.stringify(frame)}\n\n`);
    }, 1.3);
    try {
      assert.equal((await post(runtime.socketPath, '/provider/v1/codex/responses', nativeBody)).status, 200);
      assert.equal((await post(runtime.socketPath, '/provider/v1/codex/responses', nativeBody)).status, 429);
      assert.equal(forwarded, 1);
      assert.equal(runtime.broker.events.find(event => event.type === 'provider_usage')?.data.costUsd, null);
      assert.ok(Number(runtime.broker.events.find(event => event.type === 'budget_exceeded')?.data.outstandingReservedUsd) >= 1.28);
      if (invalid === 'nonterminal') {
        assert.equal(runtime.broker.events.find(event => event.type === 'provider_usage')?.data.missingReason, 'stream-ended-without-terminal');
        assert.equal(runtime.broker.events.find(event => event.type === 'provider_response')?.data.terminal, false);
      }
    } finally { await runtime.close(); }
  });
}
test('native unknown usage retains the full output reservation and blocks subsequent account egress', async () => {
  let forwarded = 0;
  const runtime = await nativeBoundary((incoming, outgoing) => {
    incoming.resume(); forwarded++;
    outgoing.writeHead(200, { 'content-type': 'text/event-stream', 'x-bench-request-id': String(incoming.headers['x-bench-request-id']) });
    outgoing.end('data: {"type":"response.completed","response":{"model":"gpt-6.1-sol"}}\n\n');
  }, 1.3);
  try {
    assert.equal((await post(runtime.socketPath, '/provider/v1/codex/responses', nativeBody)).status, 200);
    assert.equal((await post(runtime.socketPath, '/provider/v1/codex/responses', nativeBody)).status, 429);
    assert.equal(forwarded, 1);
    const denied = runtime.broker.events.find(event => event.type === 'budget_exceeded' && event.data.kind === 'cost')!;
    assert.ok(Number(denied.data.outstandingReservedUsd) >= 1.28);
    assert.equal(runtime.broker.events.find(event => event.type === 'provider_usage')?.data.costUsd, null);
  } finally { await runtime.close(); }
});
test('native cancellation closes the upstream request and cannot settle missing usage as free success', { timeout: 5000 }, async () => {
  const upstreamClosed = Promise.withResolvers<void>();
  const runtime = await nativeBoundary((incoming, outgoing) => {
    incoming.resume(); outgoing.once('close', upstreamClosed.resolve);
    outgoing.writeHead(200, { 'content-type': 'text/event-stream', 'x-bench-request-id': String(incoming.headers['x-bench-request-id']) });
    outgoing.write('data: {"type":"response.created","response":{"model":"gpt-6.1-sol"}}\n\n');
  });
  try {
    const cancelled = Promise.withResolvers<void>();
    const client = request({ socketPath: runtime.socketPath, path: '/provider/v1/codex/responses', method: 'POST', headers: { authorization: 'Bearer synthetic-capability', 'content-type': 'application/json' } }, response => {
      response.once('data', () => { client.destroy(); response.destroy(); cancelled.resolve(); });
      response.on('error', () => { /* Deliberate downstream cancellation. */ });
    });
    client.on('error', () => { /* Deliberate downstream cancellation. */ }); client.end(JSON.stringify(nativeBody));
    await cancelled.promise; await upstreamClosed.promise; await runtime.broker.close();
    assert.equal(runtime.broker.events.find(event => event.type === 'provider_usage')?.data.costUsd, null);
    assert.equal(runtime.broker.events.find(event => event.type === 'provider_response')?.data.streamEnd, 'downstream-cancelled');
    assert.equal(runtime.broker.events.find(event => event.type === 'observation_complete')?.data.providerRequests, false);
  } finally { await runtime.close(); }
});
test('native account/transport errors are returned once without credential leakage, account fallback, or a complete observation', async () => {
  let forwarded = 0;
  const runtime = await nativeBoundary((incoming, outgoing) => {
    incoming.resume(); forwarded++;
    outgoing.writeHead(502, { 'content-type': 'application/json', 'x-bench-request-id': String(incoming.headers['x-bench-request-id']) });
    outgoing.end(JSON.stringify({ error: 'native_account_access_unavailable', detail: 'trusted-host-relay-capability' }));
  });
  try {
    const result = await post(runtime.socketPath, '/provider/v1/codex/responses', nativeBody);
    assert.equal(result.status, 502); assert.equal(forwarded, 1);
    assert.match(result.text, /native_account_access_unavailable/); assert.ok(!result.text.includes('trusted-host-relay-capability'));
    await runtime.broker.close();
    assert.equal(runtime.broker.events.find(event => event.type === 'provider_usage')?.data.costUsd, null);
    assert.equal(runtime.broker.events.find(event => event.type === 'observation_complete')?.data.providerRequests, false);
  } finally { await runtime.close(); }
});

test('native successful streaming responses use the Codex SSE contract even with generic JSON media type', async () => {
  const runtime = await nativeBoundary((incoming, outgoing) => {
    incoming.resume();
    outgoing.writeHead(200, { 'content-type': 'application/json', 'x-bench-request-id': String(incoming.headers['x-bench-request-id']) });
    outgoing.end('event: response.done\ndata: {"type":"response.done","response":{"model":"gpt-6.1-sol","usage":{"input_tokens":100,"output_tokens":20,"input_tokens_details":{"cached_tokens":20}}}}\n\n');
  });
  try {
    await post(runtime.socketPath, '/provider/v1/codex/responses', nativeBody);
    assert.equal(runtime.broker.events.some(event => event.type === 'safety_violation'), false);
    const usage = runtime.broker.events.find(event => event.type === 'provider_usage')!;
    assert.equal(usage.data.inputTokens, 100);
    assert.equal(usage.data.costUsd, 0.000362);
    const response = runtime.broker.events.find(event => event.type === 'provider_response')!;
    assert.equal(response.data.terminal, true);
    assert.equal(response.data.streamEnd, 'end');
  } finally { await runtime.close(); }
});

test('native SSE contract does not forgive malformed JSON frames under a generic media type', async () => {
  const runtime = await nativeBoundary((incoming, outgoing) => {
    incoming.resume();
    outgoing.writeHead(200, { 'content-type': 'application/json', 'x-bench-request-id': String(incoming.headers['x-bench-request-id']) });
    outgoing.end('data: {malformed}\n\n');
  });
  try {
    await assert.rejects(post(runtime.socketPath, '/provider/v1/codex/responses', nativeBody));
    assert.equal(runtime.broker.events.find(event => event.type === 'safety_violation')?.data.kind, 'uninspectable-provider-frame');
    assert.equal(runtime.broker.events.find(event => event.type === 'provider_usage')?.data.costUsd, null);
    assert.equal(runtime.broker.events.find(event => event.type === 'provider_response')?.data.terminal, false);
  } finally { await runtime.close(); }
});
