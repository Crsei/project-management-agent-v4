import type { PlanningRecordsToolResult, PlanningRecordsRecord } from "../../../../../../../packages/agent-contracts/src/pm-tool-planning-records";
import { useAgentText } from "../i18n";
import { PmEmptyResult, PmObjectLink, PmResultData, unsupportedPmResult } from "./pm-tool-result-ui";

export function PmPlanningRecordsResult({ result, workspaceId }: { result: PlanningRecordsToolResult; workspaceId: string | null }) {
  const t = useAgentText();
  switch (result.kind) {
    case "planning_records":
      return <>{result.records.map(record => <PmPlanningRecord key={record.id} record={record} workspaceId={workspaceId} />)}{!result.records.length && <PmEmptyResult />}{result.cursor && <p>{t("记录原生游标：", "Native record cursor: ")}<code>{result.cursor}</code></p>}</>;
    case "planning_record_receipt":
      return <>{result.records.map(record => <PmPlanningRecord key={record.id} record={record} workspaceId={workspaceId} />)}{result.generatedTask && <article><h4>{t("生成的原任务", "Original generated task")}</h4><PmObjectLink workspaceId={workspaceId} kind="task" id={result.generatedTask.id} projectId={result.generatedTask.projectId}>{result.generatedTask.title}</PmObjectLink>{result.generatedTask.titleTruncated && <p role="status">{t("任务标题已裁剪；请打开原任务核对完整标题。", "Task title clipped; open the original task to inspect the full title.")}</p>}<PmResultData value={result.generatedTask} /></article>}{!result.records.length && !result.generatedTask && <p>{t("业务结果只附原收据，未提供当前记录正文。", "The business result includes only the original receipt, with no current record payload.")}</p>}<p>{t("提交、Evidence 或命令成功不代表任务完成；人工审核与 Done 守卫不变。", "Submission, Evidence or command success is not task completion; human review and Done guards are unchanged.")}</p></>;
    case "planning_roadmap":
      return <><h4>{result.roadmap.title}</h4>{workspaceId && <a href={`/pm/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(result.roadmap.projectId)}/roadmap`}>{t("打开项目 Roadmap", "Open project roadmap")}</a>}<PmResultData value={{ projectId: result.roadmap.projectId, revision: result.roadmap.revision, archived: result.roadmap.archived, selectedNodeIds: result.selectedNodeIds, dependencyClosure: result.dependencyClosure, idMap: result.idMap, store: result.roadmap.store, tasks: result.roadmap.tasks }} /><ul>{result.idMap.map(mapping => <li key={mapping.nodeId}><code>{mapping.nodeId}</code> → <PmObjectLink workspaceId={workspaceId} kind="task" id={mapping.taskId} projectId={result.roadmap.projectId} /> · revision <code>{mapping.revision}</code></li>)}</ul><p>{t("草稿、正式发布和物化映射分别展示；drifted 不表示已自动修复。", "Drafts, published releases and materialization mappings are separate facts; drifted does not mean automatically repaired.")}</p></>;
    default: return unsupportedPmResult(result);
  }
}

function PmPlanningRecord({ record, workspaceId }: { record: PlanningRecordsRecord; workspaceId: string | null }) {
  const t = useAgentText();
  const identity = <p><code>{record.resource}</code> · <code>{record.id}</code> · v{record.version}</p>;
  switch (record.resource) {
    case "conversation": return <article>{identity}<h4>{record.title}</h4><PmResultData value={{ messages: record.messages, messageOffset: record.messageOffset, totalMessages: record.totalMessages }} />{record.nextMessageOffset !== null && <p>{t("继续读取消息偏移：", "Continue message offset: ")}{record.nextMessageOffset}</p>}</article>;
    case "intent": case "decision": return <article>{identity}<PmResultData value={record} /></article>;
    case "evidence": return <article>{identity}<h4>{t("Evidence · 观察结果，不是审核批准", "Evidence · observation, not review approval")}</h4><PmResultData value={record} /></article>;
    case "submission": case "review": return <article>{identity}<PmObjectLink workspaceId={workspaceId} kind="task" id={record.workItemId} projectId={record.projectId} />{record.resource === "submission" && record.snapshotTruncated && <p role="status">{t("提交的不可变范围快照已裁剪；使用原生 submission read 按原 ID 核对完整快照。", "The immutable submission scope snapshot is clipped; use native submission read with the original ID to inspect the full snapshot.")}</p>}<PmResultData value={record} /></article>;
    default: return unsupportedPmResult(record);
  }
}
