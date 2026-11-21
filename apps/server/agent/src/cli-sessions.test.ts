import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import { accessGuard, accessRoutes } from './access.ts';
import { agentWorkspaceRoutes } from './agent-workspace-routes.ts';
import { chatRoutes } from './chat.ts';
import { openPmToolBridge, pmToolRoutes } from './pm-tools.ts';
import { codexAdapter } from './providers/drivers/codex.ts';
import { createProviderInstance, recordProviderObservations } from './providers/instances.ts';
import { startPmProviderApplication, stopPmProviderApplication } from './providers/t3code/application.ts';
import { providerApplicationOptions } from './providers/t3code/production.ts';
import { getActiveChat, getChatGeneration, listChatGenerations, stopChatRuntime, subscribeChat } from './durable/chat-runtime.ts';
import { getThread, getThreadBranch, getThreadHistory } from './durable/threads.ts';
import { closeStore, listRecords, writeRecord } from './durable/store.ts';
import { initializeNativeOutput } from './durable/native-output.ts';
import { registerLiveSteering } from './providers/t3code/live-actions.ts';
import { grantIdentity, putGrant, type Grant } from './mcp/grants.ts';
import { invokeMcpTool } from './mcp/tools.ts';
import { chatOnlyExecutionSelection } from '../../../../packages/agent-contracts/src/chat.ts';
import { agentWorkspaceSchema, executionSelectionSchema } from '../../../../packages/agent-contracts/src/execution.ts';
import type { NativeInteractionRequest, NativeInteractionResponse } from '../../../../packages/agent-contracts/src/output.ts';
import { pmToolCallRecordSchema, pmToolRequestSchema, type PmToolCallRecord } from '../../../../packages/agent-contracts/src/pm-tools.ts';
import { pmReferenceResolveRequestSchema, pmReferenceResolveResponseSchema, turnContextSchema } from '../../../../packages/agent-contracts/src/pm-references.ts';
import { agentLogin, agentLogout } from '../../../../packages/pm-cli/agent-connection.ts';
import { agentSessionsFamily } from '../../../../packages/pm-cli/agent-sessions.ts';
import type { CliRuntime, PmRequestOptions } from '../../../../packages/pm-cli/runtime.ts';
import { pmToolRequestHash } from '../../../../packages/infrastructure/src/pm-tool-service-auth.ts';
import { createPmApprovalAuthorityFixture, type PmApprovalAuthorityFixture } from './test-fixtures/pm-approval-authority.ts';

// Actual guarded Agent HTTP routes, SQLite, queue, worker admission and interaction broker.
// The Provider and remote PM boundary are controlled protocols, not paid inference or a PM database regression.
const environmentKeys = ['AGENT_WORKSPACE_DATA_DIR', 'AGENT_WORKSPACE_ALLOWED_ROOTS', 'AGENT_WORKSPACE_ACCESS_TOKEN', 'AGENT_APPROVAL_MODE', 'PM_AGENT_URL', 'PM_AGENT_SESSION_DIR', 'PM_API_URL', 'MCP_PUBLIC_ORIGIN', 'PM_AUTOMATION_SERVICE_SECRET'] as const;
const savedEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
const originalCheck = codexAdapter.check, originalRun = codexAdapter.run;
let root: string, origin: string, pmOrigin: string, server: Server, pmServer: Server;
let requests: { method: string; route: string; headers: Headers }[], runs: { prompt: string; cwd: string; model: string }[];
let gate: Promise<void> | undefined, question: NativeInteractionRequest | undefined;
let started = Promise.withResolvers<void>(), questionReady = Promise.withResolvers<void>();
let receivedAnswer: NativeInteractionResponse | undefined;
let payloadAllowed: boolean, loseNextWrite: boolean, loseNextChatReply: boolean;
let currentActorId: string;
let pmWrites: { operationId: string; name: string; arguments: unknown }[];
let pmReceipts: Map<string, { requestHash: string; record: PmToolCallRecord }>;
let pmResultReads: string[];
let pmResultGate: PromiseWithResolvers<void> | undefined, pmResultReached: PromiseWithResolvers<void>;
let pmResultExpected: number;
let beforeCancel: (() => Promise<void>) | undefined;
let pmApprovalAuthority: PmApprovalAuthorityFixture | undefined;
const workspaceId = randomUUID(), actorId = randomUUID();
const nativePmBearer = 'p'.repeat(43), operatorToken = 'isolated-agent-cli-operator-' + 'a'.repeat(40);
const target = { workspaceId, projectId: 'PRJ-001' };
const revision = 'a'.repeat(64);
const folderResponseSchema = z.object({ workspace: agentWorkspaceSchema });
const sidebarResponseSchema = z.object({ thread: z.object({ sidebar: z.object({ revision: z.number() }) }) });
const queueResponseSchema = z.object({ messages: z.array(z.object({ id: z.string(), revision: z.number(), generationId: z.string().optional() })) });
function printed<T>(schema: z.ZodType<T>, output: unknown[]): T { return schema.parse(output[0]); }

