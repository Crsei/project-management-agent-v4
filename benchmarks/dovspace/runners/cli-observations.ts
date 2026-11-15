import type { BenchEvent } from '../schemas/types.ts';
import { hashValue } from './telemetry.ts';

export type CliObservationKind = 'session' | 'execution' | 'message-context' | 'generation' | 'output' | 'usage';
type Identity = { sessionId: string | null; generationId: string | null; inputMessageId: string | null; outputMessageId: string | null };
type SourceVersion = { sourceHash: string | null; manifestVersion: string | null; cliSha256: string | null };
type Reference = { workspaceId: string | null; kind: string | null; id: string | null; projectId: string | null; revision: string | null; availability: string | null; reason: string | null };
type ContextProjection = { version: number | null; threadId: string | null; messageId: string | null; acceptedAt: string | null; visibility: string | null; pmReferences: Reference[] | null; body: 'not-projected' };
const tokenKeys = ['uncachedInputTokens', 'cachedInputTokens', 'cacheCreationTokens', 'outputTokens', 'reasoningTokens'] as const;
const reportedKeys = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheCreationTokens', 'reasoningTokens'] as const;
type ProductUsage = {
  providerInstanceId: string | null; model: string | null;
  productTokenTotals: Record<typeof tokenKeys[number], number | null>;
  productEstimatedCostUsd: number | null;
  reportedTurn: Record<typeof reportedKeys[number], number | null>;
  contextWindow: { usedTokens: number | null; maxTokens: number | null; autoCompactThreshold: number | null; updatedAt: string | null };
  updatedAt: string | null;
};
export interface CliObservation {
  eventId: string; runId: string; timestamp: string; source: BenchEvent['source'];
  kind: CliObservationKind | null; collectionStatus: 'observed' | 'unavailable' | 'invalid';
  requested: { sessionId: string | null; generationId: string | null; messageId: string | null };
  identities: Identity[];
  identityStatus: 'matched' | 'missing' | 'mismatch' | 'unavailable';
  sourceVersion: SourceVersion; snapshotHash: string | null; duplicateOfEventId: string | null;
  sessionRevision: number | null; execution: { agentWorkspaceId: string | null; agentWorkspaceRevision: number | null; frozen: boolean | null } | null;
  contexts: ContextProjection[];
  generationStatus: string | null;
  output: { sequences: number[]; statuses: string[]; itemCount: number | null; truncatedItems: number | null; explicitUntruncatedItems: number | null; truncationUnknownItems: number | null } | null;
  usage: ProductUsage | null;
  error: string | null; issues: string[];
}
export interface CliObservationSummary {
  version: 1; kind: 'cli-observations';
  counts: { events: number; observed: number; unavailable: number; invalid: number; duplicateSnapshots: number };
  observations: CliObservation[];
  sourceVersions: { runId: string; version: SourceVersion; eventIds: string[] }[];
  correlations: {
    runId: string; sessionId: string; generationId: string; inputMessageId: string | null; outputMessageId: string | null;
    sessionEventIds: string[]; generationEventIds: string[]; contextEventIds: string[]; outputEventIds: string[]; usageEventIds: string[]; issues: string[];
  }[];
  productUsage: {
    aggregation: 'not-summed-across-generations';
    snapshots: { runId: string; sessionId: string | null; generationId: string | null; eventIds: string[]; selectedEventId: string | null; status: 'observed' | 'unavailable' | 'ambiguous' | 'identity-unverified'; value: ProductUsage | null }[];
  };
  cliTiming: {
    intervals: { eventId: string; runId: string; command: string[]; durationMs: number | null; exitCode: number | null; outcome: string | null; purpose: string | null; duplicateOfEventId: string | null; issues: string[] }[];
    observedSubprocessDurationMs: number | null; observedCollectionDurationMs: number | null; processOverheadMs: null;
    definition: string;
  };
  limitations: string[];
}

