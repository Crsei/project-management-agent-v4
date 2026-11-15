import { z } from "zod";
import { providerOptionSelectionSchema, interactionModeSchema } from "./chat.ts";
import { executionSelectionSchema, executionEnvironmentSchema } from "./execution.ts";
import { taskBriefSchema, taskBriefRevisionSchema, taskBriefEntityIdSchema } from "./task-brief.ts";
import { nativeInteractionRequestSchema } from "./output.ts";
import { pmToolCallRecordSchema } from "./pm-tools.ts";
import { pmCommentAgentOriginSchema } from "./pm-tool-linkage.ts";

const id = z.string().trim().min(1).max(128);
const version = z.number().int().positive();
const timestamp = z.string().datetime({ offset: true });
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const uniqueIds = z.array(taskBriefEntityIdSchema).max(1000).refine(items => new Set(items).size === items.length, "Duplicate project references");
export const collaborationDefinitionStateSchema = z.enum(["active", "disabled", "archived"]);
export type CollaborationDefinitionState = z.infer<typeof collaborationDefinitionStateSchema>;
export const collaborationResourceLimitsSchema = z.strictObject({
  maxActiveRuns: z.number().int().min(1).max(3),
  maxDelegationDepth: z.number().int().min(0).max(3),
  maxRuns: z.number().int().min(1).max(100),
  maxDurationMs: z.number().int().min(1000).max(86_400_000),
  maxOutputBytes: z.number().int().min(1024).max(16 * 1024 * 1024),
});
export type CollaborationResourceLimits = z.infer<typeof collaborationResourceLimitsSchema>;
export const defaultCollaborationResourceLimits: CollaborationResourceLimits = {
  maxActiveRuns: 2, maxDelegationDepth: 2, maxRuns: 12, maxDurationMs: 3_600_000, maxOutputBytes: 1_048_576,
};
export const collaborationHostToolSchema = z.enum(["delegate_task", "ask_agent"]);
export const agentCapabilityBindingsSchema = z.strictObject({
  restriction: z.enum(["observe", "bound-only", "immutable"]),
  mcp: z.array(z.strictObject({ contextId: id, serverId: id, configFingerprint: fingerprint.nullable(), schemaFingerprint: fingerprint.nullable() })).max(100),
  skills: z.array(z.strictObject({ contextId: id.nullable(), skillId: id, contentFingerprint: fingerprint.nullable() })).max(100),
  hostTools: z.array(collaborationHostToolSchema).max(2),
}).superRefine((value, context) => {
  for (const [field, keys] of [
    ["mcp", value.mcp.map(item => `${item.contextId}:${item.serverId}`)],
    ["skills", value.skills.map(item => `${item.contextId}:${item.skillId}`)],
    ["hostTools", value.hostTools],
  ] as const) if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", path: [field], message: "Duplicate capability binding" });
});
export type AgentCapabilityBindings = z.infer<typeof agentCapabilityBindingsSchema>;
/** References and owner labels are configuration metadata, never authorization or credentials. */
export const agentConfigSchema = z.strictObject({
  name: z.string().trim().min(1).max(200), role: z.string().trim().min(1).max(200),
  instructions: z.string().max(16000), providerInstanceId: id, model: z.string().trim().min(1).max(256),
  modelOptions: z.array(providerOptionSelectionSchema).max(100), interactionMode: interactionModeSchema,
  temperature: z.number().finite().min(0).max(2),
  owner: z.strictObject({ label: z.string().max(200), actorId: z.uuid().nullable() }),
  allowedProjectIds: uniqueIds, capabilityBindings: agentCapabilityBindingsSchema,
  resourceLimits: collaborationResourceLimitsSchema, executionMode: z.enum(["read-only", "write"]),
}).superRefine((value, context) => {
  if (new Set(value.modelOptions.map(option => option.id)).size !== value.modelOptions.length)
    context.addIssue({ code: "custom", path: ["modelOptions"], message: "Duplicate model option" });
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export const agentVersionSchema = z.strictObject({
  agentId: id, workspaceId: z.uuid(), version, config: agentConfigSchema,
  createdBy: z.uuid(), createdAt: timestamp, restoredFromVersion: version.optional(),
});
export type AgentVersion = z.infer<typeof agentVersionSchema>;
export const agentDefinitionSchema = z.strictObject({
  id, workspaceId: z.uuid(), revision: version, state: collaborationDefinitionStateSchema,
  currentVersion: version, config: agentConfigSchema, createdBy: z.uuid(), createdAt: timestamp, updatedAt: timestamp,
});
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export const teamMemberSchema = z.strictObject({ agentId: id, agentVersion: version });
export type TeamMember = z.infer<typeof teamMemberSchema>;
export const teamConfigSchema = z.strictObject({
  name: z.string().trim().min(1).max(200), description: z.string().max(16000),
  members: z.array(teamMemberSchema).min(1).max(12), strategy: z.enum(["sequential", "supervisor"]),
  supervisorAgentId: id.nullable(), allowedProjectIds: uniqueIds, resourceLimits: collaborationResourceLimitsSchema,
}).superRefine((value, context) => {
  if (new Set(value.members.map(member => member.agentId)).size !== value.members.length)
    context.addIssue({ code: "custom", path: ["members"], message: "A Team may reference each Agent only once" });
  if (value.strategy === "sequential" && value.supervisorAgentId !== null)
    context.addIssue({ code: "custom", path: ["supervisorAgentId"], message: "Sequential Teams do not have a supervisor" });
  if (value.strategy === "supervisor" && (!value.supervisorAgentId || !value.members.some(member => member.agentId === value.supervisorAgentId)))
    context.addIssue({ code: "custom", path: ["supervisorAgentId"], message: "Supervisor must reference one fixed member" });
  if (value.members.length > value.resourceLimits.maxRuns)
    context.addIssue({ code: "custom", path: ["resourceLimits", "maxRuns"], message: "Run limit must accommodate all Team members" });
});
export type TeamConfig = z.infer<typeof teamConfigSchema>;
export const teamVersionSchema = z.strictObject({
  teamId: id, workspaceId: z.uuid(), version, config: teamConfigSchema,
  createdBy: z.uuid(), createdAt: timestamp, restoredFromVersion: version.optional(),
});
export type TeamVersion = z.infer<typeof teamVersionSchema>;
export const teamDefinitionSchema = z.strictObject({
  id, workspaceId: z.uuid(), revision: version, state: collaborationDefinitionStateSchema,
  currentVersion: version, config: teamConfigSchema, createdBy: z.uuid(), createdAt: timestamp, updatedAt: timestamp,
});
export type TeamDefinition = z.infer<typeof teamDefinitionSchema>;
export const definitionListQuerySchema = z.strictObject({ workspaceId: z.uuid() });
export const createAgentSchema = z.strictObject({ requestId: id, id, workspaceId: z.uuid(), config: agentConfigSchema });
export const updateAgentSchema = z.strictObject({ requestId: id, revision: version, config: agentConfigSchema.optional(), state: collaborationDefinitionStateSchema.optional() }).refine(value => value.config !== undefined || value.state !== undefined, "Supply config or state");
export const createTeamSchema = z.strictObject({ requestId: id, id, workspaceId: z.uuid(), config: teamConfigSchema });
export const updateTeamSchema = z.strictObject({ requestId: id, revision: version, config: teamConfigSchema.optional(), state: collaborationDefinitionStateSchema.optional() }).refine(value => value.config !== undefined || value.state !== undefined, "Supply config or state");
export const copyDefinitionSchema = z.strictObject({ requestId: id, id, revision: version, name: z.string().trim().min(1).max(200) });
export const restoreDefinitionVersionSchema = z.strictObject({ requestId: id, revision: version, version });
export type CreateAgent = z.infer<typeof createAgentSchema>;
export type UpdateAgent = z.infer<typeof updateAgentSchema>;
export type CreateTeam = z.infer<typeof createTeamSchema>;
export type UpdateTeam = z.infer<typeof updateTeamSchema>;
export type CopyDefinition = z.infer<typeof copyDefinitionSchema>;
export type RestoreDefinitionVersion = z.infer<typeof restoreDefinitionVersionSchema>;
export const agentsResponseSchema = z.strictObject({ agents: z.array(agentDefinitionSchema) });
export const agentResponseSchema = z.strictObject({ agent: agentDefinitionSchema });
export const agentDetailResponseSchema = z.strictObject({ agent: agentDefinitionSchema, versions: z.array(agentVersionSchema) });
export const teamsResponseSchema = z.strictObject({ teams: z.array(teamDefinitionSchema) });
export const teamResponseSchema = z.strictObject({ team: teamDefinitionSchema });
export const teamDetailResponseSchema = z.strictObject({ team: teamDefinitionSchema, versions: z.array(teamVersionSchema) });
export type AgentsResponse = z.infer<typeof agentsResponseSchema>;
export type AgentResponse = z.infer<typeof agentResponseSchema>;
export type AgentDetailResponse = z.infer<typeof agentDetailResponseSchema>;
export type TeamsResponse = z.infer<typeof teamsResponseSchema>;
export type TeamResponse = z.infer<typeof teamResponseSchema>;
export type TeamDetailResponse = z.infer<typeof teamDetailResponseSchema>;
export const definitionRequestSchema = z.strictObject({
  requestId: id, fingerprint, kind: z.enum(["agent", "team"]), definitionId: id,
  result: z.union([agentDefinitionSchema, teamDefinitionSchema]),
});
export type DefinitionRequest = z.infer<typeof definitionRequestSchema>;
export const definitionRequestResponseSchema = z.strictObject({ request: definitionRequestSchema.nullable() });
export type DefinitionRequestResponse = z.infer<typeof definitionRequestResponseSchema>;

export const capabilityFactStateSchema = z.enum(["yes", "no", "unknown"]);
export const capabilityManifestSchema = z.strictObject({
  providerInstanceId: id, providerRevision: version, providerKind: id,
  bindingFingerprint: fingerprint.nullable(), contextIds: z.array(id), observedAt: timestamp,
  restriction: z.enum(["observe", "bound-only", "immutable"]),
  hostTools: z.strictObject({ supported: z.boolean(), reason: z.string().nullable() }),
  sharedHome: z.strictObject({ shared: z.boolean(), providerInstanceIds: z.array(id), reloadRequired: z.boolean() }),
  entries: z.array(z.strictObject({ kind: z.enum(["mcp", "skill"]), referenceId: id, contextId: id.nullable(),
    installed: capabilityFactStateSchema, assigned: capabilityFactStateSchema, authorized: capabilityFactStateSchema,
    discovered: capabilityFactStateSchema, loaded: capabilityFactStateSchema,
    configFingerprint: fingerprint.nullable(), schemaFingerprint: fingerprint.nullable(), contentFingerprint: fingerprint.nullable(), evidence: z.array(z.string()),
  })), fingerprint, limitations: z.array(z.string()),
});
export type CapabilityManifest = z.infer<typeof capabilityManifestSchema>;
export const capabilitiesQuerySchema = z.strictObject({ workspaceId: z.uuid(), projectId: taskBriefEntityIdSchema.optional(), agentId: id.optional(), agentVersion: z.coerce.number().int().positive().optional(), providerInstanceId: id.optional() }).superRefine((value, context) => {
  if ((value.agentId === undefined) !== (value.agentVersion === undefined)) context.addIssue({ code: "custom", message: "Supply Agent ID and version together" });
  if (!value.agentId && !value.providerInstanceId) context.addIssue({ code: "custom", message: "Select an Agent version or Provider instance" });
});
export const capabilitiesResponseSchema = z.strictObject({ manifest: capabilityManifestSchema });
export type CapabilitiesResponse = z.infer<typeof capabilitiesResponseSchema>;

export const collaborationTargetSchema = z.strictObject({ workspaceId: z.uuid(), projectId: taskBriefEntityIdSchema, taskId: taskBriefEntityIdSchema, taskRevision: taskBriefRevisionSchema });
export type CollaborationTarget = z.infer<typeof collaborationTargetSchema>;
export const runDefinitionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("agent"), agentId: id, agentVersion: version }),
  z.strictObject({ kind: z.literal("team"), teamId: id, teamVersion: version }),
]);
export type RunDefinition = z.infer<typeof runDefinitionSchema>;
export const createRunSchema = z.strictObject({
  id, requestId: id, target: collaborationTargetSchema, definition: runDefinitionSchema,
  executionSelection: executionSelectionSchema, goal: z.string().trim().min(1).max(16000), input: z.string().max(48000).default(""),
});
export type CreateRun = z.infer<typeof createRunSchema>;
export const collaborationRunStatusSchema = z.enum(["queued", "running", "waiting", "succeeded", "failed", "cancelled", "interrupted", "unknown"]);
export type CollaborationRunStatus = z.infer<typeof collaborationRunStatusSchema>;
export const runResultReferenceSchema = z.strictObject({
  threadId: id, generationId: id, messageId: id.nullable(), outputItemIds: z.array(id),
  summary: z.string().max(16000).nullable(), summarySource: z.enum(["assistant_final", "assistant_output", "operator"]).nullable(),
  /** Current-reader projection; hidden summaries must not reveal retained private output. */
  visibility: z.enum(["visible", "redacted", "unavailable"]).optional(),
});
export type RunResultReference = z.infer<typeof runResultReferenceSchema>;
export const runOperationReferenceSchema = z.strictObject({ operationId: id, kind: z.enum(["pm_tool", "comment", "chat_acceptance", "cancel"]), status: z.enum(["pending", "succeeded", "failed", "unknown"]), commandId: id.nullable() });
export const runWaitSchema = z.strictObject({ kind: z.enum(["agent_concurrency", "workspace_writer", "children", "native_input", "pm_approval", "duration_limit", "run_limit", "output_limit"]), since: timestamp, reason: z.string(), blockingRunIds: z.array(id) });
export type RunWait = z.infer<typeof runWaitSchema>;
/** Business state is separate from native generation state; success never completes the PM task. */
export const collaborationRunSchema = z.strictObject({
  id, revision: version, requestId: id, requestFingerprint: fingerprint, target: collaborationTargetSchema,
  definition: runDefinitionSchema, goal: z.string(), input: z.string(), actorId: z.uuid(),
  rootRunId: id, parentRunId: id.nullable(), delegationId: id.nullable(), depth: z.number().int().nonnegative(),
  status: collaborationRunStatusSchema, createdAt: timestamp, updatedAt: timestamp,
  startedAt: timestamp.nullable(), finishedAt: timestamp.nullable(), deadlineAt: timestamp,
  executionSelection: executionSelectionSchema, executionEnvironment: executionEnvironmentSchema.nullable(),
  directoryIdentity: z.strictObject({ path: z.string(), device: z.string(), inode: z.string() }).nullable(),
  agentVersions: z.array(agentVersionSchema), teamVersion: teamVersionSchema.nullable(),
  capabilityManifests: z.array(capabilityManifestSchema), taskBrief: taskBriefSchema.nullable(),
  resourceLimits: collaborationResourceLimitsSchema, executionMode: z.enum(["read-only", "write"]),
  threadId: id.nullable(), generationId: id.nullable(), inputMessageId: id.nullable(),
  operationRefs: z.array(runOperationReferenceSchema), resultRefs: z.array(runResultReferenceSchema),
  wait: runWaitSchema.nullable(), error: z.strictObject({ code: z.string(), message: z.string() }).nullable(),
  cancellation: z.strictObject({ requestedAt: timestamp, requestedBy: z.uuid(), observedAt: timestamp.nullable() }).nullable(),
});
export type CollaborationRun = z.infer<typeof collaborationRunSchema>;
export const delegationInputSchema = z.strictObject({ agentId: id, agentVersion: version, goal: z.string().trim().min(1).max(16000), input: z.string().max(48000) });
export type DelegationInput = z.infer<typeof delegationInputSchema>;
export const collaborationDelegationSchema = z.strictObject({
  id, kind: collaborationHostToolSchema, rootRunId: id, parentRunId: id, childRunId: id.nullable(),
  parentGenerationId: id, originalCallId: id, requestFingerprint: fingerprint,
  agentId: id, agentVersion: version, goal: z.string(), input: z.string(),
  status: collaborationRunStatusSchema, required: z.boolean(), createdAt: timestamp, updatedAt: timestamp, finishedAt: timestamp.nullable(),
  resultRefs: z.array(runResultReferenceSchema), responsePublishedAt: timestamp.nullable(), error: z.strictObject({ code: z.string(), message: z.string() }).nullable(),
}).superRefine((value, context) => {
  if (value.childRunId === null && (value.status !== "failed" || value.required || value.error === null || value.finishedAt === null || value.resultRefs.length > 0))
    context.addIssue({ code: "custom", path: ["childRunId"], message: "A rejected delegation has no child, a final failure, an error, and no required child results" });
});
export type CollaborationDelegation = z.infer<typeof collaborationDelegationSchema>;
export const delegationAcceptedSchema = z.strictObject({ delegationId: id, childRunId: id, status: collaborationRunStatusSchema, threadId: id.nullable(), generationId: id.nullable(), asynchronous: z.literal(true) });
export type DelegationAccepted = z.infer<typeof delegationAcceptedSchema>;
export const runsQuerySchema = z.strictObject({ workspaceId: z.uuid(), projectId: taskBriefEntityIdSchema.optional(), taskId: taskBriefEntityIdSchema.optional() });
export const cancelRunSchema = z.strictObject({ requestId: id, revision: version, generationId: id.nullable() });
export type CancelRun = z.infer<typeof cancelRunSchema>;
export const runResponseSchema = z.strictObject({ run: collaborationRunSchema });
export const runsResponseSchema = z.strictObject({ runs: z.array(collaborationRunSchema) });
export const runEvidenceSchema = z.strictObject({ kind: z.enum(["native_output", "pm_operation", "comment", "usage"]), id, threadId: id.nullable(), generationId: id.nullable(), href: z.string().nullable() });
export const runDiscussionLinkSchema = z.strictObject({ workspaceId: z.uuid(), projectId: taskBriefEntityIdSchema, taskId: taskBriefEntityIdSchema, href: z.string() });
/** Same PM comment page projection; no private Session transcript is copied into discussion. */
export const collaborationCommentSchema = z.strictObject({
  id: z.uuid(), workspaceId: z.uuid(), projectId: taskBriefEntityIdSchema, taskId: taskBriefEntityIdSchema,
  authorId: z.uuid(), version, content: z.string().nullable(), deletedAt: timestamp.nullable(),
  createdAt: timestamp, updatedAt: timestamp, origin: pmCommentAgentOriginSchema.nullable().optional(),
});
export const collaborationDiscussionSchema = z.strictObject({
  taskId: taskBriefEntityIdSchema, projectId: taskBriefEntityIdSchema,
  items: z.array(collaborationCommentSchema), nextCursor: z.uuid().nullable(),
});
export type CollaborationDiscussion = z.infer<typeof collaborationDiscussionSchema>;
export const runDetailResponseSchema = z.strictObject({ run: collaborationRunSchema, delegations: z.array(collaborationDelegationSchema), discussion: collaborationDiscussionSchema.optional(), evidence: z.array(runEvidenceSchema).optional() });
export type RunResponse = z.infer<typeof runResponseSchema>;
export type RunsResponse = z.infer<typeof runsResponseSchema>;
export type RunDetailResponse = z.infer<typeof runDetailResponseSchema>;

const inboxBase = { id, runId: id.nullable(), createdAt: timestamp, respondable: z.boolean(), unavailableReason: z.string().nullable(), href: z.string() };
export const collaborationInboxItemSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...inboxBase, kind: z.literal("native_input"), threadId: z.string().min(1).max(256), generationId: id, requestId: z.string().min(1).max(512), request: nativeInteractionRequestSchema }),
  z.strictObject({ ...inboxBase, kind: z.literal("pm_approval"), operationId: z.uuid(), call: pmToolCallRecordSchema, capabilityFingerprint: fingerprint.nullable(), decisionFingerprint: fingerprint }),
  z.strictObject({ ...inboxBase, kind: z.literal("resource_wait"), wait: runWaitSchema }),
]);
export type CollaborationInboxItem = z.infer<typeof collaborationInboxItemSchema>;
export const inboxQuerySchema = z.strictObject({ workspaceId: z.uuid(), projectId: taskBriefEntityIdSchema.optional(), taskId: taskBriefEntityIdSchema.optional(), runId: id.optional() });
export const inboxResponseSchema = z.strictObject({ items: z.array(collaborationInboxItemSchema) });
export type InboxResponse = z.infer<typeof inboxResponseSchema>;
