import type { PmToolCallRecord } from "@agent-workspace/contracts/pm-tools";
import type { CollaborationToolResult } from "../../../../../../../packages/agent-contracts/src/pm-tool-collaboration";
import type { PlanningRecordsRecord } from "../../../../../../../packages/agent-contracts/src/pm-tool-planning-records";
type StudioConfig = Extract<NonNullable<PmToolCallRecord["result"]>, { kind: "automation_definition" }>["definition"]["config"];

export const fixtureWorkspaceId = "00000000-0000-4000-8000-000000000001";
export const fixtureActorId = "00000000-0000-4000-8000-000000000002";
export const fixtureOperationId = "00000000-0000-4000-8000-000000000003";
const id = "00000000-0000-4000-8000-000000000004";
const at = "2026-11-13T00:00:00Z";
const revision = "a".repeat(64);
const fields = { nextCursor: null, truncated: false, sources: [] };
const receipt = { kind: "application" as const, operationId: fixtureOperationId, commandId: id, action: "FixtureAction", targetId: id, revision: "1" };
const entity = { id: "TASK-001", projectId: "PRJ-001", entity: "work_item" as const, title: "Visible fixture entity", revision, version: 1, status: "ready" };
const source = { refId: "project-source", kind: "project" as const, id: "PRJ-001", revision, actorId: fixtureActorId, workspaceId: fixtureWorkspaceId, projectId: "PRJ-001", label: "Fixture project", url: null, updatedAt: at };
const workflowSource = { ...source, refId: "workflow-source", kind: "workflow" as const, id: "workflow" };
const coverageKinds = ["project", "workflow", "tasks", "relationships", "documents", "comments", "activities", "sessions", "executions", "pull-requests", "milestones", "versions", "visits"] as const;
const coverage = coverageKinds.map(source => ({ source, status: "complete" as const, observedRecords: 0, totalRecords: 0, reason: null }));
export const fixtureAutomationConfig: StudioConfig = { name: "Fixture automation", description: "Saved only", projectId: "PRJ-001", tags: [], templateId: null, action: { kind: "prompt", prompt: "Do not execute fixture", repositories: [], plugins: [], timeoutSeconds: 30, providerInstanceId: "fixture-provider", model: "fixture-model", options: {} }, trigger: { kind: "manual" }, dailyLimit: 1, cooldownMinutes: 0 };
const definition = { id, revision: 1, config: fixtureAutomationConfig, status: "draft" as const, createdAt: at, updatedAt: at, lastRunAt: null, nextDueAt: null };
const execution = { id, definitionId: id, definitionRevision: 1, configSnapshot: fixtureAutomationConfig, trigger: "manual" as const, requestId: fixtureOperationId, status: "outcome_unknown" as const, createdAt: at, startedAt: null, finishedAt: null, threadId: null, externalExecutionId: null, error: null, summary: "Original execution outcome not known" };
const candidate = { id: "candidate-1", kind: "create-document" as const, title: "Fixture candidate", rationale: "Needs human review", sourceRefs: [source], evidence: [], status: "pending" as const, revision: 1, document: { title: "Draft document", body: "Not applied", taskIds: [] } };
const preview = { candidate, currentSources: [source], currentTask: null, canApply: false, conflicts: ["Fixture conflict"], previewToken: null, selectedItemIds: [] };
const gitOperation = { id, status: "outcome_unknown" as const, commit: null, startedAt: at, finishedAt: null, error: null };
const gitStatus = { revision: 0, config: null, tokenSet: false, encryptionKeySet: false, capability: { available: false, reason: "Not configured", secretsAvailable: false }, lastCommit: null, lastSyncedAt: null, dirtyCount: 0, operation: gitOperation };
const workload = { serverNow: at, unit: "concurrent_open_points" as const, scope: { complete: false, projectIds: ["PRJ-001"], reason: "projects" as const }, summary: { openCount: 0, doneCount: 0, knownOpenPoints: 0, unknownEstimateCount: 0, unknownAssigneeCount: 0, overloadedMemberCount: 0, unknownOverloadMemberCount: 0 } };
const period = { start: at, end: at, durationMs: 0 };
const migration = { id: "migration-fixture", revision, kind: "transform" as const, status: "preview" as const, totalFiles: 0, diagnostics: [] };
const delivery = { deliveryId: id, endpointId: id, eventId: id, state: "unknown" as const, version: 1, attemptNo: 1, safeFailureCode: null, acceptedAt: null, createdAt: at, resumeReceiptId: null, reconciliationRequested: false };
type Result = NonNullable<PmToolCallRecord["result"]>;
type ContentKind = Exclude<Result["kind"], "task_brief" | "knowledge" | "workflow">;
type FixtureMap = { [Kind in ContentKind]: Result & { kind: Kind } };

