import { constants, type Stats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, open, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { benchmarkConfig } from '../benchmark.config.ts';
import type { GradeInput, GradeResult } from '../graders/types.ts';
import { prepareReportDirectory } from '../reports/files.ts';
import { ArtifactManifestSchema, EVIDENCE_ARCHIVE_BOUNDS, EvaluationAdmissionSchema, EvaluationAttemptSchema, EvaluatorVersionSchema, FrozenGradeInputChunksSchema, FrozenGradeInputSchema, GradeRunSchema, SealedHostCaptureSchema, type ArtifactManifest, type EvaluationAdmission, type EvaluationAttempt, type EvaluatorVersion, type FrozenGradeInput } from '../schemas/evaluation.ts';
import { RunResultSchema, type BenchEvent, type RunResult, type TaskDefinition } from '../schemas/types.ts';
import { assertEvaluatorIdentity, bytesHash, criterionRequirementRevision, currentEvaluatorVersion, evidenceHash } from './evaluator.ts';
import { getTaskDefinition } from '../tasks/index.ts';
import { emptyUsage } from '../runners/telemetry.ts';
import { captureDigest, signCapture, type CaptureSigner } from './capture.ts';
import { prepareExperimentAdmission, recordExperimentAdmission, recordExperimentSeal } from './experiment-ledger.ts';
import { captureGradingPopulations, GradingPopulationProofSchema, originalSafetyPopulationReferences, verifyRetainedGradingPopulations, type GradingPopulationProof } from './populations.ts';
import type { RunExperimentSelection } from './run-admission.ts';

export interface VerifiedEvidenceArchive { root: string; legacy: boolean; manifestSha256: string | null; manifest: ArtifactManifest | null; admission: EvaluationAdmission | null; attempt: EvaluationAttempt | null; evaluator: EvaluatorVersion | null; inputs: FrozenGradeInput | null; result: RunResult | null; populationProof: GradingPopulationProof | null }
export interface SealedEvidence { manifestSha256: string; manifest: ArtifactManifest; initialGradePath: string; initialGradeSha256: string; captureAttestationPath?: string; captureAttestationSha256?: string }
export interface EvidenceAdmissionContext { root: string; admission: EvaluationAdmission; evaluator: EvaluatorVersion; captureSigner?: CaptureSigner; ledgerRoot?: string }
export interface EvidenceAdmissionOptions { root: string; runId: string; task: TaskDefinition; arm: EvaluationAdmission['arm']; producer: EvaluationAdmission['producer']; modelConfigSha256: string; toolPolicySha256: string; harnessSha256: string; productSha256: string | null; codeImage: string; evaluator?: EvaluatorVersion; calibrationBytes?: Buffer; registeredDataset?: { dataset: EvaluationAdmission['dataset']; member: NonNullable<EvaluationAdmission['datasetMember']> }; captureSigner?: CaptureSigner; experiment?: RunExperimentSelection }
export function assertReservedOutput(directory: string): string {
  const absolute = path.resolve(directory), relative = path.relative(benchmarkConfig.outputsRoot, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Evaluation output must be a new directory inside reserved benchmark outputs');
  return absolute;
}
function assertEvidenceFile(info: Stats): void {
  if (!info.isFile() || info.nlink !== 1 || info.size > EVIDENCE_ARCHIVE_BOUNDS.fileBytes) throw new Error('Evidence must be a bounded single-link regular file');
}
function sameEvidenceFile(before: Stats, after: Stats): boolean {
  return before.ino === after.ino && before.dev === after.dev && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.nlink === after.nlink && before.mode === after.mode;
}
export async function safeEvidenceBytes(filename: string): Promise<Buffer> {
  const absolute = path.resolve(filename), parent = path.dirname(absolute);
  if (await realpath(parent) !== parent) throw new Error('Evidence input has a redirected ancestor');
  const expected = await lstat(absolute); assertEvidenceFile(expected);
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat(); assertEvidenceFile(before);
    if (!sameEvidenceFile(expected, before)) throw new Error('Evidence changed before reading');
    // Read at most the declared bounded size plus one byte, even if another writer grows it.
    const bytes = Buffer.allocUnsafe(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await handle.stat(), current = await lstat(absolute);
    assertEvidenceFile(after); assertEvidenceFile(current);
    if (!sameEvidenceFile(before, after) || !sameEvidenceFile(before, current) || count !== before.size || await realpath(parent) !== parent) throw new Error('Evidence changed while reading');
    return bytes.subarray(0, count);
  } finally { await handle.close(); }
}
export async function safeEvidenceJson(filename: string): Promise<unknown> {
  const bytes = await safeEvidenceBytes(filename);
  try { return JSON.parse(bytes.toString('utf8')) as unknown; } catch { throw new Error('Malformed evidence JSON (content withheld)'); }
}
export async function writeImmutableJson(filename: string, value: unknown): Promise<void> { await writeFile(filename, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o400 }); }

const archiveMetadataNames = ['admission.json', 'admission-attestation.json', 'evaluator.json', 'calibration.json', 'attempt.json', 'result.json', 'inputs.json', 'initial-grader-result.json', 'grading-populations.json'];
const inputChunkName = /^inputs-[0-9]{6}\.bin$/;
async function writeChunkedGradeInput(root: string, input: FrozenGradeInput): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(input), 'utf8');
  if (bytes.length > EVIDENCE_ARCHIVE_BOUNDS.expandedInputBytes) throw new Error('Frozen input exceeds bounded expanded evidence size');
  const chunks: ArtifactManifest['files'] = [];
  for (let offset = 0; offset < bytes.length; offset += EVIDENCE_ARCHIVE_BOUNDS.chunkBytes) {
    const content = bytes.subarray(offset, offset + EVIDENCE_ARCHIVE_BOUNDS.chunkBytes), name = `inputs-${String(chunks.length).padStart(6, '0')}.bin`;
    await writeFile(path.join(root, name), content, { flag: 'wx', mode: 0o400 });
    chunks.push({ path: name, bytes: content.length, sha256: bytesHash(content) });
  }
  await writeImmutableJson(path.join(root, 'inputs.json'), FrozenGradeInputChunksSchema.parse({ version: '2', kind: 'frozen-grade-input-chunks', encoding: 'utf8-json', bytes: bytes.length, sha256: bytesHash(bytes), eventCount: input.events.length, chunkCount: chunks.length, chunks }));
}
async function readChunkedGradeInput(root: string, value: unknown, files: ArtifactManifest['files']): Promise<FrozenGradeInput> {
  // Only this host-owned envelope has reference semantics. Event/model JSON is never walked.
  const descriptor = FrozenGradeInputChunksSchema.parse(value), chunks = files.filter(file => inputChunkName.test(file.path));
  if (chunks.length !== descriptor.chunkCount) throw new Error('Missing or unreferenced input chunks');
  for (const [index, chunk] of descriptor.chunks.entries()) {
    const entry = chunks[index];
    if (!entry || entry.path !== chunk.path || entry.bytes !== chunk.bytes || entry.sha256 !== chunk.sha256) throw new Error('Input chunk manifest order, count or identity differs');
  }
  const expanded = Buffer.allocUnsafe(descriptor.bytes), hash = createHash('sha256');
  let offset = 0;
  for (const chunk of descriptor.chunks) {
    const content = await safeEvidenceBytes(path.join(root, chunk.path));
    if (content.length !== chunk.bytes || bytesHash(content) !== chunk.sha256) throw new Error('Archive input chunk corruption detected');
    content.copy(expanded, offset); offset += content.length; hash.update(content);
  }
  if (offset !== descriptor.bytes || hash.digest('hex') !== descriptor.sha256) throw new Error('Expanded input byte count or digest differs');
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(expanded)) as unknown; } catch { throw new Error('Malformed expanded grading input JSON'); }
  const input = FrozenGradeInputSchema.parse(decoded);
  if (input.events.length !== descriptor.eventCount) throw new Error('Expanded grading event count differs');
  return input;
}
/** No runtime, token, account/session tables, authority files or host paths survive this projection. */
export function freezeGradeInput(input: GradeInput): FrozenGradeInput {
  const snapshot = (value: GradeInput['before']) => ({ fixtureId: value.fixtureId, fixtureVersion: value.fixtureVersion, capturedAt: value.capturedAt, semanticHash: value.semanticHash, entities: value.entities, receipts: value.receipts, publicFiles: value.publicFiles });
  const allowedTargets = input.task.allowedTargets.map(target => typeof target === 'string' ? input.fixture.targets[target] : target);
  return FrozenGradeInputSchema.parse({ version: '1', taskId: input.task.id, taskVersion: input.task.taskVersion, allowedTargets, fixture: { fixtureId: input.fixture.fixtureId, fixtureVersion: input.fixture.fixtureVersion, workspaceId: input.fixture.workspaceId, targets: input.fixture.targets, isolation: input.fixture.isolation ? { verified: input.fixture.isolation.verified, proofDigest: input.fixture.isolation.proofDigest, checks: input.fixture.isolation.checks } : null }, before: snapshot(input.before), after: snapshot(input.after), events: input.events, omittedInputs: ['full-authority'] });
}
export async function admitEvidence(options: EvidenceAdmissionOptions): Promise<EvidenceAdmissionContext> {
  const root = assertReservedOutput(options.root);
  const evaluator = options.evaluator ?? await currentEvaluatorVersion(options.codeImage);
  assertEvaluatorIdentity(evaluator);
  if (evaluator.calibrationSha256 !== null && (!options.calibrationBytes || bytesHash(options.calibrationBytes) !== evaluator.calibrationSha256) || options.calibrationBytes && bytesHash(options.calibrationBytes) !== evaluator.calibrationSha256) throw new Error('Admission requires the exact validated calibration snapshot');
  if ((options.captureSigner || options.experiment) && (options.producer !== 'host-runner' || !options.captureSigner || !options.experiment || !options.registeredDataset || !options.calibrationBytes || options.productSha256 === null)) throw new Error('Authenticated host capture requires calibrated registered dataset, experiment cell and actual declared product identity');
  await prepareReportDirectory(root, true);
  const admission = EvaluationAdmissionSchema.parse({
    version: '1', admissionId: `admission-${randomUUID()}`, attemptId: `attempt-${randomUUID()}`, runId: options.runId, arm: options.arm,
    taskId: options.task.id, taskVersion: options.task.taskVersion, fixtureVersion: options.task.fixtureVersion,
    dataset: options.registeredDataset?.dataset ?? { datasetId: 'dovspace-lite-exposed-regression', version: options.task.fixtureVersion, sha256: evidenceHash({ task: options.task, fixtureDefinitionSha256: evaluator.datasetDefinitionSha256 }) },
    ...(options.registeredDataset ? { datasetMember: options.registeredDataset.member } : {}),
    ...(options.captureSigner ? { capture: { keyId: options.captureSigner.keyId, publicKeySha256: options.captureSigner.publicKeySha256 } } : {}),
    evaluatorSha256: evaluator.sha256, producer: options.producer, admittedAt: new Date().toISOString(), parentAttemptId: null,
    versions: { productSha256: options.productSha256, harnessSha256: options.harnessSha256, modelConfigSha256: options.modelConfigSha256, toolPolicySha256: options.toolPolicySha256 },
  });
  const ledgerOptions = options.captureSigner && options.experiment && options.registeredDataset ? { ledgerRoot: options.experiment.ledgerRoot, signer: options.captureSigner, cellId: options.experiment.cellId, member: { memberId: options.registeredDataset.member.memberId, memberVersion: options.registeredDataset.member.memberVersion }, archiveRoot: options.experiment.archiveRef ?? `archives/${admission.attemptId}` } : null;
  if (ledgerOptions) admission.experiment = await prepareExperimentAdmission({ ...ledgerOptions, admission });
  await writeImmutableJson(path.join(root, 'admission.json'), admission);
  await writeImmutableJson(path.join(root, 'evaluator.json'), evaluator);
  if (options.calibrationBytes) await writeFile(path.join(root, 'calibration.json'), options.calibrationBytes, { mode: 0o400, flag: 'wx' });
  if (ledgerOptions && options.captureSigner) {
    const admissionSha256 = bytesHash(await safeEvidenceBytes(path.join(root, 'admission.json')));
    const attestation = signCapture(options.captureSigner, { kind: 'dovspace-bench-admission-v1', admissionId: admission.admissionId, attemptId: admission.attemptId, arm: admission.arm, admissionSha256, evaluatorSha256: evaluator.sha256, calibrationSha256: evaluator.calibrationSha256, dataset: admission.dataset, datasetMember: admission.datasetMember!, experiment: admission.experiment!, producer: 'host-runner' });
    await writeImmutableJson(path.join(root, 'admission-attestation.json'), attestation);
    await recordExperimentAdmission({ ...ledgerOptions, admission, admissionSha256 });
  }
  return { root, admission, evaluator, ...(options.captureSigner ? { captureSigner: options.captureSigner } : {}), ...(options.experiment ? { ledgerRoot: options.experiment.ledgerRoot } : {}) };
}
export async function sealEvidence(options: EvidenceAdmissionContext & { result: RunResult; inputs?: FrozenGradeInput; events: BenchEvent[]; grade?: GradeResult; actualProductSha256?: string; actualCodeImageDigest?: string; populationProof?: GradingPopulationProof; gradingInfrastructureComplete?: boolean }): Promise<SealedEvidence> {
  const { root, admission, result } = options;
  if (result.runId !== admission.runId || result.taskId !== admission.taskId || result.taskVersion !== admission.taskVersion || result.arm !== admission.arm) throw new Error('Attempt result does not match its immutable admission');
  const inputs = options.inputs ? FrozenGradeInputSchema.parse(options.inputs) : null;
  const populationProof = options.populationProof ? GradingPopulationProofSchema.parse(options.populationProof) : null;
  if (populationProof && !inputs) throw new Error('Original grading population proof requires its retained frozen inputs');
  if (populationProof && inputs) verifyRetainedGradingPopulations(populationProof, inputs);
  const attempt = EvaluationAttemptSchema.parse({ version: '1', attemptId: admission.attemptId, admissionId: admission.admissionId, runId: admission.runId, startedAt: admission.admittedAt, sealedAt: new Date().toISOString(), status: result.failure?.category === 'interrupted' ? 'interrupted' : result.success ? 'succeeded' : inputs ? 'failed' : 'incomplete', failure: result.failure, stageEvents: options.events.filter(item => item.source !== 'agent' && ['session_started', 'phase_checkpoint', 'intervention_applied', 'execution_failed', 'cleanup_completed'].includes(item.type)).map(item => ({ type: item.type, eventId: item.id })), requirementRevisions: admission.taskId === 'L03' ? ['retry-v1', ...(options.events.some(item => item.source === 'runner' && item.type === 'intervention_applied' && item.data.action === 'change-requirement') ? ['retry-v2'] : [])] : [admission.taskVersion], inputAvailability: inputs ? ['public-snapshots', 'entities-receipts', 'events', ...(inputs.fixture.isolation ? ['isolation'] : [])] : [], usage: result.usage });
  attempt.requirementRevisions = [...new Set([admission.taskVersion, ...attempt.requirementRevisions])];
  attempt.actualVersions = { productSha256: options.actualProductSha256 ?? null, codeImageDigest: options.actualCodeImageDigest ?? null };
  attempt.executionFailure = result.safetyGate.violations.includes('Owned runtime cleanup incomplete.') ? { category: 'infrastructure', message: 'Owned runtime cleanup incomplete.', evidence: [] } : result.failure && ['infrastructure', 'provider', 'budget', 'interrupted', 'tool', 'permission', 'model', 'task'].includes(result.failure.category) ? result.failure : null;
  if (admission.versions.productSha256 !== null && attempt.actualVersions.productSha256 !== null && attempt.actualVersions.productSha256 !== admission.versions.productSha256) throw new Error('Actual product source changed from immutable admission');
  // Preserve the mutation verdict/identity, never serialize account/authorization table rows.
  const privateMutation = (item: RunResult['unexpectedMutations'][number]) => ['entity', 'public-file', 'knowledge'].includes(item.domain) ? item : { domain: item.domain, identity: item.identity, kind: item.kind };
  await writeImmutableJson(path.join(root, 'attempt.json'), attempt);
  await writeImmutableJson(path.join(root, 'result.json'), RunResultSchema.parse({ ...result, unexpectedMutations: result.unexpectedMutations.map(privateMutation) }));
  if (inputs) await writeChunkedGradeInput(root, inputs);
  if (options.grade) await writeImmutableJson(path.join(root, 'initial-grader-result.json'), { ...options.grade, unexpectedMutations: options.grade.unexpectedMutations.map(privateMutation) });
  if (populationProof) await writeImmutableJson(path.join(root, 'grading-populations.json'), populationProof);
  // Manifest is published last: a crash leaves the admission visible but never a falsely sealed archive.
  const files: ArtifactManifest['files'] = [];
  for (const name of (await readdir(root)).sort()) {
    if (!archiveMetadataNames.includes(name) && !inputChunkName.test(name)) throw new Error('Unexpected file in new evidence archive');
    const bytes = await safeEvidenceBytes(path.join(root, name)); files.push({ path: name, bytes: bytes.length, sha256: bytesHash(bytes) });
  }
  const manifest = ArtifactManifestSchema.parse({ version: '2', attemptId: admission.attemptId, admissionId: admission.admissionId, producer: admission.producer, representation: 'private-host-capture-chunks-v2', createdAt: attempt.sealedAt, access: 'private-local-review', retention: 'operator-managed-no-public-export', authenticity: 'byte-identity-only-not-authorization', files });
  if (files.reduce((total, file) => total + file.bytes, 0) > EVIDENCE_ARCHIVE_BOUNDS.archiveBytes) throw new Error('Archive exceeds bounded evidence size');
  await writeImmutableJson(path.join(root, 'manifest.json'), manifest);
  const manifestSha256 = bytesHash(await safeEvidenceBytes(path.join(root, 'manifest.json')));
  const observed = new Map(options.grade ? [...Object.values(options.grade.checks).flat(), ...options.grade.safetyGate.checks].map(item => [item.id, item]) : []);
  const catalog = options.evaluator.criteria.filter(item => item.taskId === admission.taskId);
  for (const check of observed.values()) if (!catalog.some(item => item.criterionId === check.id)) catalog.push({ taskId: admission.taskId, criterionId: check.id, required: check.required, inputs: ['events'] });
  const criteria = catalog.map(item => {
    const check = observed.get(item.criterionId);
    const requirementRevision = criterionRequirementRevision(admission.taskId, item.criterionId, admission.taskVersion);
    const revisedNotDelivered = requirementRevision === 'retry-v2' && !attempt.requirementRevisions.includes(requirementRevision);
    const evidence = check ? [...check.evidence, ...(populationProof ? originalSafetyPopulationReferences(item.criterionId) : [])] : [];
    return { criterionId: item.criterionId, required: item.required, status: revisedNotDelivered ? 'not-applicable' as const : check ? check.passed ? 'passed' as const : 'failed' as const : 'not-evaluable' as const, reason: revisedNotDelivered ? 'Revised requirement was not delivered before original execution stopped' : check?.reason ?? (check ? null : 'No initial independent grade for admitted attempt'), evidence, taskVersion: admission.taskVersion, requirementRevision };
  });
  const model = { providerRequests: result.observations?.providerRequests ?? null, modelCalls: result.usage.modelCalls, effectiveModelSettingsHash: result.reproducibility.effectiveModelSettingsHash, inferenceObserved: (result.observations?.providerRequests ?? 0) > 0 && (result.usage.modelCalls ?? 0) > 0 && result.reproducibility.effectiveModelSettingsHash !== null };
  const evaluated = criteria.some(item => item.required) && criteria.every(item => !item.required || item.status === 'passed' || item.status === 'failed');
  const releaseEligible = admission.producer === 'host-runner' && options.captureSigner !== undefined && options.ledgerRoot !== undefined && admission.experiment !== undefined && admission.datasetMember !== undefined && admission.capture?.publicKeySha256 === options.captureSigner.publicKeySha256 && options.evaluator.calibrationSha256 !== null && populationProof !== null && options.gradingInfrastructureComplete === true && observed.get('process.isolation')?.passed === true && attempt.actualVersions.productSha256 !== null && attempt.actualVersions.codeImageDigest !== null && model.inferenceObserved && evaluated && result.safetyGate.passed && result.safetyGate.violations.length === 0 && result.unexpectedMutations.length === 0;
  const grade = GradeRunSchema.parse({ version: '1', gradeId: `grade-${randomUUID()}`, attemptId: admission.attemptId, manifestSha256, evaluatorSha256: options.evaluator.sha256, calibrationSha256: options.evaluator.calibrationSha256, previousGradeId: null, createdAt: attempt.sealedAt, kind: 'initial', status: criteria.some(item => item.required && item.status === 'failed') || attempt.executionFailure !== null ? 'failed' : result.success && criteria.every(item => !item.required || item.status === 'passed') ? 'passed' : 'not-evaluable', releaseEligible, criteria, executionFailure: attempt.executionFailure });
  const gradeRoot = `${root}-initial-grade`; await prepareReportDirectory(gradeRoot, true);
  const initialGradePath = path.join(gradeRoot, 'grade.json'); await writeImmutableJson(initialGradePath, grade);
  const initialGradeSha256 = bytesHash(await safeEvidenceBytes(initialGradePath));
  if (options.evaluator.calibrationSha256 !== null) {
    const calibrationBytes = await safeEvidenceBytes(path.join(root, 'calibration.json'));
    if (bytesHash(calibrationBytes) !== options.evaluator.calibrationSha256) throw new Error('Frozen initial calibration identity changed');
    await writeFile(path.join(gradeRoot, 'calibration.json'), calibrationBytes, { mode: 0o400, flag: 'wx' });
  }
  let captureProof: { captureAttestationPath: string; captureAttestationSha256: string } | undefined;
  if (options.captureSigner && options.ledgerRoot && admission.experiment && admission.datasetMember) {
    const populationProofSha256 = files.find(file => file.path === 'grading-populations.json')?.sha256 ?? null;
    const payload = SealedHostCaptureSchema.parse({ schemaVersion: 1, kind: 'dovspace-bench-sealed-capture-v1', producer: 'host-runner', admissionId: admission.admissionId, attemptId: admission.attemptId, runId: admission.runId, arm: admission.arm, admissionSha256: bytesHash(await safeEvidenceBytes(path.join(root, 'admission.json'))), manifestSha256, gradeId: grade.gradeId, gradeSha256: initialGradeSha256, evaluatorSha256: options.evaluator.sha256, calibrationSha256: options.evaluator.calibrationSha256, experiment: admission.experiment, dataset: admission.dataset, datasetMember: admission.datasetMember, actualVersions: attempt.actualVersions, populationProofSha256, gradingInfrastructureComplete: options.gradingInfrastructureComplete === true, model });
    const attestation = signCapture(options.captureSigner, payload);
    const captureAttestationPath = path.join(gradeRoot, 'capture-attestation.json'), captureAttestationSha256 = captureDigest(attestation);
    await writeImmutableJson(captureAttestationPath, attestation);
    await recordExperimentSeal({ ledgerRoot: options.ledgerRoot, signer: options.captureSigner, admissionId: admission.admissionId, attemptId: admission.attemptId, manifestSha256, gradeSha256: initialGradeSha256, captureAttestationSha256, status: attempt.status });
    captureProof = { captureAttestationPath, captureAttestationSha256 };
  }
  await writeImmutableJson(path.join(gradeRoot, 'grade-manifest.json'), { version: '1', gradeId: grade.gradeId, gradeSha256: initialGradeSha256, evaluatorSha256: options.evaluator.sha256, attemptId: admission.attemptId, manifestSha256, ...captureProof });
  await chmod(root, 0o500);
  return { manifestSha256, manifest, initialGradePath, initialGradeSha256, ...captureProof };
}
export async function verifyEvidenceArchive(directory: string, expectedManifestSha256?: string): Promise<VerifiedEvidenceArchive> {
  const root = path.resolve(directory), info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new Error('Evidence archive root is redirected or not a directory');
  const manifestInfo = await lstat(path.join(root, 'manifest.json')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (!manifestInfo) {
    if (expectedManifestSha256 || await lstat(path.join(root, 'admission.json')).catch(() => null)) throw new Error('Admitted archive is not sealed');
    const result = RunResultSchema.safeParse(await safeEvidenceJson(path.join(root, 'result.json')));
    if (!result.success) throw new Error('Unsupported legacy result schema');
    return { root, legacy: true, manifestSha256: null, manifest: null, admission: null, attempt: null, evaluator: null, inputs: null, result: result.data, populationProof: null };
  }
  const bytes = await safeEvidenceBytes(path.join(root, 'manifest.json')), manifestSha256 = bytesHash(bytes);
  if (expectedManifestSha256 !== undefined && manifestSha256 !== expectedManifestSha256) throw new Error('Archive manifest digest mismatch');
  let decoded: unknown; try { decoded = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Malformed archive manifest'); }
  const manifest = ArtifactManifestSchema.parse(decoded), names = manifest.files.map(item => item.path);
  if (new Set(names).size !== names.length || names.some(name => name.includes('/')) || !['admission.json', 'attempt.json', 'evaluator.json', 'result.json'].every(name => names.includes(name))) throw new Error('Archive manifest has duplicate, unsafe or missing required entries');
  if (manifest.version === '2' && (names.some(name => !archiveMetadataNames.includes(name) && !inputChunkName.test(name)) || names.join('\n') !== [...names].sort().join('\n'))) throw new Error('Noncanonical v2 archive entry or order');
  const actual = (await readdir(root)).sort();
  if (actual.join('\n') !== [...names, 'manifest.json'].sort().join('\n')) throw new Error('Unmanifested archive entries are denied');
  const total = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
  if (total > (manifest.version === '1' ? 128 * 1024 * 1024 : EVIDENCE_ARCHIVE_BOUNDS.archiveBytes)) throw new Error('Archive exceeds bounded evidence size');
  const payload = new Map<string, unknown>();
  for (const file of manifest.files) {
    if (manifest.version === '2' && inputChunkName.test(file.path)) continue;
    const content = await safeEvidenceBytes(path.join(root, file.path));
    if (content.length !== file.bytes || bytesHash(content) !== file.sha256) throw new Error('Archive artifact corruption detected');
    try { payload.set(file.path, JSON.parse(content.toString('utf8')) as unknown); } catch { throw new Error('Malformed archived artifact JSON'); }
  }
  const admission = EvaluationAdmissionSchema.parse(payload.get('admission.json')), attempt = EvaluationAttemptSchema.parse(payload.get('attempt.json')), evaluator = EvaluatorVersionSchema.parse(payload.get('evaluator.json')), result = RunResultSchema.parse(payload.get('result.json'));
  const inputs = payload.has('inputs.json') ? manifest.version === '1' ? FrozenGradeInputSchema.parse(payload.get('inputs.json')) : await readChunkedGradeInput(root, payload.get('inputs.json'), manifest.files) : null;
  if (manifest.version === '2' && !inputs && names.some(name => inputChunkName.test(name))) throw new Error('Input chunks lack their host descriptor');
  const populationProof = payload.has('grading-populations.json') ? GradingPopulationProofSchema.parse(payload.get('grading-populations.json')) : null;
  if (populationProof && !inputs) throw new Error('Population proof lacks retained grading input');
  if (populationProof && inputs) verifyRetainedGradingPopulations(populationProof, inputs);
  assertEvaluatorIdentity(evaluator);
  if (manifest.attemptId !== attempt.attemptId || manifest.admissionId !== admission.admissionId || attempt.admissionId !== admission.admissionId || attempt.attemptId !== admission.attemptId || attempt.runId !== admission.runId || result.runId !== admission.runId || result.taskId !== admission.taskId || result.taskVersion !== admission.taskVersion || result.arm !== admission.arm || manifest.producer !== admission.producer || evaluator.sha256 !== admission.evaluatorSha256 || inputs && (inputs.taskId !== admission.taskId || inputs.taskVersion !== admission.taskVersion || inputs.fixture.fixtureId !== inputs.before.fixtureId || inputs.before.fixtureId !== inputs.after.fixtureId)) throw new Error('Archive immutable identities do not agree');
  return { root, legacy: false, manifestSha256, manifest, admission, attempt, evaluator, inputs, result, populationProof };
}

/** Called by the existing calibration runner; this never provisions or executes an Agent. */
export async function archiveCalibrationEvidence(input: GradeInput, grade: GradeResult | undefined, error: string | null, root: string, evaluator: EvaluatorVersion): Promise<SealedEvidence> {
  const task = getTaskDefinition(input.task.id);
  const runId = `calibration-${input.task.id}-${randomUUID()}`;
  const evidence = await admitEvidence({ root, runId, task, arm: 'raw', producer: 'synthetic-calibration', modelConfigSha256: evidenceHash({ inferencePerformed: false }), toolPolicySha256: evidenceHash(task.allowedTools), harnessSha256: evaluator.codeSha256, productSha256: null, codeImage: evaluator.runtime.codeImage, evaluator });
  const missing = { id: 'independent-calibration-grade', passed: false, required: true, score: 0, evidence: [], reason: 'Calibration evaluator did not complete' };
  const result = RunResultSchema.parse({ runId, taskId: task.id, taskVersion: task.taskVersion, fixtureVersion: task.fixtureVersion, arm: 'raw', agent: 'none: synthetic grader calibration', model: 'none: no inference', success: grade?.success === true && !error, safetyGate: grade?.safetyGate ?? { passed: false, checks: [missing], violations: ['Calibration unavailable'] }, checkpointScore: grade?.checkpointScore ?? 0, phaseResults: grade?.phaseResults ?? task.phases.map(item => ({ id: item.id, passed: false, checks: [missing], evidence: [] })), usage: emptyUsage(), timeMs: 0, unexpectedMutations: grade?.unexpectedMutations ?? [], artifacts: {}, reproducibility: { fixtureId: input.fixture.fixtureId, fixtureSemanticHash: input.before.semanticHash, modelConfigHash: evidence.admission.versions.modelConfigSha256, budgetHash: evidenceHash(task.budget), permissionsHash: evidence.admission.versions.toolPolicySha256, environmentHash: evaluator.sha256, effectiveModelSettingsHash: null }, failure: error ? { category: 'grader', message: error, evidence: [] } : grade?.failure ?? null });
  return sealEvidence({ ...evidence, result, inputs: freezeGradeInput(input), events: input.events, populationProof: captureGradingPopulations(input), ...(grade ? { grade } : {}) });
}
