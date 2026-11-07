import { z } from 'zod';
import { documentSourceIdSchema } from '../../contracts/src/document-sources.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const externalDocumentHistoryAddressSchema = z.strictObject({
  sourceId: documentSourceIdSchema,
  path: z.string().min(1).max(4096),
  projectId: z.string().nullable(),
  sourceRevision: z.number().int().positive(),
  rootIdentity: digest,
  locationKey: digest,
});
export const externalDocumentHistorySnapshotSchema = z.strictObject({ content: z.string(), revision: digest });
export const externalDocumentHistoryPreparedSchema = z.strictObject({
  workspaceId: z.uuid(), actorId: z.uuid(), operationId: z.uuid(),
  action: z.enum(['create', 'save', 'move', 'delete']),
  source: externalDocumentHistoryAddressSchema,
  target: externalDocumentHistoryAddressSchema.optional(),
  before: externalDocumentHistorySnapshotSchema.nullable(),
  observedAt: z.iso.datetime(),
});
export type ExternalDocumentHistoryAddress = z.infer<typeof externalDocumentHistoryAddressSchema>;
export type ExternalDocumentHistorySnapshot = z.infer<typeof externalDocumentHistorySnapshotSchema>;
export type ExternalDocumentHistoryPrepared = z.infer<typeof externalDocumentHistoryPreparedSchema>;
export type ExternalDocumentHistoryCapture = Omit<ExternalDocumentHistoryPrepared, 'actorId' | 'operationId' | 'action'> & {
  actorId: string | null; operationId: string | null;
  action: ExternalDocumentHistoryPrepared['action'] | 'observe';
  after: ExternalDocumentHistorySnapshot | null;
};
