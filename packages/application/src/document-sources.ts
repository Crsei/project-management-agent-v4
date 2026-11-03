import { createHash } from 'node:crypto';
import path from 'node:path';
import type { DocumentSource, DocumentSourceAssociationScope, DocumentSourceConfigurationInput, DocumentSourceConfigurationResponse, DocumentSourceContent, DocumentSourceFiles, DocumentSourceFilesQuery, DocumentSourceMutation, DocumentSourceMutationReceipt, DocumentSourceReference, DocumentSourceScope, DocumentSources } from '../../contracts/src/document-sources.ts';
import { documentSourceConfigurationInputSchema, documentSourceFilesQuerySchema, documentSourceMutationSchema, documentSourceReferenceSchema, documentSourceScopeSchema } from '../../contracts/src/document-sources.ts';
import type { LocalProjectDirectoryListing } from '../../contracts/src/local-projects.ts';
import { DomainError, type Actor } from '../../domain/src/core.ts';
import { assertDocumentRelativePath, DocumentSourceDirectory, DocumentSourceOperationJournal, documentPrivateComponent, documentSourceFileError, type DocumentDirectoryIdentity } from '../../infrastructure/src/document-source-files.ts';
import { beginDocumentSourceOperation, dispatchDocumentSourceOperation, documentSourceConflict, finishDocumentSourceOperation, readDocumentSource, readDocumentSourceOperation, readDocumentSources, readDocumentSourceScopeRevisions, writeDocumentSourceConfiguration, type DocumentSourceOperationRequest, type DocumentSourceOperationRow, type DocumentSourceRow } from '../../infrastructure/src/document-sources.ts';
import type { Workspace } from '../../pm-core/index.ts';
import { maxRepositoryFileBytes } from '../../pm-core/repository.ts';
import { ProjectLocations } from '../../pm-core/project-locations.ts';
import { pathContains, samePath } from '../../pm-core/platform.ts';
import { assertProjectScope, getMembership, type Membership } from './access.ts';
import { agentAllowedDirectory, type AgentDirectoryConfiguration } from './agent-storage.ts';
import { requireLocalManagement } from './local-projects.ts';
import type { SqlExecutor } from './ports.ts';

