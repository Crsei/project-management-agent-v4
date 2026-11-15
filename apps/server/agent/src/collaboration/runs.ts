import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import type { UIMessage } from 'ai';
import {
  createRunSchema, delegationInputSchema,
  type AgentVersion, type CancelRun, type CollaborationDelegation, type CollaborationRun,
  type CollaborationRunStatus, type CreateRun, type DelegationAccepted, type DelegationInput, type RunResultReference,
} from '@agent-workspace/contracts/collaboration';
import type { PmToolCallRecord } from '@agent-workspace/contracts/pm-tools';
import type { AgentOutputSnapshot } from '@agent-workspace/contracts/output';
import { DurableError } from '../durable/errors.ts';
import { listRecords, readRecord, transaction, writeRecord } from '../durable/store.ts';
import { resolveAgentExecution, sameExecutionIdentity, type AgentExecutionSnapshot } from '../durable/agent-execution.ts';
import {
  cancelChat, getChatGeneration, isChatActive, lookupChatSubmission,
  startChatRuntime, submitChat, waitForChatTerminal, type ChatGeneration,
} from '../durable/chat-runtime.ts';
import { assertThreadWritable, ensureThread, getThread, getThreadBranch, updateThread, type ThreadMetadata } from '../durable/threads.ts';
import { getNativeOutput } from '../durable/native-output.ts';
import { collectPmContentProvenance, createPmVisibilityProjector, recordPmContentProvenance, type PmContentProvenance, type PmVisibilityProjector } from '../pm-visibility.ts';
import { resolveProviderRuntime } from '../providers/runtime.ts';
import { authorizePmTarget } from '../durable/pm-context.ts';
import { reconcilePmToolCall, subscribePmToolCalls } from '../pm-tools.ts';
import { assertDefinitionLaunchable } from './definitions.ts';
import { assertRunCapabilitiesCurrent, resolveRunCapabilityFacts } from './capabilities.ts';
import { authorizeCollaborationTarget, publishCollaborationComment, readCollaborationTaskBrief, reconcileCollaborationComment, type CollaborationCommentPublication } from './pm.ts';
import { COLLABORATION_DELEGATIONS, COLLABORATION_REQUESTS, COLLABORATION_RUNS, collaborationCoordinator } from './coordinator.ts';

const terminalStatuses: Record<string, true> = { succeeded: true, failed: true, cancelled: true, interrupted: true, unknown: true };
const now = () => new Date().toISOString();
const digest = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const stableId = (...parts: string[]) => {
  const hash = digest(parts);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};
const errorDetails = (error: unknown) => ({
  code: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'run_failed',
  message: error instanceof Error ? error.message : 'Run execution failed.',
});
export type CollaborationExecutionAdapters = { resolveProviderRuntime?: typeof resolveProviderRuntime };
type LiveRun = { headers: Headers; controller: AbortController; adapters: CollaborationExecutionAdapters; worker?: Promise<void>; timer?: NodeJS.Timeout };
const live = new Map<string, LiveRun>();
const threadRunIds = new Map<string, string>();
const admissions = new Set<Promise<void>>();
let started = false;
let stopping = false;

export function readCollaborationRun(id: string): CollaborationRun | null { return readRecord(COLLABORATION_RUNS, id); }

export function assertCollaborationApprovalNotCancelled(binding: { runId: string; rootRunId: string }): void {
  const original = readCollaborationRun(binding.runId);
  if (!original || original.rootRunId !== binding.rootRunId)
    throw new DurableError(409, 'approval_run_binding_missing', 'The original approval Run binding is unavailable or changed.');
  const seen = new Set<string>();
  let current: CollaborationRun | null = original;
  while (current) {
    if (seen.has(current.id)) throw new DurableError(409, 'approval_run_binding_invalid', 'The original Run ancestry is cyclic.');
    seen.add(current.id);
    if (current.cancellation || current.status === 'cancelled')
      throw new DurableError(409, 'collaboration_run_cancelled', 'The original Run or an ancestor was explicitly cancelled; the pending operation cannot be approved.');
    if (!current.parentRunId) break;
    current = readCollaborationRun(current.parentRunId);
    if (!current) throw new DurableError(409, 'approval_run_binding_missing', 'An original Run ancestor is unavailable.');
  }
  const root = readCollaborationRun(binding.rootRunId);
  if (!root || current?.id !== root.id) throw new DurableError(409, 'approval_run_binding_missing', 'The original root Run ancestry cannot be proven.');
  if (root.cancellation || root.status === 'cancelled')
    throw new DurableError(409, 'collaboration_run_cancelled', 'The original root Run was explicitly cancelled.');
}
export function listCollaborationRunsForInbox(): CollaborationRun[] { return listRecords<CollaborationRun>(COLLABORATION_RUNS); }
export function listCollaborationDelegations(runId: string): CollaborationDelegation[] {
  return listRecords<CollaborationDelegation>(COLLABORATION_DELEGATIONS).filter(item => item.parentRunId === runId || item.childRunId === runId);
}
function boundRun(threadId: string): CollaborationRun | null {
  const id = threadRunIds.get(threadId);
  const bound = id ? readCollaborationRun(id) : null;
  if (bound?.threadId === threadId) return bound;
  if (started) return null;
  // Standalone readers/tests may inspect retained history before runtime startup.
  const historical = listCollaborationRunsForInbox().find(item => item.threadId === threadId) ?? null;
  if (historical) threadRunIds.set(threadId, historical.id);
  return historical;
}

export async function projectCollaborationResultRefs(refs: RunResultReference[], rootRunId: string, headers: Headers): Promise<RunResultReference[]> {
  const projectors = new Map<string, Promise<PmVisibilityProjector>>();
  return Promise.all(refs.map(async reference => {
    const generation = getChatGeneration(reference.generationId);
    const sourceRun = generation ? boundRun(generation.threadId) : null;
    if (!generation || generation.threadId !== reference.threadId || !sourceRun || sourceRun.rootRunId !== rootRunId || !generationBelongs(sourceRun, generation))
      return { ...reference, summary: null, summarySource: null, outputItemIds: [], visibility: 'unavailable' as const };
    let projector = projectors.get(reference.threadId);
    if (!projector) { projector = createPmVisibilityProjector(reference.threadId, headers); projectors.set(reference.threadId, projector); }
    const projected = (await projector).generation({ id: reference.generationId, pmVisibility: undefined as string | undefined });
    if (projected.pmVisibility) return { ...reference, summary: null, summarySource: null, outputItemIds: [],
      visibility: projected.pmVisibility === 'redacted' ? 'redacted' as const : 'unavailable' as const };
    return { ...reference, visibility: 'visible' as const };
  }));
}

export async function getCollaborationNativeOutput(runId: string, generationId: string, headers: Headers): Promise<AgentOutputSnapshot> {
  const run = readCollaborationRun(runId);
  if (!run) throw new DurableError(404, 'run_not_found', 'Original Run is unavailable.');
  await authorizePmTarget({ workspaceId: run.target.workspaceId, projectId: run.target.projectId }, headers);
  const reference = run.resultRefs.find(item => item.generationId === generationId);
  const generation = getChatGeneration(generationId);
  const source = generation ? boundRun(generation.threadId) : null;
  if (!generation || !source || source.rootRunId !== run.rootRunId || !generationBelongs(source, generation) ||
      (!reference && run.generationId !== generationId) || reference && reference.threadId !== generation.threadId)
    throw new DurableError(404, 'run_evidence_not_found', 'This generation is not an exact retained result/current-generation reference owned by the requested Run.');
  const snapshot = getNativeOutput(generationId);
  if (!snapshot || snapshot.threadId !== generation.threadId)
    throw new DurableError(404, 'run_evidence_unavailable', 'The original native output evidence is unavailable; no output or Session was reconstructed.');
  const projector = await createPmVisibilityProjector(generation.threadId, headers);
  return projector.nativeSnapshot(snapshot);
}

export async function projectCollaborationRun(run: CollaborationRun, headers: Headers): Promise<CollaborationRun> {
  const resultRefs = await projectCollaborationResultRefs(run.resultRefs, run.rootRunId, headers);
  if (!run.error || !run.generationId || !run.threadId) return { ...run, resultRefs };
  const projector = await createPmVisibilityProjector(run.threadId, headers);
  const projected = projector.generation({ id: run.generationId, error: run.error, pmVisibility: undefined as string | undefined });
  return { ...run, resultRefs, error: projected.pmVisibility ? { code: run.error.code, message: 'Error details are currently hidden by the original PM visibility projector; the observed execution state is preserved.' } : run.error };
}

