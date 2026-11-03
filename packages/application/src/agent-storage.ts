import { accessSync, constants, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentScope, AgentStorageSettings, AgentStorageSettingsUpdate } from '../../contracts/src/agent-file-areas.ts';
import { agentStorageSettingsUpdateSchema } from '../../contracts/src/agent-file-areas.ts';
import type { LocalDirectory } from '../../contracts/src/local-projects.ts';
import { DomainError, type Actor } from '../../domain/src/core.ts';
import { getMembership } from './access.ts';
import { allowedDirectory, requireLocalManagement, resolveLocalDirectory, type LocalProjectConfiguration } from './local-projects.ts';
import type { SqlExecutor } from './ports.ts';
import { assertCanonicalAbsolute, pathContains, safePathComponent, samePath, systemStoragePath } from '../../pm-core/platform.ts';
import { assertNoWindowsReparsePath } from '../../pm-core/windows-reparse.ts';

export type AgentDirectoryConfiguration = LocalProjectConfiguration & { chatSpaceRoot: string };
const contains = pathContains;
const forbidden = (message: string): never => { throw new DomainError('local_directory_forbidden', message, 403); };
function inspect(candidate: string): void {
  try { assertCanonicalAbsolute(candidate); } catch { forbidden('A canonical local directory is required'); }
  let current = path.parse(candidate).root;
  for (const component of ['', ...candidate.slice(current.length).split(path.sep).filter(Boolean)]) {
    if (component) current = path.join(current, component);
    const stat = lstatSync(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync(current), current)) forbidden('Symlinks, reparse aliases and non-directories are not permitted');
    assertNoWindowsReparsePath(current, stat);
  }
}
function deploymentRoot(config: AgentDirectoryConfiguration): string {
  const root = config.chatSpaceRoot;
  try { assertCanonicalAbsolute(root); } catch { forbidden('An absolute Chat Space root is required'); }
  if (samePath(root, path.parse(root).root)) forbidden('An absolute Chat Space root is required');
  const homeDefault = path.join(homedir(), '.pmv4');
  if (systemStoragePath(root) && !samePath(root, homeDefault)) forbidden('System directories cannot be Chat Space roots');
  // Only the configured leaf may be absent. Never manufacture a missing home or mount.
  inspect(path.dirname(root));
  return root;
}
export function agentAllowedDirectory(config: AgentDirectoryConfiguration, candidate: string): string {
  if (!path.isAbsolute(candidate) || candidate.includes('\0')) forbidden('An absolute directory is required');
  const normalized = path.resolve(candidate);
  if (!contains(config.chatSpaceRoot, normalized)) return allowedDirectory(config, candidate);
  deploymentRoot(config);
  inspect(normalized);
  return normalized;
}
/** Read-only preflight, or creation of only the configured leaf and its contained descendants. */
export function defaultAgentDirectory(config: AgentDirectoryConfiguration, effectiveRoot: string, scope: AgentScope, create = false): string {
  const root = samePath(effectiveRoot, config.chatSpaceRoot) ? deploymentRoot(config) : agentAllowedDirectory(config, effectiveRoot);
  const candidate = path.join(root, 'workspaces', scope.workspaceId, ...(scope.projectId ? ['projects', scope.projectId] : ['workspace']));
  if (!contains(root, candidate) || !/^[0-9a-f-]{36}$/.test(scope.workspaceId) || scope.projectId !== null && !/^PRJ-\d+$/.test(scope.projectId)) forbidden('Invalid Agent scope path');
  let current = root, missing = false;
  const components = [root, ...path.relative(root, candidate).split(path.sep)];
  for (let index = 0; index < components.length; index++) {
    if (index) current = path.join(current, components[index]!);
    if (!missing) {
      try { inspect(current); accessSync(current, constants.R_OK | constants.X_OK); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        accessSync(path.dirname(current), constants.W_OK | constants.X_OK);
        missing = true;
      }
    }
    if (missing && create) {
      // Recheck the complete parent chain immediately before every single-level mkdir.
      inspect(path.dirname(current));
      try { mkdirSync(current, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      inspect(current);
    }
  }
  return candidate;
}
export function resolveAgentDirectory(config: AgentDirectoryConfiguration, directory: LocalDirectory): { root: string; mode: 'existing' | 'new' } {
  const candidate = directory.mode === 'existing' ? directory.path : directory.parentPath;
  if (!contains(config.chatSpaceRoot, path.resolve(candidate))) return resolveLocalDirectory(config, directory);
  const parent = agentAllowedDirectory(config, candidate);
  if (directory.mode === 'existing') return { root: parent, mode: 'existing' };
  const root = path.join(parent, directory.folderName);
  if (!safePathComponent(directory.folderName) || !samePath(path.dirname(root), parent)) forbidden('Folder name must be a single ordinary path component');
  try { lstatSync(root); throw new DomainError('local_directory_exists', 'Choose an unused folder name or existing-directory mode', 409); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  accessSync(parent, constants.W_OK | constants.X_OK);
  return { root, mode: 'new' };
}
export async function readAgentStorageRoot(sql: SqlExecutor, workspaceId: string, config: AgentDirectoryConfiguration): Promise<{ root: string; revision: number }> {
  const row = (await sql.query<{ default_root: string; revision: number }>('SELECT default_root,revision FROM agent_storage_settings WHERE workspace_id=$1', [workspaceId])).rows[0];
  return { root: row?.default_root ?? config.chatSpaceRoot, revision: row?.revision ?? 0 };
}
export async function agentStorageSettings(sql: SqlExecutor, actor: Actor, workspaceId: string, config: AgentDirectoryConfiguration): Promise<AgentStorageSettings> {
  const member = await getMembership(sql, actor, workspaceId);
  const visible = member.projectIds === null && member.capabilities.includes('access.manage');
  if (!visible && !member.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Readable workspace scope or unrestricted management is required', 403);
  const saved = visible ? await readAgentStorageRoot(sql, workspaceId, config) : undefined;
  return { defaultRoot: visible ? config.chatSpaceRoot : null, effectiveRoot: saved?.root ?? null, revision: saved?.revision ?? 0, canManage: visible && member.capabilities.includes('planning.edit') };
}
export async function saveAgentStorageSettings(sql: SqlExecutor, actor: Actor, workspaceId: string, config: AgentDirectoryConfiguration, input: AgentStorageSettingsUpdate): Promise<AgentStorageSettings> {
  input = agentStorageSettingsUpdateSchema.parse(input);
  await requireLocalManagement(sql, actor, workspaceId, true);
  const previous = await readAgentStorageRoot(sql, workspaceId, config);
  if (previous.revision !== input.expectedRevision) throw new DomainError('agent_storage_settings_revision_conflict', 'The default save location changed; reload before saving', 409, { currentRevision: previous.revision });
  const selected = resolveAgentDirectory(config, input.directory);
  if (selected.mode === 'new') mkdirSync(selected.root, { mode: 0o700 });
  agentAllowedDirectory(config, selected.root);
  const result = await sql.query(`INSERT INTO agent_storage_settings(workspace_id,default_root,revision,updated_by) VALUES($1,$2,1,$3)
    ON CONFLICT(workspace_id) DO UPDATE SET default_root=excluded.default_root,revision=agent_storage_settings.revision+1,updated_by=excluded.updated_by,updated_at=clock_timestamp()
    WHERE agent_storage_settings.revision=$4 RETURNING revision`, [workspaceId, selected.root, actor.id, input.expectedRevision]);
  if (!result.rows[0]) throw new DomainError('agent_storage_settings_revision_conflict', 'The default save location changed; reload before saving', 409);
  return agentStorageSettings(sql, actor, workspaceId, config);
}
