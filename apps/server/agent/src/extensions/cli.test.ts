import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import * as DateTime from 'effect/DateTime';
import { OrchestrationV2ProviderThread, ThreadId } from '@t3tools/contracts';
import { mcpAppMetadataSchema } from '@agent-workspace/contracts/mcp-apps';
import type { ExtensionContext, ExtensionMcpImportPreview, ExtensionMcpManagement } from '@agent-workspace/contracts/extensions';
import { createMcpPresets, type McpPreset } from '@agent-workspace/contracts/mcp-presets';
import { agentExtensionsFamily } from '../../../../../packages/pm-cli/agent-extensions.ts';
import { agentLogin, agentLogout, connectAgent } from '../../../../../packages/pm-cli/agent-connection.ts';
import type { CliRuntime } from '../../../../../packages/pm-cli/runtime.ts';
import { accessGuard, accessRoutes } from '../access.ts';
import { extensionRoutes } from './routes.ts';
import { getExtensionHost, stopExtensionHost } from './service.ts';
import { readExtensionContexts } from './storage.ts';
import { createProviderInstance, getStoredInstance, updateProviderInstance } from '../providers/instances.ts';
import { closeStore, listRecords, readRecord } from '../durable/store.ts';
import { ensureThread } from '../durable/threads.ts';
import { chatOnlyExecutionSelection } from '@agent-workspace/contracts/chat';
import { resolveAgentExecution } from '../durable/agent-execution.ts';
import { initializeNativeOutput, emitNativeOutput, endNativeOutput, getNativeOutput } from '../durable/native-output.ts';
import { snapshotMcpApp } from '../providers/t3code/upstream-services/mcp-app-snapshot.ts';
import { providerAttachmentsDirectory } from '../providers/t3code/upstream-services/attachments.ts';
import { closeMcpAppSession, retainMcpAppSession, shutdownMcpApps } from '../mcp-apps/live.ts';
import { mcpAppRoutes } from '../mcp-apps/routes.ts';
import { mcpOAuthRoutes } from '../mcp/routes.ts';
import { authenticateMcpRequest, type McpInvocationIdentity } from '../mcp/identity.ts';
import { MCP_GRANTS, type Grant } from '../mcp/grants.ts';
import { verifyMcpServiceBearer } from '../../../../../packages/infrastructure/src/mcp-service-auth.ts';

// These cases use actual Hono management routes, the production TypeScript
// cc-switch child, SQLite, live App fencing and OAuth grants. Only PM identity
// is a disposable protocol fixture; no production accounts or model are used.
const actorId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const sessionToken = Buffer.alloc(32, 7).toString('base64url');
let savedEnvironment: NodeJS.ProcessEnv;
let root: string, origin: string;
let pmServer: Server, agentServer: Server;
let runtime: CliRuntime;
const printed: unknown[] = [];
let pmAuthenticationCalls = 0;
let authenticated = true;

