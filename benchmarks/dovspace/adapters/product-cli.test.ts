import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BenchEvent, FixtureHandle, PrepareAdapterInput } from '../schemas/types.ts';
import { stageProductSource, type StagedProductSource } from '../isolation/source.ts';
import { ProductCliAdapter } from './product-cli.ts';

type Json = Record<string, unknown>;
let root: string, source: StagedProductSource;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'dovspace-native-cli-test-'));
  source = await stageProductSource(path.join(root, 'product-source'));
});
after(async () => { await rm(root, { recursive: true, force: true }); });

/** Actual staged product CLI against a controlled HTTP peer, not real product/model acceptance. */
async function fixture(options: { loseSubmit?: boolean; running?: boolean; unavailableContext?: boolean; mismatchGeneration?: boolean; mismatchAcceptance?: boolean; beforeSubmit?: (body: Json) => void | Promise<void>; provider?: 'codex' | 'omp'; omitModel?: boolean; anonymous?: boolean; loseStop?: boolean } = {}) {
  const directory = path.join(root, `fixture-${crypto.randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  const pmToken = 'p'.repeat(43), agentToken = 'a'.repeat(43), cookie = `agent_v4_access=${'b'.repeat(64)}`;
  const requests: { route: string; method: string; headers: IncomingMessage['headers']; body: Json }[] = [];
  const threads = new Map<string, Json>(), generations = new Map<string, Json>();
  const provider = options.provider ?? 'codex';
  let configuration: Json = { instanceId: provider, driver: provider, revision: 1, config: {}, environment: [], models: [], customModels: [], modelPreferences: {} };
  const reply = (response: ServerResponse, value: unknown, status = 200): void => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  const server = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json : {};
    const route = new URL(request.url!, 'http://127.0.0.1').pathname;
    requests.push({ route, method: request.method!, headers: request.headers, body });
    if (route === '/api/access') {
      if (request.method === 'POST') {
        if (body.token !== agentToken) return reply(response, { authorized: false }, 401);
        response.setHeader('set-cookie', `${cookie}; Path=/; HttpOnly; SameSite=Strict`);
      }
      return reply(response, { authorized: request.method === 'POST' || request.headers.cookie === cookie, configured: !options.anonymous, approvalMode: 'ask' });
    }
    if (!request.headers.cookie?.includes(cookie)) return reply(response, { error: 'independent Agent cookie required' }, 401);
    if (route === '/api/providers') {
      if (request.method === 'POST') configuration = { ...configuration, ...body, revision: 2 };
      return reply(response, request.method === 'POST' ? configuration : { providers: provider === 'omp' && configuration.revision === 1 ? [] : [configuration], drivers: [] });
    }
    if (route === `/api/providers/${provider}`) { configuration = { ...configuration, ...body, revision: Number(configuration.revision) + 1 }; return reply(response, configuration); }
    if (route === `/api/providers/${provider}/test`) return reply(response, { ok: true, nativeSessionReady: true, models: options.omitModel ? [] : [{ id: provider === 'omp' ? 'bench/fixed-model' : 'fixed-model' }] });
    if (route === '/api/agent-workspaces/open') return reply(response, { workspace: { id: 'workspace-original', revision: 1, path: '/workspace', status: 'available' } });
    if (route.startsWith('/api/chat/') || route === '/api/chat') {
      if (request.headers.authorization !== `Bearer ${pmToken}` || !request.headers.cookie.includes(`pm_v4_session=${pmToken}`)) return reply(response, { error: 'native PM token required' }, 401);
    }
    if (route === '/api/chat/threads') {
      const thread = { id: body.id, revision: 1, executionSelection: body.executionSelection };
      threads.set(String(body.id), thread); return reply(response, { thread });
    }
    if (route === '/api/chat') {
      const input = (body.messages as Json[])[0]!;
      const generation = { id: `generation-${generations.size + 1}`, threadId: body.id, inputMessageId: input.id, status: options.running ? 'running' : 'completed', messageId: `assistant-${generations.size + 1}` };
      generations.set(generation.id, generation);
      await options.beforeSubmit?.(body);
      if (options.loseSubmit) { request.socket.destroy(); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'x-resumable-stream-id': generation.id, 'x-accepted-input-message-id': options.mismatchAcceptance ? 'unrelated-input' : String(input.id) });
      response.end('data: {"type":"finish"}\n\ndata: [DONE]\n\n'); return;
    }
    const output = /^\/api\/chat\/generations\/([^/]+)\/output$/.exec(route);
    if (output) {
      const generation = generations.get(output[1]!)!;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ kind: 'snapshot', snapshot: { generationId: generation.id, threadId: generation.threadId, sequence: 1, status: generation.status, items: [{ id: 'tool-original', type: 'command_execution', status: 'completed', title: 'controlled command', exitCode: 0 }] } })}\n\n`); return;
    }
    const threadRoute = /^\/api\/chat\/threads\/([^/]+)(?:\/(.*))?$/.exec(route);
    if (threadRoute) {
      const id = threadRoute[1]!, action = threadRoute[2], thread = threads.get(id)!;
      if (!action) {
        if (request.method === 'PUT') { Object.assign(thread, body); thread.revision = Number(thread.revision) + 1; }
        return reply(response, { thread });
      }
      if (action === 'generations') return reply(response, { generations: [...generations.values()].filter(generation => generation.threadId === id).map(generation => options.mismatchGeneration ? { ...generation, threadId: 'other-session' } : generation) });
      if (action === 'execution') return reply(response, { threadId: id, source: 'controlled-peer', status: 'available' });
      if (action.startsWith('messages/')) return reply(response, options.unavailableContext ? { error: 'not available' } : { threadId: id, messageId: action.split('/')[1], references: [], context: 'product projection' }, options.unavailableContext ? 403 : 200);
      if (action === 'cancel') {
        const generation = generations.get(String(body.generationId))!;
        generation.status = 'cancelled';
        if (options.loseStop) { request.socket.destroy(); return; }
        return reply(response, { cancelled: true });
      }
    }
    if (route.startsWith('/api/usage/threads/')) return reply(response, { threadId: route.split('/').at(-1), inputTokens: null, outputTokens: null, costUsd: null });
    return reply(response, { error: `unhandled controlled route ${route}` }, 404);
  })().catch(() => { if (!response.headersSent) reply(response, { error: 'controlled peer failure' }, 500); else response.destroy(); }); });
  const listening = Promise.withResolvers<void>(); server.listen(0, '127.0.0.1', listening.resolve); await listening.promise;
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const handle = {
    fixtureId: 'fixture', fixtureVersion: 'test', root: directory, publicRoot: path.join(directory, 'public'), authorityRoot: path.join(directory, 'authority'), agentDataRoot: path.join(directory, 'agent'),
    workspaceId: 'workspace', actorId: 'actor', targets: {}, productSource: { root: source.root, manifest: source.manifest }, pm: { baseUrl: origin, token: `pm_v4_session=${pmToken}` },
    isolation: { backend: 'docker', verified: true, containerId: 'controlled-test-only', networkId: 'none', checks: [], proofDigest: 'not-isolation-acceptance' },
    runtime: { agentBaseUrl: origin, agentAccessToken: agentToken, pmCookie: `pm_v4_session=${pmToken}`, workingDirectory: '/workspace', environment: {}, containerId: 'controlled-test-only', isolationVerified: true, auditEvents: [], environmentHash: 'controlled-test-only', environmentEvidence: { sourceHash: source.manifest.sourceHash, sourceFileCount: source.manifest.files.length, lockfileHash: '', imageIds: {}, nodeVersion: process.versions.node, isolationPolicy: {} }, providerConfig: { instanceId: provider, driver: provider, config: { setupMode: 'existing' }, environment: [] } },
  } as unknown as FixtureHandle;
  const input: PrepareAdapterInput = { runId: 'run', fixtureId: handle.fixtureId, arm: 'raw', fixture: handle, provider, model: 'fixed-model', modelOptions: { reasoningEffort: 'high' }, allowedTools: ['read', 'pm_read'], allowedTargets: [], budget: { maxDurationMinutes: 1, maxModelCalls: 5, maxToolCalls: 10, maxCostUsd: 1 } };
  const adapter = new ProductCliAdapter('raw');
  return { adapter, input, handle, requests, threads, generations, async close() {
    try { await adapter.dispose(); }
    finally { server.closeAllConnections(); const closed = Promise.withResolvers<void>(); server.close(() => closed.resolve()); await closed.promise; await rm(directory, { recursive: true, force: true }); }
  } };
}

