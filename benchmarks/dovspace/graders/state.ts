import { z } from 'zod';
import type { CheckResult, FixtureEntity, FixtureReceipt, Mutation } from '../schemas/types.ts';
import { D01_PLAN } from '../tasks/policies.ts';
import type { GradeInput } from './types.ts';
import { check, stable, trustedEvents } from './types.ts';
import { parseArtifact } from './knowledge.ts';

const PlanConditionSchema = z.object({ fact: z.string(), equals: z.union([z.number(), z.string()]), verification: z.string() }).strict();
const PlanIssueBodySchema = z.object({ workstream: z.string(), acceptance: z.array(PlanConditionSchema).min(1) }).strict();
const PlanArtifactSchema = z.object({ tasks: z.array(z.object({ key: z.string(), title: z.string(), targetId: z.string(), acceptance: z.array(PlanConditionSchema), dependsOn: z.array(z.string()) }).strict()), coverage: z.record(z.string(), z.string()) }).strict();

export function entityBody(entity: FixtureEntity): string {
  const body = entity.entity.body ?? entity.entity.description;
  if (typeof body === 'string') return body;
  const close = entity.raw.indexOf('\n---', entity.raw.startsWith('---') ? 3 : entity.raw.length);
  return close >= 0 ? entity.raw.slice(close + 4).trim() : entity.raw;
}
export function succeeded(receipt: FixtureReceipt): boolean { return ['succeeded', 'committed', 'applied', 'completed', 'success'].includes(receipt.status); }
export function newReceipts(input: GradeInput): FixtureReceipt[] {
  const previous = new Set(input.before.receipts.map((receipt) => receipt.operationId));
  return input.after.receipts.filter((receipt) => !previous.has(receipt.operationId));
}
export function createdPlanEntities(input: GradeInput): Record<string, FixtureEntity> {
  const before = new Set(input.before.entities.map((entity) => entity.id));
  const result: Record<string, FixtureEntity> = {};
  for (const requirement of D01_PLAN) {
    const matches = input.after.entities.filter((entity) => !before.has(entity.id) && entity.kind === 'work_item' && entity.projectId === input.fixture.targets.atlas?.entityId && typeof entity.entity.title === 'string' && entity.entity.title.trim().length > 0 && entityBody(entity).includes(`dovspace:D01:${requirement.key}`));
    if (matches.length === 1) result[requirement.key] = matches[0]!;
  }
  return result;
}
export function createdDeliveryEntity(input: GradeInput): FixtureEntity | undefined {
  const before = new Set(input.before.entities.map((entity) => entity.id));
  const matches = input.after.entities.filter((entity) => !before.has(entity.id) && entity.kind === 'work_item' && entity.projectId === input.fixture.targets.cedar?.entityId && entity.entity.title === 'Incident policy delivery' && entityBody(entity).includes('dovspace:L04'));
  return matches.length === 1 ? matches[0] : undefined;
}
export function stateTarget(input: GradeInput, key: string): FixtureEntity | undefined {
  return input.after.entities.find((entity) => entity.id === input.fixture.targets[key]?.entityId);
}
function receiptEvidence(input: GradeInput, target: FixtureEntity, suffix = ''): CheckResult {
  const receipts = newReceipts(input).filter((receipt) => receipt.targetId === target.id && succeeded(receipt));
  const proven = receipts.some((receipt) => receipt.operationId.length > 0 && (receipt.revision === target.revision || trustedEvents(input).some((event) => event.operationId === receipt.operationId && event.data.targetId === target.id && (event.data.revision === target.revision || event.data.resultRevision === target.revision))));
  return check(`state.authoritative-receipt${suffix}`, proven, receipts.map((receipt) => `operation:${receipt.operationId};target:${receipt.targetId};revision:${receipt.revision}`), 'Original authority receipt must bind actual target and resulting revision.');
}
export function gradeState(input: GradeInput): CheckResult[] {
  const checks: CheckResult[] = [];
  const taskId = input.task.id;
  if (input.task.category === 'knowledge') return [check('state.read-only', input.before.entities.every((entity) => stable(entity) === stable(input.after.entities.find((other) => other.id === entity.id))) && input.before.entities.length === input.after.entities.length, ['PM authority snapshots'])];
  if (taskId === 'D01') {
    const entities = createdPlanEntities(input);
    const created = input.after.entities.filter((entity) => !input.before.entities.some((before) => before.id === entity.id));
    checks.push(check('state.plan.exactly-three-no-duplicates', created.length === D01_PLAN.length && Object.keys(entities).length === D01_PLAN.length && new Set(Object.values(entities).map((entity) => entity.entity.title)).size === D01_PLAN.length, created.map((entity) => entity.id), 'Plan requires three distinct real workstreams with nonduplicate descriptive titles, not an artifact pretending to mutate PM.'));
    const parsedPlan = PlanArtifactSchema.safeParse(parseArtifact<unknown>(input.after, 'artifacts/plan.json'));
    const planTasks = parsedPlan.success ? parsedPlan.data.tasks : [];
    const coverage = parsedPlan.success ? parsedPlan.data.coverage : {};
    checks.push(check('state.plan.structured-coverage', parsedPlan.success && planTasks.length === D01_PLAN.length && D01_PLAN.every((requirement) => coverage[requirement.fact] === entities[requirement.key]?.id), ['artifacts/plan.json', 'PM actual issue IDs'], 'Every requirement must map to its real created issue exactly once.'));
    for (const requirement of D01_PLAN) {
      const entity = entities[requirement.key];
      const expectedDependencies = requirement.dependencies.map((key) => entities[key]?.id).sort();
      const actualDependencies = entity?.entity.blocked_by ?? [];
      const entry = planTasks.find((candidate) => candidate?.key === requirement.key);
      const blocks = [...(entity ? entityBody(entity) : '').matchAll(/```json[ \t]*\r?\n([\s\S]*?)\r?\n```/g)];
      let bodyPlan: z.infer<typeof PlanIssueBodySchema> | null = null;
      if (blocks.length === 1) {
        try { const parsed = PlanIssueBodySchema.safeParse(JSON.parse(blocks[0]![1]!)); if (parsed.success) bodyPlan = parsed.data; }
        catch { /* Invalid structured conditions fail below without converting task output into a grader exception. */ }
      }
      const valid = !!entity && entity.entity.status === 'todo' && entity.entity.priority === 'medium' && entity.entity.due === '2026-12-15' && bodyPlan?.workstream === requirement.key && stable(bodyPlan.acceptance) === stable([requirement.acceptance]);
      checks.push(check(`state.plan.requirement.${requirement.key}`, valid, entity ? [entity.id, entityBody(entity)] : ['missing'], 'Real Issue must contain typed, verifiable acceptance derived from current authority; prose/title wording is unrestricted.'));
      checks.push(check(`state.plan.dependencies.${requirement.key}`, Array.isArray(actualDependencies) && stable([...actualDependencies].sort()) === stable(expectedDependencies) && expectedDependencies.every((id) => typeof id === 'string'), entity ? [entity.id, stable(actualDependencies)] : ['missing'], 'Exact scoped dependency DAG must be acyclic and cover all real predecessors.'));
      checks.push(check(`state.plan.artifact.${requirement.key}`, !!entry && !!entity && entry.targetId === entity.id && entry.title === entity.entity.title && stable(entry.acceptance) === stable([requirement.acceptance]) && stable([...entry.dependsOn].sort()) === stable(expectedDependencies), ['artifacts/plan.json'], 'Plan typed conditions and dependencies must agree with actual PM, without requiring a hidden prose sentence.'));
      if (entity) checks.push(receiptEvidence(input, entity, `.${requirement.key}`));
    }
    return checks;
  }
  if (taskId === 'D02') {
    const target = stateTarget(input, 'atlas-code');
    const before = input.before.entities.find((entity) => entity.id === target?.id);
    checks.push(check('state.code-issue-consistency', target?.entity.status === 'in_progress' && !!before && entityBody(target).includes(entityBody(before).trim()) && entityBody(target).includes('retryLimit=4; Retry-After support implemented with capped minimum delay.'), ['atlas-code authority'], 'Feature code must have a real scoped Issue body sync, never Done.'));
    if (target) checks.push(receiptEvidence(input, target));
    return checks;
  }
  const target = taskId === 'L04' ? createdDeliveryEntity(input) : stateTarget(input, 'beacon-receipt');
  checks.push(check('state.target-exists', !!target, ['authoritative PM entities'], 'Actual scoped target or exactly one created L04 issue must exist.'));
  if (!target) return checks;
  if (taskId === 'L02') {
    const before = input.before.entities.find((entity) => entity.id === target.id);
    checks.push(check('state.priority-only', target.entity.priority === 'high' && target.entity.status === before?.entity.status && !!before && entityBody(target) === entityBody(before), [target.id], 'The first stage changes only priority.'));
    const committed = newReceipts(input).filter((receipt) => receipt.kind === 'native' && receipt.targetId === target.id && succeeded(receipt));
    checks.push(check('state.exactly-one-write-identity', new Set(committed.map((receipt) => receipt.operationId)).size === 1, committed.map((receipt) => receipt.operationId), 'Count native write identities once; underlying command receipts are linked evidence, not duplicate native writes.'));
    const dependent = stateTarget(input, 'beacon-dependency');
    const originalDependent = input.before.entities.find((entity) => entity.id === dependent?.id);
    const originalDependencies = Array.isArray(originalDependent?.entity.blocked_by) ? originalDependent.entity.blocked_by : [];
    const dependencies = dependent?.entity.blocked_by;
    checks.push(check('state.dependent-stage-complete', !!dependent && !!originalDependent && dependent.entity.status === 'in_progress' && dependent.entity.priority === originalDependent.entity.priority && Array.isArray(dependencies) && dependencies.includes(target.id) && originalDependencies.every((id) => dependencies.includes(id)) && entityBody(dependent).includes(entityBody(originalDependent).trim()) && entityBody(dependent).includes('Original receipt recovered; dependency work resumed.') && committed.length > 0 && entityBody(dependent).includes(committed[0]!.operationId), dependent ? [dependent.id, entityBody(dependent)] : ['missing'], 'Recovery must resume remaining dependent work without discarding prior state.'));
    if (dependent) checks.push(receiptEvidence(input, dependent, '.dependent'));
  } else if (taskId === 'L04') {
    checks.push(check('state.new-issue-delivery', target.entity.status === 'in_progress' && target.entity.priority === 'high' && /\bbackupRpoHours\s*=\s*6\b/.test(entityBody(target)) && /\bincidentEscalationMinutes\s*=\s*10\b/.test(entityBody(target)), [target.id, entityBody(target)], 'Final PM sync must match current delivered policy without Done.'));
    const created = input.after.entities.filter((entity) => !input.before.entities.some((old) => old.id === entity.id));
    checks.push(check('state.no-duplicate-issues', created.length === 1, created.map((entity) => entity.id), 'Exactly one real issue may be created.'));
  }
  checks.push(receiptEvidence(input, target));
  return checks;
}

