#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import type { Diagnostic, FileRecord, UnsupportedFile, WorkspaceSnapshot } from '../pm-schema/index.ts';
import { inspectFrontmatter, inspectMarkdown } from '../pm-markdown/index.ts';
import { CliAuthError, loginCli, logoutCli } from './auth.ts';
import { createCliRuntime, CliRequestError, identifier, inputFile, nonempty, objectInput, parseOptions, textFile, type CliFamily, type CliRuntime } from './runtime.ts';
import { pmToolCallProjectionSchema } from '../agent-contracts/src/pm-tools.ts';
import { pluginOperation, pluginRead } from './plugin-adapter.ts';
import { managePlugin, PLUGIN_POLICY_NOTICE } from './plugin-distribution.ts';
import { collaborationFamily } from './collaboration.ts';
import { administrationFamily } from './administration.ts';
import { documentsFilesFamily } from './documents-files.ts';
import { dashboardFamily } from './dashboard.ts';
import { planningRecordsFamily } from './planning-records.ts';
import { automationFamily } from './automation.ts';
import { integrationsFamily } from './integrations.ts';
import { agentAccessFamily } from './agent-access.ts';
import { AgentConnectionError } from './agent-connection.ts';
import { agentSessionsFamily } from './agent-sessions.ts';
import { agentProvidersFamily } from './agent-providers.ts';
import { agentExtensionsFamily } from './agent-extensions.ts';
import { agentRuntimeFamily } from './agent-runtime.ts';
import { agentDeliveryFamily } from './agent-delivery.ts';
import { agentEvaluationFamily } from './agent-evaluation.ts';

const CLI_FAMILIES: readonly CliFamily[] = [
  collaborationFamily, administrationFamily, documentsFilesFamily, dashboardFamily,
  planningRecordsFamily, automationFamily, integrationsFamily, agentAccessFamily,
  agentSessionsFamily, agentProvidersFamily, agentExtensionsFamily, agentRuntimeFamily,
  agentDeliveryFamily, agentEvaluationFamily,
];

