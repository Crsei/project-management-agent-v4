import { z } from 'zod';
import type { Capability } from '../../domain/src/core.ts';
import { roadmapPlanSchema } from '../../contracts/src/product-roadmap.ts';
import { MAX_WORK_ITEM_ESTIMATE_POINTS, MAX_WORK_ITEM_LOCATION_LENGTH } from '../../pm-schema/index.ts';

const uuid = z.uuid().toLowerCase();
const nativeId = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/);
const entityId = z.union([nativeId, uuid]);
const text = z.string().trim().min(1).max(16000);
const deliveryText = z.string().trim().min(1).max(20000);
const uniqueIds = z.array(uuid).max(200).refine(items => new Set(items).size === items.length, 'Duplicate references');
const entityRef = z.strictObject({ kind: z.enum(['project', 'work_item', 'milestone', 'conversation', 'intent', 'decision', 'upload', 'artifact', 'artifact_version', 'evidence', 'submission', 'review']), id: entityId });
const sourceMessageRefs = z.array(z.strictObject({ messageId: uuid, contentVersion: z.number().int().positive() })).max(100).default([]);
const intentFields = { summary: z.string().trim().min(1).max(1000), goal: text, conversationId: uuid.nullable().default(null), sourceMessageRefs };
const basisRefs = z.array(entityRef).max(100).default([]);
const scope = { projectId: nativeId.nullable() };
const versions = z.array(z.strictObject({ id: entityId, version: z.number().int().positive() })).max(200).refine(items => new Set(items.map(item => item.id)).size === items.length, 'Duplicate expected versions');
const write = { ...scope, targetId: entityId.nullable(), expectedVersions: versions };
const criterion = z.strictObject({ criterionId: z.string().min(1).max(160), result: z.enum(['pass', 'fail', 'inconclusive']), basisRefs: uniqueIds.refine(items => items.length > 0, 'At least one basis reference is required'), explanation: deliveryText });