export function collaborationRunReadTargets(run: CollaborationRun): PmContentProvenance['targets'] {
  const handoff = readRecord<PmContentProvenance>(COLLABORATION_REQUESTS, `handoff:${run.id}`);
  return [{ workspaceId: run.target.workspaceId, projectId: run.target.projectId },
    ...(run.taskBrief?.sources ?? []).map(source => ({ workspaceId: source.workspaceId, projectId: source.projectId })), ...(handoff?.targets ?? [])];
}
export function collaborationDelegationReadTargets(id: string): PmContentProvenance['targets'] {
  return readRecord<PmContentProvenance>(COLLABORATION_REQUESTS, `delegation-source:${id}`)?.targets ?? [];
}
async function resultHandoffProvenance(refs: RunResultReference[], headers: Headers): Promise<PmContentProvenance> {
  const result: PmContentProvenance = { operationIds: [], targets: [], authorities: [] };
  for (const reference of refs) {
    if (reference.visibility !== 'visible' || !reference.messageId) continue;
    const projector = await createPmVisibilityProjector(reference.threadId, headers);
    const source = projector.visibleProvenance([reference.messageId]);
    result.operationIds.push(...source.operationIds); result.targets.push(...source.targets); result.authorities!.push(...source.authorities ?? []);
  }
  return result;
}

function waitForPmToolDecisions(run: CollaborationRun, operationIds: string[], signal: AbortSignal): Promise<PmToolCallRecord[]> {
  signal.throwIfAborted();
  const ids = new Set(operationIds);
  const { promise, resolve, reject } = Promise.withResolvers<PmToolCallRecord[]>();
  let unsubscribe = () => {};
  const cleanup = () => { unsubscribe(); signal.removeEventListener('abort', abort); };
  const abort = () => { cleanup(); reject(signal.reason ?? new Error('Original PM decision wait cancelled.')); };
  const check = () => {
    const records = operationIds.map(id => readRecord<{ record: PmToolCallRecord }>('pm-tool-calls', id)?.record);
    if (records.some(record => !record || record.threadId !== run.threadId)) { cleanup(); reject(new DurableError(409, 'pm_operation_unresolved', 'An original pending PM operation is missing or belongs to a different Session.')); return; }
    if (records.some(record => record!.status === 'pending_approval' || record!.status === 'running')) return;
    cleanup(); resolve(records as PmToolCallRecord[]);
  };
  unsubscribe = subscribePmToolCalls(change => { if (change.threadId === run.threadId && ids.has(change.operationId)) check(); });
  signal.addEventListener('abort', abort, { once: true });
  check();
  return promise;
}
function updateRun(id: string, change: Partial<CollaborationRun>): CollaborationRun {
  return transaction(() => {
    const current = readCollaborationRun(id);
    if (!current) throw new DurableError(404, 'run_not_found', 'Run not found.');
    const next = { ...current, ...change, id: current.id, revision: current.revision + 1, updatedAt: now() };
    writeRecord(COLLABORATION_RUNS, id, next);
    return next;
  });
}
function saveDelegation(record: CollaborationDelegation): void { writeRecord(COLLABORATION_DELEGATIONS, record.id, record); }
function credentials(headers: Headers): Headers {
  const result = new Headers();
  for (const key of ['cookie', 'authorization']) { const value = headers.get(key); if (value) result.set(key, value); }
  return result;
}
function primaryAgent(run: CollaborationRun): AgentVersion {
  const supervisor = run.teamVersion?.config.supervisorAgentId;
  const agent = supervisor ? run.agentVersions.find(item => item.agentId === supervisor) : run.agentVersions[0];
  if (!agent) throw new DurableError(409, 'run_snapshot_missing', 'Run has no fixed Agent version.');
  return agent;
}
function generationBelongs(run: CollaborationRun, generation: ChatGeneration): boolean {
  return run.threadId === generation.threadId && (run.generationId === generation.id || run.inputMessageId === generation.inputMessageId || run.resultRefs.some(item => item.generationId === generation.id));
}
export function getCollaborationGenerationContext(generationId: string) {
  const generation = getChatGeneration(generationId);
  if (!generation) return null;
  const run = boundRun(generation.threadId);
  if (!run || !generationBelongs(run, generation)) return null;
  const agent = primaryAgent(run);
  return { runId: run.id, rootRunId: run.rootRunId, agentId: agent.agentId, agentVersion: agent.version,
    delegationId: run.delegationId, target: run.target, threadId: generation.threadId, actorId: run.actorId,
    inputMessageId: generation.inputMessageId ?? null, capabilityBindings: agent.config.capabilityBindings };
}

export function assertCollaborationModelInput(generationId: string, actualPrompt: string): void {
  const context = getCollaborationGenerationContext(generationId);
  if (!context) return;
  const generation = getChatGeneration(generationId)!;
  const input = generation.request.messages.find(message => message.id === generation.inputMessageId);
  const text = input?.parts.filter(part => part.type === 'text').map(part => part.text).join('\n').trim();
  if (!text || !actualPrompt.includes(text))
    throw new DurableError(409, 'run_input_truncated', 'The native prompt cannot carry this complete fixed Run input. No partial brief or child handoff was executed.');
}

/** This synchronous fence runs in Chat's admission transaction after all async preflight. */
export function assertCollaborationChatAdmission(threadId: string, inputMessageId: string, submissionId?: string): void {
  const run = boundRun(threadId);
  if (!run) return;
  const control = live.get(run.id);
  if (stopping || !control || control.controller.signal.aborted || run.cancellation || terminalStatuses[run.status] ||
      Date.now() >= Date.parse(run.deadlineAt) || run.inputMessageId !== inputMessageId ||
      !run.operationRefs.some(operation => operation.kind === 'chat_acceptance' && operation.operationId === submissionId && operation.status === 'pending'))
    throw new DurableError(409, 'run_admission_fenced', 'Only the live server-owned Run input may be accepted; stopped history cannot be resumed through ordinary Chat.');
}

export function recordCollaborationOutput(generationId: string, text: string, streamId: string, incremental = false): void {
  const context = getCollaborationGenerationContext(generationId);
  if (!context) return;
  const run = readCollaborationRun(context.runId)!;
  const root = readCollaborationRun(run.rootRunId)!;
  const size = Buffer.byteLength(text);
  transaction(() => {
    const own = readRecord<{ bytes: number; streams?: Record<string, number> }>('collaboration:output-budgets:v1', run.id) ?? { bytes: 0 };
    const stream = `${generationId}:${streamId}`;
    const prior = own.streams?.[stream] ?? 0;
    const nextSize = incremental ? prior + size : size;
    const bytes = Math.max(0, nextSize - prior);
    if (!bytes) return;
    const rootBudget = run.id === root.id ? own : readRecord<{ bytes: number; streams?: Record<string, number> }>('collaboration:output-budgets:v1', root.id) ?? { bytes: 0 };
    if (own.bytes + bytes > run.resourceLimits.maxOutputBytes || rootBudget.bytes + bytes > root.resourceLimits.maxOutputBytes) {
      const error = new DurableError(409, 'output_limit', 'Shared Run tree output budget exhausted; Provider execution must stop.');
      live.get(run.id)?.controller.abort(error);
      throw error;
    }
    writeRecord('collaboration:output-budgets:v1', run.id, { bytes: own.bytes + bytes, streams: { ...own.streams, [stream]: nextSize } });
    if (run.id !== root.id) writeRecord('collaboration:output-budgets:v1', root.id, { ...rootBudget, bytes: rootBudget.bytes + bytes });
  });
}
/** A child may reuse only its root's server-owned scratch receipt, never a model/client cwd. */
function executionSessionId(run: CollaborationRun, fallback: string): string {
  if (run.executionSelection.agentWorkspaceId !== null || run.rootRunId === run.id) return fallback;
  const root = readCollaborationRun(run.rootRunId);
  if (!root?.threadId || !readRecord('agent:scratch:v1', root.threadId))
    throw new DurableError(409, 'root_directory_receipt_missing', 'Original root scratch identity is unavailable; no child directory is allocated or rebound.');
  return root.threadId;
}

export async function resolveCollaborationThreadScope(thread: ThreadMetadata, headers: Headers | undefined, purpose: 'execute' | 'inspect', signal?: AbortSignal): Promise<AgentExecutionSnapshot | null> {
  const run = boundRun(thread.remoteId);
  if (!run) return null;
  if (JSON.stringify(thread.executionSelection) !== JSON.stringify(run.executionSelection))
    throw new DurableError(409, 'run_selection_changed', 'The business Session directory selection differs from its immutable Run receipt.');
  if (purpose === 'execute') await assertCollaborationThreadExecution(thread.remoteId, headers, signal);
  else await authorizePmTarget({ workspaceId: run.target.workspaceId, projectId: run.target.projectId }, headers);
  const sessionId = executionSessionId(run, thread.remoteId);
  if (run.executionSelection.agentWorkspaceId === null && !readRecord('agent:scratch:v1', sessionId))
    throw new DurableError(409, 'root_directory_receipt_missing', 'Historical scratch receipt is missing; it cannot be recreated on inspection.');
  const actual = await resolveAgentExecution(run.executionSelection, sessionId, signal);
  const identity = await directoryIdentity(actual);
  if (!run.directoryIdentity || identity.path !== run.directoryIdentity.path || identity.device !== run.directoryIdentity.device || identity.inode !== run.directoryIdentity.inode ||
      !sameExecutionIdentity(run.executionEnvironment ?? undefined, actual.environment) ||
      thread.executionEnvironment?.frozen && (thread.executionPath !== actual.path || !sameExecutionIdentity(thread.executionEnvironment, actual.environment)))
    throw new DurableError(409, 'run_directory_changed', 'Current actual directory differs from the retained business Run identity.');
  return { ...actual, environment: { ...actual.environment, frozen: thread.executionEnvironment?.frozen ?? false } };
}

