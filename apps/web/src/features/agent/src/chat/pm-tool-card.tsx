import { useEffect, useRef, useState } from "react";
import type { PmToolCallProjection, PmToolCallRecord } from "@agent-workspace/contracts/pm-tools";
import { workspaceClient } from "../network";
import { useAgentText } from "../i18n";
import type { ProjectAuditPage } from "../../../../../../../packages/contracts/src/client";
import { pmJson } from "../pm/state";
import { PmToolResultContent } from "./pm-tool-result-content";
import { PmObjectLink, pmObjectHref as objectHref } from "./pm-tool-result-ui";
import { isPmToolBusinessWrite } from "../pm/pm-tool-changes";

export type PmToolRecord = PmToolCallProjection;


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
    if (record.status === "succeeded" && record.result?.receipt && isPmToolBusinessWrite(record.name) && !notified.current) {
      notified.current = true;
      window.dispatchEvent(new CustomEvent("pm-tool-committed", { detail: { workspaceId: record.workspaceId } }));
    }
  }, [record.name, record.status, record.result, record.workspaceId]);
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
    <header><strong>{record.name}</strong><span>{record.status === "pending_approval" ? t("等待批准", "Awaiting approval") : record.status === "running" ? t("进行中", "Running") : record.status === "succeeded" ? t("工具已返回", "Tool returned") : record.status === "unknown" ? t("待核实", "Needs verification") : record.error?.code === "approval_rejected" ? t("已拒绝", "Rejected") : t("失败", "Failed")}</span></header>
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
        {record.status === "unknown" ? <p role="status">{t("暂不将返回片段展示为已应用结果；来源和收据仅用于核对原操作。", "Returned fragments are not presented as applied results; sources and receipts are only references for reconciling the original operation.")}</p>
          : result.kind === "task_brief" || result.kind === "knowledge" ? <PmGuidanceResult result={result} />
          : result.kind === "workflow" ? <PmWorkflowResult result={result} />
          : <PmToolResultContent result={result} workspaceId={record.workspaceId} />}
        {result.truncated && <p>{t("结果已截断，不代表完整数据。", "Results were truncated and do not represent the complete data.")}</p>}
        {result.nextCursor && <p>{t("下一游标：", "Next cursor: ")}<code>{result.nextCursor}</code></p>}
        {!!result.sources.length && <details><summary>{t("数据来源和版本", "Data sources and versions")}</summary><ul>{result.sources.slice(0, 20).map((source, index) => <li key={`${source.entityId}:${index}`}><PmObjectLink workspaceId={source.workspaceId} kind={source.kind} id={source.entityId} projectId={source.projectId}>{source.title || source.entityId}</PmObjectLink> · <code>{source.revision}</code>{source.truncated && t(" · 已截断", " · truncated")}</li>)}</ul>{result.sources.length > 20 && <p role="status">{t("卡片仅展示前 20 条来源；这不是完整来源列表。", "The card shows only the first 20 sources; this is not the full source list.")}</p>}</details>}
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

function PmWorkflowResult({ result }: { result: Extract<NonNullable<PmToolCallRecord["result"]>, { kind: "workflow" }> }) {
  const t = useAgentText();
  const workflow = result.workflow;
  return <section aria-label={t("读取时的任务配置工作流", "Task workflow at read time")}>
    <h4>{t("读取时的任务配置工作流（只读）", "Task workflow at read time (read-only)")}</h4>
    <p><a href={objectHref(workflow.workspaceId, "project", workflow.projectId)}>{workflow.projectId}</a> · <code>{workflow.entity}</code></p>
    <p>{t("初始状态：", "Initial state: ")}<code>{workflow.initial}</code></p>
    <h5>{t("状态与类别", "States and categories")}</h5>
    <ul>{workflow.states.map(state => <li key={state.id}><code>{state.id}</code> · {state.label} · <code>{state.category}</code></li>)}</ul>
    <h5>{t("配置的转换边", "Configured transitions")}</h5>
    {workflow.transitions.length ? <ul>{workflow.transitions.map((edge, index) => <li key={`${edge.from}:${edge.to}:${index}`}><code>{edge.from}</code> → <code>{edge.to}</code></li>)}</ul> : <p>{t("配置未列出转换边。", "The configuration lists no transition edges.")}</p>}
    {workflow.defaultTargets && !!Object.keys(workflow.defaultTargets).length && <details><summary>{t("类别默认目标", "Default targets by category")}</summary><ul>{Object.entries(workflow.defaultTargets).map(([category, id]) => <li key={category}><code>{category}</code> · <code>{id}</code></li>)}</ul></details>}
    <p>{t("配置来源：", "Configuration source: ")}{workflow.configuration.source === "workspace" ? t("工作区", "Workspace") : t("内置默认", "Built-in default")} · <code>{workflow.configuration.schema}</code></p>
    {workflow.configuration.revision && <p>{t("配置 revision：", "Configuration revision: ")}<code>{workflow.configuration.revision}</code></p>}
    <p>{t("工作流 revision：", "Workflow revision: ")}<code>{workflow.configuration.workflowRevision}</code></p>
    <p>{t("读取配置不改变任务状态，也不授予转换权限；实际操作仍由 PM 授权与当前配置验证。", "Reading configuration neither changes task state nor grants transition permission; PM authorization and current configuration still validate actual actions.")}</p>
  </section>;
}

