import type { PmToolCallRecord } from "@agent-workspace/contracts/pm-tools";
import type { PmChangeKind, PmChangeSet, PmChangeState } from "./pm-types";
import { agentText } from "../i18n-text.ts";

type WriteDefinition = { kind: PmChangeKind; zh: string; en: string };
const administration: WriteDefinition = { kind: "update", zh: "变更管理记录", en: "Change administration record" };
const dashboard: WriteDefinition = { kind: "update", zh: "变更日常工作记录", en: "Change daily-work record" };
const planning: WriteDefinition = { kind: "update", zh: "变更规划／交付记录", en: "Change planning / delivery record" };
const integration: WriteDefinition = { kind: "update", zh: "变更集成／投递管理", en: "Change integration / delivery management" };
const automation: WriteDefinition = { kind: "update", zh: "变更自动化定义／审阅记录", en: "Change automation definition / review record" };
const external: WriteDefinition = { kind: "update", zh: "变更外部文档", en: "Change external document" };
const artifact: WriteDefinition = { kind: "update", zh: "变更附件元数据／版本", en: "Change artifact metadata / version" };

// This is a presentation allowlist of real mutations, not a prefix or receipt heuristic.
// Reads/reconciliation and previews may carry native receipts without applying business changes.
const writes: Readonly<Record<string, WriteDefinition>> = {
  pm_create_project: { kind: "create", zh: "创建项目", en: "Create project" },
  pm_update_project: { kind: "update", zh: "更新项目", en: "Update project" },
  pm_create_task: { kind: "create", zh: "创建任务", en: "Create task" },
  pm_update_task: { kind: "update", zh: "更新任务", en: "Update task" },
  pm_create_document: { kind: "create", zh: "创建文档", en: "Create document" },
  pm_save_document: { kind: "update", zh: "保存文档", en: "Save document" },
  pm_create_comment: { kind: "comment", zh: "创建评论", en: "Create comment" },
  pm_edit_comment: { kind: "comment", zh: "编辑评论", en: "Edit comment" },
  pm_delete_comment: { kind: "comment", zh: "软删除评论", en: "Soft-delete comment" },
  pm_restore_comment: { kind: "comment", zh: "恢复评论", en: "Restore comment" },
  pm_add_relation: { kind: "relation", zh: "添加关系", en: "Add relation" },
  pm_remove_relation: { kind: "relation", zh: "移除关系", en: "Remove relation" },
  pm_archive_task: { kind: "archive", zh: "归档任务", en: "Archive task" },
  pm_restore_task: { kind: "archive", zh: "恢复任务", en: "Restore task" },
  pm_delete_task: { kind: "delete", zh: "删除已归档任务", en: "Delete archived task" },
  pm_transition_task: { kind: "status", zh: "转换任务工作流状态", en: "Transition task workflow state" },
  pm_create_entity: { kind: "create", zh: "创建 PM 对象", en: "Create PM entity" },
  pm_update_entity: { kind: "update", zh: "更新 PM 对象字段", en: "Update PM entity fields" },
  pm_save_entity_body: { kind: "update", zh: "保存 PM 对象正文", en: "Save PM entity body" },
  pm_save_entity_source: { kind: "update", zh: "保存 PM 对象源码", en: "Save PM entity source" },
  pm_archive_entity: { kind: "archive", zh: "归档 PM 对象", en: "Archive PM entity" },
  pm_restore_entity: { kind: "archive", zh: "恢复 PM 对象", en: "Restore PM entity" },
  pm_delete_entity: { kind: "delete", zh: "删除已归档 PM 对象", en: "Delete archived PM entity" },
  pm_transition_entity: { kind: "status", zh: "转换对象工作流状态", en: "Transition entity workflow state" },
  pm_save_view: { kind: "update", zh: "保存视图定义", en: "Save view definition" },
  pm_save_configuration: { kind: "update", zh: "保存协议配置", en: "Save protocol configuration" },
  pm_preview_migration: { kind: "create", zh: "保存迁移预览计划（未应用）", en: "Save migration preview plan (not applied)" },
  pm_apply_migration: { kind: "update", zh: "应用原迁移计划", en: "Apply original migration plan" },
  pm_restore_migration: { kind: "update", zh: "恢复原迁移文件", en: "Restore original migration files" },
  pm_acknowledge_changes: { kind: "update", zh: "确认个人已阅水位", en: "Acknowledge personal reviewed watermark" },
  pm_set_notification_read: { kind: "update", zh: "设置通知已读状态", en: "Set notification read state" },
  pm_set_notification_archived: { kind: "archive", zh: "设置通知归档状态", en: "Set notification archive state" },
  pm_update_workspace_identity: administration,
  pm_set_member: administration, pm_set_member_role: administration, pm_revoke_member: administration,
  pm_create_invitation: administration, pm_revoke_invitation: administration, pm_resend_invitation: administration,
  pm_create_team: administration, pm_rename_team: administration, pm_update_team_details: administration,
  pm_set_team_members: administration, pm_set_team_maintainers: administration, pm_archive_team: administration,
  pm_set_project_teams: administration, pm_set_member_capacity: administration,
  pm_set_project_favorite: administration, pm_set_project_order: administration,
  pm_set_project_cover: administration, pm_set_project_scope: administration,
  pm_duplicate_project: { kind: "create", zh: "复制项目", en: "Duplicate project" },
  pm_configure_document_sources: { kind: "update", zh: "保存文档来源关联", en: "Save document source associations" },
  pm_create_external_file: external, pm_save_external_file: external, pm_rename_external_file: external,
  pm_move_external_file: external, pm_delete_external_file: external,
  pm_register_artifact: artifact, pm_add_artifact_version: artifact, pm_rename_artifact: artifact,
  pm_hide_artifact: artifact, pm_restore_artifact: artifact, pm_copy_artifact_version: artifact,
  pm_create_private_note: dashboard, pm_update_private_note: dashboard, pm_complete_private_note: dashboard,
  pm_reopen_private_note: dashboard, pm_delete_private_note: dashboard,
  pm_create_project_meeting: dashboard, pm_update_project_meeting: dashboard, pm_cancel_project_meeting: dashboard,
  pm_watch_task: dashboard, pm_unwatch_task: dashboard, pm_start_timer: dashboard, pm_stop_timer: dashboard,
  pm_record_manual_worklog: dashboard, pm_set_presence_preference: dashboard, pm_heartbeat_presence: dashboard,
  pm_set_project_health: dashboard, pm_set_project_budget: dashboard, pm_set_project_remaining_estimate: dashboard,
  pm_record_project_spend: dashboard, pm_void_project_spend: dashboard, pm_correct_project_spend: dashboard,
  pm_set_project_dependencies: dashboard, pm_update_task_duration: dashboard, pm_update_planning_milestone: dashboard,
  pm_record_evidence: planning, pm_submit_work_item_result: planning, pm_return_work_item_for_changes: planning,
  pm_create_conversation: planning, pm_append_conversation_message: planning,
  pm_propose_intent: planning, pm_revise_intent: planning, pm_accept_intent: planning,
  pm_reject_intent: planning, pm_withdraw_intent: planning, pm_record_decision: planning,
  pm_create_task_from_intent: { kind: "create", zh: "从 Intent 创建原任务", en: "Create original task from Intent" },
  pm_save_roadmap: planning, pm_publish_roadmap: planning, pm_materialize_roadmap: planning,
  pm_automation_create: automation, pm_automation_update: automation, pm_automation_status: automation,
  pm_automation_remove: automation, pm_automation_candidate_edit: automation,
  pm_automation_candidate_apply: automation, pm_automation_candidate_ignore: automation,
  pm_automation_import: automation, pm_automation_bundle_upload: automation,
  pm_automation_git_save: automation, pm_automation_git_sync: automation,
  pm_automation_run: { kind: "update", zh: "请求自动化执行（不是任务完成）", en: "Request automation execution (not task completion)" },
  pm_automation_test: { kind: "update", zh: "请求实际自动化测试执行", en: "Request real automation test execution" },
  pm_automation_cancel: { kind: "update", zh: "请求取消原自动化执行", en: "Request cancellation of original automation execution" },
  pm_verify_integration: integration, pm_revoke_integration: integration, pm_revoke_event_endpoint: integration,
  pm_create_webhook_endpoint: integration, pm_set_webhook_endpoint_state: integration,
  pm_reauthorize_webhook_endpoint: integration, pm_set_webhook_endpoint_signing_key: integration,
  pm_reconcile_webhook_delivery: integration, pm_resume_webhook_delivery: integration,
  pm_set_im_notifications: integration, pm_revoke_im_binding: integration,
};
const states: Record<PmToolCallRecord["status"], PmChangeState> = { pending_approval: "proposed", running: "running", succeeded: "applied", failed: "failed", unknown: "unknown" };
type Result = NonNullable<PmToolCallRecord["result"]>;

