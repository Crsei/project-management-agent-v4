import { Link } from "react-router"
import type { AgentChatToolComment, AgentChatToolEntity, AgentChatToolRelation, AgentChatToolResult } from "@contracts"
import { MessageContent } from "@/components/blocks/message-content"
import { useText } from "../service/pm-ui"
import styles from "./agent-chat.module.css"

/** Construct only native PM routes from typed identities, never model URLs. */
export function agentObjectHref(root: string, kind: string, id: string, projectId: string | null = null): string {
  if (kind === "project") return `${root}/projects/${encodeURIComponent(id)}`
  return `${root}${kind === "task" && projectId ? `/projects/${encodeURIComponent(projectId)}` : ""}/entities/${encodeURIComponent(id)}`
}

type EntityResultProps = { item: AgentChatToolEntity; root: string; compact?: boolean }

function EntityBody({ item, compact }: { item: AgentChatToolEntity; compact?: boolean }) {
  const t = useText()
  if (compact) return null
  const fields = item.fields
  const values: [string, string | null | undefined][] = !fields ? [] : item.entity === "project"
    ? [[t("目标", "Goal"), fields.goal], [t("开始日期", "Start date"), fields.startDate], [t("截止日期", "Due date"), fields.dueDate]]
    : item.entity === "work_item"
      ? [[t("优先级", "Priority"), fields.priority], [t("负责人", "Assignee"), fields.assigneeId], [t("开始日期", "Start date"), fields.startDate], [t("截止日期", "Due date"), fields.dueDate], [t("标签", "Labels"), fields.labels?.join(", ")]]
      : []
  return <>
    {!!values.length && <dl className={styles.resultFields}>{values.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || t("未设置", "Not set")}</dd></div>)}</dl>}
    {item.body !== undefined && <div className={styles.resultBody}><MessageContent content={item.body} /></div>}
  </>
}

export function ProjectToolResult({ item, root, compact = false }: EntityResultProps) {
  const t = useText()
  return <article className={styles.toolResult} aria-label={t("项目结果", "Project result")}>
    <div className={styles.resultHeading}><span>{t("项目", "Project")}</span><Link to={agentObjectHref(root, "project", item.id)}>{item.title || item.id}</Link><code>{item.id}</code></div>
    <EntityBody item={item} compact={compact} />
  </article>
}

export function TaskToolResult({ item, root, compact = false }: EntityResultProps) {
  const t = useText()
  return <article className={styles.toolResult} aria-label={t("任务结果", "Task result")}>
    <div className={styles.resultHeading}><span>{t("任务", "Task")}</span><Link to={agentObjectHref(root, "task", item.id, item.projectId)}>{item.title || item.id}</Link><code>{item.id}</code></div>
    <EntityBody item={item} compact={compact} />
  </article>
}

export function DocumentToolResult({ item, root, compact = false }: EntityResultProps) {
  const t = useText()
  return <article className={styles.toolResult} aria-label={t("文档结果", "Document result")}>
    <div className={styles.resultHeading}><span>{t("文档", "Document")}</span><Link to={agentObjectHref(root, "document", item.id, item.projectId)}>{item.title || item.id}</Link><code>{item.id}</code></div>
    <EntityBody item={item} compact={compact} />
  </article>
}

export function CommentToolResult({ item, root, compact = false }: { item: AgentChatToolComment; root: string; compact?: boolean }) {
  const t = useText()
  return <article className={styles.toolResult} aria-label={t("评论结果", "Comment result")}>
    <div className={styles.resultHeading}>
      <span>{t("评论", "Comment")}</span>
      <Link to={agentObjectHref(root, "task", item.taskId, item.projectId)}>{t("打开原任务评论", "Open original task comments")} · {item.taskId}</Link>
      {item.deletedAt && <span className={styles.runtimeMuted}>{t("已删除", "Deleted")}</span>}
    </div>
    {!compact && item.content !== null && <div className={styles.resultBody}><MessageContent content={item.content} /></div>}
  </article>
}

export function RelationToolResult({ item, root }: { item: AgentChatToolRelation; root: string }) {
  const t = useText()
  return <article className={styles.toolResult} aria-label={t("关系结果", "Relation result")}>
    <div className={styles.resultHeading}><Link to={agentObjectHref(root, "relation", item.sourceId)}>{item.sourceId}</Link><code>{item.relation}</code><Link to={agentObjectHref(root, "relation", item.targetId)}>{item.targetId}</Link></div>
  </article>
}

export function AgentToolResult({ result, root, compact = false }: { result: AgentChatToolResult; root: string; compact?: boolean }) {
  const t = useText()
  return <>
    {!result.items.length && <p className={styles.runtimeMuted}>{t("本次读取无匹配结果。", "No matching results in this response.")}</p>}
    {result.kind === "comment" ? result.items.map(item => <CommentToolResult key={item.id} item={item} root={root} compact={compact} />)
      : result.kind === "relation" ? result.items.map(item => <RelationToolResult key={`${item.sourceId}:${item.relation}:${item.targetId}`} item={item} root={root} />)
        : result.items.map(item => item.entity === "project" ? <ProjectToolResult key={item.id} item={item} root={root} compact={compact} /> : item.entity === "work_item" ? <TaskToolResult key={item.id} item={item} root={root} compact={compact} /> : <DocumentToolResult key={item.id} item={item} root={root} compact={compact} />)}
    {result.truncated && <p className={styles.runtimeMuted}>{t("仅返回部分结果，不能视为完整项目数据。", "Partial results; this is not the complete project dataset.")}</p>}
    {result.receipt && <details className={styles.technicalDetails}>
      <summary>{t("审计收据", "Audit receipt")}</summary>
      <dl><div><dt>{t("类型 / 动作", "Kind / action")}</dt><dd>{result.receipt.kind} · {result.receipt.action}</dd></div><div><dt>commandId</dt><dd><code>{result.receipt.commandId}</code></dd></div><div><dt>operationId</dt><dd><code>{result.receipt.operationId}</code></dd></div>{result.receipt.targetId && <div><dt>{t("目标", "Target")}</dt><dd><code>{result.receipt.targetId}</code></dd></div>}{result.receipt.revision && <div><dt>{t("版本", "Revision")}</dt><dd><code>{result.receipt.revision}</code></dd></div>}</dl>
    </details>}
  </>
}