async function closeServer(value: Server) {
  const closed = once(value, 'close'); value.closeAllConnections(); value.close(); await closed;
}
async function listen(value: Server) {
  value.listen(0, '127.0.0.1'); await once(value, 'listening');
  const address = value.address(); assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(await realpath(tmpdir()), 'pm-cli-sessions-'));
  process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, 'agent-data');
  process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = JSON.stringify([root]);
  process.env.AGENT_WORKSPACE_ACCESS_TOKEN = operatorToken;
  process.env.AGENT_APPROVAL_MODE = 'ask';
  process.env.PM_AGENT_SESSION_DIR = path.join(root, 'operator-session');
  process.env.MCP_PUBLIC_ORIGIN = 'https://cli-fixture.invalid';
  process.env.PM_AUTOMATION_SERVICE_SECRET = 'isolated-cli-service-secret-32-bytes';
  requests = []; runs = []; gate = undefined; question = undefined;
  receivedAnswer = undefined; started = Promise.withResolvers<void>(); questionReady = Promise.withResolvers<void>();
  payloadAllowed = true; loseNextWrite = false; loseNextChatReply = false; pmWrites = []; currentActorId = actorId;
  pmReceipts = new Map(); pmResultReads = []; beforeCancel = undefined;
  pmResultGate = undefined; pmResultReached = Promise.withResolvers<void>();
  pmResultExpected = 1;
  pmApprovalAuthority = undefined;
  const fileArea = { path: null, status: 'unconfigured', revision: 0, source: null, canManage: false };
  pmServer = createServer(async (incoming, outgoing) => {
    outgoing.setHeader('content-type', 'application/json');
    const route = incoming.url ?? '/';
    if (route === '/api/v1/auth/me') { outgoing.end(JSON.stringify({ actor: { id: currentActorId } })); return; }
    if (route === '/api/v1/agent-contexts') { outgoing.end(JSON.stringify({ workspaces: [{ id: workspaceId, name: 'Isolated PM', fileArea, projects: [{ id: target.projectId, name: 'Explicit project', fileArea }] }] })); return; }
    if (incoming.method === 'GET') { outgoing.end(JSON.stringify({ tools: [] })); return; }
    let text = ''; for await (const chunk of incoming) text += String(chunk);
    const body = z.record(z.string(), z.unknown()).parse(JSON.parse(text || '{}'));
    if (route === '/api/v1/agent-contexts/authorize') {
      if (!payloadAllowed || incoming.headers.authorization !== `Bearer ${nativePmBearer}` && !incoming.headers.authorization?.startsWith('Bearer pm-mcp-service-v1.')) { outgoing.writeHead(403).end(JSON.stringify({ error: 'Current authority denied' })); return; }
      outgoing.end(JSON.stringify({ actorId: currentActorId, scope: body })); return;
    }
    if (route.endsWith('/agent-references/resolve')) {
      const { references } = pmReferenceResolveRequestSchema.parse(body);
      outgoing.end(JSON.stringify({ items: references.map(reference => ({ ...reference, title: 'Private referenced task', revision, availability: payloadAllowed ? 'available' : 'forbidden', reason: null })) })); return;
    }
    if (route === '/api/v1/internal/agent-tools/reconcile') { outgoing.end(JSON.stringify({ ...body, status: 'unknown', evidence: 'unresolved', commandIds: [] })); return; }
    if (route.endsWith('/agent-tools/approval-authority')) {
      if (!pmApprovalAuthority || !payloadAllowed || incoming.headers.authorization !== `Bearer ${nativePmBearer}`) {
        outgoing.writeHead(403).end(JSON.stringify({ error: 'Current native approval authority denied' })); return;
      }
      const authority = await pmApprovalAuthority.read(body);
      outgoing.writeHead(authority.statusCode).end(authority.body); return;
    }
    if (route.endsWith('/call') || route.endsWith('/result')) {
      const request = pmToolRequestSchema.parse(body);
      if (!payloadAllowed || request.target.workspaceId !== target.workspaceId || request.target.projectId !== target.projectId ||
          incoming.headers.authorization !== `Bearer ${nativePmBearer}`) {
        outgoing.writeHead(403).end(JSON.stringify({ error: 'Current authority denied' })); return;
      }
      const requestHash = pmToolRequestHash(request, currentActorId);
      const original = pmReceipts.get(request.operationId);
      if (original && original.requestHash !== requestHash) {
        outgoing.writeHead(409).end(JSON.stringify({ error: 'Original operation identity mismatch' })); return;
      }
      if (route.endsWith('/result')) {
        pmResultReads.push(request.operationId);
        if (pmResultReads.length >= pmResultExpected) pmResultReached.resolve();
        await pmResultGate?.promise;
        if (!original) { outgoing.writeHead(503).end(JSON.stringify({ error: 'Original result is unavailable' })); return; }
        outgoing.end(JSON.stringify(original.record)); return;
      }
      pmWrites.push({ operationId: request.operationId, name: request.name, arguments: request.arguments });
      if (loseNextWrite) { loseNextWrite = false; incoming.socket.destroy(); return; }
      const record = original?.record ?? pmToolCallRecordSchema.parse({
        operationId: request.operationId, name: request.name, target: request.target, actorId: currentActorId,
        linkage: request.linkage, status: 'succeeded',
        result: { kind: 'task', items: [], nextCursor: null, truncated: false, sources: [] }, error: null,
        threadId: request.threadId, messageId: request.messageId, generationId: request.generationId,
        workspaceId: request.target.workspaceId, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      });
      pmReceipts.set(request.operationId, { requestHash, record });
      outgoing.end(JSON.stringify(record)); return;
    }
    outgoing.writeHead(404).end(JSON.stringify({ error: 'Unknown fixture operation' }));
  });
  pmOrigin = await listen(pmServer); process.env.PM_API_URL = pmOrigin;
  const app = new Hono().route('/api', accessRoutes).use('/api/*', accessGuard)
    .route('/api', agentWorkspaceRoutes).route('/api', chatRoutes).route('/api', pmToolRoutes);
  server = createServer(async (incoming, outgoing) => {
    const abort = new AbortController();
    outgoing.once('close', () => abort.abort());
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      requests.push({ method: incoming.method ?? 'GET', route: incoming.url ?? '/', headers });
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      if (incoming.method === 'POST' && incoming.url?.endsWith('/cancel') && beforeCancel) {
        const intercept = beforeCancel; beforeCancel = undefined; await intercept();
      }
      const response = await app.fetch(new Request(`http://${incoming.headers.host}${incoming.url}`, { method: incoming.method ?? 'GET', headers, signal: abort.signal, ...(body === undefined ? {} : { body }) }));
      if (loseNextChatReply && incoming.method === 'POST' && incoming.url === '/api/chat') {
        loseNextChatReply = false; outgoing.destroy(); await response.body?.cancel(); return;
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.flushHeaders();
      if (response.body) for await (const chunk of response.body) {
        if (abort.signal.aborted) break;
        if (!outgoing.write(chunk)) await once(outgoing, 'drain', { signal: abort.signal });
      }
      outgoing.end();
    } catch { if (!outgoing.destroyed) outgoing.destroy(); }
  });
  origin = await listen(server); process.env.PM_AGENT_URL = origin;
  await agentLogin({ token: operatorToken });
  await startPmProviderApplication(providerApplicationOptions);
  const instance = createProviderInstance({ instanceId: 'cli-controlled', driver: 'codex', label: 'Controlled CLI service fixture', enabled: true,
    config: { binaryPath: path.join(root, 'not-a-real-provider'), homePath: path.join(root, 'provider-home') }, environment: [] });
  recordProviderObservations(instance.instanceId, instance.revision, { discoveredModels: [{ id: 'controlled-model', label: 'No paid inference', temperature: false }] });
  codexAdapter.check = async () => ({ installation: { status: 'installed', checkedAt: new Date().toISOString() }, authentication: 'authenticated', nativeSessionReady: true,
    models: [{ id: 'controlled-model', label: 'No paid inference', source: 'discovered', temperature: false }], methods: [], canLogout: false,
    capabilities: { nativeResume: true, nativeFork: false, boundedFork: false, modelTransition: 'native', portableHandoff: true } });
  codexAdapter.run = async (context, options) => {
    runs.push({ prompt: options.prompt, cwd: context.cwd, model: options.model });
    const aborted = Promise.withResolvers<never>();
    const abort = () => aborted.reject(Object.assign(new Error('Controlled cancellation'), { code: 'aborted' }));
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      if (options.signal?.aborted) throw Object.assign(new Error('Controlled cancellation'), { code: 'aborted' });
      started.resolve();
      options.onEvent?.({ type: 'item.upsert', item: { id: 'command', type: 'command_execution', status: 'running', title: 'Controlled command' } });
      options.onEvent?.({ type: 'command.output', itemId: 'command', chunk: 'actual command projection\n' });
      options.onText?.('Authoritative partial reply\n\n');
      if (question) {
        const answer = options.onRequest!(question); questionReady.resolve();
        receivedAnswer = await Promise.race([answer, aborted.promise]);
      }
      await Promise.race([gate ?? Promise.resolve(), aborted.promise]);
      options.onEvent?.({ type: 'item.upsert', item: { id: 'command', type: 'command_execution', status: 'completed', exitCode: 0 } });
      options.onText?.('Completed authoritative reply');
      return { text: 'Authoritative partial reply\n\nCompleted authoritative reply' };
    } finally { options.signal?.removeEventListener('abort', abort); }
  };
});
afterEach(async () => {
  pmResultGate?.resolve();
  await stopChatRuntime(); await stopPmProviderApplication();
  codexAdapter.check = originalCheck; codexAdapter.run = originalRun;
  await agentLogout().catch(() => undefined);
  await closeServer(server); await closeServer(pmServer); closeStore();
  await pmApprovalAuthority?.close();
  for (const key of environmentKeys) { const value = savedEnvironment[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(root, { recursive: true, force: true });
});

function runtime(output: unknown[], pm = false): CliRuntime {
  const authentication = async () => { assert.equal(pm, true, 'Pure Agent calls must not read PM credentials'); return { origin: pmOrigin, headers: { Authorization: `Bearer ${nativePmBearer}` } }; };
  return { authentication,
    async connection() { return { ...await authentication(), workspaceId }; },
    async response(_scope, endpoint, options = {}) { return fetch(`${pmOrigin}/api/v1/workspaces/${workspaceId}${endpoint}`, { method: options.method ?? 'GET', headers: { Authorization: `Bearer ${nativePmBearer}`, 'Content-Type': 'application/json' }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }); },
    async json<T>(scope: 'service' | 'workspace' | 'core', endpoint: string, options: PmRequestOptions = {}) { return await (await this.response(scope, endpoint, options)).json() as T; },
    print(value) { output.push(value); },
  };
}
async function run(args: string[], pm = false) {
  const output: unknown[] = [];
  assert.equal(await agentSessionsFamily.dispatch(['agent', ...args], runtime(output, pm)), true);
  return output;
}
async function jsonFile(body: unknown) {
  const filename = path.join(root, `${randomUUID()}.json`); await writeFile(filename, JSON.stringify(body)); return filename;
}
async function createSession(sessionId = randomUUID(), executionSelection = chatOnlyExecutionSelection()) {
  const file = await jsonFile({ id: sessionId, executionSelection });
  await run(['session', 'create', '--file', file]);
  const current = getThread(sessionId)!;
  await run(['session', 'update', sessionId, '--file', await jsonFile({ revision: current.revision, settings: { ...current.settings, providerInstanceId: 'cli-controlled', model: 'controlled-model' } })]);
  return sessionId;
}
async function send(sessionId: string, text: string, extra: Record<string, unknown> = {}, detached = false) {
  const inputId = randomUUID();
  const body = { id: sessionId, messages: [...getThreadBranch(sessionId).map(value => ({ id: value.id, ...value.content })), { id: inputId, role: 'user', parts: [{ type: 'text', text }] }], config: { threadSettingsRevision: getThread(sessionId)!.revision }, idempotencyKey: inputId, ...extra };
  const output = await run(['message', 'send', sessionId, '--file', await jsonFile(body), ...(detached ? ['--follow', 'false'] : []), ...(extra.pmReferences ? ['--pm-context', 'true'] : [])], !!extra.pmReferences);
  const open = z.object({ generationId: z.string() }).parse(output.find(value => value !== null && typeof value === 'object' && 'kind' in value && value.kind === 'stream-open'));
  return { output, inputId, generationId: open.generationId, body };
}
async function finish(generationId: string) { for await (const _event of subscribeChat(generationId)) { /* Drain real worker output. */ } }

test('unowned prefixes are pure and closed commands reject smuggled identities before HTTP', async () => {
  const before = requests.length, output: unknown[] = [];
  assert.equal(await agentSessionsFamily.dispatch(['agent', 'provider', 'list'], runtime(output)), false);
  assert.equal(await agentSessionsFamily.dispatch(['agent', 'login'], runtime(output)), false);
  await assert.rejects(run(['session', 'create', '--file', await jsonFile({ id: 'forged', executionSelection: chatOnlyExecutionSelection(), actorId })]));
  await assert.rejects(run(['message', 'context', '../other', 'message']));
  await assert.rejects(run(['folder', 'list', '--endpoint', '/api/chat']));
  await assert.rejects(run(['generation', 'lifecycle', 'original-session']));
  await assert.rejects(run(['generation', 'lifecycle', 'original-session', '--generation', '../replacement']));
  await assert.rejects(run(['generation', 'lifecycle', 'original-session', '--generation', 'original-generation', '--endpoint', '/api/chat']));
  assert.equal(requests.length, before);
});

test('T31 folders retain directory identity through close/reopen and reject replacements; Session CRUD uses native services', async () => {
  const directory = path.join(root, 'code'); await mkdir(directory);
  const opened = printed(folderResponseSchema, await run(['folder', 'register', '--path', directory, '--name', 'Code']));
  let folder = opened.workspace;
  const sessionId = await createSession(randomUUID(), { version: 2, agentWorkspaceId: folder.id, agentWorkspaceRevision: folder.revision });
  folder = printed(folderResponseSchema, await run(['folder', 'rename', folder.id, '--revision', String(folder.revision), '--name', 'Renamed'])).workspace;
  folder = printed(folderResponseSchema, await run(['folder', 'close', folder.id, '--revision', String(folder.revision)])).workspace;
  const reopened = printed(folderResponseSchema, await run(['folder', 'reopen', folder.id, '--revision', String(folder.revision)]));
  assert.equal(reopened.workspace.id, opened.workspace.id); assert.equal(getThread(sessionId)!.executionSelection!.agentWorkspaceId, folder.id);
  await run(['session', 'rename', sessionId, '--revision', String(getThread(sessionId)!.revision), '--title', 'Saved title']);
  await run(['session', 'archive', sessionId, '--lifecycle-revision', String(getThread(sessionId)!.lifecycleRevision ?? 0)]);
  assert.equal(getThread(sessionId)!.status, 'archived');
  await run(['session', 'restore', sessionId, '--lifecycle-revision', String(getThread(sessionId)!.lifecycleRevision ?? 0)]);
  assert.equal(getThread(sessionId)!.title, 'Saved title');
  const saved = getThread(sessionId)!.executionSelection;
  await rename(directory, `${directory}-original`); await mkdir(directory);
  await assert.rejects(run(['folder', 'reopen', folder.id, '--revision', String(reopened.workspace.revision)]), { status: 412 });
  await assert.rejects(run(['session', 'execution', sessionId]), { status: 412 });
  assert.deepEqual(getThread(sessionId)!.executionSelection, saved);
  const deletion = ['session', 'delete', sessionId, '--operation', 'original-delete', '--lifecycle-revision', String(getThread(sessionId)!.lifecycleRevision ?? 0), '--confirm', 'true', '--generation', 'none', '--stop-active', 'false'];
  await run(deletion); assert.equal(getThread(sessionId), null);
  await run(deletion);
  const receipt = printed(z.object({ operation: z.object({ state: z.literal('committed'), operationId: z.literal('original-delete') }) }), await run(['session', 'lifecycle-result', sessionId, 'original-delete']));
  assert.equal(receipt.operation.state, 'committed');
});

test('T31 existing external delegation lists only granted history and can launch only pure Chat', async () => {
  const granted = await createSession(), unrelated = await createSession();
  const grant: Grant = { grantId: randomUUID(), actorId, scope: target, access: 'full', threadIds: [granted], version: 1, clientHash: 'isolated-cli', clientName: 'Controlled client', audience: 'https://cli-fixture.invalid/mcp', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null };
  putGrant(grant); const identity = grantIdentity(grant);
  const listed = z.object({ threads: z.array(z.object({ remoteId: z.string() })) }).parse(await invokeMcpTool(identity, 't3_thread_list', {}));
  assert.deepEqual(listed.threads.map(value => value.remoteId), [granted]);
  await assert.rejects(invokeMcpTool(identity, 't3_thread_read', { threadId: unrelated }), /not explicitly granted/);
  await assert.rejects(invokeMcpTool(identity, 't3_thread_launch', { clientRequestId: 'code-denied', title: 'No directory authority', executionSelection: { version: 2, agentWorkspaceId: 'not-granted', agentWorkspaceRevision: 1 } }), /no Agent directory access/);
  const created = z.object({ thread: z.object({ executionSelection: executionSelectionSchema }) }).parse(await invokeMcpTool(identity, 't3_thread_launch', { clientRequestId: 'chat-only', title: 'Pure Chat' }));
  assert.deepEqual(created.thread.executionSelection, chatOnlyExecutionSelection());
  assert.equal(runs.length, 0);
});

test('T32 server freezes input context and directory; history, fork, rewind and reattachment never run saved writes', async () => {
  const sessionId = await createSession();
  const first = await send(sessionId, 'First accepted input');
  const context = printed(z.object({ turnContext: turnContextSchema }), await run(['message', 'context', sessionId, first.inputId]));
  assert.equal(context.turnContext.threadId, sessionId); assert.equal(context.turnContext.messageId, first.inputId);
  await assert.rejects(run(['session', 'update', sessionId, '--file', await jsonFile({ revision: getThread(sessionId)!.revision, executionSelection: chatOnlyExecutionSelection() })]), { status: 409 });
  const second = await send(sessionId, 'Second accepted input');
  const before = runs.length, writes = pmWrites.length;
  const forked = printed(z.object({ threadId: z.string() }), await run(['message', 'fork', first.generationId, '--file', await jsonFile({ idempotencyKey: 'fork-once' })]));
  assert.notEqual(forked.threadId, sessionId); assert.equal(listChatGenerations(forked.threadId).length, 0);
  await run(['generation', 'stream', first.generationId]);
  const history = printed(z.object({ page: z.object({ beforeCursor: z.string() }), messages: z.array(z.unknown()) }), await run(['session', 'history', sessionId, '--limit', '1']));
  assert.equal(history.messages.length, 1);
  await run(['message', 'list', sessionId, '--limit', '1', '--before', history.page.beforeCursor]);
  const rewind = { messageId: getChatGeneration(first.generationId)!.messageId, expectedHeadId: getThreadHistory(sessionId).headId, revision: getThread(sessionId)!.revision, confirmed: true, idempotencyKey: 'rewind-once' };
  await run(['message', 'rewind', sessionId, '--file', await jsonFile(rewind)]);
  assert.equal(getThreadHistory(sessionId).headId, rewind.messageId); assert.equal(runs.length, before); assert.equal(pmWrites.length, writes);
  assert.ok(getChatGeneration(second.generationId));
  await assert.rejects(run(['message', 'native-fork', first.generationId, '--file', await jsonFile({ idempotencyKey: 'unsupported' })]), { status: 409 });
});

test('T32 queue/stash admission is durable and CAS-scoped; sidebar revisions do not alter execution', async () => {
  const sessionId = await createSession();
  const original = getThread(sessionId)!.executionSelection;
  const draft = (name: string) => ({ id: name, threadSettingsRevision: getThread(sessionId)!.revision, draft: { message: { id: `${name}-input`, role: 'user', parts: [{ type: 'text', text: name }] } } });
  await run(['message', 'enqueue', sessionId, '--file', await jsonFile(draft('queued'))]);
  await run(['message', 'stash-save', sessionId, '--file', await jsonFile(draft('saved'))]);
  closeStore();
  assert.equal(printed(queueResponseSchema, await run(['message', 'queue', sessionId])).messages[0]!.id, 'queued');
  assert.equal(printed(z.object({ drafts: z.array(z.object({ id: z.string() })) }), await run(['message', 'stash', sessionId])).drafts[0]!.id, 'saved');
  const pin = printed(sidebarResponseSchema, await run(['session', 'pin', sessionId, '--revision', '0'])).thread;
  await assert.rejects(run(['session', 'settle', sessionId, '--revision', '0']), { status: 409 });
  const unpinned = printed(sidebarResponseSchema, await run(['session', 'unpin', sessionId, '--revision', String(pin.sidebar.revision)])).thread;
  const snoozed = printed(sidebarResponseSchema, await run(['session', 'snooze', sessionId, '--revision', String(unpinned.sidebar.revision), '--until', new Date(Date.now() + 3_600_000).toISOString()])).thread;
  await run(['session', 'wake', sessionId, '--revision', String(snoozed.sidebar.revision)]);
  await run(['message', 'queue-send', sessionId, 'queued', '--file', await jsonFile({ action: 'send', revision: 0 })]);
  const queued = printed(queueResponseSchema, await run(['message', 'queue', sessionId])).messages[0]!;
  assert.ok(queued.generationId); await finish(queued.generationId); assert.equal(runs.length, 1);
  await run(['message', 'queue-reconcile', sessionId, 'queued', '--file', await jsonFile({ action: 'reconcile', revision: queued.revision })]);
  assert.equal(runs.length, 1); assert.deepEqual(getThread(sessionId)!.executionSelection, original);
  await run(['message', 'stash-delete', sessionId, 'saved']);
  assert.deepEqual((await run(['message', 'saved', sessionId, 'stash', 'saved']))[0], { saved: true });
});

test('T32 explicit PM context preserves distinct identities and current revocation projection', async () => {
  const sessionId = await createSession();
  const refs = [{ ...target, kind: 'issue', id: 'TASK-001', revision }];
  const resolved = printed(pmReferenceResolveResponseSchema, await run(['message', 'resolve-references', '--file', await jsonFile({ references: refs })], true));
  assert.equal(resolved.items[0]!.availability, 'available');
  const accepted = await send(sessionId, 'Reference-bound message', { pmReferences: refs });
  const frozen = getChatGeneration(accepted.generationId)!.turnContext!;
  assert.equal(frozen.messageId, accepted.inputId); assert.equal(frozen.pmReferences[0]!.revision, revision);
  const admission = requests.find(value => value.route === '/api/chat' && value.method === 'POST')!;
  assert.equal(admission.headers.get('authorization'), `Bearer ${nativePmBearer}`); assert.match(admission.headers.get('cookie')!, /agent_v4_access=/);
  payloadAllowed = false;
  const projected = await run(['message', 'list', sessionId, '--pm-context', 'true'], true);
  assert.doesNotMatch(JSON.stringify(projected), /Private referenced task/);
  assert.equal(getChatGeneration(accepted.generationId)!.turnContext!.pmReferences[0]!.revision, revision);
  assert.equal(runs.length, 1);
});

test('T33 detach preserves execution, exact stop observes final state and cannot target a replacement', async () => {
  const sessionId = await createSession(), release = Promise.withResolvers<void>(); gate = release.promise;
  const accepted = await send(sessionId, 'Keep running after detach', {}, true); await started.promise;
  assert.equal(getActiveChat(sessionId)!.id, accepted.generationId);
  await run(['generation', 'output', accepted.generationId]);
  await run(['generation', 'command-output', accepted.generationId, 'command']);
  assert.equal(getActiveChat(sessionId)!.id, accepted.generationId);
  const cancellations = requests.filter(value => value.method === 'POST' && value.route.endsWith('/cancel')).length;
  await assert.rejects(run(['generation', 'stop', sessionId, '--generation', randomUUID()]));
  await assert.rejects(run(['generation', 'stop', sessionId, '--generation', accepted.generationId, '--message', 'another-input']));
  assert.equal(requests.filter(value => value.method === 'POST' && value.route.endsWith('/cancel')).length, cancellations);
  assert.equal(getActiveChat(sessionId)?.id, accepted.generationId);
  assert.equal(listRecords('chat:cancellations').length, 0);
  const stopped = printed(z.object({ generation: z.object({ status: z.string() }) }), await run(['generation', 'stop', sessionId, '--generation', accepted.generationId, '--message', accepted.inputId]));
  assert.equal(stopped.generation.status, 'cancelled'); assert.equal(getActiveChat(sessionId), undefined);
  assert.equal(runs.length, 1); release.resolve();
  const nextRelease = Promise.withResolvers<void>(); gate = nextRelease.promise; started = Promise.withResolvers<void>();
  const replacement = await send(sessionId, 'Explicit replacement turn', {}, true); await started.promise;
  const beforeStaleStop = requests.filter(value => value.method === 'POST' && value.route.endsWith('/cancel')).length;
  await assert.rejects(run(['generation', 'stop', sessionId, '--generation', accepted.generationId]));
  assert.equal(requests.filter(value => value.method === 'POST' && value.route.endsWith('/cancel')).length, beforeStaleStop);
  assert.equal(getActiveChat(sessionId)?.id, replacement.generationId);
  await run(['generation', 'stop', sessionId, '--generation', replacement.generationId]);
  nextRelease.resolve();
});

test('lifecycle and exact stop never authorize retained PM content, even with result reads gated indefinitely', { timeout: 15_000 }, async () => {
  const sessionId = await createSession(), unrelated = await createSession();
  const release = Promise.withResolvers<void>(); gate = release.promise;
  const accepted = await send(sessionId, 'Private original prompt', {}, true); await started.promise;
  const active = getChatGeneration(accepted.generationId)!;
  const secret = 'Private retained PM text must never enter a lifecycle DTO';
  for (let index = 0; index < 128; index++) {
    const operationId = randomUUID();
    const request = pmToolRequestSchema.parse({ operationId, name: 'pm_query', target,
      arguments: { entity: null, projectId: null, query: null, after: null, limit: 20 },
      threadId: sessionId, messageId: active.messageId, generationId: active.id });
    const record = pmToolCallRecordSchema.parse({ ...request, actorId, workspaceId, status: 'succeeded',
      result: { kind: 'query', items: [], nextCursor: null, truncated: false, sources: [] }, error: null,
      createdAt: active.createdAt, finishedAt: active.createdAt });
    const requestHash = pmToolRequestHash(request, actorId);
    pmReceipts.set(operationId, { requestHash, record });
    writeRecord('pm-tool-calls', operationId, { request, record, requestHash });
  }
  writeRecord('chat:generations', active.id, { ...active, error: secret, output: { id: active.messageId, role: 'assistant', parts: [{ type: 'text', text: secret }] },
    pmReferences: [{ ...target, kind: 'issue', id: 'TASK-001', revision, title: secret, availability: 'available', reason: null }] });
  pmResultGate = Promise.withResolvers<void>();
  const lifecycleArgs = ['generation', 'lifecycle', sessionId, '--generation', active.id];
  const snapshot = (await run(lifecycleArgs))[0] as { generation: Record<string, unknown> };
  assert.deepEqual(Object.keys(snapshot.generation).sort(), ['createdAt', 'id', 'inputMessageId', 'messageId', 'status', 'threadId']);
  assert.equal(snapshot.generation.id, active.id); assert.equal(snapshot.generation.inputMessageId, accepted.inputId);
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
  assert.deepEqual(pmResultReads, []);
  assert.equal((await fetch(`${origin}/api/chat/threads/${sessionId}/generations/${active.id}/lifecycle`)).status, 401);
  await assert.rejects(run(['generation', 'lifecycle', unrelated, '--generation', active.id]), { status: 404 });
  await assert.rejects(run(['generation', 'lifecycle', sessionId, '--generation', randomUUID()]), { status: 404 });
  await assert.rejects(run(['generation', 'lifecycle', sessionId]));
  await assert.rejects(run(['generation', 'stop', unrelated, '--generation', active.id]), { status: 404 });
  await assert.rejects(run(['generation', 'stop', sessionId, '--generation', active.id, '--message', 'wrong-input']), { status: 409 });
  assert.equal(listRecords('chat:cancellations').length, 0);
  assert.equal(getActiveChat(sessionId)?.id, active.id);
  const beforeStop = requests.length;
  const stopped = printed(z.object({ generation: z.object({ id: z.string(), status: z.literal('cancelled') }) }),
    await run(['generation', 'stop', sessionId, '--generation', active.id, '--message', accepted.inputId]));
  assert.equal(stopped.generation.id, active.id);
  assert.equal(requests.slice(beforeStop).some(request => request.route.endsWith('/generations')), false);
  assert.deepEqual(pmResultReads, [], 'Neither lifecycle nor stop may read even one retained content result');
  assert.equal(getActiveChat(sessionId), undefined);
  release.resolve();
  pmResultExpected = 128;
  // The explicit content contract must still reauthorize; it really blocks on this unresolved PM gate.
  let contentSettled = false;
  const content = run(['generation', 'status', sessionId, '--generation', active.id, '--pm-context', 'true'], true).finally(() => { contentSettled = true; });
  try {
    await pmResultReached.promise;
    assert.equal(contentSettled, false);
    const reads = pmResultReads.length;
    assert.ok(reads > 0);
    assert.equal(printed(z.object({ generation: z.object({ status: z.literal('cancelled') }) }), await run(lifecycleArgs)).generation.status, 'cancelled');
    assert.equal(pmResultReads.length, reads);
    assert.equal(contentSettled, false);
  } finally { pmResultGate.resolve(); await content; }
});

test('T33 stale native questions and duplicate approvals are denied by the original broker', async () => {
  const sessionId = await createSession();
  question = { id: 'question-original', itemId: 'question-item', kind: 'user_input', title: 'Actual native question', respondable: true, questions: [{ id: 'answer', prompt: 'Choose', options: [{ id: 'yes', label: 'Yes' }], allowText: false }] };
  const accepted = await send(sessionId, 'Wait for answer', {}, true); await questionReady.promise;
  await assert.rejects(run(['generation', 'respond', accepted.generationId, 'stale-question', '--file', await jsonFile({ answers: { answer: 'yes' } })]), { status: 409 });
  await run(['generation', 'respond', accepted.generationId, question.id, '--file', await jsonFile({ answers: { answer: 'yes' } })]);
  await finish(accepted.generationId); assert.deepEqual(receivedAnswer, { answers: { answer: 'yes' } });
  await assert.rejects(run(['approval', 'respond', accepted.generationId, question.id, '--file', await jsonFile({ answers: { answer: 'yes' } })]), { status: 409 });
  assert.equal(runs.length, 1);
});

test('T33 steering unknown is never replayed, including a duplicate explicit operation identity', async () => {
  const sessionId = await createSession(), release = Promise.withResolvers<void>(); gate = release.promise;
  const accepted = await send(sessionId, 'Start controlled turn', {}, true); await started.promise;
  let calls = 0;
  const unregister = registerLiveSteering({ threadId: sessionId, generationId: accepted.generationId, interruptsTools: false, async steer() { calls++; throw new Error('Controlled lost reply'); } });
  try {
    const request = await jsonFile({ generationId: accepted.generationId, idempotencyKey: 'steer-original', text: 'A distinct live steer, not a new message' });
    assert.deepEqual((await run(['generation', 'steer', sessionId, '--file', request]))[0], { status: 'unknown' });
    assert.deepEqual((await run(['generation', 'steer', sessionId, '--file', request]))[0], { status: 'unknown' });
    assert.equal(calls, 1); assert.equal(runs.length, 1);
  } finally { unregister(); release.resolve(); await finish(accepted.generationId); }
});

test('T33 original PM approval races dispatch once; native role cannot self-approve and unknown stays unresolved', async () => {
  const sessionId = await createSession(), generationId = randomUUID();
  pmApprovalAuthority = await createPmApprovalAuthorityFixture({ directory: root, workspaceId, actorId, enabled: () => payloadAllowed });
  assert.deepEqual(pmApprovalAuthority.target, target);
  const originalTask = pmApprovalAuthority.task;
  initializeNativeOutput(generationId, sessionId, 'running');
  const bridge = await openPmToolBridge({ threadId: sessionId, messageId: 'original-message', generationId, headers: new Headers({ authorization: `Bearer ${nativePmBearer}` }), authorizeExecution: async () => {} });
  const propose = async (operationId: string) => {
    const response = await fetch(`${bridge.url}/tools/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId, name: 'pm_archive_task', target, arguments: { ...originalTask } }) });
    assert.equal(response.status, 200); assert.equal(pmToolCallRecordSchema.parse(await response.json()).status, 'pending_approval');
  };
  try {
    const operationId = randomUUID(); await propose(operationId);
    assert.equal((await fetch(`${bridge.url}/tools/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId }) })).status, 404);
    assert.equal(pmWrites.length, 0);
    currentActorId = randomUUID();
    await assert.rejects(run(['approval', 'approve', operationId, '--pm-context', 'true'], true), { status: 403 });
    assert.equal(pmWrites.length, 0); currentActorId = actorId;
    const results = await Promise.allSettled([run(['approval', 'approve', operationId, '--pm-context', 'true'], true), run(['approval', 'approve', operationId, '--pm-context', 'true'], true)]);
    const approved = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
    assert.equal(approved.length, 1);
    const originalResult = printed(pmToolCallRecordSchema, approved);
    assert.equal(originalResult.operationId, operationId); assert.equal(originalResult.status, 'succeeded');
    assert.equal(pmWrites.length, 1); assert.equal(pmWrites[0]!.operationId, operationId);
    assert.ok(pmResultReads.includes(operationId), 'Successful approval delivery reauthorizes the original PM receipt');
    payloadAllowed = false;
    const withheld = printed(z.object({ operationId: z.string(), visibility: z.literal('redacted') }), await run(['approval', 'read', operationId, '--pm-context', 'true'], true));
    assert.equal(withheld.operationId, operationId); assert.equal(pmWrites.length, 1);
    payloadAllowed = true;
    const rejected = randomUUID(); await propose(rejected);
    await run(['approval', 'reject', rejected, '--pm-context', 'true'], true); assert.equal(pmWrites.length, 1);
    await assert.rejects(run(['approval', 'approve', rejected, '--pm-context', 'true'], true), { status: 409 });
    const unknown = randomUUID(); await propose(unknown); loseNextWrite = true;
    assert.equal(printed(pmToolCallRecordSchema, await run(['approval', 'approve', unknown, '--pm-context', 'true'], true)).status, 'unknown');
    const writes = pmWrites.length;
    assert.equal(printed(pmToolCallRecordSchema, await run(['approval', 'reconcile', unknown, '--pm-context', 'true'], true)).status, 'unknown');
    assert.equal(pmWrites.length, writes); assert.equal(listRecords('pm-tool-calls').length, 3);
  } finally { await bridge.close(); }
});