async function drain(adapter: ProductCliAdapter, sessionId: string): Promise<BenchEvent[]> {
  const events: BenchEvent[] = []; for await (const event of adapter.observe(sessionId)) events.push(event); return events;
}

test('actual staged CLI uses separate native identities and returns correlated projections without billing/task-success inference', async () => {
  const current = await fixture({ unavailableContext: true });
  try {
    await current.adapter.prepare(current.input);
    const started = await current.adapter.start({ taskId: 'K02', instruction: 'Read original sources.' });
    const events = await drain(current.adapter, started.sessionId);
    assert.deepEqual(current.adapter.sessionIdentity(started.sessionId), { sessionId: started.sessionId, generationId: 'generation-1' });
    assert.equal(events.some(event => event.type === 'generation_status' && event.data.status === 'completed'), true);
    assert.equal(events.some(event => event.type === 'native_output' && event.generationId === 'generation-1'), true);
    await assert.rejects(drain(current.adapter, started.sessionId), /one consumer/);
    const audits = current.handle.runtime!.auditEvents;
    const unavailable = audits.find(event => event.type === 'cli_observation' && event.data.kind === 'message-context');
    assert.equal(unavailable?.data.collectionStatus, 'unavailable'); assert.equal(unavailable?.data.value, null);
    assert.equal(unavailable?.generationId, 'generation-1'); assert.equal(typeof unavailable?.data.messageId, 'string');
    assert.equal(audits.some(event => event.type === 'cli_observation' && event.data.kind === 'usage'), true);
    assert.equal(audits.some(event => event.type === 'usage' || event.type === 'provider_usage'), false);
    assert.equal(audits.filter(event => event.type === 'cli_command_interval').every(event => typeof event.data.durationMs === 'number' && Array.isArray(event.data.command) && event.data.command.length <= 3), true);
    const attested = audits.find(event => event.type === 'cli_source_attestation')!.data.productSource as Json;
    assert.equal(attested.sourceHash, source.manifest.sourceHash); assert.match(String(attested.cliSha256), /^[a-f0-9]{64}$/);
    const providers = current.requests.filter(request => request.route.startsWith('/api/providers'));
    assert.equal(providers.every(request => !request.headers.authorization && request.headers.cookie === `agent_v4_access=${'b'.repeat(64)}`), true);
    const submitted = current.requests.find(request => request.route === '/api/chat')!;
    assert.equal(submitted.headers.authorization, `Bearer ${'p'.repeat(43)}`);
    const evidence = JSON.stringify([...audits, ...events]);
    assert.equal(evidence.includes('p'.repeat(43)), false); assert.equal(evidence.includes('a'.repeat(43)), false); assert.equal(evidence.includes('b'.repeat(64)), false);
    await current.adapter.dispose();
  } finally { await current.close(); }
});

