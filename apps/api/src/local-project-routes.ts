import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError, type Actor, type Command } from '../../../packages/domain/src/core.ts';
import type { FileRecord } from '../../../packages/pm-schema/index.ts';
import type { Workspace } from '../../../packages/pm-core/index.ts';
import { localDirectorySchema, localProjectInitializationSchema, localProjectMoveSchema, localProjectRelocationSchema, localProjectPreviewSchema, localProjectSettingsUpdateSchema, type LocalDirectory, type LocalProjectAttempt, type LocalProjectLocation } from '../../../packages/contracts/src/local-projects.ts';
import { assertLocalProjectTargetAvailable, beginLocalProjectOperation, listLocalDirectories, localProjectSettings, previewLocalProject, readLocalProjectOperation, requireLocalManagement, requireLocalProjects, resolveLocalDirectory, resolveLocalRecoveryDirectory, saveLocalProjectSettings, type LocalProjectConfiguration, type LocalProjectOperation } from '../../../packages/application/src/local-projects.ts';
import { getMembership } from '../../../packages/application/src/access.ts';
import { lockWorkspace } from '../../../packages/infrastructure/src/database.ts';
import type { SqlExecutor } from '../../../packages/application/src/ports.ts';
import type { CoreCreationAttempt } from '../../../packages/contracts/src/core-creation.ts';
import { previewProjectDirectory } from '../../../packages/pm-core/project-locations.ts';
import type { ProjectMount } from '../../../packages/pm-core/project-locations.ts';

type RouteContext = { database: () => Pool; actor: (request: FastifyRequest) => Promise<Actor>; config: LocalProjectConfiguration;
  workspace: (workspaceId: string) => Promise<Workspace>;
  create: (request: FastifyRequest, workspaceId: string, input: Record<string, unknown>, directory: LocalDirectory, key: string, recovering: boolean) => Promise<FileRecord>;
  nativeAttempt: (request: FastifyRequest, workspaceId: string, key: string, recovering: boolean) => Promise<CoreCreationAttempt>;
  maintain: (sql: SqlExecutor, workspace: Workspace, operation: 'migrate' | 'relocate' | 'rebind', workspaceId: string, projectId: string, targetRoot: string, operationId: string, writersStopped: boolean, targetMode: 'existing' | 'new') => Promise<void>;
  recoverCommand: (request: FastifyRequest, workspaceId: string, command: Command) => Promise<void>;
  checkMount: (mount: ProjectMount) => Promise<void>;
};
const parameters = z.object({ workspaceId: z.uuid().toLowerCase(), projectId: z.string().regex(/^PRJ-\d+$/).optional(), key: z.string().min(1).max(512).optional() });
const prefix = '/api/v1/workspaces/:workspaceId/local-projects';
const keyFor = (request: FastifyRequest) => z.string().min(1).max(512).refine(key => !!key.trim()).parse(request.headers['idempotency-key']);

