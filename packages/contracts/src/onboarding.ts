import { z } from 'zod';

const acknowledgement = z.enum(['pending', 'reviewed', 'skipped']);
export const onboardingStateSchema = z.strictObject({
  actorId: z.uuid(), revision: z.number().int().nonnegative(), workspaceId: z.uuid().nullable(),
  profile: acknowledgement, ai: acknowledgement, completedAt: z.iso.datetime().nullable(), checklistDismissed: z.boolean(),
});
export const updateOnboardingRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ expectedActorId: z.uuid(), expectedRevision: z.number().int().nonnegative(), action: z.literal('select-workspace'), workspaceId: z.uuid() }),
  ...(['review-profile', 'skip-profile', 'review-ai', 'skip-ai', 'finish', 'dismiss-checklist'] as const).map(action =>
    z.strictObject({ expectedActorId: z.uuid(), expectedRevision: z.number().int().nonnegative(), action: z.literal(action) })),
]);
export type OnboardingState = z.infer<typeof onboardingStateSchema>;
export type UpdateOnboardingRequest = z.infer<typeof updateOnboardingRequestSchema>;
