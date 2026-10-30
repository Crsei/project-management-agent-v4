import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CoreCommandJournal } from '../src/core-journal.ts';

test('native creation readers preserve historical journal and durable rejected/committed precedence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pm-native-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new CoreCommandJournal(root);
  const actorId = randomUUID(), commandId = 'c'.repeat(64), hash = 'd'.repeat(64);
  journal.pendingHttp(commandId, hash, actorId);
  journal.rejectHttp(commandId, hash, actorId);
  const file = join(root, '.pm/state/pm-command-journal.ndjson');
  const historical = await readFile(file, 'utf8');
  const restarted = new CoreCommandJournal(root);
  assert.equal(restarted.httpOutcome(commandId, actorId)?.kind, 'http_rejected');
  assert.equal(restarted.findHttp(commandId, actorId), undefined, 'Legacy mutation readers keep their rejection semantics');
  assert.equal(restarted.httpOutcome(commandId, randomUUID()), undefined);
  assert.equal(await readFile(file, 'utf8'), historical);
  restarted.completeHttp({ commandId, actorId, hash, targetId: 'TASK-001', revision: 'e'.repeat(64), audit: [] });
  restarted.pendingHttp(commandId, hash, actorId);
  assert.equal(new CoreCommandJournal(root).httpOutcome(commandId, actorId)?.kind, 'http_completed');
  assert.equal((await readFile(file, 'utf8')).startsWith(historical), true);
  await appendFile(file, '{"kind":"http_pending"');
  assert.throws(() => new CoreCommandJournal(root).httpOutcome(commandId, actorId), 'Torn history must fail closed, never create a false not_found');
});

test('result reads do not initialize a new native journal directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pm-native-journal-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(new CoreCommandJournal(root).httpOutcome('a'.repeat(64), randomUUID()), undefined);
  await assert.rejects(readFile(join(root, '.pm/state/pm-command-journal.ndjson')), { code: 'ENOENT' });
});
