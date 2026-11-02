import { useEffect, useRef, useState } from "react";
import { Button } from "@agent/components/ui/button";
import { pmAutomationCandidateSchema, type PmAutomationCandidate, type PmAutomationCandidatePreview, type PmAutomationReviewReceipt, type PmAutomationSnapshot, type PmAutomationTask } from "../../../../../../../../packages/contracts/src/automation-pm";
import { useAgentText } from "../../i18n";
import { StudioPmCandidateFields } from "./studio-pm-candidate-fields";
import { normalizePmCandidate, pmCandidateWithBefore, pmEvidenceUrl, pmPlanSelectionIssue, pmPreviewMatches, pmReviewDraftKey, rebasePmCandidate, type PmReviewPending } from "./studio-pm-review";
import type { StudioPmReviewContext } from "./studio-pm-results";
import styles from "./studio-pm-results.module.css";

export type PmReviewResponse = PmAutomationCandidatePreview | PmAutomationReviewReceipt;
export type PmReviewMutation = (kind: PmReviewPending["kind"], candidate: PmAutomationCandidate, selected: string[], previewToken?: string) => Promise<PmReviewResponse | null>;
type Draft = { candidate: PmAutomationCandidate; baseline: PmAutomationCandidate; selected: string[]; reviewTask?: PmAutomationTask };
export function StudioPmCandidate({ candidate, context, executionId, workflow, task, canApply, locked, mutate, response, onDirtyChange }: {
  candidate: PmAutomationCandidate; context: StudioPmReviewContext; executionId: string; workflow?: PmAutomationSnapshot["workflow"]; task?: PmAutomationTask; canApply: boolean; locked: boolean; mutate: PmReviewMutation; response?: PmReviewResponse; onDirtyChange: (id: string, dirty: boolean) => void;
}) {
  const t = useAgentText();
  const key = pmReviewDraftKey(context.actorId, context.workspaceId, context.membershipVersion, executionId, candidate.id);
  const [initial] = useState(() => {
    const fresh: Draft = { candidate, baseline: candidate, selected: [] };
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return { draft: fresh, error: "" };
      const recovered = JSON.parse(raw) as Draft;
      // Editable blanks can be schema-invalid until saved. They are not trusted commands or evidence.
      if (recovered.candidate?.id !== candidate.id || recovered.candidate.kind !== candidate.kind || !recovered.baseline || !Array.isArray(recovered.selected) || !recovered.selected.every(id => typeof id === "string")) throw new Error("Invalid candidate recovery draft");
      const shape = pmAutomationCandidateSchema.safeParse(recovered.candidate);
      if (!pmAutomationCandidateSchema.safeParse(recovered.baseline).success || (!shape.success && shape.error.issues.some(issue => ["invalid_type", "invalid_union", "unrecognized_keys", "invalid_value"].includes(issue.code))) || JSON.stringify(recovered.candidate.sourceRefs) !== JSON.stringify(candidate.sourceRefs) || JSON.stringify(recovered.candidate.evidence) !== JSON.stringify(candidate.evidence)) throw new Error("Candidate recovery structure or original evidence is invalid");
      return { draft: recovered, error: "" };
    } catch (cause) { return { draft: fresh, error: cause instanceof Error ? cause.message : String(cause) }; }
  });
  const [draft, setDraft] = useState(initial.draft);
  const current = useRef(draft); current.current = draft;
  const [storageError, setStorageError] = useState(initial.error);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<PmAutomationCandidatePreview | null>(null);
  const [receipt, setReceipt] = useState<PmAutomationReviewReceipt | null>(null);
  const dirty = JSON.stringify(draft.candidate) !== JSON.stringify(draft.baseline);
  const stale = draft.baseline.revision !== candidate.revision;
  const selectionIssue = pmPlanSelectionIssue(draft.candidate, draft.selected);
  const terminal = ["applied", "ignored", "outcome_unknown"].includes(candidate.status);
  const disabled = locked || !!storageError || terminal;
  useEffect(() => { onDirtyChange(candidate.id, dirty || !!storageError); return () => onDirtyChange(candidate.id, false); }, [candidate.id, dirty, storageError, onDirtyChange]);
  useEffect(() => {
    if (candidate.revision === current.current.baseline.revision || JSON.stringify(current.current.candidate) !== JSON.stringify(current.current.baseline)) return;
    persist({ ...current.current, candidate, baseline: candidate }); setPreview(null);
  }, [candidate]);
  useEffect(() => { if (response) receive(response); }, [response]);
  function persist(next: Draft): boolean {
    try { sessionStorage.setItem(key, JSON.stringify(next)); current.current = next; setDraft(next); return true; }
    catch { setStorageError(t("候选恢复存储不可用，禁止发送写入。", "Candidate recovery storage is unavailable; no writes can be sent.")); return false; }
  }
  function change(next: PmAutomationCandidate) {
    if (disabled) return;
    const selected = next.kind === "plan" ? current.current.selected.filter(id => next.plan.tasks.some(task => task.localId === id)) : current.current.selected;
    if (persist({ ...current.current, selected, candidate: pmCandidateWithBefore(next, current.current.reviewTask ?? task) })) { setPreview(null); setError(""); }
  }
  function receive(value: PmReviewResponse) {
    if ("canApply" in value) { if (value.candidate.id === candidate.id) setPreview(value); return; }
    if (value.result.candidate.id !== candidate.id) return;
    if ("canApply" in value.result) { setPreview(value.result); return; }
    setReceipt(value); setPreview(null);
    if (value.httpStatus >= 200 && value.httpStatus < 300 && value.result.status !== "outcome_unknown") persist({ ...current.current, candidate: value.result.candidate, baseline: value.result.candidate });
  }
  async function send(kind: PmReviewPending["kind"]) {
    if (disabled || stale || (kind === "apply" && dirty)) return;
    if ((kind === "preview" || kind === "apply") && !canApply) return;
    if ((kind === "preview" || kind === "apply") && selectionIssue) { setError(selectionIssue); return; }
    if (kind === "apply" && !pmPreviewMatches(preview, draft.candidate, draft.selected)) return;
    if ((kind === "apply" || kind === "ignore") && !window.confirm(kind === "apply" ? t("按已预览版本应用此候选？将通过当前 PM 权限与版本检查写入；仅发布所选规划条目，不会自动完成任务。", "Apply this exact preview? Writes use current PM authorization and revision checks. Only selected plan items are published; tasks are not automatically completed.") : t("忽略此候选？决定会持久化，原发现和证据仍保留。", "Ignore this candidate? The decision persists; original findings and evidence remain."))) return;
    setError(""); const result = await mutate(kind, draft.candidate, draft.selected, preview?.previewToken ?? undefined); if (result) receive(result);
  }
  async function save() {
    if (disabled || stale || !dirty) return;
    const parsed = pmAutomationCandidateSchema.safeParse(normalizePmCandidate(draft.candidate));
    if (!parsed.success) { setError(parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("\n")); return; }
    setError(""); const result = await mutate("edit", parsed.data, draft.selected); if (result) receive(result);
  }
  return <article className={styles.candidate}>
    <header><h4>{candidate.title}</h4><span>{candidate.kind} · {candidate.status} · v{candidate.revision}</span></header>
    <p>{candidate.rationale}</p>
    {stale && <div className={styles.warning}><strong>{t("候选版本已更新，编辑保留；请显式比较。", "Candidate revision changed; your edits are retained for explicit comparison.")}</strong><details><summary>{t("当前服务器候选", "Current server candidate")}</summary><pre>{JSON.stringify(candidate, null, 2)}</pre></details><Button variant="outline" disabled={locked} onClick={() => { persist({ ...draft, baseline: candidate, candidate: { ...draft.candidate, revision: candidate.revision, status: candidate.status } }); setPreview(null); }}>{t("保留输入并采用候选 revision（仍需保存/重新预览）", "Keep input and adopt candidate revision (save and preview again)")}</Button><Button variant="ghost" disabled={locked} onClick={() => { persist({ candidate, baseline: candidate, selected: [] }); setPreview(null); }}>{t("放弃本地编辑，载入服务器候选", "Discard local edits and load server candidate")}</Button></div>}
    <details><summary>{t("编辑类型化候选", "Edit typed candidate")}</summary>{terminal ? <pre>{JSON.stringify(candidate, null, 2)}</pre> : <fieldset disabled={disabled}><StudioPmCandidateFields candidate={draft.candidate} workflow={workflow} onChange={change} /></fieldset>}</details>
    {draft.candidate.kind === "plan" && <div className={styles.plan}><strong>{t("明确选择发布条目", "Explicitly select items to publish")}</strong><p>{t("默认不选。前置条目必须逐项选择，缺少依赖时不会扩大选择。已有任务保留真实 ID，不重复创建。", "Nothing is selected by default. Prerequisites must be selected explicitly; missing dependencies never widen the selection. Existing tasks retain their real IDs and are not recreated.")}</p>{draft.candidate.plan.tasks.map(task => <label key={task.localId}><input type="checkbox" checked={draft.selected.includes(task.localId)} disabled={disabled} onChange={event => { persist({ ...draft, selected: event.target.checked ? [...draft.selected, task.localId] : draft.selected.filter(id => id !== task.localId) }); setPreview(null); }} /><span>{task.title} · <code>{task.localId}</code>{task.existingTaskId && <> → <code>{task.existingTaskId}</code> {t("（复用）", "(reuse)")}</>}{task.dependsOnLocalIds.length > 0 && <small>{t("需要：", "Requires: ")}{task.dependsOnLocalIds.join(", ")}</small>}</span></label>)}{selectionIssue && <p className={styles.warning}>{selectionIssue}</p>}</div>}
    <details><summary>{t("来源版本与原始证据", "Source revisions and original evidence")}</summary>{candidate.sourceRefs.map(source => { const href = pmEvidenceUrl(source.url); return <p key={source.refId}><code>{source.kind}:{source.id}</code> · <code>{source.revision}</code> · {href ? <a href={href} target="_blank" rel="noreferrer">{source.label || source.id}</a> : source.label}</p>; })}{candidate.evidence.map((evidence, index) => <blockquote key={`${evidence.sourceRefId}:${index}`}><code>{evidence.sourceRefId}</code><p>{evidence.quote}</p></blockquote>)}</details>
    {candidate.reviewSources && <details><summary>{t("您已显式采用的审阅来源版本（原始证据不变）", "Explicitly adopted review source revisions (original evidence unchanged)")}</summary><pre>{JSON.stringify(candidate.reviewSources, null, 2)}</pre></details>}
    <div className={styles.actions}><Button variant="outline" disabled={disabled || stale || !dirty} onClick={() => void save()}>{t("保存候选编辑", "Save candidate edits")}</Button><Button variant="outline" disabled={disabled || stale || !canApply || !!selectionIssue} onClick={() => void send("preview")}>{dirty ? t("读取当前来源（编辑尚未保存）", "Read current sources (edits not saved)") : t("预览实际写入", "Preview actual write")}</Button><Button disabled={disabled || stale || !canApply || dirty || !pmPreviewMatches(preview, draft.candidate, draft.selected)} onClick={() => void send("apply")}>{t("确认应用 / 发布所选", "Confirm apply / publish selected")}</Button><Button variant="ghost" disabled={disabled || stale} onClick={() => void send("ignore")}>{t("忽略", "Ignore")}</Button></div>
    {!canApply && <p>{t("当前仅可编辑/忽略本人审阅候选。预览与实际应用需要此项目的既有能力：备注 intent.propose，其他候选 planning.edit；服务端会再次核验。", "You may edit/ignore your review candidates. Preview and business application require existing project capability: intent.propose for comments, planning.edit for other candidates. The server rechecks authorization.")}</p>}
    {dirty && <p>{t("编辑仅保存在本地恢复草稿。可先读取当前来源解决冲突；应用前必须保存候选并生成匹配的服务器预览。", "Edits are only in the local recovery draft. Read current sources to resolve conflicts if needed; applying requires saving edits and obtaining a matching server preview.")}</p>}
    {preview && <section className={preview.canApply ? styles.preview : styles.warning}>
      <h5>{t("服务器当前版本 / 应用后预览", "Server current version / after preview")}</h5>
      {preview.currentTask && <details open><summary>{t("当前授权任务（不是旧运行快照）", "Current authorized task (not the old run snapshot)")}</summary><pre>{JSON.stringify(preview.currentTask, null, 2)}</pre></details>}
      <pre>{JSON.stringify(preview.candidate, null, 2)}</pre>{preview.conflicts.map((conflict, index) => <p key={index}>{conflict}</p>)}
      <details><summary>{t("当前来源版本（不会静默采用）", "Current source revisions (never silently adopted)")}</summary><pre>{JSON.stringify(preview.currentSources, null, 2)}</pre></details>
      {!preview.canApply && <><p>{t("来源冲突时不会强制写入或重跑。采用版本只更新审阅输入，不改写原始引用或引文；之后仍须保存并重新预览。", "Source conflicts never force a write or rerun. Adopting revisions updates review inputs only, never original references or quotes. Save and preview again afterward.")}</p><Button variant="outline" disabled={disabled || stale} onClick={() => {
        if (!window.confirm(t("已比较当前事实，保留提案并明确采用这些审阅来源版本？原始证据不会被重新标记。", "Have you compared current facts and want to keep the proposal while adopting these review revisions? Original evidence will not be relabeled."))) return;
        try { const rebased = rebasePmCandidate(draft.candidate, preview); persist({ ...draft, candidate: rebased, ...(preview.currentTask ? { reviewTask: preview.currentTask } : {}) }); setPreview(null); setError(""); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      }}>{t("保留提案，显式采用当前审阅版本", "Keep proposal, explicitly adopt current review revisions")}</Button></>}
    </section>}
    {candidate.application && <section className={styles.preview}><strong>{t("已应用的真实对象 ID（服务器持久化）", "Applied real entity IDs (server-persisted)")}</strong><p>{candidate.application.requestId}</p><dl>{Object.entries(candidate.application.idMap).map(([localId, realId]) => <div key={localId}><dt>{localId}</dt><dd><code>{realId}</code></dd></div>)}</dl></section>}
    {receipt && !("canApply" in receipt.result) && <section className={styles.preview}><strong>{t("持久化收据", "Persisted receipt")}</strong><p>{receipt.requestId} · {receipt.result.status}</p><dl>{Object.entries(receipt.result.idMap).map(([localId, realId]) => <div key={localId}><dt>{localId}</dt><dd><code>{realId}</code></dd></div>)}</dl></section>}
    {storageError && <div className={styles.error} role="alert">{storageError}<Button variant="outline" onClick={() => { if (persist(current.current)) setStorageError(""); }}>{t("重试恢复存储", "Retry recovery storage")}</Button></div>}{error && <p className={styles.error} role="alert">{error}</p>}
  </article>;
}
