import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { AutomationEventVerification } from '../../contracts/src/automation-integrations.ts';
import { DomainError } from '../../domain/src/core.ts';

function equalSignature(actual: string, expected: string): boolean {
  const left = Buffer.from(actual); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
/** Authentication always covers the original byte sequence, never JSON.stringify(parsed body). */
export function verifyAutomationEventSignature(mode: AutomationEventVerification, secret: string, raw: Buffer, headers: IncomingHttpHeaders, now = Date.now()): { externalEventId: string; bodySha256: string } {
  const header = (name: string): string => { const value = headers[name]; return typeof value === 'string' ? value : ''; };
  const bodySha256 = createHash('sha256').update(raw).digest('hex');
  let externalEventId = header('x-webhook-id') || header('x-github-delivery');
  let authenticated = false;
  if (mode === 'key') authenticated = equalSignature(header('x-automation-key'), secret);
  if (mode === 'hmac_sha256_hex') {
    const actual = (header('x-webhook-signature') || header('x-hub-signature-256')).replace(/^sha256=/, '');
    authenticated = /^[a-fA-F0-9]{64}$/.test(actual) && equalSignature(actual.toLowerCase(), createHmac('sha256', secret).update(raw).digest('hex'));
  }
  if (mode === 'standard_webhooks' || mode === 'slack_v0') {
    const timestamp = header(mode === 'slack_v0' ? 'x-slack-request-timestamp' : 'webhook-timestamp');
    if (!/^\d{1,12}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) throw new DomainError('event_replay_rejected', 'Webhook timestamp is missing or outside the five minute replay window', 401);
    if (mode === 'standard_webhooks') {
      externalEventId = header('webhook-id');
      const signingKey = secret.startsWith('whsec_') ? Buffer.from(secret.slice(6), 'base64') : Buffer.from(secret, 'base64');
      if (signingKey.length < 16) throw new DomainError('event_signature_invalid', 'Webhook signing key is not valid Standard Webhooks base64 material', 401);
      const expected = createHmac('sha256', signingKey).update(`${externalEventId}.${timestamp}.`).update(raw).digest('base64');
      authenticated = header('webhook-signature').split(/\s+/).some(signature => signature.startsWith('v1,') && equalSignature(signature.slice(3), expected));
    } else {
      authenticated = equalSignature(header('x-slack-signature'), 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:`).update(raw).digest('hex'));
      // Slack's event id is inside the authenticated body; URL verification has no event id.
      try { const payload = JSON.parse(raw.toString('utf8')) as { event_id?: unknown }; externalEventId = typeof payload.event_id === 'string' ? payload.event_id : bodySha256; } catch { externalEventId = bodySha256; }
    }
  }
  if (!authenticated) throw new DomainError('event_signature_invalid', 'Webhook authentication failed', 401);
  const optionalTimestamp = header('x-webhook-timestamp');
  if ((mode === 'key' || mode === 'hmac_sha256_hex') && optionalTimestamp && (!/^\d{1,12}$/.test(optionalTimestamp) || Math.abs(now / 1000 - Number(optionalTimestamp)) > 300)) throw new DomainError('event_replay_rejected', 'Webhook timestamp is outside the five minute replay window', 401);
  if (!externalEventId || externalEventId.length > 500 || /[\u0000-\u001f\u007f]/.test(externalEventId)) throw new DomainError('event_identity_invalid', 'A bounded webhook event identity is required', 400);
  // Raw-HMAC and key senders may not sign timestamps/ids. Permanent body-digest uniqueness also prevents relabelled replay.
  return { externalEventId, bodySha256 };
}
