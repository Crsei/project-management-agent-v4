import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type AccountSecurity, type AccountSecurityAction, type AccountSecurityActionKind } from '@contracts';
import { accountSecurityActionLookupSchema, accountSecurityActionSchema, accountSecuritySchema } from '../../../../../../../packages/contracts/src/account-security-schemas.ts';
import { usePmService } from '../pm-service';
import { parseSecurityActionMarker, serializeSecurityActionMarker, type SecurityActionMarker } from './account-security-recovery';

export type AccountSecurityState = {
  data: AccountSecurity | null; loading: boolean; busy: boolean;
  pending: SecurityActionMarker | null; storageError: boolean; error: unknown;
  outcome: AccountSecurityAction | null;
  refresh: () => Promise<void>; recover: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  revoke: (sessionId: string | "others") => Promise<void>;
  beginEmail: (email: string, currentPassword: string) => Promise<void>;
  confirmEmail: (token: string) => Promise<void>;
  cancelEmail: (currentPassword: string) => Promise<void>;
  unbindEmail: (currentPassword: string) => Promise<void>;
};
// This hook never touches the general command journal or IndexedDB. The only
// persisted value is an actor-scoped action ID/kind, never a password or token.
export function useAccountSecurity(): AccountSecurityState {
  const service = usePmService();
  const { client, actor, actorEpoch, refresh: refreshSession } = service;
  const identity = `${actor?.id ?? 'anonymous'}:${actorEpoch}`;
  const live = useRef(identity);
  live.current = identity;
  const mounted = useRef(false);
  const key = `pm.account-security.action.v1:${actor?.id ?? 'anonymous'}`;
  const [initial] = useState(() => {
    try { return { pending: parseSecurityActionMarker(sessionStorage.getItem(key)), storageError: false }; }
    catch { return { pending: null, storageError: true }; }
  });
  const [pending, setPending] = useState<SecurityActionMarker | null>(initial.pending);
  const pendingRef = useRef(initial.pending);
  const [storageError, setStorageError] = useState(initial.storageError);
  const [data, setData] = useState<AccountSecurity | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [outcome, setOutcome] = useState<AccountSecurityAction | null>(null);
  const current = useCallback(() => mounted.current && live.current === identity, [identity]);
  const report = useCallback((cause: unknown) => {
    if (!current()) return;
    setError(cause);
    if (cause instanceof ApiError && cause.status === 401) {
      setData(null);
      void refreshSession().catch(() => {});
    }
  }, [current, refreshSession]);
  const refresh = useCallback(async () => {
    if (!actor || !current()) return;
    setLoading(true);
    try {
      const snapshot = accountSecuritySchema.parse(await client.getAccountSecurity({ signal: AbortSignal.timeout(20_000) }));
      if (current()) { setData(snapshot); setError(null); }
    } catch (cause) { if (current()) { setData(null); report(cause); } }
    finally { if (current()) setLoading(false); }
  }, [actor, client, current, report]);
  // The owning route keys this component by actor+epoch, so no old identity state
  // or password field can survive a session transition.
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; };
  }, [refresh]);
  const settle = useCallback((action: AccountSecurityAction, marker: SecurityActionMarker) => {
    if (action.actionId !== marker.actionId || action.kind !== marker.kind) throw new Error('Security action response does not match the original action');
    // Clear durable marker before permitting another write. Storage failure
    // deliberately leaves recovery blocked rather than forgetting an unknown action.
    sessionStorage.removeItem(key);
    pendingRef.current = null;
    setPending(null);
    setOutcome(action);
    setError(null);
  }, [key]);
  const execute = async (kind: AccountSecurityActionKind, send: (actionId: string) => Promise<unknown>) => {
    if (!actor || !data || loading || storageError || pendingRef.current || busyRef.current || !current()) return;
    const marker: SecurityActionMarker = { actionId: crypto.randomUUID(), kind };
    try { sessionStorage.setItem(key, serializeSecurityActionMarker(marker)); }
    catch (cause) { setStorageError(true); report(cause); return; }
    pendingRef.current = marker;
    setPending(marker);
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const action = accountSecurityActionSchema.parse(await send(marker.actionId));
      if (!current()) return;
      settle(action, marker);
      await refresh();
    } catch (cause) { report(cause); }
    finally { if (current()) { busyRef.current = false; setBusy(false); } }
  };
  const recover = async () => {
    const marker = pendingRef.current;
    if (!marker || busyRef.current || !current()) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      // Read first. Absence is ambiguous, so the explicit recover endpoint takes
      // the user lock and fences a delayed original request before cancelling it.
      const found = accountSecurityActionLookupSchema.parse(await client.getAccountSecurityAction(marker.actionId, { signal: AbortSignal.timeout(20_000) }));
      const result = found.action ? found : accountSecurityActionLookupSchema.parse(await client.recoverAccountSecurityAction(marker.actionId, { kind: marker.kind }, { signal: AbortSignal.timeout(20_000) }));
      if (!current()) return;
      if (!result.action) throw new Error('Security action recovery is still unknown');
      settle(result.action, marker);
      await refresh();
    } catch (cause) { report(cause); }
    finally { if (current()) { busyRef.current = false; setBusy(false); } }
  };
  return { data, loading, busy, pending, storageError, error, outcome, refresh, recover,
    changePassword: (currentPassword: string, newPassword: string) => execute('password_change', actionId => client.changeOwnPassword({ actionId, expectedCredentialVersion: data!.credentialVersion, currentPassword, newPassword }, { signal: AbortSignal.timeout(20_000) })),
    revoke: (sessionId: string | 'others') => execute('revoke_sessions', actionId => client.revokeOwnSessions({ actionId, expectedCredentialVersion: data!.credentialVersion, sessionId }, { signal: AbortSignal.timeout(20_000) })),
    beginEmail: (email, currentPassword) => execute('recovery_email_begin', actionId => client.accountRecovery.begin({ actionId, expectedCredentialVersion: data!.credentialVersion, expectedRecoveryEmailVersion: data!.recoveryEmail.emailVersion, email, currentPassword })),
    confirmEmail: token => execute('recovery_email_confirm', actionId => client.accountRecovery.confirm({ actionId, token, expectedRecoveryEmailVersion: data!.recoveryEmail.emailVersion })),
    cancelEmail: currentPassword => execute('recovery_email_cancel', actionId => client.accountRecovery.cancel({ actionId, challengeId: data!.recoveryEmail.pending!.challengeId, expectedCredentialVersion: data!.credentialVersion, expectedRecoveryEmailVersion: data!.recoveryEmail.emailVersion, currentPassword })),
    unbindEmail: currentPassword => execute('recovery_email_unbind', actionId => client.accountRecovery.unbind({ actionId, expectedCredentialVersion: data!.credentialVersion, expectedRecoveryEmailVersion: data!.recoveryEmail.emailVersion, currentPassword })),
  };
}
