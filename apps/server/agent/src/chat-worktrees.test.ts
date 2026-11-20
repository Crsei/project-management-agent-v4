import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { chatOnlyExecutionSelection } from '@agent-workspace/contracts/chat';
import { openAgentWorkspace } from './agent-workspaces.ts';
import { chatRoutes } from './chat.ts';
import { createChatWorktree, getChatWorktreeState, readChatWorktree, removeChatWorktree } from './chat-worktrees.ts';
import { resolveAgentExecution } from './durable/agent-execution.ts';
import { chatOnlyEnvironment } from './durable/execution.testkit.ts';
import { withThreadExecution } from './durable/engine.ts';
import { closeStore, deleteRecord, writeRecord } from './durable/store.ts';
import { beginThreadDeletion } from './durable/thread-lifecycle.ts';
import { ensureThread, getThread, type ThreadMetadata } from './durable/threads.ts';
import { inventoryPersistence, namespacePolicy } from './durable/persistence-schema.ts';
import { getDatabase } from './durable/store.ts';
import { resolveChatExecutionScope } from './task-delivery/binding.ts';
import { terminalRoutes, assertSessionTerminalsIdle, stopTerminals, terminateSessionTerminals } from './inspector/terminal.ts';
import { git } from './task-delivery/git.ts';

