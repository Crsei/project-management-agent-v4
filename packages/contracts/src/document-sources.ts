import { z } from 'zod';

export const documentSourceScopeSchema = z.strictObject({ workspaceId: z.uuid().toLowerCase(), projectId: z.string().regex(/^PRJ-\d+$/).nullable() });
export type DocumentSourceScope = z.infer<typeof documentSourceScopeSchema>;
export const documentSourceScopeKeySchema = z.union([z.literal('workspace'), z.string().regex(/^PRJ-\d+$/)]);
export const documentSourceSchema = z.strictObject({
  projectId: z.string().regex(/^PRJ-\d+$/).nullable(), name: z.string(), path: z.string().nullable(),
  revision: z.number().int().nonnegative(), status: z.enum(['unconfigured', 'available', 'unavailable']),
  canManage: z.boolean(), reason: z.string().optional(),
});
export type DocumentSource = z.infer<typeof documentSourceSchema>;
export const documentSourcesSchema = z.strictObject({ sources: z.array(documentSourceSchema) });
export const documentSourcePreviewInputSchema = z.strictObject({ projectId: z.string().regex(/^PRJ-\d+$/).nullable(), path: z.string().min(1).max(4096) });
export type DocumentSourcePreviewInput = z.infer<typeof documentSourcePreviewInputSchema>;
export const documentSourcePreviewSchema = z.strictObject({ path: z.string(), readable: z.literal(true) });
export const documentSourceUpdateSchema = z.strictObject({ path: z.string().min(1).max(4096).nullable(), expectedRevision: z.number().int().nonnegative().max(2147483646) });
export type DocumentSourceUpdate = z.infer<typeof documentSourceUpdateSchema>;
export const documentSourceResponseSchema = z.strictObject({ source: documentSourceSchema });
export const documentSourceEntrySchema = z.strictObject({ path: z.string(), name: z.string(), size: z.number().int().nonnegative(), modifiedAt: z.iso.datetime() });
export type DocumentSourceEntry = z.infer<typeof documentSourceEntrySchema>;
export const documentSourceIssueSchema = z.strictObject({ path: z.string(), code: z.string() });
export type DocumentSourceIssue = z.infer<typeof documentSourceIssueSchema>;
export const documentSourceFilesSchema = z.strictObject({
  entries: z.array(documentSourceEntrySchema), nextCursor: z.string().nullable(), scanComplete: z.boolean(),
  issues: z.array(documentSourceIssueSchema), sourceRevision: z.number().int().nonnegative(),
});
export type DocumentSourceFiles = z.infer<typeof documentSourceFilesSchema>;
export const documentSourceContentSchema = z.strictObject({ path: z.string(), content: z.string(), size: z.number().int().nonnegative(), modifiedAt: z.iso.datetime(), sourceRevision: z.number().int().nonnegative() });
export type DocumentSourceContent = z.infer<typeof documentSourceContentSchema>;
export const documentSourceFilesQuerySchema = z.strictObject({ cursor: z.string().min(1).max(2048).optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) });
export type DocumentSourceFilesQuery = { cursor?: string; limit?: number };
export const documentSourceContentQuerySchema = z.strictObject({ path: z.string().min(1).max(4096) });
