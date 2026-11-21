import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { parseBenchmarkConfig } from '../benchmark.config.ts';
import { prepareReportDirectory } from '../reports/files.ts';
import { getTaskDefinition } from '../tasks/index.ts';
import { enrollCanonicalDatasetVersion } from '../evaluation/dataset.ts';
import { assertRegisteredDatasetFixture, resolveRegisteredDatasetAdmission } from '../evaluation/dataset-admission.ts';
import { createFixtureManager } from './manager.ts';

test('fresh real PM seed satisfies all six canonical dataset admissions without a model runtime', { timeout: 1_200_000 }, async t => {
  const config = parseBenchmarkConfig();
  const root = path.join(config.outputsRoot, `native-fixture-admission-${randomUUID()}`);
  await prepareReportDirectory(root, true);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const registryRoot = path.join(root, 'registry');
  const tasks = ['K02', 'K03', 'D01', 'D02', 'L02', 'L04'] as const;
  const dataset = await enrollCanonicalDatasetVersion(registryRoot, {
    datasetId: 'native-six-canonical', version: 'v1', splitPolicyVersion: 'exposed-regression-v1', enrollmentId: 'native-fixture-admission',
    source: { sourceId: 'canonical-source', sourceVersion: 'task-registry-v1', provenanceId: 'own-synthetic-fixtures', retentionUntil: new Date(Date.now() + 86_400_000).toISOString() },
    maintainerId: 'fixture-maintainer', labelerId: 'acceptance-labeler', reviewerId: 'independent-reviewer', licenseId: 'AGPL-3.0-only', licenseAuthorized: true, sanitized: true, independentExpectedCriterion: true,
    members: tasks.map(taskId => ({ memberId: `member-${taskId}`, memberVersion: 1, taskId })),
  });
  const manager = createFixtureManager(config);
  const fixture = await manager.reset({ runId: `native-admission-${randomUUID()}` });
  try {
    const actual = await manager.snapshot(fixture);
    assert.equal(fixture.runtime, null);
    for (const taskId of tasks) {
      const admission = await resolveRegisteredDatasetAdmission({ registryRoot, datasetId: dataset.datasetId, version: dataset.version, memberId: `member-${taskId}`, memberVersion: 1 }, getTaskDefinition(taskId));
      assert.doesNotThrow(() => assertRegisteredDatasetFixture(admission, actual), taskId);
      for (const field of ['body', 'status', 'blocked_by'] as const) {
        const changed = structuredClone(actual);
        const target = changed.entities.find(entity => entity.key === 'beacon-dependency')!;
        if (field === 'body') target.entity.body = `${String(target.entity.body)}\nChanged acceptance requirement.`;
        else if (field === 'status') target.entity.status = 'in_progress';
        else target.entity.blocked_by = [];
        assert.throws(() => assertRegisteredDatasetFixture(admission, changed), /no model dispatch/, `${taskId}: ${field}`);
      }
    }
    assert.equal(fixture.runtime, null);
  } finally { await manager.destroy(fixture); }
});
