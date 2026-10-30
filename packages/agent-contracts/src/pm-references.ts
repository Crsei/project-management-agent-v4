import { z } from "zod";

export const pmReferenceKindSchema = z.enum(["issue", "project", "document"]);
export type PmReferenceKind = z.infer<typeof pmReferenceKindSchema>;

export const pmReferenceInputSchema = z.strictObject({
  kind: pmReferenceKindSchema,
  id: z.string().trim().min(1).max(200),
  projectId: z.string().regex(/^PRJ-\d+$/).nullable(),
  /** Selected revision; null means no pin and the server returns the current one. */
  revision: z.string().trim().min(1).max(200).nullable(),
});
export type PmReferenceInput = z.infer<typeof pmReferenceInputSchema>;

export const pmReferenceAvailabilitySchema = z.enum(["available", "stale", "forbidden", "deleted"]);
export type PmReferenceAvailability = z.infer<typeof pmReferenceAvailabilitySchema>;

export const pmReferenceResolutionSchema = z.strictObject({
  kind: pmReferenceKindSchema,
  id: z.string().min(1),
  projectId: z.string().nullable(),
  title: z.string(),
  revision: z.string().nullable(),
  availability: pmReferenceAvailabilitySchema,
  reason: z.string().nullable(),
});
export type PmReferenceResolution = z.infer<typeof pmReferenceResolutionSchema>;

export const pmReferenceResolveRequestSchema = z.strictObject({
  references: z.array(pmReferenceInputSchema).min(1).max(50),
});
export type PmReferenceResolveRequest = z.infer<typeof pmReferenceResolveRequestSchema>;

export const pmReferenceResolveResponseSchema = z.strictObject({
  items: z.array(pmReferenceResolutionSchema),
});
export type PmReferenceResolveResponse = z.infer<typeof pmReferenceResolveResponseSchema>;
