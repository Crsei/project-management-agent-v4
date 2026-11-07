import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { applySessionCutover, inventorySessionCutover, withOfflineSessionCutover } from './session-cutover.ts';

function database(filename = ':memory:') {
  const db = new DatabaseSync(filename);
  db.exec('CREATE TABLE records(namespace TEXT,key TEXT,value TEXT,PRIMARY KEY(namespace,key)); CREATE TABLE run_events(run_id TEXT,seq INTEGER,event TEXT); CREATE TABLE worker_owner(singleton INTEGER PRIMARY KEY,pid INTEGER,token TEXT)');
  return db;
}
function put(db: DatabaseSync, namespace: string, key: string, value: unknown) { db.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?)').run(namespace, key, JSON.stringify(value)); }
function get(db: DatabaseSync, namespace: string, key: string) { const row = db.prepare('SELECT value FROM records WHERE namespace=? AND key=?').get(namespace, key); return row ? JSON.parse(String(row.value)) : null; }
const selection = { version: 2, agentWorkspaceId: null, agentWorkspaceRevision: null };

test('explicit cutover deletes only old Session payload and preserves business evidence, unusable refs, assets and current Sessions', () => {
  const db = database();
  try {
    for (const id of ['old-chat', 'old-business']) put(db, 'chat:threads', id, { remoteId: id, scope: { workspaceId: 'workspace', projectId: 'project' }, nativeSession: { sessionId: 'native-cli-history-not-owned' } });
    put(db, 'chat:threads', 'new-chat', { remoteId: 'new-chat', executionSelection: selection });
    for (const [id, threadId] of [['plain-generation', 'old-chat'], ['business-generation', 'old-business'], ['earlier-business-generation', 'old-business']]) {
      put(db, 'chat:generations', id!, { id, threadId, status: 'completed', request: { messages: [{ text: 'private-conversation-body' }] } });
      put(db, 'native-output', id!, { generationId: id, threadId, items: [{ attachmentId: `${id}-asset` }] });
      put(db, 'chat:events', `${id}:000000000001`, { generationId: id, seq: 1, chunk: { text: 'private-event-body' } });
      put(db, 'mcp-app-producing-items-v1', JSON.stringify([threadId, id]), { generationId: id });
      put(db, 'mcp-app-private-assets-v1', `${id}-asset`, { threadId, reference: { attachmentId: `${id}-asset` }, size: 10, sha256: 'registered-sha256' });
    }
    put(db, 'task-code-delivery-v1', 'business-delivery', { id: 'business-delivery', threadId: 'old-business', git: { root: '/preserved-source', worktreePath: '/preserved-worktree' }, testResult: { output: 'preserved-test-evidence' } });
    put(db, 'chat:history', 'old-history', { threadId: 'old-chat', messages: [{ text: 'private-conversation-body' }] });
    put(db, 'durable:workspaces', 'old-chat', { documents: [{ content: 'private-session-resource' }] });
    put(db, 'mcp-app-model-context-v1', 'app-context', { threadId: 'old-chat', text: 'private-app-context' });
    put(db, 'mcp:grants', 'grant', { threadIds: ['old-chat', 'old-business', 'new-chat'], actorId: 'actor' });
    put(db, 'mcp:tool-receipts', 'launch-operation', { fingerprint: 'immutable-operation-fingerprint', status: 'completed', result: { thread: { remoteId: 'old-chat' } } });
    // A deliberately non-JSON credential value proves its namespace is counted, never decoded.
    db.prepare('INSERT INTO records VALUES(?,?,?)').run('mcp:tokens', 'opaque-fixture-key', 'credential-namespace-must-not-be-read');
    put(db, 'settings:chat-defaults', 'default', { revision: 2, selection: { providerInstanceId: 'existing-provider' } });
    const plan = inventorySessionCutover(db, '/explicit/application-data');
    assert.deepEqual(plan.candidateIds, ['old-business', 'old-chat']);
    assert.deepEqual(plan.retainedGenerationIds, ['business-generation', 'earlier-business-generation']);
    assert.equal(plan.blockers.length, 0); assert.equal(plan.unclassifiedNamespaces.length, 0);
    assert.ok(!JSON.stringify(plan).includes('private-conversation-body'));
    assert.ok(plan.retainedAttachmentIds.includes('plain-generation-asset'));
    applySessionCutover(db, plan, plan.dataDirectory);
    assert.equal(get(db, 'chat:generations', 'plain-generation'), null);
    assert.equal(get(db, 'mcp-app-producing-items-v1', JSON.stringify(['old-chat', 'plain-generation'])), null);
    assert.equal(get(db, 'durable:workspaces', 'old-chat'), null);
    assert.equal(get(db, 'chat:history', 'old-history'), null);
    assert.equal(get(db, 'mcp-app-model-context-v1', 'app-context'), null);
    assert.equal(get(db, 'chat:threads', 'old-chat').deleted, true);
    assert.equal(get(db, 'chat:threads', 'old-chat').nativeSession, undefined);
    assert.deepEqual(get(db, 'chat:threads', 'new-chat').executionSelection, selection);
    assert.equal(get(db, 'chat:generations', 'earlier-business-generation').status, 'completed');
    assert.equal(get(db, 'native-output', 'business-generation').threadId, 'old-business');
    assert.equal(get(db, 'task-code-delivery-v1', 'business-delivery').git.worktreePath, '/preserved-worktree');
    assert.equal(get(db, 'settings:chat-defaults', 'default').revision, 2);
    assert.deepEqual(get(db, 'mcp:grants', 'grant').threadIds, ['new-chat']);
    assert.deepEqual(get(db, 'mcp:tool-receipts', 'launch-operation'), { fingerprint: 'immutable-operation-fingerprint', status: 'unknown', result: { status: 'deleted', message: 'Original Session was removed by explicit cutover; no request was replayed.' } });
    assert.equal(db.prepare("SELECT value FROM records WHERE namespace='mcp:tokens'").get()!.value, 'credential-namespace-must-not-be-read');
    assert.deepEqual(inventorySessionCutover(db, plan.dataDirectory).candidateIds, []);
  } finally { db.close(); }
});

