import type { AccountSecurityActionKind } from '../../../../../../../packages/contracts/src/account-security.ts';

export type SecurityActionMarker = { actionId: string; kind: AccountSecurityActionKind };
export function parseSecurityActionMarker(value: string | null): SecurityActionMarker | null {
  if (value === null) return null;
  const item: unknown = JSON.parse(value);
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid security recovery marker');
  const marker = item as Record<string, unknown>;
  if (Object.keys(marker).length !== 2 || typeof marker.actionId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(marker.actionId) || !['password_change', 'revoke_sessions', 'recovery_email_begin', 'recovery_email_confirm', 'recovery_email_cancel', 'recovery_email_unbind'].includes(String(marker.kind))) throw new Error('Invalid security recovery marker');
  return { actionId: marker.actionId, kind: marker.kind as AccountSecurityActionKind };
}
/** Explicit whitelist: even an accidentally widened caller object cannot persist a secret. */
export function serializeSecurityActionMarker(marker: SecurityActionMarker): string {
  return JSON.stringify({ actionId: marker.actionId, kind: marker.kind });
}
