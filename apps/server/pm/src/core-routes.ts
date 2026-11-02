import path from 'node:path';
import { lstatSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { Workspace, WorkspaceError, type ItemQuery, type WorkspaceMutationGuard, type WorkspaceCreationPrepared } from '../../../../packages/pm-core/index.ts';
import { ProtocolError, statusCategory, type Diagnostic, type Entity, type FileRecord, type ProtocolConfiguration, type UnsupportedFile, type ViewConfig, type WorkspaceSnapshot } from '../../../../packages/pm-schema/index.ts';
import { graphQuerySchema, type GraphQuery } from '../../../../packages/pm-schema/graph.ts';
import { getMembership, type Membership } from '../../../../packages/application/src/access.ts';
import { DomainError, type Actor, type Capability } from '../../../../packages/domain/src/core.ts';
import type { SqlExecutor } from '../../../../packages/application/src/ports.ts';
import { lockWorkspace } from '../../../../packages/infrastructure/src/database.ts';
import { appendProjectAudit } from '../../../../packages/application/src/project-audit.ts';
import { requestHash } from '../../../../packages/application/src/kernel.ts';
import { requestHash as creationInputHash } from '../../../../packages/pm-core/state.ts';
import { assertCoreProtectedMetadata, assertCoreTaskMutation, requireTaskAssignee } from '../../../../packages/application/src/core-task-creation.ts';
import type { CoreCreationAttempt } from '../../../../packages/contracts/src/core-creation.ts';
import { coreProjectAuditWrites } from './core-adapter.ts';
import { CoreCommandJournal, type CoreHttpCreation, type CoreHttpOutcome } from './core-journal.ts';
import { captureCoreFacts, recoverPreparedCoreCreations } from './core-facts.ts';
import { insertServiceFact, type CapturedServiceFact } from '../../../../packages/application/src/service-facts.ts';
import { initializeLocalProject, beginLocalProjectOperation, readLocalProjectOperation, requireLocalManagement, assertLocalProjectWritable, assertLocalProjectTargetAvailable, type LocalProjectConfiguration } from '../../../../packages/application/src/local-projects.ts';
import { assertCoreDeletionSafe } from '../../../../packages/application/src/core-deletion.ts';
import { localDirectorySchema, type LocalDirectory } from '../../../../packages/contracts/src/local-projects.ts';
import { registerLocalProjectRoutes } from './local-project-routes.ts';
import type { ProjectMount } from '../../../../packages/pm-core/project-locations.ts';
import type { Command } from '../../../../packages/domain/src/core.ts';

export type CoreAuthenticator = (request: FastifyRequest) => Promise<Actor>;

const workspaceIdSchema = z.uuid().toLowerCase();
const identifierSchema = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/, 'Expected a stable entity ID such as TASK-102');
const viewIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const migrationIdSchema = z.string().regex(/^mig-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const entityKindSchema = z.enum(['project', 'work_item', 'document', 'cycle', 'milestone', 'module', 'requirement', 'release', 'goal']);
const itemQuerySchema = z.object({
  entity: entityKindSchema.optional(), project: z.string().max(80).optional(), status: z.string().max(120).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(), q: z.string().max(500).optional(),
  sort: z.string().max(80).optional(), archived: z.enum(['exclude', 'include', 'only']).optional(),
});
const archiveSchema = z.object({ archived: z.enum(['exclude', 'include', 'only']).optional() });
const creationKeySchema = z.string().min(1).max(512).refine(key => !!key.trim());
export const nativeCommandId = (workspaceId: string, actorId: string, action: string, targetId: string | undefined, key: string): string =>
  createHash('sha256').update(JSON.stringify([workspaceId, actorId, action, targetId, key])).digest('hex');

function badRequest(message: string, field?: string): never {
  throw new DomainError('core_invalid_request', message, 400, field ? { field } : undefined);
}

function envelope(input: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(input).find(key => !allowed.includes(key));
  if (unknown) badRequest(`Unexpected request field: ${unknown}`, unknown);
}

function requiredRevision(input: Record<string, unknown>): string {
  if (typeof input.revision !== 'string' || !input.revision.trim()) badRequest('A nonempty revision string is required', 'revision');
  return input.revision;
}

function jsonObject(request: FastifyRequest): Record<string, unknown> {
  const contentType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!/^application\/(?:json|[^;]+\+json)$/.test(contentType)) badRequest('Expected application/json');
  const value: unknown = request.body;
  if (!value || typeof value !== 'object' || Array.isArray(value)) badRequest('Expected a JSON object');
  return value as Record<string, unknown>;
}

function idempotencyKey(request: FastifyRequest): string | undefined {
  const key = request.headers['idempotency-key'];
  if (key === undefined) return undefined;
  if (typeof key !== 'string' || !key.trim() || key.length > 512) badRequest('Idempotency-Key must be a nonempty string of at most 512 characters', 'Idempotency-Key');
  return key;
}

function coreError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof WorkspaceError) return reply.code(error.status).send({ error: error.message, diagnostics: error.diagnostics, ...(error.current ? { current: error.current } : {}) });
  if (error instanceof ProtocolError) return reply.code(422).send({ error: error.message, diagnostics: error.diagnostics.map(diagnostic => ({ ...diagnostic, path: diagnostic.path || request.url })) });
  if (error instanceof DomainError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }, requestId: request.id });
  if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'validation_failed', details: error.flatten() }, requestId: request.id });
  const known = error as { statusCode?: number };
  if (known.statusCode && known.statusCode >= 400 && known.statusCode < 500) return reply.code(known.statusCode).send({ error: { code: 'invalid_request' }, requestId: request.id });
  request.log.error({ err: error }, 'Core request failed');
  const diagnostics: Diagnostic[] = [{ code: 'INTERNAL_ERROR', severity: 'error', path: request.url, message: 'Internal server error; check the server terminal for details' }];
  return reply.code(500).send({ error: diagnostics[0]!.message, diagnostics });
}

/** One authoritative Markdown workspace per PM workspace, created lazily and closed with the API. */
export class CoreWorkspacePool {
  private readonly entries = new Map<string, { ready: Promise<Workspace> }>();
  private readonly root: string;
  private readonly sql: SqlExecutor | undefined;
  constructor(root: string, sql?: SqlExecutor) { this.root = root; this.sql = sql; }
  rootFor(workspaceId: string): string { return path.join(this.root, workspaceId); }

