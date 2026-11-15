import type { PmToolCallRecord } from "@agent-workspace/contracts/pm-tools";
import { useAgentText } from "../i18n";
import { PmCoreResult } from "./pm-tool-result-core";
import { PmCollaborationResult } from "./pm-tool-result-collaboration";
import { PmAdministrationResult } from "./pm-tool-result-administration";
import { PmDocumentsFilesResult } from "./pm-tool-result-documents-files";
import { PmDashboardResult } from "./pm-tool-result-dashboard";
import { PmPlanningRecordsResult } from "./pm-tool-result-planning-records";
import { PmAutomationResult } from "./pm-tool-result-automation";
import { PmIntegrationsResult } from "./pm-tool-result-integrations";
import { PmEmptyResult, PmObjectLink, unsupportedPmResult } from "./pm-tool-result-ui";

type Result = Exclude<NonNullable<PmToolCallRecord["result"]>, { kind: "task_brief" | "knowledge" | "workflow" }>;

/** The discriminators come from the shared strict result union, never shape guessing. */
export function PmToolResultContent({ result, workspaceId }: { result: Result; workspaceId: string | null }) {
  const t = useAgentText();
  switch (result.kind) {
    case "workspaces":
      return <>{result.items.slice(0, 20).map(item => <article key={item.id}><a href={`/pm/${encodeURIComponent(item.id)}/home`}>{item.name}</a> <code>{item.id}</code><ul>{item.projects.slice(0, 20).map(project => <li key={project.id}><PmObjectLink workspaceId={item.id} kind="project" id={project.id}>{project.name}</PmObjectLink> <code>{project.id}</code></li>)}</ul>{item.projects.length > 20 && <p role="status">{t("项目展示已裁剪。", "Project display clipped.")}</p>}</article>)}{!result.items.length && <PmEmptyResult />}{result.items.length > 20 && <p role="status">{t("工作区展示已裁剪。", "Workspace display clipped.")}</p>}</>;
    case "comment":
      return <>{result.items.slice(0, 20).map(item => <article key={item.id}><PmObjectLink workspaceId={workspaceId} kind="task" id={item.taskId} projectId={item.projectId}>{t("任务评论：", "Comment on task: ")}{item.taskId}</PmObjectLink><p>{item.content?.slice(0, 24000) ?? t("已删除", "Deleted")}</p>{item.content && item.content.length > 24000 && <p role="status">{t("评论展示已裁剪，请读取原评论历史继续核对。", "Comment display clipped; read the original comment history to inspect further.")}</p>}<small>{t("版本 ", "Version ")}{item.version}</small></article>)}{!result.items.length && <PmEmptyResult />}{result.items.length > 20 && <p role="status">{t("卡片仅展示前 20 条评论。", "The card shows only the first 20 comments.")}</p>}</>;
    case "relation":
      return <>{result.items.slice(0, 20).map(item => <p key={`${item.sourceId}:${item.relation}:${item.targetId}`}><PmObjectLink workspaceId={workspaceId} kind="entity" id={item.sourceId} /> · {item.relation} · <PmObjectLink workspaceId={workspaceId} kind="entity" id={item.targetId} /> <small>{item.sourceRevision} / {item.targetRevision}</small></p>)}{!result.items.length && <PmEmptyResult />}{result.items.length > 20 && <p role="status">{t("卡片仅展示前 20 条关系。", "The card shows only the first 20 relations.")}</p>}</>;
    case "project": case "task": case "document": case "cycle": case "milestone": case "module": case "requirement": case "release": case "goal": case "query": case "lifecycle": case "views": case "configuration": case "migrations": case "migration":
      return <PmCoreResult result={result} workspaceId={workspaceId} />;
    case "collaboration": return <PmCollaborationResult result={result} workspaceId={workspaceId} />;
    case "administration_workspace": case "administration_profile": case "administration_members": case "administration_invitations": case "administration_teams": case "administration_workload_members": case "administration_workload_tasks": case "administration_workload_teams": case "administration_project_extras": case "administration_project_directory": case "administration_directory_reference": case "administration_command":
      return <PmAdministrationResult result={result} workspaceId={workspaceId} />;
    case "document-sources": case "external-files": case "external-file": case "external-file-operation": case "uploads": case "artifacts": case "artifact-versions": case "artifact-mutation": case "artifact-copy-origin":
      return <PmDocumentsFilesResult result={result} workspaceId={workspaceId} />;
    case "dashboard_notes": case "dashboard_meetings": case "dashboard_meeting_participants": case "dashboard_watches": case "dashboard_presence": case "dashboard_timer": case "dashboard_worklogs": case "dashboard_portfolio": case "dashboard_planning": case "dashboard_critical_path": case "dashboard_sprint_metrics": case "dashboard_receipt":
      return <PmDashboardResult result={result} workspaceId={workspaceId} />;
    case "planning_records": case "planning_roadmap": case "planning_record_receipt":
      return <PmPlanningRecordsResult result={result} workspaceId={workspaceId} />;
    case "automation_capabilities": case "automation_templates": case "automation_timezones": case "automation_validation": case "automation_definitions": case "automation_definition": case "automation_deleted": case "automation_executions": case "automation_execution": case "automation_logs": case "automation_studio_receipt": case "automation_snapshot": case "automation_result": case "automation_preview": case "automation_review_receipt": case "automation_transfer_preview": case "automation_import_receipt": case "automation_export": case "automation_bundle": case "automation_git_status": case "automation_git_operation": case "automation_git_receipt": case "automation_git_check":
      return <PmAutomationResult result={result} />;
    case "integration_connections": case "integration_definitions": case "integration_receipt": case "integration_operation": case "event_endpoints": case "event_receipts": case "webhook_overview": case "webhook_deliveries": case "webhook_delivery": case "webhook_action": case "im_settings": case "im_binding":
      return <PmIntegrationsResult result={result} />;
    default: return unsupportedPmResult(result);
  }
}