test('T33 continuation requires explicit side-effect confirmation and reuses original continuation identity', async () => {
  const sessionId = await createSession(), release = Promise.withResolvers<void>(); gate = release.promise;
  const accepted = await send(sessionId, 'Original turn before explicit stop', {}, true); await started.promise;
  await run(['generation', 'stop', sessionId, '--generation', accepted.generationId]);
  release.resolve(); gate = undefined;
  await assert.rejects(run(['generation', 'continue', accepted.generationId, '--confirm-side-effects', 'false']), { status: 409 });
  assert.equal(runs.length, 1);
  const continuation = printed(z.object({ generation: z.object({ id: z.string(), continuationOf: z.string() }) }), await run(['generation', 'continue', accepted.generationId, '--confirm-side-effects', 'true']));
  await finish(continuation.generation.id);
  assert.equal(continuation.generation.continuationOf, accepted.generationId);
  const repeated = printed(z.object({ generation: z.object({ id: z.string() }) }), await run(['generation', 'continue', accepted.generationId, '--confirm-side-effects', 'true']));
  assert.equal(repeated.generation.id, continuation.generation.id); assert.equal(runs.length, 2);
});

test('T33 native approval accepts only original offered choices and closes after one operator answer', async () => {
  const sessionId = await createSession();
  question = { id: 'native-approval', itemId: 'approval-item', kind: 'approval', title: 'Controlled native permission', respondable: true, options: [{ id: 'deny-original', label: 'Deny' }] };
  const accepted = await send(sessionId, 'Await original native permission', {}, true); await questionReady.promise;
  await assert.rejects(run(['approval', 'respond', accepted.generationId, question.id, '--file', await jsonFile({ optionId: 'invented-allow' })]), { status: 400 });
  await run(['approval', 'respond', accepted.generationId, question.id, '--file', await jsonFile({ optionId: 'deny-original' })]);
  await finish(accepted.generationId); assert.deepEqual(receivedAnswer, { optionId: 'deny-original' });
  await assert.rejects(run(['approval', 'respond', accepted.generationId, question.id, '--file', await jsonFile({ optionId: 'deny-original' })]), { status: 409 });
});

