import path from 'node:path';
import { accessSync, constants, closeSync, fstatSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { requestHash } from '../../pm-core/state.ts';
import { DomainError, type Actor } from '../../domain/src/core.ts';
import type { Workspace, WorkspaceCreationPrepared, WorkspaceMutationGuard } from '../../pm-core/index.ts';
import { localDirectorySchema, localProjectMarkerSchema, type LocalDirectory, type LocalProjectDirectoryListing, type LocalProjectMarker, type LocalProjectPreview, type LocalProjectProbe, type LocalProjectSettings } from '../../contracts/src/local-projects.ts';
import type { SqlExecutor } from './ports.ts';
import { getMembership } from './access.ts';
import { ProjectLocations } from '../../pm-core/project-locations.ts';
import { workflowFor } from '../../pm-schema/index.ts';
import { assertCanonicalAbsolute, checkedFileOpen, pathContains, safePathComponent, samePath, systemStoragePath } from '../../pm-core/platform.ts';
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
/** Project storage is no longer constrained to configured roots. Canonical, link-free,
 * non-system paths remain mandatory; container mounts still define what the service can see. */
export function allowedDirectory(config: LocalProjectConfiguration, candidate: string): string {
  requireLocalProjects(config);
  if (!path.isAbsolute(candidate) || candidate.includes('\0')) invalid('This host path cannot be used for project storage');
  const normalized = path.resolve(candidate);
  if (systemStoragePath(normalized)) invalid('This host path cannot be used for project storage');
  try { return inspectDirectory(normalized); }
  catch (error) { if (error instanceof DomainError) throw error; throw new DomainError('local_directory_unavailable', 'The selected directory is missing or unavailable; it will not be recreated', 409); }
}
/** Agent file areas and document sources keep their configured roots; project storage does not. */
export function allowedRootDirectory(config: LocalProjectConfiguration, candidate: string): string {
  if (!path.isAbsolute(candidate) || candidate.includes('\0')) invalid('An absolute directory is required');
  const normalized = path.resolve(candidate);
  const configured = config.allowedRoots.find(root => contains(path.resolve(root), normalized));
  if (!configured) invalid('Directory is outside the trusted local roots');
  inspectDirectory(path.resolve(configured));
  return allowedDirectory(config, normalized);
}
function newProjectRoot(parent: string, folderName: string): { root: string; mode: 'new'; layout: 'dovspace-v1' } {
  if (!safePathComponent(folderName)) invalid('Folder name must be a single ordinary path component');
  const root = path.join(parent, folderName);
  if (!samePath(path.dirname(root), parent)) invalid('Folder name must be a single ordinary path component');
  try { lstatSync(root); throw new DomainError('local_directory_exists', 'Choose an unused folder name or existing-directory mode', 409); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  accessSync(parent, constants.W_OK | constants.X_OK);
  return { root, mode: 'new', layout: 'dovspace-v1' };
}
/** Convert a resolved root back into the durable request shape. Never persist `{root, layout}`. */
export function toLocalDirectory(selection: { root: string; mode: 'existing' | 'new' }): LocalDirectory {
  return selection.mode === 'existing' ? { mode: 'existing', path: selection.root } : { mode: 'new', parentPath: path.dirname(selection.root), folderName: path.basename(selection.root) };
}
export function resolveLocalDirectory(config: LocalProjectConfiguration, directory: LocalDirectory): { root: string; mode: 'existing' | 'new'; layout: 'dovspace-v1' } {
  directory = localDirectorySchema.parse(directory);
  if (directory.mode === 'existing') return { root: allowedDirectory(config, directory.path), mode: 'existing', layout: 'dovspace-v1' };
  if (directory.mode === 'auto') {
    if (!path.isAbsolute(directory.path) || directory.path.includes('\0')) invalid('An absolute directory is required');
    const requested = path.resolve(directory.path);
    let exists = false;
    try {
      const stat = lstatSync(requested);
      if (stat.isSymbolicLink() || !stat.isDirectory()) invalid('The selected path is not an ordinary directory');
      exists = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (exists) return { root: allowedDirectory(config, requested), mode: 'existing', layout: 'dovspace-v1' };
    return newProjectRoot(allowedDirectory(config, path.dirname(requested)), path.basename(requested));
  }
  return newProjectRoot(allowedDirectory(config, directory.parentPath), directory.folderName);
}
/** Recovery may use its already-created final directory. */
export function resolveLocalRecoveryDirectory(config: LocalProjectConfiguration, directory: LocalDirectory): { root: string; mode: 'existing' | 'new'; layout: 'dovspace-v1' } {
  directory = localDirectorySchema.parse(directory);
  if (directory.mode === 'existing') return resolveLocalDirectory(config, directory);
  if (directory.mode === 'auto') {
    const requested = path.resolve(directory.path);
    try {
      const stat = lstatSync(requested);
      if (!stat.isSymbolicLink() && stat.isDirectory()) return { root: allowedDirectory(config, requested), mode: 'new', layout: 'dovspace-v1' };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return resolveLocalDirectory(config, directory);
  }
  const parent = allowedDirectory(config, directory.parentPath), root = path.join(parent, directory.folderName);
  if (!safePathComponent(directory.folderName) || !samePath(path.dirname(root), parent)) invalid('Folder name must be a single ordinary path component');
  try { allowedDirectory(config, root); return { root, mode: 'new', layout: 'dovspace-v1' }; }
  catch (error) { if (error instanceof DomainError && error.code !== 'local_directory_unavailable') throw error; return resolveLocalDirectory(config, directory); }
}
/** Replays retain the original selection mode even after an auto-selected new path exists. */
export function resolveLocalInitializationDirectory(config: LocalProjectConfiguration, directory: LocalDirectory, previous?: LocalProjectOperation): { root: string; mode: 'existing' | 'new'; layout: 'dovspace-v1' } {
  if (!previous || previous.operation !== 'initialize' || previous.transport !== 'native') return resolveLocalDirectory(config, directory);
  const original = previous.request.directory;
  if (directory.mode === 'auto') {
    if (!path.isAbsolute(directory.path) || directory.path.includes('\0')) invalid('An absolute directory is required');
    const mode = original && typeof original === 'object' && 'mode' in original && original.mode === 'existing' ? 'existing' : 'new';
    directory = toLocalDirectory({ root: path.resolve(directory.path), mode });
  }
  return resolveLocalRecoveryDirectory(config, directory);
}
/** Browsing starts at the service filesystem root. Selecting a system path is still refused by
 * allowedDirectory; listing one does not grant storage rights. */
export function listLocalDirectories(config: LocalProjectConfiguration, candidate?: string): LocalProjectDirectoryListing {
  requireLocalProjects(config);
  const root = path.parse(config.dataRoot).root;
  if (!candidate) return { path: null, parentPath: null, roots: [root], directories: [] };
  let current: string;
  try { current = inspectDirectory(candidate); }
  catch (error) { if (error instanceof DomainError) throw error; throw new DomainError('local_directory_unavailable', 'The selected directory is missing or unavailable', 409); }
  const directories = readdirSync(current, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.')).map(entry => ({ name: entry.name, path: path.join(current, entry.name) })).sort((a, b) => a.name.localeCompare(b.name));
  return { path: current, parentPath: samePath(current, path.parse(current).root) ? null : path.dirname(current), roots: [root], directories };
}
function readProjectMarker(root: string): { marker: LocalProjectMarker | null; problem: 'missing_marker' | 'invalid_marker' | null } {
  for (const layout of ['dovspace-v1', 'legacy'] as const) {
    const container = layout === 'dovspace-v1' ? path.join(root, '.dovspace') : path.join(root, '.pm');
    let containerStat;
    try { containerStat = lstatSync(container); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (containerStat.isSymbolicLink() || !containerStat.isDirectory()) return { marker: null, problem: 'invalid_marker' };
    const file = layout === 'dovspace-v1' ? path.join(container, '.pm/project.json') : path.join(container, 'project.json');
    try {
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) return { marker: null, problem: 'invalid_marker' };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { marker: null, problem: 'missing_marker' }; throw error; }
    let raw: unknown;
    try {
      const descriptor = checkedFileOpen(file, constants.O_RDONLY);
      try {
        const stat = fstatSync(descriptor);
        if (stat.size > 4096) return { marker: null, problem: 'invalid_marker' };
        raw = JSON.parse(readFileSync(descriptor, 'utf8'));
      } finally { closeSync(descriptor); }
    } catch { return { marker: null, problem: 'invalid_marker' }; }
    const parsed = localProjectMarkerSchema.safeParse(raw);
    if (!parsed.success) return { marker: null, problem: 'invalid_marker' };
    return { marker: { version: 1, layout, workspaceId: parsed.data.workspaceId, projectId: parsed.data.projectId, storageId: parsed.data.storageId }, problem: null };
  }
  return { marker: null, problem: null };
}
export function probeLocalProject(config: LocalProjectConfiguration, candidate: string): LocalProjectProbe {
  requireLocalProjects(config);
  if (!path.isAbsolute(candidate) || candidate.includes('\0')) invalid('An absolute directory is required');
  const normalized = path.resolve(candidate);
  let exists = false;
  try {
    const stat = lstatSync(normalized);
    if (stat.isSymbolicLink() || !stat.isDirectory()) invalid('The selected path is not an ordinary directory');
    exists = true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!exists) {
    const parent = allowedDirectory(config, path.dirname(normalized)), folderName = path.basename(normalized);
    newProjectRoot(parent, folderName);
    return { path: normalized, exists: false, directory: { mode: 'new', parentPath: parent, folderName }, marker: null, markerProblem: null, project: null, problem: null };
  }
  const root = allowedDirectory(config, normalized), found = readProjectMarker(root);
  return { path: root, exists: true, directory: { mode: 'existing', path: root }, marker: found.marker, markerProblem: found.problem, project: null, problem: null };
}
export function previewLocalProject(config: LocalProjectConfiguration, directory: LocalDirectory): LocalProjectPreview {
  const { root, mode } = resolveLocalDirectory(config, directory);
  if (mode === 'existing') {
    for (const name of ['.pm', '.dovspace']) {
      try { lstatSync(path.join(root, name)); throw new DomainError('local_directory_marked', `This directory already contains ${name}; it cannot be adopted or overwritten`, 409); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    accessSync(root, constants.W_OK | constants.X_OK);
  }
  return { path: root, mode, directory: mode === 'existing' ? { mode: 'existing', path: root } : { mode: 'new', parentPath: path.dirname(root), folderName: path.basename(root) }, exists: mode === 'existing', creates: ['.dovspace/.pm/project.json', '.dovspace/.pm/core/projects/PRJ-<id>.md', '.dovspace/.pm/core/work-items/', '.dovspace/.pm/core/docs/', '.dovspace/.pm/attachments/'], preservesExistingFiles: true };
}
export async function localProjectSettings(sql: SqlExecutor, actor: Actor, workspaceId: string, config: LocalProjectConfiguration): Promise<LocalProjectSettings> {
  const member = await getMembership(sql, actor, workspaceId);
  const canManage = member.projectIds === null && member.capabilities.includes('access.manage');
  if (!canManage && !member.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Readable workspace scope or unrestricted management is required', 403);
  const row = canManage && config.enabled ? await sql.query<{ default_parent: string | null }>('SELECT default_parent FROM local_project_settings WHERE workspace_id=$1', [workspaceId]) : undefined;
  return { enabled: config.enabled, reason: config.enabled ? null : 'not_configured', canManage,
    dataRoot: canManage && config.enabled ? config.dataRoot : null, coreRoot: canManage && config.enabled ? config.coreRoot : null,
    defaultParent: canManage && config.enabled ? row?.rows[0]?.default_parent ?? config.defaultParent : null,
    allowedRoots: [], unrestricted: config.enabled, backupRoot: canManage && config.enabled ? config.backupRoot : null,
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
