import type { AgentOutputSnapshot, GenerationOutputStatus, NativeOutputItem } from "@agent-workspace/contracts/output";
import { useAgentText, type AgentText } from "../i18n";
import { useCollaborationResource } from "./data";
import { ReadNotice } from "./ui";
import styles from "./collaboration.module.css";

/** Read the Run's retained evidence, never a private Session or its live Chat subscription. */
export function RunNativeOutput({ runId, generationId, threadId }: { runId: string; generationId: string; threadId: string }) {
  const t = useAgentText();
  const output = useCollaborationResource<AgentOutputSnapshot>(`/api/collaboration/runs/${encodeURIComponent(runId)}/generations/${encodeURIComponent(generationId)}/output`);
  const snapshot = output.data;
  const matches = snapshot?.generationId === generationId && snapshot.threadId === threadId;
  return <section className={`${styles.form} ${styles.nativeOutput}`}>
    <ReadNotice resource={output} />
    {snapshot && !matches && <p className={styles.error} role="alert">{t("输出引用不匹配，未展示内容。请只读核对原 Run。", "Output identity does not match; content was not displayed. Reconcile the original Run read-only.")}</p>}
    {output.error && <p role="status">{t("当前无法核验这份原输出，已隐藏保留正文；请重新读取。不能由读取失败推断未执行或执行失败。", "This original output cannot currently be verified, so retained content is hidden; refresh to read again. A read failure proves neither absent execution nor failed execution.")}</p>}
    {snapshot && matches && !output.error && <><p className={styles.outputStatus}><span className={styles.status}>{snapshot.status}</span><span>{t("所选 generation · 当前权限下的保留输出", "Selected generation · retained output under current access")}</span></p>{snapshot.items.length ? <ol className={styles.list}>{snapshot.items.map(item => <RunOutputItem key={item.id} item={item} />)}</ol> : <p role="status">{t("服务端尚未提供可展示的输出项；不据此推断未执行。", "The server has not provided displayable output items; this is not evidence of no execution.")}</p>}<details><summary>{t("原输出引用与状态说明", "Original output reference and status")}</summary><p>{generationStatusGuidance(snapshot.status, t)}</p><small>Session {snapshot.threadId} · generation {snapshot.generationId}</small><p>{t("按原 Run / Session / generation 读取，不创建会话、重绑目录或重放执行。generation 状态不代表整条业务执行链结算或 Issue 完成。", "Read by original Run / Session / generation, without creating a Session, rebinding a folder or replaying execution. Generation status is not business-chain settlement or Issue completion.")}</p></details></>}
  </section>;
}

function generationStatusGuidance(status: GenerationOutputStatus, t: AgentText): string {
  switch (status) {
    case "queued": return t("此 generation 已排队；尚未报告正在执行。", "This generation is queued; it has not reported executing.");
    case "running": return t("此 generation 正在执行。业务 Run 可能还包含后续轮次、子执行或 PM 操作。", "This generation is executing. The business Run may also include later turns, child executions or PM operations.");
    case "completed": return t("此 generation 已成功结束。仍需分别核对业务 Run 的整链结算、结果证据和 PM Issue 状态。", "This generation ended successfully. Business-chain settlement, result evidence and the PM Issue state must still be inspected separately.");
    case "failed": return t("此 generation 已失败；原输出可能不完整，已经发生的操作不因此回滚。", "This generation failed. Its output may be partial; existing operations are not thereby rolled back.");
    case "cancelled": return t("此 generation 已取消；不代表所有子执行已停止或已有副作用已撤销。", "This generation was cancelled. It does not prove all child executions stopped or existing side effects were undone.");
    case "interrupted": return t("此 generation 已中断；请核对原输出与操作记录，不将中断解释为成功或未执行。", "This generation was interrupted. Inspect its original output and operations; interruption means neither success nor absent execution.");
  }
}

function RunOutputItem({ item }: { item: NativeOutputItem }) {
  const t = useAgentText();
  if (item.visibility === "redacted" || item.visibility === "unavailable") return <li className={styles.row} data-visibility={item.visibility} role="status">{item.visibility === "redacted" ? t("此项输出已不可访问；执行记录仍存在。", "This output item is no longer accessible; its execution record still exists.") : t("此项输出的当前权限暂不可核验；不表示没有输出或未执行。", "Current access to this output item cannot be verified; this does not mean output or execution is absent.")}</li>;
  // Keep provider error payloads out of the board, as in the existing Session output view.
  if (item.type === "error") return <li className={styles.row} role="status">{t("Provider 报告了错误；此处不展示可能包含请求载荷的错误正文。", "The provider reported an error; potentially sensitive request payloads in error text are not displayed here.")}</li>;
  const labels: Record<NativeOutputItem["type"], string> = {
    assistant_message: t("回复", "Reply"), reasoning: t("思考", "Thinking"), command_execution: t("命令", "Command"), file_change: t("文件变更", "File change"), file_search: t("文件搜索", "File search"), web_search: t("网页搜索", "Web search"), dynamic_tool: t("工具", "Tool"), todo_list: t("待办", "To-do"), proposed_plan: t("计划", "Plan"), subagent: t("子代理", "Subagent"), approval_request: t("审批", "Approval"), user_input_request: t("需要回答", "Input needed"), notification: t("通知", "Notification"), error: t("错误", "Error"), compaction: t("上下文压缩", "Compaction"),
  };
  const interaction = item.type === "approval_request" || item.type === "user_input_request";
  const hasText = item.text || item.output || item.diff || item.changes?.length || item.steps?.length || item.results?.length;
  return <li className={styles.row}>
    <header><strong>{labels[item.type]}</strong> · {item.status}{item.exitCode !== undefined && <span> · exit {item.exitCode}</span>}</header>
    {item.title && <p>{item.title}</p>}
    {item.text && <pre>{item.text}</pre>}
    {item.output && item.output !== item.text && <pre>{item.output}</pre>}
    {item.diff && <pre>{item.diff}</pre>}
    {item.changes?.map((change, index) => <div key={`${change.path}:${index}`}><p>{change.operation} · {change.path}</p>{change.diff && <pre>{change.diff}</pre>}</div>)}
    {item.steps?.map(step => <p key={step.id}>{step.status} · {step.text}</p>)}
    {item.results?.map((result, index) => <div key={index}><p>{result.title || result.path || result.url}</p>{result.text && <pre>{result.text}</pre>}</div>)}
    {interaction ? <p>{t("保留输出只读，不将历史卡片当作可响应请求。需要处理时请从当前 Inbox 进入原实时请求。", "Retained output is read-only; historical cards are not live requests. Use the current Inbox to reach an original live request.")}</p> : !hasText && <p>{t("此项没有服务端提供的文本片段。", "The server provided no text excerpt for this item.")}</p>}
    {item.outputTruncated && <p>{t("仅显示服务端保留的输出片段。", "Only the server-retained output excerpt is shown.")}</p>}
    {item.error && <p>{t("此项报告了错误；错误载荷未展示。", "This item reported an error; its error payload is not displayed.")}</p>}
  </li>;
}
