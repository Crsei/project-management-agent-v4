import { z } from 'zod';
import { agentChatToolResultFields } from './pm-tool-shared.ts';

const uuid = z.uuid();
const id = z.string().min(1).max(200);
const timestamp = z.iso.datetime({ offset: true });
const base = { id: uuid, workspaceId: uuid, projectId: id.nullable(), version: z.number().int().positive(), createdBy: uuid, createdAt: timestamp.nullable(), updatedAt: timestamp.nullable() };
const ref = z.strictObject({ kind: z.enum(['project', 'work_item', 'milestone', 'conversation', 'intent', 'decision', 'upload', 'artifact', 'artifact_version', 'evidence', 'submission', 'review']), id });
const criterion = z.strictObject({ id, text: z.string().max(16000) });
export const planningRecordsRecordSchema = z.discriminatedUnion('resource', [
  z.strictObject({ ...base, resource: z.literal('conversation'), title: z.string().max(300), messages: z.array(z.strictObject({ id: uuid, authorId: uuid, content: z.string().max(16000), contentVersion: z.number().int().positive(), createdAt: timestamp })).max(20), messageOffset: z.number().int().nonnegative(), nextMessageOffset: z.number().int().nonnegative().nullable(), totalMessages: z.number().int().nonnegative() }),
  z.strictObject({ ...base, resource: z.literal('intent'), summary: z.string().max(1000), goal: z.string().max(16000), conversationId: uuid.nullable(), sourceMessageRefs: z.array(z.strictObject({ messageId: uuid, contentVersion: z.number().int().positive() })).max(100), revision: z.number().int().positive(), status: z.enum(['proposed', 'accepted', 'rejected', 'withdrawn']), acceptedDecisionId: uuid.nullable(), terminalDecisionId: uuid.nullable(), withdrawalRecord: z.strictObject({ reason: z.string().max(16000), withdrawnBy: uuid, withdrawnAt: timestamp }).nullable() }),
  z.strictObject({ ...base, resource: z.literal('decision'), subjectRef: ref, decisionType: z.enum(['note', 'supersede', 'accept_intent', 'reject_intent']), actorId: uuid, reason: z.string().max(16000), basisRefs: z.array(ref).max(100), supersedesDecisionId: uuid.nullable(), acceptedRevision: z.number().int().positive().nullable(), rejectedRevision: z.number().int().positive().nullable() }),
  z.strictObject({ ...base, resource: z.literal('evidence'), subjectRefs: z.array(id).max(200), method: z.string().max(20000), scope: z.string().max(20000), result: z.enum(['pass', 'fail', 'inconclusive']), observedAt: timestamp, artifactVersionRefs: z.array(uuid).max(200), sourceRunId: z.null(), producerId: uuid }),
  z.strictObject({ ...base, resource: z.literal('submission'), workItemId: id, contentRevision: z.number().int().positive(), snapshotTruncated: z.boolean(), workScopeSnapshot: z.strictObject({ workItemId: id, contentRevision: z.number().int().positive(), title: z.string().max(300), description: z.string().max(64000), acceptanceCriteria: z.array(criterion).max(100), capturedAt: timestamp }), artifactVersionIds: z.array(uuid).max(200), evidenceIds: z.array(uuid).max(200), submittedBy: uuid, submittedAt: timestamp }),
  z.strictObject({ ...base, resource: z.literal('review'), submissionId: uuid, workItemId: id, contentRevision: z.number().int().positive(), criterionResults: z.array(z.strictObject({ criterionId: id, result: z.enum(['pass', 'fail', 'inconclusive']), basisRefs: z.array(uuid).max(200), explanation: z.string().max(20000) })).max(200), verdict: z.enum(['passed', 'changes_requested']), reason: z.string().max(20000), reviewerId: uuid, reviewedAt: timestamp }),
]);
export type PlanningRecordsRecord = z.infer<typeof planningRecordsRecordSchema>;
// Independent Agent wire DTOs mirror the native roadmap read, not its business
// publication/materialization rules. Keep native PM schemas in their own package.
const roadmapText = z.string().max(6000);
const roadmapBriefWireSchema = z.strictObject({
  idea: roadmapText, audience: roadmapText, problem: roadmapText, journey: roadmapText, success: roadmapText,
  nonGoals: roadmapText, sharedContract: roadmapText, assumptions: roadmapText,
});
const roadmapNodeWireSchema = z.strictObject({
  id: uuid, title: z.string().max(160), outcome: roadmapText, acceptance: roadmapText,
  nonGoals: roadmapText, stage: z.string().max(80), dependsOn: z.array(uuid).max(24),
  x: z.number().int().min(0).max(6000), y: z.number().int().min(0).max(6000),
});
const roadmapPlanWireSchema = z.strictObject({ brief: roadmapBriefWireSchema, nodes: z.array(roadmapNodeWireSchema).max(24) });
const roadmapStoreWireSchema = z.strictObject({
  schema: z.literal('pm/product-roadmap/v1'), draft: roadmapPlanWireSchema,
  releases: z.array(z.strictObject({ id: uuid, plan: roadmapPlanWireSchema, publishedAt: z.iso.datetime(), publishedBy: z.string() })).max(20),
});
export const planningRecordsRoadmapSchema = z.strictObject({
  projectId: id, title: z.string().max(300), revision: z.string().max(200), archived: z.boolean(), store: roadmapStoreWireSchema,
  tasks: z.record(z.string(), z.array(z.strictObject({ nodeId: uuid, taskId: id, title: z.string().max(300), status: z.string().max(200), revision: z.string().max(200), archived: z.boolean(), drifted: z.boolean() })).max(1000)),
});
export const PlanningRecordsToolResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('planning_records'), records: z.array(planningRecordsRecordSchema).max(20), cursor: z.string().nullable(), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('planning_roadmap'), roadmap: planningRecordsRoadmapSchema, selectedNodeIds: z.array(uuid).max(24), dependencyClosure: z.array(uuid).max(24), idMap: z.array(z.strictObject({ nodeId: uuid, taskId: id, revision: z.string() })).max(24), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('planning_record_receipt'), records: z.array(planningRecordsRecordSchema).max(3), generatedTask: z.strictObject({ id, projectId: id, title: z.string().max(300), titleTruncated: z.boolean(), revision: z.string().max(200), version: z.number().int().nonnegative() }).nullable(), ...agentChatToolResultFields }),
]);
export type PlanningRecordsToolResult = z.infer<typeof PlanningRecordsToolResultSchema>;
