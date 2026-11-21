import { z } from 'zod';
import { digest, mutateRegistry, readEvents, type RegistryEvent } from './dataset-files.ts';
import { assertLineageActive, assertSourceRegistrationAllowed, CriterionIdSchema, feedbackState, RegistryIdSchema, SourceEnrollmentSchema, verifyReproductionEvidence } from './feedback.ts';
import { getTaskDefinition, RUNNABLE_TASK_IDS } from '../tasks/index.ts';
import { TaskIdSchema } from '../schemas/types.ts';
import { collectDatasetDefinitionHash, criterionCatalog, evidenceHash } from './evaluator.ts';

export { assertLineageActive } from './feedback.ts';
export { resolveDatasetArchiveRoot } from './dataset-files.ts';
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const ExpectedCriterionSchema = z.object({ criterionId: CriterionIdSchema, expected: z.enum(['pass', 'fail']), rationaleCode: RegistryIdSchema }).strict();
const MemberReviewFields = { expectedCriteria: z.array(ExpectedCriterionSchema).min(1), lineageSourceIds: z.array(RegistryIdSchema).min(1), reviewerId: RegistryIdSchema, labelerId: RegistryIdSchema, licenseId: RegistryIdSchema, provenanceId: RegistryIdSchema, licenseAuthorized: z.literal(true), sanitized: z.literal(true), independentExpectedCriterion: z.literal(true) };
export const LegacyFrozenDatasetMemberSchema = z.object({
  memberId: RegistryIdSchema, memberVersion: z.number().int().positive(), caseId: RegistryIdSchema, familyId: RegistryIdSchema,
  taskId: RegistryIdSchema, taskVersion: RegistryIdSchema, split: z.enum(['development', 'regression', 'holdout']),
  reproductionId: RegistryIdSchema, archiveRoot: z.string().min(1), manifestDigest: HashSchema, attemptId: RegistryIdSchema, ...MemberReviewFields,
}).strict();
export const FrozenReproductionDatasetMemberSchema = LegacyFrozenDatasetMemberSchema.extend({ evaluationMode: z.literal('frozen-reproduction') });
export const CanonicalDatasetMemberSchema = z.object({
  evaluationMode: z.literal('canonical-task'), memberId: RegistryIdSchema, memberVersion: z.number().int().positive(), enrollmentId: RegistryIdSchema,
  taskId: TaskIdSchema, taskVersion: RegistryIdSchema, fixtureVersion: RegistryIdSchema, familyId: z.literal('dovspace-lite-public-fixture'), split: z.literal('regression'),
  executionSpec: z.object({ kind: z.literal('dovspace-canonical-task-v1'), taskDefinitionSha256: HashSchema, datasetDefinitionSha256: HashSchema, criterionContractSha256: HashSchema }).strict(), ...MemberReviewFields,
}).strict();
export const DatasetMemberSchema = z.union([LegacyFrozenDatasetMemberSchema, z.discriminatedUnion('evaluationMode', [CanonicalDatasetMemberSchema, FrozenReproductionDatasetMemberSchema])]);
export type DatasetMember = z.infer<typeof DatasetMemberSchema>;
export type CanonicalDatasetMember = z.infer<typeof CanonicalDatasetMemberSchema>;
export type FrozenReproductionDatasetMember = z.infer<typeof FrozenReproductionDatasetMemberSchema>;
const DatasetVersionFields = { datasetId: RegistryIdSchema, version: RegistryIdSchema, digest: HashSchema, createdAt: z.iso.datetime(), splitPolicyVersion: RegistryIdSchema, lineageSourceIds: z.array(RegistryIdSchema).min(1) };
export const LegacyDatasetVersionSchema = z.object({ schemaVersion: z.literal(1), members: z.array(LegacyFrozenDatasetMemberSchema).min(1), ...DatasetVersionFields }).strict();
export const DatasetVersionV2Schema = z.object({ schemaVersion: z.literal(2), members: z.array(z.discriminatedUnion('evaluationMode', [CanonicalDatasetMemberSchema, FrozenReproductionDatasetMemberSchema])).min(1), ...DatasetVersionFields }).strict();
export const DatasetVersionSchema = z.discriminatedUnion('schemaVersion', [LegacyDatasetVersionSchema, DatasetVersionV2Schema]);
export type DatasetVersion = z.infer<typeof DatasetVersionSchema>;
export type CanonicalDatasetVersion = Omit<z.infer<typeof DatasetVersionV2Schema>, 'members'> & { members: CanonicalDatasetMember[] };
export type FrozenReproductionDatasetVersion = Omit<z.infer<typeof DatasetVersionV2Schema>, 'members'> & { members: FrozenReproductionDatasetMember[] };
export function isCanonicalDatasetMember(member: DatasetMember): member is CanonicalDatasetMember { return 'evaluationMode' in member && member.evaluationMode === 'canonical-task'; }
export function datasetMemberEvaluationMode(member: DatasetMember): 'canonical-task' | 'frozen-reproduction' { return isCanonicalDatasetMember(member) ? 'canonical-task' : 'frozen-reproduction'; }
export const DatasetPromotionSchema = z.object({ datasetId: RegistryIdSchema, version: RegistryIdSchema, splitPolicyVersion: RegistryIdSchema,
  members: z.array(LegacyFrozenDatasetMemberSchema.omit({ caseId: true, familyId: true, taskId: true, taskVersion: true, archiveRoot: true, manifestDigest: true, attemptId: true, lineageSourceIds: true })).min(1),
}).strict();
export const DatasetEnrollmentSchema = z.object({
  datasetId: RegistryIdSchema, version: RegistryIdSchema, splitPolicyVersion: RegistryIdSchema, enrollmentId: RegistryIdSchema,
  source: z.object({ sourceId: RegistryIdSchema, sourceVersion: RegistryIdSchema, provenanceId: RegistryIdSchema, retentionUntil: z.iso.datetime() }).strict(),
  maintainerId: RegistryIdSchema, labelerId: RegistryIdSchema, reviewerId: RegistryIdSchema, licenseId: RegistryIdSchema, licenseAuthorized: z.literal(true), sanitized: z.literal(true), independentExpectedCriterion: z.literal(true),
  members: z.array(z.object({ memberId: RegistryIdSchema, memberVersion: z.number().int().positive(), taskId: TaskIdSchema.refine(taskId => RUNNABLE_TASK_IDS.includes(taskId), 'Canonical enrollment requires an executable registered task') }).strict()).min(1),
}).strict();
export const ExposureSchema = z.object({ exposureId: RegistryIdSchema, familyId: RegistryIdSchema, actorId: RegistryIdSchema, reason: z.enum(['reviewed', 'debugged', 'published', 'training', 'retired-holdout']), referenceId: RegistryIdSchema }).strict();
export type DatasetExposure = z.infer<typeof ExposureSchema>;
function datasets(events: RegistryEvent[]): DatasetVersion[] { return events.filter(event => event.kind === 'dataset').map(event => DatasetVersionSchema.parse(event.data)); }
function exposures(events: RegistryEvent[]): DatasetExposure[] { return events.filter(event => event.kind === 'exposure').map(event => ExposureSchema.parse(event.data)); }
function checkMemberIdentity(versions: DatasetVersion[], member: DatasetMember): void {
  const prior = versions.flatMap<DatasetMember>(version => version.members).filter(item => item.memberId === member.memberId);
  for (const item of prior) {
    if (item.familyId !== member.familyId || item.taskId !== member.taskId || datasetMemberEvaluationMode(item) !== datasetMemberEvaluationMode(member) || !isCanonicalDatasetMember(item) && !isCanonicalDatasetMember(member) && item.caseId !== member.caseId) throw new Error('Dataset member identity cannot move to another evaluation mode/task/case/family across versions');
  }
  const exact = prior.find(item => item.memberVersion === member.memberVersion);
  if (exact && digest(exact) !== digest(member)) throw new Error('Dataset member version is immutable; changed inputs/expectations require a new memberVersion');
  if (!exact && prior.length && member.memberVersion <= Math.max(...prior.map(item => item.memberVersion))) throw new Error('New dataset member versions must increase monotonically');
}
function checkSplit(events: RegistryEvent[], member: DatasetMember): void {
  const exposed = exposures(events).some(exposure => exposure.familyId === member.familyId);
  const related = datasets(events).flatMap<DatasetMember>(version => version.members).filter(item => item.familyId === member.familyId || !isCanonicalDatasetMember(item) && !isCanonicalDatasetMember(member) && item.caseId === member.caseId || item.lineageSourceIds.some(sourceId => member.lineageSourceIds.includes(sourceId)));
  if (member.split === 'holdout') {
    if (exposed || related.some(item => item.split !== 'holdout') || RUNNABLE_TASK_IDS.some(taskId => taskId === member.taskId)) throw new Error('Exposed/development family or public benchmark task cannot become unseen holdout');
  } else if (related.some(item => item.split === 'holdout') && !exposed) throw new Error('Moving a holdout family to regression requires an explicit exposure/retirement ledger entry');
}
export async function recordDatasetExposure(registryRoot: string, raw: unknown): Promise<DatasetExposure> {
  const input = ExposureSchema.parse(raw);
  return mutateRegistry(registryRoot, async (events, append) => {
    const state = feedbackState(events);
    if (![...state.cases.values()].some(feedback => feedback.familyId === input.familyId) && !datasets(events).some(version => version.members.some(member => member.familyId === input.familyId))) throw new Error('Exposure must reference a registered case or dataset family');
    if (exposures(events).some(exposure => exposure.exposureId === input.exposureId)) throw new Error('Exposure identity is immutable');
    await append('exposure', input);
    return input;
  });
}
/** Enrolls normative task acceptance from the trusted registry; no feedback failure or archived answer is invented. */
export async function enrollCanonicalDatasetVersion(registryRoot: string, raw: unknown): Promise<CanonicalDatasetVersion> {
  const input = DatasetEnrollmentSchema.parse(raw);
  const enrollment = SourceEnrollmentSchema.parse({ enrollmentId: input.enrollmentId, source: { ...input.source, kind: 'synthetic', importedClaim: false, observation: null }, maintainerId: input.maintainerId, labelerId: input.labelerId, reviewerId: input.reviewerId, licenseId: input.licenseId, licenseAuthorized: input.licenseAuthorized, sanitized: input.sanitized, independentExpectedCriterion: input.independentExpectedCriterion });
  return mutateRegistry(registryRoot, async (events, append) => {
    const state = feedbackState(events), versions = datasets(events);
    if (versions.some(version => version.datasetId === input.datasetId && version.version === input.version)) throw new Error('Dataset version is immutable; choose a new version');
    if (new Set(input.members.map(member => member.memberId)).size !== input.members.length || new Set(input.members.map(member => member.taskId)).size !== input.members.length) throw new Error('Canonical enrollment requires unique member and task identities; repetitions belong to the experiment');
    await assertSourceRegistrationAllowed(registryRoot, enrollment.source, state);
    const priorEnrollment = state.enrollments.get(enrollment.enrollmentId);
    if (priorEnrollment && digest(priorEnrollment) !== digest(enrollment)) throw new Error('Canonical source enrollment identity is immutable');
    if (state.sources.has(enrollment.source.sourceId) && ![...state.enrollments.values()].some(prior => prior.source.sourceId === enrollment.source.sourceId)) throw new Error('Canonical enrollment cannot relabel feedback or imported sources');
    const datasetDefinitionSha256 = await collectDatasetDefinitionHash();
    const members: CanonicalDatasetMember[] = input.members.map(candidate => {
      const task = getTaskDefinition(candidate.taskId), catalog = criterionCatalog(candidate.taskId);
      const member = CanonicalDatasetMemberSchema.parse({ ...candidate, evaluationMode: 'canonical-task', enrollmentId: enrollment.enrollmentId, taskVersion: task.taskVersion, fixtureVersion: task.fixtureVersion, familyId: 'dovspace-lite-public-fixture', split: 'regression', executionSpec: { kind: 'dovspace-canonical-task-v1', taskDefinitionSha256: evidenceHash(task), datasetDefinitionSha256, criterionContractSha256: evidenceHash(catalog) }, expectedCriteria: catalog.filter(criterion => criterion.required).map(criterion => ({ criterionId: criterion.criterionId, expected: 'pass', rationaleCode: 'canonical-task-acceptance' })), lineageSourceIds: [enrollment.source.sourceId], reviewerId: enrollment.reviewerId, labelerId: enrollment.labelerId, licenseId: enrollment.licenseId, provenanceId: enrollment.source.provenanceId, licenseAuthorized: true, sanitized: true, independentExpectedCriterion: true });
      checkMemberIdentity(versions, member);
      checkSplit(events, member);
      return member;
    });
    if (!priorEnrollment) await append('source-enrollment', enrollment);
    await assertLineageActive(registryRoot, [enrollment.source.sourceId]);
    const exposureId = `exposed-${digest({ enrollmentId: enrollment.enrollmentId, familyId: 'dovspace-lite-public-fixture' })}`;
    if (!exposures(events).some(exposure => exposure.exposureId === exposureId)) await append('exposure', { exposureId, familyId: 'dovspace-lite-public-fixture', actorId: enrollment.maintainerId, reason: 'published', referenceId: enrollment.enrollmentId });
    const body = { schemaVersion: 2 as const, datasetId: input.datasetId, version: input.version, createdAt: new Date().toISOString(), splitPolicyVersion: input.splitPolicyVersion, members, lineageSourceIds: [enrollment.source.sourceId] };
    const version: CanonicalDatasetVersion = { ...body, digest: digest(body) };
    await append('dataset', version);
    return version;
  });
}
export async function promoteDatasetVersion(registryRoot: string, raw: unknown): Promise<FrozenReproductionDatasetVersion> {
  const input = DatasetPromotionSchema.parse(raw);
  return mutateRegistry(registryRoot, async (events, append) => {
    const state = feedbackState(events), versions = datasets(events);
    if (versions.some(version => version.datasetId === input.datasetId && version.version === input.version)) throw new Error('Dataset version is immutable; choose a new version');
    if (new Set(input.members.map(member => member.memberId)).size !== input.members.length) throw new Error('Dataset member identities must be unique');
    const members: FrozenReproductionDatasetMember[] = [];
    for (const candidate of input.members) {
      const reproduction = state.reproductions.get(candidate.reproductionId);
      const feedback = reproduction ? state.cases.get(reproduction.caseId) : undefined;
      if (!reproduction || !feedback || feedback.triage?.status !== 'accepted' || feedback.triage.reproductionId !== reproduction.reproductionId) throw new Error('Only independently reproduced and accepted cases may be promoted');
      if (candidate.reviewerId === reproduction.reproducerId || candidate.labelerId === reproduction.reproducerId || candidate.reviewerId === candidate.labelerId) throw new Error('Expected labels, reproduction and promotion review must be independent');
      if (candidate.licenseId !== reproduction.licenseId || candidate.provenanceId !== reproduction.provenanceId) throw new Error('Promotion license/provenance must match the reviewed reproduction');
      if (new Set(candidate.expectedCriteria.map(criterion => criterion.criterionId)).size !== candidate.expectedCriteria.length || !candidate.expectedCriteria.some(criterion => criterion.expected === 'fail' && reproduction.failureCriterionIds.includes(criterion.criterionId))) throw new Error('Independent labels must include the reproduced failure criterion');
      await assertLineageActive(registryRoot, reproduction.lineageSourceIds);
      const { archive, grade, assertions } = await verifyReproductionEvidence(registryRoot, reproduction);
      if (!archive.admission || archive.admission.taskId !== reproduction.taskId || archive.admission.taskVersion !== reproduction.taskVersion) throw new Error('Dataset reproduction no longer has usable sealed input identity');
      for (const criterion of candidate.expectedCriteria) {
        const matchingGrades = grade.criteria.filter(actual => actual.criterionId === criterion.criterionId);
        const matchingAssertions = assertions.filter(actual => actual.id === criterion.criterionId);
        const actualGrade = matchingGrades[0], actualAssertion = matchingAssertions[0];
        if (matchingGrades.length !== 1 || !actualGrade || actualGrade.status !== (criterion.expected === 'pass' ? 'passed' : 'failed') || matchingAssertions.length !== 1 || !actualAssertion || actualAssertion.passed !== (criterion.expected === 'pass')) throw new Error('Independent expected criterion must match an actually executed reproduction assertion');
      }
      const member: FrozenReproductionDatasetMember = { ...candidate, evaluationMode: 'frozen-reproduction', caseId: feedback.caseId, familyId: feedback.familyId, taskId: reproduction.taskId, taskVersion: reproduction.taskVersion, archiveRoot: reproduction.archiveRoot, manifestDigest: reproduction.manifestDigest, attemptId: reproduction.attemptId, lineageSourceIds: reproduction.lineageSourceIds };
      checkMemberIdentity(versions, member);
      checkSplit(events, member);
      if (members.some(existing => existing.familyId === member.familyId && (existing.split === 'holdout') !== (member.split === 'holdout'))) throw new Error('A family cannot cross holdout and exposed splits in one version');
      members.push(member);
    }
    const body = { schemaVersion: 2 as const, datasetId: input.datasetId, version: input.version, createdAt: new Date().toISOString(), splitPolicyVersion: input.splitPolicyVersion, members, lineageSourceIds: [...new Set(members.flatMap(member => member.lineageSourceIds))].sort() };
    const version: FrozenReproductionDatasetVersion = { ...body, digest: digest(body) };
    await append('dataset', version);
    return version;
  });
}
export async function validateDatasetVersion(input: { registryRoot: string; datasetId: string; version: string }): Promise<DatasetVersion> {
  RegistryIdSchema.parse(input.datasetId); RegistryIdSchema.parse(input.version);
  const events = await readEvents(input.registryRoot), versions = datasets(events);
  const version = versions.find(entry => entry.datasetId === input.datasetId && entry.version === input.version);
  if (!version) throw new Error('Unknown immutable dataset version');
  const { digest: expected, ...body } = version;
  if (digest(body) !== expected) throw new Error('Dataset version digest mismatch');
  await assertLineageActive(input.registryRoot, version.lineageSourceIds);
  const state = feedbackState(events);
  const datasetDefinitionSha256 = version.members.some(isCanonicalDatasetMember) ? await collectDatasetDefinitionHash() : null;
  if (new Set(version.members.map(member => member.memberId)).size !== version.members.length || digest(version.lineageSourceIds) !== digest([...new Set(version.members.flatMap(member => member.lineageSourceIds))].sort())) throw new Error('Dataset member identities or aggregate source lineage are inconsistent');
  for (const member of version.members) {
    checkSplit(events, member);
    await assertLineageActive(input.registryRoot, member.lineageSourceIds);
    if (isCanonicalDatasetMember(member)) {
      const enrollment = state.enrollments.get(member.enrollmentId);
      if (!enrollment || digest(member.lineageSourceIds) !== digest([enrollment.source.sourceId]) || member.reviewerId !== enrollment.reviewerId || member.labelerId !== enrollment.labelerId || member.licenseId !== enrollment.licenseId || member.provenanceId !== enrollment.source.provenanceId) throw new Error('Canonical member source/license/independent review enrollment is missing or inconsistent');
      if (!RUNNABLE_TASK_IDS.includes(member.taskId) || !datasetDefinitionSha256) throw new Error('Canonical member task is not executable by the current registry');
      const task = getTaskDefinition(member.taskId), catalog = criterionCatalog(member.taskId);
      const executionSpec = { kind: 'dovspace-canonical-task-v1', taskDefinitionSha256: evidenceHash(task), datasetDefinitionSha256, criterionContractSha256: evidenceHash(catalog) };
      const expectedCriteria = catalog.filter(criterion => criterion.required).map(criterion => ({ criterionId: criterion.criterionId, expected: 'pass', rationaleCode: 'canonical-task-acceptance' }));
      if (member.taskVersion !== task.taskVersion || member.fixtureVersion !== task.fixtureVersion || digest(member.executionSpec) !== digest(executionSpec) || digest(member.expectedCriteria) !== digest(expectedCriteria)) throw new Error('Canonical task/fixture/criterion contract changed; a new reviewed dataset version is required');
      continue;
    }
    const reproduction = state.reproductions.get(member.reproductionId);
    if (!reproduction || reproduction.caseId !== member.caseId || reproduction.manifestDigest !== member.manifestDigest || reproduction.attemptId !== member.attemptId || reproduction.archiveRoot !== member.archiveRoot) throw new Error('Dataset member reproduction lineage mismatch');
    const feedback = state.cases.get(member.caseId);
    if (!feedback || feedback.familyId !== member.familyId || feedback.triage?.status !== 'accepted' || feedback.triage.reproductionId !== member.reproductionId) throw new Error('Dataset member independent acceptance is no longer current');
    await verifyReproductionEvidence(input.registryRoot, reproduction);
  }
  return version;
}
export async function datasetRegistryStatus(registryRoot: string): Promise<unknown> {
  const events = await readEvents(registryRoot), state = feedbackState(events), versions = datasets(events);
  const datasetVersions = [];
  for (const version of versions) {
    try { await validateDatasetVersion({ registryRoot, datasetId: version.datasetId, version: version.version }); datasetVersions.push({ datasetId: version.datasetId, version: version.version, digest: version.digest, status: 'active' }); }
    catch { datasetVersions.push({ datasetId: version.datasetId, version: version.version, digest: version.digest, status: 'invalidated' }); }
  }
  return { schemaVersion: 1, eventCount: events.length, eventHeadDigest: events.at(-1)?.digest ?? null, sources: [...state.sources.values()], enrollments: [...state.enrollments.values()], cases: [...state.cases.values()], reproductions: [...state.reproductions.values()], exposures: exposures(events), datasetVersions, contentIncluded: false, pmFactsChanged: false };
}