test('actual CLI has a pending exact Session admission before send and validates acceptance before releasing it', async () => {
  const submitted = Promise.withResolvers<Json>(), release = Promise.withResolvers<void>();
  const current = await fixture({ beforeSubmit(body) { submitted.resolve(body); return release.promise; } });
  let starting: Promise<{ sessionId: string }> | undefined;
  try {
    await current.adapter.prepare(current.input);
    starting = current.adapter.start({ taskId: 'K02', instruction: 'One exact original input.' });
    const body = await submitted.promise, runtime = current.handle.runtime!, admission = runtime.activeGenerationAdmission!;
    assert.ok(admission); assert.equal(admission.sessionId, body.id); assert.equal(runtime.activeGenerationId, undefined);
    release.resolve();
    const started = await starting;
    assert.equal(await admission.accepted, 'generation-1');
    assert.equal(runtime.activeGenerationId, 'generation-1');
    assert.deepEqual(current.adapter.sessionIdentity(started.sessionId), { sessionId: body.id, generationId: 'generation-1' });
    await drain(current.adapter, started.sessionId);
    assert.equal(current.requests.filter(request => request.route === '/api/chat').length, 1);
  } finally { release.resolve(); await starting?.catch(() => {}); await current.close(); }
});

test('CLI acceptance for a different input retains cleanup identity but never grants native egress authority', async () => {
  const submitted = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const current = await fixture({ mismatchAcceptance: true, beforeSubmit() { submitted.resolve(); return release.promise; } });
  let rejected: Promise<void> | undefined;
  try {
    await current.adapter.prepare(current.input);
    rejected = assert.rejects(current.adapter.start({ taskId: 'L02', instruction: 'Original message only.' }), /outcome unknown/);
    await submitted.promise;
    const runtime = current.handle.runtime!, admission = runtime.activeGenerationAdmission!;
    assert.ok(admission); assert.equal(runtime.activeGenerationId, undefined);
    release.resolve(); await rejected;
    assert.equal(await admission.accepted, null);
    assert.equal(runtime.activeGenerationAdmission, undefined); assert.equal(runtime.activeGenerationId, undefined);
    assert.equal(admission.signal.aborted, true);
    assert.equal(current.requests.filter(request => request.route === '/api/chat').length, 1);
    await current.adapter.dispose();
    assert.equal(current.requests.filter(request => request.route === '/api/chat').length, 1);
  } finally { release.resolve(); await rejected; await current.close(); }
});

