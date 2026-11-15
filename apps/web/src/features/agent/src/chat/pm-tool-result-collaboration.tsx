import type { CollaborationToolResult } from "../../../../../../../packages/agent-contracts/src/pm-tool-collaboration";
import { useAgentText } from "../i18n";
import { PmEmptyResult, PmObjectLink, PmResultData, unsupportedPmResult } from "./pm-tool-result-ui";

export function PmCollaborationResult({ result, workspaceId }: { result: CollaborationToolResult; workspaceId: string | null }) {
  const t = useAgentText();
  const data = result.result;
  switch (data.type) {
    case "comment_mutation":
      return <><PmObjectLink workspaceId={workspaceId} kind="task" id={data.mutation.taskId} projectId={data.mutation.projectId} /><PmResultData value={data.mutation} /></>;
    case "comment_history":
      return <><PmObjectLink workspaceId={workspaceId} kind="task" id={data.page.taskId} projectId={data.page.projectId} />{!data.page.items.length && <PmEmptyResult />}<PmResultData value={data.page} /></>;
    case "history":
      return <><p>{t("读取不确认已阅；确认水位只属于当前用户。", "Reading does not acknowledge changes; acknowledgement watermarks belong only to the current user.")}</p>{!data.page.items.length && <PmEmptyResult />}<PmResultData value={data.page} /></>;
    case "change_detail":
      return <><PmResultData value={data.change} /><PmSnapshot label={t("变更前", "Before")} snapshot={data.before} /><PmSnapshot label={t("变更后", "After")} snapshot={data.after} /></>;
    case "comparison":
      return <><PmResultData value={{ target: data.target, fromChangeId: data.fromChangeId, toChangeId: data.toChangeId, head: data.head, completeness: data.completeness }} /><PmSnapshot label={t("比较起点", "Comparison start")} snapshot={data.before} /><PmSnapshot label={t("比较终点", "Comparison end")} snapshot={data.after} /></>;
    case "review_state":
      return <>{!data.page.items.length && <PmEmptyResult />}<PmResultData value={data.page} /></>;
    case "acknowledgement":
      return <><h4>{t("个人已阅水位", "Personal reviewed watermark")}</h4><PmResultData value={data.acknowledgement} /></>;
    case "notifications":
      return <><p>{t("查看不会标记已读或归档。", "Viewing does not mark notifications read or archive them.")}</p>{!data.page.items.length && <PmEmptyResult />}<PmResultData value={data.page} /></>;
    case "notification_state": return <PmResultData value={data.state} />;
    case "audit": return <>{!data.page.entries.length && <PmEmptyResult />}<PmResultData value={data.page} /></>;
    case "changes": return <>{!data.page.events.length && <PmEmptyResult />}<PmResultData value={data.page} /></>;
    default: return unsupportedPmResult(data);
  }
}

function PmSnapshot({ label, snapshot }: { label: string; snapshot: Extract<CollaborationToolResult["result"], { type: "change_detail" }>["before"] }) {
  const t = useAgentText();
  return <section><h5>{label}</h5>{snapshot ? <><p>revision <code>{snapshot.revision}</code> · offset {snapshot.offset} / {snapshot.totalLength}</p><pre>{snapshot.raw}</pre>{snapshot.nextOffset !== null && <p>{t("继续读取偏移：", "Continue from offset: ")}{snapshot.nextOffset}</p>}</> : <p>{t("没有可见快照；不能当作空文件或推断未发生修改。", "No visible snapshot; this is not an empty file or proof that no change occurred.")}</p>}</section>;
}
