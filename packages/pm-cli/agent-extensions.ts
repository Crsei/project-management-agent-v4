import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { extensionBindSchema } from '../agent-contracts/src/extensions.ts';
import { mcpAppCallInputSchema, mcpAppContextInputSchema, mcpAppResourceInputSchema } from '../agent-contracts/src/mcp-apps.ts';
import { AgentConnectionError, agentMcpClients, connectAgent, type AgentConnection, type AgentPmContext } from './agent-connection.ts';
import { readPrivateFile } from './private-files.ts';
import { inputFile, nonempty, objectInput, parseOptions, type CliFamily, type CliRuntime } from './runtime.ts';

const resources = ['extensions', 'mcp', 'skills', 'apps', 'grants'] as const;
const targetId = z.string().min(1).max(512).refine(value => !/[\u0000-\u0020\u007f/\\%?#]/u.test(value) && value !== '.' && value !== '..');
const contextId = targetId.max(100);
const scopeSchema = z.strictObject({ workspaceId: z.uuid(), projectId: z.string().regex(/^PRJ-\d+$/) });
const jsonHeaders = { 'Content-Type': 'application/json', Accept: 'application/json' };
type NativeOperation = { command: string; input: 'none' | 'file' | 'private' };

// Only these explicit resource actions can select a native management command.
// File contents are arguments, never a route, method, command name or host program.
const mcpOperations = {
  list: { command: 'get_mcp_servers', input: 'none' },
  management: { command: 'get_mcp_management', input: 'none' },
  'definition-save': { command: 'save_mcp_definition', input: 'private' },
  upsert: { command: 'upsert_mcp_server', input: 'private' },
  configure: { command: 'set_mcp_agent_configuration', input: 'private' },
  assign: { command: 'toggle_mcp_app', input: 'file' },
  'import-preview': { command: 'preview_mcp_import', input: 'none' },
  'import-apply': { command: 'apply_mcp_import', input: 'file' },
  delete: { command: 'delete_mcp_server', input: 'file' },
  sync: { command: 'resync_mcp_to_apps', input: 'file' },
  'checks-start': { command: 'start_mcp_connectivity_checks', input: 'file' },
  'checks-cancel': { command: 'cancel_mcp_connectivity_checks', input: 'file' },
  validate: { command: 'validate_mcp_command', input: 'file' },
} as const satisfies Record<string, NativeOperation>;
const skillOperations = {
  list: { command: 'get_installed_skills', input: 'none' },
  'scan-native': { command: 'scan_native_skills', input: 'none' },
  'scan-unmanaged': { command: 'scan_unmanaged_skills', input: 'none' },
  repos: { command: 'get_skill_repos', input: 'none' },
  backups: { command: 'get_skill_backups', input: 'none' },
  'backup-delete': { command: 'delete_skill_backup', input: 'file' },
  'backup-restore': { command: 'restore_skill_backup', input: 'file' },
  discover: { command: 'discover_available_skills', input: 'file' },
  'discover-repo': { command: 'discover_repo_skills', input: 'file' },
  search: { command: 'search_skills_sh', input: 'file' },
  install: { command: 'install_skill_unified', input: 'file' },
  uninstall: { command: 'uninstall_skill_unified', input: 'file' },
  'install-zip': { command: 'install_skills_from_zip', input: 'file' },
  import: { command: 'import_skills_from_apps', input: 'file' },
  assign: { command: 'toggle_skill_app', input: 'file' },
  'updates-check': { command: 'check_skill_updates', input: 'none' },
  update: { command: 'update_skill', input: 'file' },
  sync: { command: 'resync_skills_to_apps', input: 'none' },
  'storage-migrate': { command: 'migrate_skill_storage', input: 'file' },
  'repo-add': { command: 'add_skill_repo', input: 'file' },
  'repo-remove': { command: 'remove_skill_repo', input: 'file' },
  browse: { command: 'browse_directory', input: 'file' },
  read: { command: 'read_skill_file', input: 'file' },
} as const satisfies Record<string, NativeOperation>;

const help = `Agent extension management (local unprotected access or configured Agent login):
  agent extensions targets
  agent extensions contexts [--workspace-id UUID --project-id PRJ-ID --pm-session true]
  agent extensions resolve --provider INSTANCE
  agent extensions resolve-enabled [--context ID]
  agent extensions bind --file BINDING.json
  agent extensions rebind --context ID --file BINDING.json
  agent extensions unbind --context ID --confirm true
  agent extensions settings --context ID [--pm-session true]
  agent extensions settings-save --context ID --file SETTINGS.json [--pm-session true]
  agent extensions events --context ID [--seconds 30] [--pm-session true]
  agent mcp catalog
  agent mcp list|management|import-preview --context ID [--pm-session true]
  agent mcp definition-save|upsert|configure --context ID --private-file ABSOLUTE_0600.json [--pm-session true]
  agent mcp assign|import-apply|delete|sync|checks-start|checks-cancel|validate --context ID --file ARGS.json [--pm-session true]
  agent skills list|scan-native|scan-unmanaged|repos|backups|updates-check|sync --context ID
  agent skills discover|discover-repo|search|install|uninstall|install-zip|import|assign|update --context ID --file ARGS.json
  agent skills backup-delete|backup-restore|storage-migrate|repo-add|repo-remove|browse|read --context ID --file ARGS.json
  agent skills upload --context ID --file SKILLS.zip
  agent apps snapshot|tools --thread ID --item ID [--pm-session true]
  agent apps call|resource|context --thread ID --item ID --file ARGS.json [--pm-session true]
  agent apps clear-context --thread ID --item ID [--pm-session true]
  agent grants list
  agent grants revoke --id UUID --confirm true
Arguments are the exact native API argument objects, not command envelopes. MCP credential entry uses only an explicit private file; no OAuth, host, registry, import, merge, probe or restart is implicit. Skills install/assignment is not proof of loading or invocation. Apps require the existing producing live capability; history never restores it. Grants require the existing PM browser session, not the Agent operator cookie. Writes are never retried; reconcile management/installed state after an unknown result. Events are bounded and never reconnect or replay writes.`;

function usage(resource: string): never { throw new Error(`Unsupported agent ${resource} action or options.\n${help}`); }
function segment(value: string | undefined, name: string, context = false): string {
  const parsed = (context ? contextId : targetId).safeParse(nonempty(value, name));
  if (!parsed.success) throw new Error(`${name} must be an opaque native ID without path or URL escapes`);
  return encodeURIComponent(parsed.data);
}
function enabled(value: string | undefined, name: string): boolean {
  if (value === undefined) return false;
  if (value !== 'true') throw new Error(`${name} requires the explicit value true`);
  return true;
}
async function pmContext(options: Record<string, string>, runtime: CliRuntime): Promise<AgentPmContext | undefined> {
  return enabled(options['pm-session'], '--pm-session') ? runtime.authentication() : undefined;
}
async function privateInput(filename: string | undefined): Promise<Record<string, unknown>> {
  const selected = nonempty(filename, '--private-file');
  if (!path.isAbsolute(selected)) throw new Error('--private-file requires an explicit absolute owned 0600 file inside a private directory');
  let contents: string | undefined;
  try { contents = await readPrivateFile(selected); }
  catch { throw new Error('The explicit private configuration file is unavailable or unsafe; it was not read.'); }
  if (contents === undefined) throw new Error('The explicit private configuration file does not exist.');
  let value: unknown;
  try { value = JSON.parse(contents); }
  catch { throw new Error('The private configuration file must contain a JSON argument object.'); }
  return objectInput(value);
}

// Error bodies may contain native diagnostics or credentials. Preserve only a safe
// authoritative code, never echo server text, command arguments or a local file.
async function checked(response: Response): Promise<Response> {
  if (response.ok) return response;
  let code = 'AGENT_EXTENSION_REQUEST_FAILED';
  const length = Number(response.headers.get('content-length') ?? '0');
  if (length <= 64 * 1024) {
    const reader = response.body?.getReader();
    if (reader) {
      let text = '', size = 0;
      const decoder = new TextDecoder();
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 64 * 1024) { await reader.cancel(); break; }
          text += decoder.decode(next.value, { stream: true });
        }
        if (size <= 64 * 1024) {
          const body = JSON.parse(text + decoder.decode()) as { code?: unknown; error?: unknown };
          const candidate = body.code ?? body.error;
          if (typeof candidate === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(candidate)) code = candidate;
        }
      } catch { /* A malformed error never confirms an operation outcome. */ }
      finally { reader.releaseLock(); }
    }
  } else await response.body?.cancel();
  throw new AgentConnectionError(code, `Agent management request rejected (HTTP ${response.status}, ${code}). No write was retried; read authoritative state before another mutation.`, response.status);
}
async function json<T>(connection: Pick<AgentConnection, 'request'>, route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', pm?: AgentPmContext): Promise<T> {
  const response = await checked(await connection.request(route, { method, headers: jsonHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(route.endsWith('/invoke') ? 10 * 60_000 + 30_000 : 30_000) }, pm));
  try { return await response.json() as T; }
  catch { throw new AgentConnectionError('AGENT_EXTENSION_RESPONSE_INVALID', 'Management response was incomplete JSON. No write was retried; read authoritative state.'); }
}
async function upload(connection: Pick<AgentConnection, 'request'>, context: string, filename: string | undefined): Promise<unknown> {
  const file = await open(nonempty(filename, '--file'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 100 * 1024 * 1024) throw new Error('Skill uploads require a regular ZIP file of at most 100 MiB.');
    // Read this already-open descriptor, not a second pathname that could be replaced.
    const bytes = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const next = await file.read(bytes, size, bytes.length - size, null);
      if (!next.bytesRead) break;
      size += next.bytesRead;
    }
    if (size !== info.size || size < 4 || bytes.readUInt32LE(0) !== 0x04034b50) throw new Error('Skill upload requires a stable, nonempty ZIP archive; no bytes were sent.');
    const response = await checked(await connection.request(`/api/extensions/contexts/${context}/uploads`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: bytes.subarray(0, size), signal: AbortSignal.timeout(120_000) }));
    try { return await response.json(); }
    catch { throw new AgentConnectionError('AGENT_EXTENSION_RESPONSE_INVALID', 'ZIP upload response was incomplete. Read the original upload state; installation was not inferred.'); }
  } finally { await file.close(); }
}
async function events(connection: Pick<AgentConnection, 'request'>, context: string, seconds: string | undefined, runtime: CliRuntime, pm?: AgentPmContext): Promise<void> {
  const duration = seconds === undefined ? 30 : Number(seconds);
  if (!Number.isInteger(duration) || duration < 1 || duration > 300) throw new Error('--seconds must be an integer from 1 to 300');
  const signal = AbortSignal.timeout(duration * 1000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await checked(await connection.request(`/api/extensions/contexts/${context}/events`, { headers: { Accept: 'text/event-stream' }, signal }, pm));
    if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) throw new Error('The extension service did not return its native event stream.');
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '';
    while (true) {
      const next = await reader.read();
      if (next.done) throw new AgentConnectionError('AGENT_EXTENSION_EVENTS_DISCONNECTED', 'The native event stream disconnected before its observation deadline. Re-read current state; no command was replayed.');
      buffer += decoder.decode(next.value, { stream: true });
      if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) throw new Error('Extension event exceeds the supported bounded event size.');
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        let event = 'message';
        const data: string[] = [];
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length) {
          let value: unknown;
          try { value = JSON.parse(data.join('\n')); }
          catch { throw new AgentConnectionError('AGENT_EXTENSION_EVENT_INVALID', 'The native extension event was not valid JSON. No command was replayed.'); }
          runtime.print({ event, data: value });
        }
      }
    }
  } catch (error) { if (!signal.aborted) throw error; }
  finally { await reader?.cancel().catch(() => undefined); reader?.releaseLock(); }
}

