import { z } from "zod";

export const pmChangeKindSchema = z.enum([
  "create",
  "update",
  "delete",
  "archive",
  "status",
  "comment",
  "relation",
]);
export type PmChangeKind = z.infer<typeof pmChangeKindSchema>;

export const pmChangeStateSchema = z.enum([
  "proposed",
  "approved",
  "queued",
  "running",
  "applied",
  "failed",
  "conflict",
  "unknown",
  "reverted",
]);
export type PmChangeState = z.infer<typeof pmChangeStateSchema>;

export const pmChangeFieldSchema = z.strictObject({
  field: z.string().min(1),
  label: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
});
export type PmChangeField = z.infer<typeof pmChangeFieldSchema>;

export const pmChangeSetSchema = z.strictObject({
  id: z.string().min(1),
  kind: pmChangeKindSchema,
  state: pmChangeStateSchema,
  targetId: z.string().nullable(),
  targetTitle: z.string().nullable(),
  projectId: z.string().nullable(),
  summary: z.string(),
  fields: z.array(pmChangeFieldSchema).optional(),
  receiptId: z.string().nullable().optional(),
  commandId: z.string().nullable().optional(),
  error: z.object({ code: z.string().nullable().optional(), message: z.string() }).nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
});
export type PmChangeSet = z.infer<typeof pmChangeSetSchema>;
