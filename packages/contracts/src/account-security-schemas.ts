import { z } from 'zod';

const uuid = z.uuid().toLowerCase();
const credentialVersion = z.number().int().positive().max(2147483647);
export const accountSecurityActionKindSchema = z.enum(['password_change', 'revoke_sessions', 'recovery_email_begin', 'recovery_email_confirm', 'recovery_email_cancel', 'recovery_email_unbind']);
export const changeOwnPasswordSchema = z.strictObject({
  actionId: uuid, expectedCredentialVersion: credentialVersion.max(2147483646),
  currentPassword: z.string().max(256).meta({ writeOnly: true }),
  newPassword: z.string().min(12).max(256).meta({ writeOnly: true }),
});
export const revokeOwnSessionsSchema = z.strictObject({ actionId: uuid, expectedCredentialVersion: credentialVersion, sessionId: z.union([uuid, z.literal('others')]) });
export const recoverAccountSecurityActionSchema = z.strictObject({ kind: accountSecurityActionKindSchema });
export const accountSecurityActionParamsSchema = z.strictObject({ actionId: uuid });
export const accountSecurityActionSchema = z.strictObject({
  actionId: uuid, kind: accountSecurityActionKindSchema, status: z.enum(['committed', 'rejected', 'cancelled']),
  credentialVersion, recoveryEmailVersion: credentialVersion, challengeId: uuid.nullable(), revokedCount: z.number().int().nonnegative(),
  errorCode: z.enum(['current_password_invalid', 'credential_version_conflict', 'not_found_or_forbidden', 'current_session_protected', 'password_unchanged', 'recovery_email_version_conflict', 'recovery_email_pending', 'recovery_email_conflict', 'recovery_link_unavailable', 'recovery_email_not_registered', 'recovery_delivery_in_progress']).nullable(),
  httpStatus: z.union([z.literal(200), z.literal(400), z.literal(403), z.literal(404), z.literal(409)]), occurredAt: z.iso.datetime(),
});
export const accountSecurityActionLookupSchema = z.strictObject({ action: accountSecurityActionSchema.nullable() });
export const accountSecuritySchema = z.strictObject({
  credentialVersion, passwordChangedAt: z.iso.datetime().nullable(),
  passwordPolicy: z.strictObject({ minLength: z.literal(12), maxLength: z.literal(256), currentSession: z.literal('retained'), otherSessions: z.literal('revoked') }),
  recoveryEmail: z.strictObject({ email: z.email().nullable(), verifiedAt: z.iso.datetime().nullable(), emailVersion: credentialVersion, pending: z.strictObject({ challengeId: uuid, candidateEmail: z.email(), expiresAt: z.iso.datetime(), delivery: z.strictObject({ id: uuid, status: z.enum(['queued', 'sending', 'smtp_accepted', 'failed', 'unknown', 'cancelled']), failureCode: z.string().nullable() }) }).nullable() }),
  sessions: z.array(z.strictObject({ id: uuid, current: z.boolean(), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), device: z.null(), ipAddress: z.null(), location: z.null(), lastActiveAt: z.null() })),
});
/** The registrar and OpenAPI builder share these exact validators. */
export const accountSecuritySchemas = {
  AccountSecurity: accountSecuritySchema,
  AccountSecurityAction: accountSecurityActionSchema,
  AccountSecurityActionLookup: accountSecurityActionLookupSchema,
  ChangeOwnPassword: changeOwnPasswordSchema,
  RevokeOwnSessions: revokeOwnSessionsSchema,
  RecoverAccountSecurityAction: recoverAccountSecurityActionSchema,
};