const app = new Hono().route('/api', chatRoutes);
const keys = ['AGENT_WORKSPACE_DATA_DIR', 'AGENT_WORKSPACE_ALLOWED_ROOTS', 'PM_API_URL', 'AGENT_WORKSPACE_ACCESS_TOKEN', 'AGENT_WORKSPACE_TERMINAL_SHELL'] as const;
let previous: Record<string, string | undefined>;
let directory: string, root: string;
let originalFetch: typeof fetch;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(tmpdir(), 'chat-worktrees-')));
  root = path.join(directory, 'repo');
  await mkdir(root);
  previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.AGENT_WORKSPACE_DATA_DIR = path.join(directory, 'store');
  process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = JSON.stringify([directory]);
  process.env.PM_API_URL = 'http://127.0.0.1:1';
  originalFetch = globalThis.fetch;
  delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
  process.env.AGENT_WORKSPACE_TERMINAL_SHELL = '/bin/sh';
  globalThis.fetch = async () => { throw new Error('Chat worktrees must not access the network.'); };
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.name', 'Chat Test');
  await git(root, 'config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(root, 'base.txt'), 'base\n');
  await git(root, 'add', 'base.txt');
  await git(root, 'commit', '-m', 'base');
});
afterEach(async () => {
  closeStore();
  globalThis.fetch = originalFetch;
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  await rm(directory, { recursive: true, force: true });
});
async function session(id = 'chat-session', workspacePath = root, frozen = false): Promise<ThreadMetadata> {
  const workspace = openAgentWorkspace({ path: workspacePath });
  const selection = { version: 2 as const, agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision };
  const snapshot = await resolveAgentExecution(selection, id);
  snapshot.environment.frozen = frozen;
  ensureThread(id, undefined, selection, snapshot.environment);
  if (frozen) writeRecord('chat:threads', id, { ...getThread(id)!, executionPath: snapshot.path });
  return getThread(id)!;
}
const code = (expected: string) => (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === expected;
const current = (id = 'chat-session') => getThread(id)!;

test('create pins local HEAD, keeps dirty source untouched, disables hooks and durably redirects execution', async () => {
  const thread = await session();
  const hookDirectory = path.join(root, 'hooks');
  await mkdir(hookDirectory);
  const marker = path.join(directory, 'hook-ran');
  await writeFile(path.join(hookDirectory, 'post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`);
  await chmod(path.join(hookDirectory, 'post-checkout'), 0o700);
  await git(root, 'config', 'core.hooksPath', hookDirectory);
  await writeFile(path.join(root, 'base.txt'), 'user dirty\n');
  const beforeHead = (await git(root, 'rev-parse', 'HEAD')).trim();
  const state = await createChatWorktree(thread, { revision: thread.revision, lifecycleRevision: 0 });
  assert.ok(state.worktree);
  const receipt = state.worktree;
  assert.equal(receipt.directory, path.join(directory, 'store', 'chat-worktrees', thread.remoteId));
  assert.match(receipt.branch, /^chat\/[a-f0-9]{16}$/);
  assert.equal(receipt.baseSha, beforeHead);
  assert.equal(await readFile(path.join(receipt.directory, 'base.txt'), 'utf8'), 'base\n');
  assert.equal(await readFile(path.join(root, 'base.txt'), 'utf8'), 'user dirty\n');
  assert.equal((await git(root, 'branch', '--show-current')).trim(), 'main');
  assert.equal((await git(root, 'rev-parse', 'HEAD')).trim(), beforeHead);
  await assert.rejects(lstat(marker), { code: 'ENOENT' });
  assert.equal((await lstat(receipt.directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(path.dirname(receipt.directory))).mode & 0o777, 0o700);
  const snapshot = await resolveChatExecutionScope(current());
  assert.equal(snapshot.path, receipt.directory);
  assert.equal(snapshot.environment.sourcePath, root);
  assert.deepEqual(snapshot.environment.worktree, { deliveryId: null, branch: receipt.branch });
  assert.equal(snapshot.worktreeWriteConfirmed, undefined, 'Chat must not inherit delivery approval grants');
  assert.equal(namespacePolicy('chat-worktrees-v1')?.owner, 'workspace');
  assert.deepEqual(inventoryPersistence(getDatabase()).blockers, []);
  closeStore();
  assert.equal(readChatWorktree(thread.remoteId)?.identity, receipt.identity);
  const revision = current().revision;
  assert.equal((await getChatWorktreeState(current())).worktree?.clean, true);
  assert.equal(current().revision, revision, 'GET never changes revision');
});

test('explicit idle transitions preserve freeze/source identity and clear native resume; clean descendant commits survive removal', async () => {
  const thread = await session('chat-session', root, true);
  writeRecord('chat:threads', thread.remoteId, { ...thread, nativeSession: { provider: 'codex', sessionId: 'old' } });
  const created = await createChatWorktree(current());
  const worktree = created.worktree!;
  assert.equal(current().executionEnvironment?.frozen, true);
  assert.equal(current().nativeSession, undefined);
  assert.equal(current().executionPath, worktree.directory);
  await writeFile(path.join(worktree.directory, 'committed.txt'), 'keep this commit\n');
  await git(worktree.directory, 'add', 'committed.txt');
  await git(worktree.directory, 'commit', '-m', 'chat work');
  const head = (await git(worktree.directory, 'rev-parse', 'HEAD')).trim();
  assert.equal((await resolveChatExecutionScope(current())).path, worktree.directory);
  assert.equal((await getChatWorktreeState(current())).worktree?.headSha, head);
  const removed = await removeChatWorktree(current());
  assert.equal(removed.worktree, null);
  assert.equal(removed.retainedBranch, worktree.branch);
  assert.equal((await git(root, 'rev-parse', worktree.branch)).trim(), head);
  assert.equal(readChatWorktree(thread.remoteId), null);
  await assert.rejects(lstat(worktree.directory), { code: 'ENOENT' });
  assert.equal(current().executionEnvironment?.frozen, true);
  assert.equal(current().executionEnvironment?.sourcePath, root);
  assert.equal(current().executionPath, root);
  assert.equal((await resolveChatExecutionScope(current())).path, root);
  await assert.rejects(createChatWorktree(current()), code('worktree_branch_exists'));
});

test('tracked, untracked and ignored user bytes block cleanup; failed Git removal retains receipt', async () => {
  const created = await createChatWorktree(await session());
  const worktree = created.worktree!;
  await writeFile(path.join(worktree.directory, 'base.txt'), 'dirty\n');
  await assert.rejects(removeChatWorktree(current()), code('worktree_dirty'));
  assert.ok(readChatWorktree(current().remoteId));
  await git(worktree.directory, 'restore', '--', 'base.txt');
  await writeFile(path.join(worktree.directory, 'new.txt'), 'untracked');
  assert.equal((await getChatWorktreeState(current())).worktree?.clean, false);
  await assert.rejects(removeChatWorktree(current()), code('worktree_dirty'));
  await rm(path.join(worktree.directory, 'new.txt'));
  await writeFile(path.join(root, '.git', 'info', 'exclude'), 'ignored.txt\n');
  await writeFile(path.join(worktree.directory, 'ignored.txt'), 'ignored user bytes');
  await assert.rejects(removeChatWorktree(current()), code('worktree_dirty'));
  await rm(path.join(worktree.directory, 'ignored.txt'));
  await git(root, 'worktree', 'lock', worktree.directory);
  await assert.rejects(removeChatWorktree(current()), code('worktree_remove_failed'));
  assert.ok(readChatWorktree(current().remoteId));
  assert.equal(readChatWorktree(current().remoteId)?.state, 'active', 'failed removal releases its transition state');
  assert.equal(current().executionEnvironment?.worktree?.branch, worktree.branch);
  await git(root, 'worktree', 'unlock', worktree.directory);
  await removeChatWorktree(current());
});

test('replaced paths, detached HEAD, changed branch and missing ownership fail closed without source fallback', async () => {
  const created = await createChatWorktree(await session());
  const value = created.worktree!;
  await git(value.directory, 'checkout', '--detach', 'HEAD');
  await assert.rejects(resolveChatExecutionScope(current()), code('worktree_changed'));
  await git(value.directory, 'checkout', value.branch);
  await git(value.directory, 'checkout', '-b', 'other-branch');
  await assert.rejects(removeChatWorktree(current()), code('worktree_changed'));
  await git(value.directory, 'checkout', value.branch);
  const moved = `${value.directory}-original`;
  await rename(value.directory, moved);
  await mkdir(value.directory, { mode: 0o700 });
  await assert.rejects(resolveChatExecutionScope(current()), code('worktree_changed'));
  await rm(value.directory, { recursive: true });
  await symlink(moved, value.directory);
  await assert.rejects(getChatWorktreeState(current()), code('worktree_changed'));
  await rm(value.directory);
  await rename(moved, value.directory);
  deleteRecord('chat-worktrees-v1', current().remoteId);
  await assert.rejects(resolveChatExecutionScope(current()), code('worktree_changed'));
  await assert.rejects(getChatWorktreeState(current()), code('worktree_changed'));
  writeRecord('chat-worktrees-v1', value.threadId, {
    threadId: value.threadId, agentWorkspaceId: value.agentWorkspaceId, agentWorkspaceRevision: value.agentWorkspaceRevision,
    root: value.root, directory: value.directory, branch: value.branch, baseSha: value.baseSha, identity: value.identity, createdAt: value.createdAt, state: 'active',
  });
  await removeChatWorktree(current());
});

test('chat-only, non-root, empty/non-Git and delivery-managed Sessions cannot create worktrees', async () => {
  ensureThread('chat-only', undefined, chatOnlyExecutionSelection(), chatOnlyEnvironment());
  await assert.rejects(createChatWorktree(current('chat-only')), code('worktree_workspace_required'));
  await mkdir(path.join(root, 'subdirectory'));
  await assert.rejects(createChatWorktree(await session('nested', path.join(root, 'subdirectory'))), code('repository_root_required'));
  const ordinary = path.join(directory, 'ordinary');
  await mkdir(ordinary);
  await assert.rejects(createChatWorktree(await session('ordinary', ordinary)), code('repository_root_required'));
  const empty = path.join(directory, 'empty');
  await mkdir(empty);
  await git(empty, 'init', '-b', 'main');
  await assert.rejects(createChatWorktree(await session('empty', empty)), code('repository_head_required'));
  const managed = await session('managed');
  writeRecord('task-code-delivery-v1', 'delivery', { threadId: managed.remoteId });
  await assert.rejects(createChatWorktree(managed), code('delivery_worktree_conflict'));
  await assert.rejects(createChatWorktree(await session('unsafe/id')), code('invalid_worktree_thread_id'));
});

test('unsafe parent paths, existing directories and branch collisions are never overwritten', async () => {
  const thread = await session();
  const elsewhere = path.join(directory, 'elsewhere');
  await mkdir(elsewhere, { mode: 0o700 });
  await symlink(elsewhere, path.join(directory, 'store', 'chat-worktrees'));
  await assert.rejects(createChatWorktree(thread), code('unsafe_worktree_directory'));
  await rm(path.join(directory, 'store', 'chat-worktrees'));
  const existing = path.join(directory, 'store', 'chat-worktrees', thread.remoteId);
  await mkdir(existing, { recursive: true, mode: 0o700 });
  await writeFile(path.join(existing, 'keep.txt'), 'keep');
  await assert.rejects(createChatWorktree(current()), code('worktree_create_failed'));
  assert.equal(await readFile(path.join(existing, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(readChatWorktree(thread.remoteId), null);
});

test('queued/running execution, queued native drafts, pending forks, archived state and stale revisions reject transitions', async () => {
  const thread = await session();
  await assert.rejects(createChatWorktree(thread, { revision: thread.revision + 1 }), code('worktree_conflict'));
  for (const status of ['queued', 'running']) {
    writeRecord('chat:generations', 'generation', { id: 'generation', threadId: thread.remoteId, status });
    await assert.rejects(createChatWorktree(current()), code('chat_busy'));
  }
  deleteRecord('chat:generations', 'generation');
  writeRecord('chat:message-queue', 'draft', { threadId: thread.remoteId, status: 'queued' });
  await assert.rejects(createChatWorktree(current()), code('chat_busy'));
  deleteRecord('chat:message-queue', 'draft');
  writeRecord('chat:threads', thread.remoteId, { ...current(), pendingFork: { sourceSessionId: 'source' } });
  await assert.rejects(createChatWorktree(current()), code('pending_native_fork'));
  writeRecord('chat:threads', thread.remoteId, { ...current(), pendingFork: undefined, status: 'archived' });
  await assert.rejects(createChatWorktree(current()), code('thread_archived'));
});

test('API confirmation, execution status, archive and lifecycle deletion preserve the worktree receipt', async () => {
  const thread = await session();
  const response = await app.request(`/api/chat/threads/${thread.remoteId}/worktree`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: thread.revision, lifecycleRevision: 0 }) });
  assert.equal(response.status, 200);
  const created = await response.json();
  assert.ok(created.worktree.branch);
  const status = await app.request(`/api/chat/threads/${thread.remoteId}/worktree`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).worktree.directory, created.worktree.directory);
  const noConfirmation = await app.request(`/api/chat/threads/${thread.remoteId}/worktree`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noConfirmation.status, 400);
  const archive = await app.request(`/api/chat/threads/${thread.remoteId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'archived', lifecycleRevision: 0 }) });
  assert.equal(archive.status, 409);
  assert.equal((await archive.json()).code, 'worktree_active');
  assert.throws(() => beginThreadDeletion(thread.remoteId, 'delete-with-worktree', { confirm: true, lifecycleRevision: 0, expectedGenerationId: null, stopActive: false }, null), code('worktree_active'));
  assert.equal(current().deletionState, undefined);
  const removed = await app.request(`/api/chat/threads/${thread.remoteId}/worktree`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).worktree, null);
});

test('transition barrier rejects concurrent deletion, execution and duplicate mutation; stale edits cannot be overwritten', async () => {
  const thread = await session();
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const held = withThreadExecution(thread.remoteId, async () => { started.resolve(); await gate.promise; });
  await started.promise;
  const pending = createChatWorktree(thread);
  await assert.rejects(createChatWorktree(thread), code('worktree_busy'));
  await assert.rejects(resolveChatExecutionScope(thread), code('worktree_busy'));
  assert.throws(() => beginThreadDeletion(thread.remoteId, 'racing-delete', { confirm: true, lifecycleRevision: 0, expectedGenerationId: null, stopActive: false }, null), code('worktree_active'));
  writeRecord('chat:threads', thread.remoteId, { ...thread, revision: thread.revision + 1, title: 'Concurrent edit' });
  gate.resolve();
  await held;
  await assert.rejects(pending, code('worktree_conflict'));
  assert.equal(current().title, 'Concurrent edit');
  assert.equal(readChatWorktree(thread.remoteId), null);
});

test('HEAD rewritten outside the original ancestry is rejected for execution and cleanup', async () => {
  const created = await createChatWorktree(await session());
  const value = created.worktree!;
  const unrelated = (await git(root, 'commit-tree', `${value.baseSha}^{tree}`, '-m', 'unrelated root')).trim();
  await git(root, 'update-ref', `refs/heads/${value.branch}`, unrelated, value.baseSha);
  await assert.rejects(resolveChatExecutionScope(current()), code('worktree_changed'));
  await assert.rejects(removeChatWorktree(current()), code('worktree_changed'));
  assert.equal(readChatWorktree(value.threadId)?.state, 'active');
  await git(root, 'update-ref', `refs/heads/${value.branch}`, value.baseSha, unrelated);
  await removeChatWorktree(current());
});

test('failed Git creation releases its unregistered empty allocation without deleting repository refs', async () => {
  const thread = await session();
  const branch = `chat/${createHash('sha256').update(thread.remoteId).digest('hex').slice(0, 16)}`;
  const branchDirectory = path.join(root, '.git', 'refs', 'heads', 'chat');
  await mkdir(branchDirectory);
  const lock = path.join(branchDirectory, `${branch.slice('chat/'.length)}.lock`);
  await writeFile(lock, 'held by another Git operation\n');
  const worktreeDirectory = path.join(directory, 'store', 'chat-worktrees', thread.remoteId);
  await assert.rejects(createChatWorktree(thread), code('worktree_create_failed'));
  assert.equal(readChatWorktree(thread.remoteId), null);
  await assert.rejects(lstat(worktreeDirectory), { code: 'ENOENT' });
  assert.equal(await readFile(lock, 'utf8'), 'held by another Git operation\n');
  assert.equal((await resolveChatExecutionScope(current())).path, root);
  assert.equal((await git(root, 'branch', '--show-current')).trim(), 'main');
  await rm(lock);
  const retried = await createChatWorktree(current());
  assert.equal(retried.worktree?.branch, branch);
  await removeChatWorktree(current());
});

test('DELETE recovers an already removed and unregistered directory while retaining its branch commits', async () => {
  const created = await createChatWorktree(await session('chat-session', root, true));
  const value = created.worktree!;
  await writeFile(path.join(value.directory, 'saved.txt'), 'retained commit\n');
  await git(value.directory, 'add', 'saved.txt');
  await git(value.directory, 'commit', '-m', 'retained chat work');
  const head = (await git(value.directory, 'rev-parse', 'HEAD')).trim();
  await git(root, 'worktree', 'remove', '--', value.directory);
  await assert.rejects(resolveChatExecutionScope(current()), code('worktree_changed'));
  const response = await app.request(`/api/chat/threads/${value.threadId}/worktree`, {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }),
  });
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.worktree, null);
  assert.equal(state.retainedBranch, value.branch);
  assert.equal(readChatWorktree(value.threadId), null);
  assert.equal(current().executionEnvironment?.frozen, true);
  assert.equal(current().executionPath, root);
  assert.equal((await resolveChatExecutionScope(current())).path, root);
  assert.equal((await git(root, 'rev-parse', value.branch)).trim(), head);
});

test('a missing directory still registered with Git is not treated as a completed removal', async () => {
  const created = await createChatWorktree(await session());
  const value = created.worktree!;
  const moved = `${value.directory}-moved`;
  await rename(value.directory, moved);
  await assert.rejects(removeChatWorktree(current()), code('worktree_changed'));
  assert.equal(readChatWorktree(value.threadId)?.state, 'active');
  assert.equal(current().executionEnvironment?.worktree?.branch, value.branch);
  await rename(moved, value.directory);
  await removeChatWorktree(current());
});

test('live Session terminals and workspace terminals inside a worktree block transitions without being killed', async () => {
  const thread = await session();
  const selection = thread.executionSelection!;
  const headers = { host: 'localhost', 'content-type': 'application/json' };
  const listed = await terminalRoutes.request(`http://localhost/terminals?${new URLSearchParams({
    agentWorkspaceId: selection.agentWorkspaceId!, agentWorkspaceRevision: String(selection.agentWorkspaceRevision),
  })}`, { headers });
  assert.equal(listed.status, 200);
  const { serviceId } = await listed.json();
  const createdTerminal = await terminalRoutes.request('http://localhost/terminals', { method: 'POST', headers, body: JSON.stringify({
    requestId: randomUUID(), expectedServiceId: serviceId, scope: 'session', threadId: thread.remoteId,
    agentWorkspaceId: selection.agentWorkspaceId, agentWorkspaceRevision: selection.agentWorkspaceRevision,
  }) });
  assert.equal(createdTerminal.status, 200, await createdTerminal.clone().text());
  try {
    assert.throws(() => assertSessionTerminalsIdle(thread.remoteId), code('terminal_active'));
    await assert.rejects(createChatWorktree(current()), code('terminal_active'));
    await terminateSessionTerminals(thread.remoteId);
    const state = await createChatWorktree(current());
    const value = state.worktree!;
    const workspace = openAgentWorkspace({ path: value.directory });
    const terminal = await terminalRoutes.request('http://localhost/terminals', { method: 'POST', headers, body: JSON.stringify({
      requestId: randomUUID(), expectedServiceId: serviceId, scope: 'workspace',
      agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision,
    }) });
    assert.equal(terminal.status, 200, await terminal.clone().text());
    const descriptor = (await terminal.json()).terminal;
    await assert.rejects(removeChatWorktree(current()), code('terminal_active'));
    assert.equal(readChatWorktree(thread.remoteId)?.state, 'active');
    const status = await terminalRoutes.request(`http://localhost/terminals/${descriptor.id}`, { headers });
    assert.equal((await status.json()).terminal.status, 'running', 'refusal must not terminate the PTY');
  } finally { await stopTerminals(); }
});
