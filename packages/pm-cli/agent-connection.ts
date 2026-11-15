import path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { inspect } from 'node:util';
import { emitKeypressEvents } from 'node:readline';
import { PrivateFileError, privateDirectory, readPrivateFile, removePrivateFile, writePrivateFile } from './private-files.ts';

const COOKIE_NAME = 'agent_v4_access';
const LOCAL_LIFETIME = 8 * 60 * 60 * 1000;
const REQUEST_TIMEOUT = 15_000;
type Environment = NodeJS.ProcessEnv;
export type AgentConnectionOptions = { origin?: string; environment?: Environment; signal?: AbortSignal };
export type AgentLoginOptions = AgentConnectionOptions & { token?: string; tokenFile?: string; tokenStdin?: boolean };
/** Explicit, request-local native PM authority; never an Agent credential or delegated MCP token. */
export type AgentPmContext = { origin: string; headers: Record<string, string> };
export type AgentMcpClientsOptions = AgentConnectionOptions & { pmContext: AgentPmContext } & ({ action: 'list' } | { action: 'revoke'; id: string; csrfToken: string });
type Target = { origin: string; serviceUrl: string; prefix: string; loopback: boolean };
type StoredCredential = { version: 1; identity: 'agent_operator'; serviceUrl: string; cookie: string; createdAt: string; localExpiresAt: string };
type AccessStatus = { authorized: boolean; configured: boolean; approvalMode: 'ask' | 'auto-approve'; message: string | null };
export type AgentConnectionInfo = {
  origin: string; serviceUrl: string; serverExpiresAt: null;
  approvalMode: AccessStatus['approvalMode'];
  transports: { json: true; response: true; sse: true; ndjson: true; websocket: true };
} & (
  | { identity: 'agent_operator'; credentialSource: 'saved'; localExpiresAt: string; serverRevocation: 'deployment_token_rotation' }
  | { identity: 'local_unprotected'; credentialSource: 'none'; localExpiresAt: null; serverRevocation: null }
);
export type AgentWebSocket = { close(code?: number, reason?: string): void; once?(event: 'close', listener: () => void): unknown };
export type AgentWebSocketFactory<T extends AgentWebSocket> = (url: string, options: { headers: Record<string, string>; followRedirects: false }) => T;

export class AgentConnectionError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message); this.name = 'AgentConnectionError'; this.code = code;
    if (status !== undefined) this.status = status;
  }
}