const kinds: readonly string[] = ['session', 'execution', 'message-context', 'generation', 'output', 'usage'];
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string | null { return typeof value === 'string' && value.length > 0 ? value : null; }
function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }
function count(value: unknown): number | null { const result = number(value); return result !== null && Number.isSafeInteger(result) ? result : null; }
function strings(values: readonly (string | null)[]): string[] { return [...new Set(values.filter((value): value is string => value !== null))]; }
function digest(value: unknown): string | null { try { return hashValue(value); } catch { return null; } }
function sourceVersion(value: unknown): SourceVersion {
  const source = object(value);
  return { sourceHash: text(source.sourceHash), manifestVersion: text(source.manifestVersion), cliSha256: text(source.cliSha256) };
}
function context(value: unknown, visibility: unknown): ContextProjection | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = object(value);
  return { version: count(row.version), threadId: text(row.threadId), messageId: text(row.messageId), acceptedAt: text(row.acceptedAt), visibility: text(visibility),
    pmReferences: Array.isArray(row.pmReferences) ? row.pmReferences.map(value => {
      const ref = object(value);
      return { workspaceId: text(ref.workspaceId), kind: text(ref.kind), id: text(ref.id), projectId: text(ref.projectId), revision: text(ref.revision), availability: text(ref.availability), reason: text(ref.reason) };
    }) : null, body: 'not-projected' };
}
function usage(value: Record<string, unknown>): ProductUsage {
  const totals = object(value.totals), reported = object(value.reportedTurn), window = object(value.context);
  return {
    providerInstanceId: text(value.providerInstanceId), model: text(value.model),
    productTokenTotals: Object.fromEntries(tokenKeys.map(key => [key, count(totals[key])])) as ProductUsage['productTokenTotals'],
    productEstimatedCostUsd: number(value.costUsd),
    reportedTurn: Object.fromEntries(reportedKeys.map(key => [key, count(reported[key])])) as ProductUsage['reportedTurn'],
    contextWindow: { usedTokens: count(window.usedTokens), maxTokens: count(window.maxTokens), autoCompactThreshold: count(window.autoCompactThreshold), updatedAt: text(window.updatedAt) },
    updatedAt: text(value.updatedAt),
  };
}
function identity(sessionId: unknown, generationId?: unknown, inputMessageId?: unknown, outputMessageId?: unknown): Identity {
  return { sessionId: text(sessionId), generationId: text(generationId), inputMessageId: text(inputMessageId), outputMessageId: text(outputMessageId) };
}

