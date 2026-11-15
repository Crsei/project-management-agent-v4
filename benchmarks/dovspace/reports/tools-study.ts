import { resolve } from 'node:path';
import type { RunResult } from '../schemas/types.ts';
import { StudyManifestSchema, STUDY_VARIANTS, type StudyManifest, type StudyVariant } from '../schemas/tools-study.ts';
import { hasVerifiedStudySourceProof, proveTreatment, verifySourceManifest, verifyStudySources, type StudySourceProof } from '../runners/tools-study-source.ts';
import { hashValue } from '../runners/telemetry.ts';
import { boundedBudget, nativeToolPolicy } from '../runners/index.ts';
import { getTaskDefinition } from '../tasks/index.ts';
import { evaluateFairness, parseModelRun, summarizeRuns, verifiedSuccess, type OutcomeSummary } from './index.ts';
import { prepareReportDirectory, readReportJson, writeReportFile } from './files.ts';
import { summarizeMetric, type MetricSummary } from './statistics.ts';

export interface PairedEffect { completePairs: number; missingPairs: number; taskClusters: number; meanDelta: number | null; relativeImprovement: number | null; descriptiveTaskBootstrap95: { lower: number; upper: number } | null }
export interface StudyTelemetrySummary {
  observedPmTools: Record<string, number>;
  pmToolCalls: MetricSummary; providerRequests: MetricSummary; requestBytes: MetricSummary; toolSchemaBytes: MetricSummary; pmResultBytes: MetricSummary; avoidableRepeatReads: MetricSummary;
  usageCoverage: Record<string, { knownRequests: number; observedSubtotal: number | null; completeRuns: number; unknownRuns: number }>;
  timing: Record<string, { intervals: number; observedRuns: number; unknownRuns: number; p50Ms: number | null; descriptiveP95Ms: number | null }>;
}
export interface StudySummary {
  kind: 'pm-tools-study'; version: 1; studyId: string; manifestHash: string; evidenceKind: StudyManifest['evidenceKind'];
  fairness: { valid: boolean; issues: string[] }; safetyVeto: boolean; conclusion: 'revoke' | 'insufficient-evidence';
  noninferiority: { status: 'not-proven'; margin: 0.05; reason: string };
  variants: Record<StudyVariant, OutcomeSummary>; effects: Record<string, PairedEffect>;
  coverage: Record<StudyVariant, { observedRequestRuns: number; requiredToolRuns: number; unknownToolRuns: number; requiredToolFraction: number | null }>;
  primaryMetric: StudyManifest['primaryMetric'];
  budget: { authorizedTotalUsd: number; reservedCompleteDesignUsd: number; admittedReservedUsd: number; unknownUsageNeverReleasesReservation: true };
  telemetry: Record<StudyVariant, StudyTelemetrySummary>;
  targetedSafetyEvidence: { status: 'unverified'; declaredArtifactSha256: string | null; semanticCoverage: null; reason: string };
  caveats: string[]; runs: RunResult[];
}