test('lost native send response retains original identities and never resends or creates a replacement Session', async () => {
  const current = await fixture({ loseSubmit: true });
  try {
    await current.adapter.prepare(current.input);
    await assert.rejects(current.adapter.start({ taskId: 'L02', instruction: 'Mutate exactly once.' }), /outcome unknown/);
    await assert.rejects(current.adapter.start({ taskId: 'L02', instruction: 'Do not replay.' }), /unknown outcomes/);
    assert.equal(current.requests.filter(request => request.route === '/api/chat').length, 1);
    assert.equal(current.requests.filter(request => request.route === '/api/chat/threads').length, 1);
    const unknown = current.handle.runtime!.auditEvents.find(event => event.type === 'cli_mutation_unknown');
    assert.equal(unknown?.data.replayed, false);
    assert.equal(current.handle.runtime!.activeGenerationAdmission, undefined);
    assert.equal(current.handle.runtime!.activeGenerationId, undefined);
    const sent = current.requests.find(request => request.route === '/api/chat')!.body;
    assert.equal(unknown?.data.idempotencyKey, sent.idempotencyKey);
    assert.equal(unknown?.data.messageId, (sent.messages as Json[])[0]!.id);
    await current.adapter.dispose();
    assert.equal(current.requests.filter(request => request.route === '/api/chat').length, 1);
  } finally { await current.close(); }
});

test('fresh resume requires original interruption acknowledgement, exact stop is not replayed after response loss', async () => {
  const current = await fixture({ running: true, loseStop: true });
  try {
    await current.adapter.prepare(current.input);
    const first = await current.adapter.start({ taskId: 'L04', instruction: 'first user input' });
    const firstEvents = drain(current.adapter, first.sessionId);
    await assert.rejects(current.adapter.resume({ priorSessionId: first.sessionId, instruction: 'forbidden early resume' }), /acknowledgement/);
    await current.adapter.interrupt(first.sessionId, 'controlled checkpoint');
    const observed = await firstEvents;
    assert.equal(observed.some(event => event.type === 'interrupt_acknowledged' && event.data.wasActive === true), true);
    await current.adapter.interrupt(first.sessionId, 'same original acknowledgement');
    const second = await current.adapter.resume({ priorSessionId: first.sessionId, instruction: 'Read current sources in a new Session.' });
    assert.notEqual(second.sessionId, first.sessionId);
    const secondEvents = drain(current.adapter, second.sessionId);
    await current.adapter.interrupt(second.sessionId, 'controlled cleanup'); await secondEvents;
    assert.equal(current.requests.filter(request => request.route === `/api/chat/threads/${first.sessionId}/cancel`).length, 1);
    const sends = current.requests.filter(request => request.route === '/api/chat');
    assert.equal(sends.length, 2); assert.equal((sends[1]!.body.messages as Json[]).length, 1);
    assert.notEqual(sends[0]!.body.idempotencyKey, sends[1]!.body.idempotencyKey);
    assert.equal(current.requests.some(request => /\/(continue|fork|native-fork)$/.test(request.route)), false);
  } finally { await current.close(); }
});

test('unconfigured operator authentication and absent exact OMP model fail closed before any Session or send', async () => {
  for (const options of [{ anonymous: true }, { provider: 'omp' as const, omitModel: true }]) {
    const current = await fixture(options);
    try {
      await assert.rejects(current.adapter.prepare(current.input), options.anonymous ? /projection unavailable/ : /not discovered/);
      assert.equal(current.requests.some(request => request.route.startsWith('/api/chat')), false);
    } finally { await current.close(); }
  }
});

test('mismatched generation association is retained in observations but cannot become a success or resume acknowledgement', async () => {
  const current = await fixture({ mismatchGeneration: true });
  try {
    await current.adapter.prepare(current.input);
    const started = await current.adapter.start({ taskId: 'K02', instruction: 'original' });
    const events = await drain(current.adapter, started.sessionId);
    assert.equal(events.some(event => event.type === 'adapter_error' && String(event.data.message).includes('mismatch')), true);
    assert.equal(events.some(event => event.type === 'generation_status'), false);
    await assert.rejects(current.adapter.interrupt(started.sessionId, 'must not stop another Session'), /mismatch/);
    await assert.rejects(current.adapter.resume({ priorSessionId: started.sessionId, instruction: 'forbidden' }), /acknowledgement/);
    assert.equal(current.requests.some(request => request.route.endsWith('/cancel')), false);
    await assert.rejects(current.adapter.dispose(), /cleanup incomplete/);
  } finally { await current.close().catch(error => assert.match(String(error), /cleanup incomplete/)); }
});

test('missing immutable stage or nonisolated endpoint is rejected before any CLI child connects', async () => {
  const current = await fixture();
  try {
    Reflect.deleteProperty(current.handle, 'productSource');
    await assert.rejects(current.adapter.prepare(current.input), /immutable product source stage/);
    assert.equal(current.requests.length, 0);
    const unsafe = new ProductCliAdapter('raw');
    current.handle.runtime!.agentBaseUrl = 'http://127.0.0.1:4325';
    await assert.rejects(unsafe.prepare(current.input), /non-production/);
    assert.equal(current.requests.length, 0);
  } finally { await current.close(); }
});
