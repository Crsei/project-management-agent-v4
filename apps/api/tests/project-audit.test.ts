import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMarkdown, parseMarkdown } from '../../../packages/pm-markdown/index.ts';
import { revisionOf } from '../../../packages/pm-core/index.ts';
import type { FileRecord } from '../../../packages/pm-schema/index.ts';
import { projectAuditChanges } from '../../../packages/domain/src/project-audit.ts';
import { requestHash } from '../../../packages/application/src/kernel.ts';
import { coreProjectAuditWrites } from '../src/core-adapter.ts';
import { CoreCommandJournal } from '../src/core-journal.ts';

const actorId = '22222222-2222-4222-8222-222222222222';
const metadata = { source: 'core_http' as const, commandId: 'a'.repeat(64), action: 'UpdateCoreSource', actorId, occurredAt: '2026-10-20T12:00:00.000Z' };
function taskRecord(body: string, priority: 'low' | 'high'): FileRecord {
  const raw = createMarkdown({ id: 'TASK-001', entity: 'work_item', project: 'PRJ-001', title: 'Safe title', priority, body });
  return { id: 'TASK-001', path: 'tasks/TASK-001.md', raw, revision: revisionOf(raw), entity: parseMarkdown(raw) };
}

test('audit snapshots use an explicit scalar allowlist, never arbitrary nested or source content', () => {
  const secret = 'secret-notes-message-source-token';
  const changes = projectAuditChanges({ status: 'todo', favorite: false, currency: 'USD', amountMinor: 1 }, {
    status: 'done', favorite: true, currency: 'USD', amountMinor: 2, notes: secret, body: secret, raw: secret,
    messages: [secret], fileBytes: secret, token: secret, description: secret, custom: { status: secret },
  });
  assert.deepEqual(changes, [
    { field: 'status', before: 'todo', after: 'done' },
    { field: 'favorite', before: false, after: true },
    { field: 'amountMinor', before: 1, after: 2 },
  ]);
  assert.equal(JSON.stringify(changes).includes(secret), false);
  assert.deepEqual(projectAuditChanges({}, { title: 'x'.repeat(501), status: { secret } }), [], 'Oversized and structured values are not copied to audit');
});

test('native snapshots preserve exact revisions and suppress guessed field diffs from stale projections', () => {
  const before = taskRecord('Old private source', 'low');
  const after = taskRecord('New private source and secrets', 'high');
  const entries = coreProjectAuditWrites(before, after, metadata);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.projectId, 'PRJ-001');
  assert.equal(entries[0]!.beforeVersion, before.revision);
  assert.equal(entries[0]!.afterVersion, after.revision);
  assert.deepEqual(entries[0]!.changes, [{ field: 'priority', before: 'low', after: 'high' }]);
  assert.equal(JSON.stringify(entries).includes('private source'), false);
  assert.deepEqual(coreProjectAuditWrites(before, before, metadata), [], 'Watcher refresh without a committed mutation is not a new actor fact');
  const repaired = coreProjectAuditWrites({ ...before, stale: true }, after, metadata);
  assert.deepEqual(repaired[0]!.changes, [], 'Last-known-valid fields cannot be presented as the invalid source before-image');
  assert.equal(repaired[0]!.beforeVersion, before.revision);
});

test('durable journal distinguishes pending uncertainty, completed safe snapshots, actor identity and known native rejection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'project-audit-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = taskRecord('private old', 'low'), after = taskRecord('private new', 'high');
  const audit = coreProjectAuditWrites(before, after, metadata);
  const command = { commandId: randomUUID(), commandType: 'UpdateProject', payload: {} };
  const hash = requestHash(command);
  const journal = new CoreCommandJournal(root);
  journal.pending(command, hash, actorId);
  assert.equal(new CoreCommandJournal(root).find(command.commandId, actorId)?.kind, 'pending');
  assert.equal(journal.find(command.commandId, randomUUID()), undefined);
  journal.complete(command.commandId, hash, { commandId: command.commandId, status: 'committed', httpStatus: 200, result: { id: 'TASK-001' } }, actorId, ['PRJ-001'], []);
  assert.equal(new CoreCommandJournal(root).find(command.commandId, actorId)?.kind, 'completed');
  journal.pendingHttp(metadata.commandId, hash, actorId);
  assert.equal(new CoreCommandJournal(root).findHttp(metadata.commandId, actorId)?.kind, 'http_pending');
  journal.completeHttp({ commandId: metadata.commandId, hash, actorId, targetId: after.id, revision: after.revision, audit });
  const recovered = new CoreCommandJournal(root).findHttp(metadata.commandId, actorId);
  assert.equal(recovered?.kind, 'http_completed');
  if (recovered?.kind === 'http_completed') assert.deepEqual(recovered.audit, audit);
  const rejectedId = 'b'.repeat(64);
  journal.pendingHttp(rejectedId, hash, actorId);
  journal.rejectHttp(rejectedId, hash, actorId);
  assert.equal(new CoreCommandJournal(root).findHttp(rejectedId, actorId), undefined, 'Known rejection is not an unknown or a success fact');
  await appendFile(join(root, '.pm', 'state', 'pm-command-journal.ndjson'), '{"kind":"completed"');
  assert.throws(() => new CoreCommandJournal(root).find(command.commandId, actorId), 'Damaged durable history must not be silently ignored or replayed');
});
