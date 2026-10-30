#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseDocument } from 'yaml';
import type { Diagnostic, FileRecord, UnsupportedFile } from '../pm-schema/index.ts';

const HELP = `Markdown PM Lab — operate the same live workspace as the browser

Usage:
  pm protocol
  pm file ID
  pm context ID
  pm task list [--project ID] [--status todo] [--priority high] [--q text] [--sort id] [--archived exclude|include|only]
  pm task create --title TEXT [--project ID] [--kind task] [--idempotency-key KEY]
  pm entity list [--entity KIND] [--project ID] [--status STATUS] [--archived exclude|include|only]
  pm entity create --entity KIND --title TEXT [fields] [--set JSON] [--idempotency-key KEY]
  pm task|entity update ID [fields] [--set JSON] [--unset FIELD,FIELD] [--revision HASH]
  pm task|entity archive ID --revision HASH
  pm task|entity restore ID --revision HASH
  pm task|entity delete ID --revision HASH --confirm ID
  pm config get
  pm config set --file PATH --revision REV
  pm view query --file PATH [--archived exclude|include|only]
  pm view save ID --file PATH [--revision REV]
  pm migration list
  pm migration preview --file PATH
  pm migration apply ID --revision REV --confirm ID
  pm migration restore ID --revision REV --confirm ID

Kinds: project | work_item | document | cycle | milestone | module |
       requirement | release | goal. Sprint is the UI label for cycle.

Fields (entity applicability is enforced):
  --title TEXT          First Markdown H1
  --project ID         Project reference
  --kind KIND          epic | task | bug | subtask
  --status STATUS      Configured workflow state ID
  --priority PRIORITY  low | medium | high | urgent
  --parent ID          Parent work item, module, or goal
  --blocked-by IDS     Comma-separated dependency IDs
  --related-to IDS     Comma-separated related IDs
  --labels LABELS      Comma-separated labels
  --assignee TEXT      Work item assignee
  --owner TEXT         Entity owner
  --goal TEXT          Project goal
  --document-kind KIND note | design | decision | specification
  --start YYYY-MM-DD   Start date (where applicable)
  --due YYYY-MM-DD     Due date (where applicable)
  --cycle ID           Cycle reference
  --milestone ID       Milestone reference
  --module ID          Module reference
  --requirement ID     Requirement reference
  --release ID         Release reference
  --goals IDS          Comma-separated goal references
  --target NUMBER      Goal target (number)
  --unit TEXT          Goal target unit
  --version TEXT       Release version
  --set JSON           Object of typed fields; e.g. '{"x-points":3,"x-ready":true}'
  --archived BOOLEAN  true | false (archive/restore commands are also available)
  --body TEXT          Markdown body (create only)

Empty array options clear arrays; --unset removes optional fields using null.
File inputs accept JSON or YAML objects, at most 5 MiB; YAML aliases are disabled.
View query files contain a view configuration; view save also requires name.
Existing views require --revision; new views must omit it. Config set replaces
the configuration with CAS (--revision absent creates the first config).
Migration preview never changes business files; inspect its diff/diagnostics
before apply. Apply and restore both require matching revision and confirmation.
PM_API_URL defaults to http://127.0.0.1:4194 and must point at this v4 PM API.
Authentication (first match wins): PM_SESSION_TOKEN, PM_EMAIL + PM_PASSWORD,
or .local/access.json (PM_ACCESS_FILE overrides). PM_WORKSPACE_ID selects the
workspace; otherwise the CLI uses the single workspace the account can access.
Commands operate on /api/v1/workspaces/{workspaceId}/core, the Markdown core.
`;

const FIELD_OPTIONS = ['title', 'project', 'kind', 'status', 'priority', 'parent', 'blocked-by', 'related-to', 'assignee', 'labels', 'due', 'owner', 'goal', 'document-kind', 'start', 'archived', 'cycle', 'milestone', 'module', 'requirement', 'release', 'goals', 'target', 'unit', 'version'];
const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const RESERVED_SET_FIELDS = { id: true, schema: true, entity: true, revision: true, path: true, raw: true, changes: true, 'idempotency-key': true, idempotency_key: true, prototype: true, constructor: true } as const satisfies Record<string, true>;

