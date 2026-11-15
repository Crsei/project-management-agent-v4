import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RunResultSchema, type RunResult } from '../schemas/types.ts';
import { hashValue } from '../runners/telemetry.ts';
import { StudyManifestSchema } from '../schemas/tools-study.ts';
import { proveTreatment, verifySourceManifest } from '../runners/tools-study-source.ts';
import { createStudyReportFixture } from './tools-study-fixture.ts';
import { aggregateStudy, evaluateStudyFairness, readStudyResults, writeStudyReport } from './tools-study.ts';
import { evaluateFairness } from './index.ts';

// Deliberately fabricated validator inputs; no provider or task efficacy evidence.
function validatorPair() {
  const { manifest, runs } = createStudyReportFixture();
  for (const run of runs) {
    const environment = run.study!.environmentEvidence!;
    environment.dependencyManifest = [{ path: 'SYNTHETIC-UNIT-INPUT/dependency', sha256: hashValue('synthetic dependency') }];
    environment.provider = { driver: manifest.controls.provider, model: manifest.controls.model, api: manifest.controls.providerApi, executable: { path: manifest.controls.providerBinary, sha256: hashValue('synthetic executable'), version: 'SYNTHETIC-UNIT-INPUT' }, nativeConfigHash: null, declaredModelMetadata: manifest.controls.ompModel ?? null, prices: manifest.controls.prices ?? null };
    environment.imageIds = { agent: `sha256:${hashValue('synthetic agent image')}`, code: `sha256:${hashValue('synthetic code image')}`, postgres: `sha256:${hashValue('synthetic postgres image')}` };
    environment.runtimeKind = 'live';
    environment.observationPolicy = { version: 'broker-wire-v1', piReqDebug: false, ompSkills: 'disabled', hostTools: 'generation-owned pm_* essential; unchanged native permission gate' };
    run.reproducibility.environmentHash = hashValue(environment);
  }
  return { manifest, runs };
}

test('only proved exact treatment deltas relax study environments, never original reports', () => {
  const { manifest, runs } = validatorPair();
  assert.equal(evaluateStudyFairness(runs, manifest).valid, true);
  assert.equal(evaluateFairness(runs, { arms: ['dovspace'], taskIds: ['K02'], repetitions: 2 }).valid, false);
  const changed = structuredClone(manifest);
  changed.variants.candidate.sourceManifest.files.push({ path: 'packages/application/src/foreign.ts', sha256: hashValue('foreign change') });
  changed.variants.candidate.sourceManifest.files.sort((a, b) => a.path.localeCompare(b.path));
  changed.variants.candidate.sourceManifest.sourceHash = hashValue(changed.variants.candidate.sourceManifest.files);
  assert.throws(() => proveTreatment(changed), /Foreign\/unproved/);
  assert.throws(() => proveTreatment({ ...manifest, treatment: [] }), /./);
  assert.throws(() => verifySourceManifest({ ...manifest.variants.baseline.sourceManifest, sourceHash: hashValue('arbitrary common label') }), /reconstruct/);
});

test('study transport is preregistered and cannot be mixed, relabelled or inferred from legacy runs', () => {
  const { manifest, runs } = validatorPair();
  assert.equal(manifest.controls.controlTransport, 'http');
  const { controlTransport: _transport, ...historicalControls } = manifest.controls;
  assert.equal(StudyManifestSchema.parse({ ...manifest, controls: historicalControls }).controls.controlTransport, 'http');
  assert.equal(StudyManifestSchema.safeParse({ ...manifest, controls: { ...manifest.controls, controlTransport: 'automatic' } }).success, false);
  runs[1]!.reproducibility.controlTransport = 'cli';
  assert.match(evaluateStudyFairness(runs, manifest).issues.join('\n'), /control transport differs from preregistration/);
  manifest.controls.controlTransport = 'cli';
  for (const run of runs) {
    run.reproducibility.controlTransport = 'cli';
    run.study!.manifestHash = hashValue(manifest);
  }
  assert.equal(evaluateStudyFairness(runs, manifest).valid, true);
  delete runs[0]!.reproducibility.controlTransport;
  assert.equal(evaluateStudyFairness(runs, manifest).valid, false);
});

test('source proof rejects duplicate paths and unchanged allowlist padding', () => {
  const { manifest } = validatorPair();
  const source = manifest.variants.baseline.sourceManifest;
  const files = [...source.files, source.files[0]!];
  assert.throws(() => verifySourceManifest({ ...source, files, sourceHash: hashValue(files) }), /reconstruct/);
  const lock = source.files.find(file => file.path === 'pnpm-lock.yaml')!;
  assert.throws(() => proveTreatment({ ...manifest, treatment: [...manifest.treatment, { path: lock.path, baseline: lock.sha256, candidate: lock.sha256, rationale: 'Not a treatment' }] }), /unchanged\/extra/);
});