test('directory cutover retires v1 selections and prior tombstones without changing independent workspaces', () => {
  const db = database();
  try {
    put(db, 'chat:threads', 'old-v1', { remoteId: 'old-v1', executionSelection: { version: 1, codeWorkspaceId: 'old-registry', codeWorkspaceRevision: 1, rootIds: ['old-root'], primaryRootId: 'old-root' } });
    put(db, 'chat:threads', 'old-tombstone', { remoteId: 'old-tombstone', deleted: true, scope: { workspaceId: 'old-pm-owner' }, sessionCutover: { version: 1 } });
    put(db, 'chat:threads', 'new-chat', { remoteId: 'new-chat', executionSelection: selection });
    const workspace = { id: 'new-directory', path: '/preserved-code', revision: 1 };
    const scratch = { threadId: 'new-chat', path: '/preserved-private-scratch', device: 1, inode: 2 };
    put(db, 'agent:workspaces:v1', workspace.id, workspace);
    put(db, 'agent:scratch:v1', 'new-chat', scratch);
    put(db, 'chat:history', 'old-v1', { threadId: 'old-v1', messages: [{ text: 'old-payload' }] });
    const plan = inventorySessionCutover(db, '/explicit/application-data');
    assert.deepEqual(plan.candidateIds, ['old-tombstone', 'old-v1']);
    assert.deepEqual(plan.blockers, []);
    assert.throws(() => applySessionCutover(db, { ...plan, format: 'agent-session-cutover-v1' } as unknown as typeof plan, plan.dataDirectory), /plan changed/);
    applySessionCutover(db, plan, plan.dataDirectory);
    assert.equal(get(db, 'chat:history', 'old-v1'), null);
    assert.equal(get(db, 'chat:threads', 'old-tombstone').scope, undefined);
    assert.equal(get(db, 'chat:threads', 'old-v1').sessionCutover.version, 2);
    assert.deepEqual(get(db, 'chat:threads', 'new-chat').executionSelection, selection);
    assert.deepEqual(get(db, 'agent:workspaces:v1', workspace.id), workspace);
    assert.deepEqual(get(db, 'agent:scratch:v1', 'new-chat'), scratch);
    assert.deepEqual(inventorySessionCutover(db, plan.dataDirectory).candidateIds, []);
  } finally { db.close(); }
});