export class CliError extends Error {
  readonly code: string;
  readonly diagnostics: Diagnostic[];
  readonly status?: number;
  readonly current?: FileRecord | UnsupportedFile;
  constructor(code: string, message: string, diagnostics: Diagnostic[] = [], status?: number, current?: FileRecord | UnsupportedFile) {
    super(`[${code}] ${message}`);
    this.name = 'CliError';
    this.code = code;
    this.diagnostics = diagnostics;
    this.status = status;
    this.current = current;
  }
}

function objectInput(value: unknown): Record<string, unknown> {
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

async function inputFile(filename: string | undefined): Promise<Record<string, unknown>> {
  const file = await open(nonempty(filename, '--file'), 'r');
  try {
    if (!(await file.stat()).isFile()) throw new Error('--file must identify a regular file');
    const bytes = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > MAX_INPUT_BYTES) throw new Error('Input exceeds 5 MiB');
    const source = bytes.toString('utf8', 0, length);
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length) throw new Error(document.errors.map(error => error.message).join('\n'));
    return objectInput(document.toJS({ maxAliasCount: 0 }));
  } finally { await file.close(); }
}

function archiveFilter(value: string | undefined): void {
  if (value !== undefined && !['exclude', 'include', 'only'].includes(value)) throw new Error('archived must be exclude, include, or only');
}

function migrationIdentifier(value: string | undefined): string {
  const id = nonempty(value, 'migration ID');
  if (!/^mig-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error('Invalid migration ID');
  return id;
}

function parseOptions(args: string[], allowed: readonly string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(args[index]);
    if (!match || !allowed.includes(match[1])) throw new Error(`Unknown option: ${args[index]}`);
    const value = match[2] ?? args[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${match[1]}`);
    if (match[1] in options) throw new Error(`Repeated option: --${match[1]}`);
    options[match[1]] = value;
  }
  return options;
}

function nonempty(value: string | undefined, name: string): string {
  if (value === undefined || !value.trim()) throw new Error(`${name} requires a nonempty value`);
  return value;
}

function identifier(value: string | undefined): string {
  const id = nonempty(value, 'ID');
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(id)) throw new Error(`Invalid entity ID: ${id}`);
  return id;
}

function fieldValue(field: string, value: string): unknown {
  if (['blocked_by', 'related_to', 'labels', 'goals'].includes(field)) {
    return value.trim() ? value.split(',').map(item => item.trim()) : [];
  }
  if (field === 'archived' && (value === 'true' || value === 'false')) return value === 'true';
  if (field === 'target') {
    if (!value.trim() || !Number.isFinite(Number(value))) throw new Error('--target must be a finite number');
    return Number(value);
  }
  // Transport parsing only. The shared server protocol owns applicability,
  // enums, references and date validation, including their diagnostic codes.
  return value;
}

function changesFrom(options: Record<string, string>): Record<string, unknown> {
  let changes: Record<string, unknown> = {};
  if (options.set !== undefined) {
    if (Buffer.byteLength(options.set) > MAX_INPUT_BYTES) throw new Error('--set exceeds 5 MiB');
    changes = objectInput(JSON.parse(options.set));
    for (const field of Object.keys(changes)) {
      if (Object.hasOwn(RESERVED_SET_FIELDS, field)) throw new Error(`--set cannot override reserved field: ${field}`);
    }
  }
  for (const [key, value] of Object.entries(options)) {
    if (['revision', 'idempotency-key', 'unset', 'set'].includes(key)) continue;
    const field = key.replaceAll('-', '_');
    if (Object.hasOwn(changes, field)) throw new Error(`Repeated field: ${field}`);
    changes[field] = fieldValue(field, value);
  }
  if (options.unset !== undefined) {
    for (const name of nonempty(options.unset, '--unset').split(',')) {
      const key = nonempty(name, '--unset field');
      const field = key.startsWith('x-') ? key : key.replaceAll('-', '_');
      if (field in changes) throw new Error(`Repeated field: ${field}`);
      changes[field] = null;
    }
  }
  return changes;
}

type Connection = { base: string; headers: Record<string, string>; workspaceId: string };
let connection: Promise<Connection> | undefined;

function errorText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'message' in value && typeof value.message === 'string') return value.message;
  return undefined;
}

async function authenticate(service: string): Promise<Record<string, string>> {
  const token = process.env.PM_SESSION_TOKEN?.trim();
  if (token) return { Authorization: `Bearer ${token}` };
  let email = process.env.PM_EMAIL?.trim();
  let password = process.env.PM_PASSWORD;
  if (!email || !password) {
    const file = process.env.PM_ACCESS_FILE ?? '.local/access.json';
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        if (!email && 'email' in parsed && typeof parsed.email === 'string') email = parsed.email;
        if (!password && 'password' in parsed && typeof parsed.password === 'string') password = parsed.password;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new CliError('CLI_AUTH_REQUIRED', `Cannot read ${file}: ${(error as Error).message}`);
    }
  }
  if (!email || !password) throw new CliError('CLI_AUTH_REQUIRED', 'Set PM_SESSION_TOKEN or PM_EMAIL/PM_PASSWORD, or provide .local/access.json');
  let response: Response;
  try {
    response = await fetch(`${service}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(15_000) });
  } catch (error) { throw new CliError('CLI_CONNECTION_FAILED', `Cannot reach ${service}: ${(error as Error).message}`); }
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => undefined);
    const message = payload && typeof payload === 'object' && 'error' in payload ? errorText(payload.error) : undefined;
    throw new CliError('CLI_AUTH_FAILED', `Login failed (HTTP ${response.status})${message ? `: ${message}` : ''}`);
  }
  const cookie = (response.headers.getSetCookie?.() ?? []).map(value => value.split(';')[0]).filter(Boolean).join('; ');
  if (!cookie) throw new CliError('CLI_AUTH_FAILED', 'Login did not return a session cookie');
  return { Cookie: cookie };
}

