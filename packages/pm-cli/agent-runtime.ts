import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import type { ReadStream, WriteStream } from 'node:tty';
import WebSocket from 'ws';
import type { TerminalDescriptor, TerminalServerMessage } from '../agent-contracts/src/inspector.ts';
import { connectAgent, type AgentConnection } from './agent-connection.ts';
import { nonempty, parseOptions, textFile, type CliFamily, type CliRuntime } from './runtime.ts';
import { assertPrivatePath, readPrivateJson } from '../../apps/desktop/src/private-state.mjs';

const BASE = '/api/inspector';
const HELP = `  agent files list --session ID [--path RELATIVE]
  agent files read --session ID --path RELATIVE
  agent files search --session ID --query TEXT
  agent files media --session ID --path RELATIVE  (binary stdout; redirect to a file)
  agent git status --session ID
  agent git diff --session ID [--path RELATIVE] [--staged true|false]
  agent terminal list (--session ID | --workspace ID --revision N) [--request-id UUID]
  agent terminal create (--session ID | --workspace ID --revision N) --request-id UUID --service-id UUID [--path RELATIVE] [--cols N --rows N]
  agent terminal get|close --id UUID --service-id UUID
  agent terminal attach --id UUID --service-id UUID [--after-seq N] [--client-id ID] [--close-on-exit true|false]
  agent terminal input --id UUID --service-id UUID (--text TEXT | --file FILE) [--client-id ID]
  agent terminal resize --id UUID --service-id UUID --cols N --rows N [--client-id ID]
  agent browser status|list --desktop-file ABSOLUTE
  agent browser create --desktop-file ABSOLUTE --id ID [--url HTTP_URL]
  agent browser state|close|back|forward|reload|stop|capture|pick|cancel-pick|pip-open|pip-close|devtools --desktop-file ABSOLUTE --id ID
  agent browser navigate --desktop-file ABSOLUTE --id ID --url HTTP_URL
  agent browser open-external --desktop-file ABSOLUTE --url HTTP_URL
  Runtime: local unprotected access or configured Agent login; server-resolved cwd only.
  PTY: Ctrl+] detaches; Ctrl+C is sent to the PTY. OS signals detach, not recreate.
  Browser: requires the matching live LOCAL Electron desktop browser-cli.json; never a headless/remote fallback.`;

type Options = Record<string, string>;
type RuntimeSelection = { threadId?: string; agentWorkspaceId?: string; agentWorkspaceRevision?: number };
type TerminalStreamResult = { terminalId: string; serviceId: string; exitCode?: number; acknowledged?: true; resized?: true; detached?: true };
function fail(message: string, code = 'AGENT_RUNTIME_INVALID'): never { throw Object.assign(new Error(message), { code }); }
function id(value: string | undefined, name: string): string {
  const result = nonempty(value, name);
  if (result.length > 256 || /[\u0000-\u001f\u007f]/u.test(result)) fail(`${name} is invalid`);
  return result;
}
function uuid(value: string | undefined, name: string): string {
  const result = id(value, name);
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(result)) fail(`${name} requires a UUID`);
  return result;
}
function integer(value: string | undefined, name: string, min: number, max: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!value || !/^\d+$/u.test(value)) fail(`${name} requires an integer between ${min} and ${max}`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) fail(`${name} requires an integer between ${min} and ${max}`);
  return result;
}
function boolean(value: string | undefined, name: string, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (!['true', 'false'].includes(value)) fail(`${name} requires true or false`);
  return value === 'true';
}
function relative(value = ''): string {
  if (value.length > 4096 || value.includes('\0') || /^[\\/]|^[a-z]:/iu.test(value) || value.replaceAll('\\', '/').split('/').includes('..')) fail('--path must stay relative to the server-resolved execution root');
  return value;
}
function query(route: string, fields: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) params.set(key, value);
  return `${route}?${params}`;
}
async function response(connection: AgentConnection, route: string, init?: RequestInit): Promise<Response> {
  const result = await connection.request(route, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000) });
  if (result.ok) return result;
  // Preserve finite service error codes (not arbitrary bodies or native errors).
  const body: unknown = await result.json().catch(() => null);
  const code = body && typeof body === 'object' && 'code' in body && typeof body.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/u.test(body.code) ? body.code : 'agent_request_failed';
  fail(`Agent runtime request failed (HTTP ${result.status}, ${code}); no operation was retried.`, code);
}
async function json<T>(connection: AgentConnection, route: string, init?: RequestInit): Promise<T> {
  const result = await response(connection, route, init);
  return await result.json() as T;
}
function body(value: unknown): RequestInit { return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }; }
function selectionOptions(options: Options): RuntimeSelection {
  if (options.session !== undefined) {
    if (options.workspace !== undefined || options.revision !== undefined) fail('Choose --session OR --workspace with --revision');
    return { threadId: id(options.session, '--session') };
  }
  return { agentWorkspaceId: id(options.workspace, '--workspace'), agentWorkspaceRevision: integer(options.revision, '--revision', 1, Number.MAX_SAFE_INTEGER) };
}
async function selection(connection: AgentConnection, selected: RuntimeSelection) {
  if (!selected.threadId) return { scope: 'workspace' as const, agentWorkspaceId: selected.agentWorkspaceId!, agentWorkspaceRevision: selected.agentWorkspaceRevision! };
  const { environment } = await json<{ environment: { agentWorkspaceId: string | null; agentWorkspaceRevision: number | null; executionPath: string | null } }>(connection, `/api/chat/threads/${encodeURIComponent(selected.threadId)}/execution`);
  if (!environment.agentWorkspaceId || !environment.agentWorkspaceRevision || !environment.executionPath) fail('This Session has no server-owned code execution environment.', 'code_environment_required');
  return { scope: 'session' as const, agentWorkspaceId: environment.agentWorkspaceId, agentWorkspaceRevision: environment.agentWorkspaceRevision, threadId: selected.threadId };
}
async function descriptor(connection: AgentConnection, terminalId: string, serviceId: string): Promise<TerminalDescriptor> {
  const { terminal } = await json<{ terminal: TerminalDescriptor }>(connection, `${BASE}/terminals/${encodeURIComponent(terminalId)}`);
  if (terminal.id !== terminalId || terminal.serviceId !== serviceId) fail('Terminal service lifetime changed; the original PTY was not restored or rerun.', 'terminal_service_changed');
  return terminal;
}