export async function assertCollaborationGenerationExecution(generationId: string, headers?: Headers, signal?: AbortSignal): Promise<void> {
  const context = getCollaborationGenerationContext(generationId);
  if (!context) throw new DurableError(409, 'collaboration_binding_missing', 'No server-owned active Run binding exists for this generation.');
  await assertCollaborationThreadExecution(context.threadId, headers, signal, generationId);
}
export async function assertCollaborationThreadExecution(threadId: string, headers?: Headers, signal?: AbortSignal, generationId?: string): Promise<void> {
  const run = boundRun(threadId);
  if (!run) return;
  const control = live.get(run.id);
  if (stopping || !control || control.controller.signal.aborted || run.cancellation || terminalStatuses[run.status] || Date.now() >= Date.parse(run.deadlineAt))
    throw new DurableError(409, 'run_not_executable', 'Business Run is stopped, interrupted, expired or requires original-result reconciliation; history cannot be replayed.');
  signal?.throwIfAborted();
  if (generationId) {
    const generation = getChatGeneration(generationId);
    if (!generation || !generationBelongs(run, generation)) throw new DurableError(409, 'run_generation_mismatch', 'Generation does not match the fixed Run input.');
  }
  const thread = assertThreadWritable(threadId);
  const fixedSettings = primaryAgent(run).config;
  if (thread.settings.providerInstanceId !== fixedSettings.providerInstanceId || thread.settings.model !== fixedSettings.model ||
      thread.settings.systemPrompt !== fixedSettings.instructions || thread.settings.temperature !== fixedSettings.temperature ||
      (thread.settings.interactionMode ?? 'default') !== fixedSettings.interactionMode ||
      JSON.stringify(thread.settings.modelOptions ?? []) !== JSON.stringify(fixedSettings.modelOptions))
    throw new DurableError(409, 'run_settings_changed', 'Session settings differ from the fixed Agent version; no in-flight configuration substitution is allowed.');
  // Immutable snapshots remain fixed; disabling a definition rejects new Runs, not an accepted generation.
  await authorizeCollaborationTarget(run.target, headers ?? control.headers, run.actorId);
  signal?.throwIfAborted();
  const actual = await resolveAgentExecution(run.executionSelection, executionSessionId(run, threadId), signal);
  const directory = await directoryIdentity(actual);
  if (!run.directoryIdentity || directory.path !== run.directoryIdentity.path || directory.device !== run.directoryIdentity.device || directory.inode !== run.directoryIdentity.inode ||
      !sameExecutionIdentity(run.executionEnvironment ?? undefined, actual.environment))
    throw new DurableError(409, 'run_directory_changed', 'Actual Run directory identity changed; no implicit rebind is permitted.');
  for (let index = 0; index < run.agentVersions.length; index++) {
    const agent = run.agentVersions[index]!;
    const manifest = run.capabilityManifests[index];
    if (!manifest || manifest.providerInstanceId !== agent.config.providerInstanceId) throw new DurableError(409, 'capability_snapshot_missing', 'Run capability manifest is missing.');
    await assertRunCapabilitiesCurrent(manifest, { providerInstanceId: agent.config.providerInstanceId, capabilityBindings: agent.config.capabilityBindings,
      workspaceId: run.target.workspaceId, projectId: run.target.projectId, headers: headers ?? control.headers });
  }
  const latest = readCollaborationRun(run.id);
  if (!latest || latest.cancellation || terminalStatuses[latest.status] || control.controller.signal.aborted || stopping)
    throw new DurableError(409, 'run_not_executable', 'Run stopped while checking current execution authority.');
}
async function directoryIdentity(snapshot: AgentExecutionSnapshot) {
  const path = await realpath(snapshot.path);
  const identity = await stat(path, { bigint: true });
  if (!identity.isDirectory()) throw new DurableError(409, 'run_directory_invalid', 'Selected Run directory is not a directory.');
  return { path, device: identity.dev.toString(), inode: identity.ino.toString() };
}

export async function startCollaborationRuntime(options: { newLifecycle?: boolean } = {}): Promise<void> {
  if (started) return;
  if (stopping) {
    if (!options.newLifecycle) return;
    if (admissions.size || live.size) throw new DurableError(503, 'collaboration_stopping', 'The previous lifecycle has not drained.');
    stopping = false;
  }
  started = true;
  for (const run of listCollaborationRunsForInbox()) {
    if (run.threadId) threadRunIds.set(run.threadId, run.id);
    if (terminalStatuses[run.status]) continue;
    updateRun(run.id, { status: 'interrupted', finishedAt: now(), wait: null,
      error: { code: 'restart_reconciliation_required', message: 'Service restarted. Original Chat/PM receipts remain readable; no directory/native rebinding or automatic replay is allowed.' } });
  }
  for (const delegation of listRecords<CollaborationDelegation>(COLLABORATION_DELEGATIONS)) {
    if (terminalStatuses[delegation.status]) continue;
    saveDelegation({ ...delegation, status: 'interrupted', updatedAt: now(), finishedAt: now(), error: { code: 'restart_reconciliation_required', message: 'Original child must be reconciled; no automatic replay.' } });
  }
}
export function stopCollaborationRuntime(): Promise<void> {
  stopping = true; // Synchronous admission fence, including before startup has finished.
  for (const control of live.values()) control.controller.abort(new DurableError(503, 'server_shutdown', 'Agent service stopped; no automatic replay is permitted.'));
  return Promise.all(admissions).then(async () => {
    const workers = [...live.values()].flatMap(control => control.worker ? [control.worker] : []);
    await Promise.allSettled(workers);
    started = false;
  });
}

