import type { z } from "zod";
import type { PmToolCallRecord } from "@agent-workspace/contracts/pm-tools";
import type { coreToolResultSchema } from "../../../../../../../packages/agent-contracts/src/pm-tool-core";
import { useAgentText } from "../i18n";
import { PmEmptyResult, PmObjectLink, PmResultData, unsupportedPmResult } from "./pm-tool-result-ui";

type EntityResult = Extract<NonNullable<PmToolCallRecord["result"]>, { kind: "project" | "task" | "document" | "cycle" | "milestone" | "module" | "requirement" | "release" | "goal" | "query" | "lifecycle" }>;
type CoreResult = z.infer<typeof coreToolResultSchema> | EntityResult;

export function PmCoreResult({ result, workspaceId }: { result: CoreResult; workspaceId: string | null }) {
  const t = useAgentText();
  switch (result.kind) {
    case "project": case "task": case "document": case "cycle": case "milestone": case "module": case "requirement": case "release": case "goal": case "query": case "lifecycle":
      return <>{result.items.slice(0, 20).map(item => <article key={item.id}>
        <PmObjectLink workspaceId={workspaceId} kind={item.entity} id={item.id} projectId={item.projectId}>{item.title || item.id}</PmObjectLink> <code>{item.id}</code> <small>revision {item.revision} · v{item.version}</small>
        <PmResultData value={{ entity: item.entity, status: item.status, archived: item.archived, fields: item.fields, properties: item.properties }} />
        {item.body !== undefined && <><pre>{item.body.slice(0, 24000)}</pre>{item.bodyOffset !== undefined && <p>bodyOffset: {item.bodyOffset}</p>}{item.body.length > 24000 ? <p role="status">{t("卡片正文展示已裁剪；原读取偏移：", "Card body display clipped; original read offset: ")}{item.bodyOffset ?? t("未提供", "Not provided")}{item.bodyOffset !== undefined && <>{t("；下一展示偏移（保持同一 revision）：", "; continue display at offset (retain this revision): ")}{item.bodyOffset + 24000}</>}</p> : item.nextBodyOffset != null && <p>{t("继续读取正文偏移（保持相同 revision）：", "Continue body offset (retain the same revision): ")}{item.nextBodyOffset}</p>}</>}
      </article>)}{result.items.length > 20 && <p role="status">{t("卡片只显示前 20 个对象；请继续读取原工具。", "The card shows only the first 20 objects; continue reading through the original tool.")}</p>}
      {!result.items.length && <PmEmptyResult>{result.receipt ? t("原操作有业务收据，但本结果没有当前对象正文；删除或后续变更不会重建对象。", "The original operation has a receipt, but no current object payload is included; deletion or later changes do not recreate it.") : undefined}</PmEmptyResult>}</>;
    case "views":
      return <>{!result.items.length && <PmEmptyResult />}{result.items.map(view => <article key={view.id}><h4>{view.name} · <code>{view.id}</code></h4>{workspaceId && <a href={`/pm/${encodeURIComponent(workspaceId)}/views`}>{t("查看工作区视图", "Open workspace views")}</a>}<PmResultData value={view} /></article>)}</>;
    case "configuration":
      return <section><h4>{t("工作区协议配置", "Workspace protocol configuration")}</h4><p>revision <code>{result.revision}</code></p><PmResultData value={{ configuration: result.configuration, diagnostics: result.diagnostics }} /></section>;
    case "migrations":
      return <>{!result.items.length && <PmEmptyResult /> }<PmResultData value={result.items} /></>;
    case "migration":
      return <section><h4>{t("原迁移计划", "Original migration plan")}</h4><PmResultData value={{ migration: result.migration, files: result.items }} />{!result.items.length && <PmEmptyResult>{result.migration.totalFiles === 0 ? t("该计划不包含文件变更。", "This plan contains no file changes.") : t("本页未包含文件；计划总数不为零，请核对游标。", "This page contains no files; the plan total is nonzero, so inspect the cursor.")}</PmEmptyResult>}<p>{t("preview 是计划预览，不表示已应用。", "Preview is a plan, not evidence that it was applied.")}</p></section>;
    default: return unsupportedPmResult(result);
  }
}
