import { constants, lstatSync, openSync, closeSync, readFileSync, fstatSync } from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { z } from 'zod';
import { WEBHOOK_EVENT_TYPES, sha256 } from '../../domain/src/webhooks.ts';

const token = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const project = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/).max(80);
const keySchema = z.strictObject({ keyId: token, secretFile: z.string().min(1).max(4096), activeFrom: z.iso.datetime(), activeUntil: z.iso.datetime().nullable(), receiverReady: z.boolean() });
const targetSchema = z.strictObject({ targetKey: token, workspaceId: z.uuid().toLowerCase(), projectIds: z.array(project).min(1).max(1000), eventTypes: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).max(3),
  deliveryUrl: z.string().max(2048), receiptBaseUrl: z.string().max(2048), reconcileBaseUrl: z.string().max(2048), protocol: z.literal('pm-receipt-v1'), policyVersion: z.literal(1), keyring: z.array(keySchema).min(1).max(10) });
export type WebhookKey = z.infer<typeof keySchema>;
export type WebhookTarget = z.infer<typeof targetSchema> & { targetDigest: string; hostname: string };
export type WebhookConfig = { status: 'disabled' | 'configured' | 'configuration_error'; digest: string | null; targets: WebhookTarget[] };
export function normalizeWebhookUrl(input: string): URL {
  if (/[\u0000-\u0020\u007f\\%]/.test(input)) throw new Error('webhook_configuration_error');
  const url = new URL(input);
  const hostname = domainToASCII(url.hostname).toLowerCase();
  if (url.protocol !== 'https:' || url.port && url.port !== '443' || url.username || url.password || url.search || url.hash || isIP(hostname) || !hostname.includes('.') || hostname.endsWith('.') || !/^[a-z0-9.-]+$/.test(hostname) || hostname.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) || /\.(?:local|localhost|internal|test|invalid|example|home|lan|onion)$/.test(hostname)) throw new Error('webhook_configuration_error');
  // Reject normalization of ambiguous paths, including dot segments and repeated slashes.
  if (!/^https:\/\/[^/]+(?:\/[a-zA-Z0-9_~!$&'()*+,;=:@.-]*)*$/.test(input) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(input.slice(input.indexOf('/', 8)))) throw new Error('webhook_configuration_error');
  url.hostname = hostname;
  return url;
}
function assertRegularPath(filename: string): void {
  const absolute = path.resolve(filename);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('webhook_configuration_error');
  }
}
/** API parses metadata only; secret files are deliberately not opened here. */
export function readWebhookConfig(env: NodeJS.ProcessEnv = process.env): WebhookConfig {
  if (env.WEBHOOK_TARGETS_FILE === undefined) return { status: 'disabled', digest: null, targets: [] };
  try {
    const filename = env.WEBHOOK_TARGETS_FILE;
    if (!filename || !path.isAbsolute(filename)) throw new Error('invalid');
    assertRegularPath(filename);
    const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    let raw: Buffer;
    try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 131072 || stat.mode & 0o022) throw new Error('invalid'); raw = readFileSync(fd); } finally { closeSync(fd); }
    const manifest = z.strictObject({ schemaVersion: z.literal(1), targets: z.array(targetSchema).max(100) }).parse(JSON.parse(raw.toString('utf8')));
    const seen = new Set<string>();
    const secretFiles = new Set<string>();
    const targets = manifest.targets.map(target => {
      if (seen.has(target.targetKey) || new Set(target.projectIds).size !== target.projectIds.length || new Set(target.eventTypes).size !== target.eventTypes.length || new Set(target.keyring.map(k => k.keyId)).size !== target.keyring.length) throw new Error('invalid');
      seen.add(target.targetKey);
      const delivery = normalizeWebhookUrl(target.deliveryUrl);
      const receipt = normalizeWebhookUrl(target.receiptBaseUrl);
      const reconcile = normalizeWebhookUrl(target.reconcileBaseUrl);
      if (delivery.origin !== receipt.origin || delivery.origin !== reconcile.origin) throw new Error('invalid');
      for (const key of target.keyring) {
        if (!path.isAbsolute(key.secretFile) || key.secretFile.split('{endpointId}').length !== 2 || secretFiles.has(key.secretFile) || key.activeUntil && Date.parse(key.activeUntil) <= Date.parse(key.activeFrom)) throw new Error('invalid');
        secretFiles.add(key.secretFile);
      }
      const normalized = { ...target, projectIds: [...target.projectIds].sort(), eventTypes: [...target.eventTypes].sort(), deliveryUrl: delivery.href, receiptBaseUrl: receipt.href.replace(/\/$/, ''), reconcileBaseUrl: reconcile.href.replace(/\/$/, ''), keyring: [...target.keyring].sort((a, b) => a.keyId.localeCompare(b.keyId)) };
      // Transport/scope identity is immutable; key metadata has a separate deployment digest so approved rotation never redirects backlog.
      const { keyring: _keyring, ...publicIdentity } = normalized;
      return { ...normalized, targetDigest: sha256(JSON.stringify(publicIdentity)), hostname: delivery.hostname };
    });
    return { status: targets.length ? 'configured' : 'disabled', digest: sha256(JSON.stringify(targets.map(t => [t.targetKey, t.targetDigest, t.keyring.map(({ secretFile: _secretFile, ...key }) => key)]).sort())), targets };
  } catch { return { status: 'configuration_error', digest: null, targets: [] }; }
}
export function webhookKeyMetadata(target: WebhookTarget, keyId: string, now = Date.now()): WebhookKey | undefined {
  return target.keyring.find(k => k.keyId === keyId && k.receiverReady && Date.parse(k.activeFrom) <= now && (k.activeUntil === null || Date.parse(k.activeUntil) > now));
}
/** Worker-only port. Dedicated non-symlink file, owner-readable and no group/world access. */
export function readWebhookSigningKey(target: WebhookTarget, keyId: string, endpointId: string): Buffer {
  const key = webhookKeyMetadata(target, keyId);
  if (!key || !z.uuid().safeParse(endpointId).success) throw new Error('webhook_secret_unavailable');
  try {
    const filename = key.secretFile.replace('{endpointId}', endpointId.toLowerCase());
    assertRegularPath(filename);
    const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.mode & 0o077 || stat.size < 32 || stat.size > 256) throw new Error('invalid');
      const bytes = readFileSync(fd);
      if (bytes.length < 32 || bytes.length > 256) throw new Error('invalid');
      return bytes;
    } finally { closeSync(fd); }
  } catch { throw new Error('webhook_secret_unavailable'); }
}
