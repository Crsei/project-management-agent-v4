import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import type { AutomationConfig, AutomationEvidence, AutomationRun } from "../../../../../packages/contracts/src/automation";
import { automationDateTime } from "./format";
import styles from "./history.module.css";

export function conditionLabel(value: AutomationConfig["condition"]) {
  return value === "overdue" ? "逾期未完成" : value === "blocked" ? "受阻任务" : "全部未完成";
}

export function RuleStatus({ value }: { value: "draft" | "enabled" | "paused" }) {
  return <span className={`${styles.badge} ${value === "enabled" ? styles.positive : styles.neutral}`}>{value === "enabled" ? "已启用" : value === "paused" ? "已暂停" : "草稿"}</span>;
}

export function RunStatus({ value }: { value: AutomationRun["status"] }) {
  return <span className={`${styles.badge} ${value === "failed" ? styles.negative : value === "completed" ? styles.positive : styles.neutral}`}>{value === "completed" ? "完成" : value === "skipped" ? "已跳过" : "失败"}</span>;
}

export function EvidenceList({ items, root }: { items: AutomationEvidence[]; root: string }) {
  if (!items.length) return <p className={styles.muted}>无匹配任务</p>;
  return <ul className={styles.evidence}>{items.map(item => <li key={`${item.projectId}:${item.id}`}>
    <div className={styles.evidenceHeading}>
      <Link to={`${root}/projects/${encodeURIComponent(item.projectId)}/entities/${encodeURIComponent(item.id)}`}>{item.title || item.id}<ArrowUpRight size={14} aria-hidden="true" /></Link>
      <span className={styles.badge}>{item.status}</span>
    </div>
    <div className={styles.evidenceMetadata}>
      <code>{item.id}</code><span>/</span><span>{item.projectId}</span>
      <span>/</span><span>版本 <code title={item.revision} aria-label={item.revision}>{item.revision.slice(0, 8)}</code></span>
      {item.due && <><span>/</span><span>截止 <time dateTime={item.due}>{item.due}</time></span></>}
    </div>
  </li>)}</ul>;
}

export function ConfigSnapshot({ config }: { config: AutomationConfig }) {
  return <dl className={styles.metadata}>
    <div><dt>项目</dt><dd>{config.projectId}</dd></div>
    <div><dt>触发</dt><dd>{config.trigger.kind === "daily" ? `每日 ${config.trigger.time}` : "仅手动"}</dd></div>
    <div><dt>时区</dt><dd>{config.trigger.timezone}</dd></div>
    <div><dt>条件</dt><dd>{conditionLabel(config.condition)}</dd></div>
    <div><dt>动作</dt><dd>只读任务报告</dd></div>
    <div><dt>每日运行上限</dt><dd>{config.dailyLimit}</dd></div>
    <div><dt>冷却</dt><dd>{config.cooldownMinutes} 分钟</dd></div>
  </dl>;
}

function reasonLabel(value: string | null) {
  if (value === "daily_limit") return "已达到每日运行上限";
  if (value === "cooldown") return "仍在冷却时间内";
  if (value === "schedule_missed") return "已错过计划日期";
  if (value === "automation_source_unavailable") return "任务来源不可用";
  return value;
}

export function RunDetails({ run, root, onRule }: { run: AutomationRun; root: string; onRule: (id: string) => void }) {
  const id = useId();
  const [pane, setPane] = useState<"result" | "input">("result");
  const reason = reasonLabel(run.reason);
  return <article className={styles.detail} aria-label="运行详情">
    <p className={styles.outcome}>
      {run.status === "completed" ? `报告完成，匹配 ${run.evidence.length} 条任务` : run.status === "skipped" ? "本次报告已跳过" : "报告失败"}
      {reason && <span className={styles.muted}> / {reason}</span>}
    </p>
    <div className={styles.detailTabs} role="group" aria-label="记录内容">
      <button type="button" aria-pressed={pane === "result"} aria-controls={`${id}-content`} onClick={() => setPane("result")}>结果</button>
      <button type="button" aria-pressed={pane === "input"} aria-controls={`${id}-content`} onClick={() => setPane("input")}>运行配置</button>
    </div>
    <section className={styles.detailPanel} id={`${id}-content`} aria-label={pane === "result" ? "运行结果" : "运行配置"}>
      {pane === "result" ? <>
        <h3 className={styles.subheading}>来源任务 <span className={styles.count}>{run.evidence.length}</span></h3>
        {run.evidence.length > 0 || run.status === "completed" ? <EvidenceList items={run.evidence} root={root} /> : <p className={styles.muted}>未生成来源记录</p>}
        <details className={styles.disclosure}>
          <summary>原始结果</summary>
          <p className={styles.rawResult}>{run.summary || "无摘要"}</p>
          {run.reason && <p className={styles.reason}>原因代码: <code>{run.reason}</code></p>}
        </details>
      </> : <>
        <h3 className={styles.snapshotName}>{run.config.name}</h3>
        {run.config.description && <p className={styles.prose}>{run.config.description}</p>}
        <ConfigSnapshot config={run.config} />
      </>}
    </section>
    <details className={styles.disclosure}>
      <summary>运行信息</summary>
      <dl className={styles.metadata}>
        <div><dt>运行 ID</dt><dd><code>{run.id}</code></dd></div>
        <div><dt>原规则版本</dt><dd><button type="button" className={styles.textButton} onClick={() => onRule(run.ruleId)}>{run.ruleId} / v{run.ruleRevision}</button></dd></div>
        <div><dt>开始</dt><dd><time dateTime={run.startedAt}>{automationDateTime(run.startedAt)}</time></dd></div>
        <div><dt>结束</dt><dd><time dateTime={run.finishedAt}>{automationDateTime(run.finishedAt)}</time></dd></div>
        <div><dt>触发来源</dt><dd>{run.trigger === "scheduled" ? "后台调度" : "手动"}</dd></div>
      </dl>
    </details>
  </article>;
}
