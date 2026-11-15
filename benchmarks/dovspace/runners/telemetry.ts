import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { BenchEvent, Observation, Usage } from '../schemas/types.ts';

const sensitiveKey = /(?:authorization|cookie|password|secret|access.?token|refresh.?token|api.?key|credential|private.?key|connection.?string|database.?url)/i;
const secretPatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(?:sk|sess|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g,
  /\bpostgres(?:ql)?:\/\/[^\s"']+/gi,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
];

/** All persisted untrusted text passes this boundary, including exception messages. */
export class TraceRedactor {
  private readonly secrets: string[];
  constructor(secrets: readonly string[] = []) { this.secrets = [...new Set(secrets.filter(value => value.length >= 4))].sort((a, b) => b.length - a.length); }
  addSecrets(values: readonly string[]): void {
    for (const value of values) if (value.length >= 4 && !this.secrets.includes(value)) this.secrets.push(value);
    this.secrets.sort((a, b) => b.length - a.length);
  }
  text(input: string): string {
    let text = input;
    for (const secret of this.secrets) text = text.split(secret).join('[REDACTED]');
    for (const pattern of secretPatterns) text = text.replace(pattern, '[REDACTED]');
    text = text.replace(/([?&](?:api[_-]?key|access[_-]?token|token|key|secret|password)=)[^&#\s]+/gi, '$1[REDACTED]');
    return text;
  }
  value(input: unknown, seen = new WeakSet<object>()): unknown {
    if (typeof input === 'string') {
      const text = this.text(input);
      const first = text.trimStart()[0];
      if (first === '[' || first === '{') {
        try { return JSON.stringify(this.value(JSON.parse(text), seen)); } catch { /* Plain provider text. */ }
      }
      return text;
    }
    if (input === null || typeof input !== 'object') return input;
    if (seen.has(input)) return '[CIRCULAR]';
    seen.add(input);
    try {
      if (Array.isArray(input)) return input.map(value => this.value(value, seen));
      return Object.fromEntries(Object.entries(input).map(([key, value]) => [this.text(key), sensitiveKey.test(key) ? '[REDACTED]' : this.value(value, seen)]));
    } finally { seen.delete(input); }
  }
}

export function hashValue(value: unknown): string {
  function stable(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(stable);
    if (input !== null && typeof input === 'object') return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]));
    return input;
  }
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

export function makeEvent(runId: string, source: BenchEvent['source'], type: string, data: Record<string, unknown> = {}, fields: Partial<Pick<BenchEvent, 'sessionId' | 'phaseId' | 'operationId' | 'toolName'>> = {}): BenchEvent {
  return { id: randomUUID(), timestamp: new Date().toISOString(), runId, source, type, data, ...fields };
}

export class TraceWriter {
  readonly events: BenchEvent[] = [];
  private pending = Promise.resolve();
  readonly file: string;
  private readonly redactor: TraceRedactor;
  constructor(file: string, redactor: TraceRedactor) { this.file = file; this.redactor = redactor; }
  async initialize(): Promise<void> { await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 }); await appendFile(this.file, '', { mode: 0o600 }); }
  append(event: BenchEvent): Promise<void> {
    const safe = this.redactor.value(event) as BenchEvent;
    this.events.push(safe);
    this.pending = this.pending.then(() => appendFile(this.file, `${JSON.stringify(safe)}\n`, { mode: 0o600 }));
    return this.pending;
  }
  flush(): Promise<void> { return this.pending; }
}

export function emptyUsage(): Usage {
  return { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, modelCalls: null, toolCalls: null };
}

function number(input: unknown): number | null { return typeof input === 'number' && Number.isFinite(input) && input >= 0 ? input : null; }

