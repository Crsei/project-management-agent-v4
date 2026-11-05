import { accessSync, constants, lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { AgentCatalog, AgentFileArea, AgentFileAreaUpdate, AgentScope, ResolvedAgentContext } from '../../contracts/src/agent-file-areas.ts';
import { agentFileAreaUpdateSchema, agentScopeSchema } from '../../contracts/src/agent-file-areas.ts';
import { DomainError, type Actor } from '../../domain/src/core.ts';
import { agentFileAreaConflict, readAgentFileArea, readAgentFileAreas, writeAgentFileArea, type AgentFileAreaRow } from '../../infrastructure/src/agent-file-areas.ts';
import type { Workspace } from '../../pm-core/index.ts';
import type { FileRecord } from '../../pm-schema/index.ts';
import { assertProjectScope, getMembership, type Membership } from './access.ts';
import { requireLocalManagement } from './local-projects.ts';
import { agentAllowedDirectory, defaultAgentDirectory, readAgentStorageRoot, resolveAgentDirectory, type AgentDirectoryConfiguration } from './agent-storage.ts';
import type { SqlExecutor } from './ports.ts';
import { syncDirectory } from '../../pm-core/platform.ts';

export type AgentFileAreaContext = { sql: SqlExecutor; actor: Actor; config: AgentDirectoryConfiguration; workspace: (workspaceId: string) => Promise<Workspace> };
function canReadPath(member: Membership): boolean { return member.projectIds === null && member.capabilities.includes('access.manage'); }
function requireRead(member: Membership, projectId: string | null): void {
  assertProjectScope(member, projectId);
  if (!member.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Capability domain.read is required', 403);
}
function projectFor(workspace: Workspace, projectId: string): FileRecord {
  const project = workspace.items({ entity: 'project', archived: 'include' }).find(file => file.id === projectId);
  if (!project) throw new DomainError('not_found_or_forbidden', 'Project is unavailable in this workspace', 404);
  return project;
}
function directoryIdentity(config: AgentDirectoryConfiguration, candidate: string): { root: string; device: string; inode: string } {
  const root = agentAllowedDirectory(config, candidate);
  accessSync(root, constants.R_OK | constants.X_OK);
  const stat = lstatSync(root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DomainError('local_directory_forbidden', 'The selected directory changed or is unsafe', 403);
  return { root, device: String(stat.dev), inode: String(stat.ino) };
}
function fileArea(config: AgentDirectoryConfiguration, member: Membership, workspace: Workspace, project: FileRecord | undefined, saved: AgentFileAreaRow | undefined, scope: AgentScope, effectiveRoot: string): AgentFileArea {
  const registered = !saved && project ? workspace.projectLocations().find(location => location.projectId === project.id) : undefined;
  const area: AgentFileArea = { path: saved?.path ?? registered?.root ?? null, revision: saved?.revision ?? 0,
    source: saved?.source ?? (registered ? 'project_location' : 'default'), status: 'unavailable',
    canManage: canReadPath(member) && member.capabilities.includes('planning.edit') };
  if (!canReadPath(member)) return { ...area, path: null, reason: 'path_not_visible' };
  if (project?.stale) return { ...area, reason: 'core_project_unavailable' };
  try {
    if (!saved && !registered) {
      if (!area.canManage) return { ...area, reason: 'permission_denied' };
      return { ...area, path: defaultAgentDirectory(config, effectiveRoot, scope), status: 'available', reason: 'initializes_on_first_use' };
    }
    // A native project fallback must retain its original marker and disk identity.
    if (registered && !workspace.projectLocation(project!.id)) throw new Error('Project location is unavailable');
    const identity = directoryIdentity(config, area.path!);
    if (saved && (saved.directory_device !== identity.device || saved.directory_inode !== identity.inode))
      return { ...area, status: 'unavailable', reason: 'directory_identity_changed' };
    return { ...area, path: identity.root, status: 'available' };
  } catch (error) {
    const reason = error instanceof DomainError ? error.code : 'directory_unavailable';
    return { ...area, status: 'unavailable', reason };
  }
}

/** Catalog names and projects come from authorized PM facts, never from directory preferences. */
export async function listAgentContexts(context: AgentFileAreaContext): Promise<AgentCatalog> {
  const { sql, actor, config } = context;
  const visible = await sql.query<{ id: string; name: string }>(`SELECT w.id,w.name FROM workspaces w
    JOIN memberships m ON m.workspace_id=w.id JOIN users u ON u.id=m.user_id
    WHERE m.user_id=$1 AND m.revoked_at IS NULL AND u.disabled_at IS NULL AND 'domain.read'=ANY(m.capabilities)
    ORDER BY w.created_at,w.id`, [actor.id]);
  const workspaces: AgentCatalog['workspaces'] = [];
  for (const row of visible.rows) {
    const workspace = await context.workspace(row.id), member = await getMembership(sql, actor, row.id);
    if (!member.capabilities.includes('domain.read')) continue;
    const saved = await readAgentFileAreas(sql, row.id);
    const settings = await readAgentStorageRoot(sql, row.id, config);
    workspaces.push({ id: row.id, name: row.name, fileArea: fileArea(config, member, workspace, undefined, saved.get(''), { workspaceId: row.id, projectId: null }, settings.root),
      projects: workspace.items({ entity: 'project', archived: 'include' }).filter(project => member.projectIds === null || member.projectIds.includes(project.id))
        .map(project => ({ id: project.id, name: project.entity.title, fileArea: fileArea(config, member, workspace, project, saved.get(project.id), { workspaceId: row.id, projectId: project.id }, settings.root) })) });
  }
  return { workspaces };
}

/** Caller uses the existing workspace transaction lock, including authorization and revision checks. */
export async function saveAgentFileArea(context: AgentFileAreaContext, scope: AgentScope, input: AgentFileAreaUpdate): Promise<{ fileArea: AgentFileArea }> {
  scope = agentScopeSchema.parse(scope); input = agentFileAreaUpdateSchema.parse(input);
  const { sql, actor, config } = context;
  await requireLocalManagement(sql, actor, scope.workspaceId, true);
  const member = await getMembership(sql, actor, scope.workspaceId); requireRead(member, scope.projectId);
  const workspace = await context.workspace(scope.workspaceId), project = scope.projectId ? projectFor(workspace, scope.projectId) : undefined;
  if (project?.stale) throw new DomainError('agent_file_area_unavailable', 'The authoritative core project is unavailable', 409);
  const previous = await readAgentFileArea(sql, scope);
  if ((previous?.revision ?? 0) !== input.expectedRevision) agentFileAreaConflict(previous?.revision ?? 0);
  // Resolve only after CAS preflight: stale saves must not even create a directory.
  const selected = resolveAgentDirectory(config, input.directory);
  if (selected.mode === 'new') {
    mkdirSync(selected.root, { mode: 0o700 });
    syncDirectory(path.dirname(selected.root));
  }
  const identity = directoryIdentity(config, selected.root);
  const saved = await writeAgentFileArea(sql, scope, { path: identity.root, device: identity.device, inode: identity.inode, expectedRevision: input.expectedRevision, actorId: actor.id, source: 'explicit' });
  const area = fileArea(config, member, workspace, project, saved, scope, (await readAgentStorageRoot(sql, scope.workspaceId, config)).root);
  if (area.status !== 'available') throw new DomainError('agent_file_area_unavailable', 'The selected Agent directory changed before configuration could complete', 409, { reason: area.reason });
  return { fileArea: area };
}

/** Only an unassigned scope may initialize its default; saved and native paths never fall back. */
export async function resolveAgentContext(context: AgentFileAreaContext, scope: AgentScope): Promise<ResolvedAgentContext> {
  scope = agentScopeSchema.parse(scope);
  const member = await getMembership(context.sql, context.actor, scope.workspaceId); requireRead(member, scope.projectId);
  // Preserve the existing local-project path disclosure restriction, including for Agent callers.
  await requireLocalManagement(context.sql, context.actor, scope.workspaceId).catch(error => {
    if (error instanceof DomainError && error.code === 'permission_denied')
      throw new DomainError('agent_file_area_path_not_visible', 'This caller cannot read the actual host directory', 403);
    throw error;
  });
  const workspace = await context.workspace(scope.workspaceId), project = scope.projectId ? projectFor(workspace, scope.projectId) : undefined;
  let saved = await readAgentFileArea(context.sql, scope);
  const settings = await readAgentStorageRoot(context.sql, scope.workspaceId, context.config);
  let area = fileArea(context.config, member, workspace, project, saved, scope, settings.root);
  if (area.status !== 'available' || !area.path) throw new DomainError('agent_file_area_unavailable', 'The Agent file area is unavailable; no fallback directory will be used', 409, { reason: area.reason });
  if (!saved && area.source === 'default') {
    await requireLocalManagement(context.sql, context.actor, scope.workspaceId, true);
    const root = defaultAgentDirectory(context.config, settings.root, scope, true);
    const identity = directoryIdentity(context.config, root);
    saved = await writeAgentFileArea(context.sql, scope, { path: identity.root, device: identity.device, inode: identity.inode, expectedRevision: 0, actorId: context.actor.id, source: 'default' });
    area = fileArea(context.config, member, workspace, project, saved, scope, settings.root);
    if (area.status !== 'available' || !area.path) throw new DomainError('agent_file_area_unavailable', 'The default directory changed during initialization', 409);
  }
  const row = await context.sql.query<{ name: string }>('SELECT name FROM workspaces WHERE id=$1', [scope.workspaceId]);
  if (!row.rows[0]) throw new DomainError('not_found_or_forbidden', 'Workspace is unavailable', 404);
  return { scope, actorId: context.actor.id, workspaceName: row.rows[0].name, projectName: project?.entity.title ?? null, path: area.path! };
}