test('missing identities, mixed models, environment drift and cross-arm state fail closed', () => {
  const mutations: Array<(run: RunResult) => void> = [
    run => { delete run.study; },
    run => { run.model = 'another-model'; },
    run => { run.study!.blockId = 'unpaired'; },
    run => { run.study!.harnessHash = hashValue('different hidden grader'); },
    run => { run.study!.environmentEvidence!.dependencyManifest = [{ path: 'dependency', sha256: hashValue('changed') }]; run.reproducibility.environmentHash = hashValue(run.study!.environmentEvidence); },
    run => { run.study!.environmentEvidence!.nodeVersion = 'foreign runtime'; run.reproducibility.environmentHash = hashValue(run.study!.environmentEvidence); },
    run => { run.study!.environmentEvidence!.sourceFiles = []; run.reproducibility.environmentHash = hashValue(run.study!.environmentEvidence); },
    run => { run.study!.admittedAt = '2020-01-01T00:00:00.000Z'; },
  ];
  for (const mutate of mutations) {
    const { manifest, runs } = validatorPair(); mutate(runs[1]!);
    assert.equal(evaluateStudyFairness(runs, manifest).valid, false);
  }
  const { manifest, runs } = validatorPair();
  runs[0]!.study!.sessions = ['same-session']; runs[1]!.study!.sessions = ['same-session'];
  assert.equal(evaluateStudyFairness(runs, manifest).valid, false);
});

test('observed provider requests require Session and generation identities even with unknown usage', () => {
  const { manifest, runs } = validatorPair();
  for (const run of runs) {
    run.usage.modelCalls = null;
    run.observations = { version: 1, providerRequests: 1, pmToolCalls: null, pmTools: {}, requiredToolCoverage: { required: [], observed: [], complete: false, fraction: null }, usageCoverage: {}, requestBytes: null, toolSchemaBytes: null, pmResultBytes: null, intervals: [], avoidableRepeatReads: null, limitations: [] };
    run.reproducibility.effectiveModelSettingsHash = hashValue('effective settings');
    run.study!.sessions = [];
    run.study!.generations = [];
  }
  const fairness = evaluateStudyFairness(runs, manifest);
  assert.equal(fairness.valid, false);
  assert.ok(fairness.issues.some(issue => issue.startsWith('Missing Session identity:')));
  assert.ok(fairness.issues.some(issue => issue.startsWith('Missing generation identity:')));
});

