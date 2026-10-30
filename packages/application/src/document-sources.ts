import path from 'node:path';
import type { DocumentSource, DocumentSourceContent, DocumentSourceFiles, DocumentSourceFilesQuery, DocumentSourcePreviewInput, DocumentSourceScope, DocumentSourceUpdate } from '../../contracts/src/document-sources.ts';
import { documentSourceFilesQuerySchema, documentSourcePreviewInputSchema, documentSourceScopeSchema, documentSourceUpdateSchema } from '../../contracts/src/document-sources.ts';
import { DomainError, type Actor } from '../../domain/src/core.ts';
import { assertDocumentRelativePath, DocumentSourceDirectory, documentPrivateComponent, documentSourceFileError, type DocumentDirectoryIdentity } from '../../infrastructure/src/document-source-files.ts';
import { documentSourceConflict, readDocumentSource, readDocumentSources, writeDocumentSource, type DocumentSourceRow } from '../../infrastructure/src/document-sources.ts';
import type { Workspace } from '../../pm-core/index.ts';
import { ProjectLocations } from '../../pm-core/project-locations.ts';
import { assertProjectScope, getMembership, type Membership } from './access.ts';
import { agentAllowedDirectory, type AgentDirectoryConfiguration } from './agent-storage.ts';
import { requireLocalManagement } from './local-projects.ts';
import type { SqlExecutor } from './ports.ts';