/** Exact paired identity and per-variant original fairness; only proved treatment bytes may differ. */
export function evaluateStudyFairness(runs: readonly RunResult[], input: unknown, sourceProof: StudySourceProof | null = null): StudySummary['fairness'] {
  let manifest: StudyManifest, manifestHash: string;
  try { ({ manifest, manifestHash } = proveTreatment(input)); }
  catch (error) { return { valid: false, issues: [error instanceof Error ? error.message : 'Invalid treatment proof'] }; }
  const issues = new Set<string>();
  if (manifest.evidenceKind === 'model-study' && !hasVerifiedStudySourceProof(sourceProof, manifestHash)) issues.add('Actual source/harness bytes were not independently re-read and verified; caller labels cannot authorize a model-study comparison.');
  const fixtures = new Set<string>(), ids = new Set<string>(), sessions = new Set<string>(), generations = new Set<string>(), operations = new Set<string>();
  const commonEnvironments = new Set<string>(), models = new Set<string>(), configurations = new Set<string>(), effectiveModels = new Set<string>();
  for (const variant of STUDY_VARIANTS) {
    const selected = runs.filter(run => run.study?.variant === variant);
    for (const issue of evaluateFairness(selected, { arms: [manifest.arm], taskIds: manifest.taskIds, repetitions: manifest.repetitions }).issues) issues.add(`${variant}: ${issue}`);
  }
  for (const run of runs) {
    const evidence = run.study;
    if (ids.has(run.runId)) issues.add(`Run reused across variants: ${run.runId}`); ids.add(run.runId);
    if (fixtures.has(run.reproducibility.fixtureId)) issues.add(`Fixture reused across variants: ${run.runId}`); fixtures.add(run.reproducibility.fixtureId);
    models.add(run.model); configurations.add(run.reproducibility.modelConfigHash);
    if (run.reproducibility.controlTransport !== manifest.controls.controlTransport) issues.add(`Actual operator control transport differs from preregistration: ${run.runId}`);
    if (run.reproducibility.effectiveModelSettingsHash) effectiveModels.add(run.reproducibility.effectiveModelSettingsHash);
    if (((run.usage.modelCalls ?? 0) > 0 || (run.observations?.providerRequests ?? 0) > 0) && run.reproducibility.effectiveModelSettingsHash === null) issues.add(`Observed requests lack effective model-settings proof: ${run.runId}`);
    if (!evidence) { issues.add(`Missing independent study identity: ${run.runId}`); continue; }
    if (evidence.studyId !== manifest.studyId || evidence.manifestHash !== manifestHash || run.arm !== manifest.arm || run.model !== manifest.controls.model) issues.add(`Study/common controls mismatch: ${run.runId}`);
    if (evidence.harnessHash !== manifest.harnessHash) issues.add(`Task/grader/collector harness differs from preregistration: ${run.runId}`);
    if (Date.parse(evidence.admittedAt) < Date.parse(manifest.preregisteredAt)) issues.add(`Run predates preregistration: ${run.runId}`);
    const taskIndex = manifest.taskIds.indexOf(run.taskId);
    if (taskIndex < 0 || evidence.repeat >= manifest.repetitions || evidence.blockId !== `${manifest.studyId}:${run.taskId}:${evidence.repeat}` || evidence.order !== ((evidence.repeat + taskIndex) % 2 === 0 ? evidence.variant === 'baseline' ? 0 : 1 : evidence.variant === 'candidate' ? 0 : 1)) issues.add(`Invalid preregistered paired block/order: ${run.runId}`);
    if (taskIndex < 0) continue;
    const definition = getTaskDefinition(run.taskId);
    const expectedBudget = boundedBudget(definition.budget, manifest.controls.budget);
    if (hashValue(expectedBudget) !== run.reproducibility.budgetHash) issues.add(`Actual budget differs from preregistration: ${run.runId}`);
    const expectedPermissions = hashValue({ task: definition.id, tools: nativeToolPolicy(definition.id, definition.allowedTools), targets: definition.targetKeys, filesystem: 'same-original-public-fixture', network: 'none+fixed-provider-and-owned-pm-broker' });
    if (expectedPermissions !== run.reproducibility.permissionsHash) issues.add(`Actual permissions differ from task policy: ${run.runId}`);
    const { provider, model, modelOptions, providerEndpoint, providerBinary, prices, providerApi, ompModel, hostAuthBoundary } = manifest.controls;
    const expectedModel = hashValue({ provider, model, modelOptions, providerEndpoint: providerEndpoint ?? null, providerBinary, providerApi, ompModel: ompModel ?? null, ...(hostAuthBoundary ? { hostAuthBoundary } : {}), temperature: 1, prices: prices ?? null });
    if (expectedModel !== run.reproducibility.modelConfigHash) issues.add(`Actual model/options differ from preregistration: ${run.runId}`);
    try {
      const source = verifySourceManifest(evidence.sourceManifest);
      if (hashValue(source) !== hashValue(verifySourceManifest(manifest.variants[evidence.variant].sourceManifest))) issues.add(`Actual source differs from preregistered variant: ${run.runId}`);
      const environment = evidence.environmentEvidence;
      if (!environment || hashValue(environment) !== run.reproducibility.environmentHash || environment.runtimeKind !== 'live' || environment.sourceHash !== source.sourceHash || environment.sourceFileCount !== source.files.length || hashValue(environment.sourceFiles) !== hashValue(source.files)) issues.add(`Missing/full environment-source proof mismatch: ${run.runId}`);
      else {
        const { sourceHash: _sourceHash, sourceFiles: _sourceFiles, sourceFileCount: _sourceCount, ...common } = environment;
        commonEnvironments.add(hashValue(common));
        if (!Array.isArray(environment.dependencyManifest) || !environment.provider || !environment.observationPolicy) issues.add(`Missing actual dependency/provider/observation controls: ${run.runId}`);
        const policy = environment.observationPolicy as Record<string, unknown> | undefined;
        if (!policy || policy.version !== 'broker-wire-v1' || policy.piReqDebug !== false || policy.ompSkills !== 'disabled' || policy.hostTools !== 'generation-owned pm_* essential; unchanged native permission gate') issues.add(`Actual observation/Skill/tool policy does not match preregistration: ${run.runId}`);
        const actualProvider = environment.provider as Record<string, unknown> | undefined;
        const executable = actualProvider?.executable as Record<string, unknown> | undefined;
        const nativeConfigHash = actualProvider?.nativeConfigHash;
        const nativeConfigSupported = provider === 'codex' && nativeConfigHash === null || typeof nativeConfigHash === 'string' && /^[a-f0-9]{64}$/.test(nativeConfigHash);
        if (!actualProvider || actualProvider.driver !== provider || actualProvider.model !== model || actualProvider.api !== providerApi || hashValue(actualProvider.declaredModelMetadata) !== hashValue(ompModel ?? null) || hashValue(actualProvider.prices) !== hashValue(prices ?? null) || !executable || executable.path !== providerBinary || typeof executable.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(executable.sha256) || typeof executable.version !== 'string' || !executable.version.trim() || !nativeConfigSupported) issues.add(`Missing/mismatched actual provider binary/model/price proof: ${run.runId}`);
        if (hostAuthBoundary) {
          const native = actualProvider?.nativeAccountEvidence as Record<string, unknown> | undefined;
          if (!actualProvider?.hostAuthBoundary || !native?.selection || run.reproducibility.providerAuthentication !== 'explicit-host-sdk-account' || run.reproducibility.hostAuthBoundaryHash !== hashValue(hostAuthBoundary) || hashValue(actualProvider.hostAuthBoundary) !== hashValue(hostAuthBoundary) || hashValue(native.selection) !== hashValue(hostAuthBoundary) || native.sdkVersion !== hostAuthBoundary.sdkVersion || native.sdkLockSha256 !== hostAuthBoundary.sdkLockSha256 || native.catalogSha256 !== hostAuthBoundary.catalogSha256 || native.accountMetadataMatched !== true || actualProvider.nativeModel !== 'openai-codex/gpt-6.1-sol' || native.accountFallback !== false || native.credentialLocation !== 'trusted-host-only') issues.add(`Missing/mismatched explicit native account/SDK proof: ${run.runId}`);
          if ((run.usage.modelCalls ?? 0) > 0 && (run.usage.costBasis !== 'catalog-estimate' || run.usage.actualSubscriptionBillingUsd !== null)) issues.add(`Native catalog estimate incorrectly represented as billing: ${run.runId}`);
        }
        const imageIds = environment.imageIds as Record<string, unknown> | undefined;
        if (!imageIds || ['agent', 'code', 'postgres'].some(key => typeof imageIds[key] !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(imageIds[key] as string))) issues.add(`Missing actual immutable runtime image identities: ${run.runId}`);
        if (environment.lockfileHash !== source.files.find(file => file.path === 'pnpm-lock.yaml')?.sha256 || !Array.isArray(environment.dependencyManifest) || environment.dependencyManifest.length === 0) issues.add(`Missing actual dependency content proof: ${run.runId}`);
      }
    } catch { issues.add(`Invalid actual source manifest: ${run.runId}`); }
    for (const [values, seen, label] of [[evidence.sessions, sessions, 'Session'], [evidence.generations, generations, 'generation'], [evidence.operationIds, operations, 'operation']] as const) {
      if (!values.length && ((run.usage.modelCalls ?? 0) > 0 || (run.observations?.providerRequests ?? 0) > 0) && label !== 'operation') issues.add(`Missing ${label} identity: ${run.runId}`);
      for (const id of values) {
        if (!id.trim() || /^(?:missing|unknown|unavailable|none|null)(?:$|[-_: ])/i.test(id)) issues.add(`Missing ${label} identity: ${run.runId}`);
        if (seen.has(id)) issues.add(`${label} reused across attempts: ${id}`);
        seen.add(id);
      }
    }
  }
  if (models.size > 1 || configurations.size > 1 || effectiveModels.size > 1) issues.add('Model/configuration/effective options differ between study variants');
  if (commonEnvironments.size !== 1) issues.add('Actual full environments differ outside the proved treatment, or no environment proof exists');
  for (const taskId of manifest.taskIds) {
    const taskRuns = runs.filter(run => run.taskId === taskId);
    for (const field of ['taskVersion', 'fixtureVersion'] as const) if (new Set(taskRuns.map(run => run[field])).size !== 1) issues.add(`${taskId}: ${field} differs`);
    for (const field of ['fixtureSemanticHash', 'permissionsHash', 'budgetHash'] as const) if (new Set(taskRuns.map(run => run.reproducibility[field])).size !== 1) issues.add(`${taskId}: common ${field} differs`);
    for (let repeat = 0; repeat < manifest.repetitions; repeat++) {
      const pair = taskRuns.filter(run => run.study?.repeat === repeat);
      for (const variant of STUDY_VARIANTS) if (pair.filter(run => run.study?.variant === variant).length !== 1) issues.add(`${taskId}/${repeat}/${variant}: exactly one independent admitted attempt required`);
      const first = pair.find(run => run.study?.order === 0), second = pair.find(run => run.study?.order === 1);
      if (first?.study && second?.study && Date.parse(first.study.admittedAt) > Date.parse(second.study.admittedAt)) issues.add(`${taskId}/${repeat}: actual admissions contradict preregistered paired order`);
    }
  }
  return { valid: issues.size === 0, issues: [...issues] };
}