  async confirmCreation(workspaceId: string, key: string): Promise<void> {
    const existing = this.entries.get(workspaceId);
    if (existing) await (await existing.ready).confirmCreation(key);
    else Workspace.confirmCreation(this.rootFor(workspaceId), key);
  }

  /** Cached projections are refreshed at acquisition, not only by the asynchronous watcher. */
  async get(workspaceId: string): Promise<Workspace> {
    const existing = this.entries.get(workspaceId);
    if (existing) {
      const workspace = await existing.ready;
      await workspace.rescan('refresh');
      return workspace;
    }
    let workspace: Workspace | undefined;
    const ready = (async () => {
      const root = this.rootFor(workspaceId);
      try {
        const state = lstatSync(path.join(root, '.pm/state/state.json'));
        if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1) throw new DomainError('core_workspace_storage_missing', 'The authoritative workspace state is unsafe; restore it before continuing', 503);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const evidence = await this.sql?.query<{ used: boolean }>(`SELECT EXISTS(SELECT 1 FROM project_audit WHERE workspace_id=$1) OR EXISTS(SELECT 1 FROM local_project_operations WHERE workspace_id=$1) OR EXISTS(SELECT 1 FROM command_receipts WHERE workspace_id=$1 AND command_type IN ('CreateProject','CreateWorkItem','CreateWorkItemFromIntent','CreateMilestone') AND receipt->>'status'='committed') AS used`, [workspaceId]);
        if (evidence?.rows[0]?.used) throw new DomainError('core_workspace_storage_missing', 'Authoritative workspace state is missing; restore the original data root rather than creating an empty replacement', 503);
      }
      workspace = new Workspace(root);
      const opened = workspace;
      await opened.init(history => { recoverPreparedCoreCreations(opened.root, new CoreCommandJournal(opened.root), history); });
      return opened;
    })().catch(async (error: unknown) => {
      this.entries.delete(workspaceId);
      await workspace?.close().catch(() => undefined);
      throw error;
    });
    this.entries.set(workspaceId, { ready });
    return ready;
  }

  async close(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(entries.map(async entry => { const workspace = await entry.ready.catch(() => undefined); await workspace?.close(); }));
  }
}

/** Project-scoped members see only objects that belong to an allowed core project. */
export class CoreScope {
  readonly membership: Membership;
  readonly workspaceId: string;
  constructor(membership: Membership, workspaceId: string) { this.membership = membership; this.workspaceId = workspaceId; }
  get unrestricted(): boolean { return this.membership.projectIds === null; }
  allows(record: FileRecord | UnsupportedFile): boolean {
    if (this.unrestricted) return true;
    if (!('entity' in record)) return false;
    const projectIds = this.membership.projectIds!;
    if (projectIds.includes(record.id)) return true;
    return typeof record.entity.project === 'string' && projectIds.includes(record.entity.project);
  }
  allowsProject(project: unknown): boolean {
    return this.unrestricted || (typeof project === 'string' && this.membership.projectIds!.includes(project));
  }
  entity(record: FileRecord | UnsupportedFile): FileRecord | UnsupportedFile {
    if (!this.allows(record)) throw new DomainError('not_found_or_forbidden', 'Entity is not accessible', 404);
    return record;
  }
}

function requireCapability(scope: CoreScope, capability: Capability): void {
  if (!scope.membership.capabilities.includes(capability)) throw new DomainError('permission_denied', `Capability ${capability} is required`, 403);
}

/** Field-level capabilities for generic source/property writes that bypass command handlers. */
function assertMutationCapabilities(scope: CoreScope, before: Entity | undefined, after: Entity, configuration: ProtocolConfiguration): void {
  const lifecycleOnly = before && (after.status !== before.status || after.archived !== before.archived)
    && Object.keys({ ...before, ...after }).every(field => ['status', 'archived', 'checklist', 'links', 'views'].includes(field) || isDeepStrictEqual(after[field], before[field]));
  if (!lifecycleOnly) requireCapability(scope, 'planning.edit');
  if (after.archived !== (before?.archived ?? false)) requireCapability(scope, 'planning.lifecycle');
  if (before && after.project !== before.project && !scope.allowsProject(after.project)) throw new DomainError('not_found_or_forbidden', 'Project is not accessible', 404);
  if (after.entity === 'project' && JSON.stringify(before?.depends_on ?? []) !== JSON.stringify(after.depends_on ?? [])) {
    if (after.depends_on !== undefined && (!Array.isArray(after.depends_on) || after.depends_on.some(id => typeof id !== 'string'))) badRequest('depends_on must be an array of project identifiers', 'depends_on');
    requireCapability(scope, 'domain.read');
    requireCapability(scope, 'planning.edit');
    for (const projectId of new Set([...(before?.depends_on ?? []), ...(after.depends_on ?? [])])) {
      if (!scope.allowsProject(projectId)) throw new DomainError('not_found_or_forbidden', 'Project is not accessible', 404);
    }
  }
  if (after.status === before?.status) return;
  const beforeCategory = before ? statusCategory(before, configuration) : undefined;
  const afterCategory = statusCategory(after, configuration);
  if (after.entity === 'work_item') {
    if (afterCategory === 'completed') requireCapability(scope, 'workitem.complete');
    else if (afterCategory === 'canceled') requireCapability(scope, 'workitem.cancel_reopen');
    else if (beforeCategory === 'completed' || beforeCategory === 'canceled') requireCapability(scope, 'workitem.cancel_reopen');
    else requireCapability(scope, 'planning.edit');
    return;
  }
  if (afterCategory === 'completed' || afterCategory === 'canceled' || beforeCategory === 'completed' || beforeCategory === 'canceled') requireCapability(scope, 'planning.lifecycle');
  else requireCapability(scope, 'planning.edit');
}

