import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { closeStore, listRecords, readRecord, writeRecord } from '../durable/store.ts';
import {
  currentGrant, grantIdentity, MCP_EXECUTION_ROOTS, MCP_GRANTS, putGrant,
  readMcpExecutionRoot, reserveMcpExecutionRoot, type Grant, type McpExecutionRoot,
} from './grants.ts';

const previous = { directory: process.env.AGENT_WORKSPACE_DATA_DIR, origin: process.env.MCP_PUBLIC_ORIGIN };
let directory: string;
let grant: Grant;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mcp-external-root-'));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  process.env.MCP_PUBLIC_ORIGIN = 'https://fixture.invalid';
  grant = { grantId: randomUUID(), actorId: randomUUID(), scope: { workspaceId: randomUUID(), projectId: 'PRJ-001' },
    access: 'full', threadIds: [], version: 1, clientHash: 'registered-client-digest', clientName: 'Fixture',
    audience: 'https://fixture.invalid/mcp', createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(), revokedAt: null };
  putGrant(grant);
});
afterEach(async () => {
  closeStore();
  await rm(directory, { recursive: true, force: true });
  for (const [key, value] of [['AGENT_WORKSPACE_DATA_DIR', previous.directory], ['MCP_PUBLIC_ORIGIN', previous.origin]] as const)
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
});

test('PM-only external roots preserve original identity and trace across canonical retries without creating Chat records', () => {
  const identity = grantIdentity(grant), operationId = randomUUID();
  const input = { operationId, name: 'pm_query', target: grant.scope, arguments: { query: 'original', nested: { a: 1, b: 2 } } };
  const first = reserveMcpExecutionRoot(identity, input);
  assert.equal(first.created, true);
  assert.equal(first.root.executionRoot, 'external');
  assert.equal(first.root.policy, 'full');
  assert.equal(first.root.enforcement, 'audit-only');
  assert.match(first.root.traceId, /^[a-f0-9-]{36}$/);
  assert.notEqual(first.root.traceId, first.root.executionId);
  const second = reserveMcpExecutionRoot(identity, { name: input.name, arguments: { nested: { b: 2, a: 1 }, query: 'original' }, target: input.target, operationId });
  assert.equal(second.created, false);
  assert.deepEqual(second.root, first.root);
  assert.deepEqual(readMcpExecutionRoot(identity, operationId), first.root);
  assert.deepEqual(listRecords('chat:threads'), []);
  assert.deepEqual(listRecords('chat:generations'), []);
  assert.deepEqual(listRecords('native-output:snapshots'), []);
  assert.equal(listRecords(MCP_EXECUTION_ROOTS).length, 1);
  for (const altered of [
    { ...input, name: 'pm_update_task' },
    { ...input, arguments: { query: 'changed' } },
  ]) assert.throws(() => reserveMcpExecutionRoot(identity, altered), /another request/);
  assert.throws(() => reserveMcpExecutionRoot(identity, { ...input, target: { ...grant.scope, projectId: 'PRJ-002' } }), /ceiling/);
  const replacement = { ...grant, grantId: randomUUID() }; putGrant(replacement);
  assert.throws(() => readMcpExecutionRoot(grantIdentity(replacement), operationId), /unavailable/);
  assert.throws(() => reserveMcpExecutionRoot(grantIdentity(replacement), input), /unavailable/);
});

test('audit-only root defaults never upgrade existing read-only grants and revoked or expired identities cannot read roots', () => {
  const readonly = { ...grant, access: 'read-only' as const }; putGrant(readonly);
  const identity = grantIdentity(readonly), operationId = randomUUID();
  const input = { operationId, name: 'pm_query', target: grant.scope, arguments: {} };
  const { root } = reserveMcpExecutionRoot(identity, input);
  assert.equal(root.policy, 'full');
  assert.equal(root.enforcement, 'audit-only');
  assert.equal(root.access, 'read-only');
  assert.equal(currentGrant(identity).access, 'read-only');
  assert.equal(readRecord<Grant>(MCP_GRANTS, grant.grantId)?.access, 'read-only');
  assert.throws(() => currentGrant({ ...identity, access: 'full' }), /expired|revoked|unavailable/);
  writeRecord(MCP_GRANTS, grant.grantId, { ...readonly, expiresAt: new Date(0).toISOString() });
  assert.throws(() => readMcpExecutionRoot(identity, operationId), /expired|revoked|unavailable/);
  assert.throws(() => reserveMcpExecutionRoot(identity, input), /expired|revoked|unavailable/);
  writeRecord(MCP_GRANTS, grant.grantId, { ...readonly, revokedAt: new Date().toISOString(), version: 2 });
  assert.throws(() => readMcpExecutionRoot(identity, operationId), /expired|revoked|unavailable/);
  assert.throws(() => reserveMcpExecutionRoot(identity, input), /expired|revoked|unavailable/);
  assert.deepEqual(readRecord<McpExecutionRoot>(MCP_EXECUTION_ROOTS, operationId), root, 'revocation never rewrites original evidence');
});