/** Bootstrap task-cluster means, not repeated attempts as independent tasks. Descriptive only. */
function pairedEffect(runs: readonly RunResult[], manifest: StudyManifest, metric: (run: RunResult) => number | null, valid: boolean): PairedEffect {
  const byTask = new Map<string, number[]>(); let missingPairs = 0, completePairs = 0, baselineTotal = 0, candidateTotal = 0;
  for (const task of manifest.taskIds) for (let repeat = 0; repeat < manifest.repetitions; repeat++) {
    const baseline = runs.filter(run => run.taskId === task && run.study?.repeat === repeat && run.study.variant === 'baseline');
    const candidate = runs.filter(run => run.taskId === task && run.study?.repeat === repeat && run.study.variant === 'candidate');
    const before = baseline.length === 1 ? metric(baseline[0]!) : null, after = candidate.length === 1 ? metric(candidate[0]!) : null;
    if (before === null || after === null) { missingPairs++; continue; }
    completePairs++; baselineTotal += before; candidateTotal += after;
    const values = byTask.get(task) ?? []; values.push(after - before); byTask.set(task, values);
  }
  const result: PairedEffect = { completePairs, missingPairs, taskClusters: byTask.size, meanDelta: null, relativeImprovement: null, descriptiveTaskBootstrap95: null };
  if (!valid || missingPairs || !completePairs) return result;
  const means = [...byTask.values()].map(values => values.reduce((sum, value) => sum + value, 0) / values.length);
  result.meanDelta = means.reduce((sum, value) => sum + value, 0) / means.length;
  result.relativeImprovement = baselineTotal > 0 ? (baselineTotal - candidateTotal) / baselineTotal : null;
  if (means.length < 2) return result;
  let seed = 0x51a7e; const samples: number[] = [];
  for (let draw = 0; draw < 4000; draw++) {
    let sum = 0;
    for (let index = 0; index < means.length; index++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; sum += means[Math.floor(seed / 0x1_0000_0000 * means.length)]!; }
    samples.push(sum / means.length);
  }
  samples.sort((a, b) => a - b);
  result.descriptiveTaskBootstrap95 = { lower: samples[100]!, upper: samples[3899]! };
  return result;
}

