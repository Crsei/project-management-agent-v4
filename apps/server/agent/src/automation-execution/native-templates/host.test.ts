import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { StudioExecutionRequest } from '../../../../../../packages/contracts/src/automation-studio.ts';
import type { AgentExecutionSnapshot } from '../../durable/agent-scope.ts';
import type { ChatGeneration } from '../../durable/chat-runtime.ts';
import { emitNativeOutput, initializeNativeOutput } from '../../durable/native-output.ts';
import { closeStore, listRecords, readRecord, writeRecord } from '../../durable/store.ts';
import { automationRequestFingerprint, registerAutomationNativeThread } from '../context.ts';
import { createNativeTemplateExecutionPort, nativeCommandEvidence } from './host.ts';
import { createNativeTemplateHttp, decodeNativeFeed, fetchNativePublicFeed, validatePublicFeedUrl } from './http.ts';
import { assertNativeTemplateChatSnapshot, prepareNativeRepository, readNativeRepositoryChanges, resolveNativeTemplateChatSnapshot, validateNativeRepositoryPath } from './repository.ts';
import { admitNativeOperation, createNativeTemplateState, finishNativeOperation, nativeDefinitionScope, nativeHash } from './state.ts';
import { openNativeTemplateScratchTools } from './workspace-tools.ts';
import { createProviderInstance } from '../../providers/instances.ts';

