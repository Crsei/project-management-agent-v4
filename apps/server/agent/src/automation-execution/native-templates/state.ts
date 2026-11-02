import { createHash } from 'node:crypto';
import type { StudioExecutionRequest } from '../../../../../../packages/contracts/src/automation-studio.ts';
import { listRecords, readRecord, transaction, writeRecord } from '../../durable/store.ts';
import type { NativeTemplateContext, NativeTemplateState } from './ports.ts';

export function nativeStable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(nativeStable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${nativeStable(child)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const nativeHash = (value: unknown): string => createHash('sha256').update(nativeStable(value)).digest('hex');
/** Revisions intentionally share task state; a new actor, scope, definition or template never does. */
export function nativeDefinitionScope(request: StudioExecutionRequest): string {
  if (request.config.action.kind !== 'template') throw new Error('A native template action is required.');
  return nativeHash([request.actorId, request.workspaceId, request.projectId, request.definitionId, request.config.action.templateId]);
}
function checkedKey(key: string): string {
  if (!key || key.length > 4000 || /[\u0000-\u001f]/.test(key)) throw new Error('Native state keys must be bounded nonempty text.');
  return key;
}
function jsonValue(value: unknown): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) > 1024 * 1024) throw new Error('Native state values must be JSON no larger than 1 MiB.');
  return JSON.parse(encoded) as unknown;
}
export class NativeTemplateStateConflict extends Error {
  readonly code = 'revision_conflict';
  readonly status = 409;
  constructor() { super('Native template state changed; read its current revision before updating.'); }
}
export function createNativeTemplateState(request: StudioExecutionRequest): NativeTemplateContext['state'] {
  const definitionScope = nativeDefinitionScope(request);
  const sharedScope = nativeHash([request.actorId, request.workspaceId, request.projectId, request.config.action.plugins.filter(plugin => plugin.id.startsWith('integration:')).sort((a, b) => a.id.localeCompare(b.id))]);
  const namespaceFor = (key: string) => key.startsWith('shared:review:') ? `pm-automation:native-review-state:${sharedScope}` : `pm-automation:native-state:${definitionScope}`;
  const append = (key: string, revision: number, value: unknown): NativeTemplateState => {
    const next = { revision, value: jsonValue(value) };
    const namespace = namespaceFor(key);
    writeRecord(namespace, key, next);
    writeRecord(`${namespace}:history`, JSON.stringify([key, revision]), { ...next, key, executionId: request.executionId, definitionRevision: request.definitionRevision, at: new Date().toISOString() });
    return next;
  };
  return {
    async read(key) { return readRecord<NativeTemplateState>(namespaceFor(key), checkedKey(key)); },
    async compareAndSet(key, expectedRevision, value) {
      checkedKey(key);
      return transaction(() => {
        const previous = readRecord<NativeTemplateState>(namespaceFor(key), key);
        if ((previous?.revision ?? null) !== expectedRevision) throw new NativeTemplateStateConflict();
        return append(key, (previous?.revision ?? 0) + 1, value);
      });
    },
    async claim(key, value) {
      checkedKey(key);
      return transaction(() => {
        if (readRecord(namespaceFor(key), key)) return false;
        append(key, 1, value);
        return true;
      });
    },
  };
}

export type NativeOperation = {
  scope: string; key: string; fingerprint: string; executionId: string;
  phase: 'pending' | 'completed' | 'failed' | 'unknown'; startedAt: string;
  value?: unknown; error?: string; status?: number; code?: string;
};
const operationNamespace = 'pm-automation:native-operations';
const operationKey = (scope: string, key: string): string => JSON.stringify([scope, checkedKey(key)]);
export function readNativeOperation(scope: string, key: string): NativeOperation | null {
  return readRecord(operationNamespace, operationKey(scope, key));
}
/** Persist before opening a network socket. Pending/unknown operations are never reclaimed. */
export function admitNativeOperation(request: StudioExecutionRequest, key: string, fingerprint: string): { fresh: boolean; operation: NativeOperation } {
  const scope = nativeDefinitionScope(request);
  return transaction(() => {
    const previous = readNativeOperation(scope, key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw Object.assign(new Error('A stable native operation key was reused with different input.'), { status: 409 });
      return { fresh: false, operation: previous };
    }
    const operation: NativeOperation = { scope, key, fingerprint, executionId: request.executionId, phase: 'pending', startedAt: new Date().toISOString() };
    writeRecord(operationNamespace, operationKey(scope, key), operation);
    return { fresh: true, operation };
  });
}
export function finishNativeOperation(operation: NativeOperation, result: Pick<NativeOperation, 'phase' | 'value' | 'error' | 'status' | 'code'>): void {
  transaction(() => {
    const previous = readNativeOperation(operation.scope, operation.key);
    if (!previous || previous.fingerprint !== operation.fingerprint) throw new Error('Native operation identity changed.');
    if (previous.phase !== 'pending') return;
    const next = { ...previous, ...result };
    writeRecord(operationNamespace, operationKey(operation.scope, operation.key), next);
    writeRecord(`${operationNamespace}:history`, operationKey(operation.scope, operation.key), { ...next, finishedAt: new Date().toISOString() });
  });
}
export function nativeOperations(request: StudioExecutionRequest): NativeOperation[] {
  const scope = nativeDefinitionScope(request);
  return listRecords<NativeOperation>(operationNamespace).filter(operation => operation.scope === scope && operation.executionId === request.executionId);
}