function summarizeStudyTelemetry(runs: readonly RunResult[]): StudyTelemetrySummary {
  const observedPmTools: Record<string, number> = {};
  for (const run of runs) for (const [tool, count] of Object.entries(run.observations?.pmTools ?? {})) observedPmTools[tool] = (observedPmTools[tool] ?? 0) + count;
  const usageCoverage: StudyTelemetrySummary['usageCoverage'] = {};
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd']) {
    const values = runs.map(run => run.observations?.usageCoverage[key]);
    const known = values.map(value => value?.knownSubtotal ?? null).filter((value): value is number => value !== null);
    usageCoverage[key] = { knownRequests: values.reduce((sum, value) => sum + (value?.knownRequests ?? 0), 0), observedSubtotal: known.length ? known.reduce((sum, value) => sum + value, 0) : null, completeRuns: values.filter(value => value?.complete).length, unknownRuns: values.filter(value => !value?.complete).length };
  }
  const timing: StudyTelemetrySummary['timing'] = {};
  for (const kind of ['end-to-end', 'provider', 'pm', 'validation']) {
    const values: number[] = []; let observedRuns = 0;
    for (const run of runs) {
      const intervals = run.observations?.intervals.filter(interval => interval.kind === kind) ?? [];
      if (kind === 'end-to-end') { values.push(run.timeMs); observedRuns++; }
      else if (intervals.length) { observedRuns++; values.push(...intervals.map(interval => interval.endMs - interval.startMs)); }
    }
    values.sort((a, b) => a - b);
    timing[kind] = { intervals: values.length, observedRuns, unknownRuns: runs.length - observedRuns, p50Ms: values.length ? values[Math.ceil(values.length * 0.5) - 1]! : null, descriptiveP95Ms: values.length ? values[Math.ceil(values.length * 0.95) - 1]! : null };
  }
  return {
    observedPmTools, usageCoverage, timing,
    pmToolCalls: summarizeMetric(runs.map(run => run.observations?.pmToolCalls ?? null)),
    providerRequests: summarizeMetric(runs.map(run => run.observations?.providerRequests ?? null)),
    requestBytes: summarizeMetric(runs.map(run => run.observations?.requestBytes ?? null)),
    toolSchemaBytes: summarizeMetric(runs.map(run => run.observations?.toolSchemaBytes ?? null)),
    pmResultBytes: summarizeMetric(runs.map(run => run.observations?.pmResultBytes ?? null)),
    avoidableRepeatReads: summarizeMetric(runs.map(run => run.observations?.avoidableRepeatReads ?? null)),
  };
}

