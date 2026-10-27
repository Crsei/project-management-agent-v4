// Browser-safe account security DTOs. Never add credentials, tokens or secret-derived digests.
export type AccountSecurityActionKind = 'password_change' | 'revoke_sessions' | 'recovery_email_begin' | 'recovery_email_confirm' | 'recovery_email_cancel' | 'recovery_email_unbind';
export type AccountSecurityErrorCode = 'current_password_invalid' | 'credential_version_conflict' | 'not_found_or_forbidden' | 'current_session_protected' | 'password_unchanged' | 'recovery_email_version_conflict' | 'recovery_email_pending' | 'recovery_email_conflict' | 'recovery_link_unavailable' | 'recovery_email_not_registered' | 'recovery_delivery_in_progress';
export type AccountSecurityAction = {
  actionId: string;
  kind: AccountSecurityActionKind;
  status: 'committed' | 'rejected' | 'cancelled';
  credentialVersion: number;
  recoveryEmailVersion: number;
  challengeId: string | null;
  revokedCount: number;
  errorCode: AccountSecurityErrorCode | null;
  httpStatus: number;
  occurredAt: string;
};
export type AccountSession = {
  id: string;
  current: boolean;
  createdAt: string;
  expiresAt: string;
  device: null;
  ipAddress: null;
  location: null;
  lastActiveAt: null;
};
export type AccountSecurity = {
  credentialVersion: number;
  passwordChangedAt: string | null;
  passwordPolicy: { minLength: 12; maxLength: 256; currentSession: 'retained'; otherSessions: 'revoked' };
  recoveryEmail: { email: string | null; verifiedAt: string | null; emailVersion: number; pending: null | { challengeId: string; candidateEmail: string; expiresAt: string; delivery: { id: string; status: 'queued' | 'sending' | 'smtp_accepted' | 'failed' | 'unknown' | 'cancelled'; failureCode: string | null } } };
  sessions: AccountSession[];
};
export type ChangeOwnPassword = { actionId: string; expectedCredentialVersion: number; currentPassword: string; newPassword: string };
export type RevokeOwnSessions = { actionId: string; expectedCredentialVersion: number; sessionId: string | 'others' };
export type AccountSecurityActionLookup = { action: AccountSecurityAction | null };
