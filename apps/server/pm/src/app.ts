import { lstatSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { z } from 'zod';
import { DomainError, type Actor, type Command, type CommandReceipt, type EntityKind } from '../../../../packages/domain/src/core.ts';
import { createPool, checkDatabase, lockWorkspace } from '../../../../packages/infrastructure/src/database.ts';
import { createBlobStore, type BlobStorageProvider } from '../../../../packages/infrastructure/src/blob-storage-provider.ts';
import { bindBlobStore } from '../../../../packages/infrastructure/src/blob-storage-binding.ts';
import type { BlobStorageLocator } from '../../../../packages/infrastructure/src/blob-storage-config.ts';
import { login, authenticate, logout } from '../../../../packages/infrastructure/src/auth.ts';
import { createRegistry } from '../../../../packages/application/src/registry.ts';
import { runCommand, getCommandReceipt } from '../../../../packages/application/src/kernel.ts';
import { listEntities, listWorkspaces, readEntity } from '../../../../packages/application/src/queries.ts';
import { getMembership, listMembers, requireCapability } from '../../../../packages/application/src/access.ts';
import { downloadArtifactVersion } from '../../../../packages/application/src/delivery.ts';
import { readChanges } from '../../../../packages/application/src/changes.ts';
import { buildOpenApi } from '../../../../packages/contracts/src/openapi.ts';
import { registerEventStream } from './events.ts';
import { registerCoreRoutes, CoreScope, CoreWorkspacePool, authorizeCoreScope } from './core-routes.ts';
import { executeCoreCommand, isCoreCommand, isCoreEntityKind, listCoreEntities, readCoreEntity } from './core-adapter.ts';
import { readExternalReceipt, recordExternalReceipt, requestHash } from '../../../../packages/application/src/core-bridge.ts';
import { CoreCommandJournal } from './core-journal.ts';
import { WorkspaceError } from '../../../../packages/pm-core/index.ts';
import type { CoreAccess, SqlExecutor } from '../../../../packages/application/src/ports.ts';
import { requireDashboardReadSelf, type DashboardReadContext } from '../../../../packages/application/src/dashboard-read.ts';
import { readPersonalDashboard } from '../../../../packages/application/src/dashboard-personal.ts';
import { readTimeDashboard } from '../../../../packages/application/src/dashboard-time.ts';
import { readSprintsDashboard } from '../../../../packages/application/src/dashboard-sprints.ts';
import { readPortfolioDashboard } from '../../../../packages/application/src/dashboard-portfolio.ts';
import { readPlanningDashboard } from '../../../../packages/application/src/dashboard-planning.ts';
import { readProjectExtras } from '../../../../packages/application/src/project-extras.ts';
import { readProjectDirectory } from '../../../../packages/application/src/project-directory.ts';
import { projectAuditOptionsSchema, readProjectAudit, type ProjectAuditWrite } from '../../../../packages/application/src/project-audit.ts';
import { readMemberDirectory } from '../../../../packages/application/src/member-directory.ts';
import type { InvitationMailConfig } from '../../../../packages/infrastructure/src/invitation-mail.ts';
import { registerInvitationRoutes } from './invitation-routes.ts';
import { readTeamDirectory } from '../../../../packages/application/src/team-directory.ts';
import { readTeamWorkload } from '../../../../packages/application/src/team-workload.ts';
import { registerWorkspaceIdentityRoutes } from './workspace-identity-routes.ts';
import { registerAccountSecurityRoutes } from './account-security-routes.ts';
import { readTaskComments, readTaskCommentHistory, taskCommentsOptionsSchema, taskCommentHistoryOptionsSchema } from '../../../../packages/application/src/task-comments.ts';
import { taskCommentIdSchema } from '../../../../packages/domain/src/task-comments.ts';
import type { AccountRecoveryMailConfig } from '../../../../packages/infrastructure/src/account-recovery-mail.ts';
import type { WebhookConfig } from '../../../../packages/infrastructure/src/webhook-config.ts';
import type { CapturedServiceFact } from '../../../../packages/application/src/service-facts.ts';
import { readonlyCorePort } from '../../../../packages/pm-core/readonly.ts';
import { CoreFactImporter } from './core-fact-importer.ts';
import { registerNotificationRoutes } from './notification-routes.ts';
import { registerAccountRecoveryRoutes } from './account-recovery-routes.ts';
import { registerWebhookRoutes } from './webhook-routes.ts';
import { registerArtifactFilesRoutes } from './artifact-files-routes.ts';
import { registerAgentToolRoutes } from './agent-tool-routes.ts';
import { registerAgentCoreFilesRoutes } from './agent-core-files-routes.ts';
import { registerAgentReferenceRoutes } from './agent-reference-routes.ts';
import { registerAgentCapabilityRoutes } from './agent-capability-routes.ts';
import { registerAgentIssueSearchRoutes } from './agent-issue-search-routes.ts';
import { registerAgentPreviewRoutes } from './agent-preview-routes.ts';
import { registerAutomationRoutes } from './automation-routes.ts';
import { registerAutomationStudioRoutes } from './automation-studio-routes.ts';
import { registerAutomationGitSyncRoutes } from './automation-git-sync-routes.ts';
import { registerAutomationEventsRoutes } from './automation-events-routes.ts';
import { registerPmAutomationRoutes } from './automation-pm-routes.ts';
import { createPmAutomationMutationPort } from './automation-pm-mutations.ts';
import { createAutomationStudioService } from '../../../../packages/application/src/automation-studio.ts';
import { authorizeAutomationStudioService } from '../../../../packages/application/src/automation-studio-auth.ts';
import { createConfiguredAutomationExecutionPort, verifyAutomationServiceBearer } from '../../../../packages/infrastructure/src/automation-execution-client.ts';
import type { StudioExecutionPort } from '../../../../packages/contracts/src/automation-studio.ts';
import { registerAgentFileAreaRoutes } from './agent-file-area-routes.ts';
import { registerDocumentSourceRoutes } from './document-source-routes.ts';
import { createAgentChatTools } from './agent-chat-tools.ts';
import { artifactVisibilitySchema, type ArtifactVisibility } from '../../../../packages/contracts/src/artifact-files.ts';
import { createProjectBlobStore, initializeProjectBlobStorage, checkProjectBlobStorage } from '../../../../packages/infrastructure/src/project-blobs.ts';
import { readProjectLocation, enumerateProjectMounts, type ProjectMount } from '../../../../packages/pm-core/project-locations.ts';
import { allowedDirectory, assertLocalProjectWritable, beginLocalProjectOperation, requireLocalManagement, type LocalProjectConfiguration } from '../../../../packages/application/src/local-projects.ts';
import { maintainLocalProjectStorage } from '../../../../packages/infrastructure/src/local-project-storage-maintenance.ts';

const projectMetadataWrites: Readonly<Record<string, true>> = { SetProjectCover: true, SetProjectScope: true, SetProjectTeams: true, CreateTaskComment: true, UpdateTaskComment: true, DeleteTaskComment: true, RestoreTaskComment: true, StageUpload: true, RegisterArtifact: true, AddArtifactVersion: true, RenameArtifact: true, HideArtifact: true, RestoreArtifact: true, CopyArtifactVersion: true };

const coreLocks = new Map<string, Promise<void>>();
async function withCoreLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = coreLocks.get(key) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  const guard = current.then(() => undefined, () => undefined);
  coreLocks.set(key, guard);
  void guard.finally(() => { if (coreLocks.get(key) === guard) coreLocks.delete(key); });
  return current;
}

