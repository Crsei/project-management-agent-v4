import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { parseBenchmarkConfig } from '../benchmark.config.ts';
import { createFixtureManager } from './manager.ts';

test('three fresh real PostgreSQL/Markdown resets have equal semantic content and different authority identities', { timeout: 600_000 }, async () => {
  const manager = createFixtureManager(parseBenchmarkConfig());
  const hashes: string[] = [], workspaces: string[] = [], fixtureIds: string[] = [];
  for (let index = 0; index < 3; index++) {
    const fixture = await manager.reset({ runId: `foundation-reset-${index}` });
    try {
      const before = await manager.snapshot(fixture);
      assert.equal(before.entities.filter(entity => entity.kind === 'project').length, 3);
      assert.equal(before.entities.filter(entity => entity.kind === 'work_item').length, 24);
      assert.ok(Object.keys(before.publicFiles).filter(name => name.startsWith('docs/')).length >= 30);
      assert.ok(before.receipts.filter(receipt => receipt.kind === 'creation' && receipt.status === 'committed').length >= 27);
      assert.ok(before.receipts.every(receipt => receipt.operationId));
      hashes.push(before.semanticHash); workspaces.push(fixture.workspaceId); fixtureIds.push(fixture.fixtureId);
      if (index === 2) {
        const target = fixture.targets['cedar-runbook']!;
        await manager.request(fixture, `/api/v1/workspaces/${fixture.workspaceId}/core/entities/${target.entityId}`, { method: 'PATCH', body: { revision: target.revision, changes: { priority: 'urgent' } } });
        const after = await manager.snapshot(fixture);
        assert.notEqual(after.semanticHash, before.semanticHash);
        assert.ok(manager.diff(before, after, { allowedEntityIds: [fixture.targets['atlas-plan']!.entityId] }).unexpectedMutations.some(mutation => mutation.domain === 'entity' && mutation.identity === target.entityId));
      }
      await assert.rejects(manager.seed(fixture), /single-use/);
    } finally { await manager.destroy(fixture); }
    await assert.rejects(lstat(fixture.root), { code: 'ENOENT' });
  }
  assert.equal(new Set(hashes).size, 1, 'Generated UUIDs/revisions/timestamps must not affect semantic reset content');
  assert.equal(new Set(workspaces).size, 3);
  assert.equal(new Set(fixtureIds).size, 3);
});

test('live Agent launch refuses missing explicit provider prerequisites rather than using host credentials', { timeout: 180_000 }, async () => {
  const config = parseBenchmarkConfig();
  const manager = createFixtureManager(config);
  const fixture = await manager.reset({ runId: 'foundation-provider-fail-closed' });
  try {
    await assert.rejects(manager.startRuntime(fixture, { runId: 'provider-missing', budget: config.budget, allowedTools: [], allowedTargets: [] }), /Provider prerequisite missing/);
    assert.equal(fixture.runtime, null);
    assert.equal(fixture.isolation, null);
  } finally { await manager.destroy(fixture); }
});
