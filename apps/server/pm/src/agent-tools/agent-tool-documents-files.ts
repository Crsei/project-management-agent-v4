import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Actor, Command, CommandReceipt, Entity } from '../../../../../packages/domain/src/core.ts';
import { DomainError } from '../../../../../packages/domain/src/core.ts';
import type { CoreAccess, SqlExecutor } from '../../../../../packages/application/src/ports.ts';
import { assertAgentToolNotAborted, assertAgentToolProject, type AgentChatToolContext } from '../../../../../packages/application/src/agent-chat-tools.ts';
import { DocumentsFilesToolInputSchemas } from '../../../../../packages/application/src/agent-tool-documents-files.ts';
import { authorizeExternalDocumentHistory, configureDocumentSources, inspectDocumentSourceMutation, listDocumentSourceFiles, listDocumentSources, mutateDocumentSource, queryDocumentSourceMutation, readDocumentSourceMutationResult, readDocumentSourceContent, type DocumentSourceContext } from '../../../../../packages/application/src/document-sources.ts';
import { listEntities, readEntity } from '../../../../../packages/application/src/queries.ts';
import { requireCapability } from '../../../../../packages/application/src/access.ts';
import { readArtifactCopyOrigin } from '../../../../../packages/application/src/artifact-copy-origins.ts';
import { requestHash } from '../../../../../packages/application/src/kernel.ts';
import { documentSourceIdSchema, documentSourceMutationSchema, type DocumentSourceContent, type DocumentSourceMutation, type DocumentSourceMutationReceipt } from '../../../../../packages/contracts/src/document-sources.ts';
import { DocumentsFilesToolResultSchema, documentsFilesArtifactSchema, documentsFilesArtifactVersionSchema, documentsFilesUploadSchema, type DocumentsFilesToolResult, type DocumentsFilesArtifact, type DocumentsFilesArtifactVersion, type DocumentsFilesUpload } from '../../../../../packages/agent-contracts/src/pm-tool-documents-files.ts';
import type { AgentChatToolReceipt } from '../../../../../packages/agent-contracts/src/pm-tool-shared.ts';
import type { AgentChatToolFamily } from './agent-chat-tools.ts';