test('T33 bounded live output detaches on timeout without cancelling or reconnecting the generation', async () => {
  const sessionId = await createSession(), release = Promise.withResolvers<void>(); gate = release.promise;
  const accepted = await send(sessionId, 'Keep running while observer times out', {}, true); await started.promise;
  const reads = requests.filter(value => value.route.endsWith(`/${accepted.generationId}/output`)).length;
  await assert.rejects(run(['generation', 'output', accepted.generationId, '--follow', 'true', '--timeout-ms', '500']), { code: 'AGENT_STREAM_DETACHED' });
  assert.equal(requests.filter(value => value.route.endsWith(`/${accepted.generationId}/output`)).length, reads + 1);
  assert.equal(getActiveChat(sessionId)?.id, accepted.generationId); assert.equal(runs.length, 1);
  release.resolve(); await finish(accepted.generationId);
});

test('T33 a lost admission response is unknown and is inspected by original input identity without resend', async () => {
  const sessionId = await createSession(), inputId = randomUUID();
  const body = { id: sessionId, messages: [{ id: inputId, role: 'user', parts: [{ type: 'text', text: 'One original accepted message' }] }], idempotencyKey: inputId, config: { threadSettingsRevision: getThread(sessionId)!.revision } };
  loseNextChatReply = true;
  const before = requests.filter(value => value.route === '/api/chat' && value.method === 'POST').length;
  await assert.rejects(run(['message', 'send', sessionId, '--file', await jsonFile(body)]), { code: 'AGENT_CONNECTION_FAILED' });
  const generation = listChatGenerations(sessionId).find(value => value.inputMessageId === inputId);
  assert.ok(generation); await finish(generation.id);
  const submission = printed(z.object({ status: z.literal('accepted'), generationId: z.string(), storeId: z.string(), restoreEpoch: z.number() }), await run(['message', 'submission', sessionId, inputId]));
  assert.equal(submission.generationId, generation.id);
  assert.equal(printed(z.object({ status: z.literal('unknown') }), await run(['message', 'submission', sessionId, 'missing-original-key'])).status, 'unknown');
  await run(['generation', 'status', sessionId, '--generation', generation.id]);
  await run(['generation', 'stream', generation.id]);
  assert.equal(requests.filter(value => value.route === '/api/chat' && value.method === 'POST').length, before + 1);
  assert.equal(listChatGenerations(sessionId).length, 1); assert.equal(runs.length, 1);
});

