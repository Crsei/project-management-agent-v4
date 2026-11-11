import type { BenchEvent, FixtureHandle, FixtureSnapshot } from '../schemas/types.ts';
import { HANDOFF_PATH } from '../tasks/index.ts';

export type CheckpointEvidence = { phaseId: string; operationId: string; targetId: string; revision: string; receiptIdentity: string; authorityVerified: true; handoffVerified: true };

function structuredArtifact(snapshot: FixtureSnapshot, name: string): Record<string, unknown> | null {
  const bytes = snapshot.publicFiles[name];
  if (!bytes || bytes.length > 2 * 1024 * 1024) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes, 'base64').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/** A runner checkpoint is a conjunction of captured authority and persisted model output. */
export function inspectCheckpoint(taskId: string, phaseId: string, fixture: FixtureHandle, before: FixtureSnapshot, after: FixtureSnapshot, events: readonly BenchEvent[]): CheckpointEvidence | null {
  // Snapshot construction refuses symlinks/hardlinks; parse those captured bytes, not a racy second read.
  const handoff = structuredArtifact(after, HANDOFF_PATH);
  if (!handoff) return null;
  const nestedTarget = handoff.target && typeof handoff.target === 'object' ? handoff.target as Record<string, unknown> : {};
  const declaredTarget = handoff.targetId ?? handoff.entityId ?? handoff.taskId ?? nestedTarget.entityId ?? nestedTarget.id;
  const declaredOperation = handoff.operationId ?? handoff.commandId;
  const declaredWorkspace = handoff.workspaceId ?? nestedTarget.workspaceId;
  const declaredProject = handoff.projectId ?? nestedTarget.projectId;
  if (declaredWorkspace !== fixture.workspaceId) return null;
  if (taskId === 'L02') {
    const lost = events.find(event => event.source === 'transport' && event.type === 'response_lost' && event.data.committed === true);
    const operationId = lost?.operationId ?? lost?.data.operationId;
    if (!lost || typeof operationId !== 'string' || declaredOperation !== operationId) return null;
    const receipt = after.receipts.find(value => value.operationId === operationId && value.kind === 'native' && value.status === 'succeeded');
    const target = fixture.targets['beacon-receipt'];
    const entity = after.entities.find(value => value.id === target?.entityId);
    const original = before.entities.find(value => value.id === target?.entityId);
    if (!receipt || !entity || !original || !receipt.revision || receipt.targetId !== entity.id || declaredTarget !== entity.id || declaredProject !== entity.projectId || entity.entity.priority !== 'high') return null;
    if (lost.data.targetId !== entity.id || lost.data.revision !== receipt.revision || (handoff.observedRevision ?? handoff.revision) !== original.revision) return null;
    return { phaseId, operationId, targetId: entity.id, revision: receipt.revision, receiptIdentity: String(lost.data.receiptIdentity ?? receipt.operationId), authorityVerified: true, handoffVerified: true };
  }
  if (taskId === 'L04') {
    const cedar = fixture.targets.cedar?.entityId;
    const priorIds = new Set(before.entities.map(entity => entity.id));
    const created = after.entities.filter(entity => !priorIds.has(entity.id) && entity.projectId === cedar && entity.kind === 'work_item' && entity.entity.title === 'Incident policy delivery' && entity.raw.includes('dovspace:L04'));
    if (created.length !== 1 || declaredProject !== cedar || typeof declaredOperation !== 'string') return null;
    const entity = created[0]!;
    const receipt = after.receipts.find(value => value.targetId === entity.id && value.operationId === declaredOperation && value.kind === 'native' && value.status === 'succeeded');
    const creation = events.find(event => event.source === 'transport' && event.type === 'pm_response' && event.toolName === 'pm_create_task' && event.operationId === declaredOperation && event.data.status === 'succeeded');
    const plan = structuredArtifact(after, 'artifacts/plan.json');
    const requirements = structuredArtifact(after, 'artifacts/requirements.json');
    const decision = structuredArtifact(after, 'artifacts/decision.json');
    if (!receipt?.revision || !creation || declaredTarget !== entity.id || entity.entity.priority !== 'high' || entity.entity.status !== 'in_progress' || !handoff.receipt) return null;
    if (handoff.revision !== entity.revision && handoff.revision !== receipt.revision) return null;
    const stages = plan?.stages;
    if (plan?.targetId !== entity.id || !Array.isArray(stages) || !['requirements', 'research', 'technical-decision', 'create-issue', 'development-plan'].every(stage => stages.includes(stage)) || !Array.isArray(requirements?.requirements) || !Array.isArray(decision?.sources)) return null;
    return { phaseId, operationId: receipt.operationId, targetId: entity.id, revision: receipt.revision, receiptIdentity: receipt.operationId, authorityVerified: true, handoffVerified: true };
  }
  return null;
}