function target(value: string | undefined): Target {
  let url: URL;
  try { url = new URL(value ?? ''); }
  catch { throw new AgentConnectionError('AGENT_ORIGIN_REQUIRED', 'Set PM_AGENT_URL to the explicit Agent service URL (direct origin or gateway /agent).'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['/', '/api', '/api/', '/agent', '/agent/', '/agent/api', '/agent/api/'].includes(url.pathname)) {
    throw new AgentConnectionError('AGENT_INVALID_ORIGIN', 'Agent service URL must be an HTTP(S) origin or gateway /agent, without credentials, query, or fragment.');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || (isIP(url.hostname) === 4 && url.hostname.startsWith('127.'));
  if (url.protocol === 'http:' && !loopback) throw new AgentConnectionError('AGENT_INSECURE_ORIGIN', 'Agent credentials require HTTPS except for a literal loopback host.');
  const prefix = url.pathname.startsWith('/agent') ? '/agent' : '';
  return { origin: url.origin, serviceUrl: `${url.origin}${prefix}`, prefix, loopback };
}

export function agentServiceOrigin(value = process.env.PM_AGENT_URL): string { return target(value).origin; }
export function agentServiceUrl(value = process.env.PM_AGENT_URL): string { return target(value).serviceUrl; }
function optionsTarget(options: AgentConnectionOptions): Target { return target(options.origin ?? (options.environment ?? process.env).PM_AGENT_URL); }

function credentialFile(destination: Target, environment: Environment): string {
  const directory = environment.PM_AGENT_SESSION_DIR ?? path.join(environment.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'dovspace', 'pm-agent-cli');
  if (!path.isAbsolute(directory)) throw new AgentConnectionError('AGENT_STORAGE_UNSAFE', 'PM_AGENT_SESSION_DIR and XDG_CONFIG_HOME must identify an absolute private directory.');
  return path.join(directory, `${createHash('sha256').update(destination.serviceUrl).digest('hex')}.json`);
}
function storageError(error: unknown): AgentConnectionError {
  return new AgentConnectionError(error instanceof PrivateFileError ? 'AGENT_STORAGE_UNSAFE' : 'AGENT_STORAGE_UNAVAILABLE', 'Agent private credential storage is unavailable or unsafe; it was not replaced.');
}
async function readCredential(destination: Target, environment: Environment, allowExpired = false): Promise<StoredCredential | undefined> {
  let source: string | undefined;
  try { source = await readPrivateFile(credentialFile(destination, environment)); } catch (error) { throw storageError(error); }
  if (source === undefined) return undefined;
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new AgentConnectionError('AGENT_CREDENTIAL_INVALID', 'Saved Agent credential is invalid.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentConnectionError('AGENT_CREDENTIAL_INVALID', 'Saved Agent credential is invalid.');
  const record = value as Partial<StoredCredential>;
  const created = typeof record.createdAt === 'string' ? Date.parse(record.createdAt) : NaN;
  const expires = typeof record.localExpiresAt === 'string' ? Date.parse(record.localExpiresAt) : NaN;
  if (record.version !== 1 || record.identity !== 'agent_operator' || record.serviceUrl !== destination.serviceUrl || !validCookie(record.cookie) || !Number.isFinite(created) || !Number.isFinite(expires) || expires <= created || expires - created > LOCAL_LIFETIME || created > Date.now()) {
    throw new AgentConnectionError('AGENT_CREDENTIAL_INVALID', 'Saved Agent credential does not match this service and independent identity, or has no valid finite local deadline.');
  }
  if (!allowExpired && expires <= Date.now()) throw new AgentConnectionError('AGENT_CREDENTIAL_EXPIRED', 'Saved Agent credential reached its local retention deadline. Run pm agent login.');
  return record as StoredCredential;
}
function validCookie(value: unknown): value is string { return typeof value === 'string' && /^agent_v4_access=[a-f0-9]{64}$/.test(value); }
function authHeaders(destination: Target, cookie?: string): Headers {
  const headers = new Headers({ Accept: 'application/json', Origin: destination.origin });
  if (cookie) headers.set('Cookie', cookie);
  return headers;
}
function combinedSignal(signal?: AbortSignal, deadline?: AbortSignal): AbortSignal {
  return AbortSignal.any([...(signal ? [signal] : []), ...(deadline ? [deadline] : []), AbortSignal.timeout(REQUEST_TIMEOUT)]);
}
async function accessRequest(destination: Target, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  let response: Response;
  try { response = await fetch(`${destination.serviceUrl}/api/access`, { ...init, redirect: 'manual', credentials: 'omit', signal: combinedSignal(signal) }); }
  catch { throw new AgentConnectionError('AGENT_CONNECTION_FAILED', 'Agent connection failed; no request was retried and credentials were not forwarded to a redirect.'); }
  if (response.status >= 300 && response.status < 400 || response.redirected || response.url && new URL(response.url).origin !== destination.origin) {
    await response.body?.cancel();
    throw new AgentConnectionError('AGENT_REDIRECT_REJECTED', 'Agent redirects are forbidden; no credentials were forwarded.');
  }
  return response;
}
async function accessStatus(destination: Target, cookie: string | undefined, signal?: AbortSignal): Promise<AccessStatus> {
  const response = await accessRequest(destination, { headers: authHeaders(destination, cookie) }, signal);
  if (!response.ok) { await response.body?.cancel(); throw new AgentConnectionError('AGENT_ACCESS_DENIED', `Agent access check failed (HTTP ${response.status}).`, response.status); }
  const value: unknown = await response.json().catch(() => undefined);
  if (!value || typeof value !== 'object' || !('authorized' in value) || typeof value.authorized !== 'boolean' || !('configured' in value) || typeof value.configured !== 'boolean' || !('approvalMode' in value) || !['ask', 'auto-approve'].includes(String(value.approvalMode))) {
    throw new AgentConnectionError('AGENT_PROTOCOL_INVALID', 'Agent access discovery did not return the existing operator authentication contract.');
  }
  return { authorized: value.authorized, configured: value.configured, approvalMode: value.approvalMode as AccessStatus['approvalMode'], message: null };
}
function requireOperatorAccess(status: AccessStatus): void {
  if (!status.configured) throw new AgentConnectionError('AGENT_AUTH_NOT_CONFIGURED', 'Authenticated Agent access requires a configured token; unprotected access is allowed only for an explicit loopback target.');
  if (!status.authorized) throw new AgentConnectionError('AGENT_ACCESS_DENIED', 'Agent credential is invalid or revoked; run pm agent login.', 401);
}
function connectionInfo(destination: Target, record: StoredCredential | undefined, status: AccessStatus): AgentConnectionInfo {
  const identity = record
    ? { identity: 'agent_operator' as const, credentialSource: 'saved' as const, localExpiresAt: record.localExpiresAt, serverRevocation: 'deployment_token_rotation' as const }
    : { identity: 'local_unprotected' as const, credentialSource: 'none' as const, localExpiresAt: null, serverRevocation: null };
  return { origin: destination.origin, serviceUrl: destination.serviceUrl, ...identity, serverExpiresAt: null, approvalMode: status.approvalMode, transports: { json: true, response: true, sse: true, ndjson: true, websocket: true } };
}

function pmContextToken(destination: Target, context: AgentPmContext): string {
  const pm = target(context.origin);
  const agentHost = new URL(destination.origin).hostname, pmHost = new URL(pm.origin).hostname;
  const localAgent = agentHost === 'localhost' || agentHost === '[::1]' || isIP(agentHost) === 4 && agentHost.startsWith('127.');
  const localPm = pmHost === 'localhost' || pmHost === '[::1]' || isIP(pmHost) === 4 && pmHost.startsWith('127.');
  if (pm.prefix || pm.origin !== destination.origin && !(localAgent && localPm)) throw new AgentConnectionError('AGENT_PM_ORIGIN_MISMATCH', 'Explicit PM authority must belong to the same public origin or a literal-loopback PM/Agent service pair.');
  const headers = new Headers(context.headers);
  const bearer = headers.get('authorization');
  if ([...headers.keys()].length !== 1 || !bearer || !/^Bearer [A-Za-z0-9_-]{43,512}$/u.test(bearer)) throw new AgentConnectionError('AGENT_PM_IDENTITY_REQUIRED', 'Provide the independent native PM session authority explicitly; Agent, MCP/service credentials and arbitrary cookies cannot substitute.');
  return bearer.slice('Bearer '.length);
}

// These are the existing PM-aware routes, not a prefix grant to future Agent APIs.
const PM_CONTEXT_ROUTES: readonly (readonly [string, RegExp])[] = [
  ['GET', /^\/api\/chat\/threads(?:\/[^/]+(?:\/(?:execution|history|generations|queue|stash|actions))?)?$/u],
  ['POST', /^\/api\/chat(?:\/threads(?:\/[^/]+\/(?:native-session\/restart|sidebar|regenerate-title|cancel|queue(?:\/[^/]+)?|stash|steer|rewind))?)?$/u],
  ['PUT', /^\/api\/chat\/threads\/[^/]+(?:\/history)?$/u],
  ['DELETE', /^\/api\/chat\/threads\/[^/]+(?:\/stash\/[^/]+)?$/u],
  ['GET', /^\/api\/chat\/threads\/[^/]+\/(?:messages\/[^/]+\/context|saved-drafts\/(?:queue|stash)\/[^/]+)$/u],
  ['GET', /^\/api\/chat\/generations\/[^/]+\/(?:output|items\/[^/]+\/output|subagents\/[^/]+\/session)$/u],
  ['GET', /^\/api\/chat\/streams\/[^/]+$/u],
  ['POST', /^\/api\/chat\/generations\/[^/]+\/(?:continue|fork|native-fork|requests\/[^/]+\/respond|plans\/[^/]+\/implement)$/u],
  ['GET', /^\/api\/pm-tools\/(?:workspaces|threads\/[^/]+\/(?:calls|changes)|calls\/[^/]+)$/u],
  ['POST', /^\/api\/pm-tools\/calls\/[^/]+\/(?:reconcile|approve|reject)$/u],
  ['GET', /^\/api\/pm-(?:capabilities|core-changes(?:\/[^/]+)?)$/u],
  ['POST', /^\/api\/pm-core-changes\/refresh$/u],
  ['GET', /^\/api\/task-deliveries(?:\/[^/]+(?:\/(?:brief|preview))?)?$/u],
  ['POST', /^\/api\/task-deliveries(?:\/[^/]+\/(?:actions|preview))?$/u],
  ['GET', /^\/api\/task-workflows(?:\/runs\/[^/]+)?$/u],
  ['POST', /^\/api\/task-workflows\/(?:definitions|runs(?:\/[^/]+\/control)?)$/u],
  ['GET', /^\/api\/project-roadmap-deliveries$/u],
  ['GET', /^\/api\/project-app-previews\/[^/]+$/u],
  ['POST', /^\/api\/project-app-previews\/[^/]+$/u],
  ['GET', /^\/api\/extensions\/contexts(?:\/[^/]+\/events)?$/u],
  ['POST', /^\/api\/extensions\/contexts\/[^/]+\/(?:invoke|uploads)$/u],
  ['GET', /^\/api\/mcp-apps\/[^/]+\/[^/]+\/(?:snapshot|tools)$/u],
  ['POST', /^\/api\/mcp-apps\/[^/]+\/[^/]+\/(?:call|resource|context)$/u],
];

function operatorToken(value: string): string {
  const token = value.trim();
  if (token.length < 32 || Buffer.byteLength(token) > 2048 || /[\u0000-\u001f\u007f-\u009f]/u.test(token) || /^pm-(?:mcp|automation|service)(?:-|\.)/i.test(token)) {
    throw new AgentConnectionError('AGENT_TOKEN_INVALID', 'Provide the explicitly obtained Agent operator access token, not a PM session or delegated MCP/service credential.');
  }
  return token;
}
async function hiddenToken(signal?: AbortSignal): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || !process.stderr.isTTY) throw new AgentConnectionError('AGENT_TOKEN_REQUIRED', 'Agent login needs a terminal, --token-file with an explicit private file, or explicit --token-stdin. Never pass a token in argv.');
  const wasRaw = input.isRaw, wasPaused = input.isPaused();
  return new Promise((resolve, reject) => {
    let value = '', settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true; input.removeListener('keypress', onKey); input.removeListener('end', cancel); signal?.removeEventListener('abort', cancel);
      input.setRawMode(wasRaw); if (wasPaused) input.pause(); process.stderr.write('\n');
      if (error) reject(error); else resolve(value);
      value = '';
    };
    const cancel = (): void => finish(new AgentConnectionError('AGENT_LOGIN_CANCELLED', 'Agent login cancelled.'));
    const onKey = (text: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean }): void => {
      if ((key.ctrl && ['c', 'd'].includes(key.name ?? '')) || key.name === 'escape') return cancel();
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace') { value = value.replace(/[\s\S]$/u, ''); return; }
      if (!key.ctrl && !key.meta && text && !/[\u0000-\u001f\u007f-\u009f]/u.test(text)) {
        if (Buffer.byteLength(value) + Buffer.byteLength(text) > 2048) return finish(new AgentConnectionError('AGENT_TOKEN_INVALID', 'Agent token input exceeds its size limit.'));
        value += text;
      }
    };
    if (signal?.aborted) return cancel();
    emitKeypressEvents(input); input.on('keypress', onKey); input.once('end', cancel); signal?.addEventListener('abort', cancel, { once: true });
    input.setRawMode(true); input.resume(); process.stderr.write('Agent operator token: ');
  });
}
async function loginToken(options: AgentLoginOptions): Promise<string> {
  const sources = Number(options.token !== undefined) + Number(options.tokenFile !== undefined) + Number(options.tokenStdin === true);
  if (sources > 1) throw new AgentConnectionError('AGENT_TOKEN_AMBIGUOUS', 'Choose exactly one explicit Agent token input channel.');
  if (options.token !== undefined) return operatorToken(options.token);
  if (options.tokenFile !== undefined) {
    if (!path.isAbsolute(options.tokenFile)) throw new AgentConnectionError('AGENT_TOKEN_FILE_UNSAFE', 'Agent token input file must be an explicit absolute private file.');
    let source: string | undefined;
    try { source = await readPrivateFile(options.tokenFile); } catch { throw new AgentConnectionError('AGENT_TOKEN_FILE_UNSAFE', 'Agent token input file is unavailable or unsafe.'); }
    if (source === undefined) throw new AgentConnectionError('AGENT_TOKEN_REQUIRED', 'Agent token input file does not exist.');
    return operatorToken(source);
  }
  if (options.tokenStdin) {
    if (process.stdin.isTTY) throw new AgentConnectionError('AGENT_TOKEN_STDIN_UNSAFE', '--token-stdin requires a non-terminal private input stream.');
    let input = '';
    const abort = (): void => { process.stdin.destroy(new AgentConnectionError('AGENT_LOGIN_CANCELLED', 'Agent login cancelled.')); };
    options.signal?.throwIfAborted(); options.signal?.addEventListener('abort', abort, { once: true });
    try {
      for await (const chunk of process.stdin) {
        input += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        if (Buffer.byteLength(input) > 2048) throw new AgentConnectionError('AGENT_TOKEN_INVALID', 'Agent token input exceeds its size limit.');
      }
      return operatorToken(input);
    } finally { input = ''; options.signal?.removeEventListener('abort', abort); }
  }
  return operatorToken(await hiddenToken(options.signal));
}