async function nativeOperation(resource: 'mcp' | 'skills', action: string, args: string[], runtime: CliRuntime): Promise<void> {
  const operations: Record<string, NativeOperation> = resource === 'mcp' ? mcpOperations : skillOperations;
  if (resource === 'mcp' && action === 'catalog') {
    parseOptions(args, []);
    const connection = await connectAgent();
    try { runtime.print(await json(connection, '/api/extensions/mcp/catalog')); } finally { connection.close(); }
    return;
  }
  if (resource === 'skills' && action === 'upload') {
    const options = parseOptions(args, ['context', 'file']);
    const context = segment(options.context, '--context', true);
    const connection = await connectAgent();
    try { runtime.print(await upload(connection, context, options.file)); } finally { connection.close(); }
    return;
  }
  if (!Object.hasOwn(operations, action)) usage(resource);
  const operation = operations[action]!;
  const options = parseOptions(args, ['context', 'pm-session', ...(operation.input === 'none' ? [] : [operation.input === 'private' ? 'private-file' : 'file'])]);
  const context = segment(options.context, '--context', true);
  const input = operation.input === 'none' ? {} : operation.input === 'private' ? await privateInput(options['private-file']) : await inputFile(options.file);
  const pm = await pmContext(options, runtime);
  const connection = await connectAgent();
  try { runtime.print(await json(connection, `/api/extensions/contexts/${context}/invoke`, { command: operation.command, args: input }, 'POST', pm)); }
  finally { connection.close(); }
}