export type DocumentSourceContext = { sql: SqlExecutor; actor: Actor; config: AgentDirectoryConfiguration; workspace: (workspaceId: string) => Promise<Workspace> };
const contains = pathContains;
const overlaps = (a: string, b: string): boolean => contains(a, b) || contains(b, a);
function pathVisible(member: Membership): boolean { return member.projectIds === null && member.capabilities.includes('access.manage'); }
function canManage(member: Membership): boolean { return pathVisible(member) && member.capabilities.includes('planning.edit') && member.capabilities.includes('domain.read'); }
function requireRead(member: Membership, projectId: string | null): void {
  assertProjectScope(member, projectId);
  if (!member.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Capability domain.read is required', 403);
}
function requireWrite(member: Membership): void {
  if (!member.capabilities.includes('planning.edit')) throw new DomainError('permission_denied', 'Capability planning.edit is required', 403);
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
const association = (saved: DocumentSourceRow): DocumentSourceScope => ({ workspaceId: saved.workspace_id, projectId: saved.project_key || null });
async function authorizedSource(context: DocumentSourceContext, reference: DocumentSourceReference, includeRemoved = false): Promise<{ saved: DocumentSourceRow; member: Membership }> {
  await getMembership(context.sql, context.actor, reference.workspaceId);
  const saved = await readDocumentSource(context.sql, reference, includeRemoved);
  if (!saved) throw new DomainError('not_found_or_forbidden', 'The document source is unavailable', 404);
  const { member } = await authorized(context, association(saved));
  return { saved, member };
}
function allowedRoot(context: DocumentSourceContext, candidate: string): string {
  const root = agentAllowedDirectory(context.config, candidate), config = context.config;
  const privateRoots = [config.coreRoot, config.backupRoot, ...['agent-data', 'blobs', 'logs', 'document-source-operations'].map(name => path.join(config.dataRoot, name))];
  if (process.env.AGENT_WORKSPACE_DATA_DIR?.trim()) privateRoots.push(path.resolve(process.env.AGENT_WORKSPACE_DATA_DIR.trim()));
  if (root.split(path.sep).some(documentPrivateComponent) || privateRoots.some(privateRoot => overlaps(path.resolve(privateRoot), root)))
    throw new DomainError('document_source_path_forbidden', 'Application-private storage cannot be a document source', 403);
  return root;
}

/** An explicitly selected safe root may be shared, even if it is another
 * scope's ordinary directory. A broad parent never implicitly shares registered
 * private subtrees. Omit denied paths entirely, including names in scan issues. */
async function readablePaths(context: DocumentSourceContext, scope: DocumentSourceScope, member: Membership, root: string): Promise<(relative: string) => boolean> {
  const blocked: string[] = [];
  const blockDescendant = (boundary: string): void => { const normalized = path.resolve(boundary); if (!samePath(normalized, root) && contains(root, normalized)) blocked.push(normalized); };
  const workspaces = await context.sql.query<{ id: string }>('SELECT id FROM workspaces ORDER BY id');
  const foreignAreas = await context.sql.query<{ path: string }>('SELECT path FROM agent_file_areas WHERE workspace_id <> $1', [scope.workspaceId]);
  for (const area of foreignAreas.rows) blockDescendant(area.path);
  const sources = await context.sql.query<{ workspace_id: string; project_key: string; path: string }>('SELECT workspace_id,project_key,path FROM document_sources WHERE removed_at IS NULL AND path IS NOT NULL');
  for (const source of sources.rows) {
    if (source.workspace_id === scope.workspaceId && (member.projectIds === null || source.project_key !== '' && member.projectIds.includes(source.project_key))) continue;
    blockDescendant(source.path);
  }
  try {
    for (const workspace of workspaces.rows) {
      for (const location of new ProjectLocations(path.join(context.config.coreRoot, workspace.id)).list()) {
        if (workspace.id === scope.workspaceId && (member.projectIds === null || member.projectIds.includes(location.projectId))) continue;
        blockDescendant(location.root);
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
function sourceDto(member: Membership, saved: DocumentSourceRow, status: DocumentSource['status'], reason?: string): DocumentSource {
  return { sourceId: saved.source_id, projectId: saved.project_key || null, name: path.basename(saved.path!), path: canManage(member) ? saved.path : null, revision: saved.revision,
    status, canManage: canManage(member), canWrite: status === 'available' && member.capabilities.includes('planning.edit') && member.capabilities.includes('domain.read'), ...(reason ? { reason } : {}) };
}
function describe(context: DocumentSourceContext, member: Membership, saved: DocumentSourceRow): DocumentSource {
  let directory: DocumentSourceDirectory | undefined;
  try {
    directory = openRoot(context, saved.path!, { device: saved.directory_device!, inode: saved.directory_inode! }); directory.assertCurrent();
    return sourceDto(member, saved, 'available');
  } catch (error) {
    return sourceDto(member, saved, 'unavailable', error instanceof DomainError ? error.code === 'document_source_unavailable' ? String((error.details as { reason?: string } | undefined)?.reason ?? error.code) : error.code : 'directory_unavailable');
  } finally { directory?.close(); }
}
function scopeDto(projectId: string | null, name: string, member: Membership, revision: number): DocumentSourceAssociationScope { return { projectId, name, revision, canManage: canManage(member) }; }

export async function listDocumentSources(context: DocumentSourceContext, workspaceId: string): Promise<DocumentSources> {
  const member = await getMembership(context.sql, context.actor, workspaceId);
  if (!member.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Capability domain.read is required', 403);
  const workspace = await context.workspace(workspaceId), saved = await readDocumentSources(context.sql, workspaceId), revisions = await readDocumentSourceScopeRevisions(context.sql, workspaceId);
  const sources: DocumentSource[] = [], scopes: DocumentSourceAssociationScope[] = [];
  if (member.projectIds === null) {
    const current = await authorized(context, { workspaceId, projectId: null });
    scopes.push(scopeDto(null, current.name, member, revisions.get('') ?? 0));
    sources.push(...saved.filter(source => source.project_key === '').map(source => describe(context, member, source)));
  }
  for (const project of workspace.items({ entity: 'project', archived: 'include' })) {
    if (member.projectIds !== null && !member.projectIds.includes(project.id)) continue;
    scopes.push({ ...scopeDto(project.id, project.entity.title, member, revisions.get(project.id) ?? 0), ...(project.stale ? { canManage: false } : {}) });
    sources.push(...saved.filter(source => source.project_key === project.id).map(source => project.stale ? sourceDto(member, source, 'unavailable', 'core_project_unavailable') : describe(context, member, source)));
  }
  const current = await getMembership(context.sql, context.actor, workspaceId);
  if (current.version !== member.version || !current.capabilities.includes('domain.read')) throw new DomainError('not_found_or_forbidden', 'Authorization changed; reload the source catalog', 404);
  return { sources, scopes };
}

export async function configureDocumentSources(context: DocumentSourceContext, workspaceId: string, input: DocumentSourceConfigurationInput): Promise<DocumentSourceConfigurationResponse> {
  input = documentSourceConfigurationInputSchema.parse(input);
  const scope = documentSourceScopeSchema.parse({ workspaceId, projectId: input.projectId });
  await requireLocalManagement(context.sql, context.actor, workspaceId, true);
  const current = await authorized(context, scope), revision = (await readDocumentSourceScopeRevisions(context.sql, workspaceId)).get(scope.projectId ?? '') ?? 0;
  if (revision !== input.expectedRevision) documentSourceConflict(revision);
  const directories: DocumentSourceDirectory[] = [];
  try {
    for (const candidate of input.paths) {
      const directory = openRoot(context, candidate); directories.push(directory);
      if (directories.some(other => other !== directory && overlaps(other.root, directory.root)))
        throw new DomainError('document_source_overlap', 'Directories in the same association scope cannot duplicate or contain one another', 409);
      directory.scan(await readablePaths(context, scope, current.member, directory.root)); directory.assertCurrent();
    }
    await requireLocalManagement(context.sql, context.actor, workspaceId, true);
    const latest = await authorized(context, scope);
    if (latest.member.version !== current.member.version) throw new DomainError('not_found_or_forbidden', 'Authorization changed; reload the source catalog', 404);
    for (const directory of directories) directory.assertCurrent();
    const saved = await writeDocumentSourceConfiguration(context.sql, scope, { directories: directories.map(directory => ({ path: directory.root, ...directory.identity })), expectedRevision: input.expectedRevision, actorId: context.actor.id });
    for (const directory of directories) directory.assertCurrent();
    return { scope: scopeDto(scope.projectId, latest.name, latest.member, saved.revision), sources: saved.sources.map(source => sourceDto(latest.member, source, 'available')) };
  } catch (error) { return documentSourceFileError(error); }
  finally { for (const directory of directories) directory.close(); }
}

export async function listDocumentSourceDirectories(context: DocumentSourceContext, workspaceId: string, projectId: string | null, candidate?: string): Promise<LocalProjectDirectoryListing> {
  const scope = documentSourceScopeSchema.parse({ workspaceId, projectId });
  await requireLocalManagement(context.sql, context.actor, workspaceId, true); await authorized(context, scope);
  const roots: string[] = [];
  for (const configured of [...context.config.allowedRoots, context.config.chatSpaceRoot]) {
    let directory: DocumentSourceDirectory | undefined;
    try { directory = openRoot(context, configured); if (!roots.includes(directory.root)) roots.push(directory.root); }
    catch { /* Missing or application-private configured roots are not selectable. */ }
    finally { directory?.close(); }
  }
  if (!candidate) return { path: null, parentPath: null, roots, directories: [] };
  const directory = openRoot(context, candidate);
  try {
    const directories: LocalProjectDirectoryListing['directories'] = [];
    for (const entry of directory.entries()) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.') || documentPrivateComponent(entry.name)) continue;
      let child: DocumentSourceDirectory | undefined;
      try { child = openRoot(context, path.join(directory.root, entry.name)); directories.push({ name: entry.name, path: child.root }); }
      catch { /* Never disclose unsafe/unavailable directory names. */ }
      finally { child?.close(); }
    }
    let parentPath: string | null = null, parent: DocumentSourceDirectory | undefined;
    try { if (!roots.includes(directory.root)) { parent = openRoot(context, path.dirname(directory.root)); parentPath = parent.root; } }
    catch { /* Navigation stops at the trusted document boundary. */ }
    finally { parent?.close(); }
    await requireLocalManagement(context.sql, context.actor, workspaceId, true); await authorized(context, scope); directory.assertCurrent();
    return { path: directory.root, parentPath, roots, directories: directories.sort((a, b) => a.name.localeCompare(b.name)) };
  } catch (error) { return documentSourceFileError(error); }
  finally { directory.close(); }
}

async function readSource<T>(context: DocumentSourceContext, reference: DocumentSourceReference, operation: (directory: DocumentSourceDirectory, saved: DocumentSourceRow, canRead: (relative: string) => boolean, member: Membership) => T, expectedRevision?: number): Promise<T> {
  reference = documentSourceReferenceSchema.parse(reference);
  const { member, saved } = await authorizedSource(context, reference);
  if (expectedRevision !== undefined && saved.revision !== expectedRevision) throw new DomainError('document_source_cursor_invalid', 'The source changed; reload from the first page', 409);
  let directory: DocumentSourceDirectory | undefined;
  try {
    directory = openRoot(context, saved.path!, { device: saved.directory_device!, inode: saved.directory_inode! });
    const canRead = await readablePaths(context, association(saved), member, directory.root), result = operation(directory, saved, canRead, member);
    const current = await authorizedSource(context, reference);
    if (current.member.version !== member.version) throw new DomainError('not_found_or_forbidden', 'Authorization changed during the read', 404);
    if (current.saved.revision !== saved.revision) throw new DomainError('document_source_cursor_invalid', 'The source changed; reload from the first page', 409);
    directory.assertCurrent(); return result;
  } catch (error) { return documentSourceFileError(error); }
  finally { directory?.close(); }
}
export async function listDocumentSourceFiles(context: DocumentSourceContext, reference: DocumentSourceReference, input: DocumentSourceFilesQuery = {}): Promise<DocumentSourceFiles> {
  const query = documentSourceFilesQuerySchema.parse(input);
  let cursor: { workspaceId: string; sourceId: string; revision: number; fingerprint: string; offset: number } | undefined;
  if (query.cursor) {
    try {
      cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as NonNullable<typeof cursor>;
      if (!cursor || cursor.workspaceId !== reference.workspaceId || cursor.sourceId !== reference.sourceId
        || !Number.isSafeInteger(cursor.revision) || cursor.revision < 1 || !Number.isSafeInteger(cursor.offset) || cursor.offset < 1
        || typeof cursor.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(cursor.fingerprint)) throw new Error('invalid cursor');
    } catch { throw new DomainError('document_source_cursor_invalid', 'The cursor is invalid; reload from the first page', 409); }
  }
  return readSource(context, reference, (directory, saved, canRead) => {
    const snapshot = directory.scan(canRead), offset = cursor?.offset ?? 0;
    if (cursor && (cursor.fingerprint !== snapshot.fingerprint || offset >= snapshot.entries.length)) throw new DomainError('document_source_cursor_invalid', 'The directory changed; reload from the first page', 409);
    const next = offset + query.limit;
    const nextCursor = next < snapshot.entries.length ? Buffer.from(JSON.stringify({ ...reference, revision: saved.revision, fingerprint: snapshot.fingerprint, offset: next })).toString('base64url') : null;
    const entries = snapshot.entries.slice(offset, next).map(entry => ({ ...entry, fileKey: createHash('sha256').update(reference.workspaceId).update('\0').update(path.join(directory.root, entry.path)).digest('hex') }));
    return { entries, nextCursor, scanComplete: snapshot.issues.length === 0, issues: snapshot.issues, sourceRevision: saved.revision };
  }, cursor?.revision);
}
export async function readDocumentSourceContent(context: DocumentSourceContext, reference: DocumentSourceReference, relative: string): Promise<DocumentSourceContent> {
  return readSource(context, reference, (directory, saved, canRead, member) => {
    assertDocumentRelativePath(relative);
    if (!canRead(relative)) throw new DomainError('not_found_or_forbidden', 'The requested document is unavailable', 404);
    try { return directory.content(relative, saved.revision, member.capabilities.includes('planning.edit')); }
    catch (error) { return documentSourceFileError(error, true); }
  });
}

function operationReceipt(row: DocumentSourceOperationRow, status: DocumentSourceMutationReceipt['status'], message?: string): DocumentSourceMutationReceipt {
  const target = row.request.targetSourceId ?? row.request.targetScope;
  return { operationId: row.operation_id, action: row.request.action, path: row.request.path, status,
    ...(target ? { targetSourceId: target, targetPath: row.request.targetPath } : {}), ...(message ? { message } : {}) };
}
async function authorizedOperation(context: DocumentSourceContext, reference: DocumentSourceReference, row: DocumentSourceOperationRow): Promise<Membership> {
  const { member } = await authorized(context, { workspaceId: reference.workspaceId, projectId: row.source_project_key || null }); requireWrite(member); return member;
}
async function authorizedReceipt(context: DocumentSourceContext, reference: DocumentSourceReference, row: DocumentSourceOperationRow, receipt: DocumentSourceMutationReceipt): Promise<DocumentSourceMutationReceipt> {
  let member = await authorizedOperation(context, reference, row), destination: DocumentSourceScope = { workspaceId: reference.workspaceId, projectId: row.source_project_key || null };
  if (receipt.status === 'not_applied') return receipt;
  let root = row.request.sourceRoot, relative = row.request.path;
  if (row.request.action === 'move') {
    const target = row.request.targetSourceId ?? row.request.targetScope;
    if (!target) throw new DomainError('document_source_operation_unavailable', 'The historical destination is unavailable', 409);
    const saved = await readDocumentSource(context.sql, { workspaceId: reference.workspaceId, sourceId: target }, true);
    // Legacy failed attempts can refer to a scope with no configured source row.
    if (!saved && row.request.targetScope === undefined) throw new DomainError('not_found_or_forbidden', 'The historical destination is unavailable', 404);
    destination = saved ? association(saved) : { workspaceId: reference.workspaceId, projectId: row.request.targetScope === 'workspace' ? null : row.request.targetScope! };
    member = (await authorized(context, destination)).member; requireWrite(member);
    root = row.request.targetRoot; relative = row.request.targetPath!;
  }
  if (!receipt.content) return receipt;
  if (root) {
    try {
      const checked = allowedRoot(context, root);
      if ((await readablePaths(context, destination, member, checked))(relative)) return receipt;
    } catch { /* Historical completion metadata remains queryable without bytes. */ }
  }
  const metadata = { ...receipt, message: 'The original operation completed; its historical content is no longer readable under current directory boundaries' };
  delete metadata.content; return metadata;
}
async function reconcileDocumentSourceOperation(context: DocumentSourceContext, reference: DocumentSourceReference, row: DocumentSourceOperationRow): Promise<DocumentSourceMutationReceipt> {
  if (row.receipt) return authorizedReceipt(context, reference, row, row.receipt);
  if (row.status === 'prepared') {
    const receipt = operationReceipt(row, 'not_applied', 'The original attempt stopped before filesystem dispatch; an explicit new request is safe');
    await finishDocumentSourceOperation(context.sql, reference, context.actor.id, receipt); return authorizedReceipt(context, reference, row, receipt);
  }
  let journal: DocumentSourceOperationJournal | undefined;
  try {
    journal = new DocumentSourceOperationJournal(context.config.dataRoot, reference.workspaceId, context.actor.id);
    const proof = journal.read(row.operation_id, row.request_hash);
    if (proof) {
      await finishDocumentSourceOperation(context.sql, reference, context.actor.id, proof).catch(() => undefined);
      return authorizedReceipt(context, reference, row, proof);
    }
  } catch { /* No evidence is not proof that filesystem effects were absent. */ }
  finally { journal?.close(); }
  return authorizedReceipt(context, reference, row, operationReceipt(row, 'unknown', 'The original filesystem outcome is uncertain; do not repeat this write'));
}
/** Queries never repeat, resume or compensate filesystem effects. */
export async function queryDocumentSourceMutation(context: DocumentSourceContext, reference: DocumentSourceReference, operationId: string): Promise<DocumentSourceMutationReceipt> {
  reference = documentSourceReferenceSchema.parse(reference);
  await getMembership(context.sql, context.actor, reference.workspaceId);
  const row = await readDocumentSourceOperation(context.sql, reference, context.actor.id, operationId);
  if (!row || row.source_id !== reference.sourceId) throw new DomainError('document_source_operation_not_found', 'No original operation is recorded for this identity and source; this is not permission to replay an uncertain write', 404);
  await authorizedOperation(context, reference, row); return reconcileDocumentSourceOperation(context, reference, row);
}

type WritableDocumentSource = { directory: DocumentSourceDirectory; saved: DocumentSourceRow };
async function writableSource(context: DocumentSourceContext, reference: DocumentSourceReference, revision: number, relative: string): Promise<WritableDocumentSource> {
  const { member, saved } = await authorizedSource(context, reference, true); requireWrite(member); assertDocumentRelativePath(relative);
  if (saved.revision !== revision || saved.removed_at !== null) documentSourceConflict(saved.revision);
  const canRead = await readablePaths(context, association(saved), member, saved.path!);
  if (!canRead(relative)) throw new DomainError('not_found_or_forbidden', 'The requested document is unavailable', 404);
  return { directory: openRoot(context, saved.path!, { device: saved.directory_device!, inode: saved.directory_inode! }), saved };
}
/** Uncertain side effects block overlapping physical roots globally, not aliases
 * or workspace IDs. Never disclose the other actor, operation or host path. */
async function assertNoPhysicalPending(context: DocumentSourceContext, reference: DocumentSourceReference, operationId: string, roots: string[]): Promise<void> {
  const pending = await context.sql.query<{ source_root: string | null; target_root: string | null; action: string }>(`SELECT
      COALESCE(o.request->>'sourceRoot',s.path) AS source_root,
      COALESCE(o.request->>'targetRoot',t.path) AS target_root,o.request->>'action' AS action
    FROM document_source_operations o
    LEFT JOIN document_sources s ON s.workspace_id=o.workspace_id AND s.source_id=o.source_id
    LEFT JOIN document_sources t ON t.workspace_id=o.workspace_id AND t.source_id=COALESCE(o.request->>'targetSourceId',o.request->>'targetScope')
    WHERE o.status IN ('applying','unknown') AND NOT(o.workspace_id=$1 AND o.actor_id=$2 AND o.operation_id=$3)`,
  [reference.workspaceId, context.actor.id, operationId]);
  if (pending.rows.some(row => !row.source_root || row.action === 'move' && !row.target_root || [row.source_root, row.target_root].some(root => root && roots.some(candidate => overlaps(path.resolve(root), candidate)))))
    throw new DomainError('document_source_operation_pending', 'An uncertain operation overlaps this physical directory; its owner must reconcile the original operation before another write', 409);
}
function historicalOperationHash(reference: DocumentSourceReference, row: DocumentSourceOperationRow | undefined, input: DocumentSourceMutation): string | undefined {
  if (!row || input.action === 'move' && row.request.targetScope !== input.targetSourceId) return undefined;
  const base = { operationId: input.operationId, sourceRevision: input.sourceRevision, path: input.path, action: input.action };
  const original = input.action === 'create' ? { ...base, content: input.content }
    : input.action === 'save' ? { ...base, expectedRevision: input.expectedRevision, content: input.content }
      : input.action === 'delete' ? { ...base, expectedRevision: input.expectedRevision }
        : { ...base, expectedRevision: input.expectedRevision, targetScope: row.request.targetScope ?? input.targetSourceId, targetSourceRevision: input.targetSourceRevision, targetPath: input.targetPath };
  return createHash('sha256').update(JSON.stringify({ scope: { workspaceId: reference.workspaceId, projectId: row.source_project_key || null }, input: original })).digest('hex');
}
/** Attempt/applying autocommits precede every filesystem effect. */
export async function mutateDocumentSource(context: DocumentSourceContext, reference: DocumentSourceReference, input: DocumentSourceMutation): Promise<DocumentSourceMutationReceipt> {
  reference = documentSourceReferenceSchema.parse(reference); input = documentSourceMutationSchema.parse(input);
  await getMembership(context.sql, context.actor, reference.workspaceId);
  const existing = await readDocumentSourceOperation(context.sql, reference, context.actor.id, input.operationId);
  const projectId = existing?.source_id === reference.sourceId ? existing.source_project_key || null : (await authorizedSource(context, reference, true)).saved.project_key || null;
  const { member } = await authorized(context, { workspaceId: reference.workspaceId, projectId }); requireWrite(member);
  const hash = createHash('sha256').update(JSON.stringify({ reference, input })).digest('hex');
  const request: DocumentSourceOperationRequest = { action: input.action, path: input.path, sourceRevision: input.sourceRevision,
    ...('expectedRevision' in input ? { expectedRevision: input.expectedRevision } : {}),
    ...(input.action === 'move' ? { targetSourceId: input.targetSourceId, targetPath: input.targetPath, targetSourceRevision: input.targetSourceRevision } : {}) };
  const attempt = await beginDocumentSourceOperation(context.sql, reference, projectId, context.actor.id, input.operationId, hash, request, historicalOperationHash(reference, existing, input));
  if (!attempt.created) return reconcileDocumentSourceOperation(context, reference, attempt.row);
  let source: WritableDocumentSource | undefined, target: WritableDocumentSource | undefined, journal: DocumentSourceOperationJournal | undefined;
  let dispatched = false;
  try {
    source = await writableSource(context, reference, input.sourceRevision, input.path);
    if (input.action === 'move') target = await writableSource(context, { workspaceId: reference.workspaceId, sourceId: input.targetSourceId }, input.targetSourceRevision, input.targetPath);
    await assertNoPhysicalPending(context, reference, input.operationId, [source.directory.root, ...(target ? [target.directory.root] : [])]);
    if ('content' in input && Buffer.byteLength(input.content, 'utf8') > maxRepositoryFileBytes) throw new DomainError('document_source_file_too_large', 'Markdown content exceeds the 4 MiB limit', 413, { maxBytes: maxRepositoryFileBytes });
    if (input.action === 'create') source.directory.assertVacant(input.path);
    else source.directory.assertWritable(input.path, input.expectedRevision, source.saved.revision);
    if (input.action === 'move') {
      if (path.join(source.directory.root, input.path) === path.join(target!.directory.root, input.targetPath)) throw new DomainError('document_source_same_path', 'Source and destination are the same Markdown file', 409);
      target!.directory.assertVacant(input.targetPath); request.targetRoot = target!.directory.root;
    }
    request.sourceRoot = source.directory.root;
    journal = new DocumentSourceOperationJournal(context.config.dataRoot, reference.workspaceId, context.actor.id);
    source.directory.assertCurrent(); target?.directory.assertCurrent();
    await dispatchDocumentSourceOperation(context.sql, reference, context.actor.id, input.operationId, request); dispatched = true;
    let content: DocumentSourceContent | undefined;
    if (input.action === 'create') content = source.directory.write(input.path, input.content, source.saved.revision);
    else if (input.action === 'save') content = source.directory.write(input.path, input.content, source.saved.revision, input.expectedRevision);
    else if (input.action === 'delete') source.directory.remove(input.path, input.expectedRevision, source.saved.revision);
    else content = source.directory.move(input.path, input.expectedRevision, source.saved.revision, target!.directory, input.targetPath, target!.saved.revision);
    const receipt = { ...operationReceipt(attempt.row, 'succeeded'), ...(content ? { content } : {}) };
    journal.record(input.operationId, hash, receipt); await finishDocumentSourceOperation(context.sql, reference, context.actor.id, receipt); return receipt;
  } catch (error) {
    if (dispatched) {
      const receipt = operationReceipt(attempt.row, 'unknown', 'The original filesystem outcome is uncertain; query this operation ID and do not repeat the write');
      await finishDocumentSourceOperation(context.sql, reference, context.actor.id, receipt).catch(() => undefined); return receipt;
    }
    const receipt = operationReceipt(attempt.row, 'not_applied', 'The original attempt was rejected before filesystem dispatch; no Markdown mutation was applied');
    await finishDocumentSourceOperation(context.sql, reference, context.actor.id, receipt).catch(() => undefined);
    if (!(error instanceof DomainError) && error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)) throw new DomainError('document_source_operation_unavailable', 'The original attempt did not reach filesystem dispatch; query its recorded result before retrying', 503);
    return documentSourceFileError(error, true);
  } finally { journal?.close(); target?.directory.close(); source?.directory.close(); }
}