export async function agentLogin(options: AgentLoginOptions = {}): Promise<AgentConnectionInfo> {
  const destination = optionsTarget(options), environment = options.environment ?? process.env;
  const filename = credentialFile(destination, environment);
  try { await privateDirectory(path.dirname(filename), true); await readPrivateFile(filename); } catch (error) { throw storageError(error); }
  let token = await loginToken(options);
  const headers = authHeaders(destination); headers.set('Content-Type', 'application/json');
  const response = await accessRequest(destination, { method: 'POST', headers, body: JSON.stringify({ token }) }, options.signal).finally(() => { token = ''; });
  if (!response.ok) { await response.body?.cancel(); throw new AgentConnectionError('AGENT_LOGIN_DENIED', `Agent operator login failed (HTTP ${response.status}).`, response.status); }
  const payload: unknown = await response.json().catch(() => undefined);
  const cookies = response.headers.getSetCookie().filter(cookie => cookie.startsWith(`${COOKIE_NAME}=`));
  const issued = cookies.length === 1 ? cookies[0] : undefined;
  const cookie = issued?.split(';')[0];
  if (!payload || typeof payload !== 'object' || !('authorized' in payload) || payload.authorized !== true || !validCookie(cookie) || !issued || !/;\s*HttpOnly(?:;|$)/i.test(issued) || !/;\s*SameSite=Strict(?:;|$)/i.test(issued) || !/;\s*Path=\/(?:;|$)/i.test(issued) || destination.origin.startsWith('https:') && !/;\s*Secure(?:;|$)/i.test(issued)) {
    throw new AgentConnectionError('AGENT_PROTOCOL_INVALID', 'Agent login did not issue the existing private operator cookie. No credential was saved.');
  }
  const status = await accessStatus(destination, cookie, options.signal);
  requireOperatorAccess(status);
  const created = Date.now();
  const record: StoredCredential = { version: 1, identity: 'agent_operator', serviceUrl: destination.serviceUrl, cookie, createdAt: new Date(created).toISOString(), localExpiresAt: new Date(created + LOCAL_LIFETIME).toISOString() };
  try { await writePrivateFile(filename, `${JSON.stringify(record)}\n`); }
  catch { throw new AgentConnectionError('AGENT_CREDENTIAL_SAVE_FAILED', 'Agent credential was not saved. Existing server cookies have no individual revocation; deployment token rotation invalidates any issued copies.'); }
  closeTargetConnections(destination.serviceUrl);
  return connectionInfo(destination, record, status);
}