async function connectionFor(): Promise<Connection> {
  if (connection) return connection;
  const pending = (async (): Promise<Connection> => {
    const service = (process.env.PM_API_URL ?? 'http://127.0.0.1:4194').replace(/\/+$/, '').replace(/\/api$/, '');
    const url = new URL(service);
    if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash || url.username || url.password) throw new Error('PM_API_URL must be an HTTP(S) service URL without credentials, query, or fragment');
    const headers = await authenticate(service);
    const workspaceId = process.env.PM_WORKSPACE_ID?.trim();
    if (!workspaceId) {
      let response: Response;
      try { response = await fetch(`${service}/api/v1/workspaces`, { headers, signal: AbortSignal.timeout(15_000) }); }
      catch (error) { throw new CliError('CLI_CONNECTION_FAILED', `Cannot reach ${service}: ${(error as Error).message}`); }
      if (!response.ok) throw new CliError('CLI_AUTH_FAILED', `Cannot list workspaces (HTTP ${response.status})`);
      const payload: unknown = await response.json();
      const items = payload && typeof payload === 'object' && 'items' in payload && Array.isArray(payload.items) ? payload.items : [];
      const workspaces = items.filter((item): item is { id: string; name?: string } => !!item && typeof item === 'object' && 'id' in item && typeof item.id === 'string');
      if (workspaces.length !== 1) throw new CliError('CLI_WORKSPACE_REQUIRED', workspaces.length ? `Set PM_WORKSPACE_ID; accessible workspaces: ${workspaces.map(item => item.id).join(', ')}` : 'No accessible workspace');
      return { base: `${service}/api/v1/workspaces/${workspaces[0]!.id}/core`, headers, workspaceId: workspaces[0]!.id };
    }
    return { base: `${service}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/core`, headers, workspaceId };
  })();
  connection = pending;
  pending.catch(() => { if (connection === pending) connection = undefined; });
  return pending;
}

