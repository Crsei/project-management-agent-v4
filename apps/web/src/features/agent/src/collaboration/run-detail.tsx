import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { WorkspaceClientError } from "@agent-workspace/client-runtime";
import type { CollaborationRun, RunDetailResponse, RunResponse, RunResultReference } from "@agent-workspace/contracts/collaboration";
import type { ThreadUsageSnapshot } from "@agent-workspace/contracts/usage";
import { Button } from "@/components/ui/button";
import { MessageContent } from "@/components/blocks/message-content";
import { RadixSelect } from "@/components/ui/radix-select";
import { useAgentText } from "../i18n";
import { RunNativeOutput } from "./run-output";
import { runBoardChatHref } from "../pm/run-board-navigation";
import { RunExecutionDock } from "../pm/run-execution-dock";
import { captureCollaborationAuthority, collaborationJson, errorText, safeCollaborationHref, useCollaborationResource, useCollaborationState } from "./data";
import { businessRunStatusLabel, Field, ReadNotice } from "./ui";
import { CapabilityFacts } from "./capabilities";
import { RunInbox } from "./inbox";
import { issueWorkThreadHref, runCancellationTarget, runOutputReferences, runTerminalWorkspaceId, selectedRunOutputReference } from "./model";
import styles from "./collaboration.module.css";

