import { z } from 'zod';

const projectId = z.string().regex(/^PRJ-\d+$/);
export const documentSourceScopeSchema = z.strictObject({ workspaceId: z.uuid().toLowerCase(), projectId: projectId.nullable() });
export type DocumentSourceScope = z.infer<typeof documentSourceScopeSchema>;
export const documentSourceIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
export const documentSourceReferenceSchema = z.strictObject({ workspaceId: z.uuid().toLowerCase(), sourceId: documentSourceIdSchema });
export type DocumentSourceReference = z.infer<typeof documentSourceReferenceSchema>;
export const documentSourceSchema = z.strictObject({
  sourceId: documentSourceIdSchema, projectId: projectId.nullable(), name: z.string(), path: z.string().nullable(),
  revision: z.number().int().positive(), status: z.enum(['available', 'unavailable']),
  canManage: z.boolean(), canWrite: z.boolean(), reason: z.string().optional(),
});
export type DocumentSource = z.infer<typeof documentSourceSchema>;
export const documentSourceAssociationScopeSchema = z.strictObject({
  projectId: projectId.nullable(), name: z.string(), revision: z.number().int().nonnegative(), canManage: z.boolean(),
});
export type DocumentSourceAssociationScope = z.infer<typeof documentSourceAssociationScopeSchema>;
export const documentSourcesSchema = z.strictObject({ sources: z.array(documentSourceSchema), scopes: z.array(documentSourceAssociationScopeSchema) });
export type DocumentSources = z.infer<typeof documentSourcesSchema>;
export const documentSourceConfigurationInputSchema = z.strictObject({
  projectId: projectId.nullable(), expectedRevision: z.number().int().nonnegative().max(2147483646), paths: z.array(z.string().min(1).max(4096)),
});
export type DocumentSourceConfigurationInput = z.infer<typeof documentSourceConfigurationInputSchema>;
export const documentSourceConfigurationResponseSchema = z.strictObject({ scope: documentSourceAssociationScopeSchema, sources: z.array(documentSourceSchema) });
export type DocumentSourceConfigurationResponse = z.infer<typeof documentSourceConfigurationResponseSchema>;
export const documentSourceDirectoriesQuerySchema = z.strictObject({ path: z.string().min(1).max(4096).optional(), projectId: projectId.optional() });
export const documentSourceDirectoriesSchema = z.strictObject({
  path: z.string().nullable(), parentPath: z.string().nullable(), roots: z.array(z.string()), directories: z.array(z.strictObject({ name: z.string(), path: z.string() })),
});
export const documentSourceEntrySchema = z.strictObject({ fileKey: z.string().min(1), path: z.string(), name: z.string(), size: z.number().int().nonnegative(), modifiedAt: z.iso.datetime() });
export type DocumentSourceEntry = z.infer<typeof documentSourceEntrySchema>;
export const documentSourceIssueSchema = z.strictObject({ path: z.string(), code: z.string() });
export type DocumentSourceIssue = z.infer<typeof documentSourceIssueSchema>;
export const documentSourceFilesSchema = z.strictObject({
  entries: z.array(documentSourceEntrySchema), nextCursor: z.string().nullable(), scanComplete: z.boolean(),
  issues: z.array(documentSourceIssueSchema), sourceRevision: z.number().int().positive(),
});
export type DocumentSourceFiles = z.infer<typeof documentSourceFilesSchema>;
export const documentSourceContentSchema = z.strictObject({ path: z.string(), content: z.string(), size: z.number().int().nonnegative(), modifiedAt: z.iso.datetime(), sourceRevision: z.number().int().positive(), revision: z.string().min(1), canWrite: z.boolean() });
export type DocumentSourceContent = z.infer<typeof documentSourceContentSchema>;
export const documentSourceFilesQuerySchema = z.strictObject({ cursor: z.string().min(1).max(2048).optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) });
export type DocumentSourceFilesQuery = { cursor?: string; limit?: number };
export const documentSourceContentQuerySchema = z.strictObject({ path: z.string().min(1).max(4096) });
const mutationBase = { operationId: z.uuid().toLowerCase(), sourceRevision: z.number().int().positive(), path: z.string().min(1).max(4096) };
const content = z.string().max(4 * 1024 * 1024);
export const documentSourceMutationSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...mutationBase, action: z.literal('create'), content }),
  z.strictObject({ ...mutationBase, action: z.literal('save'), expectedRevision: z.string().min(1).max(256), content }),
  z.strictObject({ ...mutationBase, action: z.literal('move'), expectedRevision: z.string().min(1).max(256), targetSourceId: documentSourceIdSchema, targetSourceRevision: z.number().int().positive(), targetPath: z.string().min(1).max(4096) }),
  z.strictObject({ ...mutationBase, action: z.literal('delete'), expectedRevision: z.string().min(1).max(256) }),
]);
export type DocumentSourceMutation = z.infer<typeof documentSourceMutationSchema>;
export const documentSourceMutationReceiptSchema = z.strictObject({
  operationId: z.uuid(), action: z.enum(['create', 'save', 'move', 'delete']), path: z.string(),
  status: z.enum(['succeeded', 'not_applied', 'unknown']), targetSourceId: documentSourceIdSchema.optional(),
  targetPath: z.string().optional(), content: documentSourceContentSchema.optional(), message: z.string().optional(),
});
export type DocumentSourceMutationReceipt = z.infer<typeof documentSourceMutationReceiptSchema>;
