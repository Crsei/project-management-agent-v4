import type { StudioExecutionRequest } from '../../../../../../packages/contracts/src/automation-studio.ts';
import { pmAutomationSnapshotSchema, pmAutomationResultSchema, validatePmAutomationResult, type PmAutomationResult, type PmAutomationSnapshot, type PmAutomationAgentEvidence } from '../../../../../../packages/contracts/src/automation-pm.ts';
import { automationExecutionHeaders, automationRequestFingerprint } from '../context.ts';
import { readRecord, writeRecord } from '../../durable/store.ts';
import { NativeTemplateUnknownOutcome, type NativeTemplateContext } from './ports.ts';
import { collectPmAgentEvidence } from './pm-evidence.ts';
import { collectPmPullRequestEvidence } from './pm-external.ts';
import { nativeHash } from './state.ts';

const namespace = 'pm-automation:pm-analysis-inputs';
type Journal = { fingerprint: string; agentEvidence?: PmAutomationAgentEvidence; snapshot?: PmAutomationSnapshot; result?: PmAutomationResult; publishAttempted?: boolean; published?: boolean };
function journal(request: StudioExecutionRequest): Journal {
  const prior = readRecord<Journal>(namespace, request.executionId);
  if (prior && prior.fingerprint !== automationRequestFingerprint(request)) throw new Error('PM analysis identity belongs to different immutable inputs.');
  return prior ?? { fingerprint: automationRequestFingerprint(request) };
}
function save(request: StudioExecutionRequest, value: Journal) { writeRecord(namespace, request.executionId, value); }
function endpoint(request: StudioExecutionRequest, operation: string): URL {
  const base = new URL(process.env.PM_API_URL ?? 'http://127.0.0.1:4194');
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' || !['http:', 'https:'].includes(base.protocol) || base.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('PM analysis requires a clean HTTPS or loopback PM API origin.');
  return new URL(`/api/v1/workspaces/${encodeURIComponent(request.workspaceId)}/automations/pm/executions/${encodeURIComponent(request.executionId)}/${operation}`, base);
}
async function call(request: StudioExecutionRequest, operation: string, signal: AbortSignal, body?: unknown): Promise<unknown | null> {
  const headers = automationExecutionHeaders(request); headers.set('content-type', 'application/json');
  const response = await fetch(endpoint(request, operation), { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]), redirect: 'error' });
  if (response.status === 404 && body === undefined) return null;
  if (!response.ok) throw Object.assign(new Error(`Authorized PM analysis ${operation} rejected (HTTP ${response.status}).`), { status: response.status });
  const reader = response.body?.getReader();
  if (!reader) throw new Error('PM analysis returned no response body.');
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('PM analysis response exceeds 4 MiB.'); } chunks.push(next.value); }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown;
}
function assertSnapshot(request: StudioExecutionRequest, snapshot: PmAutomationSnapshot): void {
  const action = request.config.action;
  if (action.kind !== 'template' || snapshot.executionId !== request.executionId || snapshot.templateId !== action.templateId || snapshot.actorId !== request.actorId || snapshot.workspaceId !== request.workspaceId || snapshot.projectId !== request.projectId || nativeHash(snapshot.args) !== nativeHash(action.arguments)) throw new Error('PM returned a different immutable analysis scope.');
}
export function preparedPmAutomationResult(request: StudioExecutionRequest): PmAutomationResult | undefined { return journal(request).result; }
export async function readAuthorizedPmAutomationSnapshot(request: StudioExecutionRequest, signal: AbortSignal): Promise<PmAutomationSnapshot> {
  const value = await call(request, 'snapshot', signal);
  if (!value) throw new Error('PM analysis Chat requires an existing authorized immutable PM snapshot.');
  const snapshot = pmAutomationSnapshotSchema.parse(value); assertSnapshot(request, snapshot);
  const frozen = journal(request).snapshot;
  if (frozen && nativeHash(frozen) !== nativeHash(snapshot)) throw new Error('Authorized PM analysis input no longer matches its original frozen snapshot.');
  return snapshot;
}
export function createPmAutomationBridge(context: NativeTemplateContext): NonNullable<NativeTemplateContext['pm']> {
  const { request, signal } = context;
  return {
    async snapshot() {
      let record = journal(request);
      const persisted = await call(request, 'snapshot', signal);
      if (persisted) {
        const snapshot = pmAutomationSnapshotSchema.parse(persisted); assertSnapshot(request, snapshot);
        if (record.snapshot && nativeHash(record.snapshot) !== nativeHash(snapshot)) throw new Error('PM attempted to replace the original immutable analysis snapshot.');
        record.snapshot = snapshot; save(request, record); return snapshot;
      }
      if (!record.agentEvidence) {
        const evidence = collectPmAgentEvidence(request);
        await collectPmPullRequestEvidence(context, evidence);
        record = journal(request); record.agentEvidence = evidence; save(request, record);
      }
      // PM owns the freeze. A lost response only resubmits identical captured read evidence.
      const snapshot = pmAutomationSnapshotSchema.parse(await call(request, 'snapshot', signal, { agentEvidence: record.agentEvidence }));
      assertSnapshot(request, snapshot);
      if (record.snapshot && nativeHash(record.snapshot) !== nativeHash(snapshot)) throw new Error('PM attempted to replace the original immutable analysis snapshot.');
      record.snapshot = snapshot; save(request, record); return snapshot;
    },
    async publish(value) {
      let record = journal(request);
      if (!record.snapshot) throw new Error('An authorized frozen PM snapshot is required before publishing.');
      const result = validatePmAutomationResult(record.snapshot, value);
      if (record.result && nativeHash(record.result) !== nativeHash(result)) throw new Error('Immutable PM analysis result cannot be replaced.');
      record.result = result; save(request, record);
      try {
        const prior = await call(request, 'result', signal);
        if (!prior) { record.publishAttempted = true; save(request, record); }
        const response = pmAutomationResultSchema.parse(prior ?? await call(request, 'result', signal, { result }));
        if (nativeHash(response) !== nativeHash(result)) throw new Error('PM returned a different immutable analysis result.');
        record = journal(request); record.published = true; save(request, record);
      } catch (error) {
        if (!record.publishAttempted && error && typeof error === 'object' && 'status' in error && Number(error.status) >= 400 && Number(error.status) < 500) throw error;
        throw new NativeTemplateUnknownOutcome('PM result publication is unconfirmed; reconcile the original execution and prepared immutable result.');
      }
    },
  };
}
