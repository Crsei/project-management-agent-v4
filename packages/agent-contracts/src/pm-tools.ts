import { z } from "zod";
import { pmChangeSetSchema } from "./pm-changes.ts";
import { agentChatToolResultSchema } from "./pm-tool-result.ts";

/** PM owns the business result payload; Chat owns its presentation record. */
export const pmToolCallRecordSchema = z.object({
  operationId: z.uuid(), name: z.string().min(1),
  status: z.enum(["pending_approval", "running", "succeeded", "failed", "unknown"]),
  result: agentChatToolResultSchema.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  threadId: z.string(), messageId: z.string(), generationId: z.string(), workspaceId: z.string(),
  createdAt: z.string(), finishedAt: z.string().nullable(),
  /** The validated tool input, when the producer exposes it; older records omit it. */
  arguments: z.unknown().optional(),
  /** Change details supplied by the producer; consumers must never infer missing values. */
  changeSet: pmChangeSetSchema.optional(),
});
export type PmToolCallRecord = z.infer<typeof pmToolCallRecordSchema>;