function parseObservation(event: BenchEvent): CliObservation {
  const data = event.data, kind = kinds.includes(String(data.kind)) ? data.kind as CliObservationKind : null;
  const status = data.collectionStatus === 'observed' || data.collectionStatus === 'unavailable' ? data.collectionStatus : 'invalid';
  const row: CliObservation = {
    eventId: event.id, runId: event.runId, timestamp: event.timestamp, source: event.source, kind, collectionStatus: status,
    requested: { sessionId: text(event.sessionId), generationId: text(event.generationId), messageId: text(data.messageId) },
    identities: [], identityStatus: status === 'unavailable' ? 'unavailable' : 'missing', sourceVersion: sourceVersion(data.productSource),
    snapshotHash: digest(data.value), duplicateOfEventId: null, sessionRevision: null, execution: null, contexts: [], generationStatus: null, output: null, usage: null,
    error: text(data.error), issues: [],
  };
  if (event.source !== 'transport') { row.issues.push('untrusted-collection-source'); row.collectionStatus = 'invalid'; }
  if (!kind || status === 'invalid') row.issues.push('invalid-observation-envelope');
  if (!row.sourceVersion.sourceHash || !row.sourceVersion.manifestVersion || !row.sourceVersion.cliSha256) row.issues.push('missing-product-source-version');
  else if (!/^[a-f0-9]{64}$/.test(row.sourceVersion.sourceHash) || !/^[a-f0-9]{64}$/.test(row.sourceVersion.cliSha256) || row.sourceVersion.manifestVersion !== '1') row.issues.push('invalid-product-source-version');
  if (!row.requested.sessionId) row.issues.push('missing-requested-session-identity');
  if (kind === 'message-context' && !row.requested.messageId) row.issues.push('missing-requested-message-identity');
  if (status === 'unavailable') {
    if (data.value !== null) row.issues.push('unavailable-observation-has-value');
    return row;
  }
  if (status === 'invalid' || !kind || data.value === null || typeof data.value !== 'object' || Array.isArray(data.value)) {
    row.collectionStatus = 'invalid'; row.issues.push('missing-or-invalid-product-value'); return row;
  }
  const value = object(data.value);
  if (kind === 'session') {
    const thread = object(value.thread);
    row.identities.push(identity(thread.remoteId)); row.sessionRevision = count(thread.revision);
  } else if (kind === 'execution') {
    const environment = object(value.environment);
    row.execution = { agentWorkspaceId: text(environment.agentWorkspaceId), agentWorkspaceRevision: count(environment.agentWorkspaceRevision), frozen: typeof environment.frozen === 'boolean' ? environment.frozen : null };
    // /execution has no Session identity in its response. The request alone is not a second identity proof.
    row.issues.push('product-response-omits-session-identity');
  } else if (kind === 'message-context') {
    const projected = context(value.turnContext, value.visibility);
    if (projected) { row.contexts.push(projected); row.identities.push(identity(projected.threadId, undefined, projected.messageId)); }
    else row.issues.push('missing-turn-context');
    if (value.visibility !== 'visible') row.issues.push('context-visibility-not-confirmed-visible');
  } else if (kind === 'generation') {
    const generation = object(value.generation);
    row.identities.push(identity(generation.threadId, generation.id, generation.inputMessageId, generation.messageId));
    row.generationStatus = text(generation.status);
    const projected = context(generation.turnContext, undefined);
    if (projected) {
      row.contexts.push(projected);
      row.identities.push(identity(projected.threadId, generation.id, projected.messageId));
    }
  } else if (kind === 'usage') {
    row.identities.push(identity(value.threadId, value.generationId)); row.usage = usage(value);
  } else {
    const output: NonNullable<CliObservation['output']> = { sequences: [], statuses: [], itemCount: null, truncatedItems: null, explicitUntruncatedItems: null, truncationUnknownItems: null };
    const items = new Map<string, Record<string, unknown>>();
    let hasItemProjection = false;
    if (!Array.isArray(value.records)) row.issues.push('missing-output-records');
    for (const raw of Array.isArray(value.records) ? value.records : []) {
      const record = object(raw), frame = object(record.event), snapshot = object(frame.snapshot);
      if (text(record.generationId)) row.identities.push(identity(undefined, record.generationId, record.inputMessageId));
      if (record.kind !== 'native') continue;
      const native = frame.kind === 'snapshot' ? snapshot : frame;
      row.identities.push(identity(native.threadId, native.generationId));
      const sequence = count(native.sequence); if (sequence !== null) output.sequences.push(sequence);
      const status = text(native.status); if (status) output.statuses.push(status);
      const entries = frame.kind === 'snapshot' && Array.isArray(snapshot.items) ? snapshot.items : frame.kind === 'item' ? [frame.item] : [];
      if (frame.kind === 'snapshot' && Array.isArray(snapshot.items) || frame.kind === 'item') hasItemProjection = true;
      for (const entry of entries) {
        const item = object(entry), itemId = text(item.id);
        // Native items are revision snapshots, not additional output consumption.
        if (itemId) items.set(itemId, item); else row.issues.push('missing-output-item-identity');
      }
    }
    output.sequences = [...new Set(output.sequences)]; output.statuses = strings(output.statuses);
    if (hasItemProjection && !row.issues.includes('missing-output-item-identity')) {
      let truncatedItems = 0, explicitUntruncatedItems = 0, truncationUnknownItems = 0;
      for (const item of items.values()) {
        if (item.outputTruncated === true) truncatedItems++;
        else if (item.outputTruncated === false) explicitUntruncatedItems++;
        else truncationUnknownItems++;
      }
      Object.assign(output, { itemCount: items.size, truncatedItems, explicitUntruncatedItems, truncationUnknownItems });
    } else row.issues.push('incomplete-output-item-projection');
    row.output = output;
  }
  for (const projected of row.contexts) {
    if (projected.version !== 1) row.issues.push('unsupported-turn-context-version');
    if (projected.pmReferences === null) row.issues.push('missing-context-reference-metadata');
  }
  const sessions = strings(row.identities.map(value => value.sessionId));
  const generations = strings(row.identities.map(value => value.generationId));
  const inputs = strings(row.identities.map(value => value.inputMessageId));
  const outputs = strings(row.identities.map(value => value.outputMessageId));
  const mismatches = sessions.length > 1 || generations.length > 1 || inputs.length > 1 || outputs.length > 1 ||
    row.requested.sessionId !== null && sessions.some(id => id !== row.requested.sessionId) ||
    row.requested.generationId !== null && generations.some(id => id !== row.requested.generationId) ||
    row.requested.messageId !== null && inputs.some(id => id !== row.requested.messageId);
  const needsGeneration = kind === 'generation' || kind === 'output' || kind === 'usage';
  if (mismatches) { row.identityStatus = 'mismatch'; row.issues.push('product-identity-mismatch'); }
  else if (sessions.length === 0 || !row.requested.sessionId ||
    needsGeneration && (generations.length === 0 || !row.requested.generationId) ||
    kind === 'message-context' && (!row.requested.messageId || inputs.length === 0 || row.contexts.some(projected => projected.version !== 1))) {
    row.identityStatus = 'missing'; row.issues.push('incomplete-identity-proof');
  } else row.identityStatus = 'matched';
  if (needsGeneration && !row.requested.generationId) row.issues.push('missing-requested-generation-identity');
  if (row.source !== 'transport') { row.collectionStatus = 'invalid'; row.identityStatus = 'missing'; }
  row.issues = [...new Set(row.issues)];
  return row;
}