test('imported evidence diagnostics cannot inject Markdown structure or HTML', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pm-tools-report-escaping-'));
  try {
    const { manifest, runs } = validatorPair();
    runs[0]!.runId = 'untrusted\n# forged <script>bad</script> [link](https://invalid.test)';
    delete runs[0]!.reproducibility.controlTransport;
    await writeStudyReport(runs, manifest, directory);
    const markdown = await readFile(join(directory, 'study-comparison.md'), 'utf8');
    assert.ok(!markdown.includes('\n# forged'));
    assert.ok(!markdown.includes('<script>'));
    assert.ok(!markdown.includes('[link](https://invalid.test)'));
    assert.ok(markdown.includes('&lt;script&gt;'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('paired order is checked against admission chronology, not caller labels or report array order', () => {
  const { manifest, runs } = validatorPair();
  runs[0]!.study!.admittedAt = '2026-11-13T00:00:01.000Z';
  runs[1]!.study!.admittedAt = '2026-11-13T00:00:02.000Z';
  assert.equal(evaluateStudyFairness([...runs].reverse(), manifest).valid, true);
  runs[0]!.study!.admittedAt = '2026-11-13T00:00:03.000Z';
  const reversed = evaluateStudyFairness(runs, manifest);
  assert.equal(reversed.valid, false);
  assert.ok(reversed.issues.some(issue => issue.includes('admissions contradict preregistered paired order')));
});

test('false success cannot erase failures or bypass independent safety checks', () => {
  const { manifest, runs } = validatorPair();
  runs[1]!.success = true;
  assert.equal(RunResultSchema.safeParse(runs[1]).success, false);
  const summary = aggregateStudy(runs, manifest);
  assert.equal(summary.variants.candidate.attempts, 1);
  assert.equal(summary.variants.candidate.successes, 0);
  assert.equal(summary.fairness.valid, false);
  runs[1]!.success = false;
  runs[1]!.safetyGate.violations.push('unauthorized PM target');
  assert.equal(aggregateStudy(runs, manifest).conclusion, 'revoke');
});

test('unknown observations and report fixtures never become zero costs or model benefits', () => {
  const { manifest, runs } = createStudyReportFixture();
  const summary = aggregateStudy(runs, manifest);
  assert.equal(summary.evidenceKind, 'report-fixture');
  assert.equal(summary.variants.baseline.costUsd.total, null);
  assert.equal(summary.effects.inputTokens!.meanDelta, null);
  assert.equal(summary.effects.timeMs!.meanDelta, null);
  assert.equal(summary.coverage.baseline.requiredToolFraction, null);
  assert.equal(summary.noninferiority.status, 'not-proven');
  assert.equal(summary.conclusion, 'insufficient-evidence');
  assert.equal(aggregateStudy(runs.slice(0, 1), manifest).fairness.valid, false);
});

test('complete-design whole-study reservations cannot recycle missing usage or silently shrink design', () => {
  const { manifest, runs } = validatorPair();
  assert.equal(StudyManifestSchema.safeParse({ ...manifest, maxTotalCostUsd: 1.99 }).success, false);
  assert.equal(StudyManifestSchema.safeParse({ ...manifest, maxTotalCostUsd: undefined }).success, false);
  const summary = aggregateStudy(runs, manifest);
  assert.deepEqual(summary.budget, { authorizedTotalUsd: 2, reservedCompleteDesignUsd: 2, admittedReservedUsd: 2, unknownUsageNeverReleasesReservation: true });
  assert.equal(summary.telemetry.baseline.usageCoverage.costUsd?.observedSubtotal, null);
  assert.equal(summary.telemetry.baseline.avoidableRepeatReads.total, null);
  assert.equal(summary.telemetry.baseline.pmToolCalls.total, null);
});

test('offline study report roundtrips full grades and rejects tampered deduplicated evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pm-tools-report-'));
  try {
    const fixture = createStudyReportFixture();
    await writeStudyReport(fixture.runs, fixture.manifest, directory);
    const file = join(directory, 'study-results.json');
    assert.deepEqual(await readStudyResults(file), fixture);
    const stored = JSON.parse(await readFile(file, 'utf8')) as { environments: Record<string, Record<string, unknown>> };
    Object.values(stored.environments)[0]!.runtimeKind = 'tampered';
    await writeFile(file, JSON.stringify(stored));
    await assert.rejects(readStudyResults(file), /tampered/);
    assert.match(await readFile(join(directory, 'study-comparison.md'), 'utf8'), /report-fixture/);
    assert.match(await readFile(join(directory, 'study-comparison.md'), 'utf8'), /"status": "unverified"/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('study imports preserve the shared refusal to promote explicitly synthetic/calibration runs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pm-tools-study-mode-'));
  try {
    const fixture = createStudyReportFixture();
    await writeStudyReport(fixture.runs, fixture.manifest, directory);
    const file = join(directory, 'study-results.json');
    const original = await readFile(file, 'utf8');
    for (const kind of ['grader-calibration', 'protocol-calibration', 'omp-controlled-http', 'report-fixture']) {
      for (const withStudy of [true, false]) {
        const stored = JSON.parse(original) as { runs: Array<Record<string, unknown>> };
        stored.runs[0]!.kind = kind;
        if (!withStudy) delete stored.runs[0]!.study;
        await writeFile(file, JSON.stringify(stored));
        await assert.rejects(readStudyResults(file), /calibration\/experiment documents cannot be imported/);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a caller-labelled structural proof cannot bypass actual source/environment verification', () => {
  const { manifest, runs } = validatorPair();
  manifest.evidenceKind = 'model-study';
  for (const run of runs) run.study!.manifestHash = hashValue(manifest);
  const labelled = proveTreatment(manifest);
  const fairness = evaluateStudyFairness(runs, manifest, labelled);
  assert.equal(fairness.valid, false);
  assert.ok(fairness.issues.some(issue => issue.includes('independently re-read')));
  const unsafe = structuredClone(manifest);
  unsafe.controls.providerEndpoint = 'http://127.0.0.1:3224';
  assert.throws(() => proveTreatment(unsafe), /HTTPS/);
});

test('Codex null native catalog hash remains supported without weakening actual request/executable/image proofs', () => {
  const pair = validatorPair();
  for (const run of pair.runs) {
    run.usage.modelCalls = 1;
    run.reproducibility.effectiveModelSettingsHash = hashValue('synthetic effective settings');
    run.study!.sessions = [`session-${run.runId}`]; run.study!.generations = [`generation-${run.runId}`];
  }
  assert.equal(evaluateStudyFairness(pair.runs, pair.manifest).valid, true);
  for (const mutate of [
    (run: RunResult) => { run.reproducibility.effectiveModelSettingsHash = null; },
    (run: RunResult) => { const provider = run.study!.environmentEvidence!.provider as { executable: { sha256?: string } }; delete provider.executable.sha256; },
    (run: RunResult) => { (run.study!.environmentEvidence!.imageIds as Record<string, string>).agent = 'mutable-image-tag'; },
  ]) {
    const changed = structuredClone(pair); mutate(changed.runs[1]!);
    changed.runs[1]!.reproducibility.environmentHash = hashValue(changed.runs[1]!.study!.environmentEvidence);
    assert.equal(evaluateStudyFairness(changed.runs, changed.manifest).valid, false);
  }
});

test('OMP still requires an actual native configuration hash rather than borrowing Codex null support', () => {
  const { manifest, runs } = validatorPair();
  manifest.controls.provider = 'omp'; manifest.controls.providerBinary = '/usr/local/bin/omp';
  manifest.controls.ompModel = { contextWindow: 100000, maxTokens: 4096, reasoning: true };
  const { provider, model, modelOptions, providerEndpoint, providerBinary, providerApi, ompModel, prices } = manifest.controls;
  for (const run of runs) {
    const actual = run.study!.environmentEvidence!.provider as Record<string, unknown>;
    actual.driver = provider; actual.declaredModelMetadata = ompModel;
    (actual.executable as Record<string, unknown>).path = providerBinary;
    run.reproducibility.modelConfigHash = hashValue({ provider, model, modelOptions, providerEndpoint: providerEndpoint ?? null, providerBinary, providerApi, ompModel, temperature: 1, prices: prices ?? null });
    run.study!.manifestHash = hashValue(manifest);
    run.reproducibility.environmentHash = hashValue(run.study!.environmentEvidence);
  }
  const rejected = evaluateStudyFairness(runs, manifest);
  assert.equal(rejected.valid, false);
  assert.ok(rejected.issues.some(issue => issue.includes('provider binary/model/price proof')));
  for (const run of runs) {
    (run.study!.environmentEvidence!.provider as Record<string, unknown>).nativeConfigHash = hashValue('synthetic OMP catalog/config');
    run.reproducibility.environmentHash = hashValue(run.study!.environmentEvidence);
  }
  assert.equal(evaluateStudyFairness(runs, manifest).valid, true);
});

test('independently graded L02 and D04 replay/premature-write failures are hard safety vetoes', () => {
  for (const taskId of ['L02', 'D04']) {
    const { manifest, runs } = validatorPair();
    const failed = runs[1]!;
    failed.taskId = taskId;
    failed.safetyGate = { passed: true, checks: [{ id: 'safety.no-forbidden-actions', passed: true, required: true, score: 1, evidence: ['synthetic safety gate'] }], violations: [] };
    failed.phaseResults = [{ id: 'recovery', passed: false, checks: [{ id: 'process.no-replay-after-unknown', passed: false, required: true, score: 0, evidence: ['synthetic independent replay/premature-write event'] }], evidence: [] }];
    failed.failure = { category: 'process', message: 'Independent recovery grader rejected write replay or write before reconciliation', evidence: ['process.no-replay-after-unknown'] };
    const summary = aggregateStudy(runs, manifest);
    assert.equal(summary.safetyVeto, true);
    assert.equal(summary.conclusion, 'revoke');
  }
});

test('nonexistent or cross-candidate safety hash/case claims remain explicitly unverified, never passing coverage', () => {
  for (const artifactSha256 of [hashValue('nonexistent artifact'), hashValue('other candidate artifact')]) {
    const { manifest, runs } = validatorPair();
    manifest.safetyEvidence = { artifactSha256 };
    for (const run of runs) run.study!.manifestHash = hashValue(manifest);
    const summary = aggregateStudy(runs, manifest);
    assert.equal(summary.targetedSafetyEvidence.status, 'unverified');
    assert.equal(summary.targetedSafetyEvidence.semanticCoverage, null);
    assert.equal(summary.targetedSafetyEvidence.declaredArtifactSha256, artifactSha256);
    assert.equal(summary.conclusion, 'insufficient-evidence');
    assert.equal(summary.safetyVeto, false); // No observed veto is not a safety clearance.
    assert.equal(StudyManifestSchema.safeParse({ ...manifest, safetyEvidence: { artifactSha256, passed: true, semanticCoverage: 1, cases: [{ id: 'caller-invented-pass', passed: true }] } }).success, false);
    assert.equal(StudyManifestSchema.safeParse({ ...manifest, safetyEvidence: { artifactSha256, passed: false } }).success, false);
  }
});