const HELP = `Markdown PM Lab — operate the same live workspace as the browser

Usage:
  pm login [--email EMAIL]
  pm logout
  pm protocol
  pm plugin tools
  pm plugin workspaces
  pm plugin call|result --file ORIGINAL_REQUEST.json
  pm plugin check --file RESULT.json
  pm plugin generate|install|update --root ABSOLUTE_PRIVATE_DIR --origin CONCRETE_ORIGIN
  pm plugin uninstall --root ABSOLUTE_PRIVATE_DIR
  pm file ID
  pm context ID
  pm task list [--project ID] [--status todo] [--priority high] [--q text] [--sort id] [--archived exclude|include|only]
  pm task create --title TEXT [--project ID] [--kind task] [--idempotency-key KEY]
  pm entity list [--entity KIND] [--project ID] [--status STATUS] [--archived exclude|include|only]
  pm entity create --entity KIND --title TEXT [fields] [--set JSON] [--idempotency-key KEY]
  pm task|entity source ID --file SOURCE.md --revision HASH [--idempotency-key KEY]
  pm task|entity body ID --file BODY.md --revision HASH [--idempotency-key KEY]
  pm task|entity update ID [fields] [--set JSON] [--unset FIELD,FIELD] [--revision HASH]
  pm task|entity archive ID --revision HASH
  pm task|entity restore ID --revision HASH
  pm task|entity delete ID --revision HASH --confirm ID
  pm creation-attempt get|recover KEY [--kind task|entity]
  pm command receipt UUID
  pm config get
  pm config set --file PATH --revision REV
  pm view list
  pm view get ID
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
Source saves require the complete Markdown source and an explicit current revision.
Body saves replace only the Markdown suffix (including the unchanged # Title);
frontmatter bytes, identity, metadata and formal relationships are preserved.
Source/body files are UTF-8, at most 4 MiB including retained frontmatter.
On an unconfirmed save, compare pm file ID with the printed expected source hash;
do not blindly retry. Creation prints its original key on stderr before dispatch.
Query that key with its original --kind; recover repairs only that original attempt.
not_found/pending is not permission to allocate a new key or recreate a deleted item.
Migration preview never changes business files; inspect its diff/diagnostics
before apply. Apply and restore both require matching revision and confirmation.
PM_API_URL defaults to http://127.0.0.1:4194 and must point at this v4 PM API.
Authentication (first match wins): PM_SESSION_TOKEN, complete PM_EMAIL + PM_PASSWORD,
or a private, unexpired session saved by pm login for this service origin.
Login prompts for a hidden password (no password command-line option).
Session storage defaults to $XDG_CONFIG_HOME/dovspace/pm-cli, or
~/.config/dovspace/pm-cli. PM_CLI_SESSION_DIR selects an absolute private directory.
Remote services require
HTTPS; HTTP is allowed only on loopback. Logout revokes the server session and
removes only this origin's saved session; failures retain local credentials.
PM_WORKSPACE_ID selects the workspace; otherwise the CLI uses the single
workspace the account can access.
PM commands use their native workspace/core services; Agent commands use independent Agent access.
Plugin adapters use the same PM login, explicit targets, revisions and native
business service. Keep the original request file and operationId. Repeated
plugin call attempts query /result only; unknown is never redispatched.
plugin call/result exit 0 means transport/projection handling, NOT business success.
Only visibility=visible AND status=succeeded AND result present AND error=null
allows a consumer to continue. Use:
pm plugin result --file ORIGINAL_REQUEST.json > RESULT.json && pm plugin check --file RESULT.json && YOUR_NEXT_COMMAND
failed, unknown, pending_approval, running, redacted and unavailable must stop.
plugin check is a local, schema-validated success assertion; it sends no requests.
Plugin distribution never rewrites native client configs or reads their tokens.
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
    if (status !== undefined) this.status = status;
    if (current !== undefined) this.current = current;
  }
}


function archiveFilter(value: string | undefined): void {
  if (value !== undefined && !['exclude', 'include', 'only'].includes(value)) throw new Error('archived must be exclude, include, or only');
}

function migrationIdentifier(value: string | undefined): string {
  const id = nonempty(value, 'migration ID');
  if (!/^mig-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error('Invalid migration ID');
  return id;
}

function originalKey(value: string | undefined): string {
  const key = nonempty(value, 'original operation key');
  if (key.length > 512 || /[\u0000-\u001f\u007f]/u.test(key)) throw new Error('Original key must be at most 512 characters without control characters');
  return key;
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


async function executeCli(args: string[], runtime: CliRuntime): Promise<void> {
  const request = <T>(endpoint: string, method = 'GET', body?: unknown, idempotencyKey?: string): Promise<T> => runtime.json<T>('core', endpoint, {
    method, ...(body === undefined ? {} : { body }),
    ...(idempotencyKey === undefined
      ? method !== 'GET' && /^\/(?:files|entities)\//.test(endpoint) ? { idempotencyKey: randomUUID() } : {}
      : { idempotencyKey }),
  });
  if (!args.length || args.includes('--help') || args[0] === 'help' || args[0] === '-h') {
    console.log([HELP, ...CLI_FAMILIES.map(family => family.help)].join('\n'));
    return;
  }
  for (const family of CLI_FAMILIES) if (await family.dispatch(args, runtime)) return;
  if (args[0] === 'plugin') {
    const action = args[1];
    if (action === 'tools' || action === 'workspaces') {
      if (args.length !== 2) throw new Error(`Usage: pm plugin ${action}`);
      console.error(PLUGIN_POLICY_NOTICE);
      console.log(JSON.stringify(await pluginRead(action), null, 2));
      return;
    }
    if (action === 'check') {
      const options = parseOptions(args.slice(2), ['file']);
      const parsed = pmToolCallProjectionSchema.safeParse(await inputFile(options.file));
      if (!parsed.success || parsed.data.visibility !== 'visible' || parsed.data.status !== 'succeeded' || parsed.data.result === null || parsed.data.error !== null) {
        throw new CliError('CLI_PLUGIN_NOT_SUCCEEDED', 'Result is not a visible, validated business success. Stop; query the original operation when its outcome is unconfirmed.');
      }
      runtime.print(parsed.data);
      return;
    }
    if (action === 'call' || action === 'result') {
      const options = parseOptions(args.slice(2), ['file']);
      console.error(PLUGIN_POLICY_NOTICE);
      console.log(JSON.stringify(await pluginOperation(action, await inputFile(options.file)), null, 2));
      return;
    }
    if (action === 'generate' || action === 'install' || action === 'update' || action === 'uninstall') {
      const options = parseOptions(args.slice(2), action === 'uninstall' ? ['root'] : ['root', 'origin']);
      console.log(JSON.stringify(await managePlugin(action, nonempty(options.root, '--root'), action === 'uninstall' ? undefined : nonempty(options.origin, '--origin')), null, 2));
      return;
    }
    throw new Error('Usage: pm plugin tools|workspaces|call|result|check|generate|install|update|uninstall');
  }
  if (args[0] === 'login') {
    const options = parseOptions(args.slice(1), ['email']);
    if (options.email !== undefined) nonempty(options.email, '--email');
    console.log(JSON.stringify(await loginCli(options.email), null, 2));
    return;
  }
  if (args[0] === 'logout') {
    if (args.length !== 1) throw new Error('Usage: pm logout');
    console.log(JSON.stringify(await logoutCli(), null, 2));
    return;
  }
  if (args[0] === 'creation-attempt') {
    const action = args[1];
    if (action !== 'get' && action !== 'recover') throw new Error('Usage: pm creation-attempt get|recover KEY [--kind task|entity]');
    const key = originalKey(args[2]);
    const options = parseOptions(args.slice(3), ['kind']);
    const kind = options.kind ?? 'entity';
    if (kind !== 'task' && kind !== 'entity') throw new Error('--kind must be task or entity, matching the original creation command');
    console.log(JSON.stringify(await request(`/creation-attempts/${encodeURIComponent(key)}${action === 'recover' ? '/recover' : ''}?kind=${kind}`, action === 'recover' ? 'POST' : 'GET', action === 'recover' ? {} : undefined), null, 2));
    return;
  }
  if (args[0] === 'command') {
    if (args[1] !== 'receipt' || args.length !== 3) throw new Error('Usage: pm command receipt UUID');
    const id = nonempty(args[2], 'original command UUID').toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error('Invalid command UUID');
    runtime.print(await runtime.json('workspace', `/commands/${id}`));
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
    if (action === 'list' || action === 'get') {
      if (args.length !== (action === 'list' ? 2 : 3)) throw new Error('Usage: pm view list | get ID');
      const id = action === 'get' ? nonempty(args[2], 'view ID') : undefined;
      if (id && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw new Error('Invalid view ID');
      const snapshot = await request<WorkspaceSnapshot>('/workspace');
      const diagnostics = snapshot.errors.filter(diagnostic => diagnostic.path.startsWith('.pm/views/'));
      if (id === undefined) runtime.print({ items: snapshot.views, diagnostics });
      else {
        const view = snapshot.views.find(candidate => candidate.id === id);
        if (!view) throw new CliError('CLI_VIEW_NOT_FOUND', 'Saved view is missing, unreadable, or not accessible.', diagnostics, 404);
        runtime.print(view);
      }
      return;
    }
    if (action !== 'query' && action !== 'save') throw new Error('Usage: pm view list | get ID | query --file PATH | save ID --file PATH [--revision REV]');
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
  const action = args[1] ?? '';
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
  if (action === 'source' || action === 'body') {
    const id = identifier(args[2]);
    const options = parseOptions(args.slice(3), ['file', 'revision', 'idempotency-key']);
    const revision = nonempty(options.revision, '--revision');
    let raw = await textFile(options.file, 4 * 1024 * 1024);
    if (action === 'body') {
      const current = await request<FileRecord | UnsupportedFile>(`/files/${id}`);
      if (!('entity' in current)) throw new CliError('UNSUPPORTED_SCHEMA_VERSION', 'Unsupported source is read-only.', current.diagnostics, 422, current);
      if (current.revision !== revision) throw new CliError('REVISION_CONFLICT', 'Body save requires the exact revision used to prepare the edit.', [], 409, current);
      const section = inspectFrontmatter(current.raw);
      raw = `${current.raw.slice(0, current.raw.length - section.body.length)}${raw}`;
      if (inspectMarkdown(raw).title !== current.entity.title) throw new Error('Body input must include the unchanged first-level Markdown title; use an explicit source/property edit to change title.');
    }
    if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error('Complete source exceeds 4 MiB');
    const key = originalKey(options['idempotency-key'] ?? randomUUID());
    const expected = createHash('sha256').update(raw).digest('hex');
    console.error(`pm: Original source-save key ${key}; expected revision ${expected}. If unconfirmed, compare pm file ${id} before any retry.`);
    runtime.print(await request(`/files/${id}`, 'PUT', { raw, revision }, key));
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
  if (action !== 'create' && action !== 'update') throw new Error(`Expected ${scope} list, create, update, source, body, archive, restore, or delete. Run pm --help.`);
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
    const key = originalKey(options['idempotency-key'] ?? randomUUID());
    console.error(`pm: Original creation key ${key}; query with pm creation-attempt get ${JSON.stringify(key)} --kind ${scope}. Never replace an unconfirmed key.`);
    result = await request<FileRecord>(scope === 'task' ? '/items' : '/entities', 'POST', changes, key);
  }
  console.log(JSON.stringify(result, null, 2));
}

export async function runCli(args: string[]): Promise<void> {
  try { await executeCli(args, createCliRuntime()); }
  catch (error) {
    if (error instanceof CliError) throw error;
    if (error instanceof CliRequestError) throw new CliError(error.code, error.message, error.diagnostics, error.status, error.current);
    if (error instanceof CliAuthError) throw new CliError(error.code, error.message);
    if (error instanceof AgentConnectionError) throw new CliError(error.code, error.message, [], error.status);
    throw new CliError('CLI_INVALID_ARGUMENT', (error as Error).message);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runCli(process.argv.slice(2)); }
  catch (error) { console.error(`pm: ${(error as Error).message}`); process.exitCode = 1; }
}
