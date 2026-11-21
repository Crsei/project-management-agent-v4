import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request, type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { StringDecoder } from 'node:string_decoder';
import { performance } from 'node:perf_hooks';
import type { BenchmarkConfig } from '../benchmark.config.ts';
import type { BenchEvent, Budget, FixtureHandle, GenerationAdmission } from '../schemas/types.ts';
import { digest } from '../fixtures/snapshot.ts';
import { TraceRedactor } from '../runners/telemetry.ts';
import { observeBriefsInProviderRequest, type BriefWireObservation } from '../pm-tools/wire-evidence.ts';
import type { NativeAccountRelay } from './native-account.ts';
export type ProviderTransport = { handle(incoming: IncomingMessage, outgoing: ServerResponse, body: Buffer, route: string): Promise<void>; close(): void; readonly complete: boolean };
export function normalizeProviderUsage(usage: Record<string, unknown> | undefined, prices?: BenchmarkConfig['prices'], api?: BenchmarkConfig['providerApi']): Record<string, unknown> {
  const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const inputTokens = count(usage?.input_tokens ?? usage?.prompt_tokens), outputTokens = count(usage?.output_tokens ?? usage?.completion_tokens);
  const details = (usage?.input_tokens_details ?? usage?.prompt_tokens_details) as Record<string, unknown> | undefined;
  const cacheReadTokens = count(details?.cached_tokens), cacheWriteTokens = count(details?.cache_creation_tokens);
  let costUsd: number | null = null;
  const freeNativeCacheWrites = api === 'openai-codex-responses' && prices?.cacheWritePerMillion === 0;
  if (prices && inputTokens !== null && outputTokens !== null && cacheReadTokens !== null && (cacheWriteTokens !== null || freeNativeCacheWrites) && cacheReadTokens <= inputTokens && (cacheReadTokens === 0 || prices.cacheReadPerMillion !== undefined) && (cacheWriteTokens === 0 || prices.cacheWritePerMillion !== undefined)) {
    costUsd = ((inputTokens - cacheReadTokens) * prices.inputPerMillion + cacheReadTokens * (prices.cacheReadPerMillion ?? 0) + outputTokens * prices.outputPerMillion + (cacheWriteTokens ?? 0) * (prices.cacheWritePerMillion ?? 0)) / 1_000_000;
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, costBasis: prices?.basis ?? 'api-billing', actualSubscriptionBillingUsd: null, usagePresent: usage !== undefined, pricingVersion: prices?.version ?? null };
}