function requestKey(input: CreateRun): string { return digest([input.target.workspaceId, input.requestId]); }
function originalRun(input: CreateRun, fingerprint: string): CollaborationRun | null {
  const receipt = readRecord<{ runId: string; fingerprint: string }>(COLLABORATION_REQUESTS, requestKey(input));
  const byId = readCollaborationRun(input.id);
  if (receipt && (receipt.fingerprint !== fingerprint || receipt.runId !== input.id) || byId && byId.requestFingerprint !== fingerprint)
    throw new DurableError(409, 'run_idempotency_conflict', 'The original Run/request identity is bound to different input.');
  if (receipt && !byId) throw new DurableError(409, 'run_receipt_unknown', 'Original Run receipt exists but its retained execution record is unavailable; never resubmit it.');
  return byId;
}
export async function createCollaborationRun(value: CreateRun, headers: Headers, adapters: CollaborationExecutionAdapters = {}): Promise<CollaborationRun> {
  const input = createRunSchema.parse(value);
  if (stopping) throw new DurableError(503, 'collaboration_stopping', 'Collaboration execution is stopping.');
  const admission = Promise.withResolvers<void>();
  admissions.add(admission.promise);
  try {
  await startChatRuntime();
  await startCollaborationRuntime();
  const authority = await authorizeCollaborationTarget(input.target, headers);
  const fingerprint = digest(input);
  if (stopping) throw new DurableError(503, 'collaboration_stopping', 'Collaboration stopped during authorization.');
  const existing = originalRun(input, fingerprint);
  if (existing) { if (existing.actorId !== authority.actorId) throw new DurableError(403, 'run_actor_mismatch', 'Original Run belongs to a different originating PM actor.'); return existing; }
  const fixed = assertDefinitionLaunchable(input.definition, input.target.workspaceId, input.target.projectId);
  if (fixed.executionMode === 'read-only') throw new DurableError(412, 'execution_mode_unsupported', 'The selected native Provider has no proven per-Run read-only enforcement. Choose an explicit write-capable execution; a prompt is not a sandbox.');
  if (fixed.teamVersion?.config.strategy === 'sequential' && fixed.teamVersion.config.members.length > 1 && fixed.resourceLimits.maxDelegationDepth < 1)
    throw new DurableError(409, 'team_depth_limit', 'Sequential Team requires depth for its fixed member Runs.');
  const createdAt = now();
  const root: CollaborationRun = {
    id: input.id, requestId: input.requestId, requestFingerprint: fingerprint, revision: 1, target: input.target, definition: input.definition,
    goal: input.goal, input: input.input, actorId: authority.actorId, rootRunId: input.id, parentRunId: null, delegationId: null, depth: 0,
    status: 'queued', createdAt, updatedAt: createdAt, startedAt: null, finishedAt: null,
    deadlineAt: new Date(Date.now() + fixed.resourceLimits.maxDurationMs).toISOString(), executionSelection: input.executionSelection,
    executionEnvironment: null, directoryIdentity: null, ...fixed, capabilityManifests: [], taskBrief: null,
    threadId: null, generationId: null, inputMessageId: null, operationRefs: [], resultRefs: [], wait: null, error: null, cancellation: null,
  };
  const reserved = transaction(() => {
    const duplicate = originalRun(input, fingerprint);
    if (stopping) throw new DurableError(503, 'collaboration_stopping', 'Collaboration is stopping.');
    assertDefinitionLaunchable(input.definition, input.target.workspaceId, input.target.projectId);
    if (duplicate) return duplicate;
    writeRecord(COLLABORATION_RUNS, root.id, root);
    writeRecord(COLLABORATION_REQUESTS, requestKey(input), { runId: root.id, fingerprint });
    return root;
  });
  if (reserved !== root) return reserved;
  const control = attachLive(root.id, headers, adapters);
  beginRunWorker(root.id, control);
  return readCollaborationRun(root.id)!;
  } finally { admissions.delete(admission.promise); admission.resolve(); }
}
function attachLive(id: string, headers: Headers, adapters: CollaborationExecutionAdapters): LiveRun {
  const control: LiveRun = { headers: credentials(headers), controller: new AbortController(), adapters };
  live.set(id, control);
  const run = readCollaborationRun(id)!;
  control.timer = setTimeout(() => {
    void cancelTree(id, run.actorId, 'duration_limit').catch(error => finishRun(id, 'unknown', errorDetails(error)));
  }, Math.max(1, Date.parse(run.deadlineAt) - Date.now()));
  control.timer.unref();
  return control;
}
function detachLive(id: string): void {
  const control = live.get(id);
  if (control?.timer) clearTimeout(control.timer);
  live.delete(id);
}
async function prepareRun(run: CollaborationRun, control: LiveRun): Promise<void> {
  control.controller.signal.throwIfAborted();
  const { brief, actorId } = await readCollaborationTaskBrief(run.target, control.headers);
  if (actorId !== run.actorId) throw new DurableError(403, 'run_actor_changed', 'Current PM identity differs from the initiating actor.');
  let inputBrief = brief;
  const threadId = run.threadId ?? stableId('run-thread', run.id);
  const snapshot = await resolveAgentExecution(run.executionSelection, executionSessionId(run, threadId), control.controller.signal);
  const directory = await directoryIdentity(snapshot);
  const manifests: CollaborationRun['capabilityManifests'] = [];
  for (const agent of run.agentVersions) {
    if (agent.config.executionMode === 'read-only') throw new DurableError(412, 'execution_mode_unsupported', 'This Provider cannot enforce the fixed read-only Agent mode.');
    const runtime = await (control.adapters.resolveProviderRuntime ?? resolveProviderRuntime)({ providerInstanceId: agent.config.providerInstanceId, modelName: agent.config.model });
    const manifest = await resolveRunCapabilityFacts({ providerInstanceId: agent.config.providerInstanceId, capabilityBindings: agent.config.capabilityBindings,
      workspaceId: run.target.workspaceId, projectId: run.target.projectId, headers: control.headers });
    if (manifest.providerRevision !== runtime.instanceRevision) throw new DurableError(409, 'provider_revision_changed', 'Provider changed while freezing the Run.');
    manifests.push(manifest);
  }
  if (run.parentRunId) {
    const root = readCollaborationRun(run.rootRunId)!;
    if (!root.taskBrief || digest({ ...root.taskBrief, generatedAt: null }) !== digest({ ...brief, generatedAt: null }))
      throw new DurableError(409, 'task_brief_changed', 'The complete task input or one of its source versions changed before the child launch. No new brief is silently substituted.');
    inputBrief = root.taskBrief;
    for (let index = 0; index < run.agentVersions.length; index++) {
      const agent = run.agentVersions[index]!;
      const fixedIndex = root.agentVersions.findIndex(item => item.agentId === agent.agentId && item.version === agent.version);
      const fixedManifest = fixedIndex >= 0 ? root.capabilityManifests[fixedIndex] : undefined;
      if (fixedManifest && fixedManifest.fingerprint !== manifests[index]?.fingerprint)
        throw new DurableError(409, 'team_capability_drift', 'Fixed Team member capability/Provider evidence changed before its later node launch.');
    }
    if (root.directoryIdentity && (directory.path !== root.directoryIdentity.path || directory.device !== root.directoryIdentity.device || directory.inode !== root.directoryIdentity.inode))
      throw new DurableError(409, 'child_directory_changed', 'Child directory differs from the root fixed actual directory.');
  }
  control.controller.signal.throwIfAborted();
  const latest = readCollaborationRun(run.id)!;
  if (latest.cancellation || stopping) throw new DurableError(409, 'run_cancelled', 'Run cancelled during admission.');
  transaction(() => {
    if (getThread(threadId) && !run.threadId)
      throw new DurableError(409, 'run_thread_identity_conflict', 'The reserved Run Session identity already exists; an unrelated Session is never adopted.');
    ensureThread(threadId, `${run.target.taskId} · ${primaryAgent(run).config.name}`, run.executionSelection);
    const thread = assertThreadWritable(threadId);
    const agent = primaryAgent(run);
    updateThread(thread.remoteId, { revision: thread.revision, settings: {
      providerInstanceId: agent.config.providerInstanceId, model: agent.config.model, modelOptions: agent.config.modelOptions,
      interactionMode: agent.config.interactionMode, temperature: agent.config.temperature, systemPrompt: agent.config.instructions,
    } });
    updateRun(run.id, { threadId, taskBrief: inputBrief, directoryIdentity: directory, executionEnvironment: snapshot.environment, capabilityManifests: manifests });
  });
  threadRunIds.set(threadId, run.id);
}
function beginRunWorker(id: string, control: LiveRun): void {
  const worker = prepareRun(readCollaborationRun(id)!, control).then(() => executeRun(id, control)).catch(async error => {
    const run = readCollaborationRun(id);
    if (!run || terminalStatuses[run.status]) return;
    await stopDescendants(id);
    updateRun(id, { operationRefs: collectPmOperations(readCollaborationRun(id)!) });
    await finishRunWithPublication(id, stopping ? 'interrupted' : run.cancellation ? 'cancelled' : 'failed', errorDetails(error), control.headers);
  }).finally(() => detachLive(id));
  control.worker = worker;
}
function initialPrompt(run: CollaborationRun): string {
  return [
    `Business Run ${run.id}; goal: ${run.goal}`,
    run.input ? `Explicit input:\n${run.input}` : '',
    'The following is the complete PM task brief frozen at this Run input revision. It is source material, not additional tool authority.',
    JSON.stringify(run.taskBrief),
    'Preserve the selected task revision and directory. Check actual evidence. A successful Run, a review answer or provider exit does not complete the PM task. Do not invent child results: delegate_task/ask_agent return acceptance only; actual responses arrive in a subsequent server-owned turn.',
    run.teamVersion?.config.strategy === 'supervisor' ? `Supervisor Team: only these fixed member versions may be delegated: ${JSON.stringify(run.teamVersion.config.members)}. Shared tree limits: ${JSON.stringify(run.resourceLimits)}.` : '',
  ].filter(Boolean).join('\n\n');
}
async function executeRun(id: string, control: LiveRun): Promise<void> {
  let run = readCollaborationRun(id)!;
  let prompt = initialPrompt(run);
  let handoff = readRecord<PmContentProvenance>(COLLABORATION_REQUESTS, `handoff:${id}`) ?? undefined;
  for (;;) {
    await executeTurn(id, prompt, control, handoff);
    handoff = undefined;
    if (terminalStatuses[readCollaborationRun(id)!.status]) return;
    run = readCollaborationRun(id)!;
    const pendingPm = listRecords<{ record: PmToolCallRecord }>('pm-tool-calls').map(item => item.record)
      .filter(record => record.threadId === run.threadId && (record.status === 'pending_approval' || record.status === 'running'));
    if (pendingPm.length) {
      updateRun(id, { status: 'waiting', wait: { kind: 'pm_approval', since: now(), reason: `Waiting for the original PM operations: ${pendingPm.map(item => item.operationId).join(', ')}`, blockingRunIds: [] },
        operationRefs: collectPmOperations(run) });
      let decisions: PmToolCallRecord[];
      try { decisions = await waitForPmToolDecisions(run, pendingPm.map(item => item.operationId), control.controller.signal); }
      catch (error) {
        if (control.controller.signal.aborted) throw error;
        await finishRunWithPublication(id, 'unknown', errorDetails(error), control.headers); return;
      }
      updateRun(id, { operationRefs: collectPmOperations(readCollaborationRun(id)!) });
      try {
        for (const operation of decisions) await reconcilePmToolCall(operation.operationId, control.headers);
      } catch (error) {
        await finishRunWithPublication(id, 'unknown', errorDetails(error), control.headers); return;
      }
      decisions = decisions.map(operation => readRecord<{ record: PmToolCallRecord }>('pm-tool-calls', operation.operationId)?.record ?? operation);
      updateRun(id, { operationRefs: collectPmOperations(readCollaborationRun(id)!) });
      await assertCollaborationThreadExecution(run.threadId!, control.headers, control.controller.signal);
      if (decisions.some(item => item.status === 'unknown')) {
        await finishRunWithPublication(id, 'unknown', { code: 'pm_outcome_unresolved', message: 'An original PM operation is unresolved; only its original receipt can be reconciled. No follow-up was dispatched.' }, control.headers); return;
      }
      const projector = await createPmVisibilityProjector(run.threadId!, control.headers);
      const ids = new Set(decisions.map(item => item.operationId));
      const projected = projector.calls.filter(item => ids.has(item.operationId));
      handoff = projector.visibleProvenance(decisions.map(item => item.messageId));
      handoff.operationIds.push(...projected.filter(item => item.visibility === 'visible').map(item => item.operationId));
      prompt = `Actual observed decisions for the exact original PM operations (not permission for a new operation and not task completion):\n${JSON.stringify(projected)}`;
      continue;
    }
    const pending = listRecords<CollaborationDelegation>(COLLABORATION_DELEGATIONS).filter(item => item.parentRunId === id && item.childRunId !== null && !item.responsePublishedAt);
    if (!pending.length) break;
    updateRun(id, { status: 'waiting', wait: { kind: 'children', since: now(), reason: 'Waiting for accepted child Runs to reach observed terminal states.', blockingRunIds: pending.flatMap(item => item.childRunId ? [item.childRunId] : []) } });
    for (const delegation of pending) if (delegation.childRunId) await waitForCollaborationRunTerminal(delegation.childRunId, control.controller.signal);
    await assertCollaborationThreadExecution(run.threadId!, control.headers, control.controller.signal);
    const originals = pending.map(item => readRecord<CollaborationDelegation>(COLLABORATION_DELEGATIONS, item.id)!);
    const responses = await Promise.all(originals.map(async item => {
      const results = await projectCollaborationResultRefs(item.resultRefs, run.rootRunId, control.headers);
      return { delegationId: item.id, childRunId: item.childRunId, kind: item.kind, status: item.status, results,
        error: item.error && results.some(result => result.visibility !== 'visible') ? { code: item.error.code, message: 'Child error details are currently hidden by the original PM visibility projector.' } : item.error };
    }));
    handoff = await resultHandoffProvenance(responses.flatMap(item => item.results), control.headers);
    prompt = `Actual server-observed child responses (not task completion):\n${JSON.stringify(responses)}`;
    for (const item of originals) saveDelegation({ ...item, responsePublishedAt: now(), updatedAt: now() });
  }
  run = readCollaborationRun(id)!;
  if (run.teamVersion?.config.strategy === 'sequential') {
    const first = primaryAgent(run);
    for (const member of run.teamVersion.config.members.filter(item => item.agentId !== first.agentId)) {
      await assertCollaborationThreadExecution(run.threadId!, control.headers, control.controller.signal);
      const prior = readCollaborationRun(id)!;
      const visibleResults = await projectCollaborationResultRefs(prior.resultRefs, prior.rootRunId, control.headers);
      const inherited = await resultHandoffProvenance(visibleResults, control.headers);
      const accepted = await acceptDelegation(prior, prior.generationId!, `sequential:${member.agentId}:${member.agentVersion}`, 'delegate_task', {
        ...member, goal: run.goal, input: JSON.stringify({ originalInput: run.input, priorResults: visibleResults }),
      }, control, true, inherited);
      updateRun(id, { status: 'waiting', wait: { kind: 'children', since: now(), reason: 'Sequential Team member is executing the fixed prior result handoff.', blockingRunIds: [accepted.childRunId] } });
      const child = await waitForCollaborationRunTerminal(accepted.childRunId, control.controller.signal);
      if (child.status !== 'succeeded') throw new DurableError(409, 'sequential_member_failed', `Team member Run ${child.id} ended ${child.status}; later members were not dispatched.`);
      const current = readCollaborationRun(id)!;
      updateRun(id, { resultRefs: [...current.resultRefs, ...child.resultRefs] });
      const delegation = readRecord<CollaborationDelegation>(COLLABORATION_DELEGATIONS, accepted.delegationId)!;
      saveDelegation({ ...delegation, responsePublishedAt: now(), updatedAt: now() });
    }
  }
  run = readCollaborationRun(id)!;
  const children = listRecords<CollaborationDelegation>(COLLABORATION_DELEGATIONS).filter(item => item.parentRunId === id && (item.required || item.kind === 'delegate_task'));
  const unsuccessful = children.find(item => item.status !== 'succeeded');
  if (unsuccessful) { await finishRunWithPublication(id, unsuccessful.status === 'unknown' || unsuccessful.status === 'interrupted' ? 'unknown' : 'failed', { code: 'required_child_incomplete', message: `Delegation ${unsuccessful.id}${unsuccessful.childRunId ? ` / child ${unsuccessful.childRunId}` : ' (rejected before child acceptance)'} ended ${unsuccessful.status}.` }, control.headers); return; }
  const operations = collectPmOperations(run);
  if (operations.some(item => item.status === 'unknown' || item.status === 'pending')) {
    updateRun(id, { operationRefs: operations });
    await finishRunWithPublication(id, 'unknown', { code: 'pm_outcome_unresolved', message: 'Original PM operations remain unresolved; reconcile them without re-dispatch.' }, control.headers);
    return;
  }
  updateRun(id, { operationRefs: operations });
  await finishRunWithPublication(id, 'succeeded', null, control.headers);
}
async function executeTurn(id: string, prompt: string, control: LiveRun, handoff?: PmContentProvenance): Promise<void> {
  let run = readCollaborationRun(id)!;
  if (!run.directoryIdentity || !run.threadId) throw new DurableError(409, 'run_snapshot_missing', 'Run has no actual directory snapshot.');
  updateRun(id, { status: 'queued', wait: { kind: 'workspace_writer', since: now(), reason: 'Awaiting the shared actual-directory writer and root concurrency lease.', blockingRunIds: listCollaborationRunsForInbox().filter(item => item.id !== id && item.status === 'running' && item.directoryIdentity?.path === run.directoryIdentity!.path).map(item => item.id) } });
  const leaseAgent = primaryAgent(run);
  const release = await collaborationCoordinator.acquire(id, run.directoryIdentity.path, run.rootRunId, run.resourceLimits.maxActiveRuns, control.controller.signal,
    { id: `${run.target.workspaceId}:${leaseAgent.agentId}`, maxActiveRuns: leaseAgent.config.resourceLimits.maxActiveRuns });
  try {
    await assertCollaborationThreadExecution(run.threadId, control.headers, control.controller.signal);
    run = readCollaborationRun(id)!;
    const agent = primaryAgent(run);
    const runtime = await (control.adapters.resolveProviderRuntime ?? resolveProviderRuntime)({ providerInstanceId: agent.config.providerInstanceId, modelName: agent.config.model });
    const manifest = run.capabilityManifests.find(item => item.providerInstanceId === runtime.providerInstanceId);
    if (!manifest || runtime.instanceRevision !== manifest.providerRevision) throw new DurableError(409, 'provider_revision_changed', 'Fixed Run Provider revision is no longer executable.');
    const turn = run.operationRefs.filter(item => item.kind === 'chat_acceptance').length;
    const key = `collaboration:${id}:turn:${turn}`;
    const inputMessageId = stableId('run-input', key);
    const thread = assertThreadWritable(run.threadId!);
    const message: UIMessage = { id: inputMessageId, role: 'user', parts: [{ type: 'text', text: prompt }] };
    updateRun(id, { inputMessageId, status: 'running', startedAt: run.startedAt ?? now(), wait: null,
      operationRefs: [...run.operationRefs, { operationId: key, kind: 'chat_acceptance', status: 'pending', commandId: null }] });
    const targets = [...new Map([{ workspaceId: run.target.workspaceId, projectId: run.target.projectId }, ...(run.taskBrief?.sources ?? []).map(source => ({ workspaceId: source.workspaceId, projectId: source.projectId }))].map(target => [`${target.workspaceId}:${target.projectId}`, target])).values()];
    let accepted: ChatGeneration;
    try {
      accepted = await submitChat({ id: run.threadId!, idempotencyKey: key, trigger: 'submit-message',
        messages: [...getThreadBranch(run.threadId!).map(entry => ({ id: entry.id, ...entry.content }) as UIMessage), message],
        pmReferences: [{ workspaceId: run.target.workspaceId, projectId: run.target.projectId, kind: 'issue', id: run.target.taskId, revision: run.target.taskRevision }],
        config: { providerInstanceId: agent.config.providerInstanceId, modelName: agent.config.model, modelOptions: agent.config.modelOptions,
          interactionMode: agent.config.interactionMode, threadSettingsRevision: thread.revision } }, runtime, control.headers, undefined, {
        onAccepted: generation => {
          recordPmContentProvenance({ threadId: generation.threadId, generationId: generation.id, messageIds: [inputMessageId],
            operationIds: handoff?.operationIds ?? [], targets: [...targets, ...(handoff?.targets ?? [])],
            authorities: [...targets.map(target => ({ actorId: run.actorId, target })), ...(handoff?.authorities ?? [])] });
          const current = readCollaborationRun(id)!;
          updateRun(id, { generationId: generation.id, operationRefs: current.operationRefs.map(operation => operation.operationId === key ? { ...operation, status: 'succeeded' } : operation) });
        },
      });
    } catch (error) {
      const receipt = lookupChatSubmission(run.threadId!, key);
      if (receipt.status === 'accepted' && receipt.generationId) accepted = getChatGeneration(receipt.generationId)!;
      else {
        const current = readCollaborationRun(id)!;
        updateRun(id, { operationRefs: current.operationRefs.map(item => item.operationId === key ? { ...item, status: receipt.status === 'not_accepted' ? 'failed' : 'unknown' } : item) });
        if (receipt.status === 'unknown') { finishRun(id, 'unknown', { code: 'chat_acceptance_unknown', message: 'Original Chat acceptance is unresolved; only query its original key.' }); return; }
        throw error;
      }
    }
    run = readCollaborationRun(id)!;
    if (turn === 0) await publishStage(readCollaborationRun(id)!, 'started', control.headers);
    let completed: ChatGeneration;
    try { completed = await waitForChatTerminal(accepted.id, control.controller.signal); }
    catch (error) { await cancelChat(accepted.id); const terminal = getChatGeneration(accepted.id); if (!terminal || isChatActive(terminal)) throw new DurableError(409, 'cancel_unobserved', 'Provider stop is not yet observed.'); throw error; }
    const result = generationResult(completed);
    run = readCollaborationRun(id)!;
    if (!run.resultRefs.some(item => item.generationId === completed.id)) updateRun(id, { resultRefs: [...run.resultRefs, result] });
    if (completed.status !== 'completed') throw new DurableError(409, `generation_${completed.status}`, completed.error ?? `Provider generation ended ${completed.status}.`);
    await assertCollaborationThreadExecution(run.threadId!, control.headers, control.controller.signal, completed.id);
    const bytes = Buffer.byteLength(JSON.stringify(readCollaborationRun(id)!.resultRefs));
    const treeBytes = listCollaborationRunsForInbox().filter(item => item.rootRunId === run.rootRunId).reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item.resultRefs)), 0);
    if (bytes > run.resourceLimits.maxOutputBytes || treeBytes > readCollaborationRun(run.rootRunId)!.resourceLimits.maxOutputBytes)
      throw new DurableError(409, 'output_limit', 'Shared Run tree result budget was exhausted.');
  } finally { release(); }
}
function generationResult(generation: ChatGeneration): RunResultReference {
  const output = getNativeOutput(generation.id);
  const assistantItems = output?.items.filter(item => item.type === 'assistant_message') ?? [];
  const finalItems = assistantItems.filter(item => item.phase === 'final_answer');
  const text = (finalItems.length ? finalItems : assistantItems).map(item => item.text ?? '').join('\n').trim() ||
    (assistantItems.length === 0 ? generation.output?.parts.filter(part => part.type === 'text').map(part => part.text).join('\n').trim() ?? '' : '');
  const summary = text ? text.slice(0, 16000) : null;
  return { threadId: generation.threadId, generationId: generation.id, messageId: generation.output?.id ?? null,
    outputItemIds: output?.items.map(item => item.id) ?? [], summary, summarySource: summary ? finalItems.length ? 'assistant_final' : 'assistant_output' : null };
}
function collectPmOperations(run: CollaborationRun): CollaborationRun['operationRefs'] {
  const refs = run.operationRefs.filter(item => item.kind !== 'pm_tool');
  for (const item of listRecords<{ record: PmToolCallRecord }>('pm-tool-calls')) {
    if (item.record.threadId !== run.threadId) continue;
    refs.push({ operationId: item.record.operationId, kind: 'pm_tool', status: item.record.status === 'succeeded' ? 'succeeded' : item.record.status === 'failed' ? 'failed' : item.record.status === 'unknown' ? 'unknown' : 'pending', commandId: null });
  }
  return refs;
}
function finishRun(id: string, status: CollaborationRunStatus, error: CollaborationRun['error'] = null): void {
  const current = readCollaborationRun(id);
  if (!current || terminalStatuses[current.status]) return;
  if (status !== 'unknown' && (current.cancellation || stopping)) {
    status = stopping ? 'interrupted' : 'cancelled';
    const reason: unknown = live.get(id)?.controller.signal.reason;
    if (reason) error = errorDetails(reason);
  }
  const next = updateRun(id, { status, error, wait: null, finishedAt: now(), cancellation: current.cancellation ? {
    ...current.cancellation, observedAt: status === 'cancelled' || status === 'interrupted' ? now() : current.cancellation.observedAt,
  } : null });
  if (next.delegationId) {
    const delegation = readRecord<CollaborationDelegation>(COLLABORATION_DELEGATIONS, next.delegationId);
    if (delegation) saveDelegation({ ...delegation, status, error, resultRefs: next.resultRefs, updatedAt: now(), finishedAt: now() });
  }
  notifyRun(id);
}
const observers = new Map<string, Set<() => void>>();
function notifyRun(id: string): void { for (const listener of observers.get(id) ?? []) listener(); }
export function waitForCollaborationRunTerminal(id: string, signal?: AbortSignal): Promise<CollaborationRun> {
  signal?.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<CollaborationRun>();
  const listeners = observers.get(id) ?? new Set<() => void>();
  observers.set(id, listeners);
  const cleanup = () => { listeners.delete(check); if (!listeners.size) observers.delete(id); signal?.removeEventListener('abort', abort); };
  const abort = () => { cleanup(); reject(signal?.reason ?? new Error('Run wait cancelled.')); };
  const check = () => { const run = readCollaborationRun(id); if (!run) { cleanup(); reject(new DurableError(404, 'run_not_found', 'Original child Run not found.')); } else if (terminalStatuses[run.status]) { cleanup(); resolve(run); } };
  listeners.add(check); signal?.addEventListener('abort', abort, { once: true }); check();
  return promise;
}

