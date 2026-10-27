import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { parseSecurityActionMarker, serializeSecurityActionMarker } from '../apps/web/src/features/pm/service/settings/account-security-recovery.ts';

it('persists only an action ID and kind even when passed an accidentally widened password object', () => {
  const input = { actionId: randomUUID(), kind: 'password_change' as const, currentPassword: 'private-current-password', newPassword: 'private-new-password', token: 'private-session-token' };
  const encoded = serializeSecurityActionMarker(input);
  assert.deepEqual(JSON.parse(encoded), { actionId: input.actionId, kind: input.kind });
  assert.ok(!encoded.includes('private-'));
  assert.deepEqual(parseSecurityActionMarker(encoded), { actionId: input.actionId, kind: input.kind });
});
it('rejects malformed or widened recovery records rather than treating unknown writes as absent', () => {
  assert.equal(parseSecurityActionMarker(null), null);
  for (const value of ['invalid-json', '{}', '[]', JSON.stringify({ actionId: randomUUID(), kind: 'password_change', password: 'do-not-retain' }), JSON.stringify({ actionId: 'not-an-id', kind: 'revoke_sessions' })]) {
    assert.throws(() => parseSecurityActionMarker(value));
  }
});
