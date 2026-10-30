import { z } from 'zod';
import { documentSourceContentSchema, documentSourceFilesSchema, documentSourcePreviewInputSchema, documentSourcePreviewSchema, documentSourceResponseSchema, documentSourcesSchema, documentSourceUpdateSchema } from './document-sources.ts';

/** Source-of-truth for the standard contracts:generate pipeline. */
export function documentSourcePaths(): Record<string, Record<string, unknown>> {
  const workspace = { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
  const scope = { name: 'scopeKey', in: 'path', required: true, schema: { type: 'string', pattern: '^(workspace|PRJ-[0-9]+)$' } };
  const base = '/api/v1/workspaces/{workspaceId}/document-sources';
  function endpoint(operationId: string, output: z.ZodType, parameters: unknown[], input?: z.ZodType) {
    const schema = z.toJSONSchema(output, { io: 'output', target: 'draft-2020-12' }); delete schema.$schema;
    const failures = Object.fromEntries([400, 401, 403, 404, 409, 413, 422, 503].map(status => [status, {
      description: 'Existing PM error envelope. document_source_revision_conflict (409) has details.currentRevision: preserve input and GET before retrying. document_source_cursor_invalid (409) requires restarting pagination. document_source_overlap (409) rejects any known other-scope root overlap, including workspace parents containing project roots. document_source_unavailable (409) has details.reason and never falls back/recreates. document_source_path_forbidden (403) rejects unsafe paths, links and special files. Missing content is document_source_file_not_found (404); document_source_file_too_large (413) has details.maxBytes; invalid UTF-8 is document_source_encoding_invalid (422).',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
    }]));
    return { operationId, security: [{ sessionCookie: [] }, { bearerAuth: [] }], parameters,
      description: 'Read-only external Markdown source, independent of Agent cwd and native PM documents. Requires current domain.read plus exact scope; project-only members cannot read workspace sources. Host paths require existing unrestricted access.manage, configuration/preview additionally planning.edit. Only existing trusted readable directories are accepted; no writes to source bytes or mkdir. One root per scope; CAS starts at revision 0, every save/unlink increments and persists the revision. Null path clears only the mapping. A configured source may return path:null to ordinary readers without being unconfigured. Linux descriptor-relative traversal rejects symlinks in every component, hard links, special files, private application directories and other registered scope overlaps on every request. Recursion includes all ordinary case-insensitive .md files without PM frontmatter. Limits: 100000 visited entries, depth 128, 1000 detailed issues plus an issue_limit marker; every exclusion/failure is reported with scanComplete:false. Content is bounded to the existing 4 MiB limit, never silently truncated. Cursor binds workspace/project, source revision and a fresh disk metadata fingerprint: refresh on any invalid cursor. Responses are private/no-store. SQL configuration is included in the existing stopped database backup; external source bytes remain external and are not copied or relocated by backup/restore.',
      ...(input ? { requestBody: { required: true, content: { 'application/json': { schema: z.toJSONSchema(input, { io: 'input', target: 'draft-2020-12' }) } } } } : {}),
      responses: { 200: { description: 'Current authorized source or read-only disk content. Private, no-store.', content: { 'application/json': { schema } } }, ...failures },
    };
  }
  return {
    [base]: { get: endpoint('listDocumentSources', documentSourcesSchema, [workspace]) },
    [`${base}/preview`]: { post: endpoint('previewDocumentSource', documentSourcePreviewSchema, [workspace], documentSourcePreviewInputSchema) },
    [`${base}/{scopeKey}`]: { put: endpoint('saveDocumentSource', documentSourceResponseSchema, [workspace, scope], documentSourceUpdateSchema) },
    [`${base}/{scopeKey}/files`]: { get: endpoint('listDocumentSourceFiles', documentSourceFilesSchema, [workspace, scope,
      { name: 'cursor', in: 'query', schema: { type: 'string', maxLength: 2048 } },
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000, default: 200 } },
    ]) },
    [`${base}/{scopeKey}/content`]: { get: endpoint('readDocumentSourceContent', documentSourceContentSchema, [workspace, scope,
      { name: 'path', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 4096 }, description: 'Encoded POSIX relative Markdown path, never an absolute root.' },
    ]) },
  };
}
