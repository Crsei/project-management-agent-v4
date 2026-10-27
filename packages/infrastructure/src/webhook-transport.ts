import { Resolver } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import * as https from 'node:https';
import * as tls from 'node:tls';
import type { ClientRequest } from 'node:http';
import { domainToASCII } from 'node:url';
import { constantSignatureEqual, sha256, signWebhookRequest, verifyWebhookReceipt, type WebhookRequestIdentity, type WebhookReceiverReceipt } from '../../domain/src/webhooks.ts';
import type { WebhookTarget } from './webhook-config.ts';

const denied4 = new BlockList();
for (const [network, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]] as const) denied4.addSubnet(network, prefix, 'ipv4');
const global6 = new BlockList(); global6.addSubnet('2000::', 3, 'ipv6');
const denied6 = new BlockList();
for (const [network, prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const) denied6.addSubnet(network, prefix, 'ipv6');
export function isGlobalWebhookAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !denied4.check(address, 'ipv4');
  return family === 6 && global6.check(address, 'ipv6') && !denied6.check(address, 'ipv6');
}
export type WebhookPinnedAddress = { address: string; family: 4 | 6 };
export type WebhookPreparedTarget = { url: URL; addresses: WebhookPinnedAddress[]; deadlineAt: number };
export type WebhookTransportResult = { receipt: WebhookReceiverReceipt | null; responseSha256: string | null; httpStatus: number | null; safeCode: string; requestMayHaveBeenSent: boolean };
export type WebhookTransport = {
  prepare(target: WebhookTarget, kind: 'dispatch' | 'receipt' | 'reconcile', deliveryId: string, signal?: AbortSignal): Promise<WebhookPreparedTarget>;
  send(prepared: WebhookPreparedTarget, request: WebhookRequestIdentity, body: Buffer, key: Buffer, payloadSha256: string, signal?: AbortSignal): Promise<WebhookTransportResult>;
};
export class WebhookNetworkError extends Error {
  readonly safeCode: string;
  constructor(safeCode: string) { super(safeCode); this.safeCode = safeCode; }
}
function allowedDnsName(name: string): boolean {
  return domainToASCII(name).toLowerCase() === name.toLowerCase() && name.includes('.') && !name.endsWith('.') && !isIP(name) && /^[a-z0-9.-]+$/i.test(name) && !/\.(?:local|localhost|internal|test|invalid|example|home|lan|onion)$/i.test(name);
}
export type WebhookDnsResolver = { resolve4: (name: string) => Promise<string[]>; resolve6: (name: string) => Promise<string[]>; resolveCname: (name: string) => Promise<string[]>; cancel: () => void };
/** All answers and the complete visible CNAME chain are validated before any socket opens. */
export async function resolveWebhookAddresses(hostname: string, signal?: AbortSignal, resolver: WebhookDnsResolver = new Resolver({ timeout: 1500, tries: 1 })): Promise<WebhookPinnedAddress[]> {
  const deadlineAt = Date.now() + 2000;
  const cancel = () => resolver.cancel();
  const timer = setTimeout(cancel, 2000);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    const visited = new Set<string>();
    const addresses = new Map<string, WebhookPinnedAddress>();
    async function lookup(name: string): Promise<void> {
      signal?.throwIfAborted();
      if (Date.now() >= deadlineAt) throw new WebhookNetworkError('webhook_dns_failed');
      name = name.toLowerCase().replace(/\.$/, '');
      if (!allowedDnsName(name) || visited.has(name) || visited.size >= 8) throw new WebhookNetworkError('webhook_dns_denied');
      visited.add(name);
      const absent = (error: unknown): never[] => {
        if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && ['ENODATA', 'ENOTFOUND'].includes(error.code)) return [];
        throw new WebhookNetworkError('webhook_dns_failed');
      };
      const [a, aaaa, aliases] = await Promise.all([resolver.resolve4(name).catch(absent), resolver.resolve6(name).catch(absent), resolver.resolveCname(name).catch(absent)]);
      for (const address of [...a, ...aaaa]) {
        if (!isGlobalWebhookAddress(address)) throw new WebhookNetworkError('webhook_dns_denied');
        addresses.set(address, { address, family: isIP(address) as 4 | 6 });
      }
      for (const alias of aliases) await lookup(alias);
    }
    await lookup(hostname);
    signal?.throwIfAborted();
    if (!addresses.size || addresses.size > 32) throw new WebhookNetworkError('webhook_dns_denied');
    return [...addresses.values()];
  } catch (error) { if (error instanceof WebhookNetworkError) throw error; throw new WebhookNetworkError('webhook_dns_failed'); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
/** No fetch, environment proxy, redirects, second lookup, pooling or automatic retry. */
async function sendPinned(prepared: WebhookPreparedTarget, identity: WebhookRequestIdentity, body: Buffer, key: Buffer, payloadSha256: string, connect: WebhookTransportPolicy['connect'], signal?: AbortSignal): Promise<WebhookTransportResult> {
  let sent = false;
  let socket: tls.TLSSocket | undefined;
  let agent: https.Agent | undefined;
  let request: ClientRequest | undefined;
  let stageTimer: NodeJS.Timeout | undefined;
  let abort: () => void = () => {};
  const total = setTimeout(() => abort(), Math.max(1, prepared.deadlineAt - Date.now()));
  const failure = (safeCode: string): WebhookTransportResult => ({ receipt: null, responseSha256: null, httpStatus: null, safeCode, requestMayHaveBeenSent: sent });
  try {
    signal?.throwIfAborted();
    if (body.length > 4096 || sha256(body) !== identity.bodySha256 || identity.path !== prepared.url.pathname) return failure('webhook_payload_invalid');
    const pinned = prepared.addresses[0];
    if (!pinned || prepared.deadlineAt <= Date.now()) return failure('webhook_dns_denied');
    const handshake = Promise.withResolvers<void>();
    abort = () => { socket?.destroy(); handshake.reject(new Error('deadline')); };
    signal?.addEventListener('abort', abort, { once: true });
    stageTimer = setTimeout(abort, Math.min(3000, prepared.deadlineAt - Date.now()));
    socket = connect(prepared.url, pinned);
    socket.once('error', handshake.reject);
    socket.once('secureConnect', () => {
      if (!socket?.authorized || !(socket.remoteAddress === pinned.address || socket.remoteAddress === `::ffff:${pinned.address}`)) { handshake.reject(new Error('tls')); return; }
      clearTimeout(stageTimer); handshake.resolve();
    });
    await handshake.promise;
    if (signal?.aborted || Date.now() >= prepared.deadlineAt) return failure('webhook_transport_failed');
    const responseResult = Promise.withResolvers<WebhookTransportResult>();
    let settled = false;
    const finish = (result: WebhookTransportResult) => { if (settled) return; settled = true; clearTimeout(stageTimer); responseResult.resolve(result); };
      signal?.removeEventListener('abort', abort);
      abort = () => { request?.destroy(); socket?.destroy(); finish(failure('webhook_transport_timeout')); };
      signal?.addEventListener('abort', abort, { once: true });
      agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
      agent.createConnection = () => socket!;
      request = https.request(prepared.url, { agent, method: identity.method, path: identity.path, maxHeaderSize: 8192, headers: {
        'Content-Type': 'application/json', 'Content-Length': body.length, 'Accept-Encoding': 'identity', 'Connection': 'close',
        'X-PM-Endpoint-Id': identity.endpointId, 'X-PM-Delivery-Id': identity.deliveryId, 'X-PM-Event-Id': identity.eventId,
        'X-PM-Attempt-Id': identity.attemptId, 'X-PM-Attempt-No': identity.attemptNo, 'X-PM-Timestamp': identity.timestamp,
        'X-PM-Key-Id': identity.keyId, 'X-PM-Signature': signWebhookRequest(key, identity),
      } }, response => {
        if (response.statusCode === undefined || response.statusCode >= 300 && response.statusCode < 400 || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { response.destroy(); finish(failure('webhook_response_untrusted')); return; }
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 8192) { response.destroy(); finish(failure('webhook_response_too_large')); } else chunks.push(chunk); });
        response.once('error', () => finish(failure('webhook_response_lost')));
        response.once('aborted', () => finish(failure('webhook_response_lost')));
        response.once('end', () => {
          const bytes = Buffer.concat(chunks, size);
          const signature = response.headers['x-pm-receipt-signature'];
          const receipt = typeof signature === 'string' ? verifyWebhookReceipt(key, identity, response.statusCode!, bytes, signature, payloadSha256) : null;
          finish({ receipt, responseSha256: receipt ? sha256(bytes) : null, httpStatus: response.statusCode!, safeCode: receipt ? `receiver_${receipt.status}` : 'webhook_response_untrusted', requestMayHaveBeenSent: true });
        });
      });
      request.once('error', () => finish(failure('webhook_transport_failed')));
      // Once an HTTP request is handed to the socket, assume effects are possible even if finish never fires.
      sent = true;
      stageTimer = setTimeout(abort, Math.max(1, Math.min(5000, prepared.deadlineAt - Date.now())));
      request.end(body);
    return await responseResult.promise;
  } catch { return failure('webhook_connect_failed'); }
  finally { clearTimeout(total); clearTimeout(stageTimer); signal?.removeEventListener('abort', abort); request?.destroy(); agent?.destroy(); socket?.destroy(); }
}
export type WebhookTransportPolicy = {
  resolve: (hostname: string, signal?: AbortSignal) => Promise<WebhookPinnedAddress[]>;
  connect: (url: URL, pinned: WebhookPinnedAddress) => tls.TLSSocket;
};
/** Explicit test seam: production main always uses the immutable default below, never env/network exemptions. */
export function createWebhookTransport(policy: WebhookTransportPolicy): WebhookTransport {
  return {
    async prepare(target, kind, deliveryId, signal) {
      const deadlineAt = Date.now() + 10000;
      const url = new URL(kind === 'dispatch' ? target.deliveryUrl : `${kind === 'receipt' ? target.receiptBaseUrl : target.reconcileBaseUrl}/${encodeURIComponent(deliveryId)}`);
      return { url, addresses: await policy.resolve(url.hostname, signal), deadlineAt };
    },
    send: (prepared, request, body, key, payloadSha256, signal) => sendPinned(prepared, request, body, key, payloadSha256, policy.connect, signal),
  };
}
export const webhookTransport = createWebhookTransport({
  resolve: resolveWebhookAddresses,
  connect: (url, pinned) => tls.connect({ host: pinned.address, port: 443, servername: url.hostname, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] }),
});
/** Receiver-side verification helper shared by the durable isolated receiver fixture. */
export function verifyWebhookRequest(key: Buffer, request: WebhookRequestIdentity, body: Buffer, signature: string, now = Date.now()): boolean {
  return Number.isSafeInteger(request.timestamp) && Math.abs(now / 1000 - request.timestamp) <= 300 && Number.isSafeInteger(request.attemptNo) && request.attemptNo > 0 && body.length <= 4096 && sha256(body) === request.bodySha256 && constantSignatureEqual(signWebhookRequest(key, request), signature);
}