beforeEach(async () => {
  savedEnvironment = { ...process.env };
  root = await mkdtemp(path.join(process.platform === 'win32' ? tmpdir() : '/tmp', 'pm-cli-extensions-'));
  process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, 'data');
  process.env.AGENT_WORKSPACE_ACCESS_TOKEN = 'isolated-extension-cli-access-'.repeat(3);
  process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = JSON.stringify([root]);
  process.env.PM_AGENT_SESSION_DIR = path.join(root, 'agent-identity');
  process.env.HOME = path.join(root, 'home');
  process.env.USERPROFILE = process.env.HOME;
  delete process.env.CC_SWITCH_EXTERNAL_TARGETS_FILE;
  delete process.env.CC_SWITCH_HOST_ENTRY;
  delete process.env.CC_SWITCH_HOST_BINARY;
  process.env.CC_SWITCH_HOST_IMPLEMENTATION = 'ts';
  for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'PI_CODING_AGENT_DIR', 'OMP_PROFILE']) delete process.env[key];
  await mkdir(path.join(process.env.HOME, '.claude'), { recursive: true });
  authenticated = true;
  pmAuthenticationCalls = 0;
  printed.length = 0;
  pmServer = createServer((request, response) => {
    const accepted = authenticated && (request.headers.cookie === `pm_v4_session=${sessionToken}` || request.headers.authorization === `Bearer ${sessionToken}`);
    response.setHeader('Content-Type', 'application/json');
    const authorization = request.headers.authorization ?? '';
    const signed = authorization.startsWith('Bearer pm-mcp-service-v1.') ? verifyMcpServiceBearer(authorization.slice(7)) : null;
    const delegated = authenticated && signed?.actorId === actorId && signed.scope.workspaceId === workspaceId;
    if (request.url === '/api/v1/auth/me' && accepted) { response.end(JSON.stringify({ actor: { id: actorId } })); return; }
    if (!accepted && !delegated) { response.writeHead(401).end('{}'); return; }
    if (request.url === '/api/v1/agent-contexts') {
      response.end(JSON.stringify({ workspaces: [{ id: workspaceId, name: 'Disposable', workspaceAllowed: true, projects: [{ id: 'PRJ-001', name: 'Disposable project' }] }] })); return;
    }
    response.writeHead(404).end('{}');
  });
  pmServer.listen(0, '127.0.0.1');
  await once(pmServer, 'listening');
  const pmAddress = pmServer.address();
  assert.ok(pmAddress && typeof pmAddress === 'object');
  process.env.PM_API_URL = `http://127.0.0.1:${pmAddress.port}`;
  process.env.PM_AUTOMATION_SERVICE_SECRET = 'disposable-cli-oauth-signing-secret-'.repeat(3);
  const app = new Hono().route('/', mcpOAuthRoutes).route('/api', accessRoutes).use('/api/*', accessGuard).route('/api', extensionRoutes).route('/api', mcpAppRoutes);
  agentServer = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }) as Server;
  await once(agentServer, 'listening');
  const agentAddress = agentServer.address();
  assert.ok(agentAddress && typeof agentAddress === 'object');
  origin = `http://127.0.0.1:${agentAddress.port}`;
  process.env.PM_AGENT_URL = origin;
  process.env.MCP_PUBLIC_ORIGIN = origin;
  runtime = {
    async authentication() { pmAuthenticationCalls++; return { origin: process.env.PM_API_URL!, headers: { Authorization: `Bearer ${sessionToken}` } }; },
    async connection() { throw new Error('Extension management must not require PM workspace selection.'); },
    async json() { throw new Error('PM JSON is not an Agent transport.'); },
    async response() { throw new Error('PM response is not an Agent transport.'); },
    print(value) { printed.push(value); },
  };
  await agentLogin({ token: process.env.AGENT_WORKSPACE_ACCESS_TOKEN });
});
afterEach(async () => {
  await stopExtensionHost();
  await shutdownMcpApps();
  closeStore();
  for (const server of [agentServer, pmServer]) {
    if (!server) continue;
    const closed = once(server, 'close');
    server.closeAllConnections(); server.close();
    await closed;
  }
  for (const name of Object.keys(process.env)) if (!(name in savedEnvironment)) delete process.env[name];
  Object.assign(process.env, savedEnvironment);
  await rm(root, { recursive: true, force: true });
});

async function command<T>(...args: string[]): Promise<T> {
  const previous = printed.length;
  assert.equal(await agentExtensionsFamily.dispatch(['agent', ...args], runtime), true);
  assert.equal(printed.length, previous + 1);
  return printed.at(-1) as T;
}
async function argumentsFile(name: string, value: unknown): Promise<string> {
  const filename = path.join(root, name);
  await writeFile(filename, JSON.stringify(value), { mode: 0o600 });
  return filename;
}
function provider(instanceId: string, driver: 'claude' | 'codex' | 'opencode' = 'claude', config: NonNullable<Parameters<typeof createProviderInstance>[0]['config']> = {}) {
  return createProviderInstance({ instanceId, driver, config, environment: [
    { name: 'HOME', value: process.env.HOME!, sensitive: false },
    { name: 'USERPROFILE', value: process.env.HOME!, sensitive: false },
  ] });
}