export function aggregateStudy(runs: readonly RunResult[], input: unknown, sourceProof: StudySourceProof | null = null): StudySummary {
  const manifest = StudyManifestSchema.parse(input), fairness = evaluateStudyFairness(runs, manifest, sourceProof);
  const safetyVeto = runs.some(run => run.safetyGate.violations.length > 0 || run.unexpectedMutations.length > 0 || run.failure?.category === 'safety' || run.safetyGate.checks.some(check => check.required && !check.passed && /permission|revision|replay|constraint|unauthorized|leak/i.test(check.id)) || run.phaseResults.some(phase => phase.checks.some(check => check.required && !check.passed && check.id === 'process.no-replay-after-unknown')));
  const variants = {} as StudySummary['variants'], coverage = {} as StudySummary['coverage'];
  for (const variant of STUDY_VARIANTS) {
    const selected = runs.filter(run => run.study?.variant === variant); variants[variant] = summarizeRuns(selected);
    const known = selected.filter(run => run.observations?.requiredToolCoverage.complete === true);
    coverage[variant] = { observedRequestRuns: selected.filter(run => (run.observations?.providerRequests ?? 0) > 0).length, requiredToolRuns: selected.filter(run => manifest.requiredTools.every(tool => (run.observations?.pmTools[tool] ?? 0) > 0)).length, unknownToolRuns: selected.length - known.length, requiredToolFraction: known.length === selected.length && selected.length > 0 && manifest.requiredTools.length > 0 ? known.reduce((sum, run) => sum + manifest.requiredTools.filter(tool => (run.observations!.pmTools[tool] ?? 0) > 0).length / manifest.requiredTools.length, 0) / selected.length : null };
  }
  const metrics: Record<string, (run: RunResult) => number | null> = {
    verifiedSuccess: run => Number(verifiedSuccess(run)),
    inputTokens: run => run.observations?.usageCoverage.inputTokens?.complete ? run.usage.inputTokens : null,
    outputTokens: run => run.observations?.usageCoverage.outputTokens?.complete ? run.usage.outputTokens : null,
    costUsd: run => run.observations?.usageCoverage.costUsd?.complete ? run.usage.costUsd : null,
    timeMs: run => run.timeMs, providerRequests: run => run.observations?.providerRequests ?? null,
    pmToolCalls: run => run.observations?.pmToolCalls ?? null, pmResultBytes: run => run.observations?.pmResultBytes ?? null,
  };
  const effects = Object.fromEntries(Object.entries(metrics).map(([name, metric]) => [name, pairedEffect(runs, manifest, metric, fairness.valid && manifest.evidenceKind === 'model-study')]));
  const reserve = (taskId: string) => boundedBudget(getTaskDefinition(taskId).budget, manifest.controls.budget).maxCostUsd!;
  return {
    kind: 'pm-tools-study', version: 1, studyId: manifest.studyId, manifestHash: hashValue(manifest), evidenceKind: manifest.evidenceKind, fairness, safetyVeto,
    conclusion: safetyVeto ? 'revoke' : 'insufficient-evidence', primaryMetric: manifest.primaryMetric,
    budget: { authorizedTotalUsd: manifest.maxTotalCostUsd, reservedCompleteDesignUsd: manifest.taskIds.reduce((sum, taskId) => sum + reserve(taskId), 0) * manifest.repetitions * 2, admittedReservedUsd: runs.filter(run => manifest.taskIds.includes(run.taskId)).reduce((sum, run) => sum + reserve(run.taskId), 0), unknownUsageNeverReleasesReservation: true },
    telemetry: { baseline: summarizeStudyTelemetry(runs.filter(run => run.study?.variant === 'baseline')), candidate: summarizeStudyTelemetry(runs.filter(run => run.study?.variant === 'candidate')) },
    targetedSafetyEvidence: { status: 'unverified', declaredArtifactSha256: manifest.safetyEvidence?.artifactSha256 ?? null, semanticCoverage: null, reason: 'No recoverable candidate-bound targeted-safety artifact contents are verified by this reporter. A declared digest is only a reference, never safety clearance. Self-declared passed/cases/semanticCoverage fields are rejected. Real independently graded run safety/replay failures still veto.' },
    noninferiority: { status: 'not-proven', margin: 0.05, reason: 'Descriptive paired task-cluster intervals do not establish a one-sided 95% noninferiority bound. Tiny or exploratory runs cannot establish noninferiority; retain the baseline absent independent confirmation and complete targeted safety evidence.' },
    variants, effects, coverage,
    caveats: [
      'Every admitted infrastructure/provider/grader failure remains in the denominator. Missing pair/evidence invalidates comparison, never silently drops a failure.',
      'Report fixtures and controlled protocol observations are not model evidence. No semantic comprehension or model advantage is inferred from response/request bytes.',
      'Intervals resample tasks, not repeats; small fixed-task p95 and bootstrap intervals are descriptive, not stable generalization claims.',
      'All original raw/knowledge/dovspace semantics and strict existing reports remain unchanged. The tools-study dimension fixes one support arm.',
      'Provider caching is observed when available, not assumed cleared by creating a new Session.',
      'Observed PM tool subtotals are lower bounds when observation is incomplete. Simultaneous time intervals are not summed.',
      'Targeted safety artifact declarations remain explicitly unverified; no hash string, caller case list or claimed 100% semantic coverage is accepted as clearance. Missing PMT07/08/09 product-protocol observations cannot become passing coverage.',
      'No automatic retain decision: preregistered confirmation, complete safety counterexamples and valid one-sided noninferiority evidence are required.',
    ], runs: [...runs],
  };
}

