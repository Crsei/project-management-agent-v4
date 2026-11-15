import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import WebSocket from 'ws';
import type { TerminalDescriptor, TerminalServerMessage } from '@agent-workspace/contracts/inspector';
import { chatDraftInputSchema, type ChatDraftInput, type ExecutionSelection } from '@agent-workspace/contracts/chat';
import type { TaskCodeDelivery } from '../../../../../packages/contracts/src/task-code-delivery.ts';
import type { GitStatusResponse, InspectorFileResponse, InspectorTreeResponse } from '@agent-workspace/contracts/inspector';
import { chatContextResolveResponseSchema, type AcceptedChatContext } from '@agent-workspace/contracts/message-context';

const original = { data: process.env.AGENT_WORKSPACE_DATA_DIR, roots: process.env.AGENT_WORKSPACE_ALLOWED_ROOTS, pm: process.env.PM_API_URL, access: process.env.AGENT_WORKSPACE_ACCESS_TOKEN };
const directory = await mkdtemp(path.join(tmpdir(), 'terminal-manager-v2-'));
const root = path.join(directory, 'code');
process.env.AGENT_WORKSPACE_DATA_DIR = path.join(directory, 'data');
process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = JSON.stringify([directory]);
delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
// Test module-loading boundary: durable configuration must see the isolated data
// directory before loading terminal/runtime modules.
const { attachTerminalUpgrade, stopTerminals } = await import('./terminal.ts');
const { inspectorRoutes } = await import('./index.ts');
const { chatRoutes } = await import('../chat.ts');
const { ensureThread, getThread, updateThread, freezeThreadExecution } = await import('../durable/threads.ts');
const { closeStore, readRecord } = await import('../durable/store.ts');
const { openAgentWorkspace, resolveAgentWorkspaceExecution, updateAgentWorkspace } = await import('../agent-workspaces.ts');
const { accessGuard } = await import('../access.ts');
const { deliveryStore, resolveChatExecutionScope } = await import('../task-delivery/binding.ts');
const { enqueueMessage, editQueuedMessage, listQueuedMessages, mutateQueue, stashDraft, listStashedDrafts, removeStashedDraft } = await import('../durable/message-queue.ts');
const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (await exec('git', args, { cwd, encoding: 'utf8' })).stdout.trim();
}
let selection: ExecutionSelection;
let pm: Server, agent: Server, origin: string, pmRequests = 0;
before(async () => {
  await mkdir(root); await mkdir(path.join(root, 'nested'));
  pm = createServer((_request, response) => {
    pmRequests++;
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'PM deliberately offline' }));
  });
  const ready = Promise.withResolvers<void>(); pm.listen(0, '127.0.0.1', ready.resolve); await ready.promise;
  process.env.PM_API_URL = `http://127.0.0.1:${(pm.address() as AddressInfo).port}`;
  const workspace = openAgentWorkspace({ path: root });
  selection = { version: 2, agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision };
  ensureThread('session', 'Session', selection, { ...resolveAgentWorkspaceExecution(selection).environment, frozen: true });
  const app = new Hono().use('/api/*', accessGuard).route('/api', inspectorRoutes).route('/api', chatRoutes);
  agent = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }) as Server;
  if (!agent.listening) { const ready = Promise.withResolvers<void>(); agent.once('listening', ready.resolve); await ready.promise; }
  attachTerminalUpgrade(agent);
  origin = `http://127.0.0.1:${(agent.address() as AddressInfo).port}`;
});
after(async () => {
  await stopTerminals(); closeStore();
  for (const server of [agent, pm]) { const closed = Promise.withResolvers<void>(); server.close(() => closed.resolve()); server.closeAllConnections(); await closed.promise; }
  assert.equal(pmRequests, 0, 'Files/Git/PTY authorization never consults PM');
  for (const [key, value] of [["AGENT_WORKSPACE_DATA_DIR", original.data], ["AGENT_WORKSPACE_ALLOWED_ROOTS", original.roots], ["PM_API_URL", original.pm], ["AGENT_WORKSPACE_ACCESS_TOKEN", original.access]] as const) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  await rm(directory, { recursive: true, force: true });
});
function workspaceQuery(target = selection, extra: Record<string, string> = {}) {
  return new URLSearchParams({ agentWorkspaceId: target.agentWorkspaceId!, agentWorkspaceRevision: String(target.agentWorkspaceRevision), ...extra });
}
async function creationBody(scopeKind: 'workspace' | 'session' = 'workspace', relativePath = '') {
  const listed = await fetch(`${origin}/api/inspector/terminals?${workspaceQuery()}`);
  assert.equal(listed.status, 200, await listed.clone().text());
  const { serviceId } = await listed.json() as { serviceId: string };
  return { requestId: randomUUID(), expectedServiceId: serviceId, scope: scopeKind, agentWorkspaceId: selection.agentWorkspaceId!, agentWorkspaceRevision: selection.agentWorkspaceRevision!, relativePath, ...(scopeKind === 'session' ? { threadId: 'session' } : {}) };
}
async function post(body: object) { return fetch(`${origin}/api/inspector/terminals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
async function create(scopeKind: 'workspace' | 'session' = 'workspace', relativePath = '') {
  const response = await post(await creationBody(scopeKind, relativePath));
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json() as { terminal: TerminalDescriptor }).terminal;
}
function attach(id: string, clientId: string, afterSeq = 0) {
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/inspector/terminal?${new URLSearchParams({ terminalId: id, clientId, afterSeq: String(afterSeq) })}`);
  const messages: TerminalServerMessage[] = [];
  const waiters: { predicate: (frame: TerminalServerMessage) => boolean; resolve: (frame: TerminalServerMessage) => void }[] = [];
  socket.on('message', raw => {
    const frame = JSON.parse(raw.toString()) as TerminalServerMessage; messages.push(frame);
    for (let index = waiters.length - 1; index >= 0; index--) {
      const waiter = waiters[index]!;
      if (waiter.predicate(frame)) { waiters.splice(index, 1); waiter.resolve(frame); }
    }
  });
  return { socket, messages, text: () => messages.flatMap(frame => frame.type === 'output' ? [frame.data] : []).join(''), async wait(predicate: (frame: TerminalServerMessage) => boolean) {
    const old = messages.find(predicate); if (old) return old;
    const result = Promise.withResolvers<TerminalServerMessage>();
    const waiter = { predicate, resolve: result.resolve }; waiters.push(waiter);
    const timer = setTimeout(() => result.reject(new Error('Terminal frame deadline exceeded')), 10000);
    try { return await result.promise; } finally { clearTimeout(timer); const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); }
  } };
}
async function detach(socket: WebSocket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  const result = Promise.withResolvers<void>(); socket.once('close', () => result.resolve()); socket.close(); await result.promise;
}

