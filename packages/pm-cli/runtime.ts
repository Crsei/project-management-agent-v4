import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import type { Diagnostic, FileRecord, UnsupportedFile } from '../pm-schema/index.ts';
import { authenticate, serviceOrigin } from './auth.ts';

const MAX_INPUT_BYTES = 5 * 1024 * 1024;

export type PmScope = 'service' | 'workspace' | 'core';
export type PmRequestOptions = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  signal?: AbortSignal;
};
export type PmAuthentication = { origin: string; headers: Record<string, string> };
export type PmConnection = PmAuthentication & { workspaceId: string };
export type CliRuntime = {
  authentication(): Promise<PmAuthentication>;
  connection(): Promise<PmConnection>;
  json<T>(scope: PmScope, endpoint: string, options?: PmRequestOptions): Promise<T>;
  response(scope: PmScope, endpoint: string, options?: PmRequestOptions): Promise<Response>;
  print(value: unknown): void;
};
export type CliFamily = {
  help: string;
  dispatch(args: string[], runtime: CliRuntime): Promise<boolean>;
};

export class CliRequestError extends Error {
  readonly code: string;
  readonly diagnostics: Diagnostic[];
  readonly status?: number;
  readonly current?: FileRecord | UnsupportedFile;
  constructor(code: string, message: string, diagnostics: Diagnostic[] = [], status?: number, current?: FileRecord | UnsupportedFile) {
    super(message);
    this.code = code;
    this.diagnostics = diagnostics;
    if (status !== undefined) this.status = status;
    if (current !== undefined) this.current = current;
  }
}

export function nonempty(value: string | undefined, name: string): string {
  if (value === undefined || !value.trim()) throw new Error(`${name} requires a nonempty value`);
  return value;
}

export function identifier(value: string | undefined): string {
  const id = nonempty(value, 'ID');
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(id)) throw new Error(`Invalid entity ID: ${id}`);
  return id;
}

export function parseOptions(args: string[], allowed: readonly string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(args[index]!);
    if (!match || !match[1] || !allowed.includes(match[1])) throw new Error('Unknown or unsupported option. Run pm --help.');
    const name = match[1];
    const value = match[2] ?? args[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    if (name in options) throw new Error(`Repeated option: --${name}`);
    options[name] = value;
  }
  return options;
}

export function objectInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  let nodes = 0;
  const visit = (entry: unknown, depth: number): void => {
    if (++nodes > 100000 || depth > 64) throw new Error('Input exceeds structural limits');
    if (entry && typeof entry === 'object') {
      for (const [key, child] of Object.entries(entry)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`Unsafe input field: ${key}`);
        visit(child, depth + 1);
      }
    }
  };
  visit(value, 0);
  return value as Record<string, unknown>;
}

export async function textFile(filename: string | undefined, maxBytes = MAX_INPUT_BYTES): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Invalid input size limit');
  const file = await open(nonempty(filename, '--file'), constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error('--file must identify a regular file');
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > maxBytes) throw new Error(`Input exceeds ${maxBytes === MAX_INPUT_BYTES ? '5 MiB' : `${maxBytes} bytes`}`);
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)); }
    catch { throw new Error('--file must contain valid UTF-8'); }
  } finally { await file.close(); }
}

export async function inputFile(filename: string | undefined): Promise<Record<string, unknown>> {
  const document = parseDocument(await textFile(filename), { uniqueKeys: true });
  if (document.errors.length) throw new Error(document.errors.map(error => error.message).join('\n'));
  return objectInput(document.toJS({ maxAliasCount: 0 }));
}

function errorText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'message' in value && typeof value.message === 'string') return value.message;
  return undefined;
}

async function requireOk(response: Response): Promise<Response> {
  if (response.ok) return response;
  const payload: unknown = await response.json().catch(() => undefined);
  const record = payload && typeof payload === 'object' ? payload as { error?: unknown; diagnostics?: Diagnostic[]; current?: FileRecord | UnsupportedFile } : {};
  const diagnostics = Array.isArray(record.diagnostics) ? record.diagnostics.filter(diagnostic => diagnostic && typeof diagnostic.code === 'string' && typeof diagnostic.message === 'string') : [];
  const current = record.current && typeof record.current.revision === 'string' ? record.current : undefined;
  const details = diagnostics.map(diagnostic => `\n[${diagnostic.code}] ${diagnostic.message} (${[
    `path=${diagnostic.path}`, `severity=${diagnostic.severity}`, diagnostic.entityId && `entity=${diagnostic.entityId}`, diagnostic.field && `field=${diagnostic.field}`, diagnostic.targetId && `target=${diagnostic.targetId}`, diagnostic.line !== undefined && `line=${diagnostic.line}`,
  ].filter(Boolean).join(', ')})`).join('');
  throw new CliRequestError(diagnostics[0]?.code ?? 'HTTP_ERROR', `HTTP ${response.status}: ${errorText(record.error) ?? response.statusText}${details}${current ? `\nCurrent disk revision: ${current.revision}` : ''}`, diagnostics, response.status, current);
}