const kinds = ['project', 'work_item', 'milestone', 'conversation', 'intent', 'decision', 'upload', 'artifact', 'artifact_version', 'evidence', 'submission', 'review'] as const;
const uuid = z.uuid().toLowerCase();
const commandSchema = z.strictObject({ commandId: uuid, commandType: z.string().min(1).max(120), targetId: z.string().min(1).max(80).optional(), projectId: z.string().min(1).max(80).optional(), expectedVersions: z.record(z.string().min(1).max(80), z.number().int().positive()).optional(), payload: z.record(z.string(), z.unknown()) });
// A loopback deployment is reached as localhost, 127.0.0.1 or [::1] depending on
// how the browser/port forward was opened; those spellings are the same service.
const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, '127.0.0.1': true, '[::1]': true };
function browserOriginAllowed(origin: string, configured: string): boolean {
  if (origin === configured) return true;
  try {
    const actual = new URL(origin);
    const expected = new URL(configured);
    return actual.protocol === expected.protocol && actual.port === expected.port
      && !actual.username && !actual.password
      && LOOPBACK_HOSTS[actual.hostname] === true && LOOPBACK_HOSTS[expected.hostname] === true;
  } catch { return false; }
}

export function buildApp(options: { logger?: boolean; databaseUrl?: string; blobStore?: BlobStorageProvider; blobStorageLocator?: BlobStorageLocator | null; coreWorkspaceRoot?: string; chatSpaceRoot?: string; localProjects?: Omit<LocalProjectConfiguration, 'coreRoot'> & { coreRoot?: string }; publicOrigin?: string; cookieSecure?: boolean; invitationMail?: InvitationMailConfig; accountRecoveryMail?: AccountRecoveryMailConfig; webhooks?: WebhookConfig; automationRuntime?: StudioExecutionPort; signal?: AbortSignal } = {}) {
  if ((options.blobStore === undefined) !== (options.blobStorageLocator === undefined)) throw new Error('Blob provider and locator must be supplied together');
  // Bound receiving a request, not durable work after its body has arrived.
  // A socket idle timer otherwise cuts off valid slow commits as unknown.
  // onReady recovers up to four real workspaces, including fsync and watcher
  // initialization. HDD recovery exceeded Fastify's 10s default in regression.
  // Fastify uses pluginTimeout for these hooks too: each startup phase gets
  // 60s, separately from HTTP/request deadlines. Never return ready mid-recovery.
  const app = Fastify({ logger: options.logger ? {
    level: 'info',
    redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body'],
    serializers: {
      req(request: FastifyRequest) {
        return { method: request.method, url: request.routeOptions?.url ?? '[unmatched]' };
      },
    },
  } : false, bodyLimit: 12 * 1024 * 1024, connectionTimeout: 0, requestTimeout: 120_000, pluginTimeout: options.databaseUrl ? 60_000 : 10_000, routerOptions: { maxParamLength: 8192 } });
  const pool = options.databaseUrl ? createPool(options.databaseUrl) : undefined;
  const blobProvider = options.blobStore ?? createBlobStore({ provider: 'disabled' });
  // Commands already hold a business connection while reading/writing bytes.
  // Binding checks must not borrow from that exhausted pool under concurrency.
  const storagePool = options.databaseUrl && options.blobStorageLocator ? createPool(options.databaseUrl, 2) : undefined;
  const coreRoot = path.resolve(options.coreWorkspaceRoot ?? options.localProjects?.coreRoot ?? '.local/pm-workspaces');
  const localProjects: LocalProjectConfiguration = { enabled: false, dataRoot: path.resolve('.local'), defaultParent: null, allowedRoots: [], backupRoot: path.resolve('.local/backups'), ...options.localProjects, coreRoot };
  const legacyBlobs = storagePool && options.blobStorageLocator ? bindBlobStore(storagePool, options.blobStorageLocator, blobProvider) : createBlobStore({ provider: 'disabled' });
  const coreWorkspaces = pool ? new CoreWorkspacePool(coreRoot, pool) : undefined;
  const blobs = pool ? createProjectBlobStore({ sql: storagePool ?? pool, legacy: legacyBlobs, resolveProject: async (workspaceId, projectId) => readProjectLocation(path.join(coreRoot, workspaceId), projectId) }) : legacyBlobs;
  async function bindLocalProject(sql: SqlExecutor, mount: ProjectMount): Promise<void> { await initializeProjectBlobStorage(sql, mount); }
  const notificationCore = readonlyCorePort(workspaceId => {
    if (!coreWorkspaces) throw new DomainError('backend_not_initialized', 'The Markdown core is unavailable', 503);
    return coreWorkspaces.rootFor(workspaceId);
  });
  const automationRuntime = options.automationRuntime ?? createConfiguredAutomationExecutionPort();
  const automationStudio = createAutomationStudioService({ database, core: notificationCore, runtime: automationRuntime });
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  let startupWork: Promise<void> | undefined;
  let importWork: Promise<void> | undefined;
  const registry = createRegistry(blobs, options.invitationMail, validateInvitationProjects, options.webhooks);
  const cookieOptions = { path: '/', httpOnly: true, sameSite: 'strict' as const, secure: options.cookieSecure ?? false };
  void app.register(cookie);
  app.addHook('onReady', async () => {
    startupWork = (async () => {
      controller.signal.throwIfAborted();
      if (pool && options.blobStorageLocator) {
        try { await blobs.init(); }
        catch { app.log.error({ code: 'blob_storage_unavailable' }, 'Storage is not ready'); }
      }
      controller.signal.throwIfAborted();
    })();
    await startupWork;
  });
  app.addHook('onReady', async () => {
    startupWork = (async () => {
      controller.signal.throwIfAborted();
      if (!pool || !coreWorkspaces) return;
      const importer = new CoreFactImporter(pool, coreWorkspaces);
      try { await importer.runBatch(100); }
      catch { app.log.error({ code: 'core_fact_import_unavailable' }, 'Core facts are not current'); }
      controller.signal.throwIfAborted();
      importWork = (async () => {
        while (!controller.signal.aborted) {
          await delay(2000, undefined, { signal: controller.signal }).catch(() => undefined);
          if (controller.signal.aborted) break;
          try { await importer.runBatch(100); }
          catch { app.log.error({ code: 'core_fact_import_unavailable' }, 'Core facts are not current'); }
        }
      })();
    })();
    await startupWork;
  });
  app.addHook('onClose', async () => {
    controller.abort();
    options.signal?.removeEventListener('abort', abort);
    // A hook timeout does not cancel its Promise. Join late initialization before
    // closing the workspace pool, or its late watcher/loop could escape cleanup.
    await startupWork?.catch(() => undefined);
    await importWork;
    try { await coreWorkspaces?.close(); }
    finally {
      try { await blobProvider.close(); }
      finally {
        try { await storagePool?.end(); }
        finally { await pool?.end(); }
      }
    }
  });
  app.addHook('onRequest', async (request) => {
    const origin = request.headers.origin;
    if (origin && !browserOriginAllowed(origin, options.publicOrigin ?? 'http://127.0.0.1:4194')) {
      request.log.warn({ origin }, 'Request origin is not allowed');
      throw new DomainError('origin_forbidden', 'Request origin is not allowed', 403);
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers['sec-fetch-site'] === 'cross-site') throw new DomainError('origin_forbidden', 'Cross-site writes are not allowed', 403);
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }, requestId: request.id });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'validation_failed', details: error.flatten() }, requestId: request.id });
    const known = error as { statusCode?: number; code?: string };
    if (known.statusCode && known.statusCode >= 400 && known.statusCode < 500) return reply.code(known.statusCode).send({ error: { code: known.statusCode === 413 ? 'payload_too_large' : 'invalid_request' }, requestId: request.id });
    request.log.error({ code: known.code ?? 'internal_error' }, 'Request could not complete');
    return reply.code(503).send({ error: { code: 'temporarily_unavailable' }, requestId: request.id });
  });
  function database() {
    if (!pool) throw new DomainError('backend_not_initialized', 'Configure DATABASE_URL and migrate the database', 503);
    return pool;
  }
  function token(request: FastifyRequest) {
    if (request.headers.authorization) {
      if (!request.headers.authorization.startsWith('Bearer ')) throw new DomainError('unauthenticated', undefined, 401);
      return request.headers.authorization.slice(7);
    }
    if (!request.cookies.pm_v4_session) throw new DomainError('unauthenticated', undefined, 401);
    return request.cookies.pm_v4_session;
  }
  async function actor(request: FastifyRequest) {
    const credential = token(request);
    if (credential.startsWith('pm-automation-v1.')) {
      const identity = verifyAutomationServiceBearer(credential);
      if (!identity) throw new DomainError('unauthenticated', 'Automation service identity is invalid or expired', 401);
      return authorizeAutomationStudioService(database(), notificationCore, identity, { method: request.method, url: request.url, body: request.body });
    }
    return authenticate(database(), credential);
  }
  function params(request: FastifyRequest) { return z.object({ workspaceId: uuid, id: z.string().min(1).max(80).optional(), commandId: uuid.optional() }).parse(request.params); }
  async function validateInvitationProjects(sql: SqlExecutor, principal: Actor, workspaceId: string, projectIds: string[]): Promise<void> {
    await requireCapability(sql, principal, workspaceId, 'access.manage');
    if (!coreWorkspaces) throw new DomainError('backend_not_initialized', 'The Markdown core is unavailable', 503);
    const workspace = await coreWorkspaces.get(workspaceId);
    for (const projectId of projectIds) {
      let record;
      try { record = workspace.get(projectId); }
      catch (error) { if (error instanceof WorkspaceError) throw new DomainError('scope_mismatch', 'Project is not in this workspace', 400); throw error; }
      if (record.entity.entity !== 'project' || record.entity.archived === true) throw new DomainError('scope_mismatch', 'Project is unavailable for member authorization', 400);
    }
  }
  async function coreAccessFor(principal: Actor, workspaceId: string, sql: SqlExecutor = database(), projectMetadataWrite = false): Promise<CoreAccess> {
    if (!coreWorkspaces) throw new DomainError('backend_not_initialized', 'The Markdown core is unavailable', 503);
    const coreScope = new CoreScope(await getMembership(sql, principal, workspaceId), workspaceId);
    const requireRead = () => {
      if (!coreScope.membership.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Capability domain.read is required', 403);
    };
    const workspace = await coreWorkspaces.get(workspaceId);
    let writableInputs: Promise<void> | undefined;
    const prepareProjectWrite = () => writableInputs ??= workspace.rescan('project_metadata').then(() => {
      workspace.assertWritable();
    }).catch((error: unknown) => {
      if (error instanceof WorkspaceError) throw new DomainError(error.diagnostics[0]?.code ?? 'core_project_read_only', 'Authoritative workspace inputs are read only; repair configuration or pending recovery before editing this project', error.status);
      throw error;
    });
    return {
      handles: (id, kind) => kind ? isCoreEntityKind(kind) : /^[A-Z]/.test(id),
      async get(id, kind) {
        requireRead();
        try {
          if (projectMetadataWrite) await prepareProjectWrite();
          const entity = readCoreEntity(workspace, coreScope, id);
          if (kind && entity.kind !== kind) throw new DomainError('not_found_or_forbidden', 'Entity is not accessible', 404);
          if (projectMetadataWrite) await assertLocalProjectWritable(sql, workspaceId, entity.kind === 'project' ? entity.id : entity.projectId);
          return entity;
        } catch (error) {
          if (error instanceof WorkspaceError) throw new DomainError(error.diagnostics[0]?.code ?? 'not_found_or_forbidden', error.message, error.status, { diagnostics: error.diagnostics });
          throw error;
        }
      },
      async list(kind) {
        requireRead();
        if (!isCoreEntityKind(kind)) throw new DomainError('validation_failed', 'Expected a Markdown core entity kind');
        return (await listCoreEntities(workspace, coreScope, { kind, archived: 'include' })).items;
      },
      async records() {
        requireRead();
        if (projectMetadataWrite) await prepareProjectWrite();
        const snapshot = workspace.snapshot();
        if (snapshot.unsupportedFiles.length > 0 || snapshot.configurationErrors.some(error => error.severity === 'error') || snapshot.errors.some(error => error.severity === 'error' && (!error.entityId || !snapshot.files.some(record => record.id === error.entityId)))) {
          throw new DomainError('core_inputs_unavailable', 'Authoritative planning inputs are incomplete or invalid; repair the workspace diagnostics before trusting dashboard calculations', 409);
        }
        return snapshot.files.filter(record => coreScope.allows(record));
      },
      async sprintHistory() {
        requireRead();
        const history = workspace.sprintHistory();
        const current = new Map(workspace.snapshot().files.map(record => [record.id, record]));
        return { ...history, observations: history.observations.map(observation => ({
          ...observation,
          invalidRecordIds: observation.invalidRecordIds.filter(id => { const record = current.get(id); return !!record && coreScope.allows(record); }),
          cycles: observation.cycles.filter(cycle => {
            const record = current.get(cycle.id);
            return coreScope.allowsProject(cycle.projectId) && (!record || coreScope.allows(record));
          }).map(cycle => ({ ...cycle, tasks: cycle.tasks.filter(task => {
            const record = current.get(task.id);
            return coreScope.allowsProject(task.projectId) && (!record || coreScope.allows(record));
          }) })),
        })) };
      },
      configuration() { requireRead(); return workspace.configuration().config; },
      validateMemberProjects(projectIds) { return validateInvitationProjects(sql, principal, workspaceId, projectIds); },
      async refresh() {
        writableInputs = undefined;
        await prepareProjectWrite();
      },
    };
  }
  async function applicationRead<T>(principal: Actor, workspaceId: string, reader: (ctx: DashboardReadContext) => Promise<T>, directoryManagement: boolean | 'members' = false): Promise<T> {
    const sql = await database().connect();
    try {
      await sql.query('BEGIN');
      await lockWorkspace(sql, workspaceId);
      const membership = directoryManagement ? await getMembership(sql, principal, workspaceId) : await requireDashboardReadSelf({ sql, actor: principal, workspaceId });
      if (directoryManagement === true && !membership.capabilities.includes('domain.read') && !(membership.capabilities.includes('access.manage') && membership.projectIds === null)) throw new DomainError('permission_denied', 'Readable project scope or workspace access.manage is required', 403);
      const now = await sql.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      const core = await coreAccessFor(principal, workspaceId, sql);
      const result = await reader({ sql, actor: principal, workspaceId, membership, now: now.rows[0]!.now, core });
      await sql.query('COMMIT');
      return result;
    } catch (error) { await sql.query('ROLLBACK'); throw error; }
    finally { sql.release(); }
  }
  async function dashboardRead<T>(request: FastifyRequest, workspaceId: string, reader: (ctx: DashboardReadContext) => Promise<T>, directoryManagement: boolean | 'members' = false): Promise<T> {
    return applicationRead(await actor(request), workspaceId, reader, directoryManagement);
  }
  async function dashboard<T>(request: FastifyRequest, reader: (ctx: DashboardReadContext) => Promise<T>): Promise<T> {
    z.strictObject({}).parse(request.query);
    const { workspaceId } = z.strictObject({ workspaceId: uuid }).parse(request.params);
    return dashboardRead(request, workspaceId, reader);
  }

  app.get('/health/live', async () => ({ status: 'alive' }));
  app.get('/health/ready', async (_request, reply) => {
    if (!pool) return reply.code(503).send({ status: 'not_ready', reason: 'backend_not_initialized' });
    let databaseReady = false, storageReady = false, workerReady = false, coreReady = false, failedOutbox = 0;
    try {
      databaseReady = (await checkDatabase(pool)).ready;
      const status = await pool.query<{ live: boolean; failures: string }>("SELECT EXISTS(SELECT 1 FROM service_heartbeats WHERE role='worker' AND heartbeat_at>now()-interval '20 seconds') AS live,(SELECT count(*)::text FROM outbox WHERE published_at IS NULL AND attempts>=10) AS failures");
      workerReady = status.rows[0]?.live ?? false;
      failedOutbox = Number(status.rows[0]?.failures ?? 0);
      const authorities = await pool.query<{ workspace_id: string }>(`SELECT workspace_id FROM project_audit UNION SELECT workspace_id FROM local_project_operations UNION SELECT workspace_id FROM command_receipts WHERE command_type IN ('CreateProject','CreateWorkItem','CreateWorkItemFromIntent','CreateMilestone') AND receipt->>'status'='committed'`);
      for (const authority of authorities.rows) {
        const state = lstatSync(path.join(coreRoot, authority.workspace_id, '.pm/state/state.json'));
        if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1) throw new Error('Authoritative core state is missing or unsafe');
      }
      mkdirSync(coreRoot, { recursive: true });
      if (!lstatSync(coreRoot).isDirectory() || lstatSync(coreRoot).isSymbolicLink()) throw new Error('Unsafe core root');
      if (localProjects.enabled) for (const root of localProjects.allowedRoots) allowedDirectory(localProjects, root);
      for (const entry of readdirSync(coreRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !uuid.safeParse(entry.name).success) continue;
        enumerateProjectMounts(path.join(coreRoot, entry.name));
      }
      coreReady = true;
    } catch { /* Do not disclose a database credential or filesystem detail. */ }
    try { await blobs.check(); storageReady = true; }
    catch { /* Storage failure does not hide the other readiness checks. */ }
    const ready = databaseReady && storageReady && workerReady && coreReady && failedOutbox === 0;
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks: { database: databaseReady, storage: storageReady, worker: workerReady, core: coreReady, quarantinedEvents: failedOutbox } });
  });
  app.get('/api/v1/capabilities', async () => ({ stage: pool ? 'backend' : 'bootstrap', business: { enabled: Boolean(pool) }, database: { enabled: Boolean(pool) }, storage: { enabled: Boolean(pool && options.blobStorageLocator) }, markdownCore: { enabled: Boolean(pool) }, localProjects: { enabled: Boolean(pool && localProjects.enabled) }, worker: { enabled: Boolean(pool) }, realtime: { enabled: Boolean(pool) }, execution: { enabled: false }, accountRecovery: { request: { enabled: Boolean(pool && options.accountRecoveryMail) }, verification: { enabled: Boolean(pool && options.accountRecoveryMail) } } }));
  app.get('/openapi.json', async () => buildOpenApi(registry));
  app.post('/api/v1/auth/login', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = z.strictObject({ email: z.string().max(254), password: z.string().max(256) }).parse(request.body);
    const session = await login(database(), body, { sourceIp: request.ip });
    reply.setCookie('pm_v4_session', session.token, { ...cookieOptions, expires: new Date(session.expiresAt) });
    return { actor: session.actor, expiresAt: session.expiresAt };
  });
  app.post('/api/v1/auth/logout', async (request, reply) => { reply.header('Cache-Control', 'no-store'); await actor(request); await logout(database(), token(request)); reply.clearCookie('pm_v4_session', cookieOptions); return { loggedOut: true }; });
  app.get('/api/v1/auth/me', async (request, reply) => { reply.header('Cache-Control', 'no-store'); return { actor: await actor(request) }; });
  registerAccountSecurityRoutes(app, { database, token });
  registerAccountRecoveryRoutes(app, { database, token, ...(options.accountRecoveryMail ? { mailConfig: options.accountRecoveryMail } : {}) });
  app.get('/api/v1/workspaces', async (request) => ({ items: await listWorkspaces(database(), await actor(request)) }));
  app.get('/api/v1/workspaces/:workspaceId/members', async (request) => listMembers(database(), await actor(request), params(request).workspaceId));
  app.get('/api/v1/workspaces/:workspaceId/members/directory', async request => {
    z.strictObject({}).parse(request.query);
    return dashboardRead(request, params(request).workspaceId, readMemberDirectory, 'members');
  });
  registerInvitationRoutes(app, { database, actor, ...(options.invitationMail ? { mailConfig: options.invitationMail } : {}), validateProjects: validateInvitationProjects });
  registerWorkspaceIdentityRoutes(app, { database, actor });
  registerArtifactFilesRoutes(app, { database, actor, coreAccessFor });
  registerAutomationRoutes(app, { database, actor, core: notificationCore });
  registerAutomationStudioRoutes(app, { database, actor, core: notificationCore, runtime: automationRuntime, studio: automationStudio });
  registerAutomationGitSyncRoutes(app, { database, actor, core: notificationCore, studio: automationStudio });
  registerAutomationEventsRoutes(app, { database, actor, core: notificationCore, ...(options.publicOrigin ? { publicOrigin: options.publicOrigin } : {}) });
  const chatTools = coreWorkspaces ? createAgentChatTools({
    database, coreWorkspaces, executeCommand: executeNativeCommand, readCommandReceipt: readNativeCommandReceipt,
    readComments: (principal, workspaceId, taskId, input) => applicationRead(principal, workspaceId, ctx => readTaskComments(ctx, taskId, input)),
    localProjects: { enabled: localProjects.enabled, defaultParent: localProjects.defaultParent },
  }) : undefined;
  registerPmAutomationRoutes(app, { database, actor, core: notificationCore, ...(coreWorkspaces && chatTools ? { mutations: createPmAutomationMutationPort({ database, coreWorkspaces, tools: chatTools }) } : {}) });
  registerAgentToolRoutes(app, { database, actor, coreWorkspaces, tools: chatTools });
  registerAgentCoreFilesRoutes(app, { database, actor, coreWorkspaces });
  registerAgentReferenceRoutes(app, { database, actor, coreWorkspaces });
  registerAgentCapabilityRoutes(app, { database, actor, coreWorkspaces, tools: chatTools });
  registerAgentIssueSearchRoutes(app, { database, actor, coreWorkspaces });
  registerAgentPreviewRoutes(app, { database, actor, coreWorkspaces });
  registerNotificationRoutes(app, { database, actor, core: notificationCore });
  registerWebhookRoutes(app, { database, actor, ...(options.webhooks ? { config: options.webhooks } : {}) });
  app.get('/api/v1/workspaces/:workspaceId/dashboard/personal', async request => dashboard(request, readPersonalDashboard));
  app.get('/api/v1/workspaces/:workspaceId/dashboard/time', async request => dashboard(request, readTimeDashboard));
  app.get('/api/v1/workspaces/:workspaceId/dashboard/sprints', async request => dashboard(request, readSprintsDashboard));
  app.get('/api/v1/workspaces/:workspaceId/dashboard/portfolio', async request => dashboard(request, readPortfolioDashboard));
  app.get('/api/v1/workspaces/:workspaceId/dashboard/planning', async request => dashboard(request, readPlanningDashboard));
  app.get('/api/v1/workspaces/:workspaceId/projects/extras', async request => dashboard(request, readProjectExtras));
  app.get('/api/v1/workspaces/:workspaceId/projects/directory', async request => {
    z.strictObject({}).parse(request.query);
    const { workspaceId } = z.strictObject({ workspaceId: uuid }).parse(request.params);
    return dashboardRead(request, workspaceId, readProjectDirectory, true);
  });
  app.get('/api/v1/workspaces/:workspaceId/teams/directory', async request => {
    z.strictObject({}).parse(request.query);
    return dashboardRead(request, params(request).workspaceId, readTeamDirectory, true);
  });
  app.get('/api/v1/workspaces/:workspaceId/teams/workload', async request => {
    z.strictObject({}).parse(request.query);
    return dashboardRead(request, params(request).workspaceId, readTeamWorkload, 'members');
  });
  app.get('/api/v1/workspaces/:workspaceId/projects/:projectId/audit', async request => {
    const scope = z.strictObject({ workspaceId: uuid, projectId: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/) }).parse(request.params);
    const query = z.strictObject({ cursor: z.string().min(1).max(2048).optional(), limit: z.string().regex(/^\d{1,3}$/).transform(Number).optional() }).parse(request.query);
    const options = projectAuditOptionsSchema.parse(query);
    return dashboardRead(request, scope.workspaceId, ctx => readProjectAudit(ctx, scope.projectId, { limit: options.limit, ...(options.cursor === undefined ? {} : { cursor: options.cursor }) }));
  });
  app.get('/api/v1/workspaces/:workspaceId/tasks/:taskId/comments', async request => {
    const scope = z.strictObject({ workspaceId: uuid, taskId: taskCommentIdSchema }).parse(request.params);
    const query = taskCommentsOptionsSchema.parse(request.query);
    return dashboardRead(request, scope.workspaceId, ctx => readTaskComments(ctx, scope.taskId, { projectId: query.projectId, limit: query.limit, ...(query.after === undefined ? {} : { after: query.after }) }));
  });
  app.get('/api/v1/workspaces/:workspaceId/tasks/:taskId/comments/:commentId/history', async request => {
    const scope = z.strictObject({ workspaceId: uuid, taskId: taskCommentIdSchema, commentId: uuid }).parse(request.params);
    const query = taskCommentHistoryOptionsSchema.parse(request.query);
    return dashboardRead(request, scope.workspaceId, ctx => readTaskCommentHistory(ctx, scope.taskId, scope.commentId, { projectId: query.projectId, limit: query.limit, ...(query.after === undefined ? {} : { after: query.after }) }));
  });
  async function executeCoreRequest(principal: Actor, scope: { workspaceId: string }, parsed: Command, recoveringLocalProject = false, checkAuthorization?: (sql: SqlExecutor) => Promise<void>): Promise<CommandReceipt> {
    if (!coreWorkspaces) throw new DomainError('backend_not_initialized', 'The Markdown core is unavailable', 503);
      const coreScope = await authorizeCoreScope(database(), principal, scope.workspaceId, 'domain.read');
      const workspace = await coreWorkspaces.get(scope.workspaceId);
      const localCreation = localProjects.enabled && parsed.commandType === 'CreateProject';
      if (localCreation) {
        await requireLocalManagement(database(), principal, scope.workspaceId, true);
        await beginLocalProjectOperation(database(), principal, scope.workspaceId, parsed.commandId, 'initialize', 'command', { command: parsed });
      }
      const journal = new CoreCommandJournal(workspace.root);
      // Destructive/lifecycle commands often omit projectId; record the target's
      // authoritative project so scoped receipts remain readable by their actor.
      if (!parsed.projectId && parsed.targetId) {
        try {
          const target = workspace.get(parsed.targetId);
          const project = target.entity.entity === 'project' ? target.id : target.entity.project;
          if (typeof project === 'string') parsed.projectId = project;
        } catch { /* The adapter returns the authoritative not-found receipt. */ }
      }
      const hash = requestHash(parsed as unknown as Record<string, unknown>);
      const lockKey = parsed.commandType === 'CreateWorkItemFromIntent'
        ? `${scope.workspaceId}:intent:${String(parsed.payload.intentId).toLowerCase()}:${String(parsed.payload.acceptedRevision)}`
        : `${scope.workspaceId}:${principal.id}:${parsed.commandId}`;
      const receipt = await withCoreLock(lockKey, async () => {
        const prior = await readExternalReceipt(database(), principal, scope.workspaceId, parsed.commandId, hash);
        if (prior) return prior;
        const saved = journal.find(parsed.commandId, principal.id);
        if (saved) {
          if (saved.hash !== hash) throw new DomainError('command_id_conflict', 'Command ID already represents a different request', 409);
          if (saved.kind === 'completed') {
            for (const projectId of saved.scopeProjectIds ?? []) if (!coreScope.allowsProject(projectId)) throw new DomainError('not_found_or_forbidden', 'Command receipt is not accessible', 404);
            const result = saved.receipt.result;
            if (result && typeof result === 'object' && 'deleted' in result && result.deleted === true) {
              if (!coreScope.allowsProject(parsed.projectId)) throw new DomainError('not_found_or_forbidden', 'Entity is not accessible', 404);
            } else if (result && typeof result === 'object' && 'id' in result && typeof result.id === 'string') {
              const record = workspace.get(result.id);
              if (!coreScope.allows(record)) throw new DomainError('not_found_or_forbidden', 'Entity is not accessible', 404);
            }
            await recordExternalReceipt(database(), principal, scope.workspaceId, parsed as Command, saved.receipt, saved.scopeProjectIds, saved.audit ?? [], saved.facts ?? []);
            return saved.receipt;
          }
          if (!recoveringLocalProject || !localCreation && parsed.commandType !== 'DuplicateProject') return { commandId: parsed.commandId, status: 'rejected', httpStatus: 409, error: { code: 'command_outcome_unknown', message: 'The previous core write outcome is unknown; query the original request before explicitly recovering supported operations' } } satisfies CommandReceipt;
        }
        journal.pending(parsed as Command, hash, principal.id);
        const affectedProjects = new Set<string>();
        if (parsed.projectId && coreScope.allowsProject(parsed.projectId)) affectedProjects.add(parsed.projectId);
        const audit: ProjectAuditWrite[] = [];
        const facts: CapturedServiceFact[] = [];
        const result = await executeCoreCommand({ workspace, scope: coreScope, principal, command: parsed as Command, pool: database(), localProjects, recoveringLocalProject, bindLocalProject, ...(checkAuthorization ? { checkAuthorization } : {}), affectProject: projectId => { affectedProjects.add(projectId); }, captureAudit: entries => { audit.push(...entries); }, captureFacts: entries => { facts.push(...entries); } }, parsed.commandId);
        journal.complete(parsed.commandId, hash, result, principal.id, [...affectedProjects], audit, facts);
        await recordExternalReceipt(database(), principal, scope.workspaceId, parsed as Command, result, [...affectedProjects], audit, facts);
        return result;
      });
      if (localCreation && !(receipt.status === 'rejected' && receipt.error?.code === 'command_outcome_unknown')) {
        const projectId = receipt.result && typeof receipt.result === 'object' && 'id' in receipt.result ? receipt.result.id : null;
        await database().query("UPDATE local_project_operations SET project_id=$4,status=$5,error_code=$6,updated_at=clock_timestamp() WHERE workspace_id=$1 AND actor_id=$2 AND request_key=$3",
          [scope.workspaceId, principal.id, parsed.commandId, projectId, receipt.status === 'committed' ? 'ready' : 'rejected', receipt.error?.code ?? null]);
      }
    return receipt;
  }

  function parseNativeCommand(input: unknown): Command {
    const parsed = commandSchema.parse(input);
    if (isCoreCommand(parsed.commandType)) {
      const payload = registry[parsed.commandType]?.payload.safeParse(parsed.payload);
      if (payload?.success) parsed.payload = payload.data as Record<string, unknown>;
    }
    if (parsed.commandType === 'DuplicateProject') {
      parsed.targetId ??= parsed.projectId;
      parsed.projectId ??= parsed.targetId;
    }
    return {
      commandId: parsed.commandId, commandType: parsed.commandType, payload: parsed.payload,
      ...(parsed.targetId === undefined ? {} : { targetId: parsed.targetId }),
      ...(parsed.projectId === undefined ? {} : { projectId: parsed.projectId }),
      ...(parsed.expectedVersions === undefined ? {} : { expectedVersions: parsed.expectedVersions }),
    };
  }
  async function executeNativeCommand(principal: Actor, workspaceId: string, input: unknown, checkAuthorization?: (sql: SqlExecutor) => Promise<void>): Promise<CommandReceipt> {
    const parsed = parseNativeCommand(input);
    if (/^(CreateSession|CloseSession|CreateRun|RetryRun|StartRun|RequestApproval|GrantApproval|DenyApproval|RecordRun|ReconcileRun)/.test(parsed.commandType)) throw new DomainError('capability_not_enabled', 'Agent execution belongs to phase three', 409);
    if (coreWorkspaces && isCoreCommand(parsed.commandType)) return executeCoreRequest(principal, { workspaceId }, parsed, false, checkAuthorization);
    const coreAccess = coreWorkspaces ? await coreAccessFor(principal, workspaceId, database(), Object.hasOwn(projectMetadataWrites, parsed.commandType)) : undefined;
    return runCommand(database(), principal, workspaceId, parsed, registry, coreAccess, notificationCore, checkAuthorization);
  }
  async function readNativeCommandReceipt(principal: Actor, workspaceId: string, input: Command): Promise<CommandReceipt | null> {
    const parsed = parseNativeCommand(input), hash = requestHash(parsed as unknown as Record<string, unknown>);
    const prior = await readExternalReceipt(database(), principal, workspaceId, parsed.commandId, hash);
    if (prior || !coreWorkspaces || !isCoreCommand(parsed.commandType)) return prior;
    const scope = await authorizeCoreScope(database(), principal, workspaceId, 'domain.read');
    const workspace = await coreWorkspaces.get(workspaceId);
    const saved = new CoreCommandJournal(workspace.root).find(parsed.commandId, principal.id);
    if (!saved) return null;
    if (saved.hash !== hash) throw new DomainError('command_id_conflict', 'Command ID already represents a different request', 409);
    if (saved.kind !== 'completed') return null;
    for (const projectId of saved.scopeProjectIds ?? []) if (!scope.allowsProject(projectId)) throw new DomainError('not_found_or_forbidden', 'Command receipt is not accessible', 404);
    const result = saved.receipt.result;
    if (result && typeof result === 'object' && 'id' in result && typeof result.id === 'string' && !scope.allows(workspace.get(result.id))) throw new DomainError('not_found_or_forbidden', 'Command receipt is not accessible', 404);
    await recordExternalReceipt(database(), principal, workspaceId, parsed, saved.receipt, saved.scopeProjectIds, saved.audit ?? [], saved.facts ?? []);
    return saved.receipt;
  }
  app.post('/api/v1/workspaces/:workspaceId/commands', async (request, reply) => {
    const receipt = await executeNativeCommand(await actor(request), params(request).workspaceId, request.body);
    return reply.code(receipt.httpStatus).send(receipt);
  });
  app.get('/api/v1/workspaces/:workspaceId/commands/:commandId', async (request) => { const scope = params(request); return getCommandReceipt(database(), await actor(request), scope.workspaceId, scope.commandId!, notificationCore); });
  app.post('/api/v1/workspaces/:workspaceId/commands/:commandId/recover', async (request, reply) => {
    z.strictObject({}).parse(request.body);
    const scope = params(request);
    const principal = await actor(request);
    if (!coreWorkspaces) throw new DomainError('backend_not_initialized', 'The Markdown core is unavailable', 503);
    await authorizeCoreScope(database(), principal, scope.workspaceId, 'domain.read');
    const workspace = await coreWorkspaces.get(scope.workspaceId);
    const original = new CoreCommandJournal(workspace.root).entries().find(entry =>
      entry.kind === 'pending' && entry.commandId === scope.commandId && entry.actorId === principal.id && entry.commandType === 'DuplicateProject');
    if (!original || original.kind !== 'pending' || !original.command) throw new DomainError('command_recovery_unavailable', 'No original project duplication is available to recover', 409);
    const command = parseNativeCommand(original.command);
    if (command.commandType !== 'DuplicateProject' || command.commandId !== scope.commandId || requestHash(command as unknown as Record<string, unknown>) !== original.hash)
      throw new DomainError('command_id_conflict', 'The original project duplication does not match its durable request', 409);
    const receipt = await executeCoreRequest(principal, { workspaceId: scope.workspaceId }, command, true);
    return reply.code(receipt.httpStatus).send(receipt);
  });
  app.get('/api/v1/workspaces/:workspaceId/entities', async (request) => {
    const query = z.strictObject({ kind: z.enum(kinds), projectId: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/).optional(), limit: z.coerce.number().int().min(1).max(100).optional(), after: z.string().max(500).optional(), visibility: artifactVisibilitySchema.optional() }).parse(request.query);
    if (query.visibility && query.visibility !== 'visible' && query.kind !== 'artifact' && query.kind !== 'artifact_version') throw new DomainError('validation_failed', 'Visibility applies only to artifacts');
    const filter: { kind: EntityKind; projectId?: string; limit?: number; after?: string; visibility?: ArtifactVisibility } = { kind: query.kind };
    if (query.projectId) filter.projectId = query.projectId;
    if (query.limit) filter.limit = query.limit;
    if (query.after) filter.after = query.after;
    if (query.visibility) filter.visibility = query.visibility;
    const workspaceId = params(request).workspaceId;
    if (coreWorkspaces && isCoreEntityKind(query.kind)) {
      const principal = await actor(request);
      const coreScope = await authorizeCoreScope(database(), principal, workspaceId, 'domain.read');
      // The PM project directory includes archived projects so lifecycle recovery stays reachable.
      // Native protocol queries retain their own archive defaults; task lists are unchanged.
      return listCoreEntities(await coreWorkspaces.get(workspaceId), coreScope, { ...filter, ...(query.kind === 'project' ? { archived: 'include' as const } : {}), ...(filter.projectId ? { project: filter.projectId } : {}) });
    }
    return listEntities(database(), await actor(request), workspaceId, filter);
  });
  app.get('/api/v1/workspaces/:workspaceId/entities/:id', async (request) => {
    const scope = params(request);
    if (coreWorkspaces && /^[A-Z]/.test(scope.id!)) {
      const principal = await actor(request);
      const coreScope = await authorizeCoreScope(database(), principal, scope.workspaceId, 'domain.read');
      return readCoreEntity(await coreWorkspaces.get(scope.workspaceId), coreScope, scope.id!);
    }
    return readEntity(database(), await actor(request), scope.workspaceId, scope.id!);
  });
  app.get('/api/v1/workspaces/:workspaceId/artifact-versions/:id/content', async (request, reply) => {
    const scope = params(request), content = await downloadArtifactVersion(database(), await actor(request), scope.workspaceId, scope.id!, blobs);
    reply.header('Content-Type', 'application/octet-stream').header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(content.fileName)}`).header('X-Content-Type-Options', 'nosniff').header('ETag', `"${content.sha256}"`).header('Cache-Control', 'private, no-store');
    return reply.send(content.bytes);
  });
  app.get('/api/v1/workspaces/:workspaceId/changes', async (request) => {
    const query = z.strictObject({ after: z.string().default('0'), projectId: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/).optional() }).parse(request.query);
    return readChanges(database(), await actor(request), params(request).workspaceId, query.after, query.projectId);
  });
  registerEventStream(app, database, actor);
  registerAgentFileAreaRoutes(app, { database, actor, config: { ...localProjects, chatSpaceRoot: options.chatSpaceRoot ?? path.join(homedir(), '.pmv4') }, workspace: async workspaceId => {
    if (!coreWorkspaces) throw new DomainError('backend_not_initialized', 'Configure DATABASE_URL and migrate the database', 503);
    return coreWorkspaces.get(workspaceId);
  } });
  registerDocumentSourceRoutes(app, { database, actor, config: { ...localProjects, chatSpaceRoot: options.chatSpaceRoot ?? path.join(homedir(), '.pmv4') }, workspace: async workspaceId => {
    if (!coreWorkspaces) throw new DomainError('backend_not_initialized', 'Configure DATABASE_URL and migrate the database', 503);
    return coreWorkspaces.get(workspaceId);
  } });
  // The Markdown core is authoritative for its objects; PM-only modules keep their own storage.
  if (coreWorkspaces) registerCoreRoutes(app, { database, actor, pool: coreWorkspaces, localProjects, bindLocalProject,
    checkLocalProject: mount => checkProjectBlobStorage(storagePool ?? database(), mount),
    maintainLocalProject: async (sql, workspace, kind, workspaceId, projectId, targetRoot, operationId, writersStopped, targetMode) => {
      await maintainLocalProjectStorage({ pool: database(), coreRoot, workspaceId, projectId, targetRoot, targetMode, operationId, kind, stopped: writersStopped, legacy: legacyBlobs, workspace, sql, persistSql: storagePool ?? database() });
    },
    recoverLocalCommand: async (request, workspaceId, command) => { await executeCoreRequest(await actor(request), { workspaceId }, command, true); } });
  return app;
}