test('PTY inherits native settings but never server-only PM or Agent credentials', async () => {
  const keys = ['PM_AUTOMATION_SERVICE_SECRET', 'AGENT_PM_TOOL_BRIDGE', 'WORKSPACE_PUBLIC_FIXTURE'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.PM_AUTOMATION_SERVICE_SECRET = 'synthetic-server-secret';
  process.env.AGENT_PM_TOOL_BRIDGE = 'synthetic-tool-credential';
  process.env.WORKSPACE_PUBLIC_FIXTURE = 'native-setting-preserved';
  let terminal: TerminalDescriptor;
  try { terminal = await create(); }
  finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
  const client = attach(terminal.id, 'credential-boundary');
  try {
    await client.wait(frame => frame.type === 'ready');
    client.socket.send(JSON.stringify({ type: 'input', seq: 1, data: "stty -echo; if [ -z \"${PM_AUTOMATION_SERVICE_SECRET+x}${AGENT_PM_TOOL_BRIDGE+x}\" ]; then printf '__SERVER_ENV_SAFE__\\n'; else printf '__SERVER_ENV_LEAK__\\n'; fi; printf '__NATIVE_%s__\\n' \"$WORKSPACE_PUBLIC_FIXTURE\"; printf '__ENV_DONE__\\n'\n" }));
    await client.wait(frame => frame.type === 'output' && client.text().includes('__ENV_DONE__\r\n'));
    assert.ok(client.text().includes('__SERVER_ENV_SAFE__\r\n'), 'PTY inherited a server-only credential');
    assert.ok(client.text().includes('__NATIVE_native-setting-preserved__\r\n'));
  } finally {
    await fetch(`${origin}/api/inspector/terminals/${terminal.id}`, { method: 'DELETE' });
    await detach(client.socket);
  }
});

test('workspace PTY survives detach/reconnect, replays by sequence, and duplicate input is acknowledged once', async () => {
  const terminal = await create();
  const first = attach(terminal.id, 'browser-stable');
  await first.wait(frame => frame.type === 'ready');
  first.socket.send(JSON.stringify({ type: 'input', seq: 1, data: "stty -echo; printf '__READY__\\n'\n" }));
  await first.wait(frame => frame.type === 'output' && first.text().includes('__READY__\r\n'));
  first.socket.send(JSON.stringify({ type: 'input', seq: 2, data: 'printf x >> input-count\n' }));
  await first.wait(frame => frame.type === 'ack' && frame.seq === 2);
  first.socket.send(JSON.stringify({ type: 'input', seq: 2, data: 'printf x >> input-count\n' }));
  first.socket.send(JSON.stringify({ type: 'input', seq: 3, data: "printf '__DONE__\\n'\n" }));
  await first.wait(frame => frame.type === 'output' && first.text().includes('__DONE__\r\n'));
  assert.equal(await readFile(path.join(root, 'input-count'), 'utf8'), 'x');
  const sequence = Math.max(...first.messages.flatMap(frame => frame.type === 'output' ? [frame.seq] : [0]));
  await detach(first.socket);
  const status = await fetch(`${origin}/api/inspector/terminals/${terminal.id}`);
  assert.equal((await status.json() as { terminal: TerminalDescriptor }).terminal.status, 'running');
  const second = attach(terminal.id, 'browser-stable', sequence);
  const ready = await second.wait(frame => frame.type === 'ready');
  assert.equal(ready.type === 'ready' && ready.terminal.id, terminal.id);
  assert.equal(ready.type === 'ready' && ready.acceptedInputSeq, 3);
  assert.ok(second.messages.every(frame => frame.type !== 'output' || frame.seq > sequence));
  second.socket.send(JSON.stringify({ type: 'input', seq: 4, data: "printf '__RECONNECTED__\\n'\n" }));
  await second.wait(frame => frame.type === 'output' && second.text().includes('__RECONNECTED__\r\n'));
  await fetch(`${origin}/api/inspector/terminals/${terminal.id}`, { method: 'DELETE' });
  await second.wait(frame => frame.type === 'exit');
  await detach(second.socket);
});
test('Session relative start and shell cd never change Agent execution path; explicit terminate is separate from detach', async () => {
  const terminal = await create('session', 'nested');
  assert.equal(terminal.startCwd, path.join(root, 'nested'));
  const client = attach(terminal.id, 'session-client'); await client.wait(frame => frame.type === 'ready');
  client.socket.send(JSON.stringify({ type: 'input', seq: 1, data: "stty -echo; cd ..; printf '__CD_DONE__\\n'\n" }));
  await client.wait(frame => frame.type === 'output' && client.text().includes('__CD_DONE__\r\n'));
  assert.equal(getThread('session')!.executionEnvironment!.executionPath, root);
  await detach(client.socket);
  const result = await fetch(`${origin}/api/inspector/terminals/${terminal.id}`, { method: 'DELETE' }); assert.equal(result.status, 200);
});
test('arbitrary cwd, obsolete root selection, traversal and unavailable lifetime IDs fail without recreation', async () => {
  for (const patch of [{ cwd: '/' }, { rootId: 'not-selected' }, { workspaceId: 'pm-forgery' }, { relativePath: '../' }]) {
    const response = await post({ ...await creationBody('session'), ...patch });
    assert.ok(response.status >= 400);
  }
  assert.equal((await fetch(`${origin}/api/inspector/terminals/not-from-this-service`)).status, 404);
  assert.equal((await post({ ...await creationBody('session'), agentWorkspaceRevision: selection.agentWorkspaceRevision! + 1 })).status, 409);
});

test('Agent access revocation and external MCP credentials reject independently of PM login', async () => {
  const terminal = await create();
  const previous = process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
  process.env.AGENT_WORKSPACE_ACCESS_TOKEN = 'terminal-test-token-with-at-least-32-characters';
  try {
    assert.equal((await fetch(`${origin}/api/inspector/terminals/${terminal.id}`)).status, 401);
    assert.equal((await fetch(`${origin}/api/inspector/terminals?${workspaceQuery()}`)).status, 401);
    assert.equal((await fetch(`${origin}/api/inspector/terminals/${terminal.id}`, { headers: { authorization: 'Bearer pm-mcp-access-v1.forged' } })).status, 401);
  } finally {
    if (previous === undefined) delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN; else process.env.AGENT_WORKSPACE_ACCESS_TOKEN = previous;
  }
  assert.equal((await fetch(`${origin}/api/inspector/terminals/${terminal.id}`, { method: 'DELETE' })).status, 200);
  assert.equal(pmRequests, 0);
});
test('lost creation response is reconciled by stable requestId and never launches a second PTY', async () => {
  const body = await creationBody();
  const [first, second] = await Promise.all([post(body), post(body)]);
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  const a = (await first.json() as { terminal: TerminalDescriptor }).terminal;
  const b = (await second.json() as { terminal: TerminalDescriptor }).terminal;
  assert.equal(a.id, b.id); assert.equal(a.requestId, body.requestId);
  const listed = await fetch(`${origin}/api/inspector/terminals?${workspaceQuery(selection, { requestId: body.requestId })}`);
  const result = await listed.json() as { terminals: TerminalDescriptor[] };
  assert.deepEqual(result.terminals.map(value => value.id), [a.id]);
  assert.equal((await post({ ...body, relativePath: 'nested' })).status, 409);
  assert.equal((await post({ ...body, requestId: randomUUID(), expectedServiceId: randomUUID() })).status, 409);
  const attached = attach(a.id, 'lost-before-server');
  const ready = await attached.wait(frame => frame.type === 'ready');
  assert.equal(ready.type === 'ready' && ready.acceptedInputSeq, 0);
  attached.socket.send(JSON.stringify({ type: 'input', seq: 1, data: "stty -echo; printf '__FRESH_AFTER_LOCAL_LOSS__\\n'\n" }));
  await attached.wait(frame => frame.type === 'output' && attached.text().includes('__FRESH_AFTER_LOCAL_LOSS__\r\n'));
  await fetch(`${origin}/api/inspector/terminals/${a.id}`, { method: 'DELETE' });
  await attached.wait(frame => frame.type === 'exit'); await detach(attached.socket);
});

test('attach to a terminal from another service lifetime cannot create a process', async () => {
  const before = await fetch(`${origin}/api/inspector/terminals?${workspaceQuery()}`);
  const existing = (await before.json() as { terminals: TerminalDescriptor[] }).terminals.map(value => value.id);
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/inspector/terminal?${new URLSearchParams({
    terminalId: randomUUID(), clientId: 'unknown-lifetime', afterSeq: '0',
  })}`);
  const result = Promise.withResolvers<number>();
  socket.on('unexpected-response', (_request, response) => { response.resume(); result.resolve(response.statusCode!); socket.terminate(); });
  socket.on('open', () => result.reject(new Error('Unknown lifetime unexpectedly attached')));
  socket.on('error', () => { /* A rejected upgrade closes the client. */ });
  assert.equal(await result.promise, 404);
  const after = await fetch(`${origin}/api/inspector/terminals?${workspaceQuery()}`);
  assert.deepEqual((await after.json() as { terminals: TerminalDescriptor[] }).terminals.map(value => value.id), existing);
});

test('a Session terminal cannot follow a rebind to another directory', async () => {
  const otherPath = path.join(directory, 'other'); await mkdir(otherPath);
  const other = openAgentWorkspace({ path: otherPath });
  ensureThread('rebind-session', undefined, selection);
  const body = { ...await creationBody('session'), threadId: 'rebind-session' };
  const response = await post(body); assert.equal(response.status, 200);
  const { terminal } = await response.json() as { terminal: TerminalDescriptor };
  updateThread('rebind-session', { executionSelection: { version: 2, agentWorkspaceId: other.id, agentWorkspaceRevision: other.revision } });
  assert.equal((await fetch(`${origin}/api/inspector/terminals/${terminal.id}`)).status, 409);
  updateThread('rebind-session', { executionSelection: selection });
  await fetch(`${origin}/api/inspector/terminals/${terminal.id}`, { method: 'DELETE' });
});

test('relative-path symlink escape and start-directory inode replacement reject', async () => {
  await symlink(directory, path.join(root, 'outside-link'));
  assert.equal((await post(await creationBody('workspace', 'outside-link'))).status, 400);
  const nested = path.join(root, 'nested'), moved = path.join(root, 'nested-original');
  const terminal = await create('session', 'nested');
  await rename(nested, moved); await mkdir(nested);
  try {
    assert.equal((await fetch(`${origin}/api/inspector/terminals/${terminal.id}`)).status, 409);
  } finally {
    await rm(nested, { recursive: true }); await rename(moved, nested);
    await fetch(`${origin}/api/inspector/terminals/${terminal.id}`, { method: 'DELETE' });
  }
});

test('same-path workspace replacement invalidates its PTY without cwd fallback', async () => {
  const replacementRoot = path.join(directory, 'replaceable'), moved = `${replacementRoot}-original`;
  await mkdir(replacementRoot);
  const workspace = openAgentWorkspace({ path: replacementRoot });
  const body = { ...await creationBody(), agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision };
  const response = await post(body); assert.equal(response.status, 200);
  const { terminal } = await response.json() as { terminal: TerminalDescriptor };
  await rename(replacementRoot, moved); await mkdir(replacementRoot);
  try {
    assert.ok((await fetch(`${origin}/api/inspector/terminals/${terminal.id}`)).status >= 400);
  } finally {
    await rm(replacementRoot, { recursive: true }); await rename(moved, replacementRoot);
    await fetch(`${origin}/api/inspector/terminals/${terminal.id}`, { method: 'DELETE' });
  }
});

test('controlled worktree Files, Git, Session PTY and frozen execution agree without PM access', async () => {
  const source = path.join(directory, 'delivery-source'), worktree = path.join(directory, 'delivery-worktree');
  await mkdir(source);
  await git(source, 'init', '-q', '-b', 'main');
  await git(source, 'config', 'user.name', 'Inspector Test');
  await git(source, 'config', 'user.email', 'inspector@example.com');
  await writeFile(path.join(source, 'tracked.txt'), 'source contents\n');
  await git(source, 'add', '.'); await git(source, 'commit', '-qm', 'fixture');
  const remote = 'https://github.com/example/inspector-test.git';
  await git(source, 'remote', 'add', 'origin', remote);
  await git(source, 'worktree', 'add', '-b', 'controlled-inspector', worktree, 'HEAD');
  await writeFile(path.join(worktree, 'only-worktree.txt'), 'actual execution\n');
  const workspace = openAgentWorkspace({ path: source });
  const target = { version: 2 as const, agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision };
  ensureThread('controlled-session', undefined, target);
  const identity = await lstat(worktree);
  const receipt: TaskCodeDelivery = {
    id: randomUUID(), workspaceId: randomUUID(), projectId: 'PRJ-001', taskId: 'TASK-001',
    taskRevision: 'fixture-revision', title: 'Inspector worktree', description: '', baseBranch: 'main',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 1,
    step: 'ready', threadId: 'controlled-session', executionSelection: target,
    git: { root: source, directory: worktree, directoryIdentity: `${identity.dev}:${identity.ino}`,
      commonDirectory: await git(source, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
      remote, owner: 'example', repo: 'inspector-test', baseBranch: 'main',
      baseSha: await git(source, 'rev-parse', 'HEAD'), branch: 'controlled-inspector' },
  };
  deliveryStore.save(receipt);
  const snapshot = await resolveChatExecutionScope(getThread('controlled-session')!, undefined, 'inspect');
  assert.equal(snapshot.path, worktree); assert.equal(snapshot.environment.sourcePath, source);
  freezeThreadExecution('controlled-session', snapshot.environment);
  const query = new URLSearchParams({ threadId: 'controlled-session' });
  const treeResponse = await fetch(`${origin}/api/inspector/files?${query}`);
  assert.equal(treeResponse.status, 200);
  assert.equal((await treeResponse.json() as InspectorTreeResponse).root, worktree);
  query.set('path', 'only-worktree.txt');
  const fileResponse = await fetch(`${origin}/api/inspector/file?${query}`);
  assert.equal(fileResponse.status, 200);
  assert.equal((await fileResponse.json() as InspectorFileResponse).content, 'actual execution\n');
  const gitResponse = await fetch(`${origin}/api/inspector/git?threadId=controlled-session`);
  assert.equal(gitResponse.status, 200);
  const status = await gitResponse.json() as GitStatusResponse;
  assert.equal(status.root, worktree);
  assert.equal(status.branch, receipt.git!.branch);
  assert.ok(status.files.some(file => file.path === 'only-worktree.txt'));
  const response = await post({ ...await creationBody('session'), agentWorkspaceId: workspace.id,
    agentWorkspaceRevision: workspace.revision, threadId: 'controlled-session' });
  assert.equal(response.status, 200, await response.clone().text());
  const { terminal } = await response.json() as { terminal: TerminalDescriptor };
  assert.equal(terminal.startCwd, worktree);
  const attached = attach(terminal.id, 'controlled-worktree');
  await attached.wait(frame => frame.type === 'ready');
  attached.socket.send(JSON.stringify({ type: 'input', seq: 1, data: 'stty -echo; printf "__WORKTREE_CWD__%s\\n" "$PWD"\n' }));
  await attached.wait(frame => frame.type === 'output' && attached.text().includes(`__WORKTREE_CWD__${worktree}\r\n`));
  assert.equal(getThread('controlled-session')!.executionEnvironment!.executionPath, worktree);
  await fetch(`${origin}/api/inspector/terminals/${terminal.id}`, { method: 'DELETE' });
  await attached.wait(frame => frame.type === 'exit'); await detach(attached.socket);
  const workspaceResponse = await post({ ...await creationBody(), agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision });
  assert.equal(workspaceResponse.status, 200);
  const workspaceTerminal = (await workspaceResponse.json() as { terminal: TerminalDescriptor }).terminal;
  assert.equal(workspaceTerminal.startCwd, source);
  const workspaceClient = attach(workspaceTerminal.id, 'workspace-context-observer');
  await workspaceClient.wait(frame => frame.type === 'ready');
  workspaceClient.socket.send(JSON.stringify({ type: 'input', seq: 1, data: 'stty -echo; printf "__WORKSPACE_CONTEXT_BODY__\\n"\n' }));
  await workspaceClient.wait(frame => frame.type === 'output' && workspaceClient.text().includes('__WORKSPACE_CONTEXT_BODY__'));
  const selected = { contextId: 'workspace-root-snapshot', kind: 'terminal', source: {
    type: 'terminal', terminalId: workspaceTerminal.id, serviceId: workspaceTerminal.serviceId }, text: '__WORKSPACE_CONTEXT_BODY__' };
  const resolve = (threadId: string) => fetch(`${origin}/api/chat/threads/${threadId}/context/resolve`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contextItems: [selected] }) });
  const wrongRoot = await resolve('controlled-session');
  assert.equal(wrongRoot.status, 403);
  assert.equal((await wrongRoot.json()).code, 'terminal_scope_mismatch');
  ensureThread('workspace-context-session', undefined, target, resolveAgentWorkspaceExecution(target).environment);
  const sameRoot = await resolve('workspace-context-session');
  assert.equal(sameRoot.status, 200, await sameRoot.clone().text());
  await fetch(`${origin}/api/inspector/terminals/${workspaceTerminal.id}`, { method: 'DELETE' });
  await detach(workspaceClient.socket);
  assert.equal(pmRequests, 0);
});

test('metadata revisions preserve existing PTYs while future bindings reject', async () => {
  const metadataRoot = path.join(directory, 'metadata-only'); await mkdir(metadataRoot);
  const workspace = openAgentWorkspace({ path: metadataRoot });
  const response = await post({ ...await creationBody(), agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision });
  assert.equal(response.status, 200);
  const { terminal } = await response.json() as { terminal: TerminalDescriptor };
  const renamed = updateAgentWorkspace(workspace.id, { expectedRevision: workspace.revision, name: 'New display name' });
  const target = { version: 2 as const, agentWorkspaceId: renamed.id, agentWorkspaceRevision: renamed.revision };
  const listed = await fetch(`${origin}/api/inspector/terminals?${workspaceQuery(target)}`);
  assert.equal(listed.status, 200);
  assert.ok((await listed.json() as { terminals: TerminalDescriptor[] }).terminals.some(value => value.id === terminal.id));
  assert.equal((await fetch(`${origin}/api/inspector/terminals/${terminal.id}`)).status, 200);
  const future = await post({ ...await creationBody(), agentWorkspaceId: renamed.id, agentWorkspaceRevision: renamed.revision + 1 });
  assert.ok(future.status >= 400);
  await fetch(`${origin}/api/inspector/terminals/${terminal.id}`, { method: 'DELETE' });
});

test('Session deletion waits for the real PTY exit and rejects late terminal creation after closing', async () => {
  const terminalRoot = path.join(directory, 'deletion-terminal'); await mkdir(terminalRoot);
  const workspace = openAgentWorkspace({ path: terminalRoot });
  const threadId = 'terminal-deletion-session';
  const chosen: ExecutionSelection = { version: 2, agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision };
  ensureThread(threadId, 'Deletion evidence', chosen, resolveAgentWorkspaceExecution(chosen).environment);
  const body = { ...await creationBody(), scope: 'session', threadId, agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision };
  const created = await post(body); assert.equal(created.status, 200, await created.clone().text());
  const terminal = (await created.json() as { terminal: TerminalDescriptor }).terminal;
  const client = attach(terminal.id, 'deletion-observer');
  const release = path.join(terminalRoot, 'release-stop');
  const controlledShell = path.join(terminalRoot, 'controlled-shell.sh');
  await writeFile(controlledShell, [
    'stty -echo',
    'trap \'printf "__TERMINATING__\\n"; while [ ! -f "$1" ]; do sleep 0.02; done; exit 0\' TERM',
    'printf "__DELETE_READY__\\n"',
    'while :; do sleep 0.02; done',
    '',
  ].join('\n'), { mode: 0o600 });
  let deleteFinished = false;
  let deleting: Promise<Response> | undefined;
  try {
    await client.wait(frame => frame.type === 'ready');
    client.socket.send(JSON.stringify({ type: 'input', seq: 1,
      // Replace the interactive login shell: readline may defer a trapped TERM until another input line.
      // exec preserves the owned PTY leader/start identity and makes this actual exit barrier deterministic.
      data: `exec /bin/sh ${JSON.stringify(controlledShell)} ${JSON.stringify(release)}\n` }));
    await client.wait(frame => frame.type === 'output' && client.text().includes('__DELETE_READY__'));
    deleting = fetch(`${origin}/api/chat/threads/${threadId}`, { method: 'DELETE',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'original-terminal-delete' },
      body: JSON.stringify({ lifecycleRevision: 0, confirm: true, expectedGenerationId: null, stopActive: false }) }).then(response => { deleteFinished = true; return response; });
    await client.wait(frame => frame.type === 'output' && client.text().includes('__TERMINATING__'));
    const stoppingReceipt = await fetch(`${origin}/api/chat/threads/${threadId}/lifecycle-operations/original-terminal-delete`);
    assert.equal((await stoppingReceipt.json()).operation.state, 'stopping');
    assert.equal(deleteFinished, false, 'Sending SIGTERM must not be reported as observed stop/deletion.');
    const late = await post({ ...body, requestId: randomUUID() });
    assert.equal(late.status, 409); assert.equal((await late.json()).code, 'thread_closing');
    await writeFile(release, 'explicit test release');
    const deleted = await deleting; assert.equal(deleted.status, 200, await deleted.clone().text());
    await client.wait(frame => frame.type === 'exit');
    assert.equal(getThread(threadId), null);
    assert.equal((await post({ ...body, requestId: randomUUID() })).status, 409);
  } finally {
    await writeFile(release, 'cleanup release'); await deleting?.catch(() => undefined); await detach(client.socket);
  }
});

test('terminal selected context verifies the real lifetime but remains a user snapshot, never command replay', async () => {
  const selectedRoot = path.join(directory, 'selected-terminal-context'); await mkdir(selectedRoot);
  const workspace = openAgentWorkspace({ path: selectedRoot });
  const chosen: ExecutionSelection = { version: 2, agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision };
  const threadId = 'selected-terminal-context';
  ensureThread(threadId, 'Selected terminal', chosen, resolveAgentWorkspaceExecution(chosen).environment);
  const created = await post({ ...await creationBody(), scope: 'session', threadId, agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision });
  assert.equal(created.status, 200);
  const terminal = (await created.json() as { terminal: TerminalDescriptor }).terminal;
  const client = attach(terminal.id, 'context-observer');
  try {
    await client.wait(frame => frame.type === 'ready');
    client.socket.send(JSON.stringify({ type: 'input', seq: 1, data: "printf '\\nACTUAL_SELECTED_OUTPUT\\n'\n" }));
    await client.wait(frame => frame.type === 'output' && client.text().includes('ACTUAL_SELECTED_OUTPUT'));
    const input = { contextId: 'terminal-selection', kind: 'terminal', source: { type: 'terminal', terminalId: terminal.id, serviceId: terminal.serviceId },
      terminalLabel: 'CALLER_UNTRUSTED_LABEL', selection: { startLine: 1, endLine: 1 }, text: 'ACTUAL_SELECTED_OUTPUT' };
    const resolve = (context: object) => fetch(`${origin}/api/chat/threads/${threadId}/context/resolve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contextItems: [context] }) });
    const response = await resolve(input); assert.equal(response.status, 200, await response.clone().text());
    const accepted = chatContextResolveResponseSchema.parse(await response.json()).contextItems[0]!;
    assert.equal(accepted.provenance, 'user-terminal-snapshot');
    assert.equal(accepted.text, 'ACTUAL_SELECTED_OUTPUT');
    assert.equal(accepted.terminalLabel, terminal.startCwd);
    assert.notEqual(accepted.terminalLabel, input.terminalLabel);
    assert.equal(getThread(threadId)!.executionEnvironment!.frozen, false, 'Resolve is not execution admission.');
    const wrongLifetime = await resolve({ ...input, source: { ...input.source, serviceId: randomUUID() } });
    assert.equal(wrongLifetime.status, 409);
    if (accepted.visibility !== 'available') assert.fail('The real selected terminal must be available.');
    assert.equal(accepted.input.source.type, 'terminal');
    if (accepted.input.source.type !== 'terminal') assert.fail('Expected the real terminal source.');
    assert.match(accepted.input.source.environmentDigest!, /^[a-f0-9]{64}$/);
    const previewOnlyResponse = await resolve({ ...accepted.input, contextId: 'read-only-terminal-preview' });
    assert.equal(previewOnlyResponse.status, 200);
    const previewOnly = chatContextResolveResponseSchema.parse(await previewOnlyResponse.json()).contextItems[0]!;
    if (previewOnly.visibility !== 'available') assert.fail('The read-only preview must initially resolve.');
    const draft: ChatDraftInput = { message: { id: 'persisted-terminal-input', role: 'user', parts: [{ type: 'text', text: 'Discuss the selected historical output.' }] }, contextItems: [accepted.input] };
    assert.equal(chatDraftInputSchema.safeParse({ ...draft, acceptedContextItems: [accepted] }).success, false, 'Clients cannot submit accepted proof.');
    const headers = new Headers({ host: new URL(origin).host }), settingsRevision = getThread(threadId)!.revision;
    await enqueueMessage(threadId, 'terminal-queue', draft, settingsRevision, headers);
    await stashDraft(threadId, 'terminal-stash', draft, headers);
    const savedTimes = new Set([
      ...readRecord<{ acceptedContextItems: AcceptedChatContext[] }>('chat:message-queue', JSON.stringify([threadId, 'terminal-queue']))!.acceptedContextItems,
      ...readRecord<{ acceptedContextItems: AcceptedChatContext[] }>('chat:draft-stash', JSON.stringify([threadId, 'terminal-stash']))!.acceptedContextItems,
    ].map(item => item.acceptedAt));
    await stopTerminals();
    closeStore();
    assert.equal((await fetch(`${origin}/api/inspector/terminals/${terminal.id}`)).status, 404, 'No PTY is restored.');
    assert.deepEqual((await listQueuedMessages(threadId, headers))[0]!.draft!.contextItems, draft.contextItems);
    assert.deepEqual((await listStashedDrafts(threadId, headers))[0]!.draft!.contextItems, draft.contextItems);
    const historicalResponse = await resolve(accepted.input); assert.equal(historicalResponse.status, 200, await historicalResponse.clone().text());
    const historical = chatContextResolveResponseSchema.parse(await historicalResponse.json()).contextItems[0]!;
    assert.equal(historical.text, 'ACTUAL_SELECTED_OUTPUT');
    assert.equal(historical.provenance, 'user-terminal-snapshot');
    assert.ok(savedTimes.has(historical.acceptedAt), 'Historical acceptance time is preserved, not fabricated anew.');
    assert.match(historical.reason!, /PTY is unavailable.*not restored or rerun/);
    assert.equal((await resolve(previewOnly.input)).status, 404, 'Read-only resolution never creates a persistence proof.');
    const editedDraft = { ...draft, message: { ...draft.message, id: 'edited-terminal-input' } };
    await editQueuedMessage(threadId, 'terminal-queue', 0, editedDraft, settingsRevision, headers);
    await assert.rejects(editQueuedMessage(threadId, 'terminal-queue', 1, {
      ...editedDraft, message: { ...editedDraft.message, id: 'forged-terminal-input' },
      contextItems: [{ ...accepted.input, comment: 'Changed immutable snapshot input' }],
    }, settingsRevision, headers), { code: 'terminal_unavailable' }, 'An expired snapshot cannot authorize changed inputDigest.');
    await mutateQueue(threadId, 'terminal-queue', 1, 'remove', headers);
    await removeStashedDraft(threadId, 'terminal-stash', headers);
    assert.equal((await resolve(accepted.input)).status, 404, 'Removing explicit saved captures also removes their private proof.');
  } finally {
    await fetch(`${origin}/api/inspector/terminals/${terminal.id}`, { method: 'DELETE' });
    await detach(client.socket);
  }
});
