import { git, prepareWorktree } from './git.ts';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authorizeDelivery } from './authority.ts';
import { deliveryStore, resolveChatExecutionScope } from './binding.ts';
import { closeStore } from '../durable/store.ts';
import type { TaskCodeDelivery } from '../../../../../packages/contracts/src/task-code-delivery.ts';
import type { ThreadMetadata } from '../durable/threads.ts';

let root = ''; const originalFetch = globalThis.fetch; const originalDir = process.env.AGENT_WORKSPACE_DATA_DIR;
const scope = { workspaceId: '11111111-1111-4111-8111-111111111111', projectId: 'PRJ-001', taskId: 'TASK-001' };
let allow = true, project = 'PRJ-001', archived = false, denyRead = false;
const seen: Headers[] = [];
before(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pm-delivery-auth-')));
  process.env.AGENT_WORKSPACE_DATA_DIR = root;
  globalThis.fetch = async (input, init) => {
    seen.push(new Headers(init?.headers));
    const url = String(input);
    if (url.includes('/core/files/')) return denyRead ? new Response('', { status: 403 }) : Response.json({ id: scope.taskId, revision: 'rev', entity: { entity: 'work_item', project, title: 'Task', body: 'Body', archived } });
    if (url.includes('/agent-capabilities')) return Response.json({ scope: { kind: 'projects', projectIds: ['PRJ-001'] }, tools: [{ name: 'pm_update_task', description: 'update', write: true, capabilities: ['planning.edit'], allowed: allow, denyReason: allow ? null : 'no permission' }] });
    if (url.includes('/agent-contexts/resolve')) return Response.json({ scope: { workspaceId: scope.workspaceId, projectId: scope.projectId }, workspaceName: 'Workspace', projectName: 'Project', path: root });
    throw new Error('unexpected endpoint');
  };
});
after(async () => { globalThis.fetch = originalFetch; closeStore(); if (originalDir === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = originalDir; await rm(root, { recursive: true, force: true }); });
test('authority checks current task scope, archived state and write capability; only request auth headers forwarded', async () => {
  assert.equal((await authorizeDelivery(scope, true, new Headers({ cookie: 'test-session', 'x-injected-actor': 'admin' }))).root, root);
  assert.ok(seen.every(h => !h.has('x-injected-actor')));
  allow = false; await assert.rejects(authorizeDelivery(scope, true), /planning.edit/); assert.ok(await authorizeDelivery(scope, false)); allow = true;
  project = 'PRJ-002'; await assert.rejects(authorizeDelivery(scope, false), /不属于/); project = 'PRJ-001';
  archived = true; await assert.rejects(authorizeDelivery(scope, false), /归档/); archived = false;
  denyRead = true; await assert.rejects(authorizeDelivery(scope, false), /不可访问/); denyRead = false;
});
test('server records persist across restart, enforce CAS and task uniqueness; forged custom cannot redirect Chat cwd', async () => {
  const record: TaskCodeDelivery = { ...scope, id: 'delivery', baseBranch: 'main', taskRevision: 'rev', title: 'Task', description: '', createdAt: 'now', updatedAt: 'now', step: 'preparing', version: 1, threadId: 'bound-thread', pending: { action: 'prepare', at: 'now' } };
  deliveryStore.save(record); closeStore(); assert.equal(deliveryStore.read('delivery')?.pending?.action, 'prepare');
  assert.throws(() => deliveryStore.save(record), /记录已变化/);
  assert.throws(() => deliveryStore.save({ ...record, id: 'another' }), /记录已变化/);
  const thread = { remoteId: 'ordinary-thread', scope, custom: { cwd: '/forged', deliveryId: 'delivery' } } as unknown as ThreadMetadata;
  assert.equal((await resolveChatExecutionScope(thread)).path, root);
  assert.equal((await resolveChatExecutionScope({ ...thread, custom: { worktreeWriteConfirmed: true } })).worktreeWriteConfirmed, undefined);
  await assert.rejects(resolveChatExecutionScope({ ...thread, remoteId: 'bound-thread' }), /归属或执行阶段/);
});

test('bound execution and Inspector use only the owned worktree, and publication/changed context blocks execution', async () => {
  await git(root, 'init', '-b', 'main'); await git(root, 'config', 'user.name', 'Test'); await git(root, 'config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(root, 'fixture.txt'), 'fixture'); await git(root, 'add', 'fixture.txt'); await git(root, 'commit', '-m', 'fixture'); await git(root, 'remote', 'add', 'origin', 'https://github.com/example/test.git');
  const record = deliveryStore.read('delivery')!;
  record.git = await prepareWorktree(record, root, 'main', (cwd, ...args) => args[0] === 'fetch' ? git(cwd, '-c', 'protocol.file.allow=always', 'fetch', '--no-tags', root, 'refs/heads/main') : git(cwd, ...args));
  record.step = 'developing'; delete record.pending; record.version++; deliveryStore.save(record);
  const thread = { remoteId: record.threadId, scope, pmContext: { taskId: scope.taskId, entityId: null } } as unknown as ThreadMetadata;
  assert.equal((await resolveChatExecutionScope(thread)).path, record.git.directory);
  assert.equal((await resolveChatExecutionScope(thread, undefined, 'inspect')).path, record.git.directory);
  await assert.rejects(resolveChatExecutionScope({ ...thread, pmContext: { taskId: 'TASK-999', entityId: null } }), /归属/);
  assert.equal((await resolveChatExecutionScope(thread)).worktreeWriteConfirmed, undefined);
  record.worktreeWriteConfirmed = true; record.version++; deliveryStore.save(record);
  assert.equal((await resolveChatExecutionScope(thread)).worktreeWriteConfirmed, true);
  assert.equal((await resolveChatExecutionScope(thread, undefined, 'inspect')).worktreeWriteConfirmed, undefined);
  allow = false; await assert.rejects(resolveChatExecutionScope(thread), /planning.edit/); allow = true;
  record.pending = { action: 'commit', at: 'now' }; record.version++; deliveryStore.save(record);
  await assert.rejects(resolveChatExecutionScope(thread), /执行阶段/);
  assert.equal((await resolveChatExecutionScope(thread, undefined, 'inspect')).path, record.git.directory);
});