export async function authorizeCoreScope(pool: SqlExecutor, principal: Actor, workspaceId: string, capability: Capability): Promise<CoreScope> {
  const membership = await getMembership(pool, principal, workspaceId);
  if (!membership.capabilities.includes(capability)) throw new DomainError('permission_denied', `Capability ${capability} is required`, 403);
  return new CoreScope(membership, workspaceId);
}

  function authorizeCreation(scope: CoreScope, saved: CoreHttpOutcome): void {
    const projects = saved.creation?.scopeProjectIds ?? (saved.kind === 'http_completed' ? saved.audit.map(entry => entry.projectId) : []);
    if (!scope.unrestricted && (!projects.length || projects.some(project => !scope.allowsProject(project))))
      throw new DomainError('not_found_or_forbidden', 'Creation attempt is not accessible', 404);
  }
/** Reconcile only original proven facts; this service never dispatches a business mutation. */
export async function recoverAuditedCoreMutation(options: {
  database: () => Pool; pool: CoreWorkspacePool; principal: Actor; workspaceId: string;
  commandId: string; hash: string; checkProject?: (projectId: string) => void;
}): Promise<CoreHttpOutcome | undefined> {
  const sql = await options.database().connect();
  try {
    await sql.query('BEGIN');
    await lockWorkspace(sql, options.workspaceId);
    const scope = await authorizeCoreScope(sql, options.principal, options.workspaceId, 'domain.read');
    const journal = new CoreCommandJournal(options.pool.rootFor(options.workspaceId));
    const original = journal.httpOutcome(options.commandId, options.principal.id);
    if (original && original.hash !== options.hash) throw new DomainError('command_id_conflict', 'The original native operation represents different arguments', 409);
    if (original) {
      authorizeCreation(scope, original);
      for (const projectId of original.creation?.scopeProjectIds ?? (original.kind === 'http_completed' ? original.audit.map(entry => entry.projectId) : [])) options.checkProject?.(projectId);
    }
    const saved = await recoverCoreHttpOutcome(sql, options.pool, options.principal, scope, options.commandId, original);
    await sql.query('COMMIT');
    return saved;
  } catch (error) { await sql.query('ROLLBACK'); throw error; }
  finally { sql.release(); }
}

async function recoverCoreHttpOutcome(sql: SqlExecutor, pool: CoreWorkspacePool, principal: Actor, scope: CoreScope, commandId: string, original: CoreHttpOutcome | undefined): Promise<CoreHttpOutcome | undefined> {
  if (!original || original.kind === 'http_rejected') return original;
  const workspaceId = scope.workspaceId, root = pool.rootFor(workspaceId), journal = new CoreCommandJournal(root);
  let saved: CoreHttpOutcome | undefined = original;
  // Confirm only already-published exact bytes; never replay creation or infer identity from a title.
  if (saved.creation) await pool.confirmCreation(workspaceId, saved.creation.coreKey);
  const recoveredFacts = recoverPreparedCoreCreations(root, journal).flatMap(entry =>
    entry.kind === 'fact_completed' && entry.commandId === commandId && entry.actorId === principal.id ? [entry.captured] : []);
  if (saved.kind === 'http_pending' && saved.creation?.prepared) {
    const prepared = saved.creation.prepared;
    const fact = Workspace.inspectCreation(root, saved.creation.coreKey, prepared.targetId);
    if (fact.current) scope.entity(fact.current);
    if (!fact.pending && fact.request?.id === prepared.targetId && fact.request.hash === saved.creation.inputHash && fact.request.revision === prepared.revision) {
      journal.completeHttp({ commandId, actorId: principal.id, hash: saved.hash, targetId: prepared.targetId, revision: prepared.revision,
        audit: prepared.audit, creation: saved.creation, facts: recoveredFacts });
      saved = journal.httpOutcome(commandId, principal.id);
    }
  }
  if (saved?.kind === 'http_completed') {
    await appendProjectAudit(sql, workspaceId, principal, saved.audit);
    for (const fact of saved.facts ?? recoveredFacts) await insertServiceFact(sql, workspaceId, fact);
  }
  return saved;
}

  function requireWorkspaceAdmin(scope: CoreScope): void {
    if (!scope.unrestricted) throw new DomainError('permission_denied', 'Workspace-wide configuration requires workspace scope', 403);
  }
  function requireProjectInScope(scope: CoreScope, project: unknown): void {
    if (!scope.allowsProject(project)) throw new DomainError('not_found_or_forbidden', 'Project is not accessible', 404);
  }
export type CoreMutationOptions = {
  database: () => Pool;
  principal: Actor;
  workspace: Workspace;
  scope: CoreScope;
  action: string;
  input: Record<string, unknown>;
  targetId?: string;
  before?: FileRecord;
  mutate: (creationKey: string | undefined, guard: WorkspaceMutationGuard, prepared: WorkspaceCreationPrepared) => Promise<FileRecord | { id: string; deleted: true }>;
  capability?: Capability;
  key?: string;
  local?: { key: string; directory: LocalDirectory; recovering: boolean };
  bindLocalProject?: (sql: SqlExecutor, mount: ProjectMount) => Promise<void>;
  log?: Pick<FastifyRequest['log'], 'error'>;
  checkAuthorization?: (sql: SqlExecutor) => Promise<void>;
  guard?: WorkspaceMutationGuard;
};