export type TerminalIo = {
  input: NodeJS.ReadStream; output: NodeJS.WriteStream; error: Pick<NodeJS.WriteStream, 'write'>;
  signals: Pick<NodeJS.Process, 'on' | 'removeListener'>;
};
/** One real attachment, without reconnect or write replay. Server owns the PTY, caller owns this socket. */
export async function terminalStream(connection: AgentConnection, terminal: TerminalDescriptor, mode: 'attach' | 'input' | 'resize', options: {
  afterSeq?: number; clientId?: string; data?: string; cols?: number; rows?: number; closeOnExit?: boolean; signal?: AbortSignal;
}, io: TerminalIo = { input: process.stdin, output: process.stdout, error: process.stderr, signals: process }): Promise<TerminalStreamResult> {
  const clientId = options.clientId ?? `pm-cli:${mode}`;
  const socket = connection.webSocket(query(`${BASE}/terminal`, { terminalId: terminal.id, clientId, afterSeq: String(options.afterSeq ?? 0) }), (url, headers) => new WebSocket(url, { ...headers, maxPayload: 2 * 1024 * 1024, handshakeTimeout: 15_000 }));
  const input = io.input as ReadStream, output = io.output as WriteStream;
  const decoder = new StringDecoder('utf8');
  const wasRaw = input.isRaw, wasFlowing = input.readableFlowing === true;
  let ready = false, settled = false, seq = 0, acknowledged = 0, lastOutput = options.afterSeq ?? 0, pending = false;
  let timer: NodeJS.Timeout | undefined, heartbeat: NodeJS.Timeout | undefined, closeTimer: NodeJS.Timeout | undefined;
  let resumeOutput: (() => void) | undefined;
  const { promise, resolve, reject } = Promise.withResolvers<TerminalStreamResult>();
  {
    const cleanup = () => {
      clearTimeout(timer); clearInterval(heartbeat);
      input.removeListener('data', onData); input.removeListener('end', onEnd); input.removeListener('error', onInputError);
      output.removeListener('resize', resize); if (resumeOutput) output.removeListener('drain', resumeOutput);
      io.signals.removeListener('SIGINT', detach); io.signals.removeListener('SIGTERM', detach); io.signals.removeListener('SIGHUP', detach);
      options.signal?.removeEventListener('abort', abort);
      if (mode === 'attach') {
        if (input.isTTY) input.setRawMode(Boolean(wasRaw));
        // An open pipe can remain referenced after pause; release only our input reader.
        if (!wasFlowing) { input.pause(); input.unref?.(); }
      }
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else if (socket.readyState !== WebSocket.CLOSED) { socket.close(1000, 'CLI attachment released'); closeTimer = setTimeout(() => socket.terminate(), 1000); closeTimer.unref(); }
    };
    const finish = (value?: { exitCode?: number; acknowledged?: true; resized?: true; detached?: true }, error?: Error) => {
      if (settled) return; settled = true; cleanup();
      if (error) reject(error); else resolve({ terminalId: terminal.id, serviceId: terminal.serviceId, ...value });
    };
    const send = (value: unknown) => {
      if (socket.readyState !== WebSocket.OPEN) throw new Error('PTY attachment is not open; input was not replayed.');
      socket.send(JSON.stringify(value));
    };
    const sendInput = (data: string) => {
      if (!data || settled) return;
      if (socket.bufferedAmount > 1024 * 1024 || pending) throw new Error('PTY input is backpressured; unconfirmed input will not be replayed.');
      // UTF-8 boundaries are preserved; each server frame is bounded to 64 KiB.
      let chunk = '', bytes = 0;
      for (const char of data) {
        const size = Buffer.byteLength(char);
        if (bytes + size > 65536) { send({ type: 'input', seq: ++seq, data: chunk }); chunk = ''; bytes = 0; }
        chunk += char; bytes += size;
      }
      if (chunk) send({ type: 'input', seq: ++seq, data: chunk });
      if (seq > acknowledged) { if (mode === 'attach') input.pause(); pending = true; }
    };
    const onData = (chunk: Buffer | string) => {
      try {
        const data = typeof chunk === 'string' ? chunk : decoder.write(chunk);
        const escape = data.indexOf('\u001d');
        if (escape !== -1) { sendInput(data.slice(0, escape)); detach(); } else sendInput(data);
      } catch (error) { finish(undefined, error instanceof Error ? error : new Error('PTY input failed.')); }
    };
    const onEnd = () => { try { sendInput(decoder.end()); if (!pending) detach(); } catch (error) { finish(undefined, error as Error); } };
    const onInputError = () => finish(undefined, new Error('PTY input stream failed; no input was replayed.'));
    const detach = () => mode === 'attach' ? finish({ detached: true }) : abort();
    const abort = () => finish(undefined, new Error('PTY operation cancelled; unacknowledged input was not replayed.'));
    const resize = () => {
      if (ready && mode === 'attach' && output.isTTY) try { send({ type: 'resize', cols: Math.max(2, Math.min(500, output.columns || 80)), rows: Math.max(2, Math.min(200, output.rows || 24)) }); } catch (error) { finish(undefined, error as Error); }
    };
    socket.on('error', () => finish(undefined, new Error('PTY transport failed; the original process was not recreated and unacknowledged input was not replayed.')));
    socket.on('close', () => { clearTimeout(closeTimer); if (!settled) finish(undefined, new Error(`PTY attachment closed${seq > acknowledged ? ' with unacknowledged input' : ''}; no reconnect, process recreation or command replay occurred.`)); });
    socket.on('message', (raw, binary) => {
      if (settled) return;
      try {
        if (binary) throw new Error('PTY server unexpectedly sent a binary protocol frame.');
        const message = JSON.parse(raw.toString()) as TerminalServerMessage;
        if (message.type === 'ready') {
          if (ready || message.terminal.id !== terminal.id || message.terminal.serviceId !== terminal.serviceId || !Number.isSafeInteger(message.acceptedInputSeq) || message.acceptedInputSeq < 0) throw new Error('PTY ready identity/sequence mismatch.');
          ready = true; seq = acknowledged = message.acceptedInputSeq; clearTimeout(timer);
          if (message.truncated && mode === 'attach') io.error.write('[Earlier terminal output exceeded the bounded replay window.]\n');
          if (mode !== 'attach' && message.terminal.status !== 'running') throw new Error('PTY process already exited; it was not rerun.');
          if (mode === 'input') { sendInput(options.data!); timer = setTimeout(() => finish(undefined, new Error('PTY input acknowledgement timed out; inspect the original process, do not resend blindly.')), 15_000); }
          else if (mode === 'resize') { send({ type: 'resize', cols: options.cols, rows: options.rows }); send({ type: 'ping' }); timer = setTimeout(() => finish(undefined, new Error('PTY resize confirmation timed out.')), 15_000); }
          else {
            if (message.terminal.status === 'running') {
              if (input.isTTY) input.setRawMode(true);
              if (!wasFlowing) input.ref?.();
              input.on('data', onData); input.once('end', onEnd); input.once('error', onInputError); input.resume();
              output.on('resize', resize); resize();
            }
            heartbeat = setInterval(() => { try { send({ type: 'ping' }); } catch (error) { finish(undefined, error as Error); } }, 30_000); heartbeat.unref();
          }
        } else if (!ready) throw new Error('PTY sent data before the ready identity.');
        else if (message.type === 'output') {
          if (!Number.isSafeInteger(message.seq) || typeof message.data !== 'string') throw new Error('Invalid PTY output frame.');
          if (mode === 'attach' && message.seq > lastOutput) {
            lastOutput = message.seq;
            if (!output.write(message.data) && !resumeOutput) { socket.pause(); resumeOutput = () => { resumeOutput = undefined; socket.resume(); }; output.once('drain', resumeOutput); }
          }
        } else if (message.type === 'ack') {
          if (!Number.isSafeInteger(message.seq) || message.seq < acknowledged || message.seq > seq) throw new Error('Invalid PTY acknowledgement sequence.');
          acknowledged = message.seq;
          if (acknowledged === seq) { pending = false; if (mode === 'input') finish({ acknowledged: true }); else if (input.readableEnded) detach(); else input.resume(); }
        } else if (message.type === 'pong') { if (mode === 'resize') finish({ resized: true }); }
        else if (message.type === 'exit') { if (mode === 'attach') finish({ exitCode: message.exitCode }); else finish(undefined, new Error('PTY exited before the operation was confirmed.')); }
        else if (message.type === 'error') throw Object.assign(new Error('PTY service rejected the operation; its authorization, binding or lifetime is no longer usable.'), { code: message.code });
        else throw new Error('Unknown PTY protocol frame.');
      } catch (error) { finish(undefined, error instanceof Error ? error : new Error('Invalid PTY protocol response.')); }
    });
    timer = setTimeout(() => finish(undefined, new Error('PTY attachment readiness timed out; no process was recreated.')), 15_000);
    io.signals.on('SIGINT', detach); io.signals.on('SIGTERM', detach); io.signals.on('SIGHUP', detach);
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
  }
  const result = await promise.finally(async () => {
    if (options.closeOnExit) await response(connection, `${BASE}/terminals/${encodeURIComponent(terminal.id)}`, { method: 'DELETE' });
  });
  return result;
}

