import { parseBenchmarkConfig } from '../benchmark.config.ts';
import { publicExperimentConfiguration } from './index.ts';
import { hashValue } from '../runners/telemetry.ts';
import { boundedBudget, nativeToolPolicy } from '../runners/index.ts';
import { getTaskDefinition } from '../tasks/index.ts';
import type { RunResult, SourceManifest } from '../schemas/types.ts';
import { StudyManifestSchema, STUDY_VARIANTS } from '../schemas/tools-study.ts';

/** Synthetic report-validator input only. Never passed to runtime, graders or model execution. */
export function createStudyReportFixture() {
  const controls = publicExperimentConfiguration(parseBenchmarkConfig({ model: 'REPORT-FIXTURE-NOT-MODEL-EVIDENCE', providerEndpoint: 'https://fixture.invalid/v1', budget: { maxDurationMinutes: 1, maxModelCalls: 1, maxToolCalls: 1, maxCostUsd: 1 }, prices: { inputPerMillion: 1, outputPerMillion: 1, maxOutputTokens: 1, version: 'synthetic-report-fixture' } }));
  const path = 'packages/application/src/task-brief.ts';
  const before = hashValue('synthetic before'), after = hashValue('synthetic after');
  function source(sha256: string): SourceManifest { const files = [{ path, sha256 }, { path: 'pnpm-lock.yaml', sha256: hashValue('synthetic lockfile') }].sort((a, b) => a.path.localeCompare(b.path)); return { version: '1', files, sourceHash: hashValue(files) }; }
  const manifest = StudyManifestSchema.parse({
    kind: 'pm-tools-study-manifest', version: 1, studyId: 'report-fixture', preregisteredAt: '2026-11-13T00:00:00.000Z', harnessHash: hashValue('synthetic report fixture'),
    evidenceKind: 'report-fixture', stage: 'exploration', arm: 'dovspace', taskIds: ['K02'], repetitions: 1, primaryMetric: 'inputTokens',
    maxTotalCostUsd: 2,
    samplePlan: { rationale: 'Synthetic report-validator fixture, not an experiment', stoppingRule: 'fixed-complete-design', independentConfirmation: false },
    controls, observationPolicy: { collectorVersion: 'pm-tools-v1', requestLogging: 'private-redacted', optionalObservers: 'disabled', skills: 'disabled', toolLoadMode: 'essential' }, requiredTools: ['pm_task_brief'], safetyEvidence: null,
    variants: { baseline: { sourceRoot: '/REPORT-FIXTURE/baseline', sourceManifest: source(before) }, candidate: { sourceRoot: '/REPORT-FIXTURE/candidate', sourceManifest: source(after) } },
    treatment: [{ path, baseline: before, candidate: after, rationale: 'Synthetic verifier input only; not actual product source' }],
  });
  const runs: RunResult[] = STUDY_VARIANTS.map((variant, order) => {
    const sourceManifest = manifest.variants[variant].sourceManifest;
    const admittedAt = '2026-11-13T00:00:01.000Z';
    const environmentEvidence = { sourceHash: sourceManifest.sourceHash, sourceFiles: sourceManifest.files, sourceFileCount: sourceManifest.files.length, lockfileHash: sourceManifest.files.find(file => file.path === 'pnpm-lock.yaml')!.sha256, imageIds: { agent: 'synthetic-image' }, nodeVersion: 'synthetic-node', isolationPolicy: { synthetic: true }, dependencyManifest: [], provider: { synthetic: true }, observationPolicy: manifest.observationPolicy, runtimeKind: 'report-fixture', protocolScriptHash: null };
    const definition = getTaskDefinition('K02');
    return {
      runId: `fixture-${variant}`, taskId: 'K02', taskVersion: definition.taskVersion, fixtureVersion: definition.fixtureVersion, arm: manifest.arm, agent: 'SYNTHETIC-REPORT-FIXTURE', model: controls.model,
      success: false, safetyGate: { passed: false, checks: [], violations: [] }, checkpointScore: 0, phaseResults: [],
      usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, modelCalls: null, toolCalls: null }, timeMs: 0, unexpectedMutations: [], artifacts: {},
      reproducibility: {
        controlTransport: controls.controlTransport,
        fixtureId: `synthetic-fixture-${variant}`, fixtureSemanticHash: hashValue('synthetic semantics'), environmentHash: hashValue(environmentEvidence), effectiveModelSettingsHash: null,
        modelConfigHash: hashValue({ provider: controls.provider, model: controls.model, modelOptions: controls.modelOptions, providerEndpoint: controls.providerEndpoint ?? null, providerBinary: controls.providerBinary, providerApi: controls.providerApi, ompModel: controls.ompModel ?? null, temperature: 1, prices: controls.prices ?? null }),
        budgetHash: hashValue(boundedBudget(definition.budget, controls.budget)),
        permissionsHash: hashValue({ task: definition.id, tools: nativeToolPolicy(definition.id, definition.allowedTools), targets: definition.targetKeys, filesystem: 'same-original-public-fixture', network: 'none+fixed-provider-and-owned-pm-broker' }),
      },
      study: { version: 1, studyId: manifest.studyId, manifestHash: hashValue(manifest), harnessHash: manifest.harnessHash, admittedAt, variant, blockId: `${manifest.studyId}:K02:0`, repeat: 0, order: order as 0 | 1, sourceManifest, environmentEvidence, sessions: [], generations: [], operationIds: [] },
      humanInterventions: { count: null, definition: 'Report fixture', reason: 'Not observed' }, rework: { count: null, denominator: null, proportion: null, definition: 'Report fixture', reason: 'Not observed' },
      failure: { category: 'infrastructure', message: 'Report fixture: no runtime, grading or inference was performed', evidence: [] },
    };
  });
  return { manifest, runs };
}
