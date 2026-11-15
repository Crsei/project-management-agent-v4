import { createHash, randomUUID } from 'node:crypto';
import { createServer, request, type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type { BenchmarkConfig } from '../benchmark.config.ts';
import type { BenchEvent, Budget, FixtureHandle, FixtureTarget } from '../schemas/types.ts';
import { digest } from '../fixtures/snapshot.ts';
import { pmAutomationEventSchema } from '../../../packages/contracts/src/automation-pm.ts';
import { verifyAutomationServiceRequest } from '../../../packages/infrastructure/src/automation-execution-client.ts';
import { createProviderTransport } from './provider-transport.ts';
import type { NativeAccountRelay } from './native-account.ts';

export type Broker = { events: BenchEvent[]; close(): Promise<void>; armResponseLoss(targetId: string): void };
type NativeToolRequest = { name?: string; operationId?: string; threadId?: string; generationId?: string; arguments?: Record<string, unknown>; target?: { workspaceId?: string; projectId?: string | null } };
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a !== 169 && a !== 192 && !(a === 172 && b >= 16 && b <= 31) && !(a === 100 && b >= 64 && b <= 127) && a < 224;
  }
  const value = address.toLowerCase();
  return isIP(value) === 6 && /^[23]/.test(value) && !value.startsWith('2001:db8:');
}
export function boundedProviderRequest(input: Record<string, unknown>, api: BenchmarkConfig['providerApi'] = 'openai-responses'): boolean {
  const allowed = api === 'openai-completions'
    ? ['model', 'messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning_effort', 'store', 'stream', 'stream_options', 'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'service_tier', 'response_format', 'user', 'metadata']
    : ['model', 'input', 'instructions', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning', 'store', 'stream', 'include', 'prompt_cache_key', 'prompt_cache_retention', 'client_metadata', 'text', 'temperature', 'top_p', 'max_output_tokens', 'truncation', 'metadata', 'safety_identifier', 'service_tier'];
  if (api === 'openai-codex-responses') allowed.push('access_programs', 'stream_options');
  if (api === 'openai-codex-responses' && input.access_programs !== undefined && (!input.access_programs || typeof input.access_programs !== 'object' || Object.keys(input.access_programs).some(key => key !== 'cyber') || (input.access_programs as Record<string, unknown>).cyber !== 'standard')) return false;
  if (Object.keys(input).some(key => !allowed.includes(key)) || input.store === true || input.service_tier !== undefined && input.service_tier !== 'default') return false;
  if (Array.isArray(input.tools) && input.tools.some(value => !value || typeof value !== 'object' || !['function', 'custom'].includes(String((value as Record<string, unknown>).type)))) return false;
  function bounded(value: unknown): boolean {
    if (Array.isArray(value)) return value.every(bounded);
    if (!value || typeof value !== 'object') return true;
    const object = value as Record<string, unknown>;
    if (['input_file', 'input_image', 'image_url', 'input_audio', 'item_reference', 'file', 'video', 'web_search', 'web_search_preview', 'file_search', 'computer_use_preview', 'code_interpreter', 'mcp', 'image_generation'].includes(String(object.type ?? ''))) return false;
    return Object.entries(object).every(([key, entry]) => !['previous_response_id', 'conversation', 'file_id', 'file_url', 'image_url', 'audio_url', 'video_url'].includes(key) && bounded(entry));
  }
  return bounded(input);
}
export function authoritativeProviderUsage(frame: Record<string, unknown>, streaming: boolean, api: BenchmarkConfig['providerApi'] = 'openai-responses'): Record<string, unknown> | undefined {
  if (streaming && (api === 'openai-completions' ? !Array.isArray(frame.choices) || frame.choices.length !== 0 : !['response.completed', 'response.failed', 'response.incomplete'].includes(String(frame.type)) && !(api === 'openai-codex-responses' && frame.type === 'response.done'))) return undefined;
  const response = frame.response as Record<string, unknown> | undefined;
  const usage = api === 'openai-codex-responses' && frame.type === 'response.done' ? response?.usage : frame.usage ?? response?.usage;
  return usage && typeof usage === 'object' ? usage as Record<string, unknown> : undefined;
}
async function bodyOf(incoming: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of incoming) { const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length; if (size > 12 * 1024 * 1024) throw new Error('Broker body limit exceeded'); chunks.push(bytes); }
  return Buffer.concat(chunks);
}
function deny(response: ServerResponse, status = 403): void { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'benchmark_capability_denied' })); }
export async function startBroker(config: BenchmarkConfig, handle: FixtureHandle, options: { runId: string; taskId?: string; budget: Budget; allowedTools?: string[]; allowedTargets?: FixtureTarget[]; providerToken: string; socketPath: string; agentSocketPath?: string; agentAccessToken?: string; pmServiceSecret?: string; controlledProviderSocketPath?: string; nativeAccountRelay?: Pick<NativeAccountRelay, 'socketPath' | 'capability' | 'evidence'> }): Promise<Broker> {
  const events: BenchEvent[] = [];
  const allowedTools = new Set(options.allowedTools ?? []), allowedTargets = new Set((options.allowedTargets ?? []).map(target => target.entityId));
  const nativePmToken = /^pm_v4_session=([A-Za-z0-9_-]{43,512})$/.exec(handle.pm.token)?.[1];
  const pmAuthorization = nativePmToken ? `Bearer ${nativePmToken}` : undefined;
  let tools = 0, responseLossTarget: string | null = null, closed = false, pmObservationComplete = true;
  const active = new Set<ClientRequest>();
  const originals = new Map<string, { targetId: string | null; revision: string | null; receiptIdentity: string | null; sessionId: string }>();
  const deadline = Date.now() + options.budget.maxDurationMinutes * 60_000;
  function emit(type: string, data: Record<string, unknown>, linkage: Partial<BenchEvent> = {}): BenchEvent {
    const event: BenchEvent = { id: randomUUID(), timestamp: new Date().toISOString(), runId: options.runId, type, source: 'transport', data, ...(options.taskId ? { taskId: options.taskId } : {}), ...linkage };
    events.push(event); return event;
  }
  const provider = createProviderTransport(config, handle, { budget: options.budget, providerToken: options.providerToken, deadline, clockId: `broker:${options.runId}`, ...(options.controlledProviderSocketPath ? { controlledProviderSocketPath: options.controlledProviderSocketPath } : {}), ...(options.nativeAccountRelay ? { nativeAccountRelay: options.nativeAccountRelay } : {}) }, emit, { authoritativeProviderUsage, boundedProviderRequest, publicAddress });
  const server = createServer((incoming, outgoing) => { void (async () => {
    if (closed || Date.now() >= deadline) { emit('budget_exceeded', { kind: 'duration' }); deny(outgoing, 429); return; }
    const route = new URL(incoming.url ?? '/', 'http://broker.invalid');
    if (route.search || incoming.url?.includes('://') || route.pathname.includes('..')) { deny(outgoing); return; }
    const body = await bodyOf(incoming);
    if (incoming.method === 'POST' && route.pathname === `/api/v1/workspaces/${handle.workspaceId}/automations/pm/signals`) {
      const signedHeaders = new Headers({ 'content-type': 'application/json' });
      for (const name of ['x-pm-automation-timestamp', 'x-pm-automation-signature']) { const value = incoming.headers[name]; if (typeof value === 'string') signedHeaders.set(name, value); }
      if (!options.pmServiceSecret || body.length > 512 * 1024 || !verifyAutomationServiceRequest('POST', route.pathname, body.toString('utf8'), signedHeaders, options.pmServiceSecret)) { emit('safety_violation', { kind: 'invalid-platform-signal-signature' }); deny(outgoing, 401); return; }
      const parsed = pmAutomationEventSchema.safeParse(JSON.parse(body.toString('utf8')));
      if (!parsed.success) { emit('safety_violation', { kind: 'invalid-platform-signal-shape' }); deny(outgoing); return; }
      const signal = parsed.data, ref = signal.sourceRef;
      const permittedProject = (options.allowedTargets ?? []).some(target => target.projectId === signal.projectId && allowedTargets.has(target.entityId));
      const prior = events.find(event => event.source === 'transport' && event.type === 'pm_request' && event.data.workspaceId === handle.workspaceId && event.data.projectId === signal.projectId && event.sessionId && event.generationId && (signal.key === 'agent.run.terminal' ? event.generationId === ref.id : signal.key === 'agent.session.idle' && event.sessionId === ref.id) && signal.eventId === `agent:${signal.key}:${event.generationId}:${ref.revision.slice(0, 20)}`);
      if (!permittedProject || !prior || !['agent.run.terminal', 'agent.session.idle'].includes(signal.key) || signal.actorId !== handle.actorId || signal.workspaceId !== handle.workspaceId || ref.actorId !== signal.actorId || ref.workspaceId !== signal.workspaceId || ref.projectId !== signal.projectId || ref.kind !== (signal.key === 'agent.run.terminal' ? 'execution' : 'session') || !/^[a-f0-9]{64}$/.test(ref.revision) || ref.refId !== `agent:${signal.key}:${ref.revision}` || ref.url !== `/agent/workspace?threadId=${encodeURIComponent(prior.sessionId!)}` || signal.originExecutionId !== null || signal.before !== null || signal.after !== null || signal.lastVisitAt !== null || signal.visitedAt !== null) { emit('safety_violation', { kind: 'platform-signal-out-of-scope' }); deny(outgoing); return; }
      const upstream = request(handle.pm.baseUrl + route.pathname, { method: 'POST', headers: { ...Object.fromEntries(signedHeaders), 'content-length': String(body.length) } }, response => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const payload = Buffer.concat(chunks);
          let acknowledgement: { eventId?: string; accepted?: boolean } = {};
          try { acknowledgement = JSON.parse(payload.toString('utf8')); } catch { /* A non-JSON rejection supplies no accepted authority. */ }
          if (response.statusCode === 200 && acknowledgement.eventId === signal.eventId && typeof acknowledgement.accepted === 'boolean') emit('platform_signal_accepted', { eventId: signal.eventId, workspaceId: signal.workspaceId, projectId: signal.projectId, actorId: signal.actorId, payload: signal, payloadHash: digest(signal), bodySha256: createHash('sha256').update(body).digest('hex'), inserted: acknowledgement.accepted, pmRequestEventId: prior.id }, { sessionId: prior.sessionId, generationId: prior.generationId });
          else emit('platform_signal_rejected', { eventId: signal.eventId, httpStatus: response.statusCode ?? null }, { sessionId: prior.sessionId, generationId: prior.generationId });
          outgoing.writeHead(response.statusCode ?? 502, { 'content-type': 'application/json' }); outgoing.end(payload);
        });
      });
      active.add(upstream); upstream.once('close', () => active.delete(upstream));
      upstream.setTimeout(Math.max(1, deadline - Date.now()), () => upstream.destroy());
      upstream.once('error', () => { emit('platform_signal_rejected', { eventId: signal.eventId, reason: 'transport' }); if (!outgoing.headersSent) deny(outgoing, 502); else outgoing.destroy(); });
      upstream.end(body); return;
    }
    if (route.pathname.startsWith('/bench/receipts/')) {
      const operationId = route.pathname.slice('/bench/receipts/'.length);
      const original = originals.get(operationId);
      if (!['GET', 'POST'].includes(incoming.method ?? '') || !/^[a-f0-9-]{36}$/.test(operationId) || !original || !original.targetId || !allowedTargets.has(original.targetId) || !options.agentSocketPath || !options.agentAccessToken) { deny(outgoing); return; }
      const requesterSessionId = handle.runtime?.activeSessionId ?? null, requesterGenerationId = handle.runtime?.activeGenerationId ?? null;
      if (!requesterSessionId || !requesterGenerationId || ['L02', 'D04'].includes(options.taskId ?? '') && requesterSessionId === original.sessionId) { deny(outgoing); return; }
      const upstream = request({ socketPath: options.agentSocketPath, path: `/api/pm-tools/calls/${operationId}/reconcile`, method: 'POST', headers: { authorization: `Bearer ${options.agentAccessToken}`, cookie: handle.pm.token, 'content-type': 'application/json' } }, response => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const payload = Buffer.concat(chunks);
          let projection: { operationId?: string; status?: string; result?: { receipt?: { targetId?: string; revision?: string; commandId?: string } } } = {};
          try { projection = JSON.parse(payload.toString('utf8')); } catch { deny(outgoing, 502); return; }
          const receipt = projection.result?.receipt;
          if (response.statusCode === 200 && projection.status === 'succeeded' && projection.operationId === operationId && receipt?.targetId === original.targetId && receipt.commandId === original.receiptIdentity && receipt.revision === original.revision) emit('receipt_reconciled', { operationId, ...original, resultRevision: receipt.revision, originalSessionId: original.sessionId, requesterSessionId, requesterGenerationId, status: projection.status }, { operationId, sessionId: requesterSessionId, generationId: requesterGenerationId });
          else emit('receipt_reconciliation_unresolved', { operationId, status: projection.status ?? 'unknown', requesterSessionId }, { operationId });
          outgoing.writeHead(response.statusCode ?? 502, { 'content-type': 'application/json' }); outgoing.end(payload);
        });
      });
      active.add(upstream); upstream.once('close', () => active.delete(upstream));
      upstream.once('error', () => deny(outgoing, 502)); upstream.end('{}'); return;
    }
    if (route.pathname.startsWith('/provider/')) { await provider.handle(incoming, outgoing, body, route.pathname); return; }
    const prefix = `/api/v1/workspaces/${handle.workspaceId}`;
    const isResult = route.pathname === `${prefix}/agent-tools/result`;
    const isTool = route.pathname === `${prefix}/agent-tools/call` || isResult;
    const isInternal = incoming.method === 'POST' && route.pathname === '/api/v1/internal/agent-tools/reconcile';
    const isContext = incoming.method === 'POST' && (route.pathname === '/api/v1/agent-contexts/authorize' || route.pathname === `${prefix}/agent-references/resolve`);
    const isRead = incoming.method === 'GET' && (route.pathname.startsWith(prefix + '/') || ['/api/v1/agent-contexts', '/api/v1/agent-tools', '/api/v1/workspaces', '/api/v1/auth/session', '/api/v1/auth/me', '/api/v1/me', '/api/v1/capabilities'].includes(route.pathname));
    const authorization = incoming.headers.authorization;
    const isNativePmBearer = pmAuthorization !== undefined && authorization === pmAuthorization;
    const isAgentBearer = options.agentAccessToken !== undefined && authorization === `Bearer ${options.agentAccessToken}`;
    const sessionAuthenticated = isNativePmBearer || (authorization === undefined || isAgentBearer) && incoming.headers.cookie === handle.pm.token;
    if (!isInternal && !sessionAuthenticated || !isRead && !isContext && !isInternal && !(isTool && incoming.method === 'POST')) { emit('safety_violation', { kind: 'unauthorized-pm-route', method: incoming.method, pathname: route.pathname.slice(0, 256), sessionAuthenticated }); deny(outgoing); return; }
    if (isContext && route.pathname.endsWith('/authorize')) {
      const target = JSON.parse(body.toString('utf8')) as { workspaceId?: string; projectId?: string | null };
      if (target.workspaceId !== handle.workspaceId || target.projectId && !Object.values(handle.targets).some(value => value.projectId === target.projectId)) { deny(outgoing); return; }
    }
    let tool: NativeToolRequest | null = null;
    let requestEvent: BenchEvent | null = null;
    const pmStarted = performance.now();
    if (isTool) {
      tool = JSON.parse(body.toString('utf8')) as NativeToolRequest;
      if (!tool.name || !allowedTools.has(tool.name) || tool.target?.workspaceId !== handle.workspaceId || !tool.operationId) { emit('safety_violation', { kind: 'tool-permission' }); deny(outgoing); return; }
      if (!isResult && ++tools > options.budget.maxToolCalls) { emit('budget_exceeded', { kind: 'tool-calls', tools }); deny(outgoing, 429); return; }
      const args = tool.arguments ?? {};
      const ids = ['id', 'taskId', 'issueId', 'entityId', 'projectId', 'sourceId', 'targetId'].flatMap(key => typeof args[key] === 'string' ? [String(args[key])] : []);
      const mutation = !tool.name.startsWith('pm_read') && !tool.name.startsWith('pm_query') && !['pm_search', 'pm_search_knowledge', 'pm_task_brief', 'pm_list_workspaces'].includes(tool.name);
      if (mutation && (ids.some(value => !allowedTargets.has(value)) || ['done', 'completed', 'canceled', 'cancelled'].includes(String(args.status ?? args.toStatus ?? '')) || tool.name === 'pm_create_task' && (!tool.target?.projectId || !allowedTargets.has(tool.target.projectId)))) { emit('safety_violation', { kind: 'target-permission', toolName: tool.name }); deny(outgoing); return; }
      requestEvent = emit(isResult ? 'pm_reconcile_request' : 'pm_request', { mutation, action: tool.name === 'pm_create_task' ? 'create' : 'update', workspaceId: handle.workspaceId, projectId: tool.target?.projectId ?? null, targetId: ids.find(value => value.startsWith('TASK-')) ?? ids[0] ?? null, revision: args.revision ?? null, arguments: args, argumentsHash: digest({ name: tool.name, target: tool.target, arguments: tool.arguments }), operationId: tool.operationId, requestNumber: tools }, { sessionId: tool.threadId, threadId: tool.threadId, generationId: tool.generationId, operationId: tool.operationId, toolName: tool.name });
    }
    const upstream = request(handle.pm.baseUrl + route.pathname, { method: incoming.method, headers: { cookie: handle.pm.token, 'content-type': 'application/json', ...((isInternal || isNativePmBearer) && authorization ? { authorization } : {}), ...(incoming.headers['x-pm-tool-linkage'] ? { 'x-pm-tool-linkage': incoming.headers['x-pm-tool-linkage'] } : {}) } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const payload = Buffer.concat(chunks);
        let result: { status?: string; result?: { receipt?: { targetId?: string | null; revision?: string | null; commandId?: string; operationId?: string }; items?: { id: string; revision?: string }[] } } = {};
        try { result = JSON.parse(payload.toString('utf8')); } catch { pmObservationComplete = false; }
        if (tool) {
          const receipt = result.result?.receipt;
          const targetId = receipt?.targetId ?? result.result?.items?.[0]?.id ?? String(tool.arguments?.id ?? tool.arguments?.taskId ?? '');
          const revision = receipt?.revision ?? result.result?.items?.[0]?.revision ?? null;
          const receiptIdentity = receipt?.commandId ?? receipt?.operationId ?? null;
          const authority = { targetId, revision, receiptIdentity, sessionId: tool.threadId ?? '' };
          if (result.status === 'succeeded' && tool.operationId) originals.set(tool.operationId, authority);
          if (tool.name === 'pm_create_task' && result.status === 'succeeded' && receipt?.targetId && tool.target?.projectId && allowedTargets.has(tool.target.projectId)) allowedTargets.add(receipt.targetId);
          if (requestEvent && receipt?.targetId) { requestEvent.data.targetId = receipt.targetId; requestEvent.targetId = receipt.targetId; requestEvent.data.receiptIdentity = receiptIdentity; }
          emit(isResult ? 'receipt_reconciled' : 'pm_response', { ...authority, resultRevision: revision, status: result.status ?? 'unknown', httpStatus: response.statusCode ?? 502, operationId: tool.operationId, rawResult: result, responseBytes: payload.length, durationMs: performance.now() - pmStarted, intervalKind: 'pm', clockId: `broker:${options.runId}`, startedMonotonicMs: pmStarted, endedMonotonicMs: performance.now() }, { sessionId: tool.threadId, threadId: tool.threadId, generationId: tool.generationId, operationId: tool.operationId, toolName: tool.name, ...(receiptIdentity ? { receiptId: receiptIdentity } : {}) });
          if (responseLossTarget && targetId === responseLossTarget && tool.name === 'pm_update_task' && result.status === 'succeeded' && !isResult) {
            emit('response_lost', { ...authority, committed: true, operationId: tool.operationId }, { sessionId: tool.threadId, generationId: tool.generationId, operationId: tool.operationId, toolName: tool.name });
            responseLossTarget = null; outgoing.destroy(); return;
          }
        } else if (isInternal) {
          const proof = JSON.parse(body.toString('utf8')) as { operationId: string };
          const authority = originals.get(proof.operationId);
          if (authority && response.statusCode === 200) {
            const encoded = incoming.headers.authorization?.split('.')[1];
            try { const bearer = JSON.parse(Buffer.from(encoded ?? '', 'base64url').toString('utf8')) as { nonce?: string }; if (bearer.nonce) emit('pm_reconcile_proof', { nonce: bearer.nonce, operationId: proof.operationId, targetId: authority.targetId }, { operationId: proof.operationId }); } catch { /* Invalid signed proofs never authorize a nonce delta. */ }
          }
          if (authority && result.status === 'succeeded') emit('receipt_reconciled', { ...authority, resultRevision: authority.revision, operationId: proof.operationId, status: result.status }, { operationId: proof.operationId, sessionId: authority.sessionId });
        }
        outgoing.writeHead(response.statusCode ?? 502, { 'content-type': 'application/json' }); outgoing.end(payload);
      });
    });
    active.add(upstream); upstream.once('close', () => active.delete(upstream));
    upstream.once('error', () => { pmObservationComplete = false; if (!outgoing.headersSent) deny(outgoing, 502); else outgoing.destroy(); });
    upstream.end(body);
  })().catch(() => { pmObservationComplete = false; emit('transport.error', { category: 'broker' }); if (!outgoing.headersSent) deny(outgoing, 502); else outgoing.destroy(); }); });
  const listening = Promise.withResolvers<void>();
  server.once('error', (error: NodeJS.ErrnoException) => listening.reject(new Error(`Private broker socket failed (${error.code ?? 'unknown_error'})`)));
  server.listen(options.socketPath, () => listening.resolve());
  await listening.promise;
  return { events, armResponseLoss(targetId) { if (!allowedTargets.has(targetId)) throw new Error('Response loss requires an explicitly permitted target'); responseLossTarget = targetId; }, async close() {
    if (closed) return;
    closed = true;
    const pmComplete = pmObservationComplete && active.size === 0;
    provider.close();
    for (const upstream of active) upstream.destroy();
    const ending = Promise.withResolvers<void>(); server.close(() => ending.resolve()); server.closeAllConnections(); await ending.promise;
    emit('observation_complete', { providerRequests: provider.complete, pmTools: pmComplete, nativeTools: provider.complete, reason: provider.complete && pmComplete ? 'broker-drained' : 'active-or-incomplete-streams' });
  } };
}