function summarizeUsage(observations: readonly CliObservation[]): CliObservationSummary['productUsage'] {
  const groups = new Map<string, CliObservation[]>();
  for (const row of observations.filter(value => value.kind === 'usage')) {
    const actual = row.identities[0];
    const sessionId = actual?.sessionId ?? row.requested.sessionId, generationId = actual?.generationId ?? row.requested.generationId;
    const key = JSON.stringify([row.runId, sessionId, generationId, !sessionId || !generationId ? row.eventId : null]);
    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
  }
  const snapshots: CliObservationSummary['productUsage']['snapshots'] = [];
  for (const rows of groups.values()) {
    const last = rows.at(-1)!;
    const actual = last.identities[0];
    const result: CliObservationSummary['productUsage']['snapshots'][number] = {
      runId: last.runId, sessionId: actual?.sessionId ?? last.requested.sessionId, generationId: actual?.generationId ?? last.requested.generationId,
      eventIds: rows.map(row => row.eventId), selectedEventId: null, status: 'identity-unverified', value: null,
    };
    const valid = rows.filter(row => row.collectionStatus === 'observed' && row.identityStatus === 'matched' && row.usage !== null);
    if (last.collectionStatus === 'unavailable') result.status = 'unavailable';
    else if (rows.some(row => row.issues.includes('conflicting-event-id'))) result.status = 'ambiguous';
    else if (new Set(valid.map(row => JSON.stringify(row.sourceVersion))).size > 1) result.status = 'ambiguous';
    else if (valid.length && valid.length === rows.filter(row => row.collectionStatus !== 'unavailable').length && last.identityStatus === 'matched') {
      const distinct = new Map<string, CliObservation>();
      for (const row of valid) distinct.set(row.snapshotHash ?? row.eventId, row);
      let selected: CliObservation | null = distinct.size === 1 ? valid.at(-1)! : null;
      if (distinct.size > 1) {
        const ordered = [...distinct.values()].map(row => ({ row, time: Date.parse(row.usage!.updatedAt ?? '') }));
        if (ordered.every(entry => Number.isFinite(entry.time))) {
          const newest = Math.max(...ordered.map(entry => entry.time));
          const candidates = ordered.filter(entry => entry.time === newest);
          if (candidates.length === 1) selected = candidates[0]!.row;
        }
      }
      result.status = selected ? 'observed' : 'ambiguous';
      if (selected) { result.selectedEventId = selected.eventId; result.value = selected.usage; }
    }
    snapshots.push(result);
  }
  return { aggregation: 'not-summed-across-generations', snapshots };
}