test('owned finite commands reject host/path/credential escapes and unowned prefixes do nothing', async () => {
  assert.equal(await agentExtensionsFamily.dispatch(['task', 'list'], runtime), false);
  assert.equal(await agentExtensionsFamily.dispatch(['agent', 'providers', 'list'], runtime), false);
  for (const args of [
    ['mcp', 'invoke', '--command', 'host_initialize'],
    ['mcp', 'catalog', '--platform', 'win32'],
    ['skills', 'list', '--context', '../outside'],
    ['apps', 'call', '--thread', 'thread', '--item', 'item', '--token', 'never-accept-argv-secret'],
    ['extensions', 'unbind', '--context', 'owned'],
    ['grants', 'revoke', '--id', '33333333-3333-4333-8333-333333333333'],
  ]) await assert.rejects(agentExtensionsFamily.dispatch(['agent', ...args], runtime));
  assert.equal(pmAuthenticationCalls, 0);
  assert.deepEqual(printed, []);
});

test('CLI MCP catalog uses canonical templates and the Agent server platform without opening a host or installing', async () => {
  const contextsBefore = await readExtensionContexts();
  const catalog = await command<{ platform: string; presets: McpPreset[] }>('mcp', 'catalog');
  assert.equal(catalog.platform, process.platform);
  assert.deepEqual(catalog.presets, createMcpPresets(process.platform === 'win32'));
  assert.deepEqual(await readExtensionContexts(), contextsBefore);
  assert.equal(pmAuthenticationCalls, 0);
  const windows = createMcpPresets(true).find(preset => preset.id === 'memory')!;
  const posix = createMcpPresets(false).find(preset => preset.id === 'memory')!;
  assert.deepEqual(windows.server, { type: 'stdio', command: 'cmd', args: ['/c', 'npx', '-y', '@modelcontextprotocol/server-memory'] });
  assert.deepEqual(posix.server, { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] });
  const connection = await connectAgent();
  try {
    const response = await connection.request('/api/extensions/mcp/catalog?platform=win32');
    assert.equal(response.status, 400, 'A caller cannot replace the actual execution platform.');
    await response.body?.cancel();
  } finally { connection.close(); }
});

test('CLI context resolution preserves same-Home ownership, rejects overlap and refreshes revisions without import', async () => {
  const original = provider('cli-claude');
  provider('cli-shared');
  provider('cli-remote', 'opencode', { serverUrl: 'http://127.0.0.1:49999' });
  const inventory = await command<{ targets: { providerInstanceId?: string }[]; unavailableTargets: { providerInstanceId: string; reason: string }[] }>('extensions', 'targets');
  assert.ok(inventory.unavailableTargets.some(target => target.providerInstanceId === 'cli-remote'));
  const first = await command<{ context: ExtensionContext }>('extensions', 'resolve', '--provider', 'cli-claude');
  const shared = await command<{ context: ExtensionContext }>('extensions', 'resolve', '--provider', 'cli-shared');
  assert.equal(first.context.id, shared.context.id);
  const managed = await command<{ result: ExtensionMcpManagement }>('mcp', 'management', '--context', first.context.id);
  assert.deepEqual(managed.result.definitions, {});
  const revised = updateProviderInstance('cli-claude', { label: 'Revised metadata' }, getStoredInstance('cli-claude')!.revision);
  await assert.rejects(command('mcp', 'management', '--context', first.context.id));
  const refreshed = await command<{ context: ExtensionContext }>('extensions', 'resolve', '--provider', 'cli-claude');
  assert.equal(refreshed.context.id, first.context.id);
  assert.equal(refreshed.context.status, 'ready');
  assert.ok(revised.revision > original.revision);
  provider('cli-overlap', 'codex', { homePath: path.join(process.env.HOME!, '.claude', 'nested-codex') });
  await assert.rejects(command('extensions', 'resolve', '--provider', 'cli-overlap'), { status: 409 });
  assert.equal(pmAuthenticationCalls, 0);
});