function PmGuidanceResult({ result }: { result: Extract<NonNullable<PmToolCallRecord["result"]>, { kind: "task_brief" | "knowledge" }> }) {
  const t = useAgentText();
  if (result.kind === "task_brief") {
    const brief = result.brief;
    return <section aria-label={t("只读任务简报", "Read-only task brief")}>
      <h4>{brief.task.title} · {brief.stage}</h4><p><a href={objectHref(brief.task.workspaceId, "task", brief.task.taskId, brief.task.projectId)}>{brief.task.taskId}</a> · revision <code>{brief.task.revision}</code> · {brief.generatedAt}</p>
      <p>{brief.authorityNotice}</p>
      {[{ title: t("目标", "Goals"), items: brief.goals }, { title: t("验收", "Acceptance"), items: brief.acceptanceCriteria }, { title: t("约束", "Constraints"), items: brief.constraints }, { title: t("非目标", "Non-goals"), items: brief.nonGoals }].map(group => <section key={group.title}><h5>{group.title}</h5>{group.items.length > 0 ? <ul>{group.items.map((entry, index) => <li key={index}>{entry.text}</li>)}</ul> : <p>{t("来源未明确声明，请核对缺口与原文。", "Not explicit in the source; inspect gaps and original text.")}</p>}</section>)}
      <h5>{t("阶段指导（不是授权）", "Stage guidance (not authorization)")}</h5><ul>{brief.guidance.map((line, index) => <li key={index}>{line}</li>)}</ul>
      <h5>{t("缺口", "Gaps")}</h5><ul>{brief.gaps.map((gap, index) => <li key={index}>{gap.code}: {gap.message}</li>)}</ul>
      {(brief.truncation.truncated || !brief.dispatchable) && <p role="status">{brief.truncation.message ?? t("简报不完整，不可派发。", "The brief is incomplete and cannot be dispatched.")}</p>}
      <details><summary>{t("任务原文", "Original task body")} · {brief.task.bodyOffset} / {brief.task.bodyLength}</summary><pre>{brief.task.body}</pre>{brief.task.nextBodyOffset !== null && <p>{t("继续读取偏移", "Continue from offset")}: {brief.task.nextBodyOffset}</p>}</details>
      <p>{t("这是当时读取的来源化输入；查看不创建会话或运行模型。", "This is source-linked input read at that time; viewing creates no session and runs no model.")}</p>
    </section>;
  }
  const knowledge = result.knowledge;
  return <section aria-label={t("待复核知识候选", "Knowledge candidates requiring review")}>
    <h4>{t("知识候选 · 待复核", "Knowledge candidates · needs review")}</h4><p>“{knowledge.query}” · {knowledge.projectIds.join(", ")} · {knowledge.generatedAt}</p><p>{knowledge.authorityNotice}</p>
    {!knowledge.items.length && <p>{t("明确范围内未匹配候选，不代表没有相关知识。", "No candidate matched in the explicit scope; this does not prove that no relevant knowledge exists.")}</p>}
    <ul>{knowledge.items.map((candidate, index) => <li key={index}>
      <a href={objectHref(candidate.source.workspaceId, candidate.source.kind === "work_item" ? "task" : candidate.source.kind, candidate.source.entityId, candidate.source.projectId)}>{candidate.source.title || candidate.source.entityId}</a> · {candidate.source.projectId} · <code>{candidate.source.revision}</code>
      <pre>{candidate.excerpt}</pre><p>{t("有效性／适用性：待复核；排序不是已验证结论。", "Validity / applicability: needs review; ranking is not a verified conclusion.")} {candidate.reason}</p>
      {candidate.validitySignals.length > 0 && <details><summary>{t("来源中的失效／替代线索（原文，不是自动判定）", "Invalidation / supersession signals (source text, not an automatic verdict)")}</summary><ul>{candidate.validitySignals.map((signal, i) => <li key={i}><pre>{signal.text}</pre>{signal.sourceRefs.map((ref, j) => <p key={j}>{ref.entityId} · <code>{ref.revision}</code> · {ref.location.type === "body" ? `${ref.location.offset}–${ref.location.offset + ref.location.length}` : ref.location.path}</p>)}</li>)}</ul></details>}
      {candidate.truncation.truncated && <p>{t("片段已裁剪；请打开来源继续核对。", "Excerpt clipped; open the source to continue.")} {candidate.truncation.nextBodyOffset}</p>}
    </li>)}</ul>{knowledge.nextCursor && <p>{t("下一页游标（保持原检索范围）", "Next page cursor (retain the original scope)")}: <code>{knowledge.nextCursor}</code></p>}
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
        <p>{t("操作者：", "Actor: ")}<code>{entry.actorId}</code> · {t("目标：", "Target: ")}<PmObjectLink workspaceId={workspaceId} kind={entry.targetKind} id={entry.targetId} projectId={projectId} /></p>
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