/** PM authentication only. Agent families must use the independent Agent connection. */
export function createCliRuntime(): CliRuntime {
  let authenticated: Promise<PmAuthentication> | undefined;
  let selected: Promise<PmConnection> | undefined;
  const authentication = (): Promise<PmAuthentication> => authenticated ??= (async () => {
    const origin = serviceOrigin();
    return { origin, headers: (await authenticate(origin)).headers };
  })();
  const connection = (): Promise<PmConnection> => selected ??= (async () => {
    const target = await authentication();
    let workspaceId = process.env.PM_WORKSPACE_ID?.trim();
    if (!workspaceId) {
      const payload = await json<{ items?: unknown }>('service', '/workspaces');
      const items = payload && Array.isArray(payload.items) ? payload.items : [];
      const workspaces = items.filter((item): item is { id: string } => !!item && typeof item === 'object' && 'id' in item && typeof item.id === 'string');
      if (workspaces.length !== 1) throw new CliRequestError('CLI_WORKSPACE_REQUIRED', workspaces.length ? `Set PM_WORKSPACE_ID; accessible workspaces: ${workspaces.map(item => item.id).join(', ')}` : 'No accessible workspace');
      workspaceId = workspaces[0]!.id;
    }
    return { ...target, workspaceId };
  })();
  const response = async (scope: PmScope, endpoint: string, options: PmRequestOptions = {}): Promise<Response> => {
    if (!endpoint.startsWith('/') || endpoint.startsWith('//') || endpoint.includes('\\') || endpoint.includes('#') || /(?:^|\/)\.{1,2}(?:\/|\?|$)/.test(endpoint)) throw new Error('Expected an internal scoped API path');
    for (const name of Object.keys(options.headers ?? {})) {
      if (['authorization', 'cookie', 'origin', 'host', 'proxy-authorization'].includes(name.toLowerCase())) throw new Error(`The CLI manages the ${name} header`);
    }
    const target: PmAuthentication & { workspaceId?: string } = scope === 'service' ? await authentication() : await connection();
    const workspace = target.workspaceId === undefined ? '' : `/workspaces/${encodeURIComponent(target.workspaceId)}`;
    const base = `${target.origin}/api/v1${scope === 'service' ? '' : workspace}${scope === 'core' ? '/core' : ''}`;
    const url = new URL(`${base}${endpoint}`);
    if (!url.href.startsWith(`${base}/`)) throw new Error('API path escapes its selected scope');
    const headers: Record<string, string> = { ...options.headers, ...target.headers };
    if (options.idempotencyKey !== undefined) {
      if (Object.keys(headers).some(name => name.toLowerCase() === 'idempotency-key')) throw new Error('Repeated Idempotency-Key');
      headers['Idempotency-Key'] = nonempty(options.idempotencyKey, 'Idempotency-Key');
    }
    const rawBody = options.body instanceof FormData || options.body instanceof Blob || options.body instanceof ArrayBuffer || ArrayBuffer.isView(options.body) || options.body instanceof URLSearchParams;
    if (options.body !== undefined && !rawBody && !Object.keys(headers).some(name => name.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    let result: Response;
    try {
      result = await fetch(url, {
        method: options.method ?? 'GET', headers,
        ...(options.body === undefined ? {} : { body: rawBody ? options.body as NonNullable<RequestInit['body']> : JSON.stringify(options.body) }),
        redirect: 'error', signal: options.signal ?? AbortSignal.timeout(15_000),
      });
    } catch { throw new CliRequestError('CLI_CONNECTION_FAILED', `Cannot reach ${base}; the original outcome is unconfirmed. Do not automatically retry a write.`); }
    return requireOk(result);
  };
  const json = async <T>(scope: PmScope, endpoint: string, options?: PmRequestOptions): Promise<T> => {
    const result = await response(scope, endpoint, options);
    if (result.status === 204) return undefined as T;
    try { return await result.json() as T; }
    catch { throw new CliRequestError('CLI_INVALID_RESPONSE', 'The service returned invalid JSON; an attempted write remains unconfirmed. Query its original identity instead of retrying.'); }
  };
  return { authentication, connection, response, json, print(value) { console.log(JSON.stringify(value, null, 2)); } };
}
