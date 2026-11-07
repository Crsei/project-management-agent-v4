import type { AutomationStore, ChatRecoveryAdapter, ChatRecoveryCandidate } from './service.ts';
import { AutomationService } from './service.ts';
export type RecoveryFixture = {
  store: AutomationStore; chat: ChatRecoveryAdapter; createService(): AutomationService;
  continuations: { id: string; key: string }[]; source(): ChatRecoveryCandidate;
  mutate(patch: Partial<ChatRecoveryCandidate>): void; removeSource(): void; provider(value: string | null): void;
  advance(milliseconds: number): void; fail(error: Error, afterAcceptance?: boolean): void;
};

export function recoveryFixture(): RecoveryFixture {
  let records = new Map<string, Map<string, unknown>>();
  const store: AutomationStore = {
    readRecord<T>(namespace: string, key: string): T | null { return structuredClone(records.get(namespace)?.get(key) ?? null) as T | null; },
    writeRecord(namespace, key, value) { let values = records.get(namespace); if (!values) records.set(namespace, values = new Map()); values.set(key, structuredClone(value)); },
    deleteRecord(namespace, key) { records.get(namespace)?.delete(key); },
    listRecords<T>(namespace: string): T[] { return [...(records.get(namespace)?.values() ?? [])].map(value => structuredClone(value) as T); },
    transaction(fn) { const before = structuredClone(records); try { return fn(); } catch (error) { records = before; throw error; } },
  };
  let now = Date.parse('2026-01-01T00:00:30Z'), providerBinding: string | null = 'account:1';
  let source: ChatRecoveryCandidate | null = { id: 'quota', threadId: 'session', status: 'failed', errorClass: 'usage_limit', resetAt: '2026-01-01T00:01:00.000Z', providerInstanceId: 'account', providerInstanceRevision: 1, startedAt: '2026-01-01T00:00:00.000Z', requestBinding: 'immutable-request-snapshot', latest: true };
  const continuations: { id: string; key: string }[] = [];
  let failure: Error | null = null, failAfterAcceptance = false;
  const chat = {
    getCandidate(id: string) { return id === source?.id ? source : null; },
    latestInThread(threadId: string) { return source?.threadId === threadId ? source : null; },
    async continueRun(id: string, options: { idempotencyKey: string }) {
      if (failure && !failAfterAcceptance) throw failure;
      continuations.push({ id, key: options.idempotencyKey });
      if (source) { source.continuationRunId = 'continuation'; source.continuationIdempotencyKey = options.idempotencyKey; }
      if (failure) throw failure;
      return { id: 'continuation', status: 'queued' as const };
    },
  };
  const createService = () => new AutomationService({ store, chat, providerIdentity: () => providerBinding, now: () => now });
  return { store, chat, createService, continuations,
    source: () => source!, mutate: (patch: Partial<ChatRecoveryCandidate>) => { if (source) Object.assign(source, patch); },
    removeSource: () => { source = null; },
    provider: (value: string | null) => { providerBinding = value; },
    advance: (milliseconds: number) => { now += milliseconds; },
    fail: (error: Error, afterAcceptance = false) => { failure = error; failAfterAcceptance = afterAcceptance; },
  };
}