export const documentsFilesRecoveryIdentitySchema = z.strictObject({ kind: z.literal('document-source'), commandId: z.uuid().toLowerCase(), hash: z.string().regex(/^[a-f0-9]{64}$/), action: z.enum(['create', 'save', 'move', 'delete']), sourceId: documentSourceIdSchema });
export type DocumentsFilesToolDependencies = {
  database: () => Pool;
  sources: Pick<DocumentSourceContext, 'config' | 'workspace' | 'history'>;
  executeCommand: (actor: Actor, workspaceId: string, command: Command, checkAuthorization?: AgentChatToolContext['checkAuthorization']) => Promise<CommandReceipt>;
  readCommandReceipt: (actor: Actor, workspaceId: string, command: Command) => Promise<CommandReceipt | null>;
  coreAccessFor: (actor: Actor, workspaceId: string, sql: SqlExecutor) => Promise<CoreAccess>;
};
type Name = keyof typeof DocumentsFilesToolInputSchemas;
type Args<N extends Name> = z.infer<typeof DocumentsFilesToolInputSchemas[N]>;
const mutationNames = ['pm_create_external_file', 'pm_save_external_file', 'pm_rename_external_file', 'pm_move_external_file', 'pm_delete_external_file'] as const;
type MutationName = typeof mutationNames[number];
const commandNames = ['pm_register_artifact', 'pm_add_artifact_version', 'pm_rename_artifact', 'pm_hide_artifact', 'pm_restore_artifact', 'pm_copy_artifact_version'] as const;
type CommandName = typeof commandNames[number];
const fields: Pick<DocumentsFilesToolResult, 'nextCursor' | 'truncated' | 'sources'> = { nextCursor: null, truncated: false, sources: [] };
function parse<N extends Name>(name: N, input: unknown): Args<N> { return DocumentsFilesToolInputSchemas[name].parse(input) as Args<N>; }
function checkProject(context: AgentChatToolContext, projectId: string | null): void {
  if (projectId === null) {
    if (context.scope.kind !== 'workspace') throw new DomainError('not_found_or_forbidden', 'Workspace source is outside the explicitly authorized scope', 404);
  } else assertAgentToolProject(context.scope, projectId);
}
function externalMutation(name: MutationName, input: unknown, context: AgentChatToolContext): { sourceId: string; input: DocumentSourceMutation } {
  if (name === 'pm_create_external_file') {
    const args = parse(name, input);
    return { sourceId: args.sourceId, input: documentSourceMutationSchema.parse({ operationId: context.operationId, sourceRevision: args.sourceRevision, path: args.path, action: 'create', content: args.content }) };
  }
  if (name === 'pm_save_external_file') {
    const args = parse(name, input);
    return { sourceId: args.sourceId, input: documentSourceMutationSchema.parse({ operationId: context.operationId, sourceRevision: args.sourceRevision, path: args.path, action: 'save', expectedRevision: args.expectedRevision, content: args.content }) };
  }
  if (name === 'pm_delete_external_file') {
    const args = parse(name, input);
    return { sourceId: args.sourceId, input: documentSourceMutationSchema.parse({ operationId: context.operationId, sourceRevision: args.sourceRevision, path: args.path, action: 'delete', expectedRevision: args.expectedRevision }) };
  }
  const args = name === 'pm_move_external_file' ? parse(name, input) : parse('pm_rename_external_file', input);
  return { sourceId: args.sourceId, input: documentSourceMutationSchema.parse({ operationId: context.operationId, sourceRevision: args.sourceRevision, path: args.path, action: 'move', expectedRevision: args.expectedRevision, targetSourceId: 'targetSourceId' in args ? args.targetSourceId : args.sourceId, targetSourceRevision: 'targetSourceRevision' in args ? args.targetSourceRevision : args.sourceRevision, targetPath: args.targetPath }) };
}
function commandFor(name: CommandName, input: unknown, context: AgentChatToolContext): Command {
  const commandId = z.uuid().toLowerCase().parse(context.operationId);
  if (name === 'pm_register_artifact') {
    const args = parse(name, input);
    return { commandId, commandType: 'RegisterArtifact', projectId: args.projectId, expectedVersions: { [args.uploadId]: args.uploadVersion }, payload: { uploadId: args.uploadId, title: args.title, kind: args.artifactKind } };
  }
  if (name === 'pm_add_artifact_version') {
    const args = parse(name, input);
    return { commandId, commandType: 'AddArtifactVersion', projectId: args.projectId, targetId: args.artifactId, expectedVersions: { [args.artifactId]: args.expectedVersion, [args.uploadId]: args.uploadVersion }, payload: { uploadId: args.uploadId } };
  }
  if (name === 'pm_copy_artifact_version') {
    const args = parse(name, input);
    return { commandId, commandType: 'CopyArtifactVersion', projectId: args.projectId, targetId: args.artifactVersionId, expectedVersions: { [args.sourceArtifactId]: args.sourceArtifactVersion, [args.artifactVersionId]: args.artifactVersion, [args.projectId]: args.projectVersion }, payload: { targetTitle: args.title, targetKind: args.artifactKind } };
  }
  const args = name === 'pm_rename_artifact' ? parse(name, input) : name === 'pm_hide_artifact' ? parse(name, input) : parse('pm_restore_artifact', input);
  return { commandId, commandType: name === 'pm_rename_artifact' ? 'RenameArtifact' : name === 'pm_hide_artifact' ? 'HideArtifact' : 'RestoreArtifact', projectId: args.projectId, targetId: args.artifactId, expectedVersions: { [args.artifactId]: args.expectedVersion }, payload: 'title' in args ? { title: args.title } : {} };
}
function contentSlice(content: DocumentSourceContent, offset = 0, limit = 24000) {
  const end = Math.min(content.content.length, offset + limit);
  return { ...content, content: content.content.slice(offset, end), contentOffset: offset, nextContentOffset: end < content.content.length ? end : null };
}
function applicationReceipt(context: AgentChatToolContext, sourceId: string, result: DocumentSourceMutationReceipt): AgentChatToolReceipt | undefined {
  if (result.status !== 'succeeded') return undefined;
  return { kind: 'application', operationId: context.operationId, commandId: result.operationId, action: result.action, targetId: `${sourceId}:${result.path}`, revision: result.content?.revision ?? null, ...(context.linkage ? { linkage: context.linkage } : {}) };
}
function operationResult(context: AgentChatToolContext, sourceId: string, result: DocumentSourceMutationReceipt): DocumentsFilesToolResult {
  const receipt = applicationReceipt(context, sourceId, result);
  const { content, ...metadata } = result;
  return { kind: 'external-file-operation', sourceId, items: [{ ...metadata, ...(content ? { content: contentSlice(content) } : {}) }], ...fields, truncated: !!content && content.content.length > 24000, ...(receipt ? { receipt } : {}) };
}
function artifact(entity: Entity): DocumentsFilesArtifact {
  if (entity.kind !== 'artifact') throw new DomainError('not_found_or_forbidden', 'The requested artifact is unavailable', 404);
  return documentsFilesArtifactSchema.parse({ id: entity.id, workspaceId: entity.workspaceId, projectId: entity.projectId, version: entity.version, title: entity.data.title.slice(0, 300), artifactKind: entity.data.kind, hiddenAt: entity.data.hiddenAt, hiddenBy: entity.data.hiddenBy, versionRefs: entity.data.versionRefs.slice(0, 200), totalVersions: entity.data.versionRefs.length, latestVersionId: entity.data.latestVersionId });
}
function artifactVersion(entity: Entity): DocumentsFilesArtifactVersion {
  if (entity.kind !== 'artifact_version') throw new DomainError('not_found_or_forbidden', 'The requested immutable version is unavailable', 404);
  return documentsFilesArtifactVersionSchema.parse({ id: entity.id, workspaceId: entity.workspaceId, projectId: entity.projectId, version: entity.version, artifactId: entity.data.artifactId, uploadId: entity.data.uploadId, sha256: entity.data.sha256, contentDigest: entity.data.contentDigest, size: entity.data.size, mediaType: entity.data.mediaType, fileName: entity.data.fileName, producerId: entity.data.producerId, downloadPath: `/api/v1/workspaces/${entity.workspaceId}/artifact-versions/${entity.id}/content` });
}
function upload(entity: Entity): DocumentsFilesUpload {
  if (entity.kind !== 'upload') throw new DomainError('not_found_or_forbidden', 'The staged upload is unavailable', 404);
  return documentsFilesUploadSchema.parse({ id: entity.id, workspaceId: entity.workspaceId, projectId: entity.projectId, version: entity.version, fileName: entity.data.fileName, mediaType: entity.data.mediaType, sha256: entity.data.sha256, size: entity.data.size, ownerId: entity.data.ownerId, expiresAt: entity.data.expiresAt, consumedAt: entity.data.consumedAt, consumedByArtifactVersionId: entity.data.consumedByArtifactVersionId });
}