test('CLI MCP preview writes nothing, stale selections reject and explicit import does not rewrite native files', async () => {
  const nativeFile = path.join(process.env.HOME!, '.claude.json');
  await writeFile(nativeFile, JSON.stringify({ mcpServers: { native: { type: 'http', url: 'https://native.example.invalid/mcp' } } }));
  provider('cli-import');
  const { context } = await command<{ context: ExtensionContext }>('extensions', 'resolve', '--provider', 'cli-import');
  const initial = await command<{ result: ExtensionMcpManagement }>('mcp', 'management', '--context', context.id);
  const before = await readFile(nativeFile, 'utf8');
  const preview = await command<{ result: ExtensionMcpImportPreview }>('mcp', 'import-preview', '--context', context.id);
  assert.equal(await readFile(nativeFile, 'utf8'), before);
  assert.deepEqual((await command<{ result: ExtensionMcpManagement }>('mcp', 'management', '--context', context.id)).result, initial.result);
  assert.equal((await getExtensionHost().browserContext(context.id, new Headers())).reloadRequired, false);
  const changed = JSON.stringify({ mcpServers: { native: { type: 'http', url: 'https://changed.example.invalid/mcp' } } });
  await writeFile(nativeFile, changed);
  const oldSelection = await argumentsFile('stale-import.json', { previewId: preview.result.previewId, selections: preview.result.entries.map(entry => ({ entryId: entry.entryId, resolution: 'import' })) });
  await assert.rejects(command('mcp', 'import-apply', '--context', context.id, '--file', oldSelection), { status: 409, code: 'mcp_import_preview_stale' });
  assert.equal(await readFile(nativeFile, 'utf8'), changed);
  const fresh = await command<{ result: ExtensionMcpImportPreview }>('mcp', 'import-preview', '--context', context.id);
  const selection = await argumentsFile('fresh-import.json', { previewId: fresh.result.previewId, selections: fresh.result.entries.map(entry => ({ entryId: entry.entryId, resolution: 'import' })) });
  const imported = await command<{ result: { applied: number } }>('mcp', 'import-apply', '--context', context.id, '--file', selection);
  assert.equal(imported.result.applied, 1);
  assert.equal(await readFile(nativeFile, 'utf8'), changed);
  assert.ok((await command<{ result: ExtensionMcpManagement }>('mcp', 'management', '--context', context.id)).result.definitions.native);
  const definition = await argumentsFile('definition.json', { definition: { id: 'explicit', name: 'Explicit', server: { type: 'http', url: 'https://explicit.example.invalid/mcp', headers: { authorization: 'synthetic-private-value' } } } });
  await command('mcp', 'definition-save', '--context', context.id, '--private-file', definition);
  const redacted = await command<{ result: ExtensionMcpManagement }>('mcp', 'management', '--context', context.id);
  assert.equal(JSON.stringify(redacted).includes('synthetic-private-value'), false);
  assert.equal(redacted.result.agentConfigurations.explicit!.claude!.enabled, false);
  await chmod(definition, 0o644);
  await assert.rejects(command('mcp', 'definition-save', '--context', context.id, '--private-file', definition), /unsafe/);
});

