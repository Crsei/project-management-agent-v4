import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import type { StudioExecutionRequest } from '../../../../../packages/contracts/src/automation-studio.ts';
import { createAutomationServiceBearer } from '../../../../../packages/infrastructure/src/automation-execution-client.ts';
import { resolveAgentScope, type AgentExecutionSnapshot } from '../durable/agent-scope.ts';
import type { ChatGeneration } from '../durable/chat-runtime.ts';
import { readRecord, transaction, writeRecord } from '../durable/store.ts';
const executionNamespace = 'pm-automation:executions';
const bindingNamespace = 'pm-automation:native-thread-bindings';
type ExecutionIdentity = { request: StudioExecutionRequest; fingerprint: string; phase: string };
type NativeThreadBinding = { executionId: string; fingerprint: string; threadId: string; idempotencyKey: string; pmAnalysis?: true };
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function automationRequestFingerprint(request: StudioExecutionRequest): string { return createHash('sha256').update(stable(request)).digest('hex'); }
/** Ephemeral authority; never put these headers into a thread, log, request snapshot or argv. */
export function automationExecutionHeaders(request: StudioExecutionRequest): Headers { return new Headers({ authorization: `Bearer ${createAutomationServiceBearer(request)}` }); }
export async function resolveAutomationExecutionScope(request: StudioExecutionRequest, signal?: AbortSignal): Promise<AgentExecutionSnapshot> {
  signal?.throwIfAborted();
  if (request.config.projectId !== request.projectId) throw new Error('Immutable execution and definition project scopes do not match.');
  const snapshot = await resolveAgentScope({ workspaceId: request.workspaceId, projectId: request.projectId }, automationExecutionHeaders(request), signal);
  signal?.throwIfAborted();
  const canonical = await realpath(snapshot.path), info = await stat(canonical);
  signal?.throwIfAborted();
  if (!info.isDirectory() || canonical !== snapshot.path || (request.config.action.kind === 'script' && canonical.includes(','))) throw new Error('The authorized PM file area must be an existing canonical directory; isolated mounts cannot contain OCI delimiters.');
  return snapshot;
}
/** Call BEFORE submitChat so the launch hook can associate every template turn without a race. */
export function registerAutomationNativeThread(request: StudioExecutionRequest, threadId: string, idempotencyKey: string, pmAnalysis = false): void {
  const fingerprint = automationRequestFingerprint(request);
  transaction(() => {
    const execution = readRecord<ExecutionIdentity>(executionNamespace, request.executionId);
    if (!execution || execution.phase === 'finished' || execution.fingerprint !== fingerprint) throw new Error('Native thread cannot bind to an absent, terminal or different automation execution.');
    const key = JSON.stringify([threadId, idempotencyKey]), previous = readRecord<NativeThreadBinding>(bindingNamespace, key);
    if (previous && (previous.executionId !== request.executionId || previous.fingerprint !== fingerprint || Boolean(previous.pmAnalysis) !== pmAnalysis)) throw new Error('Native thread submission identity already belongs to another automation or tool policy.');
    if (!previous) writeRecord<NativeThreadBinding>(bindingNamespace, key, { executionId: request.executionId, fingerprint, threadId, idempotencyKey, ...(pmAnalysis ? { pmAnalysis: true } : {}) });
  });
}
export function automationRequestForNativeGeneration(generation: ChatGeneration): StudioExecutionRequest | null {
  const key = generation.request.idempotencyKey;
  if (!key) return null;
  const binding = readRecord<NativeThreadBinding>(bindingNamespace, JSON.stringify([generation.threadId, key]));
  if (!binding) return null;
  const execution = readRecord<ExecutionIdentity>(executionNamespace, binding.executionId);
  if (!execution || execution.fingerprint !== binding.fingerprint || generation.executionSnapshot?.scope.workspaceId !== execution.request.workspaceId || generation.executionSnapshot.scope.projectId !== execution.request.projectId) return null;
  return execution.request;
}
/** Policy is taken only from the immutable server registration, never from model/browser input. */
export function isPmAnalysisGeneration(generation: ChatGeneration): boolean {
  const key = generation.request.idempotencyKey;
  const binding = key ? readRecord<NativeThreadBinding>(bindingNamespace, JSON.stringify([generation.threadId, key])) : null;
  return Boolean(binding?.pmAnalysis && automationRequestForNativeGeneration(generation));
}
/** Server registration is the sole authority for the separate no-tools PM analysis cwd. */
export function pmAnalysisRequestForNativeThread(threadId: string, idempotencyKey: string | undefined): StudioExecutionRequest | null {
  const binding = idempotencyKey ? readRecord<NativeThreadBinding>(bindingNamespace, JSON.stringify([threadId, idempotencyKey])) : null;
  if (!binding?.pmAnalysis) return null;
  const execution = readRecord<ExecutionIdentity>(executionNamespace, binding.executionId);
  if (!execution || execution.phase === 'finished' || execution.fingerprint !== binding.fingerprint) throw new Error('PM analysis Chat is not bound to its original active execution.');
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