export type DocumentSourceContext = { sql: SqlExecutor; actor: Actor; config: AgentDirectoryConfiguration; workspace: (workspaceId: string) => Promise<Workspace> };
const contains = (root: string, candidate: string): boolean => root === candidate || candidate.startsWith(root + path.sep);
const overlaps = (a: string, b: string): boolean => contains(a, b) || contains(b, a);
function pathVisible(member: Membership): boolean { return member.projectIds === null && member.capabilities.includes('access.manage'); }
function requireRead(member: Membership, projectId: string | null): void {
  assertProjectScope(member, projectId);
  if (!member.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Capability domain.read is required', 403);
}
async function authorized(context: DocumentSourceContext, scope: DocumentSourceScope): Promise<{ member: Membership; name: string }> {
  const member = await getMembership(context.sql, context.actor, scope.workspaceId); requireRead(member, scope.projectId);
  const workspace = await context.workspace(scope.workspaceId);
  if (scope.projectId) {
    const project = workspace.items({ entity: 'project', archived: 'include' }).find(item => item.id === scope.projectId);
    if (!project) throw new DomainError('not_found_or_forbidden', 'The project is unavailable in this workspace', 404);
    if (project.stale) throw new DomainError('document_source_unavailable', 'The authoritative project is unavailable', 409, { reason: 'core_project_unavailable' });
    return { member, name: project.entity.title };
  }
  const row = (await context.sql.query<{ name: string }>('SELECT name FROM workspaces WHERE id=$1', [scope.workspaceId])).rows[0];
  if (!row) throw new DomainError('not_found_or_forbidden', 'The workspace is unavailable', 404);
  return { member, name: row.name };
}
function allowedRoot(context: DocumentSourceContext, candidate: string): string {
  const root = agentAllowedDirectory(context.config, candidate);
  const config = context.config;
  // Do not let broad allowedRoots authorize the application's private persistence.
  const privateRoots = [config.coreRoot, config.backupRoot, ...['agent-data', 'blobs', 'logs'].map(name => path.join(config.dataRoot, name))];
  if (process.env.AGENT_WORKSPACE_DATA_DIR?.trim()) privateRoots.push(path.resolve(process.env.AGENT_WORKSPACE_DATA_DIR.trim()));
  if (root.split(path.sep).some(documentPrivateComponent) || privateRoots.some(privateRoot => overlaps(path.resolve(privateRoot), root)))
    throw new DomainError('document_source_path_forbidden', 'Application-private storage cannot be a document source', 403);
  return root;
}
/** Only configured document sources reserve roots for deduplication. Agent cwd and
 * native project mounts are not competing document sources. */
async function assertClaims(context: DocumentSourceContext, scope: DocumentSourceScope, root: string): Promise<void> {
  const rows = await context.sql.query<{ workspace_id: string; project_key: string; path: string }>(
    'SELECT workspace_id,project_key,path FROM document_sources WHERE path IS NOT NULL');
  for (const claim of rows.rows) {
    if (claim.workspace_id === scope.workspaceId && claim.project_key === (scope.projectId ?? '')) continue;
    if (overlaps(path.resolve(claim.path), root))
      throw new DomainError('document_source_overlap', 'Document source directories must be distinct and cannot contain one another', 409);
  }
}

/** Accept a parent source without promoting files from an unauthorized project.
 * Omit denied paths entirely, including their names in scan issues. */
async function readablePaths(context: DocumentSourceContext, scope: DocumentSourceScope, member: Membership, root: string): Promise<(relative: string) => boolean> {
  const blocked: string[] = [];
  const workspaces = await context.sql.query<{ id: string }>('SELECT id FROM workspaces ORDER BY id');
  const foreignAreas = await context.sql.query<{ path: string }>('SELECT path FROM agent_file_areas WHERE workspace_id <> $1', [scope.workspaceId]);
  for (const area of foreignAreas.rows) {
    if (overlaps(area.path, root)) blocked.push(area.path);
  }
  try {
    for (const workspace of workspaces.rows) {
      for (const location of new ProjectLocations(path.join(context.config.coreRoot, workspace.id)).list()) {
        if (workspace.id === scope.workspaceId && (member.projectIds === null || member.projectIds.includes(location.projectId))) continue;
        if (overlaps(location.root, root)) blocked.push(location.root);
      }
    }
  } catch {
    throw new DomainError('document_source_unavailable', 'Registered directory boundaries cannot currently be verified', 409, { reason: 'scope_boundaries_unavailable' });
  }
  return relative => !blocked.some(boundary => contains(boundary, path.join(root, relative)));
}
function openRoot(context: DocumentSourceContext, candidate: string, expected?: DocumentDirectoryIdentity): DocumentSourceDirectory {
  try { return new DocumentSourceDirectory(allowedRoot(context, candidate), expected); }
  catch (error) {
    if (error instanceof DomainError && error.code.startsWith('local_directory_')) {
      if (!expected && error.status === 403) throw new DomainError('document_source_path_forbidden', 'The directory is outside trusted roots or contains an unsafe component', 403);
      throw new DomainError('document_source_unavailable', 'The source directory is missing, replaced or unreadable', 409, { reason: 'directory_unavailable' });
    }
    if (expected && !(error instanceof DomainError && error.code === 'document_source_unavailable'))
      throw new DomainError('document_source_unavailable', 'The source directory is missing, replaced or unreadable', 409, { reason: 'directory_unavailable' });
    return documentSourceFileError(error);
  }
}
function sourceDto(scope: DocumentSourceScope, name: string, member: Membership, saved: DocumentSourceRow | undefined, status: DocumentSource['status'], reason?: string): DocumentSource {
  return { projectId: scope.projectId, name, path: pathVisible(member) ? saved?.path ?? null : null, revision: saved?.revision ?? 0,
    status, canManage: pathVisible(member) && member.capabilities.includes('planning.edit') && member.capabilities.includes('domain.read'), ...(reason ? { reason } : {}) };
}
async function describe(context: DocumentSourceContext, scope: DocumentSourceScope, member: Membership, name: string, saved?: DocumentSourceRow): Promise<DocumentSource> {
  if (!saved?.path) return sourceDto(scope, name, member, saved, 'unconfigured');
  let directory: DocumentSourceDirectory | undefined;
  try {
    await assertClaims(context, scope, saved.path);
    directory = openRoot(context, saved.path, { device: saved.directory_device!, inode: saved.directory_inode! });
    directory.assertCurrent();
    return sourceDto(scope, name, member, saved, 'available');
  } catch (error) {
    return sourceDto(scope, name, member, saved, 'unavailable', error instanceof DomainError ? error.code === 'document_source_unavailable' ? String((error.details as { reason?: string } | undefined)?.reason ?? error.code) : error.code : 'directory_unavailable');
  } finally { directory?.close(); }
}

export async function listDocumentSources(context: DocumentSourceContext, workspaceId: string): Promise<{ sources: DocumentSource[] }> {
  const member = await getMembership(context.sql, context.actor, workspaceId);
  if (!member.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Capability domain.read is required', 403);
  const workspace = await context.workspace(workspaceId), saved = await readDocumentSources(context.sql, workspaceId), sources: DocumentSource[] = [];
  if (member.projectIds === null) {
    const scope = { workspaceId, projectId: null }, current = await authorized(context, scope);
    sources.push(await describe(context, scope, member, current.name, saved.get('')));
  }
  for (const project of workspace.items({ entity: 'project', archived: 'include' })) {
    if (member.projectIds !== null && !member.projectIds.includes(project.id)) continue;
    const scope = { workspaceId, projectId: project.id };
    sources.push(project.stale ? sourceDto(scope, project.entity.title, member, saved.get(project.id), 'unavailable', 'core_project_unavailable')
      : await describe(context, scope, member, project.entity.title, saved.get(project.id)));
  }
  await getMembership(context.sql, context.actor, workspaceId).then(current => {
    if (current.version !== member.version || !current.capabilities.includes('domain.read')) throw new DomainError('not_found_or_forbidden', 'Authorization changed; reload the source catalog', 404);
  });
  return { sources };
}

export async function previewDocumentSource(context: DocumentSourceContext, workspaceId: string, input: DocumentSourcePreviewInput): Promise<{ path: string; readable: true }> {
  input = documentSourcePreviewInputSchema.parse(input);
  const scope = documentSourceScopeSchema.parse({ workspaceId, projectId: input.projectId });
  await requireLocalManagement(context.sql, context.actor, workspaceId, true); await authorized(context, scope);
  const directory = openRoot(context, input.path);
  try {
    await assertClaims(context, scope, directory.root); directory.assertCurrent();
    // Actually enumerate the root, rather than accepting an access-bit-only preflight.
    directory.scan();
    await requireLocalManagement(context.sql, context.actor, workspaceId, true); await authorized(context, scope); directory.assertCurrent();
    return { path: directory.root, readable: true };
  } catch (error) { return documentSourceFileError(error); }
  finally { directory.close(); }
}

export async function saveDocumentSource(context: DocumentSourceContext, scope: DocumentSourceScope, input: DocumentSourceUpdate): Promise<{ source: DocumentSource }> {
  scope = documentSourceScopeSchema.parse(scope); input = documentSourceUpdateSchema.parse(input);
  await requireLocalManagement(context.sql, context.actor, scope.workspaceId, true);
  const current = await authorized(context, scope), previous = await readDocumentSource(context.sql, scope);
  if ((previous?.revision ?? 0) !== input.expectedRevision) documentSourceConflict(previous?.revision ?? 0);
  let directory: DocumentSourceDirectory | undefined;
  try {
    if (input.path !== null) {
      directory = openRoot(context, input.path); await assertClaims(context, scope, directory.root); directory.scan(); directory.assertCurrent();
    }
    await requireLocalManagement(context.sql, context.actor, scope.workspaceId, true); await authorized(context, scope); directory?.assertCurrent();
    const saved = await writeDocumentSource(context.sql, scope, { path: directory?.root ?? null, device: directory?.identity.device ?? null, inode: directory?.identity.inode ?? null, expectedRevision: input.expectedRevision, actorId: context.actor.id });
    directory?.assertCurrent();
    return { source: sourceDto(scope, current.name, current.member, saved, saved.path ? 'available' : 'unconfigured') };
  } catch (error) { return documentSourceFileError(error); }
  finally { directory?.close(); }
}

async function readSource<T>(context: DocumentSourceContext, scope: DocumentSourceScope, operation: (directory: DocumentSourceDirectory, saved: DocumentSourceRow, canRead: (relative: string) => boolean) => T, expectedRevision?: number): Promise<T> {
  scope = documentSourceScopeSchema.parse(scope);
  const { member } = await authorized(context, scope), saved = await readDocumentSource(context.sql, scope);
  if (expectedRevision !== undefined && saved?.revision !== expectedRevision) throw new DomainError('document_source_cursor_invalid', 'The source changed; reload from the first page', 409);
  if (!saved?.path) throw new DomainError('document_source_unconfigured', 'No directory is associated with this scope', 409);
  let directory: DocumentSourceDirectory | undefined;
  try {
    await assertClaims(context, scope, saved.path);
    directory = openRoot(context, saved.path, { device: saved.directory_device!, inode: saved.directory_inode! });
    const canRead = await readablePaths(context, scope, member, directory.root);
    const result = operation(directory, saved, canRead);
    const current = await authorized(context, scope), latest = await readDocumentSource(context.sql, scope);
    if (current.member.version !== member.version) throw new DomainError('not_found_or_forbidden', 'Authorization changed during the read', 404);
    if (latest?.revision !== saved.revision) throw new DomainError('document_source_cursor_invalid', 'The source changed; reload from the first page', 409);
    await assertClaims(context, scope, saved.path); directory.assertCurrent();
    return result;
  } catch (error) { return documentSourceFileError(error); }
  finally { directory?.close(); }
}

export async function listDocumentSourceFiles(context: DocumentSourceContext, scope: DocumentSourceScope, input: DocumentSourceFilesQuery = {}): Promise<DocumentSourceFiles> {
  const query = documentSourceFilesQuerySchema.parse(input);
  let cursor: { workspaceId: string; projectId: string | null; revision: number; fingerprint: string; offset: number } | undefined;
  if (query.cursor) {
    try {
      cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as NonNullable<typeof cursor>;
      if (!cursor || cursor.workspaceId !== scope.workspaceId || cursor.projectId !== scope.projectId
        || !Number.isSafeInteger(cursor.revision) || cursor.revision < 1 || !Number.isSafeInteger(cursor.offset) || cursor.offset < 1
        || typeof cursor.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(cursor.fingerprint)) throw new Error('invalid cursor');
    } catch { throw new DomainError('document_source_cursor_invalid', 'The cursor is invalid; reload from the first page', 409); }
  }
  return readSource(context, scope, (directory, saved, canRead) => {
    const snapshot = directory.scan(canRead), offset = cursor?.offset ?? 0;
    if (cursor && (cursor.fingerprint !== snapshot.fingerprint || offset >= snapshot.entries.length))
      throw new DomainError('document_source_cursor_invalid', 'The directory changed; reload from the first page', 409);
    const next = offset + query.limit;
    const nextCursor = next < snapshot.entries.length ? Buffer.from(JSON.stringify({ workspaceId: scope.workspaceId, projectId: scope.projectId, revision: saved.revision, fingerprint: snapshot.fingerprint, offset: next })).toString('base64url') : null;
    return { entries: snapshot.entries.slice(offset, next), nextCursor, scanComplete: snapshot.issues.length === 0, issues: snapshot.issues, sourceRevision: saved.revision };
  }, cursor?.revision);
}
export async function readDocumentSourceContent(context: DocumentSourceContext, scope: DocumentSourceScope, relative: string): Promise<DocumentSourceContent> {
  return readSource(context, scope, (directory, saved, canRead) => {
    assertDocumentRelativePath(relative);
    if (!canRead(relative)) throw new DomainError('not_found_or_forbidden', 'The requested document is unavailable', 404);
    try { return directory.content(relative, saved.revision); }
    catch (error) { return documentSourceFileError(error, true); }
  });
}