test('T32 editing, ordering and removing queued drafts use original queue revisions and never execute', async () => {
  const sessionId = await createSession();
  const draft = (inputId: string) => ({ message: { id: inputId, role: 'user', parts: [{ type: 'text', text: inputId }] } });
  for (const name of ['one', 'two']) await run(['message', 'enqueue', sessionId, '--file', await jsonFile({ id: name, draft: draft(`${name}-input`), threadSettingsRevision: getThread(sessionId)!.revision })]);
  await run(['message', 'queue-edit', sessionId, 'one', '--file', await jsonFile({ action: 'edit', revision: 0, draft: draft('fresh-edited-input'), threadSettingsRevision: getThread(sessionId)!.revision })]);
  await assert.rejects(run(['message', 'queue-remove', sessionId, 'one', '--file', await jsonFile({ action: 'remove', revision: 0 })]), { status: 409 });
  await run(['message', 'queue-move', sessionId, 'two', '--file', await jsonFile({ action: 'move', revision: 0, beforeId: 'one' })]);
  const ordered = printed(queueResponseSchema, await run(['message', 'queue', sessionId]));
  assert.deepEqual(ordered.messages.map(value => value.id), ['two', 'one']);
  const original = ordered.messages.find(value => value.id === 'one')!;
  await run(['message', 'queue-remove', sessionId, 'one', '--file', await jsonFile({ action: 'remove', revision: original.revision })]);
  assert.deepEqual((await run(['message', 'saved', sessionId, 'queue', 'one']))[0], { saved: true });
  assert.equal(runs.length, 0); assert.equal(listChatGenerations(sessionId).length, 0);
});

