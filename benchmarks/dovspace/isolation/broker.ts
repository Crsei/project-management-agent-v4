import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createServer, request, type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import type { BenchmarkConfig } from '../benchmark.config.ts';
import type { BenchEvent, Budget, FixtureHandle, FixtureTarget } from '../schemas/types.ts';
import { digest } from '../fixtures/snapshot.ts';
import { pmAutomationEventSchema } from '../../../packages/contracts/src/automation-pm.ts';
import { verifyAutomationServiceRequest } from '../../../packages/infrastructure/src/automation-execution-client.ts';

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
export function boundedProviderRequest(input: Record<string, unknown>): boolean {
  const allowed = ['model', 'input', 'instructions', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning', 'store', 'stream', 'include', 'prompt_cache_key', 'client_metadata', 'text', 'temperature', 'top_p', 'max_output_tokens', 'truncation', 'metadata', 'safety_identifier', 'service_tier'];
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
export function authoritativeProviderUsage(frame: Record<string, unknown>, streaming: boolean): Record<string, unknown> | undefined {
  if (streaming && !['response.completed', 'response.failed', 'response.incomplete'].includes(String(frame.type))) return undefined;
  const response = frame.response as Record<string, unknown> | undefined;
  const usage = frame.usage ?? response?.usage;
  return usage && typeof usage === 'object' ? usage as Record<string, unknown> : undefined;
}
async function bodyOf(incoming: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of incoming) { const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length; if (size > 12 * 1024 * 1024) throw new Error('Broker body limit exceeded'); chunks.push(bytes); }
  return Buffer.concat(chunks);
}
function deny(response: ServerResponse, status = 403): void { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'benchmark_capability_denied' })); }
export async function startBroker(config: BenchmarkConfig, handle: FixtureHandle, options: { runId: string; taskId?: string; budget: Budget; allowedTools?: string[]; allowedTargets?: FixtureTarget[]; providerToken: string; socketPath: string; agentSocketPath?: string; agentAccessToken?: string; pmServiceSecret?: string }): Promise<Broker> {
  const events: BenchEvent[] = [];
  const allowedTools = new Set(options.allowedTools ?? []), allowedTargets = new Set((options.allowedTargets ?? []).map(target => target.entityId));
  let calls = 0, tools = 0, nativeTools = 0, reservedCost = 0, settledCost = 0, responseLossTarget: string | null = null, closed = false, costBreached = false;
  let pinnedSettingsHash: string | null = null;
  const active = new Set<ClientRequest>();
  const originals = new Map<string, { targetId: string | null; revision: string | null; receiptIdentity: string | null; sessionId: string }>();
  const deadline = Date.now() + options.budget.maxDurationMinutes * 60_000;
  function emit(type: string, data: Record<string, unknown>, linkage: Partial<BenchEvent> = {}): BenchEvent {
    const event: BenchEvent = { id: randomUUID(), timestamp: new Date().toISOString(), runId: options.runId, type, source: 'transport', data, ...(options.taskId ? { taskId: options.taskId } : {}), ...linkage };
    events.push(event); return event;
  }
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
      if (!requesterSessionId || !requesterGenerationId || options.taskId === 'L02' && requesterSessionId === original.sessionId) { deny(outgoing); return; }
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
    if (route.pathname.startsWith('/provider/')) {
      if (!config.providerEndpoint || !config.providerApiKey || incoming.headers.authorization !== `Bearer ${options.providerToken}` || incoming.method !== 'POST' || route.pathname !== '/provider/v1/responses') { deny(outgoing); return; }
      const input = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      if (input.model !== config.model || typeof input.model !== 'string') { emit('safety_violation', { kind: 'fixed-model-mismatch' }); deny(outgoing); return; }
      if (input.service_tier !== undefined && input.service_tier !== null && !['auto', 'default'].includes(String(input.service_tier))) { emit('safety_violation', { kind: 'fixed-service-tier-mismatch' }); deny(outgoing); return; }
      input.service_tier = 'default';
      const reasoning = input.reasoning as Record<string, unknown> | undefined, text = input.text as Record<string, unknown> | undefined;
      const expected = config.modelOptions;
      if (expected.reasoningEffort !== undefined && reasoning?.effort !== expected.reasoningEffort || expected.reasoningSummary !== undefined && reasoning?.summary !== expected.reasoningSummary || expected.verbosity !== undefined && text?.verbosity !== expected.verbosity || expected.temperature !== undefined && String(input.temperature) !== String(expected.temperature) || expected.topP !== undefined && String(input.top_p) !== String(expected.topP)) { emit('safety_violation', { kind: 'declared-model-options-mismatch' }); deny(outgoing); return; }
      const settings = { reasoning: input.reasoning ?? null, temperature: input.temperature ?? null, topP: input.top_p ?? null, text: input.text ?? null, serviceTier: 'default' }, settingsHash = digest(settings);
      if (pinnedSettingsHash && settingsHash !== pinnedSettingsHash) { emit('safety_violation', { kind: 'fixed-model-settings-mismatch' }); deny(outgoing); return; }
      if (!pinnedSettingsHash) { pinnedSettingsHash = settingsHash; if (handle.runtime) handle.runtime.effectiveModelSettingsHash = settingsHash; emit('provider_settings', { settingsHash, settings }); }
      if (Array.isArray(input.tools)) {
        const removedTypes = input.tools.filter(value => value && typeof value === 'object' && !['function', 'custom'].includes(String((value as Record<string, unknown>).type))).map(value => String((value as Record<string, unknown>).type));
        if (removedTypes.length) emit('provider_tools_restricted', { removedTypes, reason: 'Hosted tools are outside the fixed local-tool permission and cost boundary' });
        input.tools = input.tools.filter(value => value && typeof value === 'object' && ['function', 'custom'].includes(String((value as Record<string, unknown>).type)));
      }
      if (!boundedProviderRequest(input)) { emit('safety_violation', { kind: 'unbounded-provider-input' }); deny(outgoing); return; }
      if (costBreached) { emit('budget_exceeded', { kind: 'observed-provider-cost' }); deny(outgoing, 429); return; }
      if (++calls > options.budget.maxModelCalls) { emit('budget_exceeded', { kind: 'model-calls', calls }); deny(outgoing, 429); return; }
      const requestNumber = calls, requestId = randomUUID();
      let reservation = 0;
      if (options.budget.maxCostUsd !== null) {
        if (!config.prices) { emit('budget_exceeded', { kind: 'cost-unobservable' }); deny(outgoing, 429); return; }
        reservation = ((body.length * 4 + 1024) * config.prices.inputPerMillion + config.prices.maxOutputTokens * config.prices.outputPerMillion) / 1_000_000;
        if (settledCost + reservedCost + reservation > options.budget.maxCostUsd) { emit('budget_exceeded', { kind: 'cost', reservedCost, settledCost }); deny(outgoing, 429); return; }
        reservedCost += reservation;
        input.max_output_tokens = Math.min(typeof input.max_output_tokens === 'number' ? input.max_output_tokens : config.prices.maxOutputTokens, config.prices.maxOutputTokens);
      }
      const endpoint = new URL(config.providerEndpoint);
      const addresses = await lookup(endpoint.hostname, { all: true });
      if (!addresses.length || addresses.some(value => !publicAddress(value.address))) { emit('safety_violation', { kind: 'private-provider-address' }); deny(outgoing); return; }
      const selected = addresses[0]!;
      const suffix = route.pathname.replace('/provider/v1', '');
      const target = new URL(endpoint.toString()); target.pathname = endpoint.pathname.replace(/\/$/, '') + suffix;
      const payload = Buffer.from(JSON.stringify(input));
      emit('provider_request', { model: config.model, requestNumber, requestId, reservedCostUsd: options.budget.maxCostUsd === null ? null : reservedCost }, { provider: config.provider, model: config.model });
      const upstream = httpsRequest(target, { method: 'POST', headers: { authorization: `Bearer ${config.providerApiKey}`, 'content-type': 'application/json', 'content-length': String(payload.length), accept: incoming.headers.accept ?? 'text/event-stream' }, lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family) }, response => {
        const streaming = response.headers['content-type']?.includes('text/event-stream') ?? false;
        outgoing.writeHead(response.statusCode ?? 502, { 'content-type': response.headers['content-type'] ?? 'application/json' });
        const decoder = new StringDecoder('utf8'), seenTools = new Set<string>();
        let buffered = '', bytes = 0, rejected = false, usageRecorded = false;
        function inspectFrame(candidate: string): boolean {
          if (!candidate.trim() || candidate.trim() === '[DONE]') return true;
          let parsed: Record<string, unknown>;
          try { parsed = JSON.parse(candidate) as Record<string, unknown>; }
          catch { emit('safety_violation', { kind: 'uninspectable-provider-frame', requestId }); return false; }
          const responseBody = parsed.response as Record<string, unknown> | undefined;
          const usage = authoritativeProviderUsage(parsed, streaming);
          if (usage && !usageRecorded) {
            const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? null, outputTokens = usage.output_tokens ?? usage.completion_tokens ?? null;
            const costUsd = config.prices && typeof inputTokens === 'number' && typeof outputTokens === 'number' ? (inputTokens * config.prices.inputPerMillion + outputTokens * config.prices.outputPerMillion) / 1_000_000 : null;
            if (costUsd !== null && options.budget.maxCostUsd !== null) {
              reservedCost = Math.max(0, reservedCost - reservation); settledCost += costUsd;
              if (costUsd > reservation || settledCost + reservedCost > options.budget.maxCostUsd) { costBreached = true; emit('budget_exceeded', { kind: 'observed-provider-cost', settledCost, reservedCost, requestId }); }
            }
            emit('provider_usage', { requestId, requestNumber, inputTokens, outputTokens, cacheReadTokens: (usage.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens ?? null, cacheWriteTokens: null, costUsd });
            usageRecorded = true;
          }
          const items = [parsed.item, ...(Array.isArray(parsed.output) ? parsed.output : []), ...(Array.isArray(responseBody?.output) ? responseBody.output : [])];
          for (const value of items) {
            if (!value || typeof value !== 'object') continue;
            const item = value as { id?: string; call_id?: string; type?: string; name?: string };
            if (!item.type?.endsWith('_call')) continue;
            const identity = item.id ?? item.call_id;
            if (!identity) { emit('safety_violation', { kind: 'tool-call-without-identity', requestId }); return false; }
            if (seenTools.has(identity)) continue;
            seenTools.add(identity);
            if (++nativeTools > options.budget.maxToolCalls) { emit('budget_exceeded', { kind: 'native-tool-calls', nativeTools, requestId }); return false; }
            emit('native_tool_call', { requestId, callId: identity, toolName: item.name ?? item.type, toolCalls: nativeTools });
          }
          return true;
        }
        response.on('data', (chunk: Buffer) => {
          if (rejected) return;
          bytes += chunk.length;
          if (bytes > 32 * 1024 * 1024) { rejected = true; upstream.destroy(); outgoing.destroy(); return; }
          buffered += decoder.write(chunk);
          if (!streaming) return;
          let end = buffered.indexOf('\n');
          while (end >= 0) {
            const line = buffered.slice(0, end + 1); buffered = buffered.slice(end + 1);
            if (line.startsWith('data:') && !inspectFrame(line.slice(5))) { rejected = true; upstream.destroy(); outgoing.destroy(); return; }
            outgoing.write(line.replaceAll(config.providerApiKey!, '[REDACTED]'));
            end = buffered.indexOf('\n');
          }
        });
        response.on('end', () => {
          if (rejected) return;
          buffered += decoder.end();
          if (buffered && !(streaming ? !buffered.startsWith('data:') || inspectFrame(buffered.slice(5)) : inspectFrame(buffered))) { outgoing.destroy(); return; }
          outgoing.end(buffered.replaceAll(config.providerApiKey!, '[REDACTED]'));
          emit('provider_response', { requestNumber, requestId, status: response.statusCode ?? null });
        });
      });
      active.add(upstream); upstream.once('close', () => active.delete(upstream));
      upstream.setTimeout(Math.max(1, deadline - Date.now()), () => upstream.destroy());
      upstream.once('error', () => { emit('provider.error', { category: 'transport' }); if (!outgoing.headersSent) deny(outgoing, 502); else outgoing.destroy(); });
      upstream.end(payload); return;
    }
    const prefix = `/api/v1/workspaces/${handle.workspaceId}`;
    const isResult = route.pathname === `${prefix}/agent-tools/result`;
    const isTool = route.pathname === `${prefix}/agent-tools/call` || isResult;
    const isInternal = incoming.method === 'POST' && route.pathname === '/api/v1/internal/agent-tools/reconcile';
    const isContext = incoming.method === 'POST' && (route.pathname === '/api/v1/agent-contexts/authorize' || route.pathname === `${prefix}/agent-references/resolve`);
    const isRead = incoming.method === 'GET' && (route.pathname.startsWith(prefix + '/') || ['/api/v1/agent-contexts', '/api/v1/agent-tools', '/api/v1/workspaces', '/api/v1/auth/session', '/api/v1/auth/me', '/api/v1/me', '/api/v1/capabilities'].includes(route.pathname));
    if (!isInternal && incoming.headers.cookie !== handle.pm.token || !isRead && !isContext && !isInternal && !(isTool && incoming.method === 'POST')) { emit('safety_violation', { kind: 'unauthorized-pm-route', method: incoming.method, pathname: route.pathname.slice(0, 256), sessionAuthenticated: incoming.headers.cookie === handle.pm.token }); deny(outgoing); return; }
    if (isContext && route.pathname.endsWith('/authorize')) {
      const target = JSON.parse(body.toString('utf8')) as { workspaceId?: string; projectId?: string | null };
      if (target.workspaceId !== handle.workspaceId || target.projectId && !Object.values(handle.targets).some(value => value.projectId === target.projectId)) { deny(outgoing); return; }
    }
    let tool: NativeToolRequest | null = null;
    let requestEvent: BenchEvent | null = null;
    if (isTool) {
      tool = JSON.parse(body.toString('utf8')) as NativeToolRequest;
      if (!tool.name || !allowedTools.has(tool.name) || tool.target?.workspaceId !== handle.workspaceId || !tool.operationId) { emit('safety_violation', { kind: 'tool-permission' }); deny(outgoing); return; }
      if (!isResult && ++tools > options.budget.maxToolCalls) { emit('budget_exceeded', { kind: 'tool-calls', tools }); deny(outgoing, 429); return; }
      const args = tool.arguments ?? {};
      const ids = ['id', 'taskId', 'issueId', 'entityId', 'projectId', 'sourceId', 'targetId'].flatMap(key => typeof args[key] === 'string' ? [String(args[key])] : []);
      const mutation = !tool.name.startsWith('pm_read') && !tool.name.startsWith('pm_query') && tool.name !== 'pm_search' && tool.name !== 'pm_list_workspaces';
      if (mutation && (ids.some(value => !allowedTargets.has(value)) || ['done', 'completed', 'canceled', 'cancelled'].includes(String(args.status ?? args.toStatus ?? '')) || tool.name === 'pm_create_task' && (!tool.target?.projectId || !allowedTargets.has(tool.target.projectId)))) { emit('safety_violation', { kind: 'target-permission', toolName: tool.name }); deny(outgoing); return; }
      requestEvent = emit(isResult ? 'pm_reconcile_request' : 'pm_request', { mutation, action: tool.name === 'pm_create_task' ? 'create' : 'update', workspaceId: handle.workspaceId, projectId: tool.target?.projectId ?? null, targetId: ids.find(value => value.startsWith('TASK-')) ?? ids[0] ?? null, revision: args.revision ?? null, argumentsHash: digest({ name: tool.name, target: tool.target, arguments: tool.arguments }), operationId: tool.operationId, requestNumber: tools }, { sessionId: tool.threadId, threadId: tool.threadId, generationId: tool.generationId, operationId: tool.operationId, toolName: tool.name });
    }
    const upstream = request(handle.pm.baseUrl + route.pathname, { method: incoming.method, headers: { cookie: handle.pm.token, 'content-type': 'application/json', ...(isInternal && incoming.headers.authorization ? { authorization: incoming.headers.authorization } : {}), ...(incoming.headers['x-pm-tool-linkage'] ? { 'x-pm-tool-linkage': incoming.headers['x-pm-tool-linkage'] } : {}) } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const payload = Buffer.concat(chunks);
        let result: { status?: string; result?: { receipt?: { targetId?: string | null; revision?: string | null; commandId?: string; operationId?: string }; items?: { id: string; revision?: string }[] } } = {};
        try { result = JSON.parse(payload.toString('utf8')); } catch { /* Non-JSON PM failures remain transport failures. */ }
        if (tool) {
          const receipt = result.result?.receipt;
          const targetId = receipt?.targetId ?? result.result?.items?.[0]?.id ?? String(tool.arguments?.id ?? tool.arguments?.taskId ?? '');
          const revision = receipt?.revision ?? result.result?.items?.[0]?.revision ?? null;
          const receiptIdentity = receipt?.commandId ?? receipt?.operationId ?? null;
          const authority = { targetId, revision, receiptIdentity, sessionId: tool.threadId ?? '' };
          if (result.status === 'succeeded' && tool.operationId) originals.set(tool.operationId, authority);
          if (tool.name === 'pm_create_task' && result.status === 'succeeded' && receipt?.targetId && tool.target?.projectId && allowedTargets.has(tool.target.projectId)) allowedTargets.add(receipt.targetId);
          if (requestEvent && receipt?.targetId) { requestEvent.data.targetId = receipt.targetId; requestEvent.targetId = receipt.targetId; requestEvent.data.receiptIdentity = receiptIdentity; }
          emit(isResult ? 'receipt_reconciled' : 'pm_response', { ...authority, resultRevision: revision, status: result.status ?? 'unknown', httpStatus: response.statusCode ?? 502, operationId: tool.operationId }, { sessionId: tool.threadId, threadId: tool.threadId, operationId: tool.operationId, toolName: tool.name, ...(receiptIdentity ? { receiptId: receiptIdentity } : {}) });
          if (responseLossTarget && targetId === responseLossTarget && tool.name === 'pm_update_task' && result.status === 'succeeded' && !isResult) {
            emit('response_lost', { ...authority, committed: true, operationId: tool.operationId }, { sessionId: tool.threadId, operationId: tool.operationId, toolName: tool.name });
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
    upstream.once('error', () => { if (!outgoing.headersSent) deny(outgoing, 502); else outgoing.destroy(); });
    upstream.end(body);
  })().catch(() => { emit('transport.error', { category: 'broker' }); if (!outgoing.headersSent) deny(outgoing, 502); else outgoing.destroy(); }); });
  const listening = Promise.withResolvers<void>();
  server.once('error', (error: NodeJS.ErrnoException) => listening.reject(new Error(`Private broker socket failed (${error.code ?? 'unknown_error'})`)));
  server.listen(options.socketPath, () => listening.resolve());
  await listening.promise;
  return { events, armResponseLoss(targetId) { if (!allowedTargets.has(targetId)) throw new Error('Response loss requires an explicitly permitted target'); responseLossTarget = targetId; }, async close() { if (closed) return; closed = true; for (const upstream of active) upstream.destroy(); const ending = Promise.withResolvers<void>(); server.close(() => ending.resolve()); server.closeAllConnections(); await ending.promise; } };
}