const liveConnections = new Map<string, Set<AgentConnection>>();
function closeTargetConnections(serviceUrl: string): void {
  for (const connection of liveConnections.get(serviceUrl) ?? []) connection.close();
  liveConnections.delete(serviceUrl);
}

/** Internal family transport only: no CLI command accepts a user-selected HTTP path or method. */
export class AgentConnection {
  readonly #destination: Target;
  readonly #info: AgentConnectionInfo;
  #cookie: string | undefined;
  #closed = false;
  #deniedStatus: number | undefined;
  readonly #lifetime = new AbortController();
  readonly #expiryTimer: NodeJS.Timeout | undefined;
  readonly #sockets = new Set<AgentWebSocket>();
  private constructor(destination: Target, record: StoredCredential | undefined, status: AccessStatus) {
    this.#destination = destination; this.#cookie = record?.cookie; this.#info = connectionInfo(destination, record, status);
    if (record) {
      this.#expiryTimer = setTimeout(() => this.close(), Math.max(0, Date.parse(record.localExpiresAt) - Date.now())); this.#expiryTimer.unref();
    }
    const connections = liveConnections.get(destination.serviceUrl) ?? new Set<AgentConnection>(); connections.add(this); liveConnections.set(destination.serviceUrl, connections);
  }
  static async connect(options: AgentConnectionOptions = {}): Promise<AgentConnection> {
    const destination = optionsTarget(options);
    // Discover the existing local service policy without reading or sending any identity.
    if (destination.loopback) {
      const local = await accessStatus(destination, undefined, options.signal);
      if (!local.configured) {
        if (!local.authorized) throw new AgentConnectionError('AGENT_ACCESS_DENIED', 'Agent did not authorize local access; no credential or protection setting was changed.', 401);
        return new AgentConnection(destination, undefined, local);
      }
    }
    const record = await readCredential(destination, options.environment ?? process.env);
    if (!record) throw new AgentConnectionError('AGENT_IDENTITY_REQUIRED', 'Run pm agent login for this explicit Agent service; PM and MCP credentials cannot substitute.');
    const status = await accessStatus(destination, record.cookie, options.signal);
    requireOperatorAccess(status);
    if (Date.parse(record.localExpiresAt) <= Date.now()) throw new AgentConnectionError('AGENT_CREDENTIAL_EXPIRED', 'Saved Agent credential reached its local retention deadline during connection.');
    return new AgentConnection(destination, record, status);
  }
  get origin(): string { return this.#destination.origin; }
  get serviceUrl(): string { return this.#destination.serviceUrl; }
  get info(): AgentConnectionInfo { return { ...this.#info, transports: { ...this.#info.transports } }; }
  toJSON(): AgentConnectionInfo { return this.info; }
  [inspect.custom](): AgentConnectionInfo { return this.info; }
  #requireOpen(): void {
    if (this.#info.localExpiresAt !== null && Date.parse(this.#info.localExpiresAt) <= Date.now()) { this.close(); throw new AgentConnectionError('AGENT_CREDENTIAL_EXPIRED', 'Agent credential reached its local retention deadline.'); }
    if (this.#closed) throw new AgentConnectionError('AGENT_CONNECTION_CLOSED', 'Agent connection is closed.');
    if (this.#deniedStatus !== undefined) throw new AgentConnectionError('AGENT_ACCESS_DENIED', 'Agent connection has received an authorization denial.', this.#deniedStatus);
  }
  #url(route: string, socket = false): URL {
    this.#requireOpen();
    if (!route.startsWith('/api/') || /[\\#\u0000-\u0020\u007f]/u.test(route)) throw new AgentConnectionError('AGENT_INVALID_ROUTE', 'Agent family requests require an internal /api/ route.');
    const rawPath = route.split('?', 1)[0]!;
    let decoded: string;
    try { decoded = decodeURIComponent(rawPath); } catch { throw new AgentConnectionError('AGENT_INVALID_ROUTE', 'Agent route encoding is invalid.'); }
    if (/%(?:2f|5c|25)/iu.test(rawPath) || /[\\\u0000-\u001f\u007f]/u.test(decoded) || /(?:^|\/)\.{1,2}(?:\/|$)/u.test(decoded)) throw new AgentConnectionError('AGENT_INVALID_ROUTE', 'Agent route segments must be encoded individually without path escapes.');
    const url = new URL(`${this.#destination.serviceUrl}${route}`);
    if (url.origin !== this.origin || url.pathname !== `${this.#destination.prefix}${rawPath}` || /^\/api\/(?:access|v1|mcp|internal)(?:\/|$)/u.test(decoded) || socket && rawPath !== '/api/inspector/terminal') {
      throw new AgentConnectionError('AGENT_INVALID_ROUTE', 'Agent requests cannot cross the bound origin, identity, or transport namespace.');
    }
    for (const key of url.searchParams.keys()) if (/(?:token|secret|password|authorization|cookie|credential)/i.test(key)) throw new AgentConnectionError('AGENT_SECRET_IN_URL', 'Credentials must never be placed in an Agent URL.');
    if (socket) url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url;
  }
  async request(route: string, init: RequestInit = {}, pmContext?: AgentPmContext): Promise<Response> {
    const url = this.#url(route), headers = new Headers(init.headers);
    for (const key of headers.keys()) if (/^(?:authorization|cookie|host|origin|referer|proxy-authorization|forwarded|x-forwarded-.*|sec-.*|x-pm-.*)$/i.test(key)) throw new AgentConnectionError('AGENT_IDENTITY_OVERRIDE', 'Agent family requests cannot override operator identity or origin headers.');
    if (init.credentials && init.credentials !== 'omit' || init.redirect && init.redirect !== 'manual') throw new AgentConnectionError('AGENT_IDENTITY_OVERRIDE', 'Agent requests cannot enable ambient credentials or redirects.');
    if (this.#cookie) headers.set('Cookie', this.#cookie);
    headers.set('Origin', this.origin);
    if (pmContext) {
      const method = (init.method ?? 'GET').toUpperCase(), pathname = url.pathname.slice(this.#destination.prefix.length);
      if (!PM_CONTEXT_ROUTES.some(([allowed, pattern]) => allowed === method && pattern.test(pathname))) throw new AgentConnectionError('AGENT_PM_CONTEXT_ROUTE_DENIED', 'PM authority may be attached only to an existing finite PM-aware Agent operation.');
      const token = pmContextToken(this.#destination, pmContext);
      headers.set('Authorization', `Bearer ${token}`);
      headers.set('Cookie', `${this.#cookie ? `${this.#cookie}; ` : ''}pm_v4_session=${token}`);
    }
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');
    let response: Response;
    try { response = await fetch(url, { ...init, headers, credentials: 'omit', redirect: 'manual', signal: AbortSignal.any([this.#lifetime.signal, ...(init.signal ? [init.signal] : [])]) }); }
    catch { throw new AgentConnectionError('AGENT_CONNECTION_FAILED', 'Agent request failed or was cancelled; its result may be unknown. It was not retried.'); }
    if (response.status >= 300 && response.status < 400 || response.redirected || response.url && new URL(response.url).origin !== this.origin) { await response.body?.cancel(); throw new AgentConnectionError('AGENT_REDIRECT_REJECTED', 'Agent redirects are forbidden; no credentials were forwarded.'); }
    if ([401, 403].includes(response.status)) {
      this.#deniedStatus = response.status;
      // Closing the fetch lifetime before the family reads the response would
      // destroy the authoritative denial body. Preserve only this bounded body.
      const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
      let bytes = 0;
      const deadline = setTimeout(() => this.close(), REQUEST_TIMEOUT); deadline.unref();
      try {
        if (reader) for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 64 * 1024) throw new Error('Denial response exceeds the supported bound.');
          chunks.push(value);
        }
        return new Response(reader ? Buffer.concat(chunks, bytes) : null, { status: response.status, statusText: response.statusText, headers: response.headers });
      } catch {
        throw new AgentConnectionError('AGENT_DENIAL_BODY_UNAVAILABLE', `Agent denied access (HTTP ${response.status}), but its bounded error body was unavailable.`, response.status);
      } finally {
        clearTimeout(deadline); this.close(); reader?.releaseLock();
      }
    }
    return response;
  }
  async json<T>(route: string, init: RequestInit = {}, pmContext?: AgentPmContext): Promise<T> {
    const response = await this.request(route, { ...init, signal: combinedSignal(init.signal ?? undefined) }, pmContext);
    if (!response.ok) { await response.body?.cancel(); throw new AgentConnectionError('AGENT_REQUEST_FAILED', `Agent request failed (HTTP ${response.status}); no automatic retry was performed.`, response.status); }
    try { return await response.json() as T; } catch { throw new AgentConnectionError('AGENT_PROTOCOL_INVALID', 'Agent response was not complete JSON; the operation was not retried.'); }
  }
  /** The trusted factory must send headers only in the handshake and must not log them. */
  webSocket<T extends AgentWebSocket>(route: string, factory: AgentWebSocketFactory<T>): T {
    const url = this.#url(route, true);
    let socket: T;
    try { socket = factory(url.href, { headers: { Origin: this.origin, ...(this.#cookie ? { Cookie: this.#cookie } : {}) }, followRedirects: false }); }
    catch { throw new AgentConnectionError('AGENT_WEBSOCKET_FAILED', 'Agent WebSocket could not connect; credentials were not included in its URL.'); }
    this.#sockets.add(socket); socket.once?.('close', () => this.#sockets.delete(socket));
    return socket;
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true; this.#cookie = undefined; clearTimeout(this.#expiryTimer); this.#lifetime.abort();
    for (const socket of this.#sockets) { try { socket.close(1000, 'Agent connection closed'); } catch { /* The attachment is already unavailable. */ } }
    this.#sockets.clear();
    const connections = liveConnections.get(this.serviceUrl); connections?.delete(this); if (!connections?.size) liveConnections.delete(this.serviceUrl);
  }
}

export async function connectAgent(options: AgentConnectionOptions = {}): Promise<AgentConnection> { return AgentConnection.connect(options); }
export async function agentStatus(options: AgentConnectionOptions = {}): Promise<AgentConnectionInfo> {
  const connection = await connectAgent(options);
  try { return connection.info; } finally { connection.close(); }
}
export async function agentLogout(options: AgentConnectionOptions = {}): Promise<{ origin: string; serviceUrl: string; status: 'logged_out' | 'no_session'; serverRevoked: false }> {
  const destination = optionsTarget(options), environment = options.environment ?? process.env;
  closeTargetConnections(destination.serviceUrl);
  const record = await readCredential(destination, environment, true);
  if (!record) return { origin: destination.origin, serviceUrl: destination.serviceUrl, status: 'no_session', serverRevoked: false };
  let confirmed = false;
  try {
    const response = await accessRequest(destination, { method: 'DELETE', headers: authHeaders(destination, record.cookie) }, options.signal);
    const value: unknown = await response.json().catch(() => undefined);
    confirmed = response.ok && !!value && typeof value === 'object' && 'authorized' in value && value.authorized === false;
  } catch { confirmed = false; }
  finally {
    try { await removePrivateFile(credentialFile(destination, environment)); } catch { throw new AgentConnectionError('AGENT_CREDENTIAL_REMOVE_FAILED', 'Agent connection was closed, but this service’s private local credential could not be removed.'); }
  }
  if (!confirmed) throw new AgentConnectionError('AGENT_LOGOUT_UNCONFIRMED', 'Local Agent credential was removed, but server cookie clearing was not confirmed. Server revocation requires deployment token rotation.');
  return { origin: destination.origin, serviceUrl: destination.serviceUrl, status: 'logged_out', serverRevoked: false };
}

/** PM-only grant management intentionally bypasses Agent login, exactly as the existing routes do. */
export async function agentMcpClients<T>(options: AgentMcpClientsOptions): Promise<T> {
  if (!['list', 'revoke'].includes(options.action)) throw new AgentConnectionError('AGENT_MCP_MANAGEMENT_INVALID', 'MCP client management supports only explicit list or revoke.');
  const destination = optionsTarget(options), token = pmContextToken(destination, options.pmContext);
  const headers = new Headers({ Accept: 'application/json', Origin: destination.origin, Cookie: `pm_v4_session=${token}` });
  let route = '/api/mcp/clients', body: string | undefined;
  if (options.action === 'revoke') {
    if (!/^[A-Za-z0-9_-]{1,256}$/u.test(options.id) || !/^[A-Za-z0-9_-]{1,128}$/u.test(options.csrfToken)) throw new AgentConnectionError('AGENT_MCP_MANAGEMENT_INVALID', 'MCP revoke requires the original client ID and current same-session management CSRF token.');
    route += `/${encodeURIComponent(options.id)}/revoke`; body = JSON.stringify({ csrfToken: options.csrfToken }); headers.set('Content-Type', 'application/json');
  }
  let response: Response;
  try { response = await fetch(`${destination.serviceUrl}${route}`, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body }), credentials: 'omit', redirect: 'manual', signal: combinedSignal(options.signal) }); }
  catch { throw new AgentConnectionError('AGENT_CONNECTION_FAILED', 'MCP client management connection failed; no action was retried and no credentials were forwarded to a redirect.'); }
  if (response.status >= 300 && response.status < 400 || response.redirected || response.url && new URL(response.url).origin !== destination.origin) { await response.body?.cancel(); throw new AgentConnectionError('AGENT_REDIRECT_REJECTED', 'MCP management redirects are forbidden; no credentials were forwarded.'); }
  if (!response.ok) { await response.body?.cancel(); throw new AgentConnectionError('AGENT_MCP_MANAGEMENT_DENIED', `MCP client management failed (HTTP ${response.status}); no action was retried.`, response.status); }
  try { return await response.json() as T; } catch { throw new AgentConnectionError('AGENT_PROTOCOL_INVALID', 'MCP client management response was not complete JSON; no action was retried.'); }
}
