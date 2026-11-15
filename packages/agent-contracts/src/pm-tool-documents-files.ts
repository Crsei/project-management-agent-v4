import { z } from 'zod';
import { agentChatToolResultFields } from './pm-tool-shared.ts';

const id = z.uuid();
const projectId = z.string().regex(/^PRJ-\d+$/);
const timestamp = z.iso.datetime({ offset: true });
const sourceId = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const source = z.strictObject({ sourceId, projectId: projectId.nullable(), name: z.string(), revision: z.number().int().positive(), status: z.enum(['available', 'unavailable']), canManage: z.boolean(), canWrite: z.boolean(), reason: z.string().optional() });
const scope = z.strictObject({ projectId: projectId.nullable(), name: z.string(), revision: z.number().int().nonnegative(), canManage: z.boolean() });
const content = z.strictObject({ path: z.string(), content: z.string().max(24000), size: z.number().int().nonnegative(), modifiedAt: timestamp, sourceRevision: z.number().int().positive(), revision: z.string(), canWrite: z.boolean(), contentOffset: z.number().int().nonnegative(), nextContentOffset: z.number().int().nonnegative().nullable() });
const operation = z.strictObject({ operationId: id, action: z.enum(['create', 'save', 'move', 'delete']), path: z.string(), status: z.enum(['succeeded', 'not_applied', 'unknown']), targetSourceId: sourceId.optional(), targetPath: z.string().optional(), content: content.optional(), message: z.string().optional() });
const entity = { id, workspaceId: id, projectId, version: z.number().int().positive() };
export const documentsFilesUploadSchema = z.strictObject({ ...entity, fileName: z.string().max(255), mediaType: z.string().max(127), sha256: digest, size: z.number().int().min(0).max(8 * 1024 * 1024), ownerId: id, expiresAt: timestamp, consumedAt: timestamp.nullable(), consumedByArtifactVersionId: id.nullable() });
export const documentsFilesArtifactSchema = z.strictObject({ ...entity, title: z.string().max(300), artifactKind: z.string().max(100), hiddenAt: timestamp.nullable(), hiddenBy: id.nullable(), versionRefs: z.array(id).max(200), totalVersions: z.number().int().nonnegative(), latestVersionId: id });
export const documentsFilesArtifactVersionSchema = z.strictObject({ ...entity, artifactId: id, uploadId: id, sha256: digest, contentDigest: digest, size: z.number().int().min(0).max(8 * 1024 * 1024), mediaType: z.string().max(127), fileName: z.string().max(255), producerId: id, downloadPath: z.string().regex(/^\/api\/v1\/workspaces\/[0-9a-f-]+\/artifact-versions\/[0-9a-f-]+\/content$/) });
export const DocumentsFilesToolResultSchema = z.union([
  z.strictObject({ kind: z.literal('document-sources'), items: z.array(source).max(100), scopes: z.array(scope).max(100), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('external-files'), sourceId, sourceRevision: z.number().int().positive(), items: z.array(z.strictObject({ fileKey: z.string(), path: z.string(), name: z.string(), size: z.number().int().nonnegative(), modifiedAt: timestamp })).max(100), scanComplete: z.boolean(), issues: z.array(z.strictObject({ path: z.string(), code: z.string() })).max(100), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('external-file'), sourceId, items: z.array(content).max(1), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('external-file-operation'), sourceId, items: z.array(operation).max(1), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('uploads'), items: z.array(documentsFilesUploadSchema).max(100), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('artifacts'), items: z.array(documentsFilesArtifactSchema).max(100), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('artifact-versions'), items: z.array(documentsFilesArtifactVersionSchema).max(100), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('artifact-mutation'), artifacts: z.array(documentsFilesArtifactSchema).max(1), versions: z.array(documentsFilesArtifactVersionSchema).max(1), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('artifact-copy-origin'), artifactVersionId: id, origin: z.strictObject({ sourceProjectId: projectId, sourceArtifactId: id, sourceArtifactVersionId: id, copiedAt: timestamp }).nullable(), ...agentChatToolResultFields }),
]);
export type DocumentsFilesToolResult = z.infer<typeof DocumentsFilesToolResultSchema>;
export type DocumentsFilesArtifact = z.infer<typeof documentsFilesArtifactSchema>;
export type DocumentsFilesArtifactVersion = z.infer<typeof documentsFilesArtifactVersionSchema>;
export type DocumentsFilesUpload = z.infer<typeof documentsFilesUploadSchema>;