export function createDocumentsFilesToolFamily(options: DocumentsFilesToolDependencies): AgentChatToolFamily {
  // Same locks and transaction boundaries as the native document-source routes.
  // Filesystem attempts/dispatch/receipts intentionally autocommit independently.
  async function sourceOperation<T>(context: AgentChatToolContext, mutation: boolean, operation: (source: DocumentSourceContext) => Promise<T>, scoped = true): Promise<T> {
    const sql = await options.database().connect();
    let destroy = false;
    try {
      if (mutation) {
        await sql.query('SELECT pg_advisory_lock(hashtextextended($1::uuid::text,724631))', [context.workspaceId]);
        await sql.query("SELECT pg_advisory_lock(hashtextextended('local-project-directories',724631))");
      } else {
        await sql.query('BEGIN');
        await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text,724631))', [context.workspaceId]);
        await sql.query("SELECT pg_advisory_xact_lock(hashtextextended('local-project-directories',724631))");
      }
      assertAgentToolNotAborted(context);
      await context.checkAuthorization?.(sql);
      const result = await operation({ ...options.sources, sql, actor: context.actor, ...(scoped ? { checkProject: (projectId: string | null) => checkProject(context, projectId) } : {}), checkAuthorization: async transaction => { assertAgentToolNotAborted(context); await context.checkAuthorization?.(transaction); } });
      await context.checkAuthorization?.(sql);
      if (!mutation) await sql.query('COMMIT');
      return result;
    } catch (error) {
      if (!mutation) await sql.query('ROLLBACK').catch(() => { destroy = true; });
      throw error;
    } finally {
      if (mutation) {
        try {
          await sql.query("SELECT pg_advisory_unlock(hashtextextended('local-project-directories',724631))");
          await sql.query('SELECT pg_advisory_unlock(hashtextextended($1::uuid::text,724631))', [context.workspaceId]);
        } catch { destroy = true; }
      }
      sql.release(destroy);
    }
  }
  async function current(context: AgentChatToolContext, id: string, projectId: string): Promise<Entity> {
    checkProject(context, projectId);
    const entity = await readEntity(options.database(), context.actor, context.workspaceId, id);
    if (entity.projectId !== projectId) throw new DomainError('not_found_or_forbidden', 'The resource is outside the explicit project reference', 404);
    return entity;
  }
  async function authorizeCommand(name: CommandName, input: unknown, context: AgentChatToolContext): Promise<void> {
    const args = parse(name, input);
    checkProject(context, args.projectId);
    await requireCapability(options.database(), context.actor, context.workspaceId, 'domain.read', args.projectId);
    await requireCapability(options.database(), context.actor, context.workspaceId, 'delivery.write', args.projectId);
    if (name === 'pm_copy_artifact_version') {
      const copy = parse(name, input);
      checkProject(context, copy.sourceProjectId);
      const version = await current(context, copy.artifactVersionId, copy.sourceProjectId);
      if (version.kind !== 'artifact_version' || version.data.artifactId !== copy.sourceArtifactId) throw new DomainError('not_found_or_forbidden', 'The source immutable version does not match its artifact reference', 404);
    }
    await context.checkAuthorization?.(options.database());
  }
  async function commandResult(context: AgentChatToolContext, command: Command, receipt: CommandReceipt): Promise<DocumentsFilesToolResult> {
    if (receipt.status !== 'committed') throw new DomainError(receipt.error?.code ?? 'agent_tool_rejected', receipt.error?.message ?? 'The native artifact command was rejected', receipt.httpStatus);
    const result = z.object({ artifact: z.object({ id: z.uuid(), version: z.number().int().positive() }), artifactVersion: z.object({ id: z.uuid() }).optional() }).parse(receipt.result);
    const artifacts: DocumentsFilesArtifact[] = [], versions: DocumentsFilesArtifactVersion[] = [];
    try { artifacts.push(artifact(await current(context, result.artifact.id, command.projectId!))); }
    catch (error) { if (!(error instanceof DomainError) || error.status !== 404) throw error; }
    if (result.artifactVersion) {
      try { versions.push(artifactVersion(await current(context, result.artifactVersion.id, command.projectId!))); }
      catch (error) { if (!(error instanceof DomainError) || error.status !== 404) throw error; }
    }
    await context.checkAuthorization?.(options.database());
    return { kind: 'artifact-mutation', artifacts, versions, ...fields, truncated: artifacts.some(item => item.totalVersions > item.versionRefs.length), receipt: { kind: 'command', operationId: context.operationId, commandId: receipt.commandId, action: command.commandType, targetId: result.artifact.id, revision: String(result.artifact.version), ...(context.linkage ? { linkage: context.linkage } : {}) } };
  }
  return {
    names: Object.keys(DocumentsFilesToolInputSchemas) as Name[],
    async execute(rawName, input, context) {
      const name = rawName as Name;
      assertAgentToolNotAborted(context);
      if ((mutationNames as readonly string[]).includes(name)) {
        const request = externalMutation(name as MutationName, input, context);
        return sourceOperation<DocumentsFilesToolResult>(context, true, async source => {
          const result = await mutateDocumentSource(source, { workspaceId: context.workspaceId, sourceId: request.sourceId }, request.input);
          if (result.status === 'unknown') throw new DomainError('document_source_operation_unknown', 'The original filesystem outcome is uncertain; reconcile this operation and do not repeat it', 503);
          if (result.status === 'not_applied') throw new DomainError('document_source_operation_not_applied', 'The original operation did not apply', 409);
          return operationResult(context, request.sourceId, result);
        });
      }
      if ((commandNames as readonly string[]).includes(name)) {
        await authorizeCommand(name as CommandName, input, context);
        const command = commandFor(name as CommandName, input, context);
        const receipt = await options.executeCommand(context.actor, context.workspaceId, command, async sql => { assertAgentToolNotAborted(context); await context.checkAuthorization?.(sql); });
        return commandResult(context, command, receipt);
      }
      if (name === 'pm_list_document_sources') {
        const args = parse(name, input);
        if (args.projectId) checkProject(context, args.projectId);
        return sourceOperation<DocumentsFilesToolResult>(context, false, async source => {
          const catalog = await listDocumentSources(source, context.workspaceId);
          const visible = (projectId: string | null) => args.projectId !== null ? projectId === args.projectId : projectId === null ? context.scope.kind === 'workspace' : context.scope.projectIds.includes(projectId);
          const sources = catalog.sources.filter(item => visible(item.projectId)), scopes = catalog.scopes.filter(item => visible(item.projectId));
          const end = args.offset + args.limit, more = Math.max(sources.length, scopes.length) > end;
          return { kind: 'document-sources', items: sources.slice(args.offset, end).map(({ path: _path, ...item }) => item), scopes: scopes.slice(args.offset, end), ...fields, nextCursor: more ? String(end) : null, truncated: more };
        }, false);
      }
      if (name === 'pm_configure_document_sources') {
        const args = parse(name, input); checkProject(context, args.projectId);
        if (context.scope.kind !== 'workspace') throw new DomainError('not_found_or_forbidden', 'Source association administration requires an explicit workspace target', 404);
        return sourceOperation<DocumentsFilesToolResult>(context, false, async source => {
          const { checkProject: _checkProject, ...catalogContext } = source;
          const catalog = await listDocumentSources(catalogContext, context.workspaceId);
          const paths = args.sourceIds.map(id => {
            const reference = catalog.sources.find(item => item.sourceId === id);
            if (!reference?.path || !reference.canManage || reference.status !== 'available') throw new DomainError('not_found_or_forbidden', 'An authorized manageable source reference is required', 404);
            checkProject(context, reference.projectId);
            return reference.path;
          });
          const result = await configureDocumentSources(source, context.workspaceId, { projectId: args.projectId, expectedRevision: args.expectedRevision, paths });
          return { kind: 'document-sources', items: result.sources.map(({ path: _path, ...item }) => item), scopes: [result.scope], ...fields };
        });
      }
      if (name === 'pm_list_external_files') {
        const args = parse(name, input);
        return sourceOperation<DocumentsFilesToolResult>(context, false, async source => {
          const result = await listDocumentSourceFiles(source, { workspaceId: context.workspaceId, sourceId: args.sourceId }, { limit: args.limit, ...(args.cursor ? { cursor: args.cursor } : {}) });
          return { kind: 'external-files', sourceId: args.sourceId, sourceRevision: result.sourceRevision, items: result.entries, scanComplete: result.scanComplete, issues: result.issues.slice(0, 100), ...fields, nextCursor: result.nextCursor, truncated: result.nextCursor !== null || !result.scanComplete || result.issues.length > 100 };
        });
      }
      if (name === 'pm_read_external_file') {
        const args = parse(name, input);
        return sourceOperation<DocumentsFilesToolResult>(context, false, async source => {
          const result = await readDocumentSourceContent(source, { workspaceId: context.workspaceId, sourceId: args.sourceId }, args.path);
          if (args.expectedRevision && args.expectedRevision !== result.revision) throw new DomainError('document_source_file_revision_conflict', 'The file changed; restart bounded reading at the new revision', 409);
          if (args.contentOffset > result.content.length) throw new DomainError('validation_failed', 'Content offset exceeds the current body length', 400);
          const slice = contentSlice(result, args.contentOffset, args.contentLimit);
          return { kind: 'external-file', sourceId: args.sourceId, items: [slice], ...fields, truncated: args.contentOffset > 0 || slice.nextContentOffset !== null };
        });
      }
      if (name === 'pm_external_file_result') {
        const args = parse(name, input);
        return sourceOperation<DocumentsFilesToolResult>(context, true, async source => operationResult(context, args.sourceId, await queryDocumentSourceMutation(source, { workspaceId: context.workspaceId, sourceId: args.sourceId }, args.operationId)));
      }
      if (name === 'pm_list_uploads' || name === 'pm_list_artifacts' || name === 'pm_list_artifact_versions') {
        const args = parse(name, input); checkProject(context, args.projectId);
        const kind = name === 'pm_list_uploads' ? 'upload' : name === 'pm_list_artifacts' ? 'artifact' : 'artifact_version';
        const page = await listEntities(options.database(), context.actor, context.workspaceId, { kind, projectId: args.projectId, limit: args.limit, ...(args.after ? { after: args.after } : {}), ...('visibility' in args ? { visibility: args.visibility } : {}) });
        await context.checkAuthorization?.(options.database());
        if (kind === 'upload') return { kind: 'uploads', items: page.items.map(upload), ...fields, nextCursor: page.nextCursor, truncated: page.nextCursor !== null };
        if (kind === 'artifact') return { kind: 'artifacts', items: page.items.map(artifact), ...fields, nextCursor: page.nextCursor, truncated: page.nextCursor !== null || page.items.some(item => item.data.title.length > 300 || item.data.versionRefs.length > 200) };
        return { kind: 'artifact-versions', items: page.items.map(artifactVersion), ...fields, nextCursor: page.nextCursor, truncated: page.nextCursor !== null };
      }
      if (name === 'pm_read_upload') {
        const args = parse(name, input); const item = upload(await current(context, args.uploadId, args.projectId));
        await context.checkAuthorization?.(options.database());
        return { kind: 'uploads', items: [item], ...fields };
      }
      if (name === 'pm_read_artifact') {
        const args = parse(name, input); const entity = await current(context, args.artifactId, args.projectId), item = artifact(entity);
        await context.checkAuthorization?.(options.database());
        return { kind: 'artifacts', items: [item], ...fields, truncated: entity.data.title.length > 300 || item.totalVersions > item.versionRefs.length };
      }
      if (name === 'pm_read_artifact_version') {
        const args = parse(name, input); const item = artifactVersion(await current(context, args.artifactVersionId, args.projectId));
        await context.checkAuthorization?.(options.database());
        return { kind: 'artifact-versions', items: [item], ...fields };
      }
      if (name === 'pm_artifact_copy_origin') {
        const args = parse(name, input);
        artifactVersion(await current(context, args.artifactVersionId, args.projectId));
        const result = await readArtifactCopyOrigin(options.database(), context.actor, context.workspaceId, args.artifactVersionId, sql => options.coreAccessFor(context.actor, context.workspaceId, sql));
        const origin = result.origin && context.scope.projectIds.includes(result.origin.sourceProjectId) ? result.origin : null;
        await context.checkAuthorization?.(options.database());
        return { kind: 'artifact-copy-origin', artifactVersionId: args.artifactVersionId, origin, ...fields };
      }
      throw new DomainError('agent_tool_not_available', 'This document/file tool is not registered', 403);
    },
    async recover(rawName, input, context) {
      const name = rawName as Name;
      if ((mutationNames as readonly string[]).includes(name)) {
        const request = externalMutation(name as MutationName, input, context), reference = { workspaceId: context.workspaceId, sourceId: request.sourceId };
        const hash = createHash('sha256').update(JSON.stringify({ reference, input: request.input })).digest('hex');
        return sourceOperation<DocumentsFilesToolResult | null>(context, false, async source => {
          const proof = await inspectDocumentSourceMutation(source, reference, { operationId: request.input.operationId, hash, action: request.input.action });
          if (proof === 'failed') throw new DomainError('agent_tool_recovered_rejection', 'The original filesystem operation was not applied; it was not replayed', 409);
          const result = await readDocumentSourceMutationResult(source, reference, request.input.operationId, { hash, action: request.input.action });
          if (!result || result.status === 'unknown') return null;
          if (result.status === 'not_applied') throw new DomainError('agent_tool_recovered_rejection', 'The original filesystem operation was not applied; it was not replayed', 409);
          return operationResult(context, request.sourceId, result);
        });
      }
      if ((commandNames as readonly string[]).includes(name)) {
        await authorizeCommand(name as CommandName, input, context);
        const command = commandFor(name as CommandName, input, context), receipt = await options.readCommandReceipt(context.actor, context.workspaceId, command);
        if (!receipt) return null;
        if (receipt.status !== 'committed') throw new DomainError('agent_tool_recovered_rejection', 'The original artifact command was rejected; it was not replayed', 409);
        return commandResult(context, command, receipt);
      }
      // Native source association configuration has CAS, not an original request receipt.
      return null;
    },
    recoveryIdentity(rawName, input, context) {
      const name = rawName as Name;
      if ((mutationNames as readonly string[]).includes(name)) {
        const request = externalMutation(name as MutationName, input, context), reference = { workspaceId: context.workspaceId, sourceId: request.sourceId };
        return { kind: 'document-source', commandId: request.input.operationId, hash: createHash('sha256').update(JSON.stringify({ reference, input: request.input })).digest('hex'), action: request.input.action, sourceId: request.sourceId };
      }
      if ((commandNames as readonly string[]).includes(name)) {
        const command = commandFor(name as CommandName, input, context);
        return { kind: 'command', commandId: command.commandId, action: command.commandType, hash: requestHash(command as unknown as Record<string, unknown>) };
      }
      return null;
    },
    async authorizeResult(rawName, input, rawResult, context) {
      const name = rawName as Name, result = DocumentsFilesToolResultSchema.parse(rawResult);
      const argumentsForTool = DocumentsFilesToolInputSchemas[name].parse(input);
      if ('projectId' in argumentsForTool && typeof argumentsForTool.projectId === 'string') {
        checkProject(context, argumentsForTool.projectId);
        await requireCapability(options.database(), context.actor, context.workspaceId, 'domain.read', argumentsForTool.projectId);
      }
      // Authorization only: never call execute/recover/reconciliation or compare
      // dynamic file bytes, display titles, upload expiry or current clock values.
      if (result.kind === 'document-sources') {
        if (name === 'pm_configure_document_sources') {
          const args = parse(name, input); checkProject(context, args.projectId);
          if (context.scope.kind !== 'workspace') throw new DomainError('not_found_or_forbidden', 'Source administration requires the current workspace scope', 404);
        }
        await sourceOperation(context, false, async source => {
          const catalog = await listDocumentSources(source, context.workspaceId);
          for (const item of result.items) {
            checkProject(context, item.projectId);
            const current = catalog.sources.find(candidate => candidate.sourceId === item.sourceId);
            if (!current || current.revision !== item.revision) throw new DomainError('not_found_or_forbidden', 'The historical source binding is no longer readable', 404);
            if (name === 'pm_configure_document_sources' && !current.canManage) throw new DomainError('not_found_or_forbidden', 'Source management authorization is no longer available', 404);
          }
          for (const item of result.scopes) {
            checkProject(context, item.projectId);
            const current = catalog.scopes.find(candidate => candidate.projectId === item.projectId);
            if (!current || name === 'pm_configure_document_sources' && !current.canManage) throw new DomainError('not_found_or_forbidden', 'The historical association scope is no longer readable', 404);
          }
        }, false);
      } else if (result.kind === 'external-files' || result.kind === 'external-file' || result.kind === 'external-file-operation') {
        await sourceOperation(context, false, async source => {
          if (result.kind === 'external-file-operation') {
            for (const operation of result.items) {
              const reference = { workspaceId: context.workspaceId, sourceId: result.sourceId };
              const request = (mutationNames as readonly string[]).includes(name) ? externalMutation(name as MutationName, input, context) : null;
              const original = await readDocumentSourceMutationResult(source, reference, operation.operationId, request ? {
                hash: createHash('sha256').update(JSON.stringify({ reference, input: request.input })).digest('hex'), action: request.input.action,
              } : undefined);
              if (!original || request && original.status !== 'succeeded' || operation.content && !original.content)
                throw new DomainError('not_found_or_forbidden', 'The original filesystem result is not currently readable', 404);
            }
          } else if (result.kind === 'external-file') {
            for (const item of result.items) {
              const address = await authorizeExternalDocumentHistory(source, { workspaceId: context.workspaceId, sourceId: result.sourceId, path: item.path });
              if (address.sourceRevision !== item.sourceRevision) throw new DomainError('not_found_or_forbidden', 'The historical source binding is no longer readable', 404);
            }
          } else {
            const page = await listDocumentSourceFiles(source, { workspaceId: context.workspaceId, sourceId: result.sourceId }, { limit: 1 });
            if (page.sourceRevision !== result.sourceRevision) throw new DomainError('not_found_or_forbidden', 'The historical source binding is no longer readable', 404);
            for (const item of result.items) await authorizeExternalDocumentHistory(source, { workspaceId: context.workspaceId, sourceId: result.sourceId, path: item.path });
          }
        });
      } else if (result.kind === 'uploads') {
        for (const item of result.items) upload(await current(context, item.id, item.projectId));
      } else if (result.kind === 'artifacts') {
        for (const item of result.items) artifact(await current(context, item.id, item.projectId));
      } else if (result.kind === 'artifact-versions') {
        for (const item of result.items) artifactVersion(await current(context, item.id, item.projectId));
      } else if (result.kind === 'artifact-mutation') {
        await authorizeCommand(name as CommandName, input, context);
        for (const item of result.artifacts) artifact(await current(context, item.id, item.projectId));
        for (const item of result.versions) artifactVersion(await current(context, item.id, item.projectId));
      } else if (result.kind === 'artifact-copy-origin') {
        const args = parse('pm_artifact_copy_origin', input);
        artifactVersion(await current(context, result.artifactVersionId, args.projectId));
        if (result.origin) {
          checkProject(context, result.origin.sourceProjectId);
          const currentOrigin = await readArtifactCopyOrigin(options.database(), context.actor, context.workspaceId, result.artifactVersionId, sql => options.coreAccessFor(context.actor, context.workspaceId, sql));
          if (!currentOrigin.origin) throw new DomainError('not_found_or_forbidden', 'The original copy provenance is no longer readable', 404);
        }
      }
      await context.checkAuthorization?.(options.database());
    },
    async inspectOutcome(identity, actorId, workspaceId) {
      const parsed = documentsFilesRecoveryIdentitySchema.safeParse(identity);
      if (!parsed.success) return { status: 'unknown', evidence: 'unresolved' };
      const context: AgentChatToolContext = { actor: { id: actorId, email: '', name: '' }, workspaceId, threadId: '', messageId: '', operationId: parsed.data.commandId, scope: { kind: 'workspace', projectIds: [] } };
      // Inspector has no content projection and uses native current membership for
      // both scopes. It never constructs a filesystem journal or writes receipts.
      const status = await sourceOperation(context, true, source => inspectDocumentSourceMutation(source, { workspaceId, sourceId: parsed.data.sourceId }, { operationId: parsed.data.commandId, hash: parsed.data.hash, action: parsed.data.action }), false).catch(() => 'unknown' as const);
      return { status, evidence: status === 'unknown' ? 'unresolved' : 'application_receipt' };
    },
  };
}
