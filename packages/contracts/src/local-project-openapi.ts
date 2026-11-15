import { z } from 'zod';
import { localProjectInitializationSchema, localProjectMoveSchema, localProjectRelocationSchema, localProjectPreviewSchema, localProjectSettingsUpdateSchema } from './local-projects.ts';

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
const nullableString = { type: ['string', 'null'] };
const strings = { type: 'array', items: string };
const location = object({ projectId: string, storageId: nullableString, kind: { enum: ['local', 'legacy'] }, path: nullableString, status: { enum: ['available', 'unavailable'] }, reason: string }, ['projectId', 'storageId', 'kind', 'path', 'status']);
const record = { type: 'object', required: ['id', 'path', 'raw', 'revision', 'entity'], properties: { id: string, path: string, raw: string, revision: string, entity: { type: 'object', additionalProperties: true } }, additionalProperties: true };
const operation = { enum: ['initialize', 'migrate', 'relocate'] };
const attempt = { oneOf: [
  object({ status: { const: 'not_found' } }),
  object({ status: { const: 'pending' }, key: string, operation, reason: { enum: ['write_unconfirmed', 'audit_pending', 'storage_pending'] }, projectId: string }, ['status', 'key', 'operation', 'reason']),
  object({ status: { const: 'rejected' }, key: string, operation, code: string }),
  object({ status: { const: 'ready' }, key: string, operation, record, location }),
] };
const settings = object({ enabled: { type: 'boolean' }, reason: { enum: ['not_configured', null] }, canManage: { type: 'boolean' }, dataRoot: nullableString, coreRoot: nullableString, defaultParent: nullableString, allowedRoots: strings, unrestricted: { type: 'boolean' }, backupRoot: nullableString, attachments: { const: 'project_directory' }, databaseRequired: { const: true } });
const listing = object({ path: nullableString, parentPath: nullableString, roots: strings, directories: { type: 'array', items: object({ name: string, path: string }) } });
const directory = { oneOf: [
  object({ mode: { const: 'existing' }, path: string }),
  object({ mode: { const: 'new' }, parentPath: string, folderName: string }),
  object({ mode: { const: 'auto' }, path: string }),
] };
const preview = object({ path: string, exists: { type: 'boolean' }, mode: { enum: ['existing', 'new'] }, directory, creates: strings, preservesExistingFiles: { const: true } });
const probe = object({ path: string, exists: { type: 'boolean' }, directory, marker: { oneOf: [{ type: 'null' }, object({ version: { const: 1 }, layout: { enum: ['dovspace-v1', 'legacy'] }, workspaceId: string, projectId: string, storageId: string })] }, markerProblem: { enum: ['missing_marker', 'invalid_marker', null] }, project: { oneOf: [{ type: 'null' }, object({ projectId: string, title: string, locationStatus: { enum: ['available', 'unavailable'] } })] }, problem: { enum: ['foreign_workspace', 'unknown_project', null] } });
const json = (schema: unknown) => ({ 'application/json': { schema } });

/** Self-contained path schemas; importing this does not load any server or filesystem implementation. */
export function localProjectPaths(): Record<string, Record<string, unknown>> {
  const workspace = { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
  const project = { name: 'projectId', in: 'path', required: true, schema: { type: 'string', pattern: '^PRJ-\\d+$' } };
  const key = { name: 'key', in: 'path', required: true, schema: { type: 'string', minLength: 1, maxLength: 512 } };
  const header = { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 1, maxLength: 512 } };
  const failures = Object.fromEntries([400, 401, 403, 404, 409, 422, 500, 503].map(status => [status, { description: 'Authorized validation, storage, or recoverable uncertainty error. Retain the original request/key. No automatic retry.', content: json({ oneOf: [{ $ref: '#/components/schemas/ErrorResponse' }, { type: 'object', properties: { error: string, diagnostics: { type: 'array', items: { type: 'object' } } }, required: ['error', 'diagnostics'] }] }) }]));
  const endpoint = (operationId: string, output: unknown, parameters: unknown[], input?: z.ZodType) => ({ operationId, security: [{ sessionCookie: [] }, { bearerAuth: [] }], parameters: [workspace, ...parameters], description: 'Authenticated session and Origin policy apply. Host paths require unrestricted access.manage; writes additionally require planning.edit. Settings and project location redact paths for other authorized readers. Project storage is not root-restricted; canonical absolute paths, symlink/reparse refusal and system-directory refusal still apply. Agent file areas and document sources keep their separately configured roots. Initialization preserves native creation facts, not command receipts. Recover only the original identity; not_found or pending never permits replacing the key. Storage moves require explicit external-writers-stopped acknowledgement and retain a durable project fence until verified recovery.', ...(input ? { requestBody: { required: true, content: json(z.toJSONSchema(input, { unrepresentable: 'any' })) } } : {}), responses: { 200: { description: 'Authorized current result; pending remains unresolved.', content: json(output) }, ...failures } });
  const base = '/api/v1/workspaces/{workspaceId}/local-projects';
  return {
    [base + '/settings']: { get: endpoint('getLocalProjectSettings', settings, []), put: endpoint('saveLocalProjectSettings', settings, [], localProjectSettingsUpdateSchema) },
    [base + '/directories']: { get: endpoint('listLocalProjectDirectories', listing, [{ name: 'path', in: 'query', required: false, schema: { type: 'string', maxLength: 4096 } }]) },
    [base + '/probe']: { post: endpoint('probeLocalProjectPath', probe, [], z.strictObject({ path: z.string().min(1).max(4096) })) },
    [base + '/preview']: { post: endpoint('previewLocalProject', preview, [], localProjectPreviewSchema) },
    [base + '/initializations']: { post: endpoint('initializeLocalProject', attempt, [header], localProjectInitializationSchema) },
    [base + '/initializations/{key}']: { get: endpoint('getLocalProjectInitialization', attempt, [key]) },
    [base + '/initializations/{key}/recover']: { post: endpoint('recoverLocalProjectInitialization', attempt, [key], z.strictObject({})) },
    [base + '/projects/{projectId}/location']: { get: endpoint('getLocalProjectLocation', location, [project]) },
    [base + '/projects/{projectId}/migrate']: { post: endpoint('migrateLocalProject', attempt, [project, header], localProjectMoveSchema) },
    [base + '/projects/{projectId}/relocate']: { post: endpoint('relocateLocalProject', attempt, [project, header], localProjectRelocationSchema) },
  };
}
