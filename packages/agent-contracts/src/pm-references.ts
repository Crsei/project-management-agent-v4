import { z } from "zod";

export const pmReferenceKindSchema = z.enum(["issue", "project", "document"]);
export type PmReferenceKind = z.infer<typeof pmReferenceKindSchema>;

export const pmReferenceInputSchema = z.strictObject({
  workspaceId: z.uuid().toLowerCase(),
  kind: pmReferenceKindSchema,
  id: z.string().trim().min(1).max(200),
  projectId: z.string().regex(/^PRJ-\d+$/).nullable(),
  /** Null selects current metadata at admission; a non-null revision must still match. Never a historical body selector. */
  revision: z.string().trim().min(1).max(200).nullable(),
});
export type PmReferenceInput = z.infer<typeof pmReferenceInputSchema>;

export const pmReferenceAvailabilitySchema = z.enum(["available", "stale", "forbidden", "deleted"]);
export type PmReferenceAvailability = z.infer<typeof pmReferenceAvailabilitySchema>;

export const pmReferenceResolutionSchema = z.strictObject({
  workspaceId: z.uuid().toLowerCase(),
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

/** Server-accepted reference metadata, not a PM document/body snapshot or authority grant. */
export const turnContextSchema = z.strictObject({
  version: z.literal(1),
  threadId: z.string().min(1).max(256),
  /** Accepted input USER message; never the generation's assistant output messageId. */
  messageId: z.string().min(1).max(256),
  acceptedAt: z.iso.datetime(),
  pmReferences: z.array(pmReferenceResolutionSchema).max(50),
  executionGrantId: z.uuid().optional(),
});
export type TurnContext = z.infer<typeof turnContextSchema>;

/** Informational execution binding; existing authentication, leases and PM checks remain authoritative. */
export const executionPolicySchema = z.strictObject({
  access: z.literal("full"),
  mode: z.literal("audit-only"),
  notice: z.string(),
});
export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;
