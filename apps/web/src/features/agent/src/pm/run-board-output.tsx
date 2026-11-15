import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import type { NativeOutputItem } from "@agent-workspace/contracts/output"
import { useGenerationOutput } from "../chat/output-stream"
import { useAgentText } from "../i18n"
import type { RunBoardHistory } from "./run-board-data"
import styles from "./run-board-page.module.css"

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}


function NativeItem({ item, sessionHref }: { item: NativeOutputItem; sessionHref: string }) {
  const t = useAgentText()
  if (item.visibility === "redacted" || item.visibility === "unavailable") return <li className={styles.outputItem} data-visibility={item.visibility}>
    <p role="status">{item.visibility === "redacted" ? t("此项内容已不可访问。", "This item's content is no longer accessible.") : t("暂时无法核验此项内容的访问权限。", "Access to this item's content cannot be verified right now.")}</p>
  </li>
  // Provider error strings can contain request payloads; the board never renders them.
  if (item.type === "error") return <li className={styles.outputItem}><p role="status">{t("Provider 报告了错误。请在完整 Chat 中核对。", "The provider reported an error. Review it in the full Chat.")}</p><Link to={sessionHref}>{t("打开 Chat", "Open Chat")}</Link></li>
  const types: Record<NativeOutputItem["type"], string> = {
    assistant_message: t("回复", "Reply"), reasoning: t("思考", "Thinking"), command_execution: t("命令", "Command"), file_change: t("文件变更", "File change"), file_search: t("文件搜索", "File search"), web_search: t("网页搜索", "Web search"), dynamic_tool: t("工具", "Tool"), todo_list: t("待办", "To-do"), proposed_plan: t("计划", "Plan"), subagent: t("子代理", "Subagent"), approval_request: t("审批", "Approval"), user_input_request: t("需要回答", "Input needed"), notification: t("通知", "Notification"), error: t("错误", "Error"), compaction: t("上下文压缩", "Compaction"),
  }
  const statuses: Record<NativeOutputItem["status"], string> = {
    pending: t("待处理", "Pending"), running: t("进行中", "Running"), waiting: t("等待中", "Waiting"), completed: t("此项已结束", "Item ended"), failed: t("失败", "Failed"), cancelled: t("已取消", "Cancelled"), interrupted: t("已中断", "Interrupted"), unknown: t("待核对", "Needs reconciliation"),
  }
  const interaction = item.type === "approval_request" || item.type === "user_input_request"
  const hasPreview = item.text || item.output || item.diff || item.changes?.length || item.steps?.length || item.results?.length
  return <li className={styles.outputItem}>
    <header><strong>{types[item.type]}</strong><span>{statuses[item.status]}</span></header>
    {item.title && <p>{item.title}</p>}
    {item.text && <pre>{item.text}</pre>}
    {item.output && item.output !== item.text && <pre>{item.output}</pre>}
    {item.diff && <pre>{item.diff}</pre>}
    {item.changes?.map((change, index) => <div key={`${change.path}:${index}`}><p>{change.path}</p>{change.diff && <pre>{change.diff}</pre>}</div>)}
    {item.steps?.map(step => <p key={step.id}>{step.text}</p>)}
    {item.results?.map((result, index) => <div key={index}><p>{result.title || result.path || result.url}</p>{result.text && <pre>{result.text}</pre>}</div>)}
    {interaction ? <p>{t("此处只读；历史记录不代表请求仍待处理。请在原 Chat 核对当前审批或输入状态。", "Read-only history does not mean this request is still pending. Check its current approval or input state in the original Chat.")} <Link to={sessionHref}>{t("打开原 Chat", "Open original Chat")}</Link></p> : !hasPreview && <p>{t("此项没有可展示的文本片段；完整详情请打开 Chat。", "No text excerpt is available for this item; open Chat for full details.")}</p>}
    {item.outputTruncated && <p>{t("仅显示服务端保留的输出片段。", "Only the server-retained output excerpt is shown.")}</p>}
    {item.error && <p>{t("此项报告了错误；请在 Chat 中核对。", "This item reported an error; review it in Chat.")}</p>}
  </li>
}

function NativeSubscription({ generationId, threadId, sessionHref, onUnavailable }: { generationId: string; threadId: string; sessionHref: string; onUnavailable: () => void }) {
  const t = useAgentText()
  const { snapshot, error } = useGenerationOutput(generationId)
  const matches = snapshot?.generationId === generationId && snapshot.threadId === threadId
  useEffect(() => { if (error || (snapshot && !matches)) onUnavailable() }, [error, snapshot, matches, onUnavailable])
  if (error || (snapshot && !matches)) return null
  if (!snapshot) return <p role="status">{t("正在读取原生输出…", "Reading native output…")}</p>
  return snapshot.items.length ? <ol className={styles.outputItems}>{snapshot.items.map(item => <NativeItem key={item.id} item={item} sessionHref={sessionHref} />)}</ol> : <p role="status">{t("服务端尚未提供原生输出项。", "The server has not provided any native output items yet.")}</p>
}

/** Unmount on the first failure: unsupported/forbidden output must not retry forever. */
export function RunBoardNativeOutput({ generationId, threadId, sessionHref, onUnavailable }: { generationId: string; threadId: string; sessionHref: string; onUnavailable: () => void }) {
  const t = useAgentText()
  const [unavailable, setUnavailable] = useState(false)
  return unavailable ? <p role="status">{t("原生输出暂不可用或当前会话不支持此输出源。未显示任何错误载荷；可刷新详情核对或打开完整 Chat。", "Native output is unavailable or this session does not support this source. No error payload is displayed; refresh details to check again or open the full Chat.")}</p> : <NativeSubscription generationId={generationId} threadId={threadId} sessionHref={sessionHref} onUnavailable={() => { setUnavailable(true); onUnavailable() }} />
}


export function RunBoardHistoryOutput({ history }: { history: RunBoardHistory }) {
  const t = useAgentText()
  const messages = new Map(history.messages.map(message => [message.id, message]))
  const branch: RunBoardHistory["messages"] = []
  const seen = new Set<string>()
  let id = history.headId
  while (id && !seen.has(id)) {
    seen.add(id)
    const message = messages.get(id)
    if (!message) break
    branch.push(message)
    id = message.parent_id
  }
  const visible = branch.reverse().filter(message => message.content.role === "user" || message.content.role === "assistant")
  if (!visible.length) return <p role="status">{t("当前会话分支尚无已保存的消息。正在生成的输出不一定已写入历史。", "This session branch has no saved messages yet. In-progress output may not have been saved to history.")}</p>
  return <ol className={styles.outputItems}>{visible.map(message => {
    const visibility = record(message.content.metadata)?.pmVisibility
    if (visibility === "redacted" || visibility === "unavailable") return <li key={message.id} className={styles.outputItem} data-visibility={visibility}><p>{visibility === "redacted" ? t("消息内容已不可访问。", "Message content is no longer accessible.") : t("暂时无法核验消息内容的访问权限。", "Access to this message cannot be verified right now.")}</p></li>
    const text = message.content.parts.filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text as string).join("\n")
    return <li key={message.id} className={styles.outputItem}><header><strong>{message.content.role === "assistant" ? t("Agent 回复", "Agent reply") : t("用户消息", "User message")}</strong></header>{text ? <pre>{text}</pre> : <p>{t("此消息没有文本内容；附件、工具和交互详情请在 Chat 查看。", "This message has no text content; view attachments, tools and interactions in Chat.")}</p>}</li>
  })}</ol>
}
