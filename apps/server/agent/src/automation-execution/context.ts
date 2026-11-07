import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { studioActionRequiresAgentWorkspace, type StudioExecutionRequest } from '../../../../../packages/contracts/src/automation-studio.ts';
import { authorizedAgentContextSchema } from '../../../../../packages/contracts/src/agent-file-areas.ts';
import { createAutomationServiceBearer } from '../../../../../packages/infrastructure/src/automation-execution-client.ts';
import { resolveAgentExecution, sameExecutionIdentity, type AgentExecutionSnapshot } from '../durable/agent-execution.ts';
import type { ChatGeneration } from '../durable/chat-runtime.ts';
import { listRecords, readRecord, transaction, writeRecord } from '../durable/store.ts';
import { chatOnlyExecutionSelection, executionSelectionSchema } from '@agent-workspace/contracts/chat';
import type { PmToolTarget } from '@agent-workspace/contracts/pm-tools';
import type { TaskCodeDelivery } from '../../../../../packages/contracts/src/task-code-delivery.ts';
import { requestDeliveryPm } from '../task-delivery/authority.ts';
const executionNamespace = 'pm-automation:executions';
const bindingNamespace = 'pm-automation:native-thread-bindings';
type ExecutionIdentity = { request: StudioExecutionRequest; fingerprint: string; phase: string };
type NativeThreadBinding = { executionVersion: 2; executionId: string; fingerprint: string; threadId: string; idempotencyKey: string; pmAnalysis?: true };
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function automationRequestFingerprint(request: StudioExecutionRequest): string { return createHash('sha256').update(stable(request)).digest('hex'); }
/** Ephemeral authority; never put these headers into a thread, log, request snapshot or argv. */
export function automationExecutionHeaders(request: StudioExecutionRequest): Headers { return new Headers({ authorization: `Bearer ${createAutomationServiceBearer(request)}` }); }
export async function resolveAutomationExecutionScope(request: StudioExecutionRequest, signal?: AbortSignal, sessionId = `pm-automation:${request.executionId}`): Promise<AgentExecutionSnapshot> {
  signal?.throwIfAborted();
  if (request.config.projectId !== request.projectId) throw new Error('Immutable execution and definition project scopes do not match.');
  const target = { workspaceId: request.workspaceId, projectId: request.projectId };
  const authority = authorizedAgentContextSchema.parse(await requestDeliveryPm('/api/v1/agent-contexts/authorize', automationExecutionHeaders(request), target));
  if (authority.actorId !== request.actorId || authority.scope.workspaceId !== request.workspaceId || authority.scope.projectId !== request.projectId)
    throw new Error('Automation PM authority differs from its immutable actor and target.');
  const selection = executionSelectionSchema.parse(request.config.action.executionSelection ?? chatOnlyExecutionSelection());
  if (studioActionRequiresAgentWorkspace(request.config.action) && selection.agentWorkspaceId === null)
    throw new Error('This repository/script automation requires an explicit Agent Workspace selection.');
  const snapshot = await resolveAgentExecution(selection, sessionId, signal);
  signal?.throwIfAborted();
  const canonical = await realpath(snapshot.path), info = await stat(canonical);
  signal?.throwIfAborted();
  if (!info.isDirectory() || canonical !== snapshot.path || (request.config.action.kind === 'script' && canonical.includes(','))) throw new Error('The selected Agent directory must be existing and canonical; isolated mounts cannot contain OCI delimiters.');
  return snapshot;
}
/** Call BEFORE submitChat so the launch hook can associate every template turn without a race. */
export function registerAutomationNativeThread(request: StudioExecutionRequest, threadId: string, idempotencyKey: string, pmAnalysis = false): void {
  const fingerprint = automationRequestFingerprint(request);
  transaction(() => {
    const execution = readRecord<ExecutionIdentity>(executionNamespace, request.executionId);
    if (!execution || execution.phase === 'finished' || execution.fingerprint !== fingerprint || automationRequestFingerprint(execution.request) !== fingerprint) throw new Error('Native thread cannot bind to an absent, terminal or different automation execution.');
    const key = JSON.stringify([threadId, idempotencyKey]), previous = readRecord<NativeThreadBinding>(bindingNamespace, key);
    if (previous && (previous.executionVersion !== 2 || previous.executionId !== request.executionId || previous.fingerprint !== fingerprint || Boolean(previous.pmAnalysis) !== pmAnalysis)) throw new Error('Native thread submission identity already belongs to another automation or tool policy.');
    if (!previous) writeRecord<NativeThreadBinding>(bindingNamespace, key, { executionVersion: 2, executionId: request.executionId, fingerprint, threadId, idempotencyKey, ...(pmAnalysis ? { pmAnalysis: true } : {}) });
  });
}
function originalGeneration(generation: ChatGeneration): ChatGeneration | null {
  if (!generation.continuationOf) return generation;
  const visited = new Set<string>();
  while (generation.continuationOf) {
    if (visited.has(generation.id)) return null;
    visited.add(generation.id);
    const previous = readRecord<ChatGeneration>('chat:generations', generation.continuationOf);
    if (!previous || previous.threadId !== generation.threadId || previous.continuationId !== generation.id) return null;
    generation = previous;
  }
  return generation;
}
export function automationRequestForNativeGeneration(generation: ChatGeneration): StudioExecutionRequest | null {
  const original = originalGeneration(generation), key = original?.request.idempotencyKey;
  if (!original || !key) return null;
  const binding = readRecord<NativeThreadBinding>(bindingNamespace, JSON.stringify([original.threadId, key]));
  if (!binding || binding.executionVersion !== 2) return null;
  const execution = readRecord<ExecutionIdentity>(executionNamespace, binding.executionId);
  if (!execution || execution.fingerprint !== binding.fingerprint || automationRequestFingerprint(execution.request) !== binding.fingerprint) return null;
  return execution.request;
}
/** Native business dispatch retains its original grant ceiling without making plain Sessions PM-owned. */
export async function authorizeAutomationNativeThreadExecution(threadId: string, snapshot: AgentExecutionSnapshot, purpose: 'execute' | 'inspect', signal?: AbortSignal): Promise<void> {
  const bindings = listRecords<NativeThreadBinding>(bindingNamespace).filter(binding => binding.threadId === threadId);
  if (!bindings.length) return;
  if (bindings.length !== 1 || bindings[0]!.executionVersion !== 2) throw new Error('Historical or ambiguous automation Session cannot execute; create a new operation.');
  const binding = bindings[0]!, execution = readRecord<ExecutionIdentity>(executionNamespace, binding.executionId);
  if (!execution || execution.fingerprint !== binding.fingerprint || automationRequestFingerprint(execution.request) !== binding.fingerprint || purpose === 'execute' && execution.phase === 'finished')
    throw new Error('Automation Session is not bound to its original active execution.');
  const selection = executionSelectionSchema.parse(execution.request.config.action.executionSelection ?? chatOnlyExecutionSelection());
  if (snapshot.environment.agentWorkspaceId !== selection.agentWorkspaceId || snapshot.environment.agentWorkspaceRevision !== selection.agentWorkspaceRevision)
    throw new Error('Automation Session directory differs from its immutable execution selection.');
  if (purpose === 'execute') {
    const current = await resolveAutomationExecutionScope(execution.request, signal, threadId);
    if (current.path !== snapshot.path || !sameExecutionIdentity(current.environment, snapshot.environment)) throw new Error('Automation Session execution directory changed.');
  }
}
/** A server-owned business receipt may limit tools; it never assigns Session ownership. */
export function getNativeGenerationPmTargetCeiling(generation: ChatGeneration): PmToolTarget | undefined {
  const request = automationRequestForNativeGeneration(generation);
  if (request) return { workspaceId: request.workspaceId, projectId: request.projectId };
  const original = originalGeneration(generation), key = original?.request.idempotencyKey;
  if (!original || !key) return undefined;
  const delivery = listRecords<TaskCodeDelivery>('task-code-delivery-v1').find(value =>
    value.threadId === original.threadId && value.generationKey === key);
  return delivery ? { workspaceId: delivery.workspaceId, projectId: delivery.projectId } : undefined;
}
/** Policy is taken only from the immutable server registration, never from model/browser input. */
export function isPmAnalysisGeneration(generation: ChatGeneration): boolean {
  const original = originalGeneration(generation), key = original?.request.idempotencyKey;
  const binding = original && key ? readRecord<NativeThreadBinding>(bindingNamespace, JSON.stringify([original.threadId, key])) : null;
  return Boolean(binding?.pmAnalysis && automationRequestForNativeGeneration(generation));
}
/** Server registration is the sole authority for the separate no-tools PM analysis cwd. */
export function pmAnalysisRequestForNativeThread(threadId: string, idempotencyKey: string | undefined): StudioExecutionRequest | null {
  const binding = idempotencyKey ? readRecord<NativeThreadBinding>(bindingNamespace, JSON.stringify([threadId, idempotencyKey])) : null;
  if (!binding?.pmAnalysis || binding.executionVersion !== 2) return null;
  const execution = readRecord<ExecutionIdentity>(executionNamespace, binding.executionId);
  if (!execution || execution.phase === 'finished' || execution.fingerprint !== binding.fingerprint || automationRequestFingerprint(execution.request) !== binding.fingerprint) throw new Error('PM analysis Chat is not bound to its original active execution.');
  return execution.request;
}
/** Durable Studio or existing automation dispatch ownership; mutable Chat metadata is not authority. */
export function isAutomationOriginGeneration(generation: ChatGeneration): boolean {
  if (automationRequestForNativeGeneration(generation)) return true;
  const key = generation.request.idempotencyKey;
  if (!key?.startsWith('automation:')) return false;
  const dispatch = readRecord<{ threadId: string; idempotencyKey: string }>('automation.dispatches', key.slice('automation:'.length));
  return dispatch?.threadId === generation.threadId && dispatch.idempotencyKey === key;
}
