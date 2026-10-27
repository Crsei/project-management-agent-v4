import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { CoreWorkspacePool } from '../apps/api/src/core-routes.ts';
import { CoreFactImporter } from '../apps/api/src/core-fact-importer.ts';
import { CoreCommandJournal } from '../apps/api/src/core-journal.ts';
import { captureCoreFacts } from '../apps/api/src/core-facts.ts';
import { lockWorkspace } from '../packages/infrastructure/src/database.ts';
import type { CapturedServiceFact } from '../packages/application/src/service-facts.ts';
import { createLocalProjectFixture, localProjectEventually } from './local-project-fixture.ts';

test('local initialization recovery never promotes a live writer before its workspace transaction completes', { timeout: 90_000 }, async () => {
  const f = await createLocalProjectFixture();
  const workspaces = new CoreWorkspacePool(f.coreRoot, f.pool);
  const sql = await f.pool.connect();
  let importing: Promise<number> | undefined;
  try {
    await f.stopServices();
    const workspace = await workspaces.get(f.workspaceId);
    const projectRoot = join(f.parents[0], 'serialized-facts'); await mkdir(projectRoot);
    const operationId = randomUUID(), facts: CapturedServiceFact[] = [];
    const capture = captureCoreFacts({ sql, workspaceId: f.workspaceId, root: workspace.root, sourceKind: 'command', operationId, requestHash: 'a'.repeat(64), actorId: f.owner.id, facts });
    await sql.query('BEGIN'); await lockWorkspace(sql, f.workspaceId);
    const blocker = (await sql.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    let completionDeferred = false;
    // Hold the actual disk-commit / fact-publication boundary while retaining the
    // production workspace transaction lock; no fake database or timer ordering.
    const record = await workspace.captureMutations({ prepare: capture.prepare, committed() { completionDeferred = true; } },
      () => workspace.initializeProject({ entity: 'project', title: 'Original live initialization' }, operationId, { workspaceId: f.workspaceId, root: projectRoot }));
    assert.equal(completionDeferred, true);
    const importer = new CoreFactImporter(f.pool, workspaces);
    importing = importer.importWorkspace(f.workspaceId);
    await localProjectEventually(async () => (await f.pool.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND wait_event_type=\'Lock\'', [blocker])).rowCount! > 0, 'the importer to wait on the live writer transaction');
    const journal = new CoreCommandJournal(workspace.root);
    assert.equal(journal.entries().filter(entry => entry.kind === 'fact_completed').length, 0, 'Recovery must not invent a completion timestamp while the original writer owns the lock');
    capture.committed(undefined, record);
    await sql.query('COMMIT'); await importing;
    const original = facts[0]!; assert.ok(original.fact.occurredAt);
    const saved = await f.pool.query<{ fact_id: string; occurred_at: Date }>("SELECT fact_id,occurred_at FROM service_fact_events WHERE workspace_id=$1 AND source_kind='command' AND source_key=$2", [f.workspaceId, original.fact.sourceKey]);
    assert.deepEqual(saved.rows.map(row => ({ id: row.fact_id, occurredAt: row.occurred_at.toISOString() })), [{ id: original.fact.factId, occurredAt: original.fact.occurredAt }]);
    assert.equal(journal.entries().filter(entry => entry.kind === 'fact_completed').length, 1);
  } finally {
    await sql.query('ROLLBACK');
    await importing?.catch(() => undefined);
    sql.release(); await workspaces.close(); await f.close();
  }
});
