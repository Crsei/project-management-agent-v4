import { z } from 'zod';
import { documentSourceConfigurationInputSchema, documentSourceConfigurationResponseSchema, documentSourceContentSchema, documentSourceDirectoriesSchema, documentSourceFilesSchema, documentSourceMutationReceiptSchema, documentSourceMutationSchema, documentSourcesSchema } from './document-sources.ts';

/** Source-of-truth for the standard contracts:generate pipeline. */
export function documentSourcePaths(): Record<string, Record<string, unknown>> {
  const workspace = { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
  const source = { name: 'sourceId', in: 'path', required: true, schema: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9_-]+$' } };
  const base = '/api/v1/workspaces/{workspaceId}/document-sources';
  function endpoint(operationId: string, output: z.ZodType, parameters: unknown[], input?: z.ZodType) {
    const schema = z.toJSONSchema(output, { io: 'output', target: 'draft-2020-12' }); delete schema.$schema;
    const failures = Object.fromEntries([400, 401, 403, 404, 409, 413, 422, 503].map(status => [status, {
      description: 'Existing PM error envelope. document_source_revision_conflict (409) identifies a stale association-set or source revision; document_source_file_revision_conflict (409) identifies stale file content. document_source_collision (409) never overwrites a destination. document_source_same_path (409) rejects moving a physical file onto itself through any alias. document_source_operation_id_conflict (409) rejects reuse with different parameters; document_source_operation_pending (409) blocks overlapping physical writes across all source aliases/workspaces until the owner reconciles an earlier uncertain operation. document_source_operation_not_found (404) is not proof of no filesystem effect and must not trigger blind replay. document_source_cursor_invalid (409) requires restarting pagination. document_source_overlap (409) rejects equal/ancestor/descendant paths within the same association scope only. Unsafe/private paths, symlinks, hardlinks, special files, replaced directories, invalid UTF-8 and oversized files remain rejected.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
    }]));
    return { operationId, security: [{ sessionCookie: [] }, { bearerAuth: [] }], parameters,
      description: 'External Markdown sources are independent of Agent cwd and native PM documents. Source IDs are opaque workspace-scoped identities, never project selectors. Current domain.read plus the stored association scope is required; planning.edit additionally authorizes content mutations and owner-only original-operation queries. Host paths, configuration and directory browsing require unrestricted access.manage plus planning.edit and domain.read. Configuration atomically saves a whole scope association set with expectedRevision, including an empty set. Existing empty directories are valid; this API never creates roots. Identical confirmed paths retain IDs and source revisions; removals only tombstone associations and never delete bytes or operation recovery. Cross-scope/workspace sharing of safe roots is permitted, but does not grant other PM access or implicitly expose unauthorized registered subtrees. fileKey identifies the canonical absolute file location without disclosing it and is scoped to the current workspace. Directory identity, trusted roots and current permissions are checked on each request. Mutations are not automatically retried. Unknown operation outcomes require querying the original operation ID; operation requests and durable proof hashes survive the multi-source migration.',
      ...(input ? { requestBody: { required: true, content: { 'application/json': { schema: z.toJSONSchema(input, { io: 'input', target: 'draft-2020-12' }) } } } } : {}),
      responses: { 200: { description: 'Current authorized catalog/configuration/content or original mutation receipt. Private, no-store. Only not_applied authoritatively permits an explicit new attempt; unknown must never be blindly retried. An uncertain configuration save is resolved by reading the catalog and comparing its scope revision and exact desired path set.', content: { 'application/json': { schema } } }, ...failures },
    };
  }
  return {
    [base]: { get: endpoint('listDocumentSources', documentSourcesSchema, [workspace]) },
    [`${base}/configuration`]: { put: endpoint('configureDocumentSources', documentSourceConfigurationResponseSchema, [workspace], documentSourceConfigurationInputSchema) },
    [`${base}/directories`]: { get: endpoint('listDocumentSourceDirectories', documentSourceDirectoriesSchema, [workspace,
      { name: 'path', in: 'query', schema: { type: 'string', minLength: 1, maxLength: 4096 }, description: 'Existing trusted absolute server directory; omit to list selectable roots.' },
      { name: 'projectId', in: 'query', schema: { type: 'string', pattern: '^PRJ-[0-9]+$' }, description: 'Selected association project; omit for workspace-common documents.' },
    ]) },
    [`${base}/{sourceId}/files`]: { get: endpoint('listDocumentSourceFiles', documentSourceFilesSchema, [workspace, source,
      { name: 'cursor', in: 'query', schema: { type: 'string', maxLength: 2048 } },
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000, default: 200 } },
    ]) },
    [`${base}/{sourceId}/content`]: { get: endpoint('readDocumentSourceContent', documentSourceContentSchema, [workspace, source,
      { name: 'path', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 4096 }, description: 'Encoded POSIX relative Markdown path, never an absolute root.' },
    ]) },
    [`${base}/{sourceId}/operations`]: { post: endpoint('mutateDocumentSource', documentSourceMutationReceiptSchema, [workspace, source], documentSourceMutationSchema) },
    [`${base}/{sourceId}/operations/{operationId}`]: { get: endpoint('queryDocumentSourceMutation', documentSourceMutationReceiptSchema, [workspace, source,
      { name: 'operationId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
    ]) },
  };
}