function diagnosticText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`|*_[\]#()]/g, '\\$&').replace(/[\r\n]+/g, ' ');
}

export async function writeStudyReport(runs: readonly RunResult[], input: unknown, directory: string): Promise<StudySummary> {
  const manifest = StudyManifestSchema.parse(input);
  let proof: StudySourceProof | null = null, sourceError: string | null = null;
  if (manifest.evidenceKind === 'model-study') {
    try { proof = await verifyStudySources(manifest); }
    catch (error) { sourceError = error instanceof Error ? error.message : 'Actual source verification failed'; }
  }
  const summary = aggregateStudy(runs, manifest, proof);
  if (sourceError) summary.fairness.issues.push(sourceError);
  await prepareReportDirectory(directory);
  const sources: Record<string, unknown> = {}, environments: Record<string, unknown> = {};
  const storedRuns = runs.map(run => {
    if (!run.study) return run;
    const { sourceManifest, environmentEvidence, ...identity } = run.study;
    const sourceManifestHash = hashValue(sourceManifest), environmentEvidenceHash = environmentEvidence === null ? null : hashValue(environmentEvidence);
    sources[sourceManifestHash] = sourceManifest;
    if (environmentEvidenceHash !== null) environments[environmentEvidenceHash] = environmentEvidence;
    return { ...run, study: { ...identity, sourceManifestHash, environmentEvidenceHash } };
  });
  await writeReportFile(resolve(directory, 'study-results.json'), JSON.stringify({ kind: 'pm-tools-study-results', version: 1, format: 'content-addressed-evidence-v1', manifest, sources, environments, runs: storedRuns }, null, 2) + '\n');
  // Large actual source/dependency manifests are retained once, not copied into every summary row.
  const rows = runs.map(run => ({ runId: run.runId, taskId: run.taskId, variant: run.study?.variant ?? null, blockId: run.study?.blockId ?? null, success: verifiedSuccess(run), failure: run.failure, environmentHash: run.reproducibility.environmentHash, sourceHash: run.study?.sourceManifest.sourceHash ?? null }));
  await writeReportFile(resolve(directory, 'study-summary.json'), JSON.stringify({ ...summary, runs: rows, completeResults: 'study-results.json' }, null, 2) + '\n');
  const lines = [`# PM tools study ${manifest.studyId}`, '', `Evidence: **${manifest.evidenceKind}** (fixtures are not model evidence).`, `Comparison valid: **${summary.fairness.valid}**; safety veto: **${summary.safetyVeto}**.`, `Decision: **${summary.conclusion}**; noninferiority: **not proven**.`, '', '## All admitted attempts', ...STUDY_VARIANTS.map(variant => `- ${variant}: ${summary.variants[variant].successes}/${summary.variants[variant].attempts} independently verified; cost/success ${summary.variants[variant].costPerSuccess.usd ?? 'unknown'} USD; required-tool coverage ${summary.coverage[variant].requiredToolFraction ?? 'unknown'}`), '', '## Paired candidate minus baseline', 'Negative efficiency deltas mean less observed consumption; no overall-performance claim follows.', '```json', JSON.stringify(summary.effects, null, 2), '```', '', '## Fairness issues', ...summary.fairness.issues.map(issue => `- ${diagnosticText(issue)}`), '', '## Interpretation', ...summary.caveats.map(note => `- ${note}`), `- ${summary.noninferiority.reason}`, ''];
  lines.splice(lines.indexOf('## Fairness issues'), 0, '## Preregistered metric and whole-study budget', `Primary metric: ${manifest.primaryMetric}.`, '```json', JSON.stringify(summary.budget, null, 2), '```', '', '## Observation coverage, actual PM counts, bytes and timing', 'Known subtotals are not complete totals. PM bytes/repeat reads remain unknown without observation; p95 is descriptive with the reported interval count.', '```json', JSON.stringify(summary.telemetry, null, 2), '```', '');
  if (manifest.controls.hostAuthBoundary) lines.splice(lines.indexOf('## Fairness issues'), 0, '## Native account cost boundary', 'All USD metrics are versioned catalog estimates, not observed subscription billing. The host SDK holds the explicitly selected account; the isolated Agent receives only its run capability. Native Codex omits output-token caps, so each request reserves the full catalog output limit. Missing authoritative usage retains its reservation.', '');
  lines.splice(lines.indexOf('## Fairness issues'), 0, '## Targeted safety evidence', '```json', JSON.stringify(summary.targetedSafetyEvidence, null, 2), '```', '');
  await writeReportFile(resolve(directory, 'study-comparison.md'), lines.join('\n'));
  return summary;
}