test('unrecognized future execution versions block deletion instead of becoming legacy candidates', () => {
  const db = database();
  try {
    put(db, 'chat:threads', 'old', { remoteId: 'old' });
    put(db, 'chat:threads', 'future', { remoteId: 'future', executionSelection: { version: 3 } });
    const plan = inventorySessionCutover(db, '/explicit/application-data');
    assert.deepEqual(plan.candidateIds, ['old']);
    assert.match(plan.blockers.join(' '), /unsupported execution version/);
    assert.throws(() => applySessionCutover(db, plan, plan.dataDirectory), /Cutover blocked/);
    assert.deepEqual(get(db, 'chat:threads', 'old'), { remoteId: 'old' });
    assert.equal(get(db, 'chat:threads', 'future').executionSelection.version, 3);
  } finally { db.close(); }
});

test('changed fingerprint, different target, unknown namespaces and active effects block all deletion', () => {
  const db = database();
  try {
    put(db, 'chat:threads', 'old', { remoteId: 'old', deleted: true });
    const plan = inventorySessionCutover(db, '/one');
    assert.throws(() => applySessionCutover(db, plan, '/two'), /another application directory/);
    put(db, 'chat:history', 'old', { threadId: 'old', messages: [] });
    assert.throws(() => applySessionCutover(db, plan, '/one'), /plan changed/);
    put(db, 'unreviewed-session-uploads-v2', 'opaque', { threadId: 'old' });
    let current = inventorySessionCutover(db, '/one');
    assert.ok(current.blockers.some(value => value.includes('Unclassified namespace')));
    assert.throws(() => applySessionCutover(db, current, '/one'), /Cutover blocked/);
    db.prepare("DELETE FROM records WHERE namespace='unreviewed-session-uploads-v2'").run();
    put(db, 'chat:generations', 'active', { id: 'active', threadId: 'old', status: 'running' });
    current = inventorySessionCutover(db, '/one');
    assert.ok(current.blockers.some(value => value.includes('Generation active is active')));
    assert.throws(() => applySessionCutover(db, current, '/one'), /Cutover blocked/);
    assert.ok(get(db, 'chat:history', 'old'));
  } finally { db.close(); }
});

test('offline operation requires explicit stopped canonical data and refuses an owner without signalling it', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cutover-owner-'));
  const db = database(path.join(directory, 'workspace.sqlite')); db.close();
  try {
    assert.throws(() => withOfflineSessionCutover(directory, false, () => undefined), /--stopped/);
    writeFileSync(path.join(directory, 'workspace.lock'), JSON.stringify({ pid: process.pid, token: randomUUID() }), { mode: 0o600 });
    assert.throws(() => withOfflineSessionCutover(directory, true, () => undefined), /ownership lock/);
    rmSync(path.join(directory, 'workspace.lock'));
    const owner = new DatabaseSync(path.join(directory, 'workspace.sqlite'));
    owner.prepare('INSERT INTO worker_owner VALUES(1,?,?)').run(process.pid, randomUUID()); owner.close();
    assert.throws(() => withOfflineSessionCutover(directory, true, () => undefined), /live owner/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('failed cutover preserves its original error and never removes a replacement ownership lock', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cutover-replaced-owner-'));
  database(path.join(directory, 'workspace.sqlite')).close();
  const lock = path.join(directory, 'workspace.lock');
  const replacement = JSON.stringify({ pid: process.pid, token: randomUUID() });
  const original = new Error('Original transaction outcome needs reconciliation');
  try {
    assert.throws(() => withOfflineSessionCutover(directory, true, () => {
      writeFileSync(lock, replacement);
      throw original;
    }), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], original);
      assert.match(error.errors[1].message, /lock identity changed/);
      return true;
    });
    assert.equal(readFileSync(lock, 'utf8'), replacement);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