export async function invokeCollaborationTool(input: { generationId: string; callId: string; tool: 'delegate_task' | 'ask_agent'; arguments: unknown; headers?: Headers }): Promise<DelegationAccepted> {
  const context = getCollaborationGenerationContext(input.generationId);
  if (!context) throw new DurableError(409, 'collaboration_binding_missing', 'Delegation requires a server-owned parent Run.');
  const parent = readCollaborationRun(context.runId)!;
  const control = live.get(parent.id);
  if (!control) throw new DurableError(409, 'run_interrupted', 'Parent Run has no live credentials; no replay is allowed.');
  const generation = getChatGeneration(input.generationId);
  if (!generation || generation.status !== 'running') throw new DurableError(409, 'parent_generation_inactive', 'Delegation belongs to the original active parent generation only.');
  const agent = primaryAgent(parent);
  if (!agent.config.capabilityBindings.hostTools.includes(input.tool)) throw new DurableError(403, 'delegation_not_bound', 'The fixed Agent did not bind this collaboration host tool.');
  await assertCollaborationGenerationExecution(input.generationId, input.headers ?? control.headers);
  return acceptDelegation(parent, input.generationId, input.callId, input.tool, delegationInputSchema.parse(input.arguments), control, false);
}
async function acceptDelegation(parent: CollaborationRun, generationId: string, callId: string, kind: 'delegate_task' | 'ask_agent', value: DelegationInput, control: LiveRun, sequential: boolean, handoff?: PmContentProvenance): Promise<DelegationAccepted> {
  const input = delegationInputSchema.parse(value);
  const fingerprint = digest({ kind, input });
  const id = stableId('delegation', parent.id, generationId, callId);
  try {
  const original = readRecord<CollaborationDelegation>(COLLABORATION_DELEGATIONS, id);
  if (original) {
    if (original.requestFingerprint !== fingerprint) throw new DurableError(409, 'delegation_idempotency_conflict', 'Original tool call ID is bound to different delegation input.');
    return delegationReceipt(original);
  }
  const parentGeneration = getChatGeneration(generationId);
  if (!parentGeneration || parentGeneration.threadId !== parent.threadId)
    throw new DurableError(409, 'parent_generation_mismatch', 'The original delegation does not belong to the actual parent generation.');
  const inherited = collectPmContentProvenance(parentGeneration.threadId, [parentGeneration.messageId, parentGeneration.inputMessageId ?? '']);
  const source: PmContentProvenance = { operationIds: [...inherited.operationIds, ...(handoff?.operationIds ?? [])],
    targets: [...inherited.targets, ...(handoff?.targets ?? [])], authorities: [...(inherited.authorities ?? []), ...(handoff?.authorities ?? [])] };
  transaction(() => {
    if (!readRecord(COLLABORATION_REQUESTS, `delegation-source:${id}`)) writeRecord(COLLABORATION_REQUESTS, `delegation-source:${id}`, source);
  });
  if (!sequential) {
    const projector = await createPmVisibilityProjector(parentGeneration.threadId, control.headers);
    const visible = projector.generation({ id: generationId, pmVisibility: undefined as string | undefined });
    if (visible.pmVisibility) throw new DurableError(403, 'delegation_source_unavailable', 'The parent source content is no longer currently visible; no child input was copied.');
  }
  const root = readCollaborationRun(parent.rootRunId)!;
  const fixed = assertDefinitionLaunchable({ kind: 'agent', agentId: input.agentId, agentVersion: input.agentVersion }, parent.target.workspaceId, parent.target.projectId);
  if (fixed.executionMode === 'read-only') throw new DurableError(412, 'execution_mode_unsupported', 'Child Provider cannot enforce this fixed read-only Agent mode.');
  const team = root.teamVersion;
  if (team && !team.config.members.some(member => member.agentId === input.agentId && member.agentVersion === input.agentVersion))
    throw new DurableError(403, 'team_member_not_fixed', 'Team may delegate only its published fixed member versions.');
  if (!sequential && team?.config.strategy === 'sequential') throw new DurableError(409, 'sequential_delegation_unsupported', 'Sequential member order is server-owned; member tools cannot create extra branches.');
  let ancestor: CollaborationRun | null = parent;
  while (ancestor) {
    if (primaryAgent(ancestor).agentId === input.agentId) throw new DurableError(409, 'delegation_cycle', 'Delegation back to an ancestor Agent is rejected.');
    ancestor = ancestor.parentRunId ? readCollaborationRun(ancestor.parentRunId) : null;
  }
  if (parent.depth + 1 > root.resourceLimits.maxDelegationDepth || parent.depth + 1 > parent.resourceLimits.maxDelegationDepth)
    throw new DurableError(409, 'delegation_depth_limit', 'Shared root delegation depth is exhausted; child limits never reset it.');
  if (Date.now() >= Date.parse(root.deadlineAt)) throw new DurableError(409, 'duration_limit', 'Shared root duration is exhausted.');
  const createdAt = now();
  const childId = stableId('child-run', id);
  const limits = Object.fromEntries(Object.keys(root.resourceLimits).map(key => [key, Math.min(root.resourceLimits[key as keyof typeof root.resourceLimits], parent.resourceLimits[key as keyof typeof root.resourceLimits], fixed.resourceLimits[key as keyof typeof root.resourceLimits])])) as typeof root.resourceLimits;
  const child: CollaborationRun = { ...parent, ...fixed, id: childId, revision: 1, requestId: id, requestFingerprint: fingerprint,
    definition: { kind: 'agent', agentId: input.agentId, agentVersion: input.agentVersion }, goal: input.goal, input: input.input,
    rootRunId: root.id, parentRunId: parent.id, delegationId: id, depth: parent.depth + 1, status: 'queued',
    createdAt, updatedAt: createdAt, startedAt: null, finishedAt: null, deadlineAt: new Date(Math.min(Date.parse(root.deadlineAt), Date.parse(parent.deadlineAt), Date.now() + limits.maxDurationMs)).toISOString(), resourceLimits: limits,
    threadId: null, generationId: null, inputMessageId: null, operationRefs: [], resultRefs: [], capabilityManifests: [], taskBrief: null, wait: null, error: null, cancellation: null };
  const delegation: CollaborationDelegation = { id, kind, rootRunId: root.id, parentRunId: parent.id, childRunId: childId, parentGenerationId: generationId,
    originalCallId: callId, requestFingerprint: fingerprint, agentId: input.agentId, agentVersion: input.agentVersion, goal: input.goal, input: input.input,
    status: 'queued', required: true, createdAt, updatedAt: createdAt, finishedAt: null, resultRefs: [], responsePublishedAt: null, error: null };
  const reserved = transaction(() => {
    const duplicate = readRecord<CollaborationDelegation>(COLLABORATION_DELEGATIONS, id);
    if (duplicate) { if (duplicate.requestFingerprint !== fingerprint) throw new DurableError(409, 'delegation_idempotency_conflict', 'Tool identity changed.'); return duplicate; }
    assertDefinitionLaunchable({ kind: 'agent', agentId: input.agentId, agentVersion: input.agentVersion }, parent.target.workspaceId, parent.target.projectId);
    const currentParent = readCollaborationRun(parent.id);
    if (!currentParent || currentParent.cancellation || terminalStatuses[currentParent.status] || control.controller.signal.aborted || stopping)
      throw new DurableError(409, 'parent_run_inactive', 'Parent stopped before delegation acceptance.');
    if (listCollaborationRunsForInbox().filter(item => item.rootRunId === root.id).length >= Math.min(root.resourceLimits.maxRuns, parent.resourceLimits.maxRuns))
      throw new DurableError(409, 'run_limit', 'Shared root total Run budget is exhausted.');
    writeRecord(COLLABORATION_RUNS, child.id, child); saveDelegation(delegation);
    writeRecord(COLLABORATION_REQUESTS, `handoff:${child.id}`, readRecord<PmContentProvenance>(COLLABORATION_REQUESTS, `delegation-source:${id}`) ?? source);
    return delegation;
  });
  if (reserved !== delegation) return delegationReceipt(reserved);
  const childControl = attachLive(child.id, control.headers, control.adapters);
  childControl.worker = prepareRun(child, childControl).then(() => executeRun(child.id, childControl)).catch(async error => {
    await stopDescendants(child.id);
    updateRun(child.id, { operationRefs: collectPmOperations(readCollaborationRun(child.id)!) });
    await finishRunWithPublication(child.id, stopping ? 'interrupted' : readCollaborationRun(child.id)?.cancellation ? 'cancelled' : 'failed', errorDetails(error), childControl.headers);
  }).finally(() => detachLive(child.id));
  return delegationReceipt(delegation);
  } catch (error) {
    transaction(() => {
      if (readRecord(COLLABORATION_DELEGATIONS, id)) return;
      const at = now();
      saveDelegation({ id, kind, rootRunId: parent.rootRunId, parentRunId: parent.id, childRunId: null,
        parentGenerationId: generationId, originalCallId: callId, requestFingerprint: fingerprint,
        agentId: input.agentId, agentVersion: input.agentVersion, goal: input.goal, input: input.input,
        status: 'failed', required: false, createdAt: at, updatedAt: at, finishedAt: at,
        resultRefs: [], responsePublishedAt: null, error: errorDetails(error) });
    });
    throw error;
  }
}
function delegationReceipt(delegation: CollaborationDelegation): DelegationAccepted {
  if (!delegation.childRunId) throw new DurableError(409, delegation.error?.code ?? 'delegation_rejected', delegation.error?.message ?? 'The original delegation was rejected before any child was created.');
  const child = readCollaborationRun(delegation.childRunId);
  return { delegationId: delegation.id, childRunId: delegation.childRunId, status: child?.status ?? delegation.status,
    threadId: child?.threadId ?? null, generationId: child?.generationId ?? null, asynchronous: true };
}
async function stopDescendants(id: string): Promise<void> {
  const children = listCollaborationRunsForInbox().filter(item => item.parentRunId === id && (!terminalStatuses[item.status] || item.status === 'unknown'));
  await Promise.all(children.map(item => cancelTree(item.id, item.actorId, 'parent_stopped')));
}
async function cancelTree(id: string, actorId: string, reason = 'explicit_cancel'): Promise<void> {
  const run = readCollaborationRun(id);
  if (!run || terminalStatuses[run.status] && run.status !== 'unknown') return;
  updateRun(id, { cancellation: run.cancellation ?? { requestedAt: now(), requestedBy: actorId, observedAt: null } });
  live.get(id)?.controller.abort(new DurableError(409, reason, reason === 'duration_limit' ? 'Shared Run duration exhausted.' : 'Run cancellation requested; waiting for observed stops.'));
  await stopDescendants(id);
  const current = readCollaborationRun(id)!;
  updateRun(id, { operationRefs: collectPmOperations(current) });
  const generationIds = new Set(current.generationId ? [current.generationId] : []);
  let unresolvedAdmission = false;
  for (const operation of current.operationRefs) {
    if (operation.kind !== 'chat_acceptance' || !current.threadId) continue;
    const original = lookupChatSubmission(current.threadId, operation.operationId);
    if (original.status === 'accepted' && original.generationId) generationIds.add(original.generationId);
    else if (original.status === 'unknown') unresolvedAdmission = true;
  }
  await Promise.all([...generationIds].map(generationId => cancelChat(generationId)));
  if ([...generationIds].some(generationId => { const generation = getChatGeneration(generationId); return !generation || isChatActive(generation); }) || unresolvedAdmission) {
    if (!terminalStatuses[current.status]) finishRun(id, 'unknown', { code: 'cancel_unobserved', message: 'Original admission or Provider stop is unresolved; no cancellation success is inferred.' });
    return;
  }
  if (current.status === 'unknown') {
    updateRun(id, { cancellation: { ...current.cancellation!, observedAt: now() } });
    return;
  }
  const outcome = stopping ? 'interrupted' : 'cancelled';
  const error = { code: reason, message: reason === 'duration_limit' ? 'Shared root duration exhausted; observed children and Provider stops.' : 'Cancellation observed; prior external side effects are not rolled back.' };
  const headers = live.get(id)?.headers;
  if (headers) await finishRunWithPublication(id, outcome, error, headers);
  else finishRun(id, outcome, error);
}
export async function cancelCollaborationRun(id: string, input: CancelRun, headers: Headers): Promise<CollaborationRun> {
  const run = readCollaborationRun(id);
  if (!run) throw new DurableError(404, 'run_not_found', 'Run not found.');
  const authority = await authorizePmTarget({ workspaceId: run.target.workspaceId, projectId: run.target.projectId }, headers);
  if (authority.actorId !== run.actorId) throw new DurableError(403, 'run_actor_mismatch', 'Only the original current PM actor can cancel this Run.');
  const key = digest(['cancel', id, input.requestId]);
  const fingerprint = digest(input);
  const existing = readRecord<{ fingerprint: string }>(COLLABORATION_REQUESTS, key);
  if (existing) { if (existing.fingerprint !== fingerprint) throw new DurableError(409, 'cancel_idempotency_conflict', 'Cancel key is bound to a different request.'); return readCollaborationRun(id)!; }
  transaction(() => {
    const latest = readCollaborationRun(id)!;
    if (latest.revision !== input.revision || latest.generationId !== input.generationId) throw new DurableError(409, 'run_revision_conflict', 'Run revision or exact generation changed; refresh before stopping.');
    writeRecord(COLLABORATION_REQUESTS, key, { fingerprint, runId: id });
  });
  await cancelTree(id, authority.actorId);
  return readCollaborationRun(id)!;
}
async function publishStage(run: CollaborationRun, stage: 'started' | 'result', headers: Headers): Promise<void> {
  if (!run.generationId || !run.threadId) return;
  const generation = getChatGeneration(run.generationId);
  if (!generation) return;
  const agent = primaryAgent(run);
  const operationId = stableId('run-comment', run.id, stage);
  const retainedPublication = readRecord<CollaborationCommentPublication>(COLLABORATION_REQUESTS, `comment:${operationId}`);
  let visibleResults: RunResultReference[] = [];
  if (stage === 'result' && !retainedPublication) {
    try { visibleResults = await projectCollaborationResultRefs(run.resultRefs, run.rootRunId, headers); }
    catch { visibleResults = run.resultRefs.map(reference => ({ ...reference, summary: null, summarySource: null, outputItemIds: [], visibility: 'unavailable' })); }
  }
  const latest = visibleResults.at(-1);
  const summary = latest?.visibility === 'visible' ? latest.summary?.slice(0, 5000) ?? 'No assistant text was produced.'
    : run.resultRefs.length ? 'Result text is currently not visible and was withheld from this shared comment.' : 'No assistant summary was produced.';
  const content = stage === 'started' ? `Agent ${agent.config.name} (${agent.agentId}@${agent.version}) started Run ${run.id} against ${run.target.taskId}@${run.target.taskRevision}. This is execution activity, not task completion.`
    : `Run ${run.id} execution outcome: ${run.status}. ${summary}\nLatest evidence: ${run.resultRefs.slice(-8).map(item => `generation ${item.generationId}`).join(', ')}. Full evidence remains in the original Run. This result does not change task completion.`;
  const proposed: CollaborationCommentPublication = { operationId, runId: run.id, agentId: agent.agentId, agentVersion: agent.version, delegationId: run.delegationId,
    target: run.target, threadId: run.threadId, generationId: generation.id, messageId: generation.messageId, actorId: run.actorId, content };
  const original = transaction(() => {
    const retained = readRecord<CollaborationCommentPublication>(COLLABORATION_REQUESTS, `comment:${operationId}`);
    if (retained) return { request: retained, first: false };
    const current = readCollaborationRun(run.id)!;
    const existing = current.operationRefs.some(item => item.operationId === operationId);
    writeRecord(COLLABORATION_REQUESTS, `comment:${operationId}`, proposed);
    if (!existing) updateRun(run.id, { operationRefs: [...current.operationRefs, { operationId, kind: 'comment', status: 'pending', commandId: null }] });
    return { request: proposed, first: !existing };
  });
  try {
    const receipt = original.first ? await publishCollaborationComment(original.request, headers) : await reconcileCollaborationComment(original.request, headers);
    recordCommentReceipt(run.id, receipt);
  } catch (error) {
    const current = readCollaborationRun(run.id)!;
    const rejected = error instanceof DurableError && ['task_revision_changed', 'collaboration_actor_changed', 'collaboration_target_changed', 'collaboration_target_unavailable', 'pm_reference_forbidden'].includes(error.code);
    updateRun(run.id, { operationRefs: current.operationRefs.map(item => item.operationId === operationId && item.status !== 'succeeded' ? { ...item, status: rejected ? 'failed' : 'unknown' } : item) });
  }
}

