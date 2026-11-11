import { z } from "zod";

/** Server-attested correlation, never a permission or an idempotency key. */
export const pmToolLinkageSchema = z.strictObject({
  traceId: z.uuid(), invocationId: z.uuid(),
  executionRoot: z.enum(["generation", "external"]),
  inputMessageId: z.string().min(1).max(200).optional(),
  executionGrantId: z.uuid().optional(),
  clientKind: z.enum(["chat", "mcp", "cli", "plugin", "automation", "api"]),
  policy: z.literal("full"), enforcement: z.literal("audit-only"),
});
export type PmToolLinkage = z.infer<typeof pmToolLinkageSchema>;