export function isPmToolBusinessWrite(name: string): boolean {
  return Object.hasOwn(writes, name);
}

function executionState(status: string): PmChangeState {
  switch (status) {
    case "queued": case "pending": return "queued";
    case "running": case "cancel_requested": case "dispatching": return "running";
    case "failed": case "rejected": return "failed";
    case "outcome_unknown": case "unknown": case "skipped": return "unknown";
    case "succeeded": case "completed": case "applied": case "edited": case "ignored": case "cancelled": case "draft": case "enabled": case "paused": return "applied";
    default: return "unknown";
  }
}

function resultState(result: Result | null): PmChangeState {
  if (!result) return "applied"; // Authoritative operation success can precede payload retrieval.
  switch (result.kind) {
    case "migration": return result.migration.status === "preview" ? "proposed" : result.migration.status === "applying" || result.migration.status === "restoring" ? "running" : result.migration.status === "restored" ? "reverted" : "applied";
    case "external-file-operation": {
      const operation = result.items[0];
      return !operation ? result.receipt ? "applied" : "unknown" : operation.status === "not_applied" ? "failed" : executionState(operation.status);
    }
    case "automation_execution": return executionState(result.execution.status);
    case "automation_studio_receipt": return result.original.httpStatus >= 400 ? "failed" : "status" in result.original.result ? executionState(result.original.result.status) : "applied";
    case "automation_import_receipt": return executionState(result.original.status);
    case "automation_review_receipt": {
      const payload = result.original.result;
      return result.original.httpStatus >= 400 ? "failed" : "status" in payload ? payload.status === "conflict" ? "conflict" : executionState(payload.status) : "unknown";
    }
    case "automation_git_operation": return executionState(result.operation.status);
    case "automation_git_receipt": return result.original.status === "rejected" ? "failed" : result.original.result && "status" in result.original.result ? executionState(result.original.result.status) : "applied";
    case "integration_receipt": return result.outcome === "rejected" ? "failed" : "applied";
    case "integration_operation": return executionState(result.operation.status);
    default: return "applied";
  }
}