/** Synthetic typed inputs only. No fixture writes, paid execution or service identities. */
export const pmToolResultFixtures = {
  project: { kind: "project", items: [{ ...entity, id: "PRJ-001", entity: "project", projectId: null }], ...fields },
  task: { kind: "task", items: [entity], ...fields },
  document: { kind: "document", items: [{ ...entity, id: "DOC-001", entity: "document", body: "", bodyOffset: 0, nextBodyOffset: null }], ...fields },
  cycle: { kind: "cycle", items: [{ ...entity, id: "CYC-001", entity: "cycle" }], ...fields },
  milestone: { kind: "milestone", items: [{ ...entity, id: "MILE-001", entity: "milestone" }], ...fields },
  module: { kind: "module", items: [{ ...entity, id: "MOD-001", entity: "module" }], ...fields },
  requirement: { kind: "requirement", items: [{ ...entity, id: "REQ-001", entity: "requirement" }], ...fields },
  release: { kind: "release", items: [{ ...entity, id: "REL-001", entity: "release" }], ...fields },
  goal: { kind: "goal", items: [{ ...entity, id: "GOAL-001", entity: "goal" }], ...fields },
  query: { kind: "query", items: [], ...fields },
  lifecycle: { kind: "lifecycle", items: [], ...fields, receipt },
  workspaces: { kind: "workspaces", items: [], ...fields },
  comment: { kind: "comment", items: [{ id, taskId: "TASK-001", projectId: "PRJ-001", content: null, version: 2, deletedAt: at }], ...fields },
  relation: { kind: "relation", items: [{ sourceId: "TASK-001", targetId: "REQ-001", relation: "related_to", sourceRevision: revision, targetRevision: revision }], ...fields },
  views: { kind: "views", items: [{ id: "fixture-view", name: "Fixture view", layout: "table", revision }], ...fields },
  configuration: { kind: "configuration", items: [], configuration: { schema: "pm/config/v1", workflows: {}, custom_fields: [] }, revision: "absent", diagnostics: [], ...fields },
  migrations: { kind: "migrations", items: [], ...fields },
  migration: { kind: "migration", items: [], migration, ...fields },
  collaboration: { kind: "collaboration", result: { type: "acknowledgement", acknowledgement: { reviewedThrough: "3", head: "4", pendingCount: 1 } }, ...fields },
  administration_workspace: { kind: "administration_workspace", items: [], ...fields },
  administration_profile: { kind: "administration_profile", items: [], ...fields },
  administration_members: { kind: "administration_members", items: [], serverNow: at, presenceTtlMs: 30000, canManageMembers: false, ...fields },
  administration_invitations: { kind: "administration_invitations", items: [], enabled: false, ...fields },
  administration_teams: { kind: "administration_teams", items: [], canManage: false, ...fields },
  administration_workload_members: { kind: "administration_workload_members", items: [], ...workload, ...fields },
  administration_workload_tasks: { kind: "administration_workload_tasks", items: [], ...workload, ...fields },
  administration_workload_teams: { kind: "administration_workload_teams", items: [], ...workload, ...fields },
  administration_project_extras: { kind: "administration_project_extras", items: [], sidebarOrder: null, ...fields },
  administration_project_directory: { kind: "administration_project_directory", items: [], ...fields },
  administration_directory_reference: { kind: "administration_directory_reference", items: [{ projectId: "PRJ-001", storageId: null, kind: "local", status: "unavailable" }], ...fields },
  administration_command: { kind: "administration_command", items: [{ id, version: 1 }], ...fields, receipt },
  "document-sources": { kind: "document-sources", items: [], scopes: [{ projectId: "PRJ-001", name: "Fixture scope", revision: 0, canManage: false }], ...fields },
  "external-files": { kind: "external-files", sourceId: "fixture-source", sourceRevision: 1, items: [], scanComplete: false, issues: [{ path: "missing.md", code: "unavailable" }], ...fields },
  "external-file": { kind: "external-file", sourceId: "fixture-source", items: [{ path: "fixture.md", content: "Visible body page", size: 50, modifiedAt: at, sourceRevision: 1, revision, canWrite: false, contentOffset: 0, nextContentOffset: 17 }], ...fields, truncated: true },
  "external-file-operation": { kind: "external-file-operation", sourceId: "fixture-source", items: [{ operationId: fixtureOperationId, action: "move", path: "before.md", targetSourceId: "target-source", targetPath: "after.md", status: "unknown", message: "Reconcile original operation only" }], ...fields },
  uploads: { kind: "uploads", items: [], ...fields },
  artifacts: { kind: "artifacts", items: [], ...fields },
  "artifact-versions": { kind: "artifact-versions", items: [{ id, workspaceId: fixtureWorkspaceId, projectId: "PRJ-001", version: 1, artifactId: id, uploadId: id, sha256: revision, contentDigest: revision, size: 0, mediaType: "text/plain", fileName: "fixture.txt", producerId: fixtureActorId, downloadPath: `/api/v1/workspaces/${fixtureWorkspaceId}/artifact-versions/${id}/content` }], ...fields },
  "artifact-mutation": { kind: "artifact-mutation", artifacts: [], versions: [], ...fields, receipt },
  "artifact-copy-origin": { kind: "artifact-copy-origin", artifactVersionId: id, origin: null, ...fields },
  dashboard_notes: { kind: "dashboard_notes", items: [], ...fields },
  dashboard_meetings: { kind: "dashboard_meetings", items: [], ...fields },
  dashboard_meeting_participants: { kind: "dashboard_meeting_participants", items: [], canListParticipants: false, ...fields },
  dashboard_watches: { kind: "dashboard_watches", items: [], ...fields },
  dashboard_presence: { kind: "dashboard_presence", self: { userId: fixtureActorId, name: "Fixture self", preference: "online", status: "offline", lastHeartbeatAt: null, preferenceId: null, preferenceVersion: null, heartbeatId: null, heartbeatVersion: null }, items: [], serverNow: at, directoryVisible: false, ttlMs: 30000, ...fields },
  dashboard_timer: { kind: "dashboard_timer", activeTimer: null, serverNow: at, ...fields },
  dashboard_worklogs: { kind: "dashboard_worklogs", items: [], totals: { day: period, week: period, month: period }, totalsScope: "actor", timeZone: "UTC", serverNow: at, ...fields },
  dashboard_portfolio: { kind: "dashboard_portfolio", section: "current", items: [], totals: null, totalsProjectScope: null, ...fields },
  dashboard_planning: { kind: "dashboard_planning", section: "projects", items: [], ...fields },
  dashboard_critical_path: { kind: "dashboard_critical_path", projectId: "PRJ-001", section: "reasons", status: "unavailable", durationDays: null, model: null, items: [{ row: "reason", code: "missing_duration", taskId: "TASK-001", message: "Duration unknown" }], ...fields },
  dashboard_sprint_metrics: { kind: "dashboard_sprint_metrics", section: "history", historyStatus: "error", historyError: "History unavailable", semantics: "observed_snapshots", items: [], ...fields },
  dashboard_receipt: { kind: "dashboard_receipt", action: "StopTimer", ...fields, receipt },
  planning_records: { kind: "planning_records", records: [], cursor: null, ...fields },
  planning_record_receipt: { kind: "planning_record_receipt", records: [], generatedTask: null, ...fields, receipt },
  planning_roadmap: { kind: "planning_roadmap", roadmap: { projectId: "PRJ-001", title: "Fixture roadmap", revision, archived: false, store: { schema: "pm/product-roadmap/v1", draft: { brief: { idea: "", audience: "", problem: "", journey: "", success: "", nonGoals: "", sharedContract: "", assumptions: "" }, nodes: [] }, releases: [] }, tasks: {} }, selectedNodeIds: [], dependencyClosure: [], idMap: [], ...fields },
  automation_capabilities: { kind: "automation_capabilities", capabilities: { actions: [], providers: [], repositories: [], plugins: [], canWrite: false, scheduler: { authority: "worker", ready: false, reason: "Fixture unavailable" } }, ...fields },
  automation_templates: { kind: "automation_templates", templates: [], ...fields },
  automation_timezones: { kind: "automation_timezones", timezones: [], ...fields },
  automation_validation: { kind: "automation_validation", validation: { valid: false, issues: [{ path: "action", code: "unavailable", message: "No fixture runtime" }], nextDueAt: null }, ...fields },
  automation_definitions: { kind: "automation_definitions", definitions: [], ...fields },
  automation_definition: { kind: "automation_definition", definition, ...fields },
  automation_deleted: { kind: "automation_deleted", deleted: true, ...fields, receipt },
  automation_executions: { kind: "automation_executions", executions: [], ...fields },
  automation_execution: { kind: "automation_execution", execution, ...fields },
  automation_logs: { kind: "automation_logs", logs: [{ sequence: 1, at, kind: "log", message: "Fixture bounded log", stream: "stdout" }], ...fields, nextCursor: "1", truncated: true },
  automation_studio_receipt: { kind: "automation_studio_receipt", original: { requestId: fixtureOperationId, httpStatus: 200, result: { deleted: true } }, ...fields },
  automation_snapshot: { kind: "automation_snapshot", snapshot: { templateId: "pm-stalled-tasks", executionId: id, actorId: fixtureActorId, workspaceId: fixtureWorkspaceId, projectId: "PRJ-001", observedAt: at, args: {}, sources: [source, workflowSource], project: { id: "PRJ-001", sourceRefId: source.refId, revision, title: "Fixture project", description: "", goals: [], createdAt: null, updatedAt: null, archived: false }, workflow: { sourceRefId: workflowSource.refId, statuses: [], readyStatusId: null, reviewStatusId: null }, tasks: [], documents: [], relationships: [], comments: [], activities: [], sessions: [], executions: [], pullRequests: [], milestones: [], coverage, timeWindow: null, lastVisitAt: null, before: null, after: null, event: null }, ...fields },
  automation_result: { kind: "automation_result", result: { templateId: "pm-stalled-tasks", executionId: id, observedAt: at, summary: "No fixture findings", findings: [], coverage, gaps: [], candidates: [] }, ...fields },
  automation_preview: { kind: "automation_preview", preview, ...fields },
  automation_review_receipt: { kind: "automation_review_receipt", original: { requestId: fixtureOperationId, httpStatus: 200, result: { candidate, idMap: {}, status: "outcome_unknown" } }, ...fields },
  automation_transfer_preview: { kind: "automation_transfer_preview", preview: { format: "bundle", config: fixtureAutomationConfig, warnings: [], validation: { valid: false, issues: [], nextDueAt: null } }, ...fields },
  automation_import_receipt: { kind: "automation_import_receipt", original: { requestId: fixtureOperationId, status: "pending", definition: null, error: null }, ...fields },
  automation_export: { kind: "automation_export", exported: { filename: "fixture.json", document: { version: 1, kind: "pm-automation-bundle", spec: fixtureAutomationConfig }, limits: { jsonBytes: 3145728, archiveBytes: 2097152, expandedBytes: 2097152, files: 200 } }, ...fields },
  automation_bundle: { kind: "automation_bundle", bundle: { bundleId: id, sha256: revision, files: [{ path: "fixture.txt", content: "<script>must remain text</script>" }] }, ...fields },
  automation_git_status: { kind: "automation_git_status", status: gitStatus, ...fields },
  automation_git_operation: { kind: "automation_git_operation", operation: gitOperation, ...fields },
  automation_git_receipt: { kind: "automation_git_receipt", original: { requestId: fixtureOperationId, status: "completed", result: gitOperation, error: null }, ...fields },
  automation_git_check: { kind: "automation_git_check", check: { readable: true, remoteCommit: null, pushPermissionVerified: false, encryptionKeyVerified: false }, ...fields },
  integration_connections: { kind: "integration_connections", items: [], privateStorageAvailable: false, ...fields },
  integration_definitions: { kind: "integration_definitions", contextId: "fixture-context", items: [], ...fields },
  integration_receipt: { kind: "integration_receipt", requestId: fixtureOperationId, httpStatus: 403, outcome: "rejected", connection: null, endpoint: null, errorCode: "not_authorized", ...fields },
  integration_operation: { kind: "integration_operation", operation: { id, executionId: id, connectionId: id, connectionRevision: 1, status: "outcome_unknown", resultAvailable: false, createdAt: at, finishedAt: null }, ...fields },
  event_endpoints: { kind: "event_endpoints", items: [], ...fields },
  event_receipts: { kind: "event_receipts", items: [], ...fields },
  webhook_overview: { kind: "webhook_overview", configuration: "configuration_error", configurationDigest: null, restoreFenced: true, loopHealthy: false, loopCycleAt: null, targets: [], endpoints: [], nextTargetKey: "next-target", ...fields, nextCursor: id },
  webhook_deliveries: { kind: "webhook_deliveries", items: [delivery], ...fields },
  webhook_delivery: { kind: "webhook_delivery", delivery: { ...delivery, attempts: [], receipts: [] }, nextAttemptNo: 2, nextReceiptId: id, ...fields },
  webhook_action: { kind: "webhook_action", action: "ReconcileWebhookDelivery", result: { deliveryId: id, version: 2, reconciliationRequested: true }, ...fields, receipt },
  im_settings: { kind: "im_settings", configuration: "disabled", connectivity: { satori: { state: "disconnected", readyAt: null, lastEventAt: null, lastErrorCode: null }, bots: [] }, bindings: [], ...fields },
  im_binding: { kind: "im_binding", binding: null, revoked: true, ...fields },
} satisfies FixtureMap;

