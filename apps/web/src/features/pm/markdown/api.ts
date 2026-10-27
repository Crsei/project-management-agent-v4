import type { Diagnostic, FileRecord, UnsupportedFile, WorkspaceSnapshot, SavedView, ViewConfig, ProtocolConfiguration } from '@pm-schema';
import type { GraphData, GraphQuery } from '@pm-schema/graph';
import type { MigrationRequest, MigrationPlan, MigrationResult, MigrationSummary } from '@pm-core/migrations';
import { coreCreationAttemptSchema, coreCreationFileRecordSchema, type CoreCreationAttempt } from '../../../../../../packages/contracts/src/core-creation';

export type { MigrationRequest, MigrationPlan, MigrationResult, MigrationSummary, ProtocolConfiguration };
export interface ConfigurationResponse { config: ProtocolConfiguration; revision: string; diagnostics: Diagnostic[] }
export type ArchiveFilter = 'exclude' | 'include' | 'only';


export class ApiError extends Error {
  status: number;
  current?: FileRecord | UnsupportedFile;
  diagnostics: Diagnostic[];
  constructor(message: string, status: number, current?: FileRecord | UnsupportedFile, diagnostics: Diagnostic[] = []) { super(message); this.name = 'ApiError'; this.status = status; this.current = current; this.diagnostics = diagnostics; }
}

export interface CoreClient {
  workspace: (signal?: AbortSignal) => Promise<WorkspaceSnapshot>;
  protocol: () => Promise<Record<string, unknown>>;
  configuration: () => Promise<ConfigurationResponse>;
  saveConfiguration: (config: unknown, revision: string) => Promise<ConfigurationResponse>;
  query: (view: ViewConfig, archived?: ArchiveFilter) => Promise<{ items: FileRecord[] }>;
  graph: (query: GraphQuery, signal?: AbortSignal) => Promise<GraphData>;
  migrations: () => Promise<MigrationSummary[]>;
  previewMigration: (input: MigrationRequest) => Promise<MigrationPlan>;
  applyMigration: (id: string, revision: string) => Promise<MigrationResult>;
  restoreMigration: (id: string, revision: string) => Promise<MigrationResult>;
  file: (id: string) => Promise<FileRecord | UnsupportedFile>;
  save: (id: string, raw: string, revision: string) => Promise<FileRecord>;
  patch: (id: string, changes: Record<string, unknown>, revision: string) => Promise<FileRecord>;
  create: (input: Record<string, unknown>, idempotencyKey: string) => Promise<FileRecord>;
  createEntity: (input: Record<string, unknown>, idempotencyKey: string) => Promise<FileRecord>;
  creationAttempt: (key: string) => Promise<CoreCreationAttempt>;
  recoverCreationAttempt: (key: string) => Promise<CoreCreationAttempt>;
  archive: (id: string, revision: string) => Promise<FileRecord>;
  restore: (id: string, revision: string) => Promise<FileRecord>;
  delete: (id: string, revision: string) => Promise<{ id: string; deleted: true }>;
  saveView: (id: string, view: ViewConfig & { name: string; revision?: string }) => Promise<SavedView>;
  context: (id: string) => Promise<{ id: string; markdown: string }>;
}
export function createCoreClient(workspaceId: string): CoreClient {
  const base = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/core`;
  async function request<T>(path: string, method = 'GET', body?: unknown, idempotencyKey?: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method,
    signal,
    credentials: 'same-origin',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = data?.error;
    throw new ApiError(
      typeof error === 'string' ? error : (error?.message || `Request failed (${response.status})`),
      response.status,
      data?.current,
      data?.diagnostics,
    );
  }
  return data as T;
}
  return {
  workspace: signal => request<WorkspaceSnapshot>('/workspace', 'GET', undefined, undefined, signal),
  protocol: () => request<Record<string, unknown>>('/protocol'),
  configuration: () => request<ConfigurationResponse>('/config'),
  saveConfiguration: (config: unknown, revision: string) => request<ConfigurationResponse>('/config', 'PUT', { config, revision }),
  query: (view: ViewConfig, archived?: ArchiveFilter) => request<{ items: FileRecord[] }>('/query', 'POST', { view, archived }),
  graph: (query, signal) => request<GraphData>('/graph', 'POST', query, undefined, signal),
  migrations: () => request<MigrationSummary[]>('/migrations'),
  previewMigration: (input: MigrationRequest) => request<MigrationPlan>('/migrations/preview', 'POST', input),
  applyMigration: (id: string, revision: string) => request<MigrationResult>(`/migrations/${encodeURIComponent(id)}/apply`, 'POST', { revision }),
  restoreMigration: (id: string, revision: string) => request<MigrationResult>(`/migrations/${encodeURIComponent(id)}/restore`, 'POST', { revision }),
  file: (id: string) => request<FileRecord | UnsupportedFile>(`/files/${encodeURIComponent(id)}`),
  save: (id: string, raw: string, revision: string) => request<FileRecord>(`/files/${encodeURIComponent(id)}`, 'PUT', { raw, revision }, crypto.randomUUID()),
  patch: (id: string, changes: Record<string, unknown>, revision: string) => request<FileRecord>(`/entities/${encodeURIComponent(id)}`, 'PATCH', { changes, revision }, crypto.randomUUID()),
  create: (input: Record<string, unknown>, idempotencyKey: string) => request<FileRecord>('/items', 'POST', input, idempotencyKey),
  createEntity: async (input: Record<string, unknown>, idempotencyKey: string) => coreCreationFileRecordSchema.parse(await request<unknown>('/entities', 'POST', input, idempotencyKey)),
  creationAttempt: async key => coreCreationAttemptSchema.parse(await request<unknown>(`/creation-attempts/${encodeURIComponent(key)}`)),
  recoverCreationAttempt: async key => coreCreationAttemptSchema.parse(await request<unknown>(`/creation-attempts/${encodeURIComponent(key)}/recover`, 'POST', {})),
  archive: (id: string, revision: string) => request<FileRecord>(`/entities/${encodeURIComponent(id)}/archive`, 'POST', { revision }, crypto.randomUUID()),
  restore: (id: string, revision: string) => request<FileRecord>(`/entities/${encodeURIComponent(id)}/restore`, 'POST', { revision }, crypto.randomUUID()),
  delete: (id: string, revision: string) => request<{ id: string; deleted: true }>(`/entities/${encodeURIComponent(id)}`, 'DELETE', { revision }, crypto.randomUUID()),
  saveView: (id: string, view: ViewConfig & { name: string; revision?: string }) => request<SavedView>(`/views/${encodeURIComponent(id)}`, 'PUT', view),
  context: (id: string) => request<{ id: string; markdown: string }>(`/context/${encodeURIComponent(id)}`),
};
}