async function files(resource: 'files' | 'git', action: string | undefined, args: string[], runtime: CliRuntime): Promise<void> {
  const allowed: Record<string, readonly string[]> = resource === 'files' ? { list: ['session', 'path'], read: ['session', 'path'], search: ['session', 'query'], media: ['session', 'path'] } : { status: ['session'], diff: ['session', 'path', 'staged'] };
  if (!action || !Object.hasOwn(allowed, action)) fail(`Unknown agent ${resource} action.\n${HELP}`);
  const options = parseOptions(args, allowed[action]!);
  const threadId = id(options.session, '--session');
  const filePath = relative(options.path);
  if (['read', 'media'].includes(action)) nonempty(options.path, '--path');
  const search = action === 'search' ? nonempty(options.query, '--query') : undefined;
  if (search && search.length > 256) fail('--query cannot exceed 256 characters');
  const staged = action === 'diff' ? boolean(options.staged, '--staged') : false;
  const route = resource === 'git' ? (action === 'status' ? '/git' : '/git/diff') : ({ list: '/files', read: '/file', search: '/search', media: '/media' } as const)[action as 'list' | 'read' | 'search' | 'media'];
  const endpoint = query(`${BASE}${route}`, { threadId, ...(action !== 'status' && action !== 'search' ? { path: filePath } : {}), ...(search ? { q: search } : {}), ...(staged ? { staged: 'true' } : {}) });
  const connection = await connectAgent();
  try {
    if (action !== 'media') runtime.print(await json(connection, endpoint));
    else {
      if (process.stdout.isTTY) fail('Media is binary stdout; redirect it to a file or pipe.');
      const result = await response(connection, endpoint);
      if (!result.body) fail('Media response has no body');
      const reader = result.body.getReader();
      try { while (true) { const next = await reader.read(); if (next.done) break; if (!process.stdout.write(next.value)) { const drained = Promise.withResolvers<void>(); process.stdout.once('drain', drained.resolve); await drained.promise; } } }
      finally { await reader.cancel(); reader.releaseLock(); }
    }
  } finally { connection.close(); }
}
async function terminals(action: string | undefined, args: string[], runtime: CliRuntime): Promise<void> {
  const common = ['id', 'service-id'];
  const allowed: Record<string, readonly string[]> = { list: ['session', 'workspace', 'revision', 'request-id'], create: ['session', 'workspace', 'revision', 'request-id', 'service-id', 'path', 'cols', 'rows'], get: common, close: common, attach: [...common, 'after-seq', 'client-id', 'close-on-exit'], input: [...common, 'text', 'file', 'client-id'], resize: [...common, 'cols', 'rows', 'client-id'] };
  if (!action || !Object.hasOwn(allowed, action)) fail(`Unknown agent terminal action.\n${HELP}`);
  const options = parseOptions(args, allowed[action]!);
  const selected = ['create', 'list'].includes(action) ? selectionOptions(options) : undefined;
  const terminalId = selected ? undefined : uuid(options.id, '--id');
  const serviceId = action === 'list' ? undefined : uuid(options['service-id'], '--service-id');
  const requestId = action === 'create' || options['request-id'] !== undefined ? uuid(options['request-id'], '--request-id') : undefined;
  const cols = ['create', 'resize'].includes(action) ? integer(options.cols, '--cols', 2, 500, action === 'create' ? 80 : undefined) : undefined;
  const rows = ['create', 'resize'].includes(action) ? integer(options.rows, '--rows', 2, 200, action === 'create' ? 24 : undefined) : undefined;
  const relativePath = relative(options.path), afterSeq = integer(options['after-seq'], '--after-seq', 0, Number.MAX_SAFE_INTEGER, 0);
  const closeOnExit = boolean(options['close-on-exit'], '--close-on-exit');
  const clientId = options['client-id'] === undefined ? undefined : id(options['client-id'], '--client-id');
  if (clientId && clientId.length > 128) fail('--client-id cannot exceed 128 characters');
  let data: string | undefined;
  if (action === 'input') {
    if (Number(options.text !== undefined) + Number(options.file !== undefined) !== 1) fail('Terminal input requires exactly one of --text or --file');
    data = options.file !== undefined ? await textFile(options.file, 65536) : nonempty(options.text, '--text');
    if (!data || Buffer.byteLength(data) > 65536) fail('Terminal input must contain 1–65536 UTF-8 bytes');
  }
  const connection = await connectAgent();
  try {
    if (selected) {
      const binding = await selection(connection, selected);
      if (action === 'list') runtime.print(await json(connection, query(`${BASE}/terminals`, { agentWorkspaceId: binding.agentWorkspaceId, agentWorkspaceRevision: String(binding.agentWorkspaceRevision), threadId: 'threadId' in binding ? binding.threadId : undefined, requestId })));
      else runtime.print(await json(connection, `${BASE}/terminals`, body({ ...binding, requestId, expectedServiceId: serviceId, relativePath, cols, rows })));
      return;
    }
    const terminal = await descriptor(connection, terminalId!, serviceId!);
    if (action === 'get') runtime.print({ terminal });
    else if (action === 'close') runtime.print(await json(connection, `${BASE}/terminals/${encodeURIComponent(terminal.id)}`, { method: 'DELETE' }));
    else {
      const result = await terminalStream(connection, terminal, action as 'attach' | 'input' | 'resize', {
        afterSeq, closeOnExit, ...(clientId === undefined ? {} : { clientId }), ...(data === undefined ? {} : { data }),
        ...(cols === undefined ? {} : { cols }), ...(rows === undefined ? {} : { rows }),
      });
      if (action === 'attach') process.stderr.write(`${JSON.stringify(result)}\n`); else runtime.print(result);
    }
  } finally { connection.close(); }
}

