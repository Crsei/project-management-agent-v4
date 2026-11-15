import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectSourceManifest } from '../isolation/source.ts';
import { createStudyReportFixture } from '../reports/tools-study-fixture.ts';
import { verifyStudySources } from './tools-study-source.ts';

async function sourceTree(root: string, body: string) {
  for (const directory of ['apps/server', 'apps/desktop/src', 'packages/application/src', 'vendor']) await mkdir(join(root, directory), { recursive: true });
  for (const name of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.base.json', 'apps/desktop/src/private-state.mjs']) await writeFile(join(root, name), '{}');
  await writeFile(join(root, 'packages/application/src/task-brief.ts'), body);
  return await collectSourceManifest(root);
}

test('actual source bytes are re-read; foreign changes cannot hide behind registered source labels', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pm-tools-study-source-'));
  try {
    const baselineRoot = join(root, 'baseline'), candidateRoot = join(root, 'candidate');
    const baseline = await sourceTree(baselineRoot, 'original'), candidate = await sourceTree(candidateRoot, 'candidate');
    const { manifest } = createStudyReportFixture();
    manifest.variants.baseline = { sourceRoot: baselineRoot, sourceManifest: baseline };
    manifest.variants.candidate = { sourceRoot: candidateRoot, sourceManifest: candidate };
    const path = 'packages/application/src/task-brief.ts';
    manifest.treatment = [{ path, baseline: baseline.files.find(file => file.path === path)!.sha256, candidate: candidate.files.find(file => file.path === path)!.sha256, rationale: 'Synthetic source-protocol test only' }];
    assert.equal((await verifyStudySources(manifest)).differences.length, 1);
    await writeFile(join(candidateRoot, 'packages/application/src/foreign.ts'), 'unregistered change');
    await assert.rejects(verifyStudySources(manifest), /actual source bytes differ/);
    const observed = await collectSourceManifest(candidateRoot);
    manifest.variants.candidate.sourceManifest = observed;
    await assert.rejects(verifyStudySources(manifest), /Foreign\/unproved/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('literal dot-dot-prefixed nested source directories cannot obtain a verified capability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pm-tools-study-nesting-'));
  try {
    const outerRoot = join(root, 'baseline'), nestedRoot = join(outerRoot, '..candidate');
    const outer = await sourceTree(outerRoot, 'outer'), nested = await sourceTree(nestedRoot, 'nested');
    const path = 'packages/application/src/task-brief.ts';
    for (const swapped of [false, true]) {
      const { manifest } = createStudyReportFixture();
      const baseline = swapped ? nested : outer, candidate = swapped ? outer : nested;
      manifest.variants.baseline = { sourceRoot: swapped ? nestedRoot : outerRoot, sourceManifest: baseline };
      manifest.variants.candidate = { sourceRoot: swapped ? outerRoot : nestedRoot, sourceManifest: candidate };
      manifest.treatment = [{ path, baseline: baseline.files.find(file => file.path === path)!.sha256, candidate: candidate.files.find(file => file.path === path)!.sha256, rationale: 'Synthetic nesting rejection case only' }];
      await assert.rejects(verifyStudySources(manifest), /equal or nested/);
    }
    const siblingRoot = join(root, '..candidate'), sibling = await sourceTree(siblingRoot, 'sibling');
    const { manifest } = createStudyReportFixture();
    manifest.variants.baseline = { sourceRoot: outerRoot, sourceManifest: outer };
    manifest.variants.candidate = { sourceRoot: siblingRoot, sourceManifest: sibling };
    manifest.treatment = [{ path, baseline: outer.files.find(file => file.path === path)!.sha256, candidate: sibling.files.find(file => file.path === path)!.sha256, rationale: 'Synthetic genuinely independent sibling control' }];
    assert.equal((await verifyStudySources(manifest)).differences.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