function correlate(observations: readonly CliObservation[]): CliObservationSummary['correlations'] {
  const groups = new Map<string, { row: CliObservation; id: Identity }[]>();
  for (const row of observations) {
    if (row.kind !== 'generation' || row.collectionStatus !== 'observed' || row.identityStatus !== 'matched') continue;
    const id = row.identities[0];
    if (!id?.sessionId || !id.generationId) continue;
    const key = JSON.stringify([row.runId, id.sessionId, id.generationId]);
    const entries = groups.get(key) ?? []; entries.push({ row, id }); groups.set(key, entries);
  }
  return [...groups.values()].map(entries => {
    const first = entries[0]!, sessionId = first.id.sessionId!, generationId = first.id.generationId!;
    const inputs = strings(entries.map(entry => entry.id.inputMessageId)), outputs = strings(entries.map(entry => entry.id.outputMessageId));
    const issues: string[] = [];
    if (inputs.length !== 1) issues.push(inputs.length ? 'generation-input-identity-conflict' : 'missing-generation-input-message');
    if (outputs.length !== 1) issues.push(outputs.length ? 'generation-output-identity-conflict' : 'missing-generation-output-message');
    const sameRun = observations.filter(row => row.runId === first.row.runId);
    const linked = sameRun.filter(row => row.collectionStatus === 'observed' && row.identityStatus === 'matched' && row.identities.some(id => id.sessionId === sessionId));
    const contexts = linked.filter(row => row.kind === 'message-context' && inputs.length === 1 && row.identities.some(id => id.inputMessageId === inputs[0]));
    const correlatedRows = [...entries.map(entry => entry.row), ...contexts, ...linked.filter(row => row.kind === 'session' || row.identities.some(id => id.generationId === generationId))];
    if (new Set(correlatedRows.map(row => JSON.stringify(row.sourceVersion))).size > 1) issues.push('correlated-product-source-version-mismatch');
    if (correlatedRows.some(row => row.issues.some(issue => issue === 'missing-product-source-version' || issue === 'invalid-product-source-version'))) issues.push('unverified-correlated-product-source-version');
    if (correlatedRows.some(row => row.issues.includes('conflicting-event-id'))) issues.push('conflicting-correlated-event-id');
    if (contexts.some(row => row.requested.generationId !== null && row.requested.generationId !== generationId)) issues.push('requested-context-generation-mismatch');
    if (contexts.some(row => row.issues.includes('context-visibility-not-confirmed-visible'))) issues.push('context-visibility-not-confirmed-visible');
    if (inputs.length === 1 && linked.some(row => row.kind === 'output' && row.identities.some(id => id.generationId === generationId) && row.identities.some(id => id.inputMessageId !== null && id.inputMessageId !== inputs[0]))) issues.push('generation-output-input-message-mismatch');
    if (!linked.some(row => row.kind === 'session')) issues.push('missing-session-observation');
    if (!contexts.length) issues.push('missing-message-context-observation');
    if (entries.some(entry => !entry.row.contexts.some(projected => projected.version === 1))) issues.push('missing-generation-turn-context');
    for (const projected of entries.flatMap(entry => entry.row.contexts).filter(projected => projected.version === 1)) {
      for (const collected of contexts.flatMap(row => row.contexts)) {
        if (projected.pmReferences === null || collected.pmReferences === null) issues.push('missing-context-reference-metadata');
        else if (digest(projected.pmReferences.map(ref => digest(ref)).sort()) !== digest(collected.pmReferences.map(ref => digest(ref)).sort())) issues.push('context-reference-metadata-mismatch');
      }
    }
    const ids = (kind: CliObservationKind) => linked.filter(row => row.kind === kind && row.identities.some(id => id.generationId === generationId)).map(row => row.eventId);
    return { runId: first.row.runId, sessionId, generationId, inputMessageId: inputs.length === 1 ? inputs[0]! : null, outputMessageId: outputs.length === 1 ? outputs[0]! : null,
      sessionEventIds: linked.filter(row => row.kind === 'session').map(row => row.eventId), generationEventIds: entries.map(entry => entry.row.eventId), contextEventIds: contexts.map(row => row.eventId), outputEventIds: ids('output'), usageEventIds: ids('usage'), issues: [...new Set(issues)] };
  });
}

function timing(events: readonly BenchEvent[]): CliObservationSummary['cliTiming'] {
  const seen = new Map<string, { hash: string | null; eventId: string }>();
  const intervals: CliObservationSummary['cliTiming']['intervals'] = [];
  for (const event of events.filter(value => value.type === 'cli_command_interval')) {
    const data = event.data, key = JSON.stringify([event.runId, event.id]), hash = digest(data), previous = seen.get(key);
    const issues: string[] = [];
    const command = Array.isArray(data.command) && data.command.every(value => typeof value === 'string') ? data.command as string[] : [];
    const durationMs = number(data.durationMs), purpose = data.purpose === 'control' || data.purpose === 'observation' ? data.purpose : null;
    const outcome = ['completed', 'failed', 'unknown'].includes(String(data.outcome)) ? String(data.outcome) : null;
    if (event.source !== 'transport') issues.push('untrusted-timing-source');
    if (durationMs === null || !command.length || outcome === null) issues.push('invalid-command-interval');
    if (previous && previous.hash !== hash) issues.push('conflicting-event-id');
    if (!purpose) issues.push('unknown-command-purpose');
    intervals.push({ eventId: event.id, runId: event.runId, command, durationMs, exitCode: count(data.exitCode), outcome, purpose, duplicateOfEventId: previous?.hash === hash ? previous.eventId : null, issues });
    seen.set(key, { hash, eventId: event.id });
  }
  const unique = intervals.filter(row => !row.duplicateOfEventId);
  const trusted = unique.filter(row => !row.issues.some(issue => issue !== 'unknown-command-purpose'));
  const valid = unique.length > 0 && trusted.length === unique.length;
  return { intervals, observedSubprocessDurationMs: valid ? trusted.reduce((total, row) => total + row.durationMs!, 0) : null,
    observedCollectionDurationMs: valid && trusted.every(row => row.purpose !== null) && trusted.some(row => row.purpose === 'observation') ? trusted.filter(row => row.purpose === 'observation').reduce((total, row) => total + row.durationMs!, 0) : null,
    processOverheadMs: null,
    definition: 'Sum of distinct trusted CLI subprocess wall durations, including startup, authentication and service latency; collection subtotal includes only purpose=observation. Not isolated CLI process overhead, model time, or proof all commands were collected.',
  };
}