test('T32 settle, auto-settle and unread operations persist native sidebar revisions without completing PM tasks', async () => {
  const sessionId = await createSession();
  let sidebarRevision = 0;
  for (const [action, extra] of [['settle', []], ['unsettle', []], ['auto-settle', ['--enabled', 'false']], ['mark-unread', []], ['visit', []]] as const) {
    const changed = printed(sidebarResponseSchema, await run(['session', action, sessionId, '--revision', String(sidebarRevision), ...extra]));
    assert.ok(changed.thread.sidebar.revision > sidebarRevision); sidebarRevision = changed.thread.sidebar.revision;
  }
  assert.equal(getThread(sessionId)!.status, 'regular'); assert.equal(runs.length, 0); assert.equal(pmWrites.length, 0);
});

test('T33 a replacement admitted after stop preflight survives the native exact-generation guard', async () => {
  const sessionId = await createSession(), originalRelease = Promise.withResolvers<void>(); gate = originalRelease.promise;
  const original = await send(sessionId, 'Original turn ends before cancellation reaches the service', {}, true); await started.promise;
  const replacementRelease = Promise.withResolvers<void>();
  let replacementId: string | undefined;
  beforeCancel = async () => {
    originalRelease.resolve(); await finish(original.generationId);
    gate = replacementRelease.promise; started = Promise.withResolvers<void>();
    const replacement = await send(sessionId, 'Explicit new turn, not a retried write', {}, true); await started.promise;
    replacementId = replacement.generationId;
  };
  const observed = printed(z.object({
    stop: z.object({ generationId: z.string(), status: z.literal('not_cancelled') }),
    generation: z.object({ id: z.string(), status: z.literal('completed') }),
  }), await run(['generation', 'stop', sessionId, '--generation', original.generationId]));
  assert.equal(observed.stop.generationId, original.generationId);
  assert.equal(observed.generation.id, original.generationId);
  assert.ok(replacementId); assert.equal(getActiveChat(sessionId)?.id, replacementId);
  await run(['generation', 'stop', sessionId, '--generation', replacementId]);
  assert.equal(getActiveChat(sessionId), undefined); assert.equal(runs.length, 2); replacementRelease.resolve();
});