const change = { changeId: id, sequence: "2", target: { kind: "core" as const, entityId: "TASK-001" }, entityKind: "work_item", projectId: "PRJ-001", changeKinds: ["body"], changedFields: ["body"], origin: "agent" as const, actorId: fixtureActorId, occurredAt: at, observedAt: at, beforeRevision: revision, afterRevision: "b".repeat(64), completeness: "exact" as const, relation: "self" as const };
const snapshot = { revision, raw: "Fixture snapshot body", offset: 0, nextOffset: 21, totalLength: 100 };
export const collaborationResultFixtures: CollaborationToolResult[] = [
  { ...fields, kind: "collaboration", result: { type: "comment_mutation", mutation: { id, taskId: "TASK-001", projectId: "PRJ-001", version: 2, action: "edited" } } },
  { ...fields, kind: "collaboration", result: { type: "comment_history", page: { taskId: "TASK-001", projectId: "PRJ-001", commentId: id, items: [], nextCursor: null } } },
  { ...fields, kind: "collaboration", result: { type: "history", page: { items: [change], head: "2", nextCursor: null, reviewedThrough: "1", pendingCount: 1, observationToken: id, completeness: "complete_since_capture" } } },
  { ...fields, kind: "collaboration", result: { type: "change_detail", change, before: null, after: snapshot } },
  { ...fields, kind: "collaboration", result: { type: "comparison", target: change.target, fromChangeId: null, toChangeId: id, head: "2", completeness: "baseline", before: snapshot, after: null } },
  { ...fields, kind: "collaboration", result: { type: "review_state", page: { items: [], nextTaskId: null } } },
  pmToolResultFixtures.collaboration,
  { ...fields, kind: "collaboration", result: { type: "notifications", page: { items: [], cursor: "0", head: "0", membershipVersion: 1, sourceCoverage: "selected_saved_facts", historyBoundary: { activatedAt: at, legacyImplicitUnreadNotImported: true }, processing: { status: "pending", asOf: at } } } },
  { ...fields, kind: "collaboration", result: { type: "notification_state", state: { eventId: id, version: 1, readAt: null, archivedAt: null } } },
  { ...fields, kind: "collaboration", result: { type: "audit", page: { projectId: "PRJ-001", entries: [], nextCursor: null } } },
  { ...fields, kind: "collaboration", result: { type: "changes", page: { events: [], cursor: "1", head: "2" } } },
];
const record = { id, workspaceId: fixtureWorkspaceId, projectId: "PRJ-001", version: 1, createdBy: fixtureActorId, createdAt: at, updatedAt: at };
export const planningRecordFixtures: PlanningRecordsRecord[] = [
  { ...record, resource: "conversation", title: "Fixture conversation", messages: [], messageOffset: 0, nextMessageOffset: 20, totalMessages: 40 },
  { ...record, resource: "intent", summary: "Fixture intent", goal: "Not accepted", conversationId: null, sourceMessageRefs: [], revision: 1, status: "proposed", acceptedDecisionId: null, terminalDecisionId: null, withdrawalRecord: null },
  { ...record, resource: "decision", subjectRef: { kind: "intent", id }, decisionType: "note", actorId: fixtureActorId, reason: "Fixture decision", basisRefs: [], supersedesDecisionId: null, acceptedRevision: null, rejectedRevision: null },
  { ...record, resource: "evidence", subjectRefs: ["TASK-001"], method: "Fixture only", scope: "No actual test", result: "inconclusive", observedAt: at, artifactVersionRefs: [], sourceRunId: null, producerId: fixtureActorId },
  { ...record, resource: "submission", workItemId: "TASK-001", contentRevision: 1, snapshotTruncated: true, workScopeSnapshot: { workItemId: "TASK-001", contentRevision: 1, title: "Fixture task", description: "", acceptanceCriteria: [], capturedAt: at }, artifactVersionIds: [], evidenceIds: [], submittedBy: fixtureActorId, submittedAt: at },
  { ...record, resource: "review", submissionId: id, workItemId: "TASK-001", contentRevision: 1, criterionResults: [], verdict: "changes_requested", reason: "Fixture human review", reviewerId: fixtureActorId, reviewedAt: at },
];

export function pmToolFixtureRecord(result: Result, options: Partial<PmToolCallRecord> = {}): PmToolCallRecord & { visibility: "visible" } {
  return { operationId: fixtureOperationId, name: "pm_read", status: "succeeded", result, error: null, threadId: "fixture-thread", messageId: "fixture-message", generationId: "fixture-generation", workspaceId: fixtureWorkspaceId, target: { workspaceId: fixtureWorkspaceId, projectId: "PRJ-001" }, createdAt: at, finishedAt: at, ...options, visibility: "visible" };
}
