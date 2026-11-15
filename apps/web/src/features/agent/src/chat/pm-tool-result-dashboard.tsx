import type { DashboardToolResult } from "../../../../../../../packages/agent-contracts/src/pm-tool-dashboard";
import { useAgentText } from "../i18n";
import { PmEmptyResult, PmObjectLink, PmResultData, unsupportedPmResult } from "./pm-tool-result-ui";

export function PmDashboardResult({ result, workspaceId }: { result: DashboardToolResult; workspaceId: string | null }) {
  const t = useAgentText();
  switch (result.kind) {
    case "dashboard_notes":
      return <><h4>{t("我的私人记录", "My private notes")}</h4><PmResultData value={result.items} />{!result.items.length && <PmEmptyResult />}</>;
    case "dashboard_meetings": case "dashboard_watches":
      return <><PmResultData value={result.items} />{!result.items.length && <PmEmptyResult />}</>;
    case "dashboard_meeting_participants":
      return <><PmResultData value={{ canListParticipants: result.canListParticipants, participants: result.items }} />{!result.canListParticipants && <p role="status">{t("参与者目录受限；当前结果不是完整成员目录。", "The participant directory is restricted; this is not a full member directory.")}</p>}{!result.items.length && <PmEmptyResult />}</>;
    case "dashboard_presence":
      return <><PmResultData value={{ serverNow: result.serverNow, ttlMs: result.ttlMs, directoryVisible: result.directoryVisible, self: result.self, members: result.items }} /><p>{t("Presence 是暂态读取结果；读取不会写入心跳，也不是持久任务状态。", "Presence is transient read-time information; reading does not heartbeat or establish durable task state.")}</p>{!result.directoryVisible && <p role="status">{t("成员目录不可见；不能把成员列表当作空目录。", "The member directory is not visible; do not treat the list as an empty directory.")}</p>}</>;
    case "dashboard_timer":
      return <><p>serverNow: {result.serverNow}</p>{result.activeTimer ? <><PmResultData value={result.activeTimer} />{!result.activeTimer.task.unavailable && result.activeTimer.task.taskId && <PmObjectLink workspaceId={workspaceId} kind="task" id={result.activeTimer.task.taskId} projectId={result.activeTimer.task.projectId} />}{result.activeTimer.task.unavailable && <p role="status">{t("计时关联任务已不可访问。", "The timer's task is no longer accessible.")}</p>}</> : <p>{t("当前没有服务端活动计时器。", "There is no active server timer.")}</p>}<p>{t("取消读取或生成不会停止服务端计时器。", "Cancelling a read or generation does not stop the server timer.")}</p></>;
    case "dashboard_worklogs":
      return <><PmResultData value={{ serverNow: result.serverNow, timeZone: result.timeZone, totalsScope: result.totalsScope, totals: result.totals, worklogs: result.items }} /><p>{t("总计由服务端按当前用户日历计算，不是本页或项目小计。", "Totals are server-computed for the actor's calendar, not page or project subtotals.")}</p>{!result.items.length && <PmEmptyResult />}</>;
    case "dashboard_portfolio":
      return <><h4>{t("人工评估／财务记录与派生合计", "Manual assessments / financial records and derived totals")}</h4><PmResultData value={{ section: result.section, totals: result.totals, items: result.items }} /><p>{t("金额保留 currency 与整数 minor units；null 是未知或未提供，不是 0。", "Amounts retain their currency and integer minor units; null is unknown or unavailable, not zero.")}</p>{!result.items.length && <PmEmptyResult />}</>;
    case "dashboard_planning":
      return <><PmResultData value={{ section: result.section, items: result.items }} />{result.items.slice(0, 20).map((item, index) => <p key={index}>{item.row === "dependency" ? <><PmObjectLink workspaceId={workspaceId} kind="project" id={item.projectId} /> → <PmObjectLink workspaceId={workspaceId} kind="project" id={item.dependsOnProjectId} /></> : <PmObjectLink workspaceId={workspaceId} kind={item.row} id={item.id} projectId={item.row === "project" ? null : item.projectId}>{item.title}</PmObjectLink>}</p>)}{!result.items.length && <PmEmptyResult />}</>;
    case "dashboard_critical_path":
      return <><PmObjectLink workspaceId={workspaceId} kind="project" id={result.projectId} /><PmResultData value={{ status: result.status, durationDays: result.durationDays, model: result.model, section: result.section, items: result.items }} />{result.status === "unavailable" && <p role="status">{t("关键路径不可用；缺失时长不填为 0，请读取 reasons 分页。", "The critical path is unavailable; missing durations are not zero. Read the reasons section.")}</p>}{!result.items.length && <PmEmptyResult />}</>;
    case "dashboard_sprint_metrics":
      return <><PmResultData value={{ section: result.section, historyStatus: result.historyStatus, historyError: result.historyError, semantics: result.semantics, items: result.items }} /><p>{t("历史是实际观测快照，不是观测开始前的重建燃尽图；complete/gap 保留原义。", "History contains observed snapshots, not reconstructed pre-capture burndown; complete / gap retain their native meaning.")}</p>{result.historyStatus === "error" && <p role="alert">{t("历史读取失败，不能当作没有历史。", "History could not be read; this does not mean there is no history.")}</p>}{!result.items.length && <PmEmptyResult />}</>;
    case "dashboard_receipt":
      return <><h4>{t("原业务命令结果", "Original business command result")}</h4><p><code>{result.action}</code></p><p>{t("请核对原业务收据；命令执行不表示任务 Done。", "Inspect the original business receipt; command execution does not mean a task is Done.")}</p></>;
    default: return unsupportedPmResult(result);
  }
}