function fixture(): StudioExecutionRequest {
  return { executionId: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222', actorId: '33333333-3333-4333-8333-333333333333', workspaceId: '44444444-4444-4444-8444-444444444444', projectId: 'PRJ-001', definitionId: '55555555-5555-4555-8555-555555555555', definitionRevision: 1, config: { name: 'Native fixture', description: '', projectId: 'PRJ-001', tags: [], templateId: 'news-digest', action: { kind: 'template', templateId: 'news-digest', arguments: { feeds: 'https://news.ycombinator.com/rss', topics: '' }, repositories: [], plugins: [], providerInstanceId: 'fixture', model: 'fixture', options: {}, timeoutSeconds: 30 }, trigger: { kind: 'manual' }, dailyLimit: 2, cooldownMinutes: 0 }, trigger: 'test', payload: null, issuedAt: '2026-10-31T00:00:00.000Z' };
}
function repositoryFixture(): StudioExecutionRequest {
  const request = fixture();
  if (request.config.action.kind !== 'template') throw new Error('fixture');
  request.config.templateId = request.config.action.templateId = 'github-issue-to-pr';
  request.config.action.arguments = { repositories: ['owner/repo'], githubTokenSecret: 'GITHUB_TOKEN', triggerLabel: 'openhands', branchPrefix: 'openhands/issue', pullRequestMode: 'draft' };
  return request;
}
let directory: string;
const originalData = process.env.AGENT_WORKSPACE_DATA_DIR;
const originalServiceSecret = process.env.PM_AUTOMATION_SERVICE_SECRET;
const originalFetch = globalThis.fetch;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'native-template-host-')); process.env.AGENT_WORKSPACE_DATA_DIR = path.join(directory, 'store'); });
afterEach(async () => { closeStore(); globalThis.fetch = originalFetch; if (originalServiceSecret === undefined) delete process.env.PM_AUTOMATION_SERVICE_SECRET; else process.env.PM_AUTOMATION_SERVICE_SECRET = originalServiceSecret; if (originalData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = originalData; await rm(directory, { recursive: true, force: true }); });

test('CAS and claims survive restart, retain immutable revisions and reject lost updates', async () => {
  const request = fixture(), state = createNativeTemplateState(request);
  assert.equal(await state.read('seen'), null);
  assert.deepEqual(await state.compareAndSet('seen', null, { stories: ['one'] }), { revision: 1, value: { stories: ['one'] } });
  await assert.rejects(state.compareAndSet('seen', null, {}), { code: 'revision_conflict' });
  await assert.rejects(state.compareAndSet('seen', 2, {}), { code: 'revision_conflict' });
  assert.deepEqual(await state.compareAndSet('seen', 1, { stories: ['one', 'two'] }), { revision: 2, value: { stories: ['one', 'two'] } });
  assert.equal(await state.claim('delivery', { owner: request.executionId }), true);
  closeStore();
  const later = structuredClone(request); later.executionId = '66666666-6666-4666-8666-666666666666'; later.definitionRevision = 2;
  const restarted = createNativeTemplateState(later);
  assert.equal(await restarted.claim('delivery', { owner: later.executionId }), false);
  assert.equal((await restarted.read('seen'))?.revision, 2);
  const history = listRecords<{ revision: number; value: unknown }>(`pm-automation:native-state:${nativeDefinitionScope(request)}:history`);
  assert.deepEqual(history.filter(entry => entry.revision === 1)[0]?.value, { stories: ['one'] });
  for (const change of [{ actorId: '77777777-7777-4777-8777-777777777777' }, { workspaceId: '77777777-7777-4777-8777-777777777777' }, { projectId: 'PRJ-002' }, { definitionId: '77777777-7777-4777-8777-777777777777' }]) {
    assert.equal(await createNativeTemplateState({ ...request, ...change }).read('seen'), null);
  }
});

test('shared review claims coordinate definitions only within the same actor and connection revision', async () => {
  const request = fixture(); request.config.action.plugins = [{ id: 'integration:review-bot', version: '4' }];
  const second = structuredClone(request); second.definitionId = '66666666-6666-4666-8666-666666666666';
  const key = 'shared:review:github:owner/repo:3:head';
  assert.equal(await createNativeTemplateState(request).claim(key, { owner: 'first' }), true);
  assert.equal(await createNativeTemplateState(second).claim(key, { owner: 'second' }), false);
  second.config.action.plugins[0]!.version = '5';
  assert.equal(await createNativeTemplateState(second).claim(key, { owner: 'revised' }), true);
});

test('operation admission is persistent and never reclaims pending or uncertain external writes', () => {
  const request = fixture(), first = admitNativeOperation(request, 'github:merge:head', nativeHash({ sha: 'head' }));
  assert.equal(first.fresh, true);
  assert.equal(admitNativeOperation(request, 'github:merge:head', first.operation.fingerprint).fresh, false);
  assert.throws(() => admitNativeOperation(request, 'github:merge:head', nativeHash({ sha: 'different' })), /different input/);
  finishNativeOperation(first.operation, { phase: 'unknown', error: 'response lost' });
  finishNativeOperation(first.operation, { phase: 'completed', value: { fabricated: true } });
  closeStore();
  assert.equal(admitNativeOperation(request, 'github:merge:head', first.operation.fingerprint).operation.phase, 'unknown');
});

test('missing execution query and cancel never create a handler admission or a Chat', async () => {
  const port = createNativeTemplateExecutionPort(), request = fixture();
  assert.equal((await port.query(request)).status, 'outcome_unknown');
  assert.equal((await port.cancel(request)).status, 'outcome_unknown');
  assert.deepEqual(listRecords('pm-automation:native-template-executions'), []);
  assert.deepEqual(listRecords('chat:threads'), []);
});

test('invalid source arguments produce a persistent failure without network or a native turn', async () => {
  const request = fixture(); if (request.config.action.kind !== 'template') throw new Error('fixture'); request.config.action.arguments = { feeds: 12 };
  const port = createNativeTemplateExecutionPort();
  const result = await port.dispatch(request);
  assert.equal(result.status, 'failed');
  assert.deepEqual(await port.query(request), result);
  const changed = structuredClone(request); changed.config.description = 'another request';
  await assert.rejects(port.dispatch(changed), /different immutable request/);
  assert.deepEqual(listRecords('chat:threads'), []);
});

test('public feeds reject credentials, IP literals, private hostname classes and non-HTTPS before sockets', async () => {
  for (const input of ['http://feeds.example.net/rss', 'https://user:secret@feeds.example.net/rss', 'https://127.0.0.1/rss', 'https://[::1]/rss', 'https://feeds.example.net:444/rss', 'https://feeds.example.net/rss#fragment']) assert.throws(() => validatePublicFeedUrl(input));
  await assert.rejects(fetchNativePublicFeed('https://metadata.internal/rss'), /webhook_dns_denied/);
});

test('native repository paths reject traversal, git control directories, links-by-path and Windows escapes', () => {
  for (const input of ['../outside', '/absolute', 'a/../outside', 'a//file', '.git/config', 'src/.GiT/hooks', 'C:/file', 'a\\file']) assert.throws(() => validateNativeRepositoryPath(input));
  assert.deepEqual(validateNativeRepositoryPath('src/main.ts'), ['src', 'main.ts']);
});

test('trusted child cwd is a registered canonical descendant, never a caller path or an ordinary Chat override', async () => {
  const request = fixture(), root = path.join(directory, 'project'); await mkdir(root);
  const authorized: AgentExecutionSnapshot = { scope: { workspaceId: request.workspaceId, projectId: request.projectId }, workspaceName: 'Fixture', projectName: 'Fixture', path: root };
  const threadId = 'native-fixture-child', idempotencyKey = 'native-fixture-key';
  const binding = await prepareNativeRepository({ request, threadId, idempotencyKey, authorized, requestJson: async () => { throw new Error('No remote request expected'); }, signal: new AbortController().signal });
  assert.deepEqual(await resolveNativeTemplateChatSnapshot('unregistered', idempotencyKey, authorized), authorized);
  await assert.rejects(resolveNativeTemplateChatSnapshot(threadId, idempotencyKey, authorized), /active original/);
  writeRecord('pm-automation:executions', request.executionId, { request, fingerprint: automationRequestFingerprint(request), phase: 'running' });
  registerAutomationNativeThread(request, threadId, idempotencyKey);
  const childSnapshot = await resolveNativeTemplateChatSnapshot(threadId, idempotencyKey, authorized);
  assert.equal(childSnapshot.path, binding.executionPath);
  const generation = { threadId, request: { idempotencyKey }, executionSnapshot: childSnapshot } as ChatGeneration;
  await assertNativeTemplateChatSnapshot(generation, authorized);
  await assert.rejects(assertNativeTemplateChatSnapshot({ ...generation, threadId: 'ordinary' }, authorized), /directory changed/);
  await assert.rejects(assertNativeTemplateChatSnapshot(generation, { ...authorized, path: directory }), /currently authorized/);
  const old = binding.executionPath; await rm(old, { recursive: true }); await symlink(directory, old);
  await assert.rejects(assertNativeTemplateChatSnapshot(generation, authorized), /replaced|escaped/);
  assert.equal(readRecord<{ phase: string }>('pm-automation:executions', request.executionId)?.phase, 'running');
});

test('fixed-origin connector preserves API status and never replays a possibly accepted write', async () => {
  process.env.PM_AUTOMATION_SERVICE_SECRET = 'native-host-test-private-service-secret-32bytes';
  const calls: Array<Record<string, unknown>> = [];
  let revokedAfterSend = false;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/automations\/integrations\/runtime$/);
    assert.equal(init?.redirect, 'error');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>; calls.push(body);
    if (body.method === 'provider/request') {
      const params = body.params as Record<string, unknown>;
      if (params.method === 'POST') {
        if (revokedAfterSend) return Response.json({ error: { code: 'integration_connection_changed', message: 'Access changed after the original send' } }, { status: 409 });
        throw new Error('response lost after possible acceptance');
      }
      return Response.json({ status: 404, body: { message: 'not found' } });
    }
    return Response.json({ opened: true, revoked: true });
  };
  let authorizations = 0;
  const http = createNativeTemplateHttp(fixture(), async () => { authorizations += 1; }, new AbortController().signal);
  await assert.rejects(http.requestJson('github', '/repos/owner/repo/issues/1'), { status: 404 });
  await assert.rejects(http.requestJson('github', '/repos/owner/repo/issues/1/comments', { method: 'POST', body: { body: 'comment' }, operationKey: 'issue:1:comment' }), { code: 'outcome_unknown' });
  await assert.rejects(http.requestJson('github', '/repos/owner/repo/issues/1/comments', { method: 'POST', body: { body: 'comment' }, operationKey: 'issue:1:comment' }), { code: 'outcome_unknown' });
  revokedAfterSend = true;
  await assert.rejects(http.requestJson('github', '/repos/owner/repo/issues/1/comments', { method: 'POST', body: { body: 'second operation' }, operationKey: 'issue:1:revoked-after-send' }), { code: 'outcome_unknown' });
  await assert.rejects(http.requestJson('github', 'https://outside.invalid/repos/owner/repo'), /relative API path/);
  assert.equal(calls.filter(call => call.method === 'provider/request').length, 3);
  assert.equal(authorizations, 4);
  await http.close();
  assert.equal(calls.at(-1)?.method, 'grant/close');
});