/** Counts only transport/provider authority; absent provider counters remain null. */
export function usageFromEvents(events: readonly BenchEvent[]): Usage {
  const usage = emptyUsage();
  const generations = new Map<string, Record<string, unknown>>();
  const requests = new Map<string, Record<string, unknown>>();
  const modelCalls = new Set<string>(), pmCalls = new Set<string>(), nativeCalls = new Set<string>();
  const canonicalPmObserved = events.some(event => trusted(event) && event.type === 'pm_request');
  let modelObserved = false, pmObserved = false, nativeObserved = false;
  for (const event of events) {
    if (event.source !== 'provider' && event.source !== 'transport') continue;
    const requestId = requestIdentity(event);
    if (event.type === 'provider_request' || event.type === 'model_request') { modelObserved = true; if (requestId) modelCalls.add(requestId); }
    if (event.type === 'provider_usage' && requestId) requests.set(requestId, event.data);
    if (event.type === 'native_tool_call') {
      nativeObserved = true;
      const callId = identity(event.data.callId ?? event.data.itemId);
      if (callId) nativeCalls.add(`${event.runId}:${callId}`);
    }
    if (event.type === 'tool_request' || event.type === 'pm_request' || event.type === 'pm_tool_call') {
      if (canonicalPmObserved && event.type !== 'pm_request') continue;
      pmObserved = true;
      const callId = pmIdentity(event);
      if (callId) pmCalls.add(callId);
    }
    if (event.type === 'usage') generations.set(String(event.data.generationId ?? event.sessionId ?? event.id), event.data);
  }
  // Proxy request totals supersede Chat's cumulative Session/generation projection.
  // An interrupted request with missing final usage makes the whole sum unknown.
  const counters = modelObserved ? [...modelCalls].map(id => requests.get(id) ?? {}) : [...generations.values()];
  const keys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd'] as const;
  for (const key of keys) {
    const values = counters.map(value => number(value[key]));
    if (values.length && values.every(value => value !== null)) usage[key] = values.reduce<number>((total, value) => total + value!, 0);
  }
  const bases = new Set(counters.map(value => value.costBasis));
  if (bases.size === 1 && (bases.has('api-billing') || bases.has('catalog-estimate'))) usage.costBasis = counters[0]!.costBasis as 'api-billing' | 'catalog-estimate';
  if (usage.costBasis === 'catalog-estimate') usage.actualSubscriptionBillingUsd = null;
  const missingRequestIdentity = events.some(event => trusted(event) && ['provider_request', 'model_request'].includes(event.type) && !requestIdentity(event));
  const missingNativeIdentity = events.some(event => trusted(event) && event.type === 'native_tool_call' && !identity(event.data.callId ?? event.data.itemId));
  const missingPmIdentity = events.some(event => trusted(event) && (canonicalPmObserved ? event.type === 'pm_request' : ['tool_request', 'pm_request', 'pm_tool_call'].includes(event.type)) && !pmIdentity(event));
  usage.modelCalls = modelObserved && !missingRequestIdentity ? modelCalls.size : null;
  if (missingRequestIdentity) for (const key of keys) usage[key] = null;
  if (events.some(event => trusted(event) && ['transport_error', 'transport.error', 'provider_stream_truncated'].includes(event.type))) for (const key of keys) usage[key] = null;
  // Host/bridge/service records are nested; the canonical invocation wins.
  usage.toolCalls = nativeObserved ? missingNativeIdentity ? null : nativeCalls.size : pmObserved && !missingPmIdentity ? pmCalls.size : null;
  return usage;
}

function identity(value: unknown): string | null { return typeof value === 'string' && value.length > 0 ? value : null; }
function trusted(event: BenchEvent): boolean { return event.source === 'provider' || event.source === 'transport'; }
function requestIdentity(event: BenchEvent): string | null {
  const id = identity(event.data.requestId);
  return id ? `${event.runId}:${id}` : null;
}

function pmIdentity(event: BenchEvent): string | null {
  const operation = identity(event.operationId ?? event.data.operationId ?? event.data.callId);
  if (!operation) return null;
  // The same original operation may be queried/replayed as distinct actual invocations.
  const attempt = number(event.data.requestNumber);
  return `${event.runId}:${operation}:${attempt ?? 'single-observed-invocation'}`;
}