function resultTarget(result: Result | null): { id?: string | null; title?: string | null; projectId?: string | null } {
  if (!result) return {};
  switch (result.kind) {
    case "project": case "task": case "document": case "cycle": case "milestone": case "module": case "requirement": case "release": case "goal": case "query": case "lifecycle": return result.items[0] ?? {};
    case "comment": return { id: result.items[0]?.taskId, projectId: result.items[0]?.projectId };
    case "relation": return { id: result.items[0]?.sourceId };
    case "views": return { id: result.items[0]?.id, title: result.items[0]?.name };
    case "migration": return { id: result.migration.id };
    case "administration_command": return { id: result.items[0]?.id };
    case "collaboration": return result.result.type === "comment_mutation" ? { id: result.result.mutation.taskId, projectId: result.result.mutation.projectId } : {};
    case "external-file-operation": return { id: result.items[0]?.targetPath ?? result.items[0]?.path };
    case "artifact-mutation": return result.artifacts[0] ?? result.versions[0] ?? {};
    case "planning_record_receipt": {
      if (result.generatedTask) return { id: result.generatedTask.id, projectId: result.generatedTask.projectId, title: result.generatedTask.titleTruncated ? `${result.generatedTask.title} ${agentText("（标题已裁剪）", "(title clipped)")}` : result.generatedTask.title };
      const record = result.records[0];
      return record ? { id: record.id, projectId: record.projectId, title: record.resource === "conversation" ? record.title : record.resource === "intent" ? record.summary : null } : {};
    }
    case "planning_roadmap": return { id: result.roadmap.projectId, projectId: result.roadmap.projectId, title: result.roadmap.title };
    case "automation_definition": return { id: result.definition.id, title: result.definition.config.name, projectId: result.definition.config.projectId };
    case "automation_execution": return { id: result.execution.id, title: result.execution.configSnapshot.name, projectId: result.execution.configSnapshot.projectId };
    case "automation_import_receipt": return result.original.definition ? { id: result.original.definition.id, title: result.original.definition.config.name, projectId: result.original.definition.config.projectId } : {};
    case "automation_git_operation": return { id: result.operation.id };
    case "integration_receipt": return result.connection ?? result.endpoint ?? {};
    case "integration_operation": return { id: result.operation.id };
    case "webhook_action": return { id: "endpointId" in result.result ? result.result.endpointId : result.result.deliveryId };
    case "im_binding": return { id: result.binding?.id };
    default: return {};
  }
}

/** The sidebar projects original mutations only, never read receipts or generic tool completion. */
export function pmToolChanges(calls: readonly PmToolCallRecord[]): PmChangeSet[] {
  return calls.flatMap(call => {
    if (call.visibility === "redacted" || call.visibility === "unavailable" || !isPmToolBusinessWrite(call.name)) return [];
    const definition = writes[call.name];
    const result = call.result;
    const target = resultTarget(result);
    const targetId = result?.receipt?.targetId ?? target.id ?? null;
    return [{
      id: call.operationId,
      kind: definition.kind,
      state: call.status === "succeeded" ? resultState(result) : states[call.status],
      targetId,
      targetTitle: target.title ?? null,
      projectId: target.projectId ?? call.target?.projectId ?? null,
      summary: `${agentText(definition.zh, definition.en)} · ${call.name}${targetId ? ` · ${targetId}` : ""}`,
      receiptId: result?.receipt?.operationId ?? null,
      commandId: result?.receipt?.commandId ?? null,
      error: call.error,
      createdAt: call.createdAt,
      updatedAt: call.finishedAt ?? undefined,
    }];
  });
}
