import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectEvaluatorImplementationHash, EVALUATOR_IMPLEMENTATION_INPUTS } from './evaluator.ts';
import { collectStudyHarnessHash } from '../runners/tools-study-source.ts';

test('mutable source approval/revocation records do not invalidate calibrated evaluator or preregistered harness identities', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'evaluation-implementation-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of EVALUATOR_IMPLEMENTATION_INPUTS) {
    const location = path.join(root, name);
    if (name.endsWith('.ts')) { await mkdir(path.dirname(location), { recursive: true, mode: 0o700 }); await writeFile(location, 'implementation-input\n'); }
    else await mkdir(location, { recursive: true, mode: 0o700 });
  }
  const benchmarkRoot = path.join(root, 'benchmarks/dovspace');
  for (const name of ['adapters', 'calibration', 'evaluation', 'fixtures', 'graders', 'isolation', 'pm-tools', 'reports', 'runners', 'schemas', 'tasks']) await mkdir(path.join(benchmarkRoot, name), { recursive: true, mode: 0o700 });
  await writeFile(path.join(benchmarkRoot, 'cli.ts'), 'cli-input\n');
  const registry = path.join(benchmarkRoot, 'evaluation/release-policy-registry.json'), implementation = path.join(benchmarkRoot, 'evaluation/review.ts');
  await writeFile(registry, '{"policies":[],"revocations":[]}\n');
  await writeFile(implementation, 'review-implementation-a\n');
  const evaluatorBefore = await collectEvaluatorImplementationHash(root), harnessBefore = await collectStudyHarnessHash(benchmarkRoot);
  await writeFile(registry, '{"policies":["approved exact evidence"],"revocations":["withdrawn"]}\n');
  assert.equal(await collectEvaluatorImplementationHash(root), evaluatorBefore);
  assert.equal(await collectStudyHarnessHash(benchmarkRoot), harnessBefore);
  await writeFile(implementation, 'review-implementation-b\n');
  assert.notEqual(await collectEvaluatorImplementationHash(root), evaluatorBefore);
  assert.notEqual(await collectStudyHarnessHash(benchmarkRoot), harnessBefore);
  const evaluatorChanged = await collectEvaluatorImplementationHash(root), harnessChanged = await collectStudyHarnessHash(benchmarkRoot);
  await writeFile(path.join(benchmarkRoot, 'evaluation/unrelated-input.json'), '{"mustStillBeHashed":true}\n');
  assert.notEqual(await collectEvaluatorImplementationHash(root), evaluatorChanged);
  assert.notEqual(await collectStudyHarnessHash(benchmarkRoot), harnessChanged);
});
