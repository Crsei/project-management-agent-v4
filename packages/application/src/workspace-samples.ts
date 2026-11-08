import { lstatSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Pool } from 'pg';
import { DomainError, type Actor } from '../../domain/src/core.ts';
import { Workspace } from '../../pm-core/index.ts';
import { createMarkdown } from '../../pm-markdown/index.ts';
import { entityKinds, fieldRegistry, workflowFor, type EntityKind, type FileRecord } from '../../pm-schema/index.ts';
import { relationFields } from '../../pm-schema/relations.ts';
import { lockWorkspace } from '../../infrastructure/src/database.ts';
import { initializeProjectBlobStorage } from '../../infrastructure/src/project-blobs.ts';
import type { SqlExecutor } from './ports.ts';
import { getMembership } from './access.ts';
import { allowedDirectory, assertLocalProjectTargetAvailable, resolveLocalDirectory, resolveLocalRecoveryDirectory, type LocalProjectConfiguration } from './local-projects.ts';
import { localDirectorySchema, type LocalDirectory } from '../../contracts/src/local-projects.ts';
import type { WorkspaceCreationResult } from '../../contracts/src/workspace-creation.ts';
import { novaSampleTemplate } from './nova-sample-template.ts';

const sampleObject = z.strictObject({ title: z.string().trim().min(1).max(500), body: z.string().max(1_000_000), fields: z.record(z.string(), z.unknown()).optional() });
const sampleSchema = z.strictObject({ version: z.literal(1), key: z.string().regex(/^[a-z][a-z0-9-]{0,80}$/), project: sampleObject, items: z.array(sampleObject.extend({ key: z.string().regex(/^[a-z][a-z0-9-]{0,80}$/), entity: z.enum(entityKinds).refine(kind => kind !== 'project') })).max(100) });
export type NovaSampleTemplate = z.infer<typeof sampleSchema>;
export type WorkspaceSampleOptions = { coreRoot: string; localProjects: LocalProjectConfiguration };
type SampleRow = { workspace_id: string; actor_id: string; workspace_name: string; request_key: string | null; template: unknown; directory: unknown; status: 'pending' | 'ready'; project_id: string | null; sample_skipped: boolean; core_root_identity: unknown; core_initialization_phase: 'unclaimed' | 'prestate' | 'established' };
const storageIdentitySchema = z.strictObject({ device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/) });
const pendingError = () => new DomainError('workspace_initialization_pending', 'Workspace creation is recorded, but its Nova sample initialization is incomplete. Resume the original workspace creation; do not create a replacement.', 503);

export function parseNovaSampleTemplate(input: unknown): NovaSampleTemplate {
  const template = sampleSchema.parse(input);
  const keys = new Set(['nova']);
  for (const item of template.items) {
    if (keys.has(item.key)) throw new Error('Duplicate Nova template key');
    keys.add(item.key);
  }
  for (const item of [{ ...template.project, entity: 'project' as const }, ...template.items]) {
    const allowed = new Set(fieldRegistry.filter(field => field.editable && field.entities.includes(item.entity) && !['title', 'owner', 'assignee', 'archived'].includes(field.name)).map(field => field.name));
    for (const name of Object.keys(item.fields ?? {})) if (!allowed.has(name)) throw new Error(`Unsupported Nova sample field: ${name}`);
    for (const relation of relationFields().filter(field => field.entities.includes(item.entity))) {
      const value = item.fields?.[relation.name];
      if (value === undefined) continue;
      const targets = relation.multiple ? value : [value];
      if (!Array.isArray(targets) || targets.some(target => typeof target !== 'string' || !keys.has(target))) throw new Error(`Unknown Nova sample relation: ${relation.name}`);
    }
  }
  return template;
}

/** Only the transaction creating a new workspace may opt it into built-in content. */
export async function queueNovaWorkspaceSample(sql: SqlExecutor, workspaceId: string, actorId: string, name: string, options: WorkspaceSampleOptions, requestKey: string | null = null): Promise<void> {
  const template = parseNovaSampleTemplate(novaSampleTemplate);
  const directory: LocalDirectory | null = options.localProjects.enabled ? { mode: 'new', parentPath: options.localProjects.defaultParent ?? '', folderName: `nova-${workspaceId}` } : null;
  if (directory) localDirectorySchema.parse(directory);
  await sql.query('INSERT INTO workspace_sample_initializations(workspace_id,actor_id,request_key,workspace_name,template,directory) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)', [workspaceId, actorId, requestKey, name, JSON.stringify(template), directory ? JSON.stringify(directory) : null]);
}

/** An opted-out creation is complete in the same transaction that creates the
 * workspace, so it has no pending phase or filesystem side effects to resume. */
export async function queueWorkspaceWithoutSample(sql: SqlExecutor, workspaceId: string, actorId: string, name: string, requestKey: string | null = null): Promise<void> {
  await sql.query("INSERT INTO workspace_sample_initializations(workspace_id,actor_id,request_key,workspace_name,template,sample_skipped,status,completed_at) VALUES($1,$2,$3,$4,NULL,true,'ready',clock_timestamp())", [workspaceId, actorId, requestKey, name]);
}

