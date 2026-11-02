import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@agent/components/ui/button";
import { StudioApiError, type StudioClient } from "../../../../../../../../packages/contracts/src/automation-studio-client";
import type { StudioExecution } from "../../../../../../../../packages/contracts/src/automation-studio";
import type { PmAutomationEvidence, PmAutomationSourceRef } from "../../../../../../../../packages/contracts/src/automation-pm";
import { useAgentText } from "../../i18n";
import { automationDateTime } from "./format";
import { useAutomationQuery } from "./query";
import { StudioPmCandidate, type PmReviewMutation, type PmReviewResponse } from "./studio-pm-candidate";
import { pmEvidenceUrl, pmReviewDefiniteRejection, pmReviewJournalKey, readPmReviewPending, recordPmReviewPending, redactPmReviewDrafts, settlePmReviewPending, type PmReviewPending } from "./studio-pm-review";
import styles from "./studio-pm-results.module.css";

export type StudioPmReviewContext = { actorId: string; workspaceId: string; membershipVersion: number; reviewProjectIds: readonly string[]; planningProjectIds: readonly string[]; commentProjectIds: readonly string[]; onDirtyChange?: (dirty: boolean) => void };
function Evidence({ evidence, sources }: { evidence: PmAutomationEvidence[]; sources: Map<string, PmAutomationSourceRef> }) {
  const t = useAgentText();
  return <ul className={styles.evidence}>{evidence.map((item, index) => {
    const source = sources.get(item.sourceRefId); const url = pmEvidenceUrl(source?.url);
    return <li key={`${item.sourceRefId}:${index}`}><blockquote>{item.quote}</blockquote>{source ? <><span>{source.kind} · {url ? <a href={url} target="_blank" rel="noreferrer">{source.label || source.id}</a> : source.label || source.id}</span><small><code>{source.id}</code> · <code>{source.revision}</code>{source.updatedAt && ` · ${automationDateTime(source.updatedAt)}`}</small></> : <span className={styles.warning}>{t("来源引用不可读取；未伪造链接", "Source reference is unavailable; no link is fabricated")} · {item.sourceRefId}</span>}</li>;
  })}</ul>;
}
/** Existing execution detail, not a second reporting product or session store. All mount effects are reads. */
export function StudioPmResults({ run, api, context, locked, onAccessFailure }: { run: StudioExecution; api: StudioClient; context: StudioPmReviewContext; locked: boolean; onAccessFailure: (cause: unknown) => void }) {
  const t = useAgentText(); const alive = useRef(false); const inFlight = useRef(false);
  const journalKey = pmReviewJournalKey(context.actorId, context.workspaceId);
  const commentWritable = context.commentProjectIds.includes(run.configSnapshot.projectId);
  const reviewAllowed = context.reviewProjectIds.includes(run.configSnapshot.projectId);
  const planningWritable = context.planningProjectIds.includes(run.configSnapshot.projectId);
  const [initial] = useState(() => { try { redactPmReviewDrafts(context.actorId, context.workspaceId, context.membershipVersion); return { pending: readPmReviewPending(journalKey), error: "" }; } catch (cause) { return { pending: null, error: cause instanceof Error ? cause.message : String(cause) }; } });
  const [pending, setPending] = useState(initial.pending); const original = useRef(pending); original.current = pending;
  const [storageError, setStorageError] = useState(initial.error); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [replies, setReplies] = useState<Record<string, PmReviewResponse>>({});
  const [continuationReady, setContinuationReady] = useState<string | null>(null);
  const [dirtyCandidates, setDirtyCandidates] = useState<Set<string>>(new Set());
  const result = useAutomationQuery(`pm-result:${run.id}:${run.status}`, async signal => { try { const value = await api.pmResult(run.id, { signal }); if (value.executionId !== run.id || run.configSnapshot.action.kind !== "template" || value.templateId !== run.configSnapshot.action.templateId) throw new Error("PM result execution/template mismatch"); return value; } catch (cause) { onAccessFailure(cause); throw cause; } });
  const snapshot = useAutomationQuery(`pm-snapshot:${run.id}:${run.status}`, async signal => { try { const value = await api.pmSnapshot(run.id, { signal }); if (value.executionId !== run.id || value.workspaceId !== context.workspaceId || value.projectId !== run.configSnapshot.projectId) throw new Error("PM snapshot scope mismatch"); return value; } catch (cause) { onAccessFailure(cause); throw cause; } });
  const sources = new Map(snapshot.error ? [] : snapshot.data?.sources.map(source => [source.refId, source]) ?? []);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { context.onDirtyChange?.(!!pending || !!storageError || dirtyCandidates.size > 0); return () => context.onDirtyChange?.(false); }, [pending, storageError, dirtyCandidates.size, context.onDirtyChange]);
  const onCandidateDirty = useCallback((id: string, dirty: boolean) => setDirtyCandidates(current => {
    if (current.has(id) === dirty) return current;
    const next = new Set(current); if (dirty) next.add(id); else next.delete(id); return next;
  }), []);
  function finish(request: PmReviewPending, response: PmReviewResponse): boolean {
    if (("requestId" in response && response.requestId !== request.requestId) || ("candidate" in response ? response.candidate.id : response.result.candidate.id) !== request.candidateId) throw new Error("PM review response identity mismatch; reconcile the original receipt");
    // Unknown application results keep their original request identity even when HTTP returned successfully.
    const unknown = "result" in response && !("canApply" in response.result) && response.result.status === "outcome_unknown";
    if (!unknown) { settlePmReviewPending(journalKey, request.requestId); original.current = null; }
    if (alive.current) {
      if (!unknown) setPending(null);
      if (request.executionId === run.id) setReplies(current => ({ ...current, [request.candidateId]: response }));
      if ("httpStatus" in response && response.httpStatus >= 400) setError(t("原请求已被拒绝；输入保留。请比较当前版本，不会自动重试。", "The original request was rejected; your input is retained. Compare current revisions; it will not be retried automatically."));
      result.refetch();
    }
    return !unknown;
  }
  const mutate: PmReviewMutation = async (kind, candidate, selected, previewToken) => {
    const allowed = kind === "edit" || kind === "ignore" ? reviewAllowed : candidate.kind === "task-comment" ? commentWritable : planningWritable;
    if (inFlight.current || original.current || storageError || locked || !allowed || result.error || snapshot.error || !result.data || !snapshot.data) return null;
    if (kind === "apply" && !previewToken) { setError(t("缺少精确预览，请重新预览。", "An exact preview is required; preview again.")); return null; }
    const request: PmReviewPending = { version: 1, requestId: crypto.randomUUID(), executionId: run.id, projectId: run.configSnapshot.projectId, candidateId: candidate.id, expectedRevision: candidate.revision, kind, membershipVersion: context.membershipVersion, ...(kind === "apply" ? { applyInput: { previewToken: previewToken!, ...(candidate.kind === "plan" ? { selectedItemIds: [...selected] } : {}) } } : {}) };
    try { recordPmReviewPending(journalKey, request); original.current = request; setPending(request); }
    catch (cause) { setStorageError(cause instanceof Error ? cause.message : String(cause)); return null; }
    inFlight.current = true; setBusy(true); setError(""); setContinuationReady(null);
    try {
      const response = kind === "edit" ? await api.pmEditCandidate(run.id, candidate.id, request.requestId, candidate.revision, candidate)
        : kind === "preview" ? await api.pmPreviewCandidate(run.id, candidate.id, request.requestId, candidate.revision, candidate.kind === "plan" ? selected : undefined)
        : kind === "apply" ? await api.pmApplyCandidate(run.id, candidate.id, request.requestId, request.expectedRevision, request.applyInput!.previewToken, request.applyInput!.selectedItemIds)
        : await api.pmIgnoreCandidate(run.id, candidate.id, request.requestId, candidate.revision);
      finish(request, response); return response;
    } catch (cause) {
      if (pmReviewDefiniteRejection(cause)) {
        try { settlePmReviewPending(journalKey, request.requestId); original.current = null; if (alive.current) setPending(null); } catch (failure) { if (alive.current) setStorageError(String(failure)); }
      }
      onAccessFailure(cause);
      if (alive.current) { setError(pmReviewDefiniteRejection(cause) ? `${cause instanceof Error ? cause.message : String(cause)}\n${t("输入已保留；重新读取并显式比较版本，不自动合并。", "Input is retained. Reload and explicitly compare revisions; no automatic merge.")}` : t("原请求结果未知。仅查询原收据，不重发或生成新键。", "The original outcome is unknown. Query its receipt; never resend or replace its ID.")); result.refetch(); }
      return null;
    } finally { inFlight.current = false; if (alive.current) setBusy(false); }
  };
  async function reconcile() {
    const request = original.current; if (!request || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try { const receipt = await api.pmReceipt(request.requestId); if (receipt.requestId !== request.requestId) throw new Error("Receipt identity mismatch"); const settled = finish(request, receipt); if (alive.current) setContinuationReady(settled ? null : request.requestId); }
    catch (cause) { onAccessFailure(cause); if (alive.current) setError(t("仍无法证明原请求结果；保留原标识，不会重新应用。", "The original outcome is still unproven; its identity is retained and it will not be applied again.") + " " + (cause instanceof Error ? cause.message : String(cause))); }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }
  async function continueOriginal() {
    const request = original.current;
    const target = result.data?.candidates.find(candidate => candidate.id === request?.candidateId);
    if (!target || !request?.applyInput || continuationReady !== request.requestId || request.membershipVersion !== context.membershipVersion || request.executionId !== run.id || inFlight.current || locked || !(target.kind === "task-comment" ? commentWritable : planningWritable)) return;
    if (!window.confirm(t("仅继续原已批准请求中尚未执行的步骤？服务会先核对原步骤，未知步骤不会重复派发；请求 ID、预览和选择保持不变。", "Continue only the remaining steps of the original approved request? The service reconciles original steps first and never redispatches unknown steps. The request ID, preview and selection stay unchanged."))) return;
    inFlight.current = true; setBusy(true); setError("");
    try { const response = await api.pmApplyCandidate(request.executionId, request.candidateId, request.requestId, request.expectedRevision, request.applyInput.previewToken, request.applyInput.selectedItemIds); finish(request, response); }
    catch (cause) { onAccessFailure(cause); if (alive.current) setError(t("原请求仍未核定；继续保留原输入与标识，请再次查询原收据。", "The original request is still unsettled; its inputs and identity are retained. Query the original receipt again.") + " " + (cause instanceof Error ? cause.message : String(cause))); }
    finally { inFlight.current = false; if (alive.current) { setBusy(false); setContinuationReady(null); } }
  }
  const resultMissing = result.error instanceof StudioApiError && result.error.status === 404;
  const pendingCandidate = result.data?.candidates.find(candidate => candidate.id === pending?.candidateId);
  const continuationAllowed = pendingCandidate ? pendingCandidate.kind === "task-comment" ? commentWritable : planningWritable : false;
  return <section className={styles.results} aria-label={t("PM 原生分析结果", "PM native analysis results")}>
    <header><h3>{t("持久化发现与人工审阅", "Persisted findings and human review")}</h3><Button variant="outline" size="sm" disabled={result.loading || snapshot.loading || busy} onClick={() => { result.refetch(); snapshot.refetch(); }}>{t("重读结果", "Reload results")}</Button></header>
    <p>{t("分析结果独立于 Chat 文本持久化。没有发现不代表验收通过；运行成功不等于业务任务完成。打开详情只读取，不创建会话或重新分析。", "Analysis results persist independently of Chat text. No findings do not imply acceptance; run success is not business task completion. Opening details only reads; it never creates a session or re-analyzes.")}</p>
    {pending && <section className={styles.warning} role="status"><strong>{t("原审阅请求待核对", "Original review request awaiting reconciliation")}</strong><p><code>{pending.requestId}</code> · {pending.kind} · {pending.executionId} / {pending.candidateId}</p><p>{t("切换运行或刷新不会清除原键。缺收据不证明未执行；所有新候选写入暂停。", "Switching runs or refreshing does not clear this ID. A missing receipt does not prove non-execution; new candidate writes are paused.")}</p><Button disabled={busy} onClick={() => void reconcile()}>{t("查询原收据", "Query original receipt")}</Button>{pending.executionId !== run.id && <a href={`/agent/automations/history?workspace=${encodeURIComponent(context.workspaceId)}&project=${encodeURIComponent(pending.projectId)}&run=${encodeURIComponent(pending.executionId)}`}>{t("打开原运行核对", "Open the original execution")}</a>}{pending.applyInput && pending.executionId === run.id && pending.membershipVersion === context.membershipVersion && continuationReady === pending.requestId && <Button variant="outline" disabled={busy || locked || !continuationAllowed} onClick={() => void continueOriginal()}>{t("明确继续原已批准请求（不换键）", "Explicitly continue original approval (same request ID)")}</Button>}</section>}
    {storageError && <section className={styles.error} role="alert">{storageError}<Button variant="outline" onClick={() => { try { const recovered = readPmReviewPending(journalKey); original.current = recovered; setPending(recovered); setStorageError(""); } catch (cause) { setStorageError(String(cause)); } }}>{t("重试恢复日志", "Retry recovery journal")}</Button></section>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {result.loading && <p role="status">{t("读取真实分析结果…", "Reading persisted analysis…")}</p>}
    {!!result.error && <p className={resultMissing ? styles.warning : styles.error} role="alert">{resultMissing ? t("该运行尚无已发布的 PM 分析结果。未将空数据当作成功；可在运行结束后重读。", "This run has no published PM analysis result yet. Empty data is not treated as success; reload after the run finishes.") : result.error instanceof Error ? result.error.message : t("结果读取失败", "Result read failed")}</p>}
    {!!snapshot.error && <p className={styles.warning} role="alert">{t("冻结来源快照读取失败；证据链接与候选应用暂停。", "The frozen source snapshot could not be read; evidence links and candidate application are paused.")}</p>}
    {result.data && !result.error && <>
      <p className={styles.summary}>{result.data.summary}</p><small>{t("观察时间", "Observed at")}: {automationDateTime(result.data.observedAt)}</small>
      {snapshot.data && !snapshot.error && <p>{t("冻结范围", "Frozen scope")}: <code>{snapshot.data.projectId}</code>{snapshot.data.timeWindow && <> · {automationDateTime(snapshot.data.timeWindow.from)} → {automationDateTime(snapshot.data.timeWindow.to)} ({snapshot.data.timeWindow.basis})</>}{snapshot.data.lastVisitAt && <> · lastVisitAt {automationDateTime(snapshot.data.lastVisitAt)}</>}</p>}
      <section className={styles.coverage}><h4>{t("来源覆盖与缺口", "Source coverage and gaps")}</h4><ul>{result.data.coverage.map(item => <li key={item.source} data-status={item.status}><strong>{item.source}</strong><span>{item.status} · {item.observedRecords} / {item.totalRecords ?? t("未知", "unknown")}</span>{item.reason && <p>{item.reason}</p>}</li>)}</ul>{result.data.gaps.map((gap, index) => <p key={`${gap.source}:${index}`} className={styles.warning}><strong>{gap.source}</strong>: {gap.reason}</p>)}</section>
      <section><h4>{t("发现", "Findings")} ({result.data.findings.length})</h4>{!result.data.findings.length && <p>{t("本次来源未产生发现。请同时检查覆盖缺口，不能解释为项目已全部达标。", "No findings arose from these sources. Review coverage gaps; this does not mean all project criteria were met.")}</p>}{result.data.findings.map(finding => <article key={finding.id} className={styles.finding}><h5>{finding.title}</h5><small>{finding.severity} · {t("置信度", "Confidence")}: {finding.confidence}</small><p>{finding.detail}</p><Evidence evidence={finding.evidence} sources={sources} /></article>)}</section>
      <section><h4>{t("可编辑候选", "Editable candidates")} ({result.data.candidates.length})</h4>{result.data.candidates.map(candidate => <StudioPmCandidate key={candidate.id} candidate={candidate} context={context} executionId={run.id} workflow={snapshot.error ? undefined : snapshot.data?.workflow} task={"taskId" in candidate && !snapshot.error ? snapshot.data?.tasks.find(task => task.id === candidate.taskId) : undefined} canApply={candidate.kind === "task-comment" ? commentWritable : planningWritable} locked={locked || busy || !!pending || !!storageError || !reviewAllowed || !!snapshot.error || !snapshot.data} mutate={mutate} response={replies[candidate.id]} onDirtyChange={onCandidateDirty} />)}</section>
    </>}
  </section>;
}