/** Closed native business command payloads; identity and authorization are never supplied in a payload. */
export const planningRecordsCommandPayloadSchemas = {
  RecordEvidence: z.strictObject({ subjectRefs: z.array(entityId).min(1).max(200).refine(items => new Set(items).size === items.length, 'Duplicate subjects'), method: deliveryText, scope: deliveryText, result: z.enum(['pass', 'fail', 'inconclusive']), observedAt: z.iso.datetime({ offset: true }), artifactVersionRefs: uniqueIds, sourceRunId: z.null().optional() }),
  SubmitWorkItemResult: z.strictObject({ contentRevision: z.number().int().positive(), artifactVersionIds: uniqueIds.refine(items => items.length > 0, 'At least one artifact version is required'), evidenceIds: uniqueIds }),
  ReturnWorkItemForChanges: z.strictObject({ reason: deliveryText, reviewId: uuid.optional() }),
  RecordReview: z.strictObject({ criterionResults: z.array(criterion).min(1).max(200), verdict: z.enum(['passed', 'changes_requested']), reason: deliveryText }),
  CreateConversation: z.strictObject({ title: z.string().trim().min(1).max(300) }),
  AppendMessage: z.strictObject({ content: text }),
  ProposeIntent: z.strictObject(intentFields),
  ReviseIntent: z.strictObject({ ...intentFields, revision: z.number().int().positive() }),
  AcceptIntent: z.strictObject({ revision: z.number().int().positive(), reason: text, basisRefs }),
  RejectIntent: z.strictObject({ revision: z.number().int().positive(), reason: text, basisRefs }),
  WithdrawIntent: z.strictObject({ reason: text }),
  RecordDecision: z.strictObject({ subjectRef: entityRef, decisionType: z.enum(['note', 'supersede']), reason: text, basisRefs, supersedesDecisionId: uuid.nullable().default(null) }),
  CreateWorkItemFromIntent: z.strictObject({
    title: z.string().trim().min(1).max(300), description: z.string().max(64000),
    acceptanceCriteria: z.array(z.strictObject({ id: z.union([uuid, z.string().regex(/^[A-Z][A-Z0-9]*-\d+-AC-[1-9]\d*$/)]), text })).max(100).refine(items => new Set(items.map(item => item.id)).size === items.length, 'Duplicate criterion ID'),
    assigneeId: uuid.nullable().default(null), priority: z.enum(['low', 'normal', 'high', 'urgent']).nullable().default(null),
    startDate: z.iso.date().nullable().optional(), dueDate: z.iso.date().nullable().optional(), labels: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
    kind: z.enum(['epic', 'task', 'bug', 'subtask']).optional(), parentId: nativeId.nullable().optional(), estimatePoints: z.number().finite().nonnegative().max(MAX_WORK_ITEM_ESTIMATE_POINTS).nullable().optional(), location: z.string().trim().max(MAX_WORK_ITEM_LOCATION_LENGTH).nullable().optional(),
    intentId: uuid, acceptedRevision: z.number().int().positive(), decisionId: uuid,
  }),
} as const;
export type PlanningRecordsCommandType = keyof typeof planningRecordsCommandPayloadSchemas;
export const planningRecordsNativeInputSchemas = {
  RecordEvidence: z.strictObject({ ...write, payload: planningRecordsCommandPayloadSchemas.RecordEvidence }),
  SubmitWorkItemResult: z.strictObject({ ...write, payload: planningRecordsCommandPayloadSchemas.SubmitWorkItemResult }),
  ReturnWorkItemForChanges: z.strictObject({ ...write, payload: planningRecordsCommandPayloadSchemas.ReturnWorkItemForChanges }),
  RecordReview: z.strictObject({ ...write, payload: planningRecordsCommandPayloadSchemas.RecordReview }),
  CreateConversation: z.strictObject({ ...write, payload: planningRecordsCommandPayloadSchemas.CreateConversation }),
  AppendMessage: z.strictObject({ ...write, payload: planningRecordsCommandPayloadSchemas.AppendMessage }),
  ProposeIntent: z.strictObject({ ...write, payload: planningRecordsCommandPayloadSchemas.ProposeIntent }),
  ReviseIntent: z.strictObject({ ...write, payload: planningRecordsCommandPayloadSchemas.ReviseIntent }),
  AcceptIntent: z.strictObject({ ...write, payload: planningRecordsCommandPayloadSchemas.AcceptIntent }),
  RejectIntent: z.strictObject({ ...write, payload: planningRecordsCommandPayloadSchemas.RejectIntent }),
  WithdrawIntent: z.strictObject({ ...write, payload: planningRecordsCommandPayloadSchemas.WithdrawIntent }),
  RecordDecision: z.strictObject({ ...write, payload: planningRecordsCommandPayloadSchemas.RecordDecision }),
  CreateWorkItemFromIntent: z.strictObject({ ...write, payload: planningRecordsCommandPayloadSchemas.CreateWorkItemFromIntent }),
} as const;
export const planningRecordsResourceSchema = z.enum(['evidence', 'submission', 'review', 'conversation', 'intent', 'decision']);
export const PlanningRecordsToolInputSchemas = {
  pm_list_planning_records: z.strictObject({ resource: planningRecordsResourceSchema, projectId: nativeId.nullable(), limit: z.number().int().min(1).max(20).default(20), after: z.string().max(500).nullable().default(null) }),
  pm_read_planning_record: z.strictObject({ resource: planningRecordsResourceSchema, id: uuid, messageOffset: z.number().int().nonnegative().default(0), messageLimit: z.number().int().min(1).max(20).default(20) }),
  pm_record_evidence: planningRecordsNativeInputSchemas.RecordEvidence,
  pm_submit_work_item_result: planningRecordsNativeInputSchemas.SubmitWorkItemResult,
  pm_return_work_item_for_changes: planningRecordsNativeInputSchemas.ReturnWorkItemForChanges,
  pm_create_conversation: planningRecordsNativeInputSchemas.CreateConversation,
  pm_append_conversation_message: planningRecordsNativeInputSchemas.AppendMessage,
  pm_propose_intent: planningRecordsNativeInputSchemas.ProposeIntent,
  pm_revise_intent: planningRecordsNativeInputSchemas.ReviseIntent,
  pm_accept_intent: planningRecordsNativeInputSchemas.AcceptIntent,
  pm_reject_intent: planningRecordsNativeInputSchemas.RejectIntent,
  pm_withdraw_intent: planningRecordsNativeInputSchemas.WithdrawIntent,
  pm_record_decision: planningRecordsNativeInputSchemas.RecordDecision,
  pm_create_task_from_intent: planningRecordsNativeInputSchemas.CreateWorkItemFromIntent,
  pm_read_roadmap: z.strictObject({ projectId: nativeId }),
  pm_save_roadmap: z.strictObject({ projectId: nativeId, revision: z.string().min(1).max(200), plan: roadmapPlanSchema }),
  pm_publish_roadmap: z.strictObject({ projectId: nativeId, revision: z.string().min(1).max(200), releaseId: uuid, confirm: z.literal(true) }),
  pm_materialize_roadmap: z.strictObject({ projectId: nativeId, releaseId: uuid, nodeIds: z.array(uuid).min(1).max(24).refine(ids => new Set(ids).size === ids.length, 'Duplicate nodes'), confirm: z.literal(true) }),
} as const;
export type PlanningRecordsToolName = keyof typeof PlanningRecordsToolInputSchemas;
export type PlanningRecordsToolMetadataEntry = { description: string; write: boolean; capabilities: Capability[]; scope: 'project' };
const metadata = (description: string, write: boolean, capability?: Capability) => ({ description, write, capabilities: ['domain.read', ...(capability ? [capability] : [])] as Capability[], scope: 'project' as const });
export const PlanningRecordsToolMetadata = {
  pm_list_planning_records: metadata('List a bounded currently authorized page of real Evidence, Submission, Review, PM Conversation, Intent or business Decision records. Not Agent Chat or document-kind decision.', false),
  pm_read_planning_record: metadata('Read one authorized immutable delivery or PM planning record; conversation messages have explicit offset pagination.', false),
  pm_record_evidence: metadata('Record observed evidence with actual immutable artifact-version UUID references. Does not approve delivery or complete a task.', true, 'delivery.write'),
  pm_submit_work_item_result: metadata('Submit immutable artifact versions and evidence against the exact current task version and scope. Does not transition task state.', true, 'delivery.submit'),
  pm_return_work_item_for_changes: metadata('Record return-for-changes against the current submission through the independent delivery service. Does not change task state.', true, 'delivery.submit'),
  pm_create_conversation: metadata('Create a PM business conversation, preserving the authenticated author. This is not Agent Chat.', true, 'intent.propose'),
  pm_append_conversation_message: metadata('Append an immutable authored PM conversation message at the exact aggregate version.', true, 'intent.propose'),
  pm_propose_intent: metadata('Propose an intent with exact source conversation message versions; creates no task.', true, 'intent.propose'),
  pm_revise_intent: metadata('Revise a proposed intent at its aggregate and intent revision. Accepted/rejected historical versions are not overwritten.', true, 'intent.propose'),
  pm_accept_intent: metadata('Accept the exact intent revision under the authenticated principal and native intent.decide capability; retain the business Decision receipt. Does not create work.', true, 'intent.decide'),
  pm_reject_intent: metadata('Reject the exact intent revision with an immutable business Decision and authenticated decision actor.', true, 'intent.decide'),
  pm_withdraw_intent: metadata('Withdraw a proposed intent at its exact aggregate version; native author/decider capability checks apply.', true),
  pm_record_decision: metadata('Record a real immutable business Decision with subject and basis references; cannot stand in for acceptance or mutate prior work.', true, 'intent.decide'),
  pm_create_task_from_intent: metadata('Convert an explicitly accepted intent revision and its real decision into one native task. Native durable conversion guards prevent duplicates, including response loss.', true, 'planning.edit'),
  pm_read_roadmap: metadata('Read the dedicated roadmap draft, immutable releases, native task mapping and requirement/dependency drift. No execution or completion.', false),
  pm_save_roadmap: metadata('Save only the roadmap draft at the exact project revision. Published plans remain immutable.', true, 'planning.edit'),
  pm_publish_roadmap: metadata('Publish a validated immutable roadmap version after explicit confirmation. Does not create tasks or dispatch execution.', true, 'planning.edit'),
  pm_materialize_roadmap: metadata('Materialize explicitly selected published node keys and their dependency closure, preserving original per-node creation identities and real blocked_by IDs. Never ordinary task creation, retry, or completion.', true, 'planning.edit'),
} satisfies Record<PlanningRecordsToolName, PlanningRecordsToolMetadataEntry>;
export const planningRecordsToolCommands = {
  pm_record_evidence: 'RecordEvidence', pm_submit_work_item_result: 'SubmitWorkItemResult', pm_return_work_item_for_changes: 'ReturnWorkItemForChanges',
  pm_create_conversation: 'CreateConversation', pm_append_conversation_message: 'AppendMessage', pm_propose_intent: 'ProposeIntent', pm_revise_intent: 'ReviseIntent',
  pm_accept_intent: 'AcceptIntent', pm_reject_intent: 'RejectIntent', pm_withdraw_intent: 'WithdrawIntent', pm_record_decision: 'RecordDecision', pm_create_task_from_intent: 'CreateWorkItemFromIntent',
} as const;