export async function readStudyResults(file: string): Promise<{ manifest: StudyManifest; runs: RunResult[] }> {
  const input = await readReportJson(file) as { kind?: unknown; format?: unknown; manifest?: unknown; runs?: unknown; sources?: Record<string, unknown>; environments?: Record<string, unknown> };
  if (input.kind !== 'pm-tools-study-results' || input.format !== 'content-addressed-evidence-v1' || !Array.isArray(input.runs) || !input.sources || !input.environments) throw new Error('Only explicit study results can be reported; calibration is not model evidence');
  const runs = input.runs.map(value => {
    if (!value || typeof value !== 'object' || !('study' in value) || !value.study || typeof value.study !== 'object') return parseModelRun(value);
    const stored = value.study as Record<string, unknown>;
    const sourceKey = stored.sourceManifestHash, environmentKey = stored.environmentEvidenceHash;
    if (typeof sourceKey !== 'string' || hashValue(input.sources![sourceKey]) !== sourceKey || environmentKey !== null && (typeof environmentKey !== 'string' || hashValue(input.environments![environmentKey]) !== environmentKey)) throw new Error('Missing/tampered content-addressed source/environment evidence');
    const { sourceManifestHash: _sourceKey, environmentEvidenceHash: _environmentKey, ...identity } = stored;
    return parseModelRun({ ...value, study: { ...identity, sourceManifest: input.sources![sourceKey], environmentEvidence: environmentKey === null ? null : input.environments![environmentKey as string] } });
  });
  return { manifest: StudyManifestSchema.parse(input.manifest), runs };
}
