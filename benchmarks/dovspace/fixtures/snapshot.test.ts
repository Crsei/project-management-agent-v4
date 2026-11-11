import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonical, digest, diffSnapshots, readTree, semanticTables } from './snapshot.ts';
import type { FixtureSnapshot } from '../schemas/types.ts';

function snapshot(): FixtureSnapshot {
  return { fixtureId: 'same-owned-fixture', fixtureVersion: 'test', capturedAt: '2026-11-10T00:00:00Z', semanticHash: 'before', entities: [{ key: 'target', id: 'TASK-001', projectId: 'PRJ-001', kind: 'work_item', revision: 'r1', path: 'work-items/TASK-001.md', entity: { title: 'Original', status: 'todo' }, raw: 'original' }], receipts: [], tables: { memberships: [{ user_id: 'owner', capabilities: ['domain.read'] }] }, files: { 'workspace/work-items/TASK-001.md': 'original' }, publicFiles: { 'docs/source.md': 'aW1tdXRhYmxl' } };
}
test('canonical hashes ignore object insertion order but not values', () => {
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
  assert.notEqual(digest({ a: 1 }), digest({ a: 2 }));
});
test('semantic SQL normalization retains business changes across independent identities', () => {
  const first = { root: '/owned/a', workspaceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', actorId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' };
  const second = { root: '/owned/b', workspaceId: 'cccccccc-cccc-cccc-cccc-cccccccccccc', actorId: 'dddddddd-dddd-dddd-dddd-dddddddddddd' };
  const rows = (owner: typeof first, enabled = true) => ({ memberships: [{ workspace_id: owner.workspaceId, user_id: owner.actorId, created_at: 'volatile', enabled, capabilities: ['domain.read'] }] });
  assert.equal(canonical(semanticTables(rows(first), first)), canonical(semanticTables(rows(second), second)));
  assert.notEqual(digest(semanticTables(rows(first), first)), digest(semanticTables(rows(second, false), second)));
});
test('snapshot diff detects unrelated SQL, entity and authority changes', () => {
  const before = snapshot(), after = structuredClone(before);
  after.semanticHash = 'after'; after.entities.push({ ...after.entities[0]!, id: 'TASK-002', key: 'unrelated' });
  after.tables.memberships![0]!.capabilities = ['domain.read', 'planning.edit'];
  after.files['workspace/.pm/config.yaml'] = 'unauthorized';
  const diff = diffSnapshots(before, after, { allowedEntityIds: ['TASK-001'] });
  assert.ok(diff.unexpectedMutations.some(value => value.domain === 'postgres' && value.identity === 'memberships'));
  assert.ok(diff.unexpectedMutations.some(value => value.domain === 'entity' && value.identity === 'TASK-002'));
  assert.ok(diff.unexpectedMutations.some(value => value.identity.endsWith('config.yaml')));
  assert.throws(() => diffSnapshots(before, { ...after, fixtureId: 'another-run' }), /independent fixture/);
});
test('authorized native audit/fact heads are journal-bound, not whole-table exemptions', () => {
  const before = snapshot(), after = structuredClone(before);
  before.tables.workspaces = [{ id: 'owned', name: 'Fictional', service_fact_head: 0, change_history_head: 0 }];
  after.tables.workspaces = [{ id: 'owned', name: 'Fictional', service_fact_head: 1, change_history_head: 1 }];
  const audit = { projectId: 'PRJ-001', source: 'core_http', commandId: 'original-command', action: 'UpdateCoreEntity', actorId: 'actor', targetId: 'TASK-001', targetKind: 'work_item', beforeVersion: 'r1', afterVersion: 'r2', changes: [{ field: 'priority', before: 'medium', after: 'high' }], audienceActorId: null };
  const fact = { factId: 'fact-1', sourceKey: '["actor","original-command","TASK-001",0]', entityId: 'TASK-001', beforeRevision: 'r1', afterRevision: 'r2' };
  after.files['owned/.pm/state/pm-command-journal.ndjson'] = Buffer.from(JSON.stringify({ kind: 'http_completed', commandId: 'original-command', actorId: 'actor', targetId: 'TASK-001', audit: [audit], facts: [{ fact }] }) + '\n').toString('base64');
  after.tables.project_audit = [{ workspace_id: 'owned', project_id: 'PRJ-001', source: audit.source, command_id: audit.commandId, action: audit.action, actor_id: audit.actorId, target_id: audit.targetId, target_kind: audit.targetKind, before_version: audit.beforeVersion, after_version: audit.afterVersion, changes: audit.changes, audience_actor_id: null }];
  after.tables.service_fact_events = [{ workspace_id: 'owned', fact_id: fact.factId, source_key: fact.sourceKey, entity_id: fact.entityId, before_revision: fact.beforeRevision, after_revision: fact.afterRevision }];
  after.tables.change_history_entries = [{ workspace_id: 'owned', change_id: fact.factId, source_key: `fact:${fact.factId}`, target: { entityId: fact.entityId } }];
  assert.deepEqual(diffSnapshots(before, after, { allowedEntityIds: ['TASK-001'] }).unexpectedMutations, []);
  const forged = structuredClone(after);
  forged.tables.project_audit!.push({ ...forged.tables.project_audit![0]!, target_id: 'TASK-999' });
  assert.ok(diffSnapshots(before, forged, { allowedEntityIds: ['TASK-001'] }).unexpectedMutations.some(mutation => mutation.domain === 'postgres' && mutation.identity === 'project_audit'));
  const tampered = structuredClone(after);
  tampered.tables.project_audit![0]!.changes = [];
  assert.ok(diffSnapshots(before, tampered, { allowedEntityIds: ['TASK-001'] }).unexpectedMutations.some(mutation => mutation.domain === 'postgres' && mutation.identity === 'project_audit'));
});
test('platform signal SQL additions require exact accepted signed payload and linked trusted PM request', () => {
  const before = snapshot(), after = structuredClone(before);
  before.tables.workspaces = [{ id: 'owned' }]; after.tables.workspaces = [{ id: 'owned' }];
  const payload = { eventId: 'agent:terminal:generation', workspaceId: 'owned', projectId: 'PRJ-001', actorId: 'actor', sourceRef: { kind: 'execution', id: 'generation' } };
  const prior = { id: 'pm-request', timestamp: before.capturedAt, runId: 'run', type: 'pm_request', source: 'transport' as const, sessionId: 'session', generationId: 'generation', data: { workspaceId: 'owned', projectId: 'PRJ-001' } };
  after.transportEvents = [prior, { id: 'accepted-signal', timestamp: before.capturedAt, runId: 'run', type: 'platform_signal_accepted', source: 'transport', sessionId: 'session', generationId: 'generation', data: { payload, payloadHash: digest(payload), pmRequestEventId: prior.id } }];
  after.tables.automation_pm_signals = [{ workspace_id: 'owned', project_id: 'PRJ-001', actor_id: 'actor', source_key: payload.eventId, payload }];
  assert.deepEqual(diffSnapshots(before, after, { allowedEntityIds: ['TASK-001'] }).unexpectedMutations, []);
  const unrelated = structuredClone(after);
  unrelated.tables.automation_pm_signals!.push({ ...unrelated.tables.automation_pm_signals![0]!, source_key: 'unrelated-signal' });
  assert.ok(diffSnapshots(before, unrelated, { allowedEntityIds: ['TASK-001'] }).unexpectedMutations.some(mutation => mutation.identity === 'automation_pm_signals'));
  const tampered = structuredClone(after);
  tampered.tables.automation_pm_signals![0]!.payload = { ...payload, actorId: 'another-actor' };
  assert.ok(diffSnapshots(before, tampered, { allowedEntityIds: ['TASK-001'] }).unexpectedMutations.some(mutation => mutation.identity === 'automation_pm_signals'));
  const unbound = structuredClone(after); unbound.transportEvents = unbound.transportEvents!.filter(event => event.id !== prior.id);
  assert.ok(diffSnapshots(before, unbound, { allowedEntityIds: ['TASK-001'] }).unexpectedMutations.some(mutation => mutation.identity === 'automation_pm_signals'));
});
test('snapshot walker refuses symlinks and hardlinks rather than exporting host bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dovspace-snapshot-'));
  try {
    const publicRoot = path.join(root, 'public'); await mkdir(publicRoot);
    await writeFile(path.join(root, 'hidden'), 'must-not-export');
    await symlink(path.join(root, 'hidden'), path.join(publicRoot, 'escape'));
    await assert.rejects(readTree(publicRoot));
    await rm(path.join(publicRoot, 'escape'));
    await link(path.join(root, 'hidden'), path.join(publicRoot, 'hardlink'));
    await assert.rejects(readTree(publicRoot), /hardlink/);
    await rm(path.join(publicRoot, 'hardlink'));
    await writeFile(path.join(publicRoot, 'allowed.md'), 'fictional');
    assert.deepEqual(await readTree(publicRoot), { 'allowed.md': Buffer.from('fictional').toString('base64') });
  } finally { await rm(root, { recursive: true, force: true }); }
});
