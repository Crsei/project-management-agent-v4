import path from 'node:path';
import { accessSync, constants, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { requestHash } from '../../pm-core/state.ts';
import { DomainError, type Actor } from '../../domain/src/core.ts';
import type { Workspace, WorkspaceCreationPrepared, WorkspaceMutationGuard } from '../../pm-core/index.ts';
import { localDirectorySchema, type LocalDirectory, type LocalProjectDirectoryListing, type LocalProjectPreview, type LocalProjectSettings } from '../../contracts/src/local-projects.ts';
import type { SqlExecutor } from './ports.ts';
import { getMembership } from './access.ts';
import { ProjectLocations } from '../../pm-core/project-locations.ts';
import { workflowFor } from '../../pm-schema/index.ts';
import { assertCanonicalAbsolute, pathContains, safePathComponent, samePath, systemStoragePath } from '../../pm-core/platform.ts';
import { assertNoWindowsReparsePath } from '../../pm-core/windows-reparse.ts';

export type LocalProjectConfiguration = { enabled: boolean; dataRoot: string; defaultParent: string | null; allowedRoots: string[]; backupRoot: string; coreRoot: string };
export type LocalProjectOperation = { workspace_id: string; actor_id: string; request_key: string; operation: 'initialize' | 'migrate' | 'relocate'; transport: 'native' | 'command'; request_hash: string; request: Record<string, unknown>; project_id: string | null; status: 'pending' | 'ready' | 'rejected'; error_code: string | null };
const contains = pathContains;
function invalid(message: string): never { throw new DomainError('local_directory_forbidden', message, 403); }

export async function requireLocalManagement(sql: SqlExecutor, actor: Actor, workspaceId: string, write = false): Promise<void> {
  const member = await getMembership(sql, actor, workspaceId);
  if (member.projectIds !== null || !member.capabilities.includes('access.manage') || write && !member.capabilities.includes('planning.edit'))
    throw new DomainError('permission_denied', 'Host directory access requires unrestricted workspace management' + (write ? ' and planning.edit' : ''), 403);
}
export function requireLocalProjects(config: LocalProjectConfiguration): void {
  if (!config.enabled) throw new DomainError('local_projects_disabled', 'Local project directories are not configured on this deployment', 409);
}
/** Every component is inspected without following links. Missing trusted roots never become new empty disks. */
function inspectDirectory(candidate: string): string {
  if (!path.isAbsolute(candidate) || candidate.includes('\0')) invalid('An absolute directory is required');
  const normalized = path.resolve(candidate);
  try { assertCanonicalAbsolute(normalized); } catch { invalid('A canonical local directory is required'); }
  let current = path.parse(normalized).root;
  for (const part of ['', ...normalized.slice(current.length).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    const stat = lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory() || !samePath(realpathSync(current), current)) invalid('Symlinks, reparse aliases and non-directories are not permitted');
    assertNoWindowsReparsePath(current, stat);
  }
  return normalized;
}
export function allowedDirectory(config: LocalProjectConfiguration, candidate: string): string {
  requireLocalProjects(config);
  const normalized = path.resolve(candidate);
  if (!path.isAbsolute(candidate) || systemStoragePath(normalized)) invalid('This host path cannot be used for project storage');
  const configured = config.allowedRoots.find(root => contains(path.resolve(root), normalized));
  if (!configured) invalid('Directory is outside the trusted local roots');
  try { inspectDirectory(path.resolve(configured)); return inspectDirectory(normalized); }
  catch (error) { if (error instanceof DomainError) throw error; throw new DomainError('local_directory_unavailable', 'The trusted directory is missing or unavailable; it will not be recreated', 409); }
}
export function resolveLocalDirectory(config: LocalProjectConfiguration, directory: LocalDirectory): { root: string; mode: 'existing' | 'new' } {
  directory = localDirectorySchema.parse(directory);
  if (directory.mode === 'existing') return { root: allowedDirectory(config, directory.path), mode: 'existing' };
  const parent = allowedDirectory(config, directory.parentPath);
  const root = path.join(parent, directory.folderName);
  if (!safePathComponent(directory.folderName) || !samePath(path.dirname(root), parent)) invalid('Folder name must be a single ordinary path component');
  try { lstatSync(root); throw new DomainError('local_directory_exists', 'Choose an unused folder name or existing-directory mode', 409); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  accessSync(parent, constants.W_OK | constants.X_OK);
  return { root, mode: 'new' };
}
/** Recovery may use its already-created final directory, but only within the original trusted parent. */
export function resolveLocalRecoveryDirectory(config: LocalProjectConfiguration, directory: LocalDirectory): { root: string; mode: 'existing' | 'new' } {
  directory = localDirectorySchema.parse(directory);
  if (directory.mode === 'existing') return resolveLocalDirectory(config, directory);
  const parent = allowedDirectory(config, directory.parentPath), root = path.join(parent, directory.folderName);
  if (!safePathComponent(directory.folderName) || !samePath(path.dirname(root), parent)) invalid('Folder name must be a single ordinary path component');
  try { allowedDirectory(config, root); return { root, mode: 'new' }; }
  catch (error) { if (error instanceof DomainError && error.code !== 'local_directory_unavailable') throw error; return resolveLocalDirectory(config, directory); }
}
export function listLocalDirectories(config: LocalProjectConfiguration, candidate?: string): LocalProjectDirectoryListing {
  requireLocalProjects(config);
  if (!candidate) return { path: null, parentPath: null, roots: config.allowedRoots.map(root => allowedDirectory(config, root)), directories: [] };
  const current = allowedDirectory(config, candidate);
  const root = config.allowedRoots.find(root => contains(path.resolve(root), current))!;
  const directories = readdirSync(current, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.')).map(entry => ({ name: entry.name, path: path.join(current, entry.name) })).sort((a, b) => a.name.localeCompare(b.name));
  return { path: current, parentPath: samePath(current, root) ? null : path.dirname(current), roots: config.allowedRoots, directories };
}
export function previewLocalProject(config: LocalProjectConfiguration, directory: LocalDirectory): LocalProjectPreview {
  const { root, mode } = resolveLocalDirectory(config, directory);
  if (mode === 'existing') {
    try { lstatSync(path.join(root, '.pm')); throw new DomainError('local_directory_marked', 'This directory already contains .pm; it cannot be adopted or overwritten', 409); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    accessSync(root, constants.W_OK | constants.X_OK);
  }
  return { path: root, mode, exists: mode === 'existing', creates: ['.pm/project.json', '.pm/core/projects/PRJ-<id>.md', '.pm/core/work-items/', '.pm/core/docs/', '.pm/attachments/'], preservesExistingFiles: true };
}
export async function localProjectSettings(sql: SqlExecutor, actor: Actor, workspaceId: string, config: LocalProjectConfiguration): Promise<LocalProjectSettings> {
  const member = await getMembership(sql, actor, workspaceId);
  const canManage = member.projectIds === null && member.capabilities.includes('access.manage');
  if (!canManage && !member.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Readable workspace scope or unrestricted management is required', 403);
  const row = canManage && config.enabled ? await sql.query<{ default_parent: string | null }>('SELECT default_parent FROM local_project_settings WHERE workspace_id=$1', [workspaceId]) : undefined;
  return { enabled: config.enabled, reason: config.enabled ? null : 'not_configured', canManage,
    dataRoot: canManage && config.enabled ? config.dataRoot : null, coreRoot: canManage && config.enabled ? config.coreRoot : null,
    defaultParent: canManage && config.enabled ? row?.rows[0]?.default_parent ?? config.defaultParent : null,
    allowedRoots: canManage && config.enabled ? config.allowedRoots : [], backupRoot: canManage && config.enabled ? config.backupRoot : null,
    attachments: 'project_directory', databaseRequired: true };
}
export async function saveLocalProjectSettings(sql: SqlExecutor, actor: Actor, workspaceId: string, config: LocalProjectConfiguration, parent: string): Promise<LocalProjectSettings> {
  await requireLocalManagement(sql, actor, workspaceId, true);
  const selected = allowedDirectory(config, parent);
  await sql.query('INSERT INTO local_project_settings(workspace_id,default_parent,updated_by) VALUES($1,$2,$3) ON CONFLICT(workspace_id) DO UPDATE SET default_parent=excluded.default_parent,updated_by=excluded.updated_by,updated_at=clock_timestamp()', [workspaceId, selected, actor.id]);
  return localProjectSettings(sql, actor, workspaceId, config);
}
export async function beginLocalProjectOperation(sql: SqlExecutor, actor: Actor, workspaceId: string, key: string, operation: LocalProjectOperation['operation'], transport: LocalProjectOperation['transport'], request: Record<string, unknown>, projectId?: string): Promise<LocalProjectOperation> {
  const hash = requestHash({ operation, transport, request, projectId: projectId ?? null });
  await sql.query(`INSERT INTO local_project_operations(workspace_id,actor_id,request_key,operation,transport,request_hash,request,project_id) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT(workspace_id,actor_id,request_key) DO NOTHING`, [workspaceId, actor.id, key, operation, transport, hash, JSON.stringify(request), projectId ?? null]);
  const row = await readLocalProjectOperation(sql, actor, workspaceId, key);
  if (!row || row.request_hash !== hash) throw new DomainError('command_id_conflict', 'The original local request key has different parameters', 409);
  return row;
}
export async function readLocalProjectOperation(sql: SqlExecutor, actor: Actor, workspaceId: string, key: string): Promise<LocalProjectOperation | undefined> {
  return (await sql.query<LocalProjectOperation>('SELECT * FROM local_project_operations WHERE workspace_id=$1 AND actor_id=$2 AND request_key=$3', [workspaceId, actor.id, key])).rows[0];
}
export async function initializeLocalProject(workspace: Workspace, config: LocalProjectConfiguration, workspaceId: string, input: Record<string, unknown>, key: string, directory: LocalDirectory, guard?: WorkspaceMutationGuard, prepared?: WorkspaceCreationPrepared, recovering = false) {
  if (!recovering && input.status !== undefined && input.status !== workflowFor('project', workspace.configuration().config)?.initial)
    throw new DomainError('local_project_initial_status_required', 'New local projects use the configured initial workflow state', 409);
  const selected = recovering ? resolveLocalRecoveryDirectory(config, directory) : resolveLocalDirectory(config, directory);
  return workspace.initializeProject(input, key, { workspaceId, ...selected }, guard, prepared);
}

export async function assertLocalProjectWritable(sql: SqlExecutor, workspaceId: string, projectId: string | null | undefined): Promise<void> {
  if (!projectId) return;
  const pending = await sql.query("SELECT 1 FROM local_project_storage_operations WHERE workspace_id=$1 AND project_id=$2 AND phase<>'completed' LIMIT 1", [workspaceId, projectId]);
  if (pending.rows.length) throw new DomainError('local_project_maintenance_pending', 'Project storage maintenance requires recovery before further writes', 409);
}

/** Serializes cross-workspace directory claims without duplicating the core-owned mount registry. */
export async function assertLocalProjectTargetAvailable(sql: SqlExecutor, workspaceRoot: string, targetRoot: string, key: string, projectId?: string): Promise<void> {
  await sql.query("SELECT pg_advisory_xact_lock(hashtextextended('local-project-directories',724631))");
  const transfers = await sql.query<{ workspace_id: string; project_id: string; target_root: string }>("SELECT workspace_id,project_id,target_root FROM local_project_storage_operations WHERE phase<>'completed'");
  for (const transfer of transfers.rows) {
    if (path.basename(workspaceRoot) === transfer.workspace_id && transfer.project_id === projectId) continue;
    if (contains(transfer.target_root, targetRoot) || contains(targetRoot, transfer.target_root)) throw new DomainError('local_directory_registered', 'The selected directory overlaps pending project storage maintenance', 409);
  }
  const coreRoot = path.dirname(workspaceRoot);
  if (contains(coreRoot, targetRoot) || contains(targetRoot, coreRoot)) throw new DomainError('local_directory_registered', 'Project storage cannot overlap application workspace state', 409);
  for (const entry of readdirSync(coreRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
    const root = path.join(coreRoot, entry.name);
    for (const location of new ProjectLocations(root).list()) {
      if (samePath(root, workspaceRoot) && (location.initialization.key === key || location.projectId === projectId)) continue;
      if (contains(location.root, targetRoot) || contains(targetRoot, location.root)) throw new DomainError('local_directory_registered', 'The selected directory overlaps registered project storage', 409);
    }
  }
}
