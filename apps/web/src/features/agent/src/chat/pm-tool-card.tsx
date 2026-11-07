import { useEffect, useRef, useState } from "react";
import type { PmToolCallRecord } from "@agent-workspace/contracts/pm-tools";
import { workspaceClient } from "../network";
import { useAgentText } from "../i18n";

export type PmToolRecord = PmToolCallRecord;

function objectHref(workspaceId: string | null, kind: string, id: string, projectId?: string | null) {
  if (!workspaceId) return undefined;
  const root = `/pm/${encodeURIComponent(workspaceId)}`;
  return kind === "project" ? `${root}/projects/${encodeURIComponent(id)}` : `${root}${kind === "task" && projectId ? `/projects/${encodeURIComponent(projectId)}` : ""}/entities/${encodeURIComponent(id)}`;
}

export function PmToolCard({ record, onUpdate }: { record: PmToolRecord; onUpdate: (record: PmToolRecord) => void }) {
  const t = useAgentText();
  const notified = useRef(false);
  useEffect(() => {
    if (record.status === "succeeded" && record.result?.receipt && !notified.current) {
      notified.current = true;
      window.dispatchEvent(new CustomEvent("pm-tool-committed", { detail: { workspaceId: record.workspaceId } }));
    }
  }, [record.status, record.result, record.workspaceId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const deciding = useRef(false);
  const decide = (decision: "approve" | "reject") => {
    if (deciding.current) return;
    deciding.current = true; setBusy(true); setError(undefined);
    void workspaceClient.json<PmToolRecord>(`/api/pm-tools/calls/${encodeURIComponent(record.operationId)}/${decision}`, { method: "POST" }).then(onUpdate).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => { deciding.current = false; setBusy(false); });
  };
  const result = record.result;
  return <section className="native-output-card pm-tool-card" data-state={record.status}>
    <header><strong>{record.name}</strong><span>{record.status === "pending_approval" ? t("等待批准", "Awaiting approval") : record.status === "running" ? t("进行中", "Running") : record.status === "succeeded" ? t("已完成", "Completed") : record.status === "unknown" ? t("结果未知", "Result unknown") : record.error?.code === "approval_rejected" ? t("已拒绝", "Rejected") : t("失败", "Failed")}</span></header>
    <div className="native-card-body">
      {record.target && <p className="text-xs">{t("PM 目标：", "PM target: ")}<code>{record.target.workspaceId}{record.target.projectId ? ` / ${record.target.projectId}` : ""}</code></p>}
      {record.status === "pending_approval" && <>
        <p role="status">{t("该操作会更改或移除任务。批准后才会把原始请求发送给 PM；拒绝不会写入任何内容。", "This operation changes or removes tasks. The original request is sent to PM only after approval; rejecting writes nothing.")}</p>
        <button type="button" disabled={busy} onClick={() => decide("approve")}>{busy ? t("处理中…", "Working…") : t("批准执行", "Approve and run")}</button>
        <button type="button" disabled={busy} onClick={() => decide("reject")}>{t("拒绝", "Reject")}</button>
      </>}
      {record.status === "unknown" && <><p role="status">{t("业务效果尚未确认。只核对原操作，不会重新执行；取消生成也不会回滚已提交的修改。", "The business effect is not confirmed yet. This only reconciles the original operation and never re-runs it; cancelling generation also does not roll back already committed changes.")}</p><button type="button" disabled={busy} onClick={() => {
        setBusy(true); setError(undefined);
        void workspaceClient.json<PmToolRecord>(`/api/pm-tools/calls/${encodeURIComponent(record.operationId)}/reconcile`, { method: "POST" }).then(onUpdate).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false));
      }}>{busy ? t("核对中…", "Reconciling…") : t("核对原操作", "Reconcile original operation")}</button></>}
      {record.error && <p role="alert"><code>{record.error.code}</code>{t("：", ": ")}{record.error.message}</p>}
      {error && <p role="alert">{t("操作失败：", "Operation failed: ")}{error}</p>}
      {result && <>
        {result.kind === "workspaces" ? result.items.map(item => <article key={item.id}><a href={`/pm/${encodeURIComponent(item.id)}/home`}>{item.name}</a> <code>{item.id}</code><ul>{item.projects.map(project => <li key={project.id}><a href={objectHref(item.id, "project", project.id)}>{project.name}</a> <code>{project.id}</code></li>)}</ul></article>)
          : result.kind === "comment" ? result.items.map(item => <article key={item.id}><a href={objectHref(record.workspaceId, "task", item.taskId, item.projectId)}>{t("任务 ", "Comment on task ")}{item.taskId}{t(" 的评论", "")}</a><p>{item.content ?? t("已删除", "Deleted")}</p><small>{t("版本 ", "Version ")}{item.version}</small></article>)
          : result.kind === "relation" ? result.items.map(item => <p key={`${item.sourceId}:${item.relation}:${item.targetId}`}><a href={objectHref(record.workspaceId, "relation", item.sourceId)}>{item.sourceId}</a> · {item.relation} · <a href={objectHref(record.workspaceId, "relation", item.targetId)}>{item.targetId}</a> <small>{item.sourceRevision} / {item.targetRevision}</small></p>)
          : result.items.map(item => <article key={item.id}>
            <a href={objectHref(record.workspaceId, item.entity === "work_item" ? "task" : item.entity, item.id, item.projectId)}>{item.title || item.id}</a> <code>{item.id}</code> <small>revision {item.revision} · v{item.version}</small>
            {item.status && <p>{t("状态：", "Status: ")}{item.status}</p>}
            {item.fields && <dl>{Object.entries(item.fields).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{Array.isArray(value) ? value.join(", ") : value ?? t("未设置", "Not set")}</dd></div>)}</dl>}
            {item.body !== undefined && <pre>{item.body}</pre>}
            {item.bodyOffset !== undefined && <p>{t("正文偏移：", "Body offset: ")}{item.bodyOffset}</p>}
            {item.nextBodyOffset != null && <p>{t("正文还有后续内容，下一偏移：", "More body content follows; next offset: ")}{item.nextBodyOffset}</p>}
          </article>)}
        {!result.items.length && <p>{t("本次结果没有匹配对象。", "This result matched no objects.")}</p>}
        {result.truncated && <p>{t("结果已截断，不代表完整数据。", "Results were truncated and do not represent the complete data.")}</p>}
        {result.nextCursor && <p>{t("下一游标：", "Next cursor: ")}<code>{result.nextCursor}</code></p>}
        {!!result.sources.length && <details><summary>{t("数据来源和版本", "Data sources and versions")}</summary><ul>{result.sources.map((source, index) => <li key={`${source.entityId}:${index}`}>{source.kind === "comment" ? <span>{source.title || source.entityId}</span> : <a href={objectHref(source.workspaceId, source.kind, source.entityId, source.projectId)}>{source.title || source.entityId}</a>} · <code>{source.revision}</code>{source.truncated && t(" · 已截断", " · truncated")}</li>)}</ul></details>}
        {result.receipt && <details><summary>{t("业务收据", "Business receipt")}</summary><p>{result.receipt.kind} · {result.receipt.action}</p><p>commandId: <code>{result.receipt.commandId}</code></p><p>operationId: <code>{result.receipt.operationId}</code></p>{result.receipt.targetId && <p>{t("目标：", "Target: ")}{result.receipt.targetId}</p>}{result.receipt.revision && <p>revision: {result.receipt.revision}</p>}</details>}
      </>}
      <small>{t("操作 ID：", "Operation ID: ")}<code>{record.operationId}</code></small>
    </div>
  </section>;
}