async function finishRunWithPublication(id: string, status: CollaborationRunStatus, error: CollaborationRun['error'], headers: Headers): Promise<void> {
  const run = readCollaborationRun(id);
  if (!run || terminalStatuses[run.status]) return;
  await publishStage({ ...run, status }, 'result', headers);
  const current = readCollaborationRun(id)!;
  const unresolved = current.operationRefs.some(item => item.status === 'unknown' || item.status === 'pending');
  finishRun(id, status === 'succeeded' && unresolved ? 'unknown' : status,
    status === 'succeeded' && unresolved ? { code: 'pm_outcome_unresolved', message: 'Execution ended, but an original PM operation/publication remains unresolved. Query original receipts only.' } : error);
}

export async function getCollaborationOperation(runId: string, operationId: string, headers: Headers): Promise<PmToolCallRecord> {
  const run = readCollaborationRun(runId);
  const original = readRecord<CollaborationCommentPublication>(COLLABORATION_REQUESTS, `comment:${operationId}`);
  if (!run?.operationRefs.some(item => item.operationId === operationId && item.kind === 'comment') || !original || original.runId !== runId)
    throw new DurableError(404, 'operation_unresolved', 'No retained exact original comment operation exists.');
  // Current PM result projection, not a stale cached comment body, owns read visibility.
  const receipt = await reconcileCollaborationComment(original, headers);
  recordCommentReceipt(runId, receipt);
  return receipt;
}

