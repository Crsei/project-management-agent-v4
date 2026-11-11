import type { BenchEvent, RunResult } from '../schemas/types.ts';
import { hashValue } from './telemetry.ts';

/** A deliberately narrow behavioral proxy, not an estimate of all semantic or code rework. */
export function reworkFromEvents(events: readonly BenchEvent[], traceComplete: boolean): RunResult['rework'] {
  const definition = 'Repeated failed revision-bound PM mutations with identical tool/target/revision/arguments and an independently observed unchanged authority revision, divided by attributable completed revision-bound PM mutation attempts. Excludes receipt lookup, creation without a prior revision, and scheduled injected response loss; not all semantic/code rework.';
  const unknown = (reason: string): RunResult['rework'] => ({ count: null, denominator: null, proportion: null, definition, reason });
  if (!traceComplete) return unknown('The run did not retain a complete trusted PM gateway lifecycle.');
  const lost = new Set(events.filter(event => event.source === 'transport' && event.type === 'response_lost').map(event => event.operationId ?? String(event.data.operationId)));
  const responses = new Map<string, BenchEvent>();
  const authority = new Map<string, BenchEvent>();
  for (const event of events) {
    const operationId = event.operationId ?? (typeof event.data.operationId === 'string' ? event.data.operationId : '');
    if (!operationId) continue;
    if (event.source === 'transport' && event.type === 'pm_response') responses.set(operationId, event);
    if (event.source === 'runner' && event.type === 'pm_failure_checkpoint') authority.set(operationId, event);
  }
  const seen = new Set<string>(), countedOperations = new Set<string>();
  let count = 0, denominator = 0;
  for (const request of events) {
    if (request.source !== 'transport' || request.type !== 'pm_request' || request.data.mutation !== true) continue;
    const operationId = request.operationId ?? String(request.data.operationId ?? '');
    if (!operationId || countedOperations.has(operationId) || lost.has(operationId)) continue;
    countedOperations.add(operationId);
    const response = responses.get(operationId);
    if (!response || !['succeeded', 'failed'].includes(String(response.data.status))) return unknown('A PM mutation outcome is unresolved; unknown outcomes are never treated as failed rework.');
    if (typeof request.data.revision !== 'string' || request.data.revision.length === 0) continue;
    if (typeof request.data.argumentsHash !== 'string') return unknown('A revision-bound mutation lacks a trusted normalized argument fingerprint.');
    if (response.data.status === 'failed') {
      const checkpoint = authority.get(operationId);
      if (!checkpoint) return unknown('A failed mutation lacks an independent post-failure authority checkpoint.');
      // Necessary stale-revision reconciliation is not wasted repetition at unchanged authority.
      if (checkpoint.data.authorityRevision !== request.data.revision) continue;
    }
    denominator++;
    if (response.data.status !== 'failed') continue;
    const signature = hashValue({ toolName: request.toolName, targetId: request.data.targetId, revision: request.data.revision, argumentsHash: request.data.argumentsHash });
    if (seen.has(signature)) count++; else seen.add(signature);
  }
  return { count, denominator, proportion: denominator ? count / denominator : null, definition, reason: denominator ? null : 'No attributable revision-bound PM attempts were observed; the repetition proportion has no denominator.' };
}
