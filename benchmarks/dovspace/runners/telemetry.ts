import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { BenchEvent, Usage } from '../schemas/types.ts';

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
    if (Array.isArray(input)) return input.map(value => this.value(value, seen));
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [this.text(key), sensitiveKey.test(key) ? '[REDACTED]' : this.value(value, seen)]));
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
  let modelObserved = false, pmObserved = false, nativeObserved = false;
  for (const event of events) {
    if (event.source !== 'provider' && event.source !== 'transport') continue;
    const requestId = String(event.data.requestId ?? event.data.requestNumber ?? event.id);
    if (event.type === 'provider_request' || event.type === 'model_request') { modelObserved = true; modelCalls.add(requestId); }
    if (event.type === 'provider_usage') requests.set(requestId, event.data);
    if (event.type === 'native_tool_call') {
      nativeObserved = true;
      nativeCalls.add(String(event.data.callId ?? event.data.itemId ?? event.id));
    }
    if (event.type === 'tool_request' || event.type === 'pm_request' || event.type === 'pm_tool_call') {
      pmObserved = true;
      pmCalls.add(String(event.data.requestId ?? event.operationId ?? event.id));
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
  usage.modelCalls = modelObserved ? modelCalls.size : null;
  // PM gateway records are nested in the native invocation, never counted twice.
  usage.toolCalls = nativeObserved ? nativeCalls.size : pmObserved ? pmCalls.size : null;
  return usage;
}
