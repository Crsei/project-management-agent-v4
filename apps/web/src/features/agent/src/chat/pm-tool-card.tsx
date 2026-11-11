import { useEffect, useRef, useState } from "react";
import type { PmToolCallProjection, PmToolCallRecord } from "@agent-workspace/contracts/pm-tools";
import { workspaceClient } from "../network";
import { useAgentText } from "../i18n";
import type { ProjectAuditPage } from "../../../../../../../packages/contracts/src/client";
import { pmJson } from "../pm/state";

export type PmToolRecord = PmToolCallProjection;

function objectHref(workspaceId: string | null, kind: string, id: string, projectId?: string | null) {
  if (!workspaceId) return undefined;
  const root = `/pm/${encodeURIComponent(workspaceId)}`;
  return kind === "project" ? `${root}/projects/${encodeURIComponent(id)}` : `${root}${kind === "task" && projectId ? `/projects/${encodeURIComponent(projectId)}` : ""}/entities/${encodeURIComponent(id)}`;
}

export function PmToolCard({ record, onUpdate }: { record: PmToolRecord; onUpdate: (record: PmToolRecord) => void }) {
  const t = useAgentText();
  if (record.visibility === "redacted" || record.visibility === "unavailable" || !("name" in record)) {
    return <section className="native-output-card pm-tool-card" data-visibility={record.visibility}>
      <header><strong>{t("PM 工具记录", "PM tool record")}</strong></header>
      <p role="status" className="native-card-body">{record.visibility === "redacted"
        ? t("内容已不可访问。", "This content is no longer accessible.")
        : t("暂时无法核验内容访问权限，请稍后刷新。", "Content access cannot be verified right now. Refresh later.")}</p>
    </section>;
  }
  return <VisiblePmToolCard record={record} onUpdate={onUpdate} />;
}

function VisiblePmToolCard({ record, onUpdate }: { record: PmToolCallRecord; onUpdate: (record: PmToolRecord) => void }) {
  const t = useAgentText();
  const notified = useRef(false);
  useEffect(() => {
    if (window.location.hash === `#pm-operation-${record.operationId}`) document.getElementById(`pm-operation-${record.operationId}`)?.scrollIntoView({ block: "center" });
  }, [record.operationId]);
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
  return <section id={`pm-operation-${record.operationId}`} className="native-output-card pm-tool-card" data-state={record.status}>
    <header><strong>{record.name}</strong><span>{record.status === "pending_approval" ? t("等待批准", "Awaiting approval") : record.status === "running" ? t("进行中", "Running") : record.status === "succeeded" ? t("已完成", "Completed") : record.status === "unknown" ? t("待核实", "Needs verification") : record.error?.code === "approval_rejected" ? t("已拒绝", "Rejected") : t("失败", "Failed")}</span></header>
    <div className="native-card-body">
      {record.target && <p className="text-xs">{t("PM 目标：", "PM target: ")}<code>{record.target.workspaceId}{record.target.projectId ? ` / ${record.target.projectId}` : ""}</code></p>}
      {record.linkage && <p className="text-xs" role="status">{t("新增许可：Full access · 仅记录与提醒；既有 PM 授权仍须核验。", "New policy: Full access · audit and notices only; existing PM authorization still applies.")}</p>}
      {record.notices?.map(notice => <p key={notice.code} role="status" className="text-xs">{notice.message}</p>)}
      {record.status === "succeeded" && !result && <div role="status"><p>{t("原操作已确认成功，业务结果正文尚未取得；不会重新执行。", "The original operation is confirmed successful; its business payload has not been retrieved. It will not be rerun.")}</p>{record.commandIds?.map(commandId => <p key={commandId}>commandId: <code>{commandId}</code></p>)}</div>}
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
        {result.receipt && record.target?.projectId && <PmReceiptAudit workspaceId={record.target.workspaceId} projectId={record.target.projectId} operationId={record.operationId} commandId={result.receipt.commandId} />}
      </>}
      <small>{t("操作 ID：", "Operation ID: ")}<code>{record.operationId}</code></small>
      {record.linkage && <details><summary>{t("执行关联", "Execution links")}</summary><dl>
        <dt>traceId</dt><dd><code>{record.linkage.traceId}</code></dd>
        <dt>invocationId</dt><dd><code>{record.linkage.invocationId}</code></dd>
        {record.linkage.inputMessageId && <><dt>{t("输入消息", "Input message")}</dt><dd><code>{record.linkage.inputMessageId}</code></dd></>}
        {record.linkage.executionGrantId && <><dt>{t("执行策略记录", "Execution policy record")}</dt><dd><code>{record.linkage.executionGrantId}</code></dd></>}
      </dl></details>}
    </div>
  </section>;
}

function PmReceiptAudit({ workspaceId, projectId, operationId, commandId }: {
  workspaceId: string; projectId: string; operationId: string; commandId: string;
}) {
  const t = useAgentText();
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState<string>();
  const [page, setPage] = useState<ProjectAuditPage>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setPage(undefined); setError(undefined);
    if (!open) return;
    const controller = new AbortController();
    let running = false;
    const refresh = async () => {
      if (running) return;
      running = true; setLoading(true);
      try {
        const query = new URLSearchParams({ commandId, operationId, limit: "30", ...(cursor ? { cursor } : {}) });
        const result = await pmJson<ProjectAuditPage>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/audit?${query}`, { signal: controller.signal });
        if (!controller.signal.aborted) { setPage(result); setError(undefined); }
      } catch (cause) {
        if (!controller.signal.aborted) { setPage(undefined); setError(cause instanceof Error ? cause.message : String(cause)); }
      } finally {
        running = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 10_000);
    const onFocus = () => { setPage(undefined); void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => { controller.abort(); window.clearInterval(interval); window.removeEventListener("focus", onFocus); };
  }, [open, workspaceId, projectId, operationId, commandId, cursor]);
  return <section className="mt-2 text-xs">
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? t("收起命令审计", "Hide command audit") : t("查看关联命令审计", "View linked command audit")}</button>
    {open && <>
      {loading && <p role="status">{t("正在核验审计访问…", "Verifying audit access…")}</p>}
      {error && <p role="alert">{t("审计内容不可读取：", "Audit content cannot be read: ")}{error}</p>}
      {page && <><ul>{page.entries.map(entry => <li key={entry.id} className="my-2 break-all">
        <strong>{entry.action}</strong> · <time>{entry.occurredAt}</time>
        <p>{t("操作者：", "Actor: ")}<code>{entry.actorId}</code> · {t("目标：", "Target: ")}<a href={objectHref(workspaceId, entry.targetKind, entry.targetId, projectId)}>{entry.targetId}</a></p>
        <p>revision <code>{entry.beforeVersion ?? "—"}</code> → <code>{entry.afterVersion ?? "—"}</code></p>
        <p>commandId: <code>{entry.commandId}</code></p>
        {entry.correlation && <p>traceId: <code>{entry.correlation.traceId}</code> · operationId: <code>{entry.correlation.operationId}</code></p>}
      </li>)}</ul>
        {!page.entries.length && <p>{t("尚无可见的关联审计记录；不能据此推断操作失败。", "No linked audit entry is visible yet; this does not prove operation failure.")}</p>}
        {page.nextCursor && <button type="button" disabled={loading} onClick={() => setCursor(page.nextCursor!)}>{t("下一页", "Next page")}</button>}
        {cursor && <button type="button" disabled={loading} onClick={() => setCursor(undefined)}>{t("回到第一页", "First page")}</button>}
      </>}
    </>}
  </section>;
}