test('CLI native Skill observation and explicit adoption retain installed/assigned versus loaded distinction', async () => {
  provider('cli-skill');
  const skillDirectory = path.join(process.env.HOME!, '.claude', 'skills', 'cli-native-skill');
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(path.join(skillDirectory, 'SKILL.md'), '---\nname: CLI native Skill\ndescription: Isolated local fixture\n---\n# Local only\n');
  const { context } = await command<{ context: ExtensionContext }>('extensions', 'resolve', '--provider', 'cli-skill');
  const scan = await command<{ result: { directory: string; managed: boolean }[] }>('skills', 'scan-native', '--context', context.id);
  assert.ok(scan.result.some(item => item.directory === 'cli-native-skill' && item.managed === false));
  assert.deepEqual((await command<{ result: unknown[] }>('skills', 'list', '--context', context.id)).result, []);
  const selection = await argumentsFile('adopt.json', { imports: [{ directory: 'cli-native-skill', apps: {} }] });
  await command('skills', 'import', '--context', context.id, '--file', selection);
  const installed = await command<{ result: { id: string; directory: string; apps: Record<string, boolean> }[] }>('skills', 'list', '--context', context.id);
  const skill = installed.result.find(item => item.directory === 'cli-native-skill')!;
  assert.ok(skill.id);
  assert.equal(skill.apps.claude, false, 'Adoption never silently assigns another native target.');
  assert.equal('loaded' in skill, false);
  assert.equal('callable' in skill, false);
  const assignment = await argumentsFile('assignment.json', { id: skill.id, app: 'claude', enabled: true });
  await command('skills', 'assign', '--context', context.id, '--file', assignment);
  await command('skills', 'sync', '--context', context.id);
  assert.ok((await readFile(path.join(skillDirectory, 'SKILL.md'), 'utf8')).includes('Local only'));
  assert.deepEqual(listRecords('chat:generations'), [], 'Management never starts a model or restarts a Session.');
});

test('CLI ZIP upload and install use the real context-owned archive with no registry installation', async () => {
  provider('cli-zip');
  const { context } = await command<{ context: ExtensionContext }>('extensions', 'resolve', '--provider', 'cli-zip');
  const name = Buffer.from('cli-zip-skill/SKILL.md');
  const content = Buffer.from('---\nname: CLI ZIP Skill\ndescription: Disposable archive fixture\n---\n# ZIP only\n');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc32(content), 14); local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc32(content), 16); central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + content.length, 16);
  const archive = path.join(root, 'disposable-skill.zip');
  await writeFile(archive, Buffer.concat([local, name, content, central, name, end]));
  const upload = await command<{ uploadId: string }>('skills', 'upload', '--context', context.id, '--file', archive);
  assert.match(upload.uploadId, /^[0-9a-f-]{36}$/);
  assert.equal(JSON.stringify(upload).includes(root), false);
  const input = await argumentsFile('zip-install.json', { uploadId: upload.uploadId, currentApp: 'claude' });
  await command('skills', 'install-zip', '--context', context.id, '--file', input);
  const installed = await command<{ result: { id: string; directory: string; apps: Record<string, boolean> }[] }>('skills', 'list', '--context', context.id);
  const skill = installed.result.find(item => item.directory === 'cli-zip-skill')!;
  assert.ok(skill.id);
  assert.equal(skill.apps.claude, true);
  assert.equal('loaded' in skill, false);
  assert.match(await readFile(path.join(process.env.HOME!, '.claude', 'skills', skill.directory, 'SKILL.md'), 'utf8'), /ZIP only/);
  assert.deepEqual(listRecords('chat:generations'), []);
});