/** Product CLI projections only. Independent grades and broker wire/usage evidence are never rewritten. */
export function summarizeCliObservations(events: readonly BenchEvent[]): CliObservationSummary {
  const observations = events.filter(event => event.type === 'cli_observation').map(parseObservation);
  const snapshots = new Map<string, string>(), eventIds = new Map<string, { hash: string | null; row: CliObservation }>();
  const versions = new Map<string, CliObservationSummary['sourceVersions'][number]>();
  for (const row of observations) {
    const eventKey = JSON.stringify([row.runId, row.eventId]);
    const eventHash = digest(row), previousEvent = eventIds.get(eventKey);
    if (previousEvent && previousEvent.hash !== eventHash) {
      row.issues.push('conflicting-event-id'); previousEvent.row.issues.push('conflicting-event-id');
    }
    eventIds.set(eventKey, { hash: eventHash, row });
    const key = JSON.stringify([row.runId, row.source, row.kind, row.requested, row.sourceVersion, row.collectionStatus, row.snapshotHash]);
    if (row.snapshotHash !== null && row.collectionStatus === 'observed') {
      row.duplicateOfEventId = snapshots.get(key) ?? null;
      if (!snapshots.has(key)) snapshots.set(key, row.eventId);
    }
    const versionKey = JSON.stringify([row.runId, row.sourceVersion]);
    const version = versions.get(versionKey) ?? { runId: row.runId, version: row.sourceVersion, eventIds: [] };
    version.eventIds.push(row.eventId); versions.set(versionKey, version);
  }
  const sourceVersions = [...versions.values()];
  for (const row of observations) {
    const known = sourceVersions.filter(version => version.runId === row.runId && version.version.sourceHash !== null);
    if (new Set(known.map(version => JSON.stringify(version.version))).size > 1) row.issues.push('run-product-source-version-mismatch');
  }
  return {
    version: 1, kind: 'cli-observations',
    counts: { events: observations.length, observed: observations.filter(row => row.collectionStatus === 'observed').length, unavailable: observations.filter(row => row.collectionStatus === 'unavailable').length, invalid: observations.filter(row => row.collectionStatus === 'invalid').length, duplicateSnapshots: observations.filter(row => row.duplicateOfEventId !== null).length },
    observations, sourceVersions, correlations: correlate(observations), productUsage: summarizeUsage(observations), cliTiming: timing(events),
    limitations: [
      'CLI values are product projections, not actual Provider wire requests, an exact prompt, or proof that a model read or understood any source.',
      'TurnContext exposes accepted reference metadata/revisions only; PM bodies and body truncation are not projected by this contract. Missing metadata remains unknown.',
      'Requested identities are kept separate from returned identities. Missing, unavailable, redacted and mismatched observations do not establish a match.',
      'Identical snapshots retain every source event ID but are not added together. Conflicting usage snapshots need distinct product updatedAt timestamps to select the newest.',
      'Product token categories, reportedTurn counters and context-window occupancy remain separate. Reasoning tokens are a subset of output; native input categories are not combined.',
      'Product estimated cost is nullable and is not billing. Snapshots are not summed across generations because native-turn/session overlap is not proved absent.',
      'CLI collection durations include service latency; pure process overhead and completeness of timing coverage remain unknown.',
      'Broker transport evidence, model usage and independent task grades retain authority for their own dimensions. This summary does not determine task success.',
    ],
  };
}