export function registerLocalProjectRoutes(app: FastifyInstance, options: RouteContext): void {
  async function management(request: FastifyRequest, write = false) {
    const { workspaceId } = parameters.parse(request.params), actor = await options.actor(request);
    await requireLocalManagement(options.database(), actor, workspaceId, write);
    requireLocalProjects(options.config);
    return { workspaceId, actor };
  }
  async function location(workspace: Workspace, projectId: string): Promise<LocalProjectLocation> {
    const registered = workspace.projectLocations().find(location => location.projectId === projectId);
    if (!registered) {
      const record = workspace.get(projectId);
      if (record.entity.entity !== 'project') throw new DomainError('not_found_or_forbidden', 'Project is unavailable', 404);
    }
    try {
      const mount = workspace.projectLocation(projectId);
      if (mount) await options.checkMount(mount);
      return mount ? { projectId, storageId: mount.storageId, kind: 'local', path: mount.root, status: 'available' } : { projectId, storageId: null, kind: 'legacy', path: null, status: 'available' };
    } catch { return { projectId, storageId: registered?.storageId ?? null, kind: 'local', path: registered?.root ?? null, status: 'unavailable', reason: 'Registered project storage is missing or its identity cannot be confirmed' }; }
  }
  async function attempt(request: FastifyRequest, workspaceId: string, actor: Actor, key: string): Promise<LocalProjectAttempt> {
    const saved = await readLocalProjectOperation(options.database(), actor, workspaceId, key);
    if (!saved) return { status: 'not_found' };
    if (saved.status === 'rejected') return { status: 'rejected', key, operation: saved.operation, code: saved.error_code ?? 'local_project_rejected' };
    const workspace = await options.workspace(workspaceId);
    if (saved.operation === 'initialize' && saved.transport === 'native') {
      const native = await options.nativeAttempt(request, workspaceId, key, false);
      if (native.status === 'rejected') return { status: 'rejected', key, operation: saved.operation, code: 'core_creation_rejected' };
      if (native.status !== 'committed') return { status: 'pending', key, operation: saved.operation, reason: native.status === 'pending' ? native.reason : 'write_unconfirmed', ...(saved.project_id ? { projectId: saved.project_id } : {}) };
      if (native.current.status !== 'present') return { status: 'pending', key, operation: saved.operation, reason: 'storage_pending', projectId: native.entityId };
      const current = await location(workspace, native.entityId);
      if (saved.status !== 'ready' || current.status !== 'available') return { status: 'pending', key, operation: saved.operation, reason: 'storage_pending', projectId: native.entityId };
      return { status: 'ready', key, operation: saved.operation, record: native.current.record, location: current };
    }
    if (!saved.project_id || saved.status !== 'ready') return { status: 'pending', key, operation: saved.operation, reason: 'write_unconfirmed', ...(saved.project_id ? { projectId: saved.project_id } : {}) };
    const current = await location(workspace, saved.project_id);
    if (current.status !== 'available') return { status: 'pending', key, operation: saved.operation, reason: 'storage_pending', projectId: saved.project_id };
    return { status: 'ready', key, operation: saved.operation, record: workspace.get(saved.project_id), location: current };
  }
  async function move(saved: LocalProjectOperation, actor: Actor, recovering: boolean): Promise<void> {
    const directory = localDirectorySchema.parse(saved.request.directory);
    const selected = recovering ? resolveLocalRecoveryDirectory(options.config, directory) : resolveLocalDirectory(options.config, directory);
    const workspace = await options.workspace(saved.workspace_id), sql = await options.database().connect();
    try {
      await sql.query('BEGIN'); await lockWorkspace(sql, saved.workspace_id);
      await requireLocalManagement(sql, actor, saved.workspace_id, true);
      const digest = createHash('sha256').update(JSON.stringify([saved.workspace_id, actor.id, saved.request_key])).digest('hex');
      const operationId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
      if (saved.operation === 'initialize') throw new DomainError('local_project_operation_mismatch', 'A storage move operation is required', 409);
      if (saved.request.mode === 'rebind' && directory.mode !== 'existing') throw new DomainError('local_directory_invalid', 'Rebinding requires an existing moved directory', 400);
      await assertLocalProjectTargetAvailable(sql, workspace.root, selected.root, operationId, saved.project_id!);
      await options.maintain(sql, workspace, saved.request.mode === 'rebind' ? 'rebind' : saved.operation, saved.workspace_id, saved.project_id!, selected.root, operationId, saved.request.writersStopped === true, selected.mode);
      workspace.get(saved.project_id!);
      await sql.query("UPDATE local_project_operations SET status='ready',error_code=NULL,updated_at=clock_timestamp() WHERE workspace_id=$1 AND actor_id=$2 AND request_key=$3", [saved.workspace_id, actor.id, saved.request_key]);
      await sql.query('COMMIT');
    } catch (error) { await sql.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { sql.release(); }
  }
  async function execute(request: FastifyRequest, saved: LocalProjectOperation, actor: Actor, recovering: boolean): Promise<void> {
    if (saved.status === 'ready' || saved.status === 'rejected') return;
    if (saved.operation !== 'initialize') return move(saved, actor, recovering);
    if (saved.transport === 'command') return options.recoverCommand(request, saved.workspace_id, saved.request.command as Command);
    if (recovering && (await options.nativeAttempt(request, saved.workspace_id, saved.request_key, false)).status === 'rejected') {
      await options.database().query("UPDATE local_project_operations SET status='rejected',error_code='core_creation_rejected',updated_at=clock_timestamp() WHERE workspace_id=$1 AND actor_id=$2 AND request_key=$3", [saved.workspace_id, actor.id, saved.request_key]);
      return;
    }
    const input = saved.request.input as Record<string, unknown>, directory = localDirectorySchema.parse(saved.request.directory);
    const record = await options.create(request, saved.workspace_id, input, directory, saved.request_key, recovering);
    await options.database().query("UPDATE local_project_operations SET project_id=$4,status='ready',error_code=NULL,updated_at=clock_timestamp() WHERE workspace_id=$1 AND actor_id=$2 AND request_key=$3", [saved.workspace_id, actor.id, saved.request_key, record.id]);
  }
  app.addHook('onSend', async (request, reply) => { if (request.routeOptions.url?.includes('/local-projects/')) reply.header('Cache-Control', 'private, no-store'); });
  app.get(prefix + '/settings', async request => {
    z.strictObject({}).parse(request.query);
    const { workspaceId } = parameters.parse(request.params);
    return localProjectSettings(options.database(), await options.actor(request), workspaceId, options.config);
  });
  app.put(prefix + '/settings', async request => {
    const { workspaceId, actor } = await management(request, true);
    const body = localProjectSettingsUpdateSchema.parse(request.body), sql = await options.database().connect();
    try {
      await sql.query('BEGIN'); await lockWorkspace(sql, workspaceId);
      const result = await saveLocalProjectSettings(sql, actor, workspaceId, options.config, body.defaultParent);
      await sql.query('COMMIT');
      return result;
    } catch (error) { await sql.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { sql.release(); }
  });
  app.get(prefix + '/directories', async request => {
    await management(request);
    const { path } = z.strictObject({ path: z.string().min(1).max(4096).optional() }).parse(request.query);
    return listLocalDirectories(options.config, path);
  });
  app.post(prefix + '/preview', async request => {
    const { workspaceId } = await management(request);
    const result = previewLocalProject(options.config, localProjectPreviewSchema.parse(request.body).directory);
    const workspace = await options.workspace(workspaceId);
    try { previewProjectDirectory(workspace.root, { workspaceId, root: result.path, mode: result.mode }); }
    catch { throw new DomainError('local_directory_conflict', 'The selected directory overlaps registered storage or already contains application metadata', 409); }
    return result;
  });
  app.post(prefix + '/initializations', async request => {
    const { workspaceId, actor } = await management(request, true), key = keyFor(request);
    const body = localProjectInitializationSchema.parse(request.body);
    await options.workspace(workspaceId);
    const saved = await beginLocalProjectOperation(options.database(), actor, workspaceId, key, 'initialize', 'native', body);
    await execute(request, saved, actor, false);
    return attempt(request, workspaceId, actor, key);
  });
  app.get(prefix + '/initializations/:key', async request => {
    const { workspaceId, actor } = await management(request), { key } = parameters.parse(request.params);
    return attempt(request, workspaceId, actor, key!);
  });
  app.post(prefix + '/initializations/:key/recover', async request => {
    z.strictObject({}).parse(request.body);
    const { workspaceId, actor } = await management(request, true), { key } = parameters.parse(request.params);
    const saved = await readLocalProjectOperation(options.database(), actor, workspaceId, key!);
    if (!saved) return { status: 'not_found' };
    await execute(request, saved, actor, true);
    return attempt(request, workspaceId, actor, key!);
  });
  app.get(prefix + '/projects/:projectId/location', async request => {
    const { workspaceId } = parameters.parse(request.params), { projectId } = parameters.parse(request.params), actor = await options.actor(request);
    const member = await getMembership(options.database(), actor, workspaceId);
    if (!member.capabilities.includes('domain.read') || member.projectIds !== null && !member.projectIds.includes(projectId!)) throw new DomainError('not_found_or_forbidden', 'Project is unavailable', 404);
    const result = await location(await options.workspace(workspaceId), projectId!);
    if (member.projectIds !== null || !member.capabilities.includes('access.manage')) { result.path = null; delete result.reason; }
    return result;
  });
  for (const operation of ['migrate', 'relocate'] as const) app.post(prefix + '/projects/:projectId/' + operation, async request => {
    const { workspaceId, actor } = await management(request, true), { projectId } = parameters.parse(request.params), key = keyFor(request);
    const body = operation === 'relocate' ? localProjectRelocationSchema.parse(request.body) : localProjectMoveSchema.parse(request.body);
    const saved = await beginLocalProjectOperation(options.database(), actor, workspaceId, key, operation, 'native', body, projectId);
    await execute(request, saved, actor, false);
    return attempt(request, workspaceId, actor, key);
  });
}