async function retainedApp(originatingMcpGrant?: McpInvocationIdentity) {
  const selection = chatOnlyExecutionSelection();
  const execution = await resolveAgentExecution(selection, 'cli-app-thread');
  ensureThread('cli-app-thread', undefined, selection, execution.environment);
  const reference = await Effect.runPromise(snapshotMcpApp({ attachmentsDir: providerAttachmentsDirectory(), threadId: ThreadId.make('cli-app-thread'), server: 'local-fixture', tool: 'show', resourceUri: 'ui://fixture/view', contents: [{ uri: 'ui://fixture/view', mimeType: 'text/html;profile=mcp-app', text: '<!doctype html><p>Isolated App</p>' }] }));
  assert.ok(reference);
  const app = mcpAppMetadataSchema.parse({ ...reference, producing: { threadId: 'cli-app-thread', itemId: 'cli-app-item', generationId: 'cli-app-generation', providerInstanceId: 'cli-app-provider', instanceRevision: 1, providerSessionId: 'cli-app-session', providerThreadId: 'cli-provider-thread', nativeSessionId: 'cli-native-session' } });
  initializeNativeOutput('cli-app-generation', 'cli-app-thread', 'running');
  emitNativeOutput('cli-app-generation', { type: 'item.upsert', item: { id: 'cli-app-item', type: 'dynamic_tool', status: 'completed', toolName: 'local-fixture.show', output: 'Historical output', mcpApp: app, mcpToolResult: { content: [{ type: 'text', text: 'Historical fixture result' }] } } });
  endNativeOutput('cli-app-generation', 'completed');
  const providerThread = Schema.decodeUnknownSync(Schema.toType(OrchestrationV2ProviderThread))({ id: 'cli-provider-thread', driver: 'codex', providerInstanceId: 'cli-app-provider', providerSessionId: 'cli-app-session', appThreadId: 'cli-app-thread', ownerNodeId: null, nativeThreadRef: { driver: 'codex', nativeId: 'cli-native-session', strength: 'strong' }, nativeConversationHeadRef: null, status: 'idle', firstRunOrdinal: 1, lastRunOrdinal: 1, handoffIds: [], forkedFrom: null, createdAt: DateTime.makeUnsafe('2026-11-03T00:00:00.000Z'), updatedAt: DateTime.makeUnsafe('2026-11-03T00:00:00.000Z') });
  let calls = 0;
  retainMcpAppSession({ apps: [app], executionEnvironment: execution.environment, cwd: execution.path, providerThread, blockedServers: ['pm_tools'], ...(originatingMcpGrant ? { originatingMcpGrant } : {}), assertCurrent: async () => {}, authorize: async headers => { assert.ok(headers.get('cookie')?.startsWith('agent_v4_access=')); }, close: async () => {}, mcpApps: {
    listTools: () => Effect.succeed([{ name: 'refresh', annotations: { readOnlyHint: true } }, { name: 'hidden', _meta: { ui: { visibility: ['model'] } } }]),
    callTool: () => Effect.sync(() => { calls++; return { content: [{ type: 'text', text: 'Fresh controlled fixture result' }] }; }),
    readResource: input => Effect.succeed({ contents: [{ uri: input.uri, text: 'Controlled resource' }] }),
  } });
  return { calls: () => calls };
}

test('CLI Apps uses actual producing capability, rejects hidden tools and never revives stale output', async () => {
  const live = await retainedApp();
  const target = ['--thread', 'cli-app-thread', '--item', 'cli-app-item'];
  const snapshot = await command<{ html: string }>('apps', 'snapshot', ...target);
  assert.ok(snapshot.html.includes('Isolated App'));
  const tools = await command<{ tools: { name: string; callable: boolean }[] }>('apps', 'tools', ...target);
  assert.equal(tools.tools.find(tool => tool.name === 'hidden')!.callable, false);
  const hidden = await argumentsFile('hidden-call.json', { name: 'hidden', arguments: {} });
  await assert.rejects(command('apps', 'call', ...target, '--file', hidden), { status: 403 });
  assert.equal(live.calls(), 0);
  const call = await argumentsFile('app-call.json', { name: 'refresh', arguments: {} });
  await command('apps', 'call', ...target, '--file', call);
  assert.equal(live.calls(), 1);
  await command('apps', 'clear-context', ...target);
  await closeMcpAppSession('cli-app-thread');
  assert.ok(getNativeOutput('cli-app-generation')!.items.some(item => item.id === 'cli-app-item' && item.mcpApp));
  await assert.rejects(command('apps', 'snapshot', ...target), { status: 409, code: 'mcp_app_session_stopped' });
  await assert.rejects(command('apps', 'call', ...target, '--file', call), { status: 409, code: 'mcp_app_session_stopped' });
  assert.equal(live.calls(), 1);
  assert.deepEqual(listRecords('chat:generations'), []);
});