export function RunDetail({ runId, returnTo, onClose, onNavigate }: { runId: string; returnTo: string; onClose: () => void; onNavigate: (id: string) => void }) {
  const t = useAgentText();
  const detail = useCollaborationResource<RunDetailResponse>(`/api/collaboration/runs/${encodeURIComponent(runId)}`);
  const [tab, setTab] = useState("output");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useCollaborationState<string | null>(null, null);
  const [outputGenerationId, setOutputGenerationId] = useCollaborationState("", "");
  const storageKey = `agent-collaboration:cancel:${runId}`;
  const [attempt, setAttempt] = useState<string | null>(() => { try { return sessionStorage.getItem(storageKey); } catch { return null; } });
  const stopping = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const run = detail.data?.run.id === runId ? detail.data.run : undefined;
  const outputReferences = run ? runOutputReferences(run) : [];
  const outputReference = selectedRunOutputReference(outputReferences, outputGenerationId);
  const openOutput = (generationId: string) => { setOutputGenerationId(generationId); setTab("output"); };
  const target = run ? runCancellationTarget(run) : null;
  const cancel = async () => {
    if (!run || !target || detail.error || detail.loading || stopping.current || attempt) return;
    if (!window.confirm(t(`停止此 Run 及其真实子执行？\nRun ${run.id}\nGeneration ${run.generationId ?? "尚未派发"}\n停止需要服务端观察确认，不撤销已发生的副作用。`, `Stop this Run and its real children?\nRun ${run.id}\nGeneration ${run.generationId ?? "not dispatched"}\nStop requires observed confirmation and does not undo side effects.`))) return;
    stopping.current = true; setBusy(true); setError(null);
    const currentAuthority = captureCollaborationAuthority();
    let submitted = false;
    try {
      const current = await collaborationJson<RunDetailResponse>(`/api/collaboration/runs/${encodeURIComponent(runId)}`, { cache: "no-store" });
      if (!alive.current || !currentAuthority()) return;
      const actual = runCancellationTarget(current.run);
      if (!alive.current || !actual || actual.revision !== target.revision || actual.generationId !== target.generationId) throw new Error(t("执行 revision 或 generation 已变化，未发送停止。请重新核对。", "Run revision or generation changed. Stop was not sent; inspect again."));
      const requestId = crypto.randomUUID();
      sessionStorage.setItem(storageKey, requestId); setAttempt(requestId); submitted = true;
      await collaborationJson<RunResponse>(`/api/collaboration/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", body: JSON.stringify({ requestId, ...target }) });
      if (!alive.current || !currentAuthority()) return;
      // Acceptance of cancellation is not an observed terminal stop.
      await detail.refresh();
    } catch (cause) {
      if (!alive.current || !currentAuthority()) return;
      if (submitted && cause instanceof WorkspaceClientError && [400, 404, 409, 422].includes(cause.status)) { sessionStorage.removeItem(storageKey); setAttempt(null); }
      setError(errorText(cause));
    } finally { stopping.current = false; if (alive.current) setBusy(false); }
  };
  const reconcile = async () => {
    if (stopping.current) return;
    stopping.current = true; setBusy(true); setError(null);
    const currentAuthority = captureCollaborationAuthority();
    try {
      const current = await collaborationJson<RunDetailResponse>(`/api/collaboration/runs/${encodeURIComponent(runId)}`, { cache: "no-store" });
      if (!alive.current || !currentAuthority()) return;
      if (current.run.cancellation || ["succeeded", "failed", "cancelled", "interrupted"].includes(current.run.status)) { sessionStorage.removeItem(storageKey); if (alive.current) setAttempt(null); }
      else if (alive.current && attempt) setError(t("原停止结果仍未确认；未再次发送停止。", "The original stop is still unconfirmed; no cancellation was resent."));
      await detail.refresh();
    } catch (cause) { if (alive.current && currentAuthority()) setError(errorText(cause)); }
    finally { stopping.current = false; if (alive.current) setBusy(false); }
  };
  const sessionHref = run?.threadId ? runBoardChatHref({ threadId: run.threadId, returnTo }) : null;
  const terminalWorkspaceId = run ? runTerminalWorkspaceId(run) : null;
  const terminalHref = run?.threadId && terminalWorkspaceId ? runBoardChatHref({ threadId: run.threadId, agentWorkspaceId: terminalWorkspaceId, terminal: true, returnTo }) : null;
  return <RunExecutionDock title={run?.goal ?? t("业务运行", "Business Run")} onClose={onClose}><div className={styles.detail}>
    <ReadNotice resource={detail} />
    {detail.data && !run && <p className={styles.error} role="alert">{t("运行身份不匹配，输出与终端已隐藏。请刷新核对原 Run。", "Run identity does not match. Output and terminal are hidden; refresh to reconcile the original Run.")}</p>}
    {run && <>
      <div className={styles.runStatus}><span className={styles.status}>{businessRunStatusLabel(run.status, t)}</span><span className={styles.hint}>{t("Run 状态 ≠ Issue 完成", "Run status ≠ Issue completion")}</span></div>
      <div className={styles.actions}><Button size="sm" variant="outline" disabled={busy || detail.loading} onClick={() => void reconcile()}>{t("刷新核对", "Refresh / reconcile")}</Button><Button size="sm" variant="outline" disabled={!target || !!detail.error || detail.loading || busy || !!attempt} onClick={() => void cancel()}>{t("停止执行链", "Stop execution chain")}</Button>{sessionHref && !detail.error && <Link to={sessionHref}>{t("打开原 Chat", "Open original Chat")}</Link>}{terminalHref && !detail.error && <Link to={terminalHref}>{t("打开独立终端", "Open separate terminal")}</Link>}</div>
      {run.wait && <div className={styles.notice}><p>{run.wait.reason}</p>{!detail.error && <div className={styles.actions}>{run.wait.blockingRunIds.map(id => <Button key={id} size="sm" variant="ghost" onClick={() => onNavigate(id)}>{t("查看阻塞 Run", "Inspect blocking Run")}</Button>)}<Button size="sm" variant="ghost" onClick={() => setTab("inbox")}>{t("需要处理", "Inbox")}</Button></div>}</div>}
      {run.error && <p className={styles.error} role="alert">{run.error.code}: {run.error.message}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}{attempt && <p className={styles.notice}>{t("停止请求已记录，尚需观察确认；不自动重发。原请求：", "Stop recorded; observed confirmation is still required. No automatic replay. Original request: ")}{attempt}</p>}{run.cancellation && <p className={styles.notice}>{run.cancellation.observedAt ? t("服务端已观察停止结算；已经发生的文件或 PM 修改未回滚。", "Server observed cancellation settlement; existing file and PM effects were not rolled back.") : t("已请求停止，尚未观察整条执行链停止。", "Stop requested; the whole execution chain is not yet observed stopped.")}</p>}
      <div className={styles.detailTabs} role="tablist" aria-label={t("Run 详情视图", "Run detail views")}>{[["output", t("执行输出", "Execution output")], ["overview", t("状态与输入", "Status / input")], ["delegations", t("委派", "Delegations")], ["discussion", t("工作讨论", "Work Thread")], ["evidence", t("证据与操作", "Evidence / operations")], ["usage", t("用量", "Usage")], ["capabilities", t("能力快照", "Capabilities")], ["inbox", t("需要处理", "Inbox")]].map(([id, label]) => <Button size="sm" type="button" role="tab" aria-selected={tab === id} variant={tab === id ? "secondary" : "ghost"} key={id} onClick={() => setTab(id!)}>{label}</Button>)}</div>
      {tab === "overview" && <section className={styles.form}>
        <RunOutcome run={run} readable={!detail.error} onOutput={() => { setOutputGenerationId(""); setTab("output"); }} onNavigate={onNavigate} />
        <dl className={styles.facts}>
          <div><dt>PM target</dt><dd>{run.target.workspaceId} / {run.target.projectId} / {run.target.taskId}</dd></div>
          <div><dt>{t("本次固定的 Issue revision（非当前状态）", "Frozen Issue revision (not its current status)")}</dt><dd>{run.target.taskRevision}</dd></div>
          <div><dt>Agent / Team</dt><dd>{run.teamVersion ? `${run.teamVersion.config.name} v${run.teamVersion.version}` : run.agentVersions.map(version => `${version.config.name} v${version.version}`).join(", ")}</dd></div>
          <div><dt>{t("实际执行目录", "Actual execution directory")}</dt><dd>{run.directoryIdentity?.path ?? t("尚未核验 / 未派发", "Not verified / not dispatched")}</dd></div>
          <div><dt>{t("共享链限额", "Shared chain limits")}</dt><dd>{run.resourceLimits.maxActiveRuns} active · depth {run.resourceLimits.maxDelegationDepth} · {run.resourceLimits.maxRuns} runs</dd></div>
          <div><dt>{t("原受理身份", "Original acceptance")}</dt><dd>{run.requestId}</dd></div>
          <div><dt>Run / revision</dt><dd>{run.id} · r{run.revision}</dd></div>
          <div><dt>Session / generation</dt><dd>{run.threadId ?? "—"} / {run.generationId ?? "—"}</dd></div>
        </dl>
        <div className={styles.actions}>{run.parentRunId && <Button variant="outline" onClick={() => onNavigate(run.parentRunId!)}>{t("查看父 Run", "Inspect parent Run")} · {run.parentRunId}</Button>}{run.rootRunId !== run.id && run.rootRunId !== run.parentRunId && <Button variant="outline" onClick={() => onNavigate(run.rootRunId)}>{t("查看根 Run", "Inspect root Run")} · {run.rootRunId}</Button>}</div>
        {!detail.error && <Link to={issueWorkThreadHref(run.target)}>{t("同一 Issue Work Thread", "Same Issue Work Thread")}</Link>}
        <p className={styles.hint}>{terminalHref ? t("终端是原 Session 已核验目录中的独立 Shell，不是模型输出。只有明确打开才会附加或创建，不更新 generation 或 Issue 状态。", "The terminal is a separate shell in the original Session's verified folder, not model output. It attaches or creates only on explicit open and never updates generation or Issue status.") : t("原 Session 或其已核验目录尚不可用，终端入口已隐藏；不会改用其他目录。请只读核对原 Run。", "The original Session or its verified folder is unavailable. The terminal entry is hidden and no other folder is substituted; reconcile the original Run read-only.")}</p>
        <h3>{t("补充输入", "Additional input")}</h3><pre>{run.input || t("无", "None")}</pre>
        <details><summary>{t("本次读取的完整 Issue 简报与来源", "Issue brief and provenance read for this Run")}</summary>{run.taskBrief ? <pre>{JSON.stringify(run.taskBrief, null, 2)}</pre> : <p>{t("尚未取得完整简报，不伪造输入事实。", "No complete brief recorded; input facts are not invented.")}</p>}</details>
        <details><summary>{t("固定 Agent / Team 配置快照", "Frozen Agent / Team configuration")}</summary><pre>{JSON.stringify({ agentVersions: run.agentVersions, teamVersion: run.teamVersion, executionEnvironment: run.executionEnvironment }, null, 2)}</pre></details>
      </section>}
      {tab === "delegations" && <section className={styles.form}><p className={styles.hint}>{t("委派由真实宿主工具受理；ask_agent 返回异步身份，不是伪同步结论。", "Delegation is accepted by real host tools. ask_agent returns an asynchronous identity, not a fabricated synchronous answer.")}</p>{detail.data?.delegations.length === 0 && <p>{t("没有委派调用记录。", "No delegation calls recorded.")}</p>}{detail.data?.delegations.map(row => <article className={styles.row} key={row.id}><strong>{row.kind} · {row.status}</strong><p>{row.goal}</p><small>Agent {row.agentId} · v{row.agentVersion} · call {row.originalCallId}</small><small>{!row.childRunId ? t("调用已拒绝，未创建子执行", "Call rejected; no child execution created") : row.required ? t("必须结算的子执行", "Required child execution") : t("咨询执行", "Consultation")} · {row.responsePublishedAt ?? t("答复尚未发布", "Response not yet published")}</small><pre>{row.input}</pre>{row.resultRefs.map((result, index) => <div key={index}><RunResultSummary result={result} /><code>{result.generationId}</code></div>)}{row.error && <p role="alert">{row.error.code}: {row.error.message}</p>}{row.childRunId && <Button variant="outline" onClick={() => onNavigate(row.childRunId!)}>{t("查看真实子 Run", "Inspect real child Run")}</Button>}</article>)}</section>}
      {tab === "discussion" && !detail.error && <section className={styles.form}><h3>{t("Issue 同一工作讨论", "Same Issue Work Thread")}</h3><p className={styles.hint}>{t("以下是原 PM 评论投影；不公开完整私有 Session。人类 authorId 与可信 Agent 来源分别保留。", "This is the original PM comment projection, not a public copy of the private Session. Human authorId and trusted Agent origin remain distinct.")}</p>{detail.data?.discussion ? <>{detail.data.discussion.items.map(comment => <article className={styles.row} key={comment.id}><strong>{comment.origin ? `Agent ${comment.origin.agentId} · v${comment.origin.agentVersion}` : t("人类评论", "Human comment")}</strong><small>{t("实际作者：", "Actual author: ")}<Link to={`/pm/${encodeURIComponent(run.target.workspaceId)}/members?person=${encodeURIComponent(comment.authorId)}`}>{comment.authorId}</Link> · v{comment.version} · {comment.createdAt}</small>{comment.origin && <Button size="sm" variant="ghost" onClick={() => onNavigate(comment.origin!.runId)}>Run {comment.origin.runId}{comment.origin.delegationId ? ` · delegation ${comment.origin.delegationId}` : ""}</Button>}{comment.deletedAt ? <p>{t("评论已隐藏，原历史仍保留。", "Comment hidden; original history retained.")}</p> : <MessageContent content={comment.content ?? ""} />}</article>)}{!detail.data.discussion.items.length && <p>{t("暂无评论。", "No comments.")}</p>}{detail.data.discussion.nextCursor && <p>{t("还有更多原评论；原入口支持完整历史。", "More original comments exist; open the original thread for full history.")}</p>}</> : <p>{t("讨论投影暂不可用，不表示没有讨论。", "Discussion projection unavailable; this does not mean there is no discussion.")}</p>}<Link to={issueWorkThreadHref(run.target)}>{t("在同一原讨论中发言、编辑或查看完整历史", "Post, edit or inspect full history in the same original thread")}</Link></section>}
      {tab === "output" && !detail.error && <section className={styles.form}>
        <p className={styles.hint}>{t("原生输出 · 只读；不是独立终端。默认读取本 Run 的最新 generation，子执行保留各自原引用。", "Native output · read-only, not a separate terminal. Defaults to this Run's latest generation; child executions retain their original references.")}</p>
        {outputReferences.length > 1 && <Field label={t("原 generation 输出引用", "Original generation output reference")}><RadixSelect value={outputReference?.generationId ?? outputGenerationId} onChange={event => setOutputGenerationId(event.target.value)}>{outputGenerationId && !outputReference && <option value={outputGenerationId} disabled>{t("原引用当前不可用：", "Original reference unavailable: ")}{outputGenerationId}</option>}{outputReferences.map(result => <option key={result.generationId} value={result.generationId}>{result.generationId} · Session {result.threadId}</option>)}</RadixSelect></Field>}
        {outputReference ? <RunNativeOutput key={outputReference.generationId} runId={run.id} threadId={outputReference.threadId} generationId={outputReference.generationId} /> : <p>{outputGenerationId ? t("所选原输出引用当前不可用，未改用其他 generation。请只读刷新核对，或明确选择当前引用。", "The selected original output reference is unavailable; no other generation was substituted. Refresh read-only, or explicitly choose a current reference.") : t("Run 尚未提供可读取的 generation 输出引用；不据此推断未执行。", "The Run has not provided a readable generation output reference; this does not prove no execution occurred.")}</p>}
        {outputGenerationId && !outputReference && outputReferences.length > 0 && <Button variant="outline" onClick={() => setOutputGenerationId("")}>{t("明确选择本 Run 当前输出", "Explicitly select this Run's current output")}</Button>}
      </section>}
      {tab === "evidence" && <section className={styles.form}><h3>{t("原操作身份与真实结果引用", "Original operations and result references")}</h3>{run.operationRefs.map(operation => <article key={operation.operationId} className={styles.row}><strong>{operation.kind} · {operation.status}</strong><code>{operation.operationId}</code>{operation.commandId && <code>PM command: {operation.commandId}</code>}{operation.status === "unknown" && <p>{t("只核对原操作，不重放未知写入。", "Reconcile this original operation; never replay unknown writes.")}</p>}</article>)}{run.resultRefs.map((result, index) => <article key={index} className={styles.row}><strong>{t("有来源的执行输出（不是任务完成）", "Sourced execution output (not task completion)")}</strong><RunResultSummary result={result} /><small>{result.generationId}</small>{!detail.error && <Button type="button" variant="outline" onClick={() => openOutput(result.generationId)}>{t("读取 Run 保留输出", "Read Run-retained output")}</Button>}</article>)}{detail.data?.evidence?.map((evidence, index) => { const href = !detail.error ? safeCollaborationHref(evidence.href) : null; return <article className={styles.row} key={index}><strong>{evidence.kind}</strong><code>{evidence.id}</code>{evidence.kind === "native_output" && evidence.generationId && !detail.error ? <Button type="button" variant="outline" onClick={() => openOutput(evidence.generationId!)}>{t("读取原 Run 输出证据", "Read original Run output evidence")}</Button> : href && <Link to={href}>{t("查看来源证据", "Inspect source evidence")}</Link>}</article>; })}{!run.operationRefs.length && !run.resultRefs.length && !detail.data?.evidence?.length && <p>{t("尚无来源证据。不从模型文字推断测试通过。", "No source evidence yet. Model text never proves tests passed.")}</p>}</section>}
      {tab === "usage" && !detail.error && <section className={styles.form}><p className={styles.hint}>{t("逐 Session/generation 真实用量，不把缺失成本记零，不把 Team 成员数当进度。", "Actual Session/generation usage. Missing cost is not zero; member count is not progress.")}</p>{[...new Set([run.threadId, ...run.resultRefs.map(result => result.threadId), ...(detail.data?.delegations.flatMap(row => row.resultRefs.map(result => result.threadId)) ?? [])].filter((id): id is string => !!id))].map(threadId => <RunUsage key={threadId} threadId={threadId} />)}{!run.threadId && !run.resultRefs.length && <p>{t("根 Run 尚无 Session 用量；子执行用量按实际引用分别展示。", "The root Run has no Session usage; child usage appears only from actual references.")}</p>}</section>}
      {tab === "capabilities" && <section className={styles.form}>{run.capabilityManifests.length ? run.capabilityManifests.map((manifest, index) => <CapabilityFacts key={index} manifest={manifest} />) : <p>{t("尚未记录能力快照。", "No capability snapshot recorded.")}</p>}</section>}
      {tab === "inbox" && !detail.error && <RunInbox workspaceId={run.target.workspaceId} projectId={run.target.projectId} runId={run.id} />}
    </>}
  </div></RunExecutionDock>;
}
function RunOutcome({ run, readable, onOutput, onNavigate }: { run: CollaborationRun; readable: boolean; onOutput: () => void; onNavigate: (id: string) => void }) {
  const t = useAgentText();
  const guidance = (() => {
    switch (run.status) {
      case "queued": return t("执行已受理并排队，尚未处于执行中；查看实际等待原因，不要重复提交。", "Execution was accepted and is queued, not currently executing. Inspect any recorded wait reason; do not submit again.");
      case "running": return t("业务 Run 正在执行；可查看原输出或打开原 Session。离开页面不会停止执行。", "The business Run is executing. Read its original output or open its original Session. Leaving does not stop execution.");
      case "waiting": return t("执行链正在等待，并不代表失败或完成。请根据下方原等待原因查看阻塞 Run 或当前 Inbox；不要重复派发。", "The execution chain is waiting, not failed or complete. Use the recorded wait reason below to inspect blocking Runs or the current Inbox; do not dispatch again.");
      case "succeeded": return t("服务端将此业务 Run 结算为成功。请阅读有来源的结果、子执行与操作记录；是否完成 Issue 仍由 PM 的真实任务状态决定。", "The server settled this business Run as succeeded. Read its sourced results, child executions and operation records; Issue completion remains a separate PM task fact.");
      case "failed": return t("服务端记录此 Run 失败；可能保留部分输出或已经发生副作用。请查看原错误、委派和操作记录，不自动重跑。", "The server recorded a failed Run. Partial output or side effects may remain. Inspect its original error, delegations and operations; no automatic rerun.");
      case "cancelled": return t("此 Run 已结算为取消，不表示已回滚文件或 PM 修改。请查看原输出与停止观察记录。", "This Run settled as cancelled, not as a rollback of file or PM changes. Inspect its original output and observed cancellation record.");
      case "interrupted": return t("执行已中断，不能据此推断成功、未执行或没有副作用。请只读核对原 Session、输出与操作身份；不自动恢复或重放。", "Execution was interrupted. This proves neither success nor absence of execution or side effects. Reconcile the original Session, output and operation identities read-only; no automatic resume or replay.");
      case "unknown": return t("原执行或操作的结果尚未确定，不是成功、空闲或没有执行。请只读核对原结果引用与操作身份；不要重新发送未知写入。", "The original execution or operation outcome is unresolved, not successful, idle or absent. Reconcile its original result references and operation identities read-only; never resend unknown writes.");
    }
  })();
  const result = run.resultRefs.find(reference => reference.generationId === run.generationId && reference.threadId === run.threadId);
  return <section className={styles.panel} aria-label={t("执行状态与结果", "Execution status and result")}>
    <p>{guidance}</p>
    <dl className={styles.facts}>
      <div><dt>{t("实际开始时间", "Recorded start")}</dt><dd>{run.startedAt ?? t("未记录开始；不推断未执行", "No start recorded; execution is not ruled out")}</dd></div>
      <div><dt>{t("实际结算时间", "Recorded settlement")}</dt><dd>{run.finishedAt ?? t("未记录结算时间", "No settlement timestamp recorded")}</dd></div>
      <div><dt>{t("原结果引用", "Original result references")}</dt><dd>{run.resultRefs.length}</dd></div>
    </dl>
    {run.wait && <div className={styles.notice}><strong>{run.wait.kind}</strong><p>{run.wait.reason}</p><small>{t("从以下时间等待：", "Waiting since: ")}{run.wait.since}</small><div className={styles.actions}>{run.wait.blockingRunIds.map(id => <Button key={id} variant="outline" size="sm" onClick={() => onNavigate(id)}>{t("查看阻塞 Run", "Inspect blocking Run")} · {id}</Button>)}</div></div>}
    {run.error && <p className={styles.error} role="alert">{run.error.code}: {run.error.message}</p>}
    {result && readable && <><h3>{t("本 Run 最新 generation 的有来源摘要", "Sourced summary of this Run's latest generation")}</h3><RunResultSummary result={result} /></>}
    {!run.resultRefs.length && <p className={styles.hint}>{t("尚无保留的结果引用；不代表没有执行或没有输出。", "No retained result reference yet; this does not mean execution or output is absent.")}</p>}
    <div className={styles.actions}><Button variant="outline" disabled={!readable || (!run.generationId && !run.resultRefs.length)} onClick={onOutput}>{t("查看原状态与输出", "Inspect original status and output")}</Button>{run.wait && readable && <Link to={`/agent/inbox?${new URLSearchParams({ workspaceId: run.target.workspaceId, projectId: run.target.projectId, runId: run.id })}`}>{t("查看当前待处理项", "Inspect current Inbox")}</Link>}</div>
  </section>;
}
function RunResultSummary({ result }: { result: RunResultReference }) {
  const t = useAgentText();
  if (result.visibility === "redacted" || result.visibility === "unavailable") return <p role="status" data-visibility={result.visibility}>{result.visibility === "redacted" ? t("结果摘要当前不可访问；执行与原结果引用仍存在。", "The result summary is currently inaccessible; execution and its original result reference still exist.") : t("结果摘要的当前权限暂不可核验；不表示没有结果或未执行。", "Current access to the result summary cannot be verified; this does not mean no result or execution exists.")}</p>;
  return <><p>{result.summary ?? t("服务端未提供有来源的摘要；不据此推断未执行。", "The server provided no sourced summary; this is not evidence of no execution.")}</p>{result.summarySource && <small>{result.summarySource}</small>}</>;
}
function RunUsage({ threadId }: { threadId: string }) {
  const t = useAgentText();
  const usage = useCollaborationResource<ThreadUsageSnapshot>(`/api/usage/threads/${encodeURIComponent(threadId)}`);
  return <article className={styles.row}><strong>Session {threadId}</strong><ReadNotice resource={usage} />{usage.data && <><p>{t("费用：", "Cost: ")}{usage.data.costUsd === undefined ? t("未知 / 未计价", "Unknown / unpriced") : `USD ${usage.data.costUsd}`}</p><pre>{JSON.stringify(usage.data, null, 2)}</pre></>}</article>;
}