async function extensions(action: string, args: string[], runtime: CliRuntime): Promise<void> {
  let route: string, body: unknown, method = 'GET';
  let pm: AgentPmContext | undefined;
  if (action === 'targets') {
    parseOptions(args, []); route = '/api/extensions/targets';
  } else if (action === 'contexts') {
    const options = parseOptions(args, ['workspace-id', 'project-id', 'pm-session']);
    const scoped = options['workspace-id'] !== undefined || options['project-id'] !== undefined;
    const scope = scoped ? scopeSchema.parse({ workspaceId: options['workspace-id'], projectId: options['project-id'] }) : undefined;
    pm = await pmContext(options, runtime);
    if (scope && !pm) throw new Error('Project-private contexts require --pm-session true with the current PM session in addition to Agent service access.');
    route = `/api/extensions/contexts${scope ? `?${new URLSearchParams(scope)}` : ''}`;
  } else if (action === 'resolve') {
    const options = parseOptions(args, ['provider']);
    route = `/api/extensions/providers/${segment(options.provider, '--provider')}/context`; body = {}; method = 'POST';
  } else if (action === 'resolve-enabled') {
    const options = parseOptions(args, ['context']);
    route = '/api/extensions/contexts/resolve-enabled'; body = options.context === undefined ? {} : { contextId: decodeURIComponent(segment(options.context, '--context', true)) }; method = 'POST';
  } else if (action === 'bind' || action === 'rebind') {
    const options = parseOptions(args, action === 'bind' ? ['file'] : ['context', 'file']);
    body = extensionBindSchema.parse(await inputFile(options.file)); method = 'POST';
    route = action === 'bind' ? '/api/extensions/contexts' : `/api/extensions/contexts/${segment(options.context, '--context', true)}/binding`;
  } else if (action === 'unbind') {
    const options = parseOptions(args, ['context', 'confirm']);
    if (!enabled(options.confirm, '--confirm')) throw new Error('Unbind requires --confirm true; native configuration remains unchanged.');
    route = `/api/extensions/contexts/${segment(options.context, '--context', true)}`; body = { confirmed: true }; method = 'DELETE';
  } else if (action === 'settings' || action === 'settings-save' || action === 'events') {
    const options = parseOptions(args, ['context', 'pm-session', ...(action === 'settings-save' ? ['file'] : action === 'events' ? ['seconds'] : [])]);
    const context = segment(options.context, '--context', true);
    pm = await pmContext(options, runtime);
    const connection = await connectAgent();
    try {
      if (action === 'events') await events(connection, context, options.seconds, runtime, pm);
      else runtime.print(await json(connection, `/api/extensions/contexts/${context}/invoke`, { command: action === 'settings' ? 'get_settings' : 'save_settings', args: action === 'settings' ? {} : await inputFile(options.file) }, 'POST', pm));
    } finally { connection.close(); }
    return;
  } else usage('extensions');
  const connection = await connectAgent();
  try { runtime.print(await json(connection, route, body, method, pm)); } finally { connection.close(); }
}