export function createProviderTransport(config: BenchmarkConfig, handle: FixtureHandle, options: { budget: Budget; providerToken: string; deadline: number; clockId: string; controlledProviderSocketPath?: string; nativeAccountRelay?: Pick<NativeAccountRelay, 'socketPath' | 'capability' | 'evidence'> }, emit: (type: string, data: Record<string, unknown>, linkage?: Partial<BenchEvent>) => BenchEvent, policy: { authoritativeProviderUsage(frame: Record<string, unknown>, streaming: boolean, api: BenchmarkConfig['providerApi']): Record<string, unknown> | undefined; boundedProviderRequest(input: Record<string, unknown>, api: BenchmarkConfig['providerApi']): boolean; publicAddress(address: string): boolean }): ProviderTransport {
  if (options.controlledProviderSocketPath && (config.provider !== 'omp' || config.providerApi !== 'openai-completions' || config.model !== 'omp-controlled-protocol' || config.providerEndpoint || config.providerApiKey)) throw new Error('Controlled HTTP capability cannot configure real-provider egress');
  if (options.nativeAccountRelay && (!config.hostAuthBoundary || options.controlledProviderSocketPath)) throw new Error('Native host relay requires explicit native account selection and cannot replace a controlled provider');
  if (options.nativeAccountRelay && digest(options.nativeAccountRelay.evidence.selection) !== digest(config.hostAuthBoundary)) throw new Error('Native host relay account selection differs from the explicit auth boundary');
  const { authoritativeProviderUsage, boundedProviderRequest, publicAddress } = policy;
  const active = new Set<ClientRequest>(), redactor = new TraceRedactor(), shutdown = new AbortController();
  redactor.addSecrets([options.providerToken, handle.pm.token, ...(config.providerApiKey ? [config.providerApiKey] : []), ...(options.nativeAccountRelay ? [options.nativeAccountRelay.capability] : [])]);
  let calls = 0, nativeTools = 0, reservedCost = 0, settledCost = 0, costBreached = false, complete = true, pinnedSettingsHash: string | null = null, unsettledRequests = 0;
  function deny(outgoing: ServerResponse, kind: string, status = 403, details: Record<string, unknown> = {}): void { emit(status === 429 ? 'budget_exceeded' : 'safety_violation', { kind, ...details }); outgoing.writeHead(status, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify({ error: 'benchmark_capability_denied' })); }
  async function awaitAdmission(admission: GenerationAdmission, incoming: IncomingMessage, outgoing: ServerResponse): Promise<string | null> {
    if (shutdown.signal.aborted || admission.signal.aborted || incoming.aborted || outgoing.destroyed) return null;
    const cancelled = Promise.withResolvers<null>(), cancel = (): void => { cancelled.resolve(null); };
    const timer = setTimeout(cancel, Math.max(0, Math.min(admission.deadline, options.deadline) - Date.now()));
    admission.signal.addEventListener('abort', cancel, { once: true });
    shutdown.signal.addEventListener('abort', cancel, { once: true });
    incoming.once('aborted', cancel); outgoing.once('close', cancel);
    try { return await Promise.race([admission.accepted, cancelled.promise]); }
    finally {
      clearTimeout(timer);
      admission.signal.removeEventListener('abort', cancel); shutdown.signal.removeEventListener('abort', cancel);
      incoming.off('aborted', cancel); outgoing.off('close', cancel);
    }
  }
  return {
    get complete() { return complete; },
    close() { shutdown.abort(); if (unsettledRequests) complete = false; for (const upstream of active) upstream.destroy(new Error('Provider boundary closed')); },
    async handle(incoming, outgoing, body, route) {
      const nativeAccount = config.hostAuthBoundary !== undefined;
      const completions = config.providerApi === 'openai-completions', expectedRoute = nativeAccount ? '/provider/v1/codex/responses' : completions ? '/provider/v1/chat/completions' : '/provider/v1/responses';
      const runtime = handle.runtime, sessionId = runtime?.activeSessionId, admission = runtime?.activeGenerationAdmission;
      let generationId = runtime?.activeGenerationId;
      if (incoming.headers.authorization !== `Bearer ${options.providerToken}` || incoming.method !== 'POST' || route !== expectedRoute || nativeAccount && (!options.nativeAccountRelay || incoming.headers.origin !== undefined || incoming.headers['chatgpt-account-id'] !== undefined || !sessionId || !generationId && (!admission || admission.sessionId !== sessionId)) || !nativeAccount && !options.controlledProviderSocketPath && (!config.providerEndpoint || !config.providerApiKey)) { deny(outgoing, 'provider-route-or-credentials'); return; }
      if (nativeAccount) {
        if (admission) {
          const accepted = admission.sessionId === sessionId ? await awaitAdmission(admission, incoming, outgoing) : null;
          if (!accepted || admission.signal.aborted || runtime?.activeGenerationAdmission !== admission || runtime?.activeGenerationId !== accepted) {
            if (!outgoing.destroyed) deny(outgoing, 'native-generation-admission');
            return;
          }
          generationId = accepted;
        }
        if (shutdown.signal.aborted || Date.now() >= options.deadline || incoming.aborted || outgoing.destroyed || handle.runtime !== runtime || runtime?.activeSessionId !== sessionId || runtime?.activeGenerationId !== generationId) {
          if (!outgoing.destroyed) deny(outgoing, 'native-generation-admission');
          return;
        }
      }
      const input = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      if (input.model !== config.model || typeof input.model !== 'string') { deny(outgoing, 'fixed-model-mismatch'); return; }
      if (nativeAccount && (input.store !== false || input.stream !== true || ['max_output_tokens', 'max_completion_tokens', 'max_tokens'].some(key => key in input))) { deny(outgoing, 'native-account-output-or-storage-policy'); return; }
      if (input.service_tier !== undefined && input.service_tier !== null && !['auto', 'default'].includes(String(input.service_tier))) { deny(outgoing, 'fixed-service-tier-mismatch'); return; }
      input.service_tier = 'default';
      const reasoning = input.reasoning as Record<string, unknown> | undefined, text = input.text as Record<string, unknown> | undefined;
      const expected = config.modelOptions;
      if (expected.reasoningEffort !== undefined && (completions ? input.reasoning_effort : reasoning?.effort) !== expected.reasoningEffort || expected.reasoningSummary !== undefined && reasoning?.summary !== expected.reasoningSummary || expected.verbosity !== undefined && text?.verbosity !== expected.verbosity || expected.temperature !== undefined && String(input.temperature) !== String(expected.temperature) || expected.topP !== undefined && String(input.top_p) !== String(expected.topP)) { deny(outgoing, 'declared-model-options-mismatch'); return; }
      if (config.provider === 'omp' && expected.thinking !== undefined && expected.thinking !== 'off' && (completions ? input.reasoning_effort : reasoning?.effort) !== expected.thinking) { deny(outgoing, 'declared-thinking-mismatch'); return; }
      if (config.provider === 'omp' && expected.thinking === 'off' && ![undefined, null, 'off', 'none'].includes(completions ? input.reasoning_effort as string | undefined : reasoning?.effort as string | undefined)) { deny(outgoing, 'declared-thinking-off-mismatch'); return; }
      if (!nativeAccount && options.budget.maxCostUsd !== null && config.prices) {
        const cap = completions ? Object.hasOwn(input, 'max_tokens') ? 'max_tokens' : 'max_completion_tokens' : 'max_output_tokens';
        input[cap] = Math.min(typeof input[cap] === 'number' ? input[cap] as number : config.prices.maxOutputTokens, config.prices.maxOutputTokens);
      }
      const settings = { api: config.providerApi, model: input.model, reasoning: input.reasoning ?? input.reasoning_effort ?? null, temperature: input.temperature ?? null, topP: input.top_p ?? null, text: input.text ?? null, serviceTier: 'default', maxOutputTokens: input.max_output_tokens ?? input.max_completion_tokens ?? input.max_tokens ?? null, ...(nativeAccount ? { hostAuthBoundary: config.hostAuthBoundary, reservedMaxOutputTokens: config.prices?.maxOutputTokens, outputCapEnforced: false } : {}) }, settingsHash = digest(settings);
      if (pinnedSettingsHash && settingsHash !== pinnedSettingsHash) { deny(outgoing, 'fixed-model-settings-mismatch'); return; }
      if (!pinnedSettingsHash) { pinnedSettingsHash = settingsHash; if (handle.runtime) handle.runtime.effectiveModelSettingsHash = settingsHash; emit('provider_settings', { settingsHash, settings }); }
      if (Array.isArray(input.tools)) {
        const supported = (value: unknown): boolean => !!value && typeof value === 'object' && 'type' in value && (value.type === 'function' || (config.provider === 'codex' || nativeAccount) && value.type === 'custom');
        const removed = input.tools.filter(value => !supported(value));
        if (removed.length && config.provider !== 'codex') { deny(outgoing, 'hosted-or-unknown-provider-tool'); return; }
        if (removed.length) {
          emit('provider_tools_restricted', { removedTypes: removed.map(value => value && typeof value === 'object' && 'type' in value ? value.type : 'invalid'), reason: 'Hosted tools remain outside the existing Codex fixed local-tool permission/cost boundary' });
          input.tools = input.tools.filter(supported);
        }
      }
      if (!boundedProviderRequest(input, config.providerApi)) { deny(outgoing, 'unbounded-provider-input'); return; }
      if (costBreached) { deny(outgoing, 'observed-provider-cost', 429); return; }
      if (++calls > options.budget.maxModelCalls) { deny(outgoing, 'model-calls', 429); return; }
      const requestNumber = calls, requestId = randomUUID(), startedMonotonicMs = performance.now();
      let reservation = 0;
      if (options.budget.maxCostUsd !== null) {
        if (!config.prices) { deny(outgoing, 'cost-unobservable', 429); return; }
        const price = Math.max(config.prices.inputPerMillion, config.prices.cacheReadPerMillion ?? config.prices.inputPerMillion, config.prices.cacheWritePerMillion ?? config.prices.inputPerMillion);
        reservation = ((body.length * 4 + 1024) * price + config.prices.maxOutputTokens * config.prices.outputPerMillion) / 1_000_000;
        if (settledCost + reservedCost + reservation > options.budget.maxCostUsd) { deny(outgoing, 'cost', 429, { reservationUsd: reservation, settledCostUsd: settledCost, outstandingReservedUsd: reservedCost, maxCostUsd: options.budget.maxCostUsd, costBasis: config.prices.basis ?? 'api-billing' }); return; }
        reservedCost += reservation;
      }
      const linkage: Partial<BenchEvent> = { provider: config.provider, model: config.model, ...(sessionId ? { sessionId } : {}), ...(generationId ? { generationId } : {}) };
      const payload = Buffer.from(JSON.stringify(input)), toolSchemaBytes = Array.isArray(input.tools) ? Buffer.byteLength(JSON.stringify(input.tools)) : 0;
      const transcript = completions ? input.messages : input.input;
      const toolResults = Array.isArray(transcript) ? transcript.filter(value => value && typeof value === 'object' && ((value as Record<string, unknown>).role === 'tool' || (value as Record<string, unknown>).type === 'function_call_output')) : [];
      let usageRecorded = false, terminal = false, finished = false, registered = false, responseBytes = 0, status: number | null = null, upstreamRequestId: string | null = null, contentType: string | null = null;
      function finish(reason: string): void {
        if (finished) return;
        finished = true;
        if (registered) unsettledRequests--;
        if (!terminal || reason !== 'end' && reason !== 'terminal-consumed' || status === null || status < 200 || status >= 300) complete = false;
        if (!usageRecorded) emit('provider_usage', { requestId, requestNumber, ...normalizeProviderUsage(undefined, config.prices, config.providerApi), missingReason: reason === 'end' ? terminal ? 'terminal-usage-absent' : 'stream-ended-without-terminal' : reason, controlled: !!options.controlledProviderSocketPath }, linkage);
        emit('provider_response', { requestNumber, requestId, upstreamRequestId, status, contentType, terminal, usageRecorded, responseBytes, streamEnd: reason, durationMs: performance.now() - startedMonotonicMs, startedMonotonicMs, endedMonotonicMs: performance.now(), clockId: options.clockId, intervalKind: 'provider', controlled: !!options.controlledProviderSocketPath }, linkage);
      }
      const receive = (response: IncomingMessage): void => {
        status = response.statusCode ?? null;
        const actualRequestId = response.headers['x-request-id'];
        if (typeof actualRequestId === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(actualRequestId)) upstreamRequestId = redactor.text(actualRequestId);
        if (nativeAccount && response.headers['x-bench-request-id'] !== requestId) { response.destroy(); finish('native-relay-request-identity-mismatch'); deny(outgoing, 'native-relay-request-identity-mismatch', 502); return; }
        contentType = response.headers['content-type'] ?? null;
        // Native Codex's SSE transport parses every successful streamed response
        // as SSE, independently of Content-Type; non-2xx JSON errors stay JSON.
        const streaming = nativeAccount && input.stream === true && status !== null && status >= 200 && status < 300 || (contentType?.includes('text/event-stream') ?? false);
        outgoing.writeHead(response.statusCode ?? 502, { 'content-type': response.headers['content-type'] ?? 'application/json' });
        const decoder = new StringDecoder('utf8'), seenTools = new Set<string>();
        let buffered = '', frameLines: string[] = [], rejected = false;
        const inspect = (candidate: string): boolean => {
          if (!candidate.trim()) return true;
          if (candidate.trim() === '[DONE]') { terminal = true; return true; }
          let parsed: Record<string, unknown>;
          try { parsed = JSON.parse(candidate) as Record<string, unknown>; } catch { emit('safety_violation', { kind: 'uninspectable-provider-frame', requestId }, linkage); return false; }
          const responseBody = parsed.response as Record<string, unknown> | undefined;
          if (nativeAccount && (responseBody?.model ?? parsed.model) !== undefined && (responseBody?.model ?? parsed.model) !== config.model) { emit('safety_violation', { kind: 'native-response-model-mismatch', requestId }, linkage); return false; }
          if (!streaming || ['response.completed', 'response.failed', 'response.incomplete'].includes(String(parsed.type)) || config.providerApi === 'openai-codex-responses' && parsed.type === 'response.done') terminal = true;
          const usage = authoritativeProviderUsage(parsed, streaming, config.providerApi);
          if (usage && !usageRecorded) {
            const normalized = normalizeProviderUsage(usage, config.prices, config.providerApi), costUsd = normalized.costUsd;
            if (typeof costUsd === 'number' && options.budget.maxCostUsd !== null) {
              reservedCost = Math.max(0, reservedCost - reservation); settledCost += costUsd;
              if (costUsd > reservation || settledCost + reservedCost > options.budget.maxCostUsd) { costBreached = true; emit('budget_exceeded', { kind: 'observed-provider-cost', settledCost, reservedCost, requestId }, linkage); }
            }
            emit('provider_usage', { requestId, requestNumber, ...normalized, rawUsage: redactor.value(usage), controlled: !!options.controlledProviderSocketPath }, linkage); usageRecorded = true;
          }
          const choices = Array.isArray(parsed.choices) ? parsed.choices as Record<string, unknown>[] : [];
          const completionTools = choices.flatMap(choice => { const message = (choice.delta ?? choice.message) as Record<string, unknown> | undefined; return Array.isArray(message?.tool_calls) ? message.tool_calls : []; });
          const items = [parsed.item, ...(Array.isArray(parsed.output) ? parsed.output : []), ...(Array.isArray(responseBody?.output) ? responseBody.output : []), ...completionTools];
          for (const value of items) {
            if (!value || typeof value !== 'object') continue;
            const item = value as { id?: string; call_id?: string; index?: number; type?: string; name?: string; function?: { name?: string } };
            if (!item.type?.endsWith('_call') && item.type !== 'function' && !item.function) continue;
            const identity = item.call_id ?? item.id;
            if (!identity) { if (completions && item.index !== undefined) continue; emit('safety_violation', { kind: 'tool-call-without-identity', requestId }, linkage); return false; }
            if (seenTools.has(identity)) continue;
            seenTools.add(identity);
            if (++nativeTools > options.budget.maxToolCalls) { emit('budget_exceeded', { kind: 'native-tool-calls', nativeTools, requestId }, linkage); return false; }
            emit('native_tool_call', { requestId, callId: identity, toolName: item.name ?? item.function?.name ?? item.type, toolCalls: nativeTools }, linkage);
          }
          emit('provider_frame', { requestId, frame: redactor.value(parsed), streaming, byteLength: Buffer.byteLength(candidate) }, linkage);
          return true;
        };
        const frame = (): boolean => { const value = frameLines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'); frameLines = []; return inspect(value); };
        response.on('data', (chunk: Buffer) => {
          if (rejected) return;
          responseBytes += chunk.length;
          if (responseBytes > 32 * 1024 * 1024) { rejected = true; finish('response-limit'); response.destroy(); outgoing.destroy(); return; }
          buffered += decoder.write(chunk);
          if (!streaming) return;
          let end = buffered.indexOf('\n');
          while (end >= 0) {
            const line = buffered.slice(0, end).replace(/\r$/, ''); buffered = buffered.slice(end + 1);
            frameLines.push(line);
            if (!line && !frame()) { rejected = true; finish('rejected-frame'); response.destroy(); outgoing.destroy(); return; }
            // Redact the capability/credential before forwarding even on failure payloads.
            outgoing.write(redactor.text(line) + '\n'); end = buffered.indexOf('\n');
          }
        });
        response.once('end', () => {
          if (rejected) return;
          buffered += decoder.end();
          if (streaming) { if (buffered) frameLines.push(buffered); if (frameLines.length && !frame()) { finish('truncated-or-invalid-frame'); outgoing.destroy(); return; } }
          else if (!inspect(buffered)) { finish('invalid-json'); outgoing.destroy(); return; }
          outgoing.end(redactor.text(buffered)); finish('end');
        });
        response.once('aborted', () => { finish('upstream-aborted'); outgoing.destroy(); });
        response.once('error', () => { finish('response-error'); outgoing.destroy(); });
      };
      let upstream: ClientRequest;
      if (options.controlledProviderSocketPath) upstream = request({ socketPath: options.controlledProviderSocketPath, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(payload.length) } }, receive);
      else if (options.nativeAccountRelay) {
        const headers: Record<string, string> = { authorization: `Bearer ${options.nativeAccountRelay.capability}`, 'content-type': 'application/json', 'content-length': String(payload.length), 'x-bench-request-id': requestId };
        for (const name of ['session_id', 'conversation_id', 'session-id', 'thread-id', 'x-codex-window-id', 'x-codex-turn-metadata', 'x-client-request-id']) {
          const value = incoming.headers[name]; if (typeof value === 'string' && value.length <= 8192) headers[name] = value;
        }
        upstream = request({ socketPath: options.nativeAccountRelay.socketPath, path: '/responses', method: 'POST', headers }, receive);
      }
      else {
        const endpoint = new URL(config.providerEndpoint!);
        let addresses: { address: string; family: number }[];
        try { addresses = await lookup(endpoint.hostname, { all: true }); }
        catch {
          finish('dns-error'); emit('provider.error', { category: 'dns', requestId }, linkage);
          outgoing.writeHead(502, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify({ error: 'provider_dns_failed' })); return;
        }
        if (!addresses.length || addresses.some(value => !publicAddress(value.address))) { finish('private-provider-address'); deny(outgoing, 'private-provider-address'); return; }
        const selected = addresses[0]!, target = new URL(endpoint);
        target.pathname = endpoint.pathname.replace(/\/$/, '') + (completions ? '/chat/completions' : '/responses');
        upstream = httpsRequest(target, { method: 'POST', family: selected.family, headers: { authorization: `Bearer ${config.providerApiKey}`, 'content-type': 'application/json', 'content-length': String(payload.length), accept: incoming.headers.accept ?? 'text/event-stream' }, lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family) }, receive);
      }
      registered = true; unsettledRequests++;
      active.add(upstream); upstream.once('close', () => { active.delete(upstream); if (!finished) finish('transport-closed'); });
      outgoing.once('close', () => {
        if (outgoing.writableFinished) return;
        // Native SDK consumers stop at the inspected terminal frame, before HTTP EOF.
        // A pre-terminal close or missing authoritative usage remains incomplete.
        finish(nativeAccount && terminal && usageRecorded ? 'terminal-consumed' : 'downstream-cancelled');
        upstream.destroy();
      });
      upstream.setTimeout(Math.max(1, options.deadline - Date.now()), () => upstream.destroy(new Error('Provider deadline')));
      upstream.once('error', () => { finish('transport-error'); emit('provider.error', { category: 'transport', requestId }, linkage); if (!outgoing.headersSent) { outgoing.writeHead(502, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify({ error: 'provider_transport_failed' })); } else outgoing.destroy(); });
      let briefWireObservations: BriefWireObservation[] = [];
      try { briefWireObservations = observeBriefsInProviderRequest(payload.toString('utf8')); }
      catch { emit('observation_missing', { requestId, kind: 'brief-wire-inspection-failed' }, linkage); }
      emit('provider_request', { requestNumber, requestId, model: config.model, api: config.providerApi, ...(nativeAccount ? { nativeProvider: config.hostAuthBoundary!.provider, hostAuthBoundary: config.hostAuthBoundary, costBasis: 'catalog-estimate', outputCapEnforced: false, reservedMaxOutputTokens: config.prices?.maxOutputTokens } : {}), settingsHash, requestBytes: payload.length, requestSha256: createHash('sha256').update(payload).digest('hex'), toolSchemaBytes, pmResultBytes: null, allToolResultBytes: Buffer.byteLength(JSON.stringify(toolResults)), body: redactor.value(input), bodyRepresentation: 'TraceRedactor structured JSON; embedded JSON strings may be reserialized', wireVerbatimExported: false, briefWireObservations: redactor.value(briefWireObservations), correlation: linkage.sessionId && linkage.generationId ? 'trusted-single-active-generation' : 'missing-generation-identity', reservedCostUsd: options.budget.maxCostUsd === null ? null : reservation, controlled: !!options.controlledProviderSocketPath }, linkage);
      upstream.end(payload);
    },
  };
}
