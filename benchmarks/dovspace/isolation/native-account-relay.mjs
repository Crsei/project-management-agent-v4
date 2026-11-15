import { createHash } from 'node:crypto';
import { readFile, lstat, chmod } from 'node:fs/promises';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { Readable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TraceRedactor } from '../runners/telemetry.ts';

// This program runs ONLY on the trusted host. No token is returned over IPC.
const hash = value => createHash('sha256').update(value).digest('hex');
const fingerprint = accountId => hash(`openai-codex\0${accountId}`);
const publicAddress = address => {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a !== 169 && a !== 192 && !(a === 172 && b >= 16 && b <= 31) && !(a === 100 && b >= 64 && b <= 127) && a < 224;
  }
  return isIP(address) === 6 && /^[23]/.test(address) && !address.toLowerCase().startsWith('2001:db8:');
};
let auth, authOpening;
try {
  let raw = '';
  for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 65536) throw new Error('configuration-size'); }
  const config = JSON.parse(raw);
  const httpProxy = config.boundary?.httpProxy;
  if (httpProxy !== undefined && (typeof httpProxy !== 'string' || !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9]\d{0,4}\/?$/.test(httpProxy) || !URL.canParse(httpProxy))) throw new Error('Explicit credential-free loopback HTTP proxy required');
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const [major, minor, patch] = Bun.version.split('.').map(Number);
  if (major < 1 || major === 1 && (minor < 4 || minor === 4 && patch < 4)) throw new Error('Bun >=1.4.4 is required');
  const load = name => import(pathToFileURL(Bun.resolveSync(name, path.join(config.access.sdkRoot, 'package.json'))).href);
  const utils = await load('@oh-my-pi/pi-utils/logger');
  utils.setTransports({ console: false, file: false });
  const versions = {};
  for (const name of ['pi-ai', 'pi-catalog', 'pi-wire', 'pi-utils', 'pi-natives', 'omptype']) {
    const metadata = JSON.parse(await readFile(path.join(config.access.sdkRoot, 'node_modules', '@oh-my-pi', name, 'package.json'), 'utf8'));
    if (metadata.version !== '18.15.0') throw new Error('Exact OMP18.15.0 SDK packages are required');
    versions[name] = metadata.version;
  }
  const lockBytes = await readFile(path.join(config.access.sdkRoot, 'package-lock.json'));
  const sdkLockSha256 = hash(lockBytes);
  const catalogBytes = await readFile(path.join(config.access.sdkRoot, 'node_modules/@oh-my-pi/pi-catalog/src/models.json'));
  const catalogSha256 = hash(catalogBytes);
  const { getBundledModel } = await load('@oh-my-pi/pi-catalog/models');
  const wire = await load('@oh-my-pi/pi-catalog/wire/codex');
  const model = getBundledModel('openai-codex', 'gpt-6.1-sol');
  if (!model || model.provider !== 'openai-codex' || model.api !== 'openai-codex-responses' || model.baseUrl !== 'https://chatgpt.com/backend-api' || model.contextWindow !== 500000 || model.maxTokens !== 128000 || model.omitMaxOutputTokens !== true || !model.thinking?.efforts.includes('xhigh')) throw new Error('Exact native catalog model unavailable or unsupported');
  const metadata = { sdkVersion: '18.15.0', sdkLockSha256, catalogSha256, sdkPackages: versions, bunVersion: Bun.version,
    model: { id: model.id, provider: model.provider, api: model.api, baseUrl: model.baseUrl },
    ompModel: { contextWindow: model.contextWindow, maxTokens: model.maxTokens, reasoning: model.reasoning, thinking: { efforts: model.thinking.efforts, mode: model.thinking.mode }, omitMaxOutputTokens: true },
    prices: { inputPerMillion: model.cost.input, outputPerMillion: model.cost.output, cacheReadPerMillion: model.cost.cacheRead, cacheWritePerMillion: model.cost.cacheWrite, maxOutputTokens: model.maxTokens, version: `omp-catalog-18.15.0:${catalogSha256}`, basis: 'catalog-estimate' },
    transport: { origin: wire.CODEX_BASE_URL, authTokenEndpoint: 'https://auth.openai.com/oauth/token', clientVersion: wire.CODEX_CLIENT_VERSION, protocol: 'https-sse', egress: httpProxy ? { kind: 'explicit-loopback-http-connect', httpProxy, dns: 'trusted-proxy', tlsVerification: true } : { kind: 'direct-public-dns-pinned' }, outputCap: 'catalog-max-reservation-only', billing: 'unknown-subscription-billing' } };
  if (config.mode === 'catalog') { process.stdout.write(JSON.stringify(metadata) + '\n'); process.exit(0); }
  // The SDK alone owns refresh semantics. Only the official token exchange is
  // reachable: direct pinned DNS or the explicitly selected trusted local proxy.
  let activeAuthResolutions = 0;
  globalThis.fetch = async (input, init) => {
    const exchange = new Request(input, init);
    if (config.mode !== 'serve' || activeAuthResolutions === 0 || exchange.url !== 'https://auth.openai.com/oauth/token' || exchange.method !== 'POST' || Date.now() >= config.deadline) throw new Error('SDK auth origin denied');
    const body = Buffer.from(await exchange.arrayBuffer());
    if (body.length > 65536) throw new Error('SDK auth body limit');
    if (httpProxy) {
      const response = await nativeFetch(exchange.url, { method: 'POST', headers: { 'content-type': exchange.headers.get('content-type') ?? 'application/x-www-form-urlencoded' }, body, proxy: httpProxy, redirect: 'manual', signal: AbortSignal.any([exchange.signal, AbortSignal.timeout(15000)]) });
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error('SDK auth redirect denied'); }
      const chunks = []; let size = 0;
      if (response.body) for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new Error('SDK auth response limit');
        chunks.push(chunk);
      }
      return new Response(Buffer.concat(chunks), { status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' } });
    }
    const addresses = await lookup('auth.openai.com', { all: true });
    if (!addresses.length || addresses.some(value => !publicAddress(value.address))) throw new Error('SDK auth origin denied');
    return await new Promise((resolve, reject) => {
      const exchangeRequest = request(exchange.url, { method: 'POST', family: addresses[0].family, headers: { 'content-type': exchange.headers.get('content-type') ?? 'application/x-www-form-urlencoded', 'content-length': String(body.length) }, signal: exchange.signal, lookup: (_hostname, _options, callback) => callback(null, addresses[0].address, addresses[0].family) }, response => {
        if ((response.statusCode ?? 502) >= 300 && (response.statusCode ?? 502) < 400) { response.resume(); reject(new Error('SDK auth redirect denied')); return; }
        const chunks = []; let size = 0;
        response.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) response.destroy(new Error('SDK auth response limit')); else chunks.push(chunk); });
        response.once('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 502, headers: { 'content-type': response.headers['content-type'] ?? 'application/json' } })));
        response.once('error', () => reject(new Error('SDK auth exchange failed')));
      });
      exchangeRequest.setTimeout(15000, () => exchangeRequest.destroy());
      exchangeRequest.once('error', () => reject(new Error('SDK auth exchange failed')));
      exchangeRequest.end(body);
    });
  };
  const { AuthStorage } = await load('@oh-my-pi/pi-ai/auth-storage');
  async function storage() {
    if (auth) return auth;
    if (!authOpening) authOpening = (async () => {
      const stat = await lstat(config.access.authStorePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error('Existing owned SDK credential store is required');
      const opened = await AuthStorage.create(config.access.authStorePath, { usageProviderResolver: () => undefined, usageLogger: { debug() {}, warn() {} }, configValueResolver: async () => undefined });
      try {
        if (typeof opened.credentials?.reload !== 'function' || typeof opened.oauth?.accessById !== 'function' || typeof opened.oauth?.accounts !== 'function') throw new Error('Strict SDK account APIs are required');
        // create() opens SQLite; the supported local reload populates the account pool without resolving access.
        await opened.credentials.reload();
        auth = opened; return opened;
      } catch (error) { opened.close(); throw error; }
    })().catch(error => { authOpening = undefined; throw error; });
    return authOpening;
  }
  if (config.mode === 'accounts') {
    const store = await storage();
    const accounts = store.oauth.accounts('openai-codex').filter(account => typeof account.accountId === 'string' && account.accountId.length > 0).map(account => ({ accountRowId: account.credentialId, accountFingerprint: fingerprint(account.accountId) }));
    process.stdout.write(JSON.stringify({ ...metadata, accounts }) + '\n'); auth.close(); process.exit(0);
  }
  const boundary = config.boundary;
  if (config.mode !== 'serve' || boundary?.kind !== 'omp-native-account' || boundary.provider !== 'openai-codex' || boundary.sdkVersion !== metadata.sdkVersion || boundary.sdkLockSha256 !== sdkLockSha256 || boundary.catalogSha256 !== catalogSha256 || !isDeepStrictEqual(config.ompModel, metadata.ompModel) || !isDeepStrictEqual(config.prices, metadata.prices)) throw new Error('Native SDK/catalog/pricing preregistration mismatch');
  if (wire.CODEX_BASE_URL !== 'https://chatgpt.com/backend-api') throw new Error('Unapproved native origin');
  if (typeof wire.applyCodexResidencyHeader !== 'function') throw new Error('Native SDK residency API is required');
  const selectedAtStartup = (await storage()).oauth.accounts('openai-codex').find(account => account.credentialId === boundary.accountRowId);
  if (!selectedAtStartup?.accountId || fingerprint(selectedAtStartup.accountId) !== boundary.accountFingerprint) throw new Error('Explicit existing account metadata mismatch');
  metadata.accountMetadataMatched = true;
  const active = new Set();
  const server = createServer((incoming, outgoing) => { void (async () => {
    const fail = (status, error) => { if (outgoing.headersSent) outgoing.destroy(); else { outgoing.writeHead(status, { 'content-type': 'application/json', ...(typeof incoming.headers['x-bench-request-id'] === 'string' ? { 'x-bench-request-id': incoming.headers['x-bench-request-id'] } : {}) }); outgoing.end(JSON.stringify({ error })); } };
    if (incoming.method !== 'POST' || incoming.url !== '/responses' || incoming.headers.authorization !== `Bearer ${config.capability}` || incoming.headers.origin || incoming.headers['chatgpt-account-id'] || !/^[a-f0-9-]{36}$/.test(String(incoming.headers['x-bench-request-id'] ?? '')) || Date.now() >= config.deadline) { incoming.resume(); fail(403, 'native_account_capability_denied'); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, config.deadline - Date.now()));
    let upstream;
    outgoing.once('close', () => { clearTimeout(timer); if (!outgoing.writableFinished) { controller.abort(); upstream?.destroy(); } });
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of incoming) { bytes += chunk.length; if (bytes > 12 * 1024 * 1024) throw new Error('body-limit'); chunks.push(chunk); }
      const body = Buffer.concat(chunks), input = JSON.parse(body.toString('utf8'));
      if (input.model !== 'gpt-6.1-sol' || input.reasoning?.effort !== 'xhigh' || input.service_tier !== 'default' || input.store !== false || input.stream !== true || ['max_output_tokens', 'max_completion_tokens', 'max_tokens', 'previous_response_id', 'conversation'].some(key => key in input)) { fail(403, 'native_account_request_denied'); return; }
      const store = await storage();
      const selected = store.oauth.accounts('openai-codex').find(account => account.credentialId === boundary.accountRowId);
      if (!selected?.accountId || fingerprint(selected.accountId) !== boundary.accountFingerprint) { fail(403, 'native_account_identity_mismatch'); return; }
      let access;
      activeAuthResolutions++;
      try { access = await store.oauth.accessById('openai-codex', boundary.accountRowId, { signal: controller.signal, modelId: 'gpt-6.1-sol', baseUrl: wire.CODEX_BASE_URL }); }
      finally { activeAuthResolutions--; }
      if (!access?.ok || access.credentialId !== boundary.accountRowId || !access.accountId || fingerprint(access.accountId) !== boundary.accountFingerprint || wire.getCodexAccountId(access.accessToken) !== access.accountId) { fail(502, 'native_account_access_unavailable'); return; }
      if (controller.signal.aborted) return;
      const redactor = new TraceRedactor([access.accessToken, access.accountId, config.capability]);
      const headers = { authorization: `Bearer ${access.accessToken}`, 'chatgpt-account-id': access.accountId, 'content-type': 'application/json', 'content-length': String(body.length), accept: 'text/event-stream', 'OpenAI-Beta': wire.OPENAI_HEADER_VALUES.BETA_RESPONSES, originator: wire.OPENAI_HEADER_VALUES.ORIGINATOR_CODEX, version: wire.CODEX_CLIENT_VERSION, 'x-codex-routing-hint': wire.codexRoutingHint('gpt-6.1-sol', 'default') };
      wire.applyCodexResidencyHeader(headers, access.accessToken);
      for (const name of ['session_id', 'conversation_id', 'session-id', 'thread-id', 'x-codex-window-id', 'x-codex-turn-metadata', 'x-client-request-id']) {
        const value = incoming.headers[name]; if (typeof value === 'string' && value.length <= 8192 && !/[\r\n]/.test(value)) headers[name] = value;
      }
      const forwardResponse = (status, contentType, providerRequestId, response) => {
        // Never follow redirects, forward credential headers, or emit upstream diagnostics.
        if (status >= 300 && status < 400) { response.destroy(); fail(502, 'native_account_redirect_denied'); return; }
        outgoing.writeHead(status, { 'content-type': contentType ?? 'application/json', 'x-bench-request-id': incoming.headers['x-bench-request-id'], ...(typeof providerRequestId === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(providerRequestId) ? { 'x-request-id': redactor.text(providerRequestId) } : {}) });
        const decoder = new StringDecoder('utf8'); let pending = '', size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > 32 * 1024 * 1024) { response.destroy(); outgoing.destroy(); return; }
          pending += decoder.write(chunk);
          let newline = pending.indexOf('\n');
          while (newline >= 0) { outgoing.write(redactor.text(pending.slice(0, newline + 1))); pending = pending.slice(newline + 1); newline = pending.indexOf('\n'); }
        });
        response.once('end', () => { outgoing.end(redactor.text(pending + decoder.end())); clearTimeout(timer); });
        response.once('aborted', () => outgoing.destroy()); response.once('error', () => outgoing.destroy());
      };
      if (httpProxy) {
        const pending = { destroy: () => controller.abort() };
        active.add(pending);
        try {
          const response = await nativeFetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST', headers, body, proxy: httpProxy, redirect: 'manual', signal: controller.signal });
          upstream = response.body ? Readable.fromWeb(response.body) : Readable.from([]);
          upstream.once('close', () => { active.delete(pending); clearTimeout(timer); });
          forwardResponse(response.status, response.headers.get('content-type'), response.headers.get('x-request-id'), upstream);
        } catch {
          active.delete(pending); clearTimeout(timer);
          fail(502, controller.signal.aborted ? 'native_account_cancelled' : 'native_account_transport_failed');
        }
        return;
      }
      const addresses = await lookup('chatgpt.com', { all: true });
      if (!addresses.length || addresses.some(value => !publicAddress(value.address))) { fail(403, 'native_account_origin_denied'); return; }
      upstream = request('https://chatgpt.com/backend-api/codex/responses', { method: 'POST', family: addresses[0].family, headers, signal: controller.signal, lookup: (_hostname, _options, callback) => callback(null, addresses[0].address, addresses[0].family) }, response => forwardResponse(response.statusCode ?? 502, response.headers['content-type'], response.headers['x-request-id'], response));
      active.add(upstream); upstream.once('close', () => { active.delete(upstream); clearTimeout(timer); });
      upstream.once('error', () => { clearTimeout(timer); fail(502, controller.signal.aborted ? 'native_account_cancelled' : 'native_account_transport_failed'); });
      upstream.end(body);
    } catch { clearTimeout(timer); fail(502, 'native_account_request_failed'); }
  })(); });
  server.on('error', () => process.exit(1));
  server.listen(config.socketPath, async () => { await chmod(config.socketPath, 0o600); process.stdout.write(JSON.stringify(metadata) + '\n'); });
  const stop = () => { for (const upstream of active) upstream.destroy(); server.closeAllConnections(); server.close(() => { auth?.close(); process.exitCode = 0; }); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
} catch {
  // SDK exceptions can include credential-bearing provider payloads: withhold them entirely.
  auth?.close(); process.stderr.write('Native OMP SDK prerequisite or explicit selection unavailable.\n'); process.exit(1);
}
