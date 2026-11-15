import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { realpath, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { assertPrivatePath, readPrivateJson, writePrivateJson } from '../private-state.mjs';

const FIELDS = Object.freeze({
  status: [], list: [], create: ['tabId', 'url'], state: ['tabId'], close: ['tabId'], navigate: ['tabId', 'url'],
  back: ['tabId'], forward: ['tabId'], reload: ['tabId'], stop: ['tabId'], capture: ['tabId'], pick: ['tabId'],
  'cancel-pick': ['tabId'], 'pip-open': ['tabId'], 'pip-close': ['tabId'], devtools: ['tabId'], 'open-external': ['url'],
});
const MAX_REQUEST_BYTES = 16_384;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
function invalid(message) { return Object.assign(new Error(message), { status: 400 }); }

/** Closed native command vocabulary; no renderer channel, JS, arbitrary endpoint or filesystem arguments. */
export function parseBrowserCliAction(input, expected) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(FIELDS, input.action)) throw invalid('Invalid Browser command.');
  if (input.instanceId !== expected.instanceId || input.serviceUrl !== expected.serviceUrl) throw Object.assign(new Error('Browser instance changed.'), { status: 409 });
  const allowed = ['instanceId', 'serviceUrl', 'action', ...FIELDS[input.action]];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw invalid('Unknown Browser command field.');
  if (FIELDS[input.action].includes('tabId') && (typeof input.tabId !== 'string' || !input.tabId || input.tabId.length > 128 || /[\u0000-\u001f\u007f]/u.test(input.tabId))) throw invalid('Invalid Browser tab identity.');
  if (FIELDS[input.action].includes('url')) {
    if (input.url !== undefined || input.action !== 'create') {
      let url;
      try { url = new URL(input.url); } catch { throw invalid('Browser requires an HTTP(S) URL.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 8192) throw invalid('Invalid Browser URL.');
    }
  }
  return input;
}

/** Private per-workspace-window capability. This is not an Agent route or a remotely discoverable API. */
export async function startBrowserCliBridge({ descriptorFile, serviceUrl, execute }) {
  const target = new URL(serviceUrl);
  if (target.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname) || target.pathname !== '/agent' || target.search || target.hash || target.username || target.password) throw new Error('Browser CLI requires the existing local desktop Agent gateway.');
  if (resolve(descriptorFile) !== descriptorFile || await realpath(dirname(descriptorFile)) !== dirname(descriptorFile)) throw new Error('Browser descriptor directory cannot be redirected.');
  await assertPrivatePath(dirname(descriptorFile), true);
  const instanceId = randomUUID(), token = randomBytes(32).toString('hex');
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  let stopping = false, active = 0;
  const pending = new Set();
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    // No CORS, cookies, redirects, preflight or ambient web/Agent credentials.
    const supplied = Buffer.from(typeof request.headers.authorization === 'string' ? request.headers.authorization : '');
    if (stopping || request.method !== 'POST' || request.url !== '/preview' || request.headers.host !== `127.0.0.1:${server.address().port}` || request.headers.origin !== undefined || request.headers.cookie !== undefined || request.headers['sec-fetch-site'] !== undefined || supplied.length !== expectedAuthorization.length || !timingSafeEqual(supplied, expectedAuthorization)) {
      response.writeHead(403); response.end('{"error":"Browser capability required."}'); request.resume(); return;
    }
    if (request.headers['content-type'] !== 'application/json' || active >= 16) { response.writeHead(429); response.end('{"error":"Browser request refused."}'); request.resume(); return; }
    const cancellation = new AbortController();
    pending.add(cancellation); active++;
    const cancel = () => { if (!response.writableFinished) cancellation.abort(); };
    response.once('close', cancel);
    try {
      let length = 0; const chunks = [];
      for await (const chunk of request) {
        length += chunk.length;
        if (length > MAX_REQUEST_BYTES) throw invalid('Browser command exceeds its size limit.');
        chunks.push(chunk);
      }
      let value;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw invalid('Invalid Browser JSON.'); }
      const command = parseBrowserCliAction(value, { instanceId, serviceUrl });
      if (cancellation.signal.aborted || stopping) throw Object.assign(new Error('Browser operation cancelled.'), { status: 409 });
      const result = await execute(command, cancellation.signal);
      if (cancellation.signal.aborted || stopping) throw Object.assign(new Error('Browser operation cancelled.'), { status: 409 });
      const serialized = JSON.stringify({ instanceId, serviceUrl, ...result });
      if (Buffer.byteLength(serialized) > MAX_RESPONSE_BYTES) throw new Error('Browser result exceeds its size limit.');
      response.end(serialized);
    } catch (error) {
      if (!response.destroyed) { response.writeHead([400, 409].includes(error?.status) ? error.status : 503); response.end(JSON.stringify({ error: 'Native Browser action failed or its live desktop binding is unavailable; no action was retried.' })); }
    } finally { response.removeListener('close', cancel); pending.delete(cancellation); active--; }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 5_000; server.keepAliveTimeout = 1_000;
  const { promise, resolve: ready, reject } = Promise.withResolvers();
  server.once('error', reject); server.listen(0, '127.0.0.1', ready);
  await promise;
  server.removeListener('error', reject);
  const descriptor = { version: 1, serviceUrl, instanceId, endpoint: `http://127.0.0.1:${server.address().port}/preview`, token };
  try { await writePrivateJson(descriptorFile, descriptor); }
  catch (error) { server.closeAllConnections(); server.close(); throw error; }
  return {
    // Safe metadata deliberately excludes capability, endpoint and descriptor contents.
    instanceId,
    async close() {
      if (stopping) return;
      stopping = true;
      for (const cancellation of pending) cancellation.abort();
      const { promise, resolve: closed } = Promise.withResolvers();
      server.close(closed); server.closeAllConnections(); await promise;
      const current = await readPrivateJson(descriptorFile);
      if (current?.instanceId === instanceId) await unlink(descriptorFile);
    },
  };
}
