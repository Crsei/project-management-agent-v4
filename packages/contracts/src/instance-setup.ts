import { z } from 'zod';

/** Shared strict validators for the HTTP adapter, client types and OpenAPI. */
export const setupTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/).meta({ writeOnly: true });
export const setupRequestSchema = z.strictObject({
  setupToken: setupTokenSchema,
  email: z.email().max(254),
  password: z.string().min(12).max(256).meta({ writeOnly: true }),
  name: z.string().trim().min(1).max(200),
  workspaceName: z.string().trim().min(1).max(200),
});
export const instanceSetupStatusSchema = z.strictObject({
  initialized: z.boolean(), setupAllowed: z.boolean(), registrationMode: z.literal('invite_only'),
});
export const setupResponseSchema = z.strictObject({
  actor: z.strictObject({ id: z.uuid(), email: z.string(), name: z.string() }),
  workspaceId: z.uuid(), expiresAt: z.iso.datetime(),
});
export type InstanceSetupStatus = z.infer<typeof instanceSetupStatusSchema>;
export type SetupRequest = z.infer<typeof setupRequestSchema>;
export type SetupResponse = z.infer<typeof setupResponseSchema>;
export const instanceSetupSchemas = {
  InstanceSetupStatus: instanceSetupStatusSchema, SetupRequest: setupRequestSchema, SetupResponse: setupResponseSchema,
};
