import { z } from 'zod';

export const registerRequestSchema = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  name: z.string().trim().min(1).max(200),
  password: z.string().min(12).max(256).meta({ writeOnly: true }),
});
export const registerResponseSchema = z.strictObject({
  actor: z.strictObject({ id: z.uuid(), email: z.email(), name: z.string().min(1) }),
  expiresAt: z.iso.datetime(),
});
export type RegisterRequest = z.input<typeof registerRequestSchema>;
export type RegisterResponse = z.infer<typeof registerResponseSchema>;
export const registrationSchemas = { RegisterRequest: registerRequestSchema, RegisterResponse: registerResponseSchema };
