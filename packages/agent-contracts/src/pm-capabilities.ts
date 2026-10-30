import { z } from "zod";

export const pmToolCapabilitySchema = z.strictObject({
  name: z.string().min(1),
  description: z.string(),
  write: z.boolean(),
  capabilities: z.array(z.string()),
  allowed: z.boolean(),
  denyReason: z.string().nullable(),
});
export type PmToolCapability = z.infer<typeof pmToolCapabilitySchema>;

export const pmToolCapabilitiesSchema = z.strictObject({
  scope: z.strictObject({
    kind: z.enum(["workspace", "projects"]),
    projectIds: z.array(z.string()).max(1000),
  }),
  tools: z.array(pmToolCapabilitySchema),
});
export type PmToolCapabilities = z.infer<typeof pmToolCapabilitiesSchema>;
