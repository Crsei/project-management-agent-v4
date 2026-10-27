import { DomainError } from './core.ts';
import type { Entity } from './core.ts';

export function assertRule(condition: unknown, code: string, message = code): asserts condition {
  if (!condition) throw new DomainError(code, message, 409);
}

export function assertSchedule(startDate: unknown, dueDate: unknown): void {
  for (const value of [startDate, dueDate]) {
    if (value === null) continue;
    assertRule(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'invalid_schedule_date');
    const timestamp = Date.parse(`${value}T00:00:00.000Z`);
    assertRule(Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value, 'invalid_schedule_date');
  }
  assertRule(startDate === null || dueDate === null || (startDate as string) <= (dueDate as string), 'invalid_schedule_range');
}

export function assertSameProject(entity: Entity, projectId: string): void {
  assertRule(entity.projectId === projectId, 'project_mismatch');
}

export function assertUnarchived(entity: Entity): void {
  assertRule(!entity.data.archivedAt, 'object_archived');
}

export function assertStatus(entity: Entity, allowed: readonly string[]): void {
  assertRule(allowed.includes(entity.data.status), 'invalid_state', `Expected ${allowed.join(' or ')}`);
}

export function assertProjectWritable(project: Entity, active = false): void {
  assertUnarchived(project);
  assertStatus(project, active ? ['active'] : ['planning', 'active']);
}

export function assertCriteria(criteria: { id: string; text: string }[]): void {
  assertRule(criteria.length > 0, 'acceptance_criteria_required');
  assertRule(new Set(criteria.map(item => item.id)).size === criteria.length, 'duplicate_criterion');
  assertRule(criteria.every(item => item.text.trim()), 'acceptance_criteria_required');
}

export function assertReadyScope(workItem: Entity): void {
  assertRule(workItem.data.title?.trim() && workItem.data.description?.trim(), 'scope_required');
  assertCriteria(workItem.data.acceptanceCriteria);
  assertRule(workItem.data.assigneeId, 'assignee_required');
}

export function assertNoDependencyCycle(workItems: Entity[], dependentId: string, prerequisiteId: string): void {
  assertRule(dependentId !== prerequisiteId, 'dependency_self_reference');
  const graph = new Map(workItems.map(item => [item.id, item.data.prerequisiteIds as string[]]));
  const seen = new Set<string>();
  const stack = [prerequisiteId];
  while (stack.length) {
    const id = stack.pop()!;
    assertRule(id !== dependentId, 'dependency_cycle');
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(graph.get(id) ?? []));
  }
}

export function assertPassedReview(workItem: Entity, submission: Entity, review: Entity): void {
  const data = workItem.data;
  assertRule(submission.projectId === workItem.projectId && review.projectId === workItem.projectId, 'project_mismatch');
  assertRule(data.currentSubmissionId === submission.id && submission.data.workItemId === workItem.id, 'submission_mismatch');
  assertRule(review.data.workItemId === workItem.id && review.data.submissionId === submission.id, 'review_mismatch');
  assertRule(submission.data.contentRevision === data.contentRevision && review.data.contentRevision === data.contentRevision, 'content_revision_mismatch');
  assertRule(review.data.verdict === 'passed', 'passed_review_required');
  const snapshot = submission.data.workScopeSnapshot;
  assertRule(snapshot?.workItemId === workItem.id && snapshot.contentRevision === data.contentRevision, 'submission_snapshot_mismatch');
  assertRule(snapshot.title === data.title && snapshot.description === data.description, 'submission_snapshot_mismatch');
  const criteria = data.acceptanceCriteria as { id: string; text: string }[];
  assertCriteria(criteria);
  assertRule(Array.isArray(snapshot.acceptanceCriteria) && snapshot.acceptanceCriteria.length === criteria.length && criteria.every(item => snapshot.acceptanceCriteria.some((saved: any) => saved.id === item.id && saved.text === item.text)), 'submission_snapshot_mismatch');
  const results = review.data.criterionResults as { criterionId: string; result: string; basisRefs: unknown[]; explanation: string }[];
  assertRule(Array.isArray(results) && results.length === criteria.length, 'incomplete_review');
  assertRule(new Set(results.map(item => item.criterionId)).size === criteria.length, 'incomplete_review');
  const allowedBasis = new Set([...(submission.data.artifactVersionIds ?? []), ...(submission.data.evidenceIds ?? [])]);
  assertRule(Array.isArray(submission.data.artifactVersionIds) && submission.data.artifactVersionIds.length > 0, 'submission_artifact_required');
  assertRule(criteria.every(criterion => results.some(item => item.criterionId === criterion.id && item.result === 'pass' && item.explanation?.trim() && Array.isArray(item.basisRefs) && item.basisRefs.length > 0 && item.basisRefs.every(ref => allowedBasis.has(ref)))), 'incomplete_review');
}