test('published file evidence comes from the actual worktree versus its private pinned base', async () => {
  const request = repositoryFixture(), root = path.join(directory, 'artifacts'); await mkdir(root);
  const authorized: AgentExecutionSnapshot = { scope: { workspaceId: request.workspaceId, projectId: request.projectId }, workspaceName: 'Fixture', projectName: 'Fixture', path: root };
  const files = { 'keep.ts': 'original\n', 'delete.ts': 'original\n', '.gitignore': 'node_modules/\n', 'node_modules/tracked.ts': 'tracked\n' };
  const blobs = Object.entries(files).map(([filename, content]) => { const bytes = Buffer.from(content); return { filename, bytes, sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') }; });
  const commit = 'a'.repeat(40), tree = 'b'.repeat(40);
  const threadId = 'artifact-fixture', idempotencyKey = 'artifact-key';
  const binding = await prepareNativeRepository({ request, threadId, idempotencyKey, authorized, repository: { provider: 'github', repository: 'owner/repo', ref: commit, write: true }, signal: new AbortController().signal, requestJson: async <T>(_provider: 'github' | 'gitlab', apiPath: string): Promise<T> => {
    if (apiPath.includes('/commits/')) return { sha: commit, commit: { tree: { sha: tree } } } as T;
    if (apiPath.includes('/git/trees/')) return { truncated: false, tree: blobs.map(blob => ({ path: blob.filename, type: 'blob', mode: '100644', sha: blob.sha })) } as T;
    if (apiPath.includes('/git/blobs/')) { const blob = blobs.find(blob => apiPath.endsWith(blob.sha))!; return { content: blob.bytes.toString('base64'), encoding: 'base64', size: blob.bytes.length } as T; }
    throw new Error(`Unexpected fixture API ${apiPath}`);
  } });
  writeRecord('pm-automation:executions', request.executionId, { request, fingerprint: automationRequestFingerprint(request), phase: 'running' });
  registerAutomationNativeThread(request, threadId, idempotencyKey);
  assert.deepEqual(await readNativeRepositoryChanges(threadId, idempotencyKey, authorized), []);
  await chmod(path.join(binding.executionPath, 'keep.ts'), 0o700);
  assert.deepEqual(await readNativeRepositoryChanges(threadId, idempotencyKey, authorized), [{ path: 'keep.ts', content: 'original\n', mode: '100755' }]);
  await chmod(path.join(binding.executionPath, 'keep.ts'), 0o4755);
  await assert.rejects(readNativeRepositoryChanges(threadId, idempotencyKey, authorized), /safe permissions/);
  await chmod(path.join(binding.executionPath, 'keep.ts'), 0o600);
  await writeFile(path.join(binding.executionPath, 'keep.ts'), 'changed\n');
  await unlink(path.join(binding.executionPath, 'delete.ts'));
  await writeFile(path.join(binding.executionPath, 'new.ts'), 'new file\n');
  // A normal umask 0002 file remains private behind the verified 0700 snapshot ancestry.
  await chmod(path.join(binding.executionPath, 'new.ts'), 0o664);
  await chmod(binding.executionPath, 0o770);
  await assert.rejects(readNativeRepositoryChanges(threadId, idempotencyKey, authorized), /private path/);
  await chmod(binding.executionPath, 0o700);
  await chmod(path.join(binding.executionPath, 'new.ts'), 0o666);
  await assert.rejects(readNativeRepositoryChanges(threadId, idempotencyKey, authorized), /safe permissions/);
  await chmod(path.join(binding.executionPath, 'new.ts'), 0o664);
  await writeFile(path.join(binding.executionPath, 'new.bin'), Buffer.from([0xff, 0x00]));
  await writeFile(path.join(binding.executionPath, '.gitignore'), '*\n');
  await writeFile(path.join(binding.executionPath, 'node_modules/tracked.ts'), 'tracked change\n');
  await symlink(root, path.join(binding.executionPath, 'node_modules/ignored-escape'));
  assert.deepEqual(await readNativeRepositoryChanges(threadId, idempotencyKey, authorized), [{ path: '.gitignore', content: '*\n' }, { path: 'delete.ts', content: null }, { path: 'keep.ts', content: 'changed\n' }, { path: 'new.bin', content: '/wA=', encoding: 'base64' }, { path: 'new.ts', content: 'new file\n' }, { path: 'node_modules/tracked.ts', content: 'tracked change\n' }]);
  await symlink(root, path.join(binding.executionPath, 'escape'));
  await assert.rejects(readNativeRepositoryChanges(threadId, idempotencyKey, authorized), /unsafe links/);
});

test('command receipts exclude assistant test claims and retain observed native exit status', () => {
  initializeNativeOutput('native-host-receipts', 'native-host-thread', 'running');
  emitNativeOutput('native-host-receipts', { type: 'item.upsert', item: { id: 'assistant', type: 'assistant_message', status: 'completed', text: 'All tests passed' } });
  emitNativeOutput('native-host-receipts', { type: 'item.upsert', item: { id: 'command', type: 'command_execution', status: 'failed', title: 'npm test', output: 'assertion failed', exitCode: 1 } });
  assert.deepEqual(nativeCommandEvidence('native-host-receipts'), [{ itemId: 'command', status: 'failed', title: 'npm test', output: 'assertion failed', exitCode: 1, outputTruncated: false }]);
});

test('feed decoder honors byte encoding instead of corrupting non-UTF8 RSS', () => {
  assert.match(decodeNativeFeed(Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><rss>caf\xe9</rss>', 'latin1'), 'application/xml'), /café/);
  assert.match(decodeNativeFeed(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<?xml version="1.0"?><rss>雪</rss>', 'utf16le')]), 'application/rss+xml'), /雪/);
  assert.throws(() => decodeNativeFeed(Buffer.from('<?xml version="1.0" encoding="not-an-encoding"?><rss/>'), 'application/xml'), /unsupported/);
});

test('scratch bridge writes actual files only with the live original generation and rejects path escape', async () => {
  process.env.PM_AUTOMATION_SERVICE_SECRET = 'native-host-test-private-service-secret-32bytes';
  const provider = createProviderInstance({ instanceId: 'fixture', driver: 'codex', config: { setupMode: 'managed' } });
  const request = repositoryFixture(), root = path.join(directory, 'scratch'); await mkdir(root);
  const authorized: AgentExecutionSnapshot = { scope: { workspaceId: request.workspaceId, projectId: request.projectId }, workspaceName: 'Fixture', projectName: 'Fixture', path: root };
  const threadId = 'scratch-fixture', idempotencyKey = 'scratch-key', generationId = '88888888-8888-4888-8888-888888888888', commit = 'a'.repeat(40);
  const binding = await prepareNativeRepository({ request, threadId, idempotencyKey, authorized, repository: { provider: 'github', repository: 'owner/repo', ref: commit, write: true }, signal: new AbortController().signal, requestJson: async <T>(_provider: 'github' | 'gitlab', apiPath: string): Promise<T> => apiPath.includes('/commits/') ? { sha: commit, commit: { tree: { sha: commit } } } as T : { truncated: false, tree: [] } as T });
  writeRecord('pm-automation:executions', request.executionId, { request, fingerprint: automationRequestFingerprint(request), phase: 'running' });
  registerAutomationNativeThread(request, threadId, idempotencyKey);
  const generation = { id: generationId, threadId, status: 'running', providerInstanceId: provider.instanceId, request: { idempotencyKey }, executionSnapshot: { ...authorized, path: binding.executionPath } } as ChatGeneration;
  writeRecord('chat:generations', generationId, generation);
  globalThis.fetch = async (url, init) => String(url).includes('/agent-contexts/resolve') ? Response.json(authorized) : originalFetch(url, init);
  const bridge = await openNativeTemplateScratchTools(generation, undefined, async () => {});
  try {
    const descriptor = bridge.mcpServers?.[0]; assert.ok(descriptor);
    const filename = descriptor.args.at(-1)!;
    const grant = JSON.parse(await readFile(filename, 'utf8')) as { url: string; token: string };
    const post = (operationId: string, filename: string) => originalFetch(grant.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${grant.token}` }, body: JSON.stringify({ method: 'tools/call', params: { operationId, name: 'automation_workspace_write', arguments: { path: filename, content: 'actual file\\n' } } }) });
    assert.equal((await post('99999999-9999-4999-8999-999999999999', 'src/new.ts')).status, 200);
    assert.equal(await readFile(path.join(binding.executionPath, 'src/new.ts'), 'utf8'), 'actual file\\n');
    assert.deepEqual(await readNativeRepositoryChanges(threadId, idempotencyKey, authorized), [{ path: 'src/new.ts', content: 'actual file\\n' }]);
    assert.equal((await post('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '../escape')).status, 400);
    writeRecord('chat:generations', generationId, { ...generation, status: 'completed' });
    assert.equal((await post('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'must-not-exist.ts')).status, 400);
  } finally { await bridge.close(); }
});

test('read-only stages prove the actual snapshot remained unchanged instead of assuming an empty delta', async () => {
  const request = repositoryFixture(), root = path.join(directory, 'readonly'); await mkdir(root);
  const authorized: AgentExecutionSnapshot = { scope: { workspaceId: request.workspaceId, projectId: request.projectId }, workspaceName: 'Fixture', projectName: 'Fixture', path: root };
  const threadId = 'readonly-fixture', idempotencyKey = 'readonly-key', commit = 'a'.repeat(40);
  const binding = await prepareNativeRepository({ request, threadId, idempotencyKey, authorized, repository: { provider: 'github', repository: 'owner/repo', ref: commit, write: false }, signal: new AbortController().signal, requestJson: async <T>(_provider: 'github' | 'gitlab', apiPath: string): Promise<T> => apiPath.includes('/commits/') ? { sha: commit, commit: { tree: { sha: commit } } } as T : { truncated: false, tree: [] } as T });
  writeRecord('pm-automation:executions', request.executionId, { request, fingerprint: automationRequestFingerprint(request), phase: 'running' });
  registerAutomationNativeThread(request, threadId, idempotencyKey);
  assert.deepEqual(await readNativeRepositoryChanges(threadId, idempotencyKey, authorized), []);
  await writeFile(path.join(binding.executionPath, 'unapproved.ts'), 'unexpected edit\n');
  await assert.rejects(readNativeRepositoryChanges(threadId, idempotencyKey, authorized), /read-only native repository stage changed/);
});