async function apps(action: string, args: string[], runtime: CliRuntime): Promise<void> {
  if (!['snapshot', 'tools', 'call', 'resource', 'context', 'clear-context'].includes(action)) usage('apps');
  const takesFile = ['call', 'resource', 'context'].includes(action);
  const options = parseOptions(args, ['thread', 'item', 'pm-session', ...(takesFile ? ['file'] : [])]);
  const route = `/api/mcp-apps/${segment(options.thread, '--thread')}/${segment(options.item, '--item')}/${action === 'clear-context' ? 'context' : action}`;
  let body: unknown;
  if (takesFile) {
    const input = await inputFile(options.file);
    body = action === 'call' ? mcpAppCallInputSchema.parse(input) : action === 'resource' ? mcpAppResourceInputSchema.parse(input) : mcpAppContextInputSchema.parse(input);
  } else if (action === 'clear-context') body = {};
  const pm = await pmContext(options, runtime);
  const connection = await connectAgent();
  try { runtime.print(await json(connection, route, body, body === undefined ? 'GET' : 'POST', pm)); } finally { connection.close(); }
}

const grantListSchema = z.strictObject({
  csrfToken: z.string().min(1).max(128),
  items: z.array(z.strictObject({
    id: z.uuid(), clientName: z.string(),
    scope: z.strictObject({ workspaceId: z.uuid(), projectId: z.string().nullable() }),
    access: z.enum(['read-only', 'full']), threadIds: z.array(z.string()),
    createdAt: z.string(), expiresAt: z.string(), revokedAt: z.string().nullable(),
  })),
});
async function grants(action: string, args: string[], runtime: CliRuntime): Promise<void> {
  if (action !== 'list' && action !== 'revoke') usage('grants');
  const options = parseOptions(args, action === 'list' ? [] : ['id', 'confirm']);
  const id = action === 'revoke' ? z.uuid().parse(nonempty(options.id, '--id')) : undefined;
  if (action === 'revoke' && !enabled(options.confirm, '--confirm')) throw new Error('Grant revocation requires --confirm true.');
  const pm = await runtime.authentication();
  const management = grantListSchema.parse(await agentMcpClients<unknown>({ action: 'list', pmContext: pm }));
  if (action === 'list') { runtime.print({ items: management.items }); return; }
  if (!management.items.some(grant => grant.id === id)) throw new Error('The requested grant is not in the current PM actor’s authoritative grant list.');
  const result = z.strictObject({ revoked: z.literal(true) }).parse(await agentMcpClients<unknown>({ action: 'revoke', id: id!, csrfToken: management.csrfToken, pmContext: pm }));
  runtime.print(result);
}

export const agentExtensionsFamily: CliFamily = {
  help,
  async dispatch(args, runtime) {
    if (args[0] !== 'agent' || !(resources as readonly string[]).includes(args[1] ?? '')) return false;
    const resource = args[1]!, action = args[2] ?? '';
    if (resource === 'mcp' || resource === 'skills') await nativeOperation(resource, action, args.slice(3), runtime);
    else if (resource === 'extensions') await extensions(action, args.slice(3), runtime);
    else if (resource === 'apps') await apps(action, args.slice(3), runtime);
    else await grants(action, args.slice(3), runtime);
    return true;
  },
};