/** Only the actual canonical transport can prove counts and request-byte observations. */
export function observationsFromEvents(events: readonly BenchEvent[], requiredTools: readonly string[] = []): Observation {
  const authority = events.filter(trusted);
  const requests = new Map<string, BenchEvent>(), usage = new Map<string, BenchEvent>(), pm = new Map<string, BenchEvent>();
  const complete = authority.findLast(event => event.type === 'observation_complete')?.data;
  let missingRequest = false, missingPm = false;
  for (const event of authority) {
    if (['provider_request', 'model_request'].includes(event.type)) {
      const id = requestIdentity(event); if (id) requests.set(id, event); else missingRequest = true;
    }
    if (event.type === 'provider_usage') { const id = requestIdentity(event); if (id) usage.set(id, event); }
    if (event.type === 'pm_request') {
      const id = pmIdentity(event);
      if (id && event.toolName) pm.set(id, event); else missingPm = true;
    }
  }
  const providerComplete = complete?.providerRequests === true && !missingRequest;
  const pmComplete = complete?.pmTools === true && !missingPm;
  const pmTools: Record<string, number> = {};
  for (const event of pm.values()) pmTools[event.toolName!] = (pmTools[event.toolName!] ?? 0) + 1;
  const usageCoverage: Observation['usageCoverage'] = {};
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd'] as const) {
    const values = [...requests.keys()].map(id => number(usage.get(id)?.data[key]));
    const known = values.filter((value): value is number => value !== null);
    usageCoverage[key] = { knownRequests: known.length, totalRequests: providerComplete ? requests.size : null, knownSubtotal: known.length ? known.reduce((sum, value) => sum + value, 0) : null, complete: providerComplete && known.length === requests.size };
  }
  function bytes(key: string): number | null {
    const values = [...requests.values()].map(event => number(event.data[key]));
    return providerComplete && values.every(value => value !== null) ? values.reduce<number>((sum, value) => sum + value!, 0) : null;
  }
  const intervalIds = new Set<string>();
  const intervals: Observation['intervals'] = [];
  for (const event of events) {
    if (!trusted(event) && event.source !== 'runner' && event.source !== 'grader') continue;
    const startMs = number(event.data.startedMonotonicMs), endMs = number(event.data.endedMonotonicMs);
    const clockId = identity(event.data.clockId);
    const kind = event.data.intervalKind;
    if (startMs !== null && endMs !== null && endMs >= startMs && clockId && ['provider', 'pm', 'validation', 'end-to-end'].includes(String(kind))) {
      const intervalIdentity = identity(event.operationId ?? event.data.requestId) ?? event.id;
      const key = `${clockId}:${kind}:${intervalIdentity}:${startMs}:${endMs}`;
      if (!intervalIds.has(key)) intervals.push({ kind: kind as Observation['intervals'][number]['kind'], identity: intervalIdentity, clockId, startMs, endMs });
      intervalIds.add(key);
    }
  }
  const observed = requiredTools.filter(name => (pmTools[name] ?? 0) > 0);
  return {
    version: 1, providerRequests: providerComplete ? requests.size : null, pmToolCalls: pmComplete ? pm.size : null, pmTools,
    requiredToolCoverage: { required: [...requiredTools], observed, complete: pmComplete, fraction: pmComplete && requiredTools.length ? observed.length / requiredTools.length : null },
    usageCoverage, requestBytes: bytes('requestBytes'), toolSchemaBytes: bytes('toolSchemaBytes'), pmResultBytes: bytes('pmResultBytes'), intervals,
    avoidableRepeatReads: null,
    limitations: [
      ...(!providerComplete ? ['Request observation is incomplete; counts/totals cannot be inferred from a partial trace.'] : []),
      ...(!pmComplete ? ['PM tool observation is incomplete; named tools are observed lower bounds only.'] : []),
      'No observable retained-context/revision/range proof: avoidable repeat reads are unknown.',
      'Transport bytes are not billable tokens or logical context size; intervals may overlap and must not be added.',
    ],
  };
}
