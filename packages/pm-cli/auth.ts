import path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { PrivateFileError, privateDirectory, readPrivateFile, removePrivateFile, writePrivateFile } from './private-files.ts';

type Environment = NodeJS.ProcessEnv;
type SavedSession = { version: 1; origin: string; token: string; expiresAt: string };
export type CliAuthentication = { token: string; headers: Record<string, string>; source: 'token' | 'password' | 'saved'; expiresAt?: string };

export class CliAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export function serviceOrigin(value = process.env.PM_API_URL ?? 'http://127.0.0.1:4194'): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new CliAuthError('CLI_INVALID_ARGUMENT', 'PM_API_URL must be an absolute HTTP(S) service origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['/', '/api', '/api/'].includes(url.pathname)) {
    throw new CliAuthError('CLI_INVALID_ARGUMENT', 'Use a service origin without credentials, query, fragment, or path (an optional /api suffix is accepted).');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || (isIP(url.hostname) === 4 && url.hostname.startsWith('127.'));
  if (url.protocol === 'http:' && !loopback) throw new CliAuthError('CLI_INSECURE_SERVICE', 'Remote services require HTTPS; HTTP is allowed only for localhost or a loopback IP address.');
  return url.origin;
}

function sessionFile(origin: string, environment: Environment): string {
  const directory = environment.PM_CLI_SESSION_DIR ?? path.join(environment.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'dovspace', 'pm-cli');
  if (!path.isAbsolute(directory)) throw new CliAuthError('CLI_SESSION_UNSAFE', 'PM_CLI_SESSION_DIR and XDG_CONFIG_HOME must identify an absolute private directory.');
  return path.join(directory, `${createHash('sha256').update(origin).digest('hex')}.json`);
}

function validToken(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43,512}$/.test(token);
}

