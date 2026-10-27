import { useId, useState } from "react"
import { Link } from "react-router"
import { ArrowUpRight } from "lucide-react"
import type { AutomationConfig, AutomationEvidence, AutomationRun } from "../../../../../../packages/contracts/src/automation"
import { useText } from "../service/pm-ui"
import { useDisplayDateTime } from "@/features/workspace/preference-format"
import styles from "./history.module.css"

export function conditionLabel(value: AutomationConfig["condition"], t: (zh: string, en: string) => string) {
  return value === "overdue" ? t("逾期未完成", "Overdue tasks") : value === "blocked" ? t("受阻任务", "Blocked tasks") : t("全部未完成", "All open tasks")
}

export function RuleStatus({ value }: { value: "draft" | "enabled" | "paused" }) {
  const t = useText()
  return <span className={`${styles.badge} ${value === "enabled" ? styles.positive : styles.neutral}`}>{value === "enabled" ? t("已启用", "Enabled") : value === "paused" ? t("已暂停", "Paused") : t("草稿", "Draft")}</span>
}

export function RunStatus({ value }: { value: AutomationRun["status"] }) {
  const t = useText()
  return <span className={`${styles.badge} ${value === "failed" ? styles.negative : value === "completed" ? styles.positive : styles.neutral}`}>{value === "completed" ? t("完成", "Completed") : value === "skipped" ? t("已跳过", "Skipped") : t("失败", "Failed")}</span>
}

export function EvidenceList({ items, root }: { items: AutomationEvidence[]; root: string }) {
  const t = useText()
  if (!items.length) return <p className={styles.muted}>{t("无匹配任务", "No matching tasks")}</p>
  return <ul className={styles.evidence}>{items.map(item => <li key={`${item.projectId}:${item.id}`}>
    <div className={styles.evidenceHeading}>
      <Link to={`${root}/projects/${encodeURIComponent(item.projectId)}/entities/${encodeURIComponent(item.id)}`}>{item.title || item.id}<ArrowUpRight size={14} aria-hidden="true" /></Link>
      <span className={styles.badge}>{item.status}</span>
    </div>
    <div className={styles.evidenceMetadata}>
      <code>{item.id}</code><span>/</span><span>{item.projectId}</span>
      <span>/</span><span>{t("版本", "Revision")} <code title={item.revision} aria-label={item.revision}>{item.revision.slice(0, 8)}</code></span>
      {item.due && <><span>/</span><span>{t("截止", "Due")} <time dateTime={item.due}>{item.due}</time></span></>}
    </div>
  </li>)}</ul>
}

export function ConfigSnapshot({ config }: { config: AutomationConfig }) {
  const t = useText()
  return <dl className={styles.metadata}>
    <div><dt>{t("项目", "Project")}</dt><dd>{config.projectId}</dd></div>
    <div><dt>{t("触发", "Trigger")}</dt><dd>{config.trigger.kind === "daily" ? `${t("每日", "Daily")} ${config.trigger.time}` : t("仅手动", "Manual only")}</dd></div>
    <div><dt>{t("时区", "Time zone")}</dt><dd>{config.trigger.timezone}</dd></div>
    <div><dt>{t("条件", "Condition")}</dt><dd>{conditionLabel(config.condition, t)}</dd></div>
    <div><dt>{t("动作", "Action")}</dt><dd>{t("只读任务报告", "Read-only task report")}</dd></div>
    <div><dt>{t("每日运行上限", "Daily run limit")}</dt><dd>{config.dailyLimit}</dd></div>
    <div><dt>{t("冷却", "Cooldown")}</dt><dd>{config.cooldownMinutes} {t("分钟", "min")}</dd></div>
  </dl>
}

function reasonLabel(value: string | null, t: (zh: string, en: string) => string) {
  if (value === "daily_limit") return t("已达到每日运行上限", "Daily run limit reached")
  if (value === "cooldown") return t("仍在冷却时间内", "Cooldown is active")
  if (value === "schedule_missed") return t("已错过计划日期", "Scheduled date missed")
  if (value === "automation_source_unavailable") return t("任务来源不可用", "Task sources unavailable")
  return value
}

export function RunDetails({ run, root, onRule }: { run: AutomationRun; root: string; onRule: (id: string) => void }) {
  const t = useText()
  const display = useDisplayDateTime()
  const id = useId()
  const [pane, setPane] = useState<"result" | "input">("result")
  const reason = reasonLabel(run.reason, t)
  return <article className={styles.detail} aria-label={t("运行详情", "Run details")}>
    <p className={styles.outcome}>
      {run.status === "completed" ? t(`报告完成，匹配 ${run.evidence.length} 条任务`, `Report completed, ${run.evidence.length} matching tasks`) : run.status === "skipped" ? t("本次报告已跳过", "Report skipped") : t("报告失败", "Report failed")}
      {reason && <span className={styles.muted}> / {reason}</span>}
    </p>
    <div className={styles.detailTabs} role="group" aria-label={t("记录内容", "Record content")}>
      <button type="button" aria-pressed={pane === "result"} aria-controls={`${id}-content`} onClick={() => setPane("result")}>{t("结果", "Result")}</button>
      <button type="button" aria-pressed={pane === "input"} aria-controls={`${id}-content`} onClick={() => setPane("input")}>{t("运行配置", "Run configuration")}</button>
    </div>
    <section className={styles.detailPanel} id={`${id}-content`} aria-label={pane === "result" ? t("运行结果", "Run result") : t("运行配置", "Run configuration")}>
      {pane === "result" ? <>
        <h3 className={styles.subheading}>{t("来源任务", "Source tasks")} <span className={styles.count}>{run.evidence.length}</span></h3>
        {run.evidence.length > 0 || run.status === "completed" ? <EvidenceList items={run.evidence} root={root} /> : <p className={styles.muted}>{t("未生成来源记录", "No source records produced")}</p>}
        <details className={styles.disclosure}>
          <summary>{t("原始结果", "Raw result")}</summary>
          <p className={styles.rawResult}>{run.summary || t("无摘要", "No summary")}</p>
          {run.reason && <p className={styles.reason}>{t("原因代码", "Reason code")}: <code>{run.reason}</code></p>}
        </details>
      </> : <>
        <h3 className={styles.snapshotName}>{run.config.name}</h3>
        {run.config.description && <p className={styles.prose}>{run.config.description}</p>}
        <ConfigSnapshot config={run.config} />
      </>}
    </section>
    <details className={styles.disclosure}>
      <summary>{t("运行信息", "Run information")}</summary>
      <dl className={styles.metadata}>
        <div><dt>{t("运行 ID", "Run ID")}</dt><dd><code>{run.id}</code></dd></div>
        <div><dt>{t("原规则版本", "Original rule revision")}</dt><dd><button type="button" className={styles.textButton} onClick={() => onRule(run.ruleId)}>{run.ruleId} / v{run.ruleRevision}</button></dd></div>
        <div><dt>{t("开始", "Started")}</dt><dd><time dateTime={run.startedAt}>{display.date(run.startedAt)} / {display.time(run.startedAt)}</time></dd></div>
        <div><dt>{t("结束", "Finished")}</dt><dd><time dateTime={run.finishedAt}>{display.date(run.finishedAt)} / {display.time(run.finishedAt)}</time></dd></div>
        <div><dt>{t("触发来源", "Trigger source")}</dt><dd>{run.trigger === "scheduled" ? t("后台调度", "Scheduled") : t("手动", "Manual")}</dd></div>
      </dl>
    </details>
  </article>
}