/** Shared native service: HTTP and trusted Agent calls retain identical guards, facts and journal keys. */
export async function executeAuditedCoreMutation(options: CoreMutationOptions): Promise<FileRecord | { id: string; deleted: true }> {
    const { principal, workspace, scope, action, input, targetId, before, mutate, local, capability = 'planning.edit' } = options;
    const hash = requestHash({ action, targetId, input });
    const headerKey = local?.key ?? options.key;
    const key = headerKey ?? (targetId && typeof input.revision === 'string' ? hash : randomUUID());
    const commandId = nativeCommandId(scope.workspaceId, principal.id, action, targetId, key);
    const journal = new CoreCommandJournal(workspace.root);
    const sql = await options.database().connect();
    const isCreation = targetId === undefined;
    const coreKey = `native:${commandId}`;
    const { localDirectory: _directory, ...nativeInput } = input;
    const creationInput = action === 'CreateCoreWorkItem' ? { ...nativeInput, entity: 'work_item' } : nativeInput;
    let creation: CoreHttpCreation | undefined = isCreation ? {
      coreKey, inputHash: creationInputHash(creationInput), scopeProjectIds: typeof input.project === 'string' ? [input.project] : [],
    } : undefined;
    let fileCommitted = false, journalCompleted = false;
    try {
      await sql.query('BEGIN');
      await lockWorkspace(sql, scope.workspaceId);
      const fresh = await authorizeCoreScope(sql, principal, scope.workspaceId, capability);
      if (fresh.membership.version !== scope.membership.version) throw new DomainError('permission_denied', 'Membership changed; refresh authorization before writing', 403);
      await options.checkAuthorization?.(sql);
      if (local) await requireLocalManagement(sql, principal, scope.workspaceId, true);
      if (before) fresh.entity(before);
      if (before) await assertLocalProjectWritable(sql, scope.workspaceId, before.entity.entity === 'project' ? before.id : typeof before.entity.project === 'string' ? before.entity.project : undefined);
      if (action === 'DeleteCoreEntity' && before) await assertCoreDeletionSafe(sql, scope.workspaceId, before);
      const saved = isCreation ? journal.httpOutcome(commandId, principal.id) : journal.findHttp(commandId, principal.id);
      if (saved) {
        if (saved.hash !== hash) throw new DomainError('command_id_conflict', 'Idempotency key already represents a different native request', 409);
        if (saved.kind === 'http_rejected') throw new DomainError('core_creation_rejected', 'The original creation was rejected; use a new key for an edited creation intent', 409);
        if (saved.kind === 'http_pending' && !local?.recovering) throw new DomainError('core_write_outcome_unknown', 'The previous native write outcome is unknown; reconcile the source before making another write', 409);
        if (saved.kind === 'http_pending') {
          // Only the explicit local recovery endpoint may resume its durable, exact reserved operation.
          creation = saved.creation ?? creation;
        } else {
        for (const entry of saved.audit) if (!fresh.allowsProject(entry.projectId)) throw new DomainError('not_found_or_forbidden', 'Entity is not accessible', 404);
        journalCompleted = true;
        if (local) {
          const mount = workspace.projectLocation(saved.targetId);
          if (!mount) throw new DomainError('local_project_binding_missing', 'Project storage identity is unavailable', 503);
          if (!options.bindLocalProject) throw new DomainError('local_project_binding_missing', 'Project binding service is unavailable', 503);
          await options.bindLocalProject(sql, mount);
        }
        await appendProjectAudit(sql, scope.workspaceId, principal, saved.audit);
        for (const fact of saved.facts ?? []) await insertServiceFact(sql, scope.workspaceId, fact);
        await sql.query('COMMIT');
        if (saved.revision === null) return { id: saved.targetId, deleted: true };
        let current: FileRecord;
        try { current = workspace.get(saved.targetId); }
        catch (error) {
          if (error instanceof WorkspaceError) throw new DomainError('core_write_recovered', 'The original write and audit are recovered, but its current source is unavailable; the original will not be recreated', 409);
          throw error;
        }
        fresh.entity(current);
        if (current.revision !== saved.revision) throw new DomainError('core_write_recovered', 'The original write and audit are recovered, but the source has since changed; read the current version', 409);
        return current;
        }
      }
      // Historical unscoped keys remain readable without inventing a new actor-attributed creation.
      const legacy = isCreation && headerKey ? Workspace.inspectCreation(workspace.root, headerKey) : undefined;
      if (legacy?.request) {
        if (legacy.request.hash !== creation?.inputHash || legacy.deleted || !legacy.current || legacy.unavailable)
          throw new DomainError('command_id_conflict', 'The key conflicts with its historical creation; the original cannot be recreated', 409);
        fresh.entity(legacy.current);
        if (!legacy.request.revision || legacy.current.revision !== legacy.request.revision)
          throw new DomainError('core_write_recovered', 'The historical creation exists, but its original revision is unavailable or its source has changed; read the current source without recreating it', 409);
        await sql.query('COMMIT');
        return legacy.current;
      }
      if (!local?.recovering && isCreation && Workspace.inspectCreation(workspace.root, coreKey).request)
        throw new DomainError('core_write_outcome_unknown', 'A durable creation exists without its native request journal; administrative reconciliation is required', 409);
      if (local) {
        const targetRoot = local.directory.mode === 'existing' ? path.resolve(local.directory.path) : path.resolve(local.directory.parentPath, local.directory.folderName);
        await assertLocalProjectTargetAvailable(sql, workspace.root, targetRoot, coreKey);
      }
      journal.pendingHttp(commandId, hash, principal.id, creation);
      const guard: WorkspaceMutationGuard = async (previous, next) => {
        if (previous) fresh.entity(previous);
        await assertLocalProjectWritable(sql, scope.workspaceId, next.entity === 'project' ? next.id : typeof next.project === 'string' ? next.project : undefined);
        if (next.entity === 'project') {
          if (!previous) requireWorkspaceAdmin(fresh);
          else requireProjectInScope(fresh, next.id);
        } else requireProjectInScope(fresh, next.project);
        if (local && next.entity === 'project' && typeof next.owner === 'string') await requireTaskAssignee(sql, scope.workspaceId, next.id, next.owner);
        assertCoreProtectedMetadata(next, previous?.entity);
        assertMutationCapabilities(fresh, previous?.entity, next, workspace.configuration().config);
        await assertCoreTaskMutation({
          get: id => workspace.get(id), configuration: workspace.configuration().config,
          requireCapability: capability => requireCapability(fresh, capability), allowsProject: project => fresh.allowsProject(project),
          requireAssignee: (project, assignee) => requireTaskAssignee(sql, scope.workspaceId, project, assignee),
        }, next, previous?.entity);
        await options.guard?.(previous, next);
      };
      const prepared: WorkspaceCreationPrepared = record => {
        if (!creation) return;
        const audit = coreProjectAuditWrites(undefined, record, { source: 'core_http', commandId, action, actorId: principal.id, occurredAt: new Date().toISOString() });
        creation = { ...creation, scopeProjectIds: record.entity.entity === 'project' ? [record.id] : creation.scopeProjectIds,
          prepared: { targetId: record.id, revision: record.revision, audit } };
        journal.pendingHttp(commandId, hash, principal.id, creation);
      };
      const facts: CapturedServiceFact[] = [];
      let result: FileRecord | { id: string; deleted: true };
      try { result = await workspace.captureMutations(captureCoreFacts({ sql, workspaceId: scope.workspaceId, root: workspace.root,
        sourceKind: 'core_http', operationId: commandId, requestHash: hash, actorId: principal.id, facts, configuration: workspace.configuration().config }),
        () => mutate(isCreation ? coreKey : headerKey, guard, prepared)); }
      catch (error) {
        const uncertain = !!local && workspace.projectLocations().some(location => location.initialization.key === coreKey) || error instanceof WorkspaceError && error.diagnostics.some(item => ['TRANSACTION_FAILED', 'PERSISTENT_STATE_INVALID', 'FILE_UNWRITABLE', 'PROJECT_INITIALIZATION_PENDING'].includes(item.code));
        if ((error instanceof WorkspaceError || error instanceof ProtocolError || error instanceof DomainError || error instanceof z.ZodError) && !uncertain) journal.rejectHttp(commandId, hash, principal.id, creation);
        if (uncertain) {
          options.log?.error({ commandId }, 'Native file write outcome is uncertain');
          throw new DomainError('core_write_outcome_unknown', 'The file write outcome is uncertain. Reconcile the source before making another write.', 503);
        }
        throw error;
      }
      fileCommitted = true;
      const after = 'entity' in result ? result : undefined;
      if (local && 'entity' in result) {
        const mount = workspace.projectLocation(result.id);
        if (!mount) throw new DomainError('local_project_binding_missing', 'The initialized project has no durable storage binding', 503);
        if (!options.bindLocalProject) throw new DomainError('local_project_binding_missing', 'Project binding service is unavailable', 503);
        await options.bindLocalProject(sql, mount);
      }
      if (local?.recovering) for (const entry of recoverPreparedCoreCreations(workspace.root, journal)) {
        if (entry.kind === 'fact_completed' && entry.commandId === commandId && entry.actorId === principal.id && !facts.some(fact => fact.fact.factId === entry.captured.fact.factId)) facts.push(entry.captured);
      }
      if (after) fresh.entity(after);
      const audit = creation?.prepared?.audit ?? coreProjectAuditWrites(before, after, { source: 'core_http', commandId, action, actorId: principal.id, occurredAt: new Date().toISOString() });
      journal.completeHttp({ commandId, actorId: principal.id, hash, targetId: result.id, revision: after?.revision ?? null, audit, facts, ...(creation ? { creation } : {}) });
      journalCompleted = true;
      await appendProjectAudit(sql, scope.workspaceId, principal, audit);
      for (const fact of facts) await insertServiceFact(sql, scope.workspaceId, fact);
      await sql.query('COMMIT');
      return result;
    } catch (error) {
      await sql.query('ROLLBACK');
      if (error instanceof DomainError && ['core_write_recovered', 'not_found_or_forbidden', 'permission_denied', 'command_id_conflict', 'core_creation_rejected', 'core_write_outcome_unknown'].includes(error.code)) throw error;
      if (journalCompleted || fileCommitted) {
        options.log?.error({ commandId, code: error instanceof DomainError ? error.code : 'audit_persistence_failed' }, 'Native file write requires audit recovery');
        throw new DomainError(journalCompleted ? 'core_audit_pending' : 'core_write_outcome_unknown',
          journalCompleted ? 'The file write completed, but audit persistence is pending. Retry this exact request to recover; do not apply the change again.' : 'The file write outcome is uncertain. Reconcile the source before making another write.', 503);
      }
      throw error;
    } finally { sql.release(); }
  }