async function oauthGrant(threadIds: string[] = []): Promise<string> {
  const post = (route: string, body: unknown) => fetch(origin + route, { method: 'POST', headers: { Origin: origin, Cookie: `pm_v4_session=${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const registered = await post('/oauth/mcp/register', { client_name: 'Disposable CLI client', redirect_uris: ['http://localhost:12222/callback'] });
  assert.equal(registered.status, 201);
  const { client_id } = await registered.json() as { client_id: string };
  const verifier = 'v'.repeat(43);
  const authorization = { client_id, redirect_uri: 'http://localhost:12222/callback', response_type: 'code', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 'disposable-state', resource: `${origin}/mcp` };
  const approval = await post('/oauth/mcp/approval', authorization);
  assert.equal(approval.status, 200);
  const { csrfToken } = await approval.json() as { csrfToken: string };
  const decision = await post('/oauth/mcp/decision', { authorization, decision: { _tag: 'approve', csrfToken, scope: { workspaceId, projectId: 'PRJ-001' }, threadIds } });
  assert.equal(decision.status, 200);
  const { redirectTo } = await decision.json() as { redirectTo: string };
  const code = new URL(redirectTo).searchParams.get('code')!;
  const exchanged = await fetch(origin + '/oauth/mcp/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id, redirect_uri: authorization.redirect_uri, code, code_verifier: verifier, resource: `${origin}/mcp` }) });
  assert.equal(exchanged.status, 200);
  return (await exchanged.json() as { access_token: string }).access_token;
}

test('CLI grants list/revoke uses PM-only identity and real OAuth token loses subsequent access', async () => {
  const selection = chatOnlyExecutionSelection();
  const execution = await resolveAgentExecution(selection, 'cli-app-thread');
  ensureThread('cli-app-thread', undefined, selection, execution.environment);
  const token = await oauthGrant(['cli-app-thread']);
  const identity = await authenticateMcpRequest(new Request(`${origin}/mcp`, { headers: { Authorization: `Bearer ${token}` } }));
  const live = await retainedApp(identity);
  const target = ['--thread', 'cli-app-thread', '--item', 'cli-app-item'];
  const call = await argumentsFile('granted-app-call.json', { name: 'refresh', arguments: {} });
  await command('apps', 'call', ...target, '--file', call);
  assert.equal(live.calls(), 1);
  await agentLogout();
  const listed = await command<{ items: { id: string; revokedAt: string | null }[] }>('grants', 'list');
  assert.equal(listed.items[0]!.id, identity.grantId);
  assert.equal(JSON.stringify(listed).includes('csrfToken'), false);
  assert.equal(JSON.stringify(listed).includes(sessionToken), false);
  await command('grants', 'revoke', '--id', identity.grantId, '--confirm', 'true');
  assert.ok(readRecord<Grant>(MCP_GRANTS, identity.grantId)!.revokedAt);
  await assert.rejects(authenticateMcpRequest(new Request(`${origin}/mcp`, { headers: { Authorization: `Bearer ${token}` } })));
  assert.equal((await command<{ items: { revokedAt: string | null }[] }>('grants', 'list')).items[0]!.revokedAt !== null, true);
  await agentLogin({ token: process.env.AGENT_WORKSPACE_ACCESS_TOKEN! });
  assert.ok(getNativeOutput('cli-app-generation')!.items.some(item => item.id === 'cli-app-item' && item.mcpApp));
  await assert.rejects(command('apps', 'call', ...target, '--file', call), { status: 409, code: 'mcp_app_session_stopped' });
  assert.equal(live.calls(), 1, 'Revoking a grant never restarts its native App or repeats a tool call.');
  authenticated = false;
  await assert.rejects(command('grants', 'list'), { status: 401 });
  assert.deepEqual(listRecords('chat:generations'), []);
});