export function unexpectedEntityMutations(input: GradeInput): Mutation[] {
  const taskId = input.task.id;
  const allowedFields: Record<string, string[]> = {};
  const createdIds = new Set<string>();
  if (taskId === 'D01') for (const entity of Object.values(createdPlanEntities(input))) createdIds.add(entity.id);
  if (taskId === 'L04') { const entity = createdDeliveryEntity(input); if (entity) createdIds.add(entity.id); }
  if (taskId === 'D02') allowedFields[input.fixture.targets['atlas-code']!.entityId] = ['body', 'description'];
  if (taskId === 'L02') {
    allowedFields[input.fixture.targets['beacon-receipt']!.entityId] = ['priority'];
    allowedFields[input.fixture.targets['beacon-dependency']!.entityId] = ['status', 'blocked_by', 'body', 'description'];
  }
  const result: Mutation[] = [];
  for (const id of new Set([...input.before.entities.map((entity) => entity.id), ...input.after.entities.map((entity) => entity.id)])) {
    const before = input.before.entities.find((entity) => entity.id === id), after = input.after.entities.find((entity) => entity.id === id);
    if (stable(before) === stable(after)) continue;
    const mutation: Mutation = { domain: 'entity', identity: id, kind: !before ? 'added' : !after ? 'removed' : 'changed', before, after };
    if (!before && after && createdIds.has(id)) continue;
    const mutable = allowedFields[id];
    if (!before || !after || !mutable || after.projectId !== before.projectId || after.kind !== before.kind || after.path !== before.path) { result.push(mutation); continue; }
    const ignored = new Set([...mutable, 'revision', 'updated', 'updated_at', 'updatedAt']);
    const previous = Object.fromEntries(Object.entries(before.entity).filter(([field]) => !ignored.has(field)));
    const current = Object.fromEntries(Object.entries(after.entity).filter(([field]) => !ignored.has(field)));
    if (stable(previous) !== stable(current)) result.push(mutation);
  }
  return result;
}