export function registerCoreRoutes(app: FastifyInstance, options: { database: () => Pool; actor: CoreAuthenticator; pool: CoreWorkspacePool; localProjects: LocalProjectConfiguration; bindLocalProject: (sql: SqlExecutor, mount: ProjectMount) => Promise<void>; checkLocalProject: (mount: ProjectMount) => Promise<void>; maintainLocalProject: (sql: SqlExecutor, workspace: Workspace, operation: 'migrate' | 'relocate' | 'rebind', workspaceId: string, projectId: string, targetRoot: string, operationId: string, writersStopped: boolean, targetMode: 'existing' | 'new') => Promise<void>; recoverLocalCommand: (request: FastifyRequest, workspaceId: string, command: Command) => Promise<void> }) {
  const { pool } = options;

  async function scopeFor(request: FastifyRequest, workspaceId: string, capability: Capability): Promise<CoreScope> {
    return authorizeCoreScope(options.database(), await options.actor(request), workspaceId, capability);
  }
  async function workspaceFor(request: FastifyRequest<{ Params: { workspaceId: string } }>, capability: Capability): Promise<{ workspace: Workspace; scope: CoreScope }> {
    const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
    const scope = await scopeFor(request, workspaceId, capability);
    return { workspace: await pool.get(workspaceId), scope };
  }
  function scopedSnapshot(snapshot: WorkspaceSnapshot, scope: CoreScope): WorkspaceSnapshot {
    if (scope.unrestricted) return snapshot;
    const files = snapshot.files.filter(file => scope.allows(file));
    return {
      ...snapshot,
      files,
      unsupportedFiles: [],
      views: snapshot.views.filter(view => !view.project || scope.allowsProject(view.project)),
      configurationErrors: [],
      errors: snapshot.errors.filter(issue => !!issue.entityId && files.some(file => file.id === issue.entityId)),
    };
  }

  async function auditedMutation(request: FastifyRequest, workspace: Workspace, scope: CoreScope, action: string,
    input: Record<string, unknown>, targetId: string | undefined, before: FileRecord | undefined,
    mutate: CoreMutationOptions['mutate'], capability: Capability = 'planning.edit',
    local?: CoreMutationOptions['local']): Promise<FileRecord | { id: string; deleted: true }> {
    return executeAuditedCoreMutation({
      database: options.database, principal: await options.actor(request), workspace, scope, action, input, mutate, capability,
      bindLocalProject: options.bindLocalProject, log: request.log,
      ...(targetId === undefined ? {} : { targetId }), ...(before ? { before } : {}),
      ...(idempotencyKey(request) === undefined ? {} : { key: idempotencyKey(request)! }), ...(local ? { local } : {}),
    });
  }

  async function createLocal(request: FastifyRequest, workspaceId: string, input: Record<string, unknown>, directory: LocalDirectory, key: string, recovering: boolean): Promise<FileRecord> {
    const principal = await options.actor(request);
    await requireLocalManagement(options.database(), principal, workspaceId, true);
    const saved = await beginLocalProjectOperation(options.database(), principal, workspaceId, key, 'initialize', 'native', { input, directory });
    if (saved.status === 'rejected') throw new DomainError('core_creation_rejected', 'The original initialization was rejected', 409);
    const scope = await scopeFor(request, workspaceId, 'planning.edit'), workspace = await pool.get(workspaceId);
    let result: FileRecord | { id: string; deleted: true };
    try {
      result = await auditedMutation(request, workspace, scope, 'CreateCoreEntity', { ...input, localDirectory: directory }, undefined, undefined,
        (coreKey, guard, prepared) => initializeLocalProject(workspace, options.localProjects, workspaceId, input, coreKey!, directory, guard, prepared, recovering),
        'planning.edit', { key, directory, recovering });
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'core_write_recovered') throw error;
      const original = new CoreCommandJournal(workspace.root).httpOutcome(nativeCommandId(workspaceId, principal.id, 'CreateCoreEntity', undefined, key), principal.id);
      if (original?.kind !== 'http_completed' || original.revision === null) throw error;
      result = workspace.get(original.targetId);
    }
    if (!('entity' in result)) throw new DomainError('core_write_outcome_unknown', 'Project initialization has no confirmed source', 503);
    await options.database().query("UPDATE local_project_operations SET project_id=$4,status='ready',updated_at=clock_timestamp() WHERE workspace_id=$1 AND actor_id=$2 AND request_key=$3", [workspaceId, principal.id, key, result.id]);
    return result;
  }


  async function creationResult(sql: SqlExecutor, scope: CoreScope, root: string, key: string, saved: CoreHttpOutcome | undefined): Promise<CoreCreationAttempt> {
    if (!saved) return { status: 'not_found' };
    authorizeCreation(scope, saved);
    if (saved.kind === 'http_rejected') return { status: 'rejected' };
    const prepared = saved.creation?.prepared;
    const targetId = saved.kind === 'http_completed' ? saved.targetId : prepared?.targetId;
    const fact = Workspace.inspectCreation(root, saved.creation?.coreKey ?? key, targetId);
    if (fact.current) scope.entity(fact.current);
    const revision = saved.kind === 'http_completed' ? saved.revision : prepared?.revision;
    if (!targetId || !revision || fact.pending || !fact.request || fact.request.id !== targetId
      || saved.creation && (fact.request.hash !== saved.creation.inputHash || fact.request.revision !== revision))
      return { status: 'pending', reason: 'write_unconfirmed' };
    if (saved.kind === 'http_pending') return { status: 'pending', reason: 'audit_pending' };
    for (const entry of saved.audit) {
      const dedupe = JSON.stringify([entry.projectId, entry.targetId, entry.beforeVersion, entry.afterVersion]);
      const row = await sql.query(`SELECT 1 FROM project_audit WHERE workspace_id=$1 AND actor_id=$2 AND command_id=$3 AND source=$4 AND dedupe_key=$5`,
        [scope.workspaceId, saved.actorId, entry.commandId, entry.source, dedupe]);
      if (!row.rows.length) return { status: 'pending', reason: 'audit_pending' };
    }
    return {
      status: 'committed', entityId: targetId, revision,
      current: fact.deleted ? { status: 'deleted' } : fact.current ? { status: 'present', record: fact.current }
        : { status: fact.unavailable ? 'unavailable' : 'missing' },
    };
  }

  async function creationAttempt(request: FastifyRequest, recover: boolean, explicit?: { workspaceId: string; key: string }): Promise<CoreCreationAttempt> {
    const route = explicit ?? z.object({ workspaceId: workspaceIdSchema, key: creationKeySchema }).parse(request.params);
    const workspaceId = route.workspaceId, key = route.key;
    const principal = await options.actor(request);
    if (recover) {
      const local = await readLocalProjectOperation(options.database(), principal, workspaceId, key);
      const original = new CoreCommandJournal(pool.rootFor(workspaceId)).httpOutcome(nativeCommandId(workspaceId, principal.id, 'CreateCoreEntity', undefined, key), principal.id);
      if (local?.operation === 'initialize' && local.transport === 'native' && local.status !== 'rejected' && original?.kind !== 'http_rejected')
        await createLocal(request, workspaceId, local.request.input as Record<string, unknown>, localDirectorySchema.parse(local.request.directory), key, true);
    }
    const sql = await options.database().connect();
    try {
      if (recover) { await sql.query('BEGIN'); await lockWorkspace(sql, workspaceId); }
      const scope = await authorizeCoreScope(sql, principal, workspaceId, 'domain.read');
      const root = pool.rootFor(workspaceId), journal = new CoreCommandJournal(root);
      const commandId = nativeCommandId(workspaceId, principal.id, 'CreateCoreEntity', undefined, key);
      let saved = journal.httpOutcome(commandId, principal.id);
      if (saved) authorizeCreation(scope, saved);
      if (recover) saved = await recoverCoreHttpOutcome(sql, pool, principal, scope, commandId, saved);
      const result = await creationResult(sql, scope, root, key, saved);
      if (recover) await sql.query('COMMIT');
      return result;
    } catch (error) {
      if (recover) await sql.query('ROLLBACK');
      throw error;
    } finally { sql.release(); }
  }

  app.register(async core => {
    registerLocalProjectRoutes(core, { database: options.database, actor: options.actor, config: options.localProjects,
      workspace: workspaceId => pool.get(workspaceId), create: createLocal,
      nativeAttempt: (request, workspaceId, key, recovering) => creationAttempt(request, recovering, { workspaceId, key }),
      checkMount: options.checkLocalProject, maintain: options.maintainLocalProject, recoverCommand: options.recoverLocalCommand });
    core.setErrorHandler(coreError);
    const streams = new Set<() => void>();
    core.addHook('preClose', async () => { for (const finish of streams) finish(); });
    core.get<{ Params: { workspaceId: string; key: string } }>('/api/v1/workspaces/:workspaceId/core/creation-attempts/:key', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return creationAttempt(request, false);
    });
    core.post<{ Params: { workspaceId: string; key: string } }>('/api/v1/workspaces/:workspaceId/core/creation-attempts/:key/recover', async (request, reply) => {
      envelope(jsonObject(request), []);
      reply.header('Cache-Control', 'no-store');
      return creationAttempt(request, true);
    });

    core.get<{ Params: { workspaceId: string } }>('/api/v1/workspaces/:workspaceId/core/health', async request => {
      await workspaceFor(request, 'domain.read');
      return { ok: true, service: 'project-management-core' };
    });
    core.get<{ Params: { workspaceId: string } }>('/api/v1/workspaces/:workspaceId/core/protocol', async request => {
      const { workspace } = await workspaceFor(request, 'domain.read');
      return workspace.protocol();
    });
    core.get<{ Params: { workspaceId: string } }>('/api/v1/workspaces/:workspaceId/core/config', async request => {
      const { workspace, scope } = await workspaceFor(request, 'domain.read');
      const result = workspace.configuration();
      return scope.unrestricted ? result : { ...result, diagnostics: [] };
    });
    core.put<{ Params: { workspaceId: string } }>('/api/v1/workspaces/:workspaceId/core/config', async request => {
      const { workspace, scope } = await workspaceFor(request, 'planning.edit');
      requireWorkspaceAdmin(scope);
      const input = jsonObject(request);
      envelope(input, ['config', 'revision']);
      if (!input.config || typeof input.config !== 'object' || Array.isArray(input.config)) badRequest('config must be an object', 'config');
      return workspace.saveConfiguration(input.config, requiredRevision(input));
    });
    core.post<{ Params: { workspaceId: string } }>('/api/v1/workspaces/:workspaceId/core/query', async request => {
      const { workspace, scope } = await workspaceFor(request, 'domain.read');
      const input = jsonObject(request);
      envelope(input, ['view', 'archived']);
      if (!input.view || typeof input.view !== 'object' || Array.isArray(input.view)) badRequest('view must be an object', 'view');
      const archived = archiveSchema.parse(input).archived;
      return { items: workspace.query(input.view as ViewConfig, archived === undefined ? {} : { archived }).filter(file => scope.allows(file)) };
    });
    core.post<{ Params: { workspaceId: string } }>('/api/v1/workspaces/:workspaceId/core/graph', async request => {
      const { workspace, scope } = await workspaceFor(request, 'domain.read');
      const query = graphQuerySchema.parse(jsonObject(request)) as GraphQuery;
      return workspace.graph(query, scope.unrestricted ? undefined : file => scope.allows(file));
    });
    core.get<{ Params: { workspaceId: string } }>('/api/v1/workspaces/:workspaceId/core/migrations', async request => {
      const { workspace, scope } = await workspaceFor(request, 'planning.lifecycle');
      requireWorkspaceAdmin(scope);
      return workspace.migration('list');
    });
    core.post<{ Params: { workspaceId: string } }>('/api/v1/workspaces/:workspaceId/core/migrations/preview', async request => {
      const { workspace, scope } = await workspaceFor(request, 'planning.lifecycle');
      requireWorkspaceAdmin(scope);
      const input = jsonObject(request);
      envelope(input, ['kind', 'config', 'changes']);
      return workspace.migration('preview', input);
    });
    for (const action of ['apply', 'restore'] as const) {
      core.post<{ Params: { workspaceId: string; id: string } }>(`/api/v1/workspaces/:workspaceId/core/migrations/:id/${action}`, async request => {
        const { workspace, scope } = await workspaceFor(request, 'planning.lifecycle');
        requireWorkspaceAdmin(scope);
        const input = jsonObject(request);
        envelope(input, ['revision']);
        return workspace.migration(action, { id: migrationIdSchema.parse(request.params.id), revision: requiredRevision(input) });
      });
    }
    core.get<{ Params: { workspaceId: string } }>('/api/v1/workspaces/:workspaceId/core/workspace', async request => {
      const { workspace, scope } = await workspaceFor(request, 'domain.read');
      return scopedSnapshot(workspace.snapshot(), scope);
    });
    core.get<{ Params: { workspaceId: string } }>('/api/v1/workspaces/:workspaceId/core/items', async request => {
      const { workspace, scope } = await workspaceFor(request, 'domain.read');
      return { items: workspace.items(itemQuerySchema.parse(request.query) as ItemQuery).filter(file => scope.allows(file)) };
    });
    core.get<{ Params: { workspaceId: string; id: string } }>('/api/v1/workspaces/:workspaceId/core/files/:id', async request => {
      const { workspace, scope } = await workspaceFor(request, 'domain.read');
      return scope.entity(workspace.source(identifierSchema.parse(request.params.id)));
    });
    core.put<{ Params: { workspaceId: string; id: string } }>('/api/v1/workspaces/:workspaceId/core/files/:id', async request => {
      const { workspace, scope } = await workspaceFor(request, 'planning.edit');
      const id = identifierSchema.parse(request.params.id);
      const current = workspace.get(id);
      scope.entity(current);
      const input = jsonObject(request);
      envelope(input, ['raw', 'revision']);
      if (typeof input.raw !== 'string') badRequest('raw must be a string', 'raw');
      const raw = input.raw, revision = requiredRevision(input);
      return auditedMutation(request, workspace, scope, 'UpdateCoreSource', input, id, current, (_key, guard) => workspace.save(id, raw, revision, guard));
    });
    core.patch<{ Params: { workspaceId: string; id: string } }>('/api/v1/workspaces/:workspaceId/core/entities/:id', async request => {
      const { workspace, scope } = await workspaceFor(request, 'domain.read');
      const id = identifierSchema.parse(request.params.id);
      const current = workspace.get(id);
      scope.entity(current);
      const input = jsonObject(request);
      envelope(input, ['changes', 'revision']);
      if (!input.changes || typeof input.changes !== 'object' || Array.isArray(input.changes)) badRequest('changes must be an object', 'changes');
      const changes = input.changes as Record<string, unknown>;
      const revision = requiredRevision(input);
      return auditedMutation(request, workspace, scope, 'UpdateCoreProperties', input, id, current, (_key, guard) => workspace.patch(id, changes, revision, guard), 'domain.read');
    });
    core.post<{ Params: { workspaceId: string } }>('/api/v1/workspaces/:workspaceId/core/items', async request => {
      const { workspace, scope } = await workspaceFor(request, 'planning.edit');
      const input = jsonObject(request);
      return auditedMutation(request, workspace, scope, 'CreateCoreWorkItem', input, undefined, undefined, (key, guard, prepared) => workspace.create(input, key, guard, prepared));
    });
    core.post<{ Params: { workspaceId: string } }>('/api/v1/workspaces/:workspaceId/core/entities', async request => {
      const { workspace, scope } = await workspaceFor(request, 'planning.edit');
      const input = jsonObject(request);
      if (input.entity === 'project' && options.localProjects.enabled) {
        const { localDirectory, ...native } = input;
        return createLocal(request, scope.workspaceId, native, localDirectorySchema.parse(localDirectory), creationKeySchema.parse(idempotencyKey(request)), false);
      }
      if ('localDirectory' in input) throw new DomainError('local_projects_disabled', 'Local project directories are not configured on this deployment', 409);
      return auditedMutation(request, workspace, scope, 'CreateCoreEntity', input, undefined, undefined, (key, guard, prepared) => workspace.createEntity(input, key, guard, prepared));
    });
    for (const action of ['archive', 'restore'] as const) {
      core.post<{ Params: { workspaceId: string; id: string } }>(`/api/v1/workspaces/:workspaceId/core/entities/:id/${action}`, async request => {
        const { workspace, scope } = await workspaceFor(request, 'planning.lifecycle');
        const id = identifierSchema.parse(request.params.id);
        const current = workspace.get(id);
        scope.entity(current);
        const input = jsonObject(request);
        envelope(input, ['revision']);
        const revision = requiredRevision(input);
        return auditedMutation(request, workspace, scope, action === 'archive' ? 'ArchiveCoreEntity' : 'RestoreCoreEntity', input, id, current, (_key, guard) => workspace[action](id, revision, guard), 'planning.lifecycle');
      });
    }
    core.delete<{ Params: { workspaceId: string; id: string } }>('/api/v1/workspaces/:workspaceId/core/entities/:id', async request => {
      const { workspace, scope } = await workspaceFor(request, 'planning.lifecycle');
      const id = identifierSchema.parse(request.params.id);
      const current = workspace.snapshot().files.find(record => record.id === id);
      if (current) scope.entity(current);
      const input = jsonObject(request);
      envelope(input, ['revision']);
      const revision = requiredRevision(input);
      return auditedMutation(request, workspace, scope, 'DeleteCoreEntity', input, id, current, () => workspace.delete(id, revision), 'planning.lifecycle');
    });
    core.get<{ Params: { workspaceId: string; id: string } }>('/api/v1/workspaces/:workspaceId/core/context/:id', async request => {
      const { workspace, scope } = await workspaceFor(request, 'domain.read');
      const id = identifierSchema.parse(request.params.id);
      scope.entity(workspace.get(id));
      return scope.unrestricted ? workspace.context(id) : workspace.context(id, record => scope.allows(record));
    });
    core.put<{ Params: { workspaceId: string; id: string } }>('/api/v1/workspaces/:workspaceId/core/views/:id', async request => {
      const { workspace, scope } = await workspaceFor(request, 'planning.edit');
      requireWorkspaceAdmin(scope);
      const id = viewIdSchema.parse(request.params.id);
      const input = jsonObject(request);
      envelope(input, ['id', 'name', 'entity', 'project', 'layout', 'group_by', 'filter', 'sort', 'where', 'order_by', 'order', 'columns', 'revision']);
      if (input.id !== undefined && input.id !== id) badRequest('View ID must match the route ID', 'id');
      if (input.revision !== undefined) requiredRevision(input);
      return workspace.saveView(id, input);
    });
    core.get<{ Params: { workspaceId: string } }>('/api/v1/workspaces/:workspaceId/core/events', async (request, reply) => {
      const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
      const principal = await options.actor(request);
      const scope = await authorizeCoreScope(options.database(), principal, workspaceId, 'domain.read');
      const workspace = await pool.get(workspaceId);
      reply.hijack();
      // SSE owns its lifetime; the ordinary 10s HTTP idle timeout is shorter
      // than the authorization heartbeat and would silently kill live updates.
      reply.raw.setTimeout(0);
      reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      let closed = false;
      const send = (event: string, data: unknown): void => {
        if (!closed && !reply.raw.destroyed && reply.raw.writable) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const canSend = async (): Promise<boolean> => {
        if (closed) return false;
        const fresh = await scopeFor(request, workspaceId, 'domain.read');
        if (closed) return false;
        if (fresh.unrestricted !== scope.unrestricted || !isDeepStrictEqual(fresh.membership.projectIds, scope.membership.projectIds)) {
          finish();
          return false;
        }
        return true;
      };
      let pending = Promise.resolve();
      const unsubscribe = workspace.onChange(event => {
        if (closed) return;
        // Revalidate the actual session before every event, not only heartbeats.
        // Serial checks preserve event order without trusting the opening scope.
        pending = pending.then(async () => {
          if (await canSend()) send(event.type, scope.unrestricted ? event : { type: event.type, reason: event.reason });
        }).catch(finish);
      });
      let checking = false;
      const heartbeat = setInterval(() => {
        if (closed || checking) return;
        checking = true;
        void canSend().then(authorized => {
          if (authorized) send('heartbeat', { time: Date.now() });
        }, finish).finally(() => { checking = false; });
      }, 15_000);
      const finish = (): void => {
        if (closed) return;
        closed = true;
        streams.delete(finish);
        clearInterval(heartbeat);
        unsubscribe();
        if (!reply.raw.destroyed) reply.raw.end();
      };
      streams.add(finish);
      reply.raw.once('close', finish);
      send('ready', { type: 'ready' });
    });
  });
}