const BROWSER_ACTIONS: Record<string, readonly string[]> = {
  status: [], list: [], create: ['id', 'url'], state: ['id'], close: ['id'], navigate: ['id', 'url'], back: ['id'], forward: ['id'], reload: ['id'], stop: ['id'], capture: ['id'], pick: ['id'], 'cancel-pick': ['id'], 'pip-open': ['id'], 'pip-close': ['id'], devtools: ['id'], 'open-external': ['url'],
};
async function browser(action: string | undefined, args: string[], runtime: CliRuntime): Promise<void> {
  if (!action || !Object.hasOwn(BROWSER_ACTIONS, action)) fail(`Unknown agent browser action.\n${HELP}`);
  const options = parseOptions(args, ['desktop-file', ...BROWSER_ACTIONS[action]!]);
  const filename = nonempty(options['desktop-file'], '--desktop-file');
  if (!path.isAbsolute(filename)) fail('--desktop-file must be an explicit absolute private desktop descriptor');
  const tabId = BROWSER_ACTIONS[action]!.includes('id') ? id(options.id, '--id') : undefined;
  if (tabId && tabId.length > 128) fail('Browser tab ID cannot exceed 128 characters');
  let url: string | undefined;
  if (options.url !== undefined || ['navigate', 'open-external'].includes(action)) {
    try { const parsed = new URL(nonempty(options.url, '--url')); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(); url = parsed.href; }
    catch { fail('--url must be an HTTP(S) URL without embedded credentials'); }
  }
  const connection = await connectAgent();
  try {
    const canonical = await realpath(filename).catch(() => undefined);
    if (!canonical) fail('No live desktop Browser descriptor. Open the matching LOCAL Electron workspace; no headless fallback is available.', 'browser_platform_unavailable');
    if (canonical !== filename) fail('Desktop descriptor must use its canonical non-symlink path.', 'browser_descriptor_unsafe');
    await assertPrivatePath(path.dirname(filename), true);
    if (process.platform !== 'win32' && ((await lstat(filename)).mode & 0o777) !== 0o600) fail('Desktop descriptor must be a private 0600 file.', 'browser_descriptor_unsafe');
    const descriptor: unknown = await readPrivateJson(filename);
    if (!descriptor || typeof descriptor !== 'object') fail('No live desktop Browser bridge descriptor. Open the matching local Electron workspace; no headless fallback is available.', 'browser_platform_unavailable');
    const value = descriptor as { version?: unknown; serviceUrl?: unknown; instanceId?: unknown; endpoint?: unknown; token?: unknown };
    if (value.version !== 1 || value.serviceUrl !== connection.serviceUrl || typeof value.instanceId !== 'string' || !/^[0-9a-f-]{36}$/u.test(value.instanceId) || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/u.test(value.token) || typeof value.endpoint !== 'string') fail('Desktop Browser descriptor does not match this connected Agent service.', 'browser_instance_mismatch');
    let endpoint: URL;
    try { endpoint = new URL(value.endpoint); } catch { return fail('Invalid desktop Browser endpoint'); }
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || endpoint.pathname !== '/preview' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) fail('Desktop Browser control must stay on its private loopback bridge');
    const controller = new AbortController();
    const cancel = () => controller.abort(); process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    try {
      let result: Response;
      try { result = await fetch(endpoint, { ...body({ instanceId: value.instanceId, serviceUrl: value.serviceUrl, action, ...(tabId ? { tabId } : {}), ...(url ? { url } : {}) }), headers: { Authorization: `Bearer ${value.token}`, 'Content-Type': 'application/json' }, redirect: 'error', credentials: 'omit', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(action === 'pick' ? 40_000 : 20_000)]) }); }
      catch { return fail('Desktop Browser operation was cancelled or the live desktop is unavailable; no action was retried. Check the original instance before repeating an action.', 'browser_outcome_unconfirmed'); }
      if (!result.ok) { await result.body?.cancel(); fail(`Desktop Browser rejected the operation (HTTP ${result.status}). It requires the matching ready local workspace and attached native webview.`, 'browser_operation_failed'); }
      runtime.print(await result.json());
    } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  } finally { connection.close(); }
}

export const agentRuntimeFamily: CliFamily = {
  help: HELP,
  async dispatch(args, runtime) {
    if (args[0] !== 'agent' || !['files', 'git', 'terminal', 'browser'].includes(args[1] ?? '')) return false;
    const [, resource, action, ...rest] = args;
    if (resource === 'files' || resource === 'git') await files(resource, action, rest, runtime);
    else if (resource === 'terminal') await terminals(action, rest, runtime);
    else await browser(action, rest, runtime);
    return true;
  },
};