function recordCommentReceipt(runId: string, receipt: PmToolCallRecord): void {
  transaction(() => {
    const retained = readRecord<PmToolCallRecord>(COLLABORATION_REQUESTS, `comment-result:${receipt.operationId}`);
    const proven = retained?.status === 'succeeded' ? retained : receipt;
    writeRecord(COLLABORATION_REQUESTS, `comment-result:${receipt.operationId}`, proven);
    const current = readCollaborationRun(runId)!;
    const commandId = proven.result?.kind === 'comment' ? proven.result.receipt?.commandId ?? null : null;
    updateRun(runId, { operationRefs: current.operationRefs.map(item => item.operationId === proven.operationId ? { ...item, commandId,
      status: proven.status === 'succeeded' ? 'succeeded' : proven.status === 'failed' ? 'failed' : 'unknown' } : item) });
  });
}

/** Read-only original-receipt reconciliation. Never launches, restores bindings or advances Team nodes. */
export async function reconcileCollaborationRun(id: string, headers: Headers): Promise<CollaborationRun> {
  const run = readCollaborationRun(id);
  if (!run) throw new DurableError(404, 'run_not_found', 'Original Run is unavailable.');
  await authorizePmTarget({ workspaceId: run.target.workspaceId, projectId: run.target.projectId }, headers);
  let generationId = run.generationId;
  for (const operation of run.operationRefs) {
    if (operation.kind !== 'comment' || operation.status !== 'unknown' && operation.status !== 'pending') continue;
    const original = readRecord<CollaborationCommentPublication>(COLLABORATION_REQUESTS, `comment:${operation.operationId}`);
    if (!original) continue;
    try {
      const receipt = await reconcileCollaborationComment(original, headers);
      recordCommentReceipt(id, receipt);
    } catch { /* Original uncertainty remains; result lookup never dispatches a missing operation. */ }
  }
  for (const operation of run.operationRefs) {
    if (operation.kind !== 'pm_tool' || operation.status !== 'unknown' && operation.status !== 'pending') continue;
    try { await reconcilePmToolCall(operation.operationId, headers); }
    catch { /* Keep original uncertainty or visibility failure; this path never dispatches. */ }
  }
  const current = readCollaborationRun(id)!;
  const results = [...current.resultRefs];
  const operations = current.operationRefs.map(operation => {
    if (operation.kind !== 'chat_acceptance' || !run.threadId) return operation;
    const receipt = lookupChatSubmission(run.threadId, operation.operationId);
    if (receipt.status === 'accepted' && receipt.generationId) {
      generationId = receipt.generationId;
      const generation = getChatGeneration(receipt.generationId);
      if (generation && !isChatActive(generation) && !results.some(item => item.generationId === generation.id)) results.push(generationResult(generation));
    }
    return { ...operation, status: receipt.status === 'accepted' ? 'succeeded' as const : receipt.status === 'not_accepted' ? 'failed' as const : 'unknown' as const };
  });
  const latest = readCollaborationRun(id)!;
  const mergedResults = [...latest.resultRefs, ...results.filter(result => !latest.resultRefs.some(item => item.generationId === result.generationId))];
  const mergedOperations = collectPmOperations(latest).map(item => item.kind === 'pm_tool' ? item : operations.find(operation => operation.operationId === item.operationId) ?? item);
  if (generationId === latest.generationId && JSON.stringify(mergedResults) === JSON.stringify(latest.resultRefs) && JSON.stringify(mergedOperations) === JSON.stringify(latest.operationRefs)) return latest;
  return updateRun(id, { generationId, resultRefs: mergedResults, operationRefs: mergedOperations });
}
