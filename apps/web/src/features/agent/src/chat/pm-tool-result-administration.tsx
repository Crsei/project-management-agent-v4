import type { AdministrationToolResult } from "../../../../../../../packages/agent-contracts/src/pm-tool-administration";
import { useAgentText } from "../i18n";
import { PmEmptyResult, PmObjectLink, PmResultData, unsupportedPmResult } from "./pm-tool-result-ui";

export function PmAdministrationResult({ result, workspaceId }: { result: AdministrationToolResult; workspaceId: string | null }) {
  const t = useAgentText();
  switch (result.kind) {
    case "administration_workspace": case "administration_profile":
      return <>{!result.items.length && <PmEmptyResult />}<PmResultData value={result.items} /></>;
    case "administration_members":
      return <><p>{t("成员 access 为 null 表示授权信息已隐藏，不表示没有权限。Presence 是读取时的暂态，不是任务状态。", "Null member access means grant details are hidden, not that the member has no permissions. Presence is transient read-time information, not task state.")}</p><PmResultData value={{ serverNow: result.serverNow, presenceTtlMs: result.presenceTtlMs, canManageMembers: result.canManageMembers, members: result.items }} />{!result.items.length && <PmEmptyResult />}</>;
    case "administration_invitations":
      return <><PmResultData value={{ enabled: result.enabled, invitations: result.items }} /><p>{t("SMTP 接受不代表收件箱已送达。", "SMTP acceptance does not establish inbox delivery.")}</p>{!result.items.length && <PmEmptyResult />}</>;
    case "administration_teams":
      return <><PmResultData value={{ canManage: result.canManage, teams: result.items }} /><p>{t("团队成员关系不授予项目权限。", "Team membership does not grant project access.")}</p>{!result.items.length && <PmEmptyResult />}</>;
    case "administration_workload_members": case "administration_workload_tasks": case "administration_workload_teams":
      return <><PmResultData value={{ unit: result.unit, serverNow: result.serverNow, scope: result.scope, summary: result.summary, items: result.items }} /><p>{t("未设容量、未知估算与不完整范围均保留原值，不按 0 计算。", "Unset capacity, unknown estimates and incomplete scope retain their original values; they are not treated as zero.")}</p>{!result.items.length && <PmEmptyResult />}</>;
    case "administration_project_extras":
      return <><PmResultData value={{ sidebarOrder: result.sidebarOrder, projects: result.items }} />{result.items.slice(0, 20).map(item => <p key={item.projectId}><PmObjectLink workspaceId={workspaceId} kind="project" id={item.projectId} /></p>)}{!result.items.length && <PmEmptyResult />}</>;
    case "administration_project_directory": case "administration_directory_reference":
      return <>{result.items.slice(0, 20).map(item => <p key={item.projectId}><PmObjectLink workspaceId={workspaceId} kind="project" id={item.projectId} /></p>)}<PmResultData value={result.items} />{!result.items.length && <PmEmptyResult />}</>;
    case "administration_command":
      return <><h4>{t("原管理命令结果", "Original administration command result")}</h4><PmResultData value={result.items} />{!result.items.length && <p>{t("当前正文未提供；请核对原业务收据，不能当作空目录。", "No current payload was provided; inspect the original business receipt rather than treating this as an empty directory.")}</p>}</>;
    default: return unsupportedPmResult(result);
  }
}
