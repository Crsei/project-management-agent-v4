import { z } from 'zod';

export const workspaceCreationRequestSchema = z.strictObject({ name: z.string().trim().min(1).max(200), expectedActorId: z.uuid() });
export const workspaceCreationRecoveryRequestSchema = z.strictObject({ expectedActorId: z.uuid() });
export const workspaceCreationKeySchema = z.uuid();
export type WorkspaceCreationRequest = z.infer<typeof workspaceCreationRequestSchema>;
export type WorkspaceCreationRecoveryRequest = z.infer<typeof workspaceCreationRecoveryRequestSchema>;
export const workspaceCreationResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('not_found') }),
  z.strictObject({ status: z.literal('pending'), key: z.uuid(), workspaceId: z.uuid() }),
  z.strictObject({ status: z.literal('ready'), key: z.uuid(), workspaceId: z.uuid(), sampleProjectId: z.string().regex(/^PRJ-\d+$/) }),
]);
export type WorkspaceCreationResult = z.infer<typeof workspaceCreationResultSchema>;
export type WorkspaceInitialization = { workspaceId: string; name: string; key: string | null };