export async function assertWorkspaceSampleReady(sql: SqlExecutor, workspaceId: string): Promise<void> {
  const pending = await sql.query("SELECT 1 FROM workspace_sample_initializations WHERE workspace_id=$1 AND status='pending'", [workspaceId]);
  if (pending.rows.length) throw pendingError();
}

function remapValue(value: unknown, ids: Readonly<Record<string, string>>): unknown {
  if (typeof value === 'string') return ids[value] ?? value;
  if (Array.isArray(value)) return value.map(item => remapValue(item, ids));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remapValue(item, ids)]));
  return value;
}

export function remapNovaBody(body: string, ids: Readonly<Record<string, string>>): string {
  const linked = body.replace(/\[\[([^|\]#]+)([^\]]*)\]\]/g, (_match, key: string, suffix: string) => {
    if (!ids[key]) throw new Error('Nova sample contains an unknown document link');
    return `[[${ids[key]}${suffix}]]`;
  });
  // Preserve sample prose and formatting; remap explicit IDs in embedded view and API examples only.
  return linked.replace(/(["']?(?:project|parent|cycle|milestone|module|requirement|release|id|targetId)["']?\s*:\s*["']?)([a-z][a-z0-9-]*)(?=["'\s,}\]])/g, (match, prefix: string, key: string) => ids[key] ? `${prefix}${ids[key]}` : match);
}

/** Recheck authority after every durable phase boundary, under the same workspace lock as normal writes. */
async function lockedSample(sql: SqlExecutor, workspaceId: string): Promise<SampleRow | undefined> {
  await sql.query('BEGIN');
  await lockWorkspace(sql, workspaceId);
  const row = (await sql.query<SampleRow>('SELECT * FROM workspace_sample_initializations WHERE workspace_id=$1 FOR UPDATE', [workspaceId])).rows[0];
  if (!row || row.status === 'ready') return row;
  const actor = (await sql.query<Actor>('SELECT id,email,name FROM users WHERE id=$1 AND disabled_at IS NULL', [row.actor_id])).rows[0];
  if (!actor) throw pendingError();
  const member = await getMembership(sql, actor, workspaceId);
  if (member.projectIds !== null || !member.capabilities.includes('planning.edit') || !member.capabilities.includes('domain.read') || row.directory && !member.capabilities.includes('access.manage')) throw new DomainError('permission_denied', 'Current workspace creation authority is required to initialize its sample', 403);
  return row;
}

/** Frozen native creation keys reconcile interrupted initialization without copying live data. */
export async function initializeNovaWorkspaceSample(pool: Pool, workspaceId: string, options: WorkspaceSampleOptions): Promise<string | null> {
  const sql = await pool.connect();
  let workspace: Workspace | undefined;
  try {
    let row = await lockedSample(sql, workspaceId);
    if (!row || row.status === 'ready') { await sql.query('COMMIT'); return row?.project_id ?? null; }
    const root = path.join(path.resolve(options.coreRoot), workspaceId);
    if (row.core_initialization_phase === 'unclaimed') {
      let phase: 'prestate' | 'established' = 'established';
      let identity;
      try {
        const state = lstatSync(path.join(root, '.pm/state/state.json'));
        if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1) throw pendingError();
        identity = Workspace.storageIdentity(root);
        Workspace.initializeStorage(root, identity, false);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // A root without durable ownership proof is never adopted, even if empty.
        // A crash between this exclusive mkdir and the SQL commit stays fail-closed.
        identity = Workspace.claimStorage(root);
        phase = 'prestate';
      }
      await sql.query('UPDATE workspace_sample_initializations SET core_root_identity=$2::jsonb,core_initialization_phase=$3 WHERE workspace_id=$1', [workspaceId, JSON.stringify(identity), phase]);
      await sql.query('COMMIT');
      row = await lockedSample(sql, workspaceId);
      if (!row || row.status === 'ready') { await sql.query('COMMIT'); return row?.project_id ?? null; }
    }
    const identity = storageIdentitySchema.parse(row.core_root_identity);
    Workspace.initializeStorage(root, identity, row.core_initialization_phase === 'prestate');
    if (row.core_initialization_phase === 'prestate') {
      // State is durable before this commit; no sample content is written until
      // the established phase is durable, so a lost state can never be reseeded.
      await sql.query("UPDATE workspace_sample_initializations SET core_initialization_phase='established' WHERE workspace_id=$1", [workspaceId]);
      await sql.query('COMMIT');
      row = await lockedSample(sql, workspaceId);
      if (!row || row.status === 'ready') { await sql.query('COMMIT'); return row?.project_id ?? null; }
      Workspace.initializeStorage(root, storageIdentitySchema.parse(row.core_root_identity), false);
    }
    const template = parseNovaSampleTemplate(row.template);
    const directory = row.directory === null ? null : localDirectorySchema.parse(row.directory);
    workspace = new Workspace(root);
    await workspace.init();
    const configuration = workspace.configuration().config;
    const relationNames = new Set(relationFields(configuration).map(field => field.name));
    const objects = [{ ...template.project, entity: 'project' as EntityKind, key: 'nova' }, ...template.items];
    const records: Record<string, FileRecord> = {};
    const ids: Record<string, string> = {};
    for (const item of objects) {
      const fields = Object.fromEntries(Object.entries(item.fields ?? {}).filter(([name]) => !relationNames.has(name)));
      const input: Record<string, unknown> = { ...fields, entity: item.entity, title: item.title, body: '', ...(item.entity === 'project' ? {} : { project: ids.nova }) };
      if (item.entity === 'project' && directory) input.status = workflowFor('project', configuration)?.initial;
      const key = `workspace-sample:${workspaceId}:${template.key}:${item.key}`;
      if (item.entity === 'project' && directory) {
        if (!options.localProjects.enabled) throw pendingError();
        const reserved = workspace.projectLocations().some(location => location.initialization.key === key);
        const selected = reserved ? resolveLocalRecoveryDirectory(options.localProjects, directory) : resolveLocalDirectory(options.localProjects, directory);
        allowedDirectory(options.localProjects, directory.mode === 'new' ? directory.parentPath : directory.path);
        await assertLocalProjectTargetAvailable(sql, workspace.root, selected.root, key);
        records[item.key] = await workspace.initializeProject(input, key, { workspaceId, ...selected });
      } else records[item.key] = await workspace.createEntity(input, key);
      ids[item.key] = records[item.key]!.id;
    }
    for (const item of objects) {
      const current = records[item.key]!;
      const fields = Object.fromEntries(Object.entries(item.fields ?? {}).map(([name, value]) => [name, relationNames.has(name) || name === 'views' ? remapValue(value, ids) : value]));
      const desired = createMarkdown({ ...fields, entity: item.entity, id: current.id, title: item.title, body: remapNovaBody(item.body, ids), ...(item.entity === 'project' ? {} : { project: ids.nova }) }, configuration);
      if (current.raw === desired) continue;
      const key = `workspace-sample:${workspaceId}:${template.key}:${item.key}`;
      const originalRevision = workspace.originalCreationRevision(key);
      if (!originalRevision || current.revision !== originalRevision) throw new DomainError('workspace_sample_conflict', 'An unfinished Nova sample object changed outside its original initialization; nothing was overwritten', 409);
      await workspace.save(current.id, desired, current.revision);
    }
    const projectId = ids.nova!;
    if (directory) {
      const mount = workspace.projectLocation(projectId);
      if (!mount) throw pendingError();
      await initializeProjectBlobStorage(sql, mount);
    }
    const snapshot = workspace.snapshot();
    if (snapshot.errors.some(issue => issue.severity === 'error') || snapshot.configurationErrors.some(issue => issue.severity === 'error')) throw pendingError();
    await sql.query("UPDATE workspace_sample_initializations SET status='ready',project_id=$2,completed_at=clock_timestamp() WHERE workspace_id=$1", [workspaceId, projectId]);
    await sql.query('COMMIT');
    return projectId;
  } catch (error) {
    await sql.query('ROLLBACK').catch(() => undefined);
    if (error instanceof DomainError) throw error;
    throw pendingError();
  } finally {
    try { await workspace?.close(); }
    finally { sql.release(); }
  }
}

export async function readWorkspaceCreation(sql: SqlExecutor, actor: Actor, key: string): Promise<WorkspaceCreationResult> {
  const row = (await sql.query<SampleRow>('SELECT * FROM workspace_sample_initializations WHERE actor_id=$1 AND request_key=$2', [actor.id, key])).rows[0];
  if (!row) return { status: 'not_found' };
  await getMembership(sql, actor, row.workspace_id);
  return row.status === 'ready' ? { status: 'ready', key, workspaceId: row.workspace_id, sampleProjectId: row.project_id } : { status: 'pending', key, workspaceId: row.workspace_id };
}

export async function resumeActorWorkspaceSamples(pool: Pool, actor: Actor, options: WorkspaceSampleOptions): Promise<void> {
  const pending = await pool.query<{ workspace_id: string }>("SELECT s.workspace_id FROM workspace_sample_initializations s JOIN memberships m ON m.workspace_id=s.workspace_id AND m.user_id=$1 AND m.revoked_at IS NULL WHERE s.actor_id=$1 AND s.status='pending' ORDER BY s.created_at LIMIT 5", [actor.id]);
  for (let index = 0; index < Math.min(pending.rows.length, 4); index++) {
    try { await initializeNovaWorkspaceSample(pool, pending.rows[index]!.workspace_id, options); }
    catch (error) {
      // This pending workspace remains explicit in the list response. Its
      // unavailable storage must not hide unrelated usable workspaces.
      if (!(error instanceof DomainError) || ![403, 409, 503].includes(error.status)) throw error;
    }
  }
}