async function request<T>(endpoint: string, method = 'GET', body?: unknown, idempotencyKey?: string): Promise<T> {
  const target = await connectionFor();
  const headers: Record<string, string> = { ...target.headers };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey !== undefined) headers['Idempotency-Key'] = nonempty(idempotencyKey, '--idempotency-key');
  else if (method !== 'GET' && /^\/(?:files|entities)\//.test(endpoint)) headers['Idempotency-Key'] = randomUUID();
  let response: Response;
  try {
    response = await fetch(`${target.base}${endpoint}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
  } catch (error) { throw new CliError('CLI_CONNECTION_FAILED', `Cannot reach ${target.base}: ${(error as Error).message}`); }
  const text = await response.text();
  let payload: unknown;
  try { payload = text ? JSON.parse(text) : undefined; } catch { payload = undefined; }
  if (!response.ok) {
    const record = payload && typeof payload === 'object' ? payload as { error?: unknown; diagnostics?: Diagnostic[]; current?: FileRecord | UnsupportedFile } : {};
    const message = errorText(record.error);
    const current = record.current ? `\nCurrent disk revision: ${record.current.revision}` : '';
    const diagnostics = (record.diagnostics ?? []).map(diagnostic => `\n[${diagnostic.code}] ${diagnostic.message} (${[
      `path=${diagnostic.path}`, `severity=${diagnostic.severity}`, diagnostic.entityId && `entity=${diagnostic.entityId}`, diagnostic.field && `field=${diagnostic.field}`, diagnostic.targetId && `target=${diagnostic.targetId}`, diagnostic.line !== undefined && `line=${diagnostic.line}`,
    ].filter(Boolean).join(', ')})`).join('');
    throw new CliError(record.diagnostics?.[0]?.code ?? 'HTTP_ERROR', `HTTP ${response.status}: ${message ?? response.statusText}${diagnostics}${current}`, record.diagnostics, response.status, record.current);
  }
  return payload as T;
}

async function executeCli(args: string[]): Promise<void> {
  if (!args.length || args.includes('--help') || args[0] === 'help' || args[0] === '-h') {
    console.log(HELP);
    return;
  }
  if (args[0] === 'protocol') {
    if (args.length !== 1) throw new Error('Usage: pm protocol');
    console.log(JSON.stringify(await request('/protocol'), null, 2));
    return;
  }
  if (args[0] === 'context' || args[0] === 'file') {
    if (args.length !== 2) throw new Error(`Usage: pm ${args[0]} ID`);
    const id = identifier(args[1]);
    if (args[0] === 'file') process.stdout.write((await request<FileRecord | UnsupportedFile>(`/files/${id}`)).raw);
    else console.log((await request<{ markdown: string }>(`/context/${id}`)).markdown);
    return;
  }
  if (args[0] === 'config') {
    if (args[1] === 'get' && args.length === 2) {
      console.log(JSON.stringify(await request('/config'), null, 2));
      return;
    }
    if (args[1] !== 'set') throw new Error('Usage: pm config get | set --file PATH --revision REV');
    const options = parseOptions(args.slice(2), ['file', 'revision']);
    const revision = nonempty(options.revision, '--revision');
    const config = await inputFile(options.file);
    console.log(JSON.stringify(await request('/config', 'PUT', { config, revision }), null, 2));
    return;
  }
  if (args[0] === 'view') {
    const action = args[1];
    if (action !== 'query' && action !== 'save') throw new Error('Usage: pm view query --file PATH | save ID --file PATH [--revision REV]');
    const id = action === 'save' ? nonempty(args[2], 'view ID') : undefined;
    if (id && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw new Error('Invalid view ID');
    const options = parseOptions(args.slice(action === 'save' ? 3 : 2), action === 'save' ? ['file', 'revision'] : ['file', 'archived']);
    archiveFilter(options.archived);
    if (options.revision !== undefined) nonempty(options.revision, '--revision');
    const view = await inputFile(options.file);
    if (Object.hasOwn(view, 'revision')) throw new Error('View revision must be supplied with --revision, not persisted in the input file');
    const result = action === 'query'
      ? await request('/query', 'POST', { view, archived: options.archived })
      : await request(`/views/${encodeURIComponent(id!)}`, 'PUT', { ...view, ...(options.revision === undefined ? {} : { revision: options.revision }) });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args[0] === 'migration') {
    const action = args[1];
    if (action === 'list' && args.length === 2) {
      console.log(JSON.stringify(await request('/migrations'), null, 2));
      return;
    }
    if (action === 'preview') {
      const options = parseOptions(args.slice(2), ['file']);
      console.log(JSON.stringify(await request('/migrations/preview', 'POST', await inputFile(options.file)), null, 2));
      return;
    }
    if (action !== 'apply' && action !== 'restore') throw new Error('Expected migration list, preview, apply, or restore');
    const id = migrationIdentifier(args[2]);
    const options = parseOptions(args.slice(3), ['revision', 'confirm']);
    const revision = nonempty(options.revision, '--revision');
    if (options.confirm !== id) throw new Error(`Migration ${action} requires --confirm ${id}`);
    console.log(JSON.stringify(await request(`/migrations/${id}/${action}`, 'POST', { revision }), null, 2));
    return;
  }
  const scope = args[0];
  if (scope !== 'task' && scope !== 'entity') throw new Error(`Unknown command: ${scope}. Run pm --help.`);
  const action = args[1];
  if (action === 'list') {
    const options = parseOptions(args.slice(2), ['project', 'status', 'priority', 'q', 'sort', 'archived', ...(scope === 'entity' ? ['entity'] : [])]);
    archiveFilter(options.archived);
    if (scope === 'task') {
      console.log(JSON.stringify(await request(`/items?${new URLSearchParams(options)}`), null, 2));
    } else {
      const { entity, project, status, priority, q, sort, archived } = options;
      const where = [
        ...(status === undefined ? [] : [{ field: 'status', op: 'eq', value: status }]),
        ...(priority === undefined ? [] : [{ field: 'priority', op: 'eq', value: priority }]),
        ...(q === undefined ? [] : [{ field: 'title', op: 'contains', value: q }]),
      ];
      const view = { layout: 'table', entity, project, ...(where.length ? { where: { all: where } } : {}), ...(sort === undefined ? {} : { sort }) };
      console.log(JSON.stringify(await request('/query', 'POST', { view, archived }), null, 2));
    }
    return;
  }
  if (['archive', 'restore', 'delete'].includes(action)) {
    const id = identifier(args[2]);
    const options = parseOptions(args.slice(3), action === 'delete' ? ['revision', 'confirm'] : ['revision']);
    const revision = nonempty(options.revision, '--revision');
    if (action === 'delete' && options.confirm !== id) throw new Error(`Deletion requires --confirm ${id}`);
    const endpoint = `/entities/${id}${action === 'delete' ? '' : `/${action}`}`;
    console.log(JSON.stringify(await request(endpoint, action === 'delete' ? 'DELETE' : 'POST', { revision }), null, 2));
    return;
  }
  if (action !== 'create' && action !== 'update') throw new Error(`Expected ${scope} list, create, update, archive, restore, or delete. Run pm --help.`);
  const updating = action === 'update';
  const id = updating ? identifier(args[2]) : undefined;
  const options = parseOptions(args.slice(updating ? 3 : 2), [...FIELD_OPTIONS, 'set', ...(updating ? ['revision', 'unset'] : ['body', 'idempotency-key', ...(scope === 'entity' ? ['entity'] : [])])]);
  if (options.revision !== undefined) nonempty(options.revision, '--revision');
  if (options['idempotency-key'] !== undefined) nonempty(options['idempotency-key'], '--idempotency-key');
  if (scope === 'entity' && !updating) nonempty(options.entity, '--entity');
  const changes = changesFrom(options);
  if (!Object.keys(changes).length) throw new Error('Provide at least one entity field');
  let result: FileRecord;
  if (updating) {
    const revision = options.revision ?? (await request<FileRecord | UnsupportedFile>(`/files/${id}`)).revision;
    result = await request<FileRecord>(`/entities/${id}`, 'PATCH', { changes, revision });
  } else {
    nonempty(changes.title as string | undefined, '--title');
    result = await request<FileRecord>(scope === 'task' ? '/items' : '/entities', 'POST', changes, options['idempotency-key']);
  }
  console.log(JSON.stringify(result, null, 2));
}

export async function runCli(args: string[]): Promise<void> {
  try { await executeCli(args); }
  catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('CLI_INVALID_ARGUMENT', (error as Error).message);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runCli(process.argv.slice(2)); }
  catch (error) { console.error(`pm: ${(error as Error).message}`); process.exitCode = 1; }
}
