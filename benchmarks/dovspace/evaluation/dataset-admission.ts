import { z } from 'zod';
import { createMarkdown, inspectFrontmatter } from '../../../packages/pm-markdown/index.ts';
import { validateDatasetVersion, isCanonicalDatasetMember } from './dataset.ts';
import { collectDatasetDefinitionHash, criterionCatalog, evidenceHash } from './evaluator.ts';
import { SYNTHETIC_DOCUMENTS, KNOWLEDGE_FIXTURE_FILES, HISTORICAL_SESSION_FILES } from '../fixtures/documents.ts';
import { PROJECTS, ISSUES } from '../fixtures/dataset.ts';
import { CODE_FIXTURE_FILES, getTaskDefinition } from '../tasks/index.ts';
import { PARTIAL_RETRY_SOURCE, PARTIAL_RETRY_TEST } from '../tasks/guidance.ts';
import { entityBody } from '../graders/state.ts';
import type { EvaluationAdmission } from '../schemas/evaluation.ts';
import type { FixtureSnapshot } from '../schemas/types.ts';

export const DatasetRunSelectionSchema = z.object({ registryRoot: z.string().min(1), datasetId: z.string().min(1), version: z.string().min(1), memberId: z.string().min(1), memberVersion: z.number().int().positive() }).strict();
export type DatasetRunSelection = z.infer<typeof DatasetRunSelectionSchema>;
export interface RegisteredDatasetAdmission {
  dataset: EvaluationAdmission['dataset'];
  member: NonNullable<EvaluationAdmission['datasetMember']>;
  task: { id: string; taskVersion: string; fixtureVersion: string };
  publicFilesSha256: string;
  authoritySha256: string;
}
function publicPopulation(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).filter(([name]) => name !== 'pm-targets.json' && !name.startsWith('.dovspace/')).sort(([a], [b]) => a.localeCompare(b)));
}
function canonicalPublicPopulation(taskId: string): Record<string, string> {
  const files = Object.fromEntries([...SYNTHETIC_DOCUMENTS.map(document => [document.path, Buffer.from(document.content).toString('base64')]), ...Object.entries({ ...KNOWLEDGE_FIXTURE_FILES, ...HISTORICAL_SESSION_FILES }).map(([name, content]) => [name, Buffer.from(content).toString('base64')]), ...Object.entries(CODE_FIXTURE_FILES).map(([name, content]) => [`repo/${name}`, Buffer.from(content).toString('base64')])]);
  if (taskId === 'D04') { files['repo/src/retry.ts'] = Buffer.from(PARTIAL_RETRY_SOURCE).toString('base64'); files['repo/test/retry-partial.test.ts'] = Buffer.from(PARTIAL_RETRY_TEST).toString('base64'); }
  return publicPopulation(files);
}
function canonicalAuthorityBody(kind: 'project' | 'work_item', seed: { title: string; body: string }): string {
  // Native PM creation inserts the authoritative H1 into entity.body; compare that
  // complete representation rather than stripping headings or other fixture content.
  // Render-only valid IDs do not identify or replace the real fixture authority.
  return inspectFrontmatter(createMarkdown({ id: kind === 'project' ? 'PRJ-001' : 'TASK-001', entity: kind, title: seed.title, body: seed.body })).body.trim();
}
function canonicalAuthorityPopulation(): unknown[] {
  return [...PROJECTS.map(project => ({ key: project.key, kind: 'project', project: null, title: project.title, body: canonicalAuthorityBody('project', project) })), ...ISSUES.map(issue => ({ key: issue.key, kind: 'work_item', project: issue.project, title: issue.title, body: canonicalAuthorityBody('work_item', issue), state: { status: ['atlas-code', 'cedar-handoff'].includes(issue.key) ? 'in_progress' : 'todo', priority: 'medium', due: '2026-12-01', blockedBy: issue.key === 'beacon-dependency' ? ['atlas-plan'] : [] } }))].sort((a, b) => a.key.localeCompare(b.key));
}
function actualAuthorityPopulation(snapshot: FixtureSnapshot): unknown[] {
  const keyById = new Map(snapshot.entities.map(entity => [entity.id, entity.key]));
  return snapshot.entities.slice().sort((a, b) => a.key.localeCompare(b.key)).map(entity => ({
    key: entity.key, kind: entity.kind, project: entity.kind === 'project' ? null : entity.projectId ? keyById.get(entity.projectId) ?? entity.projectId : null,
    title: String(entity.entity.title ?? ''), body: entityBody(entity).trim(),
    ...(entity.kind === 'work_item' ? { state: { status: entity.entity.status ?? null, priority: entity.entity.priority ?? null, due: entity.entity.due ?? null, blockedBy: Array.isArray(entity.entity.blocked_by) ? entity.entity.blocked_by.map(id => keyById.get(String(id)) ?? String(id)).sort() : [] } } : {}),
  }));
}
/** Fresh model tasks use canonical registry acceptance, never expected-fail labels from an old frozen trace. */
export async function resolveRegisteredDatasetAdmission(selection: DatasetRunSelection, task: { id: string; taskVersion: string; fixtureVersion: string }): Promise<RegisteredDatasetAdmission> {
  const input = DatasetRunSelectionSchema.parse(selection), definition = getTaskDefinition(task.id);
  const dataset = await validateDatasetVersion({ registryRoot: input.registryRoot, datasetId: input.datasetId, version: input.version });
  const member = dataset.members.find(item => item.memberId === input.memberId && item.memberVersion === input.memberVersion);
  if (!member || !isCanonicalDatasetMember(member)) throw new Error('Frozen-reproduction dataset members are regrade-only; canonical task enrollment is required for fresh execution');
  const criteria = criterionCatalog(definition.id), expected = criteria.filter(item => item.required).map(item => ({ criterionId: item.criterionId, expected: 'pass', rationaleCode: 'canonical-task-acceptance' }));
  if (member.taskId !== task.id || member.taskVersion !== task.taskVersion || member.fixtureVersion !== task.fixtureVersion || definition.taskVersion !== task.taskVersion || definition.fixtureVersion !== task.fixtureVersion || member.executionSpec.taskDefinitionSha256 !== evidenceHash(definition) || member.executionSpec.datasetDefinitionSha256 !== await collectDatasetDefinitionHash() || member.executionSpec.criterionContractSha256 !== evidenceHash(criteria) || evidenceHash(member.expectedCriteria) !== evidenceHash(expected)) throw new Error('Canonical dataset member differs from exact current task/fixture/criterion execution contract');
  return { dataset: { datasetId: dataset.datasetId, version: dataset.version, sha256: dataset.digest }, member: { evaluationMode: 'canonical-task', memberId: member.memberId, memberVersion: member.memberVersion, familyId: member.familyId, executionSpecSha256: evidenceHash(member.executionSpec) }, task, publicFilesSha256: evidenceHash(canonicalPublicPopulation(task.id)), authoritySha256: evidenceHash(canonicalAuthorityPopulation()) };
}
/** Runs after fresh real fixture preparation and before any Agent/model dispatch. Custom incompatible inputs are rejected, never silently ignored. */
export function assertRegisteredDatasetFixture(selection: RegisteredDatasetAdmission, actual: FixtureSnapshot): void {
  if (actual.fixtureVersion !== selection.task.fixtureVersion || evidenceHash(publicPopulation(actual.publicFiles)) !== selection.publicFilesSha256 || evidenceHash(actualAuthorityPopulation(actual)) !== selection.authoritySha256) throw new Error('Actual fresh fixture differs from selected canonical dataset execution contract; no model dispatch is allowed');
}