export async function savedSession(origin: string, environment: Environment = process.env, allowExpired = false): Promise<SavedSession | undefined> {
  let source: string | undefined;
  try { source = await readPrivateFile(sessionFile(origin, environment)); }
  catch (error) {
    if (error instanceof PrivateFileError) throw new CliAuthError('CLI_SESSION_UNSAFE', error.message);
    throw new CliAuthError('CLI_SESSION_UNAVAILABLE', 'Cannot read private CLI session storage.');
  }
  if (source === undefined) return undefined;
  let data: unknown;
  try { data = JSON.parse(source); } catch { throw new CliAuthError('CLI_SESSION_INVALID', 'Saved session is invalid; restore or explicitly remove this origin’s private session file.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CliAuthError('CLI_SESSION_INVALID', 'Saved session is invalid.');
  const record = data as Partial<SavedSession>;
  if (record.version !== 1 || record.origin !== origin || !validToken(record.token) || typeof record.expiresAt !== 'string' || !Number.isFinite(Date.parse(record.expiresAt))) {
    throw new CliAuthError('CLI_SESSION_INVALID', 'Saved session does not match this service or has no valid expiry.');
  }
  if (!allowExpired && Date.parse(record.expiresAt) <= Date.now()) throw new CliAuthError('CLI_SESSION_EXPIRED', 'Saved session expired. Run pm login.');
  return record as SavedSession;
}

async function authRequest(origin: string, route: string, init: RequestInit): Promise<Response> {
  try { return await fetch(`${origin}${route}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
  catch { throw new CliAuthError('CLI_CONNECTION_FAILED', `Cannot reach ${origin}; credentials were not forwarded to a redirect.`); }
}

async function passwordSession(origin: string, email: string, password: string): Promise<CliAuthentication & { expiresAt: string }> {
  const response = await authRequest(origin, '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!response.ok) throw new CliAuthError('CLI_AUTH_FAILED', `Login failed (HTTP ${response.status}).`);
  const payload: unknown = await response.json().catch(() => undefined);
  const cookies = response.headers.getSetCookie();
  const sessionCookies = cookies.filter(cookie => cookie.startsWith('pm_v4_session='));
  const token = sessionCookies.length === 1 ? sessionCookies[0]!.split(';')[0]!.slice('pm_v4_session='.length) : undefined;
  const expiresAt = payload && typeof payload === 'object' && 'expiresAt' in payload ? payload.expiresAt : undefined;
  if (!validToken(token) || typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) {
    throw new CliAuthError('CLI_AUTH_FAILED', 'Login did not return a valid finite session.');
  }
  return { token, headers: { Authorization: `Bearer ${token}` }, expiresAt, source: 'password' };
}

export async function authenticate(origin: string, environment: Environment = process.env): Promise<CliAuthentication> {
  const explicit = environment.PM_SESSION_TOKEN?.trim();
  if (explicit) {
    if (!validToken(explicit)) throw new CliAuthError('CLI_AUTH_FAILED', 'PM_SESSION_TOKEN is not a valid session token.');
    return { token: explicit, headers: { Authorization: `Bearer ${explicit}` }, source: 'token' };
  }
  const email = environment.PM_EMAIL?.trim();
  const password = environment.PM_PASSWORD;
  if (email && password) return passwordSession(origin, email, password);
  const saved = await savedSession(origin, environment);
  if (saved) return { token: saved.token, headers: { Authorization: `Bearer ${saved.token}` }, source: 'saved', expiresAt: saved.expiresAt };
  throw new CliAuthError('CLI_AUTH_REQUIRED', 'Run pm login, or set PM_SESSION_TOKEN or both PM_EMAIL and PM_PASSWORD.');
}

export async function revokeSession(origin: string, token: string): Promise<void> {
  const response = await authRequest(origin, '/api/v1/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
  // An unauthenticated session is already expired or revoked; do not claim a new revocation.
  if (response.status === 401) return;
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !payload || typeof payload !== 'object' || !('loggedOut' in payload) || payload.loggedOut !== true) {
    throw new CliAuthError('CLI_LOGOUT_FAILED', `Server did not confirm logout (HTTP ${response.status}); local credentials were retained.`);
  }
}

async function passwordPrompt(): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || !process.stderr.isTTY) throw new CliAuthError('CLI_AUTH_REQUIRED', 'Interactive login requires a terminal; automation must provide both PM_EMAIL and PM_PASSWORD.');
  const wasRaw = input.isRaw;
  const wasPaused = input.isPaused();
  // The backend's ES2023 library target does not expose Promise.withResolvers.
  return new Promise<string>((resolve, reject) => {
    let value = '';
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      input.removeListener('keypress', onKey);
      input.removeListener('end', onEnd);
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
      process.stderr.write('\n');
      if (error) reject(error); else resolve(value);
      value = '';
    };
    const onEnd = (): void => finish(new CliAuthError('CLI_LOGIN_CANCELLED', 'Login cancelled.'));
    const onKey = (text: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean }): void => {
      if ((key.ctrl && ['c', 'd'].includes(key.name ?? '')) || key.name === 'escape') return onEnd();
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace') { value = value.replace(/[\s\S]$/u, ''); return; }
      if (!key.ctrl && !key.meta && text && !/[\u0000-\u001f\u007f-\u009f]/u.test(text)) value += text;
    };
    emitKeypressEvents(input);
    input.on('keypress', onKey);
    input.once('end', onEnd);
    input.setRawMode(true);
    input.resume();
    process.stderr.write('Password: ');
  });
}

export async function loginCli(emailOption?: string, environment: Environment = process.env): Promise<{ origin: string; expiresAt: string }> {
  const origin = serviceOrigin(environment.PM_API_URL);
  const filename = sessionFile(origin, environment);
  try { await privateDirectory(path.dirname(filename), true); await readPrivateFile(filename); }
  catch { throw new CliAuthError('CLI_SESSION_UNSAFE', 'Private session storage is unavailable or unsafe; no login was attempted.'); }
  let email = emailOption?.trim() || environment.PM_EMAIL?.trim();
  if (!email) {
    if (!process.stdin.isTTY || !process.stderr.isTTY) throw new CliAuthError('CLI_AUTH_REQUIRED', 'Interactive login requires a terminal; set both PM_EMAIL and PM_PASSWORD for automation.');
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try { email = await prompt.question('Email: '); }
    finally { prompt.close(); }
  }
  let password = environment.PM_PASSWORD || await passwordPrompt();
  const session = await passwordSession(origin, email.trim(), password).finally(() => { password = ''; });
  try {
    await writePrivateFile(filename, JSON.stringify({ version: 1, origin, token: session.token, expiresAt: session.expiresAt } satisfies SavedSession) + '\n');
  } catch {
    try { await revokeSession(origin, session.token); }
    catch { throw new CliAuthError('CLI_SESSION_SAVE_FAILED', 'Session was not saved and server revocation could not be confirmed; it expires at the server-provided deadline.'); }
    throw new CliAuthError('CLI_SESSION_SAVE_FAILED', 'Session could not be saved; the new server session is no longer authenticated.');
  }
  return { origin, expiresAt: session.expiresAt };
}

export async function logoutCli(environment: Environment = process.env): Promise<{ origin: string; status: 'logged_out' | 'no_session' }> {
  const origin = serviceOrigin(environment.PM_API_URL);
  const saved = await savedSession(origin, environment, true);
  const explicit = environment.PM_SESSION_TOKEN?.trim();
  let selected: CliAuthentication | undefined;
  if (explicit || (environment.PM_EMAIL?.trim() && environment.PM_PASSWORD)) selected = await authenticate(origin, environment);
  else if (saved) selected = { token: saved.token, headers: { Authorization: `Bearer ${saved.token}` }, source: 'saved' };
  if (!selected) return { origin, status: 'no_session' };
  await revokeSession(origin, selected.token);
  if (saved && saved.token !== selected.token) await revokeSession(origin, saved.token);
  try { await removePrivateFile(sessionFile(origin, environment)); }
  catch { throw new CliAuthError('CLI_SESSION_REMOVE_FAILED', 'Server logout completed, but this origin’s private local session could not be removed.'); }
  return { origin, status: 'logged_out' };
}
