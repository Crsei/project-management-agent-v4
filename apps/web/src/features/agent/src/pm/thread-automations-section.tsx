import { useEffect, useId, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ZapIcon } from "lucide-react";
import { StudioClient } from "../../../../../../../packages/contracts/src/automation-studio-client";
import type { StudioExecution } from "../../../../../../../packages/contracts/src/automation-studio";
import styles from "./thread-details-sections.module.css";
import { useAgentText, type AgentText } from "../i18n";
import {
  automationBinding,
  automationPageHref,
  automationStatusTone,
  executionsForThread,
} from "./thread-automations-model";

type Failure = { message: string; code?: string };

type Load = {
  loading: boolean;
  executions: StudioExecution[];
  error?: Failure;
  truncated: boolean;
};

function failureOf(error: unknown): Failure {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
  return { message: error instanceof Error ? error.message : String(error), ...(code ? { code } : {}) };
}

function statusLabel(status: string, t: AgentText): string {
  switch (status) {
    case "queued": return t("排队中", "Queued");
    case "running": return t("运行中", "Running");
    case "completed": return t("已完成", "Completed");
    case "failed": return t("失败", "Failed");
    case "skipped": return t("已跳过", "Skipped");
    case "cancel_requested": return t("正在取消", "Cancel requested");
    case "cancelled": return t("已取消", "Cancelled");
    case "outcome_unknown": return t("结果未知", "Outcome unknown");
    default: return status;
  }
}

function triggerLabel(trigger: string, t: AgentText): string {
  switch (trigger) {
    case "manual": return t("手动", "Manual");
    case "scheduled": return t("计划", "Scheduled");
    case "event": return t("事件", "Event");
    case "test": return t("测试", "Test");
    default: return trigger;
  }
}

const PAGE_SCAN_LIMIT = 5;

export function ThreadAutomationSection({
  threadId,
  workspaceId,
  projectId,
  threadCustom,
  returnTo,
  onOpen,
}: {
  threadId?: string;
  workspaceId?: string;
  projectId?: string;
  threadCustom?: Record<string, unknown>;
  returnTo?: string;
  onOpen?: (href: string) => void;
}) {
  const t = useAgentText();
  const headingId = useId();
  const binding = automationBinding(threadCustom);
  const [load, setLoad] = useState<Load>({ loading: true, executions: [], truncated: false });

  useEffect(() => {
    if (!threadId || !workspaceId) return;
    const controller = new AbortController();
    const api = new StudioClient(workspaceId);
    setLoad(current => ({ loading: true, executions: current.executions, truncated: false }));
    void (async () => {
      const found = new Map<string, StudioExecution>();
      let error: Failure | undefined;
      let truncated = false;
      if (binding.executionId) {
        try {
          const execution = await api.execution(binding.executionId, { signal: controller.signal });
          found.set(execution.id, execution);
        } catch (cause) {
          if (!controller.signal.aborted) error = failureOf(cause);
        }
      }
      if (projectId && !controller.signal.aborted) {
        let cursor: string | undefined;
        let pages = 0;
        try {
          do {
            const page = await api.executions(undefined, cursor, { signal: controller.signal }, projectId);
            for (const execution of executionsForThread(page.items, threadId)) found.set(execution.id, execution);
            cursor = page.nextCursor ?? undefined;
            pages += 1;
            if (pages >= PAGE_SCAN_LIMIT && cursor) {
              truncated = true;
              break;
            }
          } while (cursor);
        } catch (cause) {
          if (!controller.signal.aborted && !error) error = failureOf(cause);
        }
      }
      if (!controller.signal.aborted) setLoad({ loading: false, executions: [...found.values()], error, truncated });
    })();
    return () => controller.abort();
  }, [threadId, workspaceId, projectId, binding.executionId]);

  if (!threadId || !workspaceId) return null;
  if (load.loading && load.executions.length === 0) return null;
  if (!load.loading && load.executions.length === 0 && !load.error && !binding.definitionId) return null;

  const hrefFor = (execution: StudioExecution) => automationPageHref({
    workspaceId,
    projectId: execution.configSnapshot.projectId || projectId,
    definitionId: execution.definitionId,
    executionId: execution.id,
    returnTo,
  });
  const open = (href: string) => (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (!onOpen) return;
    event.preventDefault();
    onOpen(href);
  };
  const definitionHref = binding.definitionId
    ? automationPageHref({ workspaceId, projectId, definitionId: binding.definitionId, returnTo })
    : undefined;

  return <section className={styles.section} aria-labelledby={headingId}>
    <h3 id={headingId} className={styles.title}>{t("线程级自动化", "Thread automations")}</h3>
    {load.error && <p role="alert" className={styles.error}>
      {load.error.message}
      {load.error.code && <> <code className={styles.code}>{load.error.code}</code></>}
    </p>}
    {load.executions.length > 0 && <ul className={styles.list}>
      {load.executions.map(execution => {
        const tone = automationStatusTone(execution.status);
        const href = hrefFor(execution);
        return <li key={execution.id} className={styles.item}>
          <ZapIcon aria-hidden="true" className={styles.itemIcon} />
          <div>
            <a className={styles.link} href={href} onClick={open(href)} title={execution.configSnapshot.name}>
              {execution.configSnapshot.name}
            </a>
            <span className={styles.itemMeta} data-tone={tone === "default" ? undefined : tone}>
              {statusLabel(execution.status, t)} · {triggerLabel(execution.trigger, t)}
            </span>
            {execution.error && <span className={styles.itemMeta} data-tone="error">{execution.error}</span>}
            {execution.summary && <span className={styles.itemMeta}>{execution.summary}</span>}
          </div>
        </li>;
      })}
    </ul>}
    {load.executions.length === 0 && definitionHref && <p className={styles.note}>
      {t("此会话由自动化定义创建，但没有可读取的执行记录。", "This Session was created by an automation definition, but no readable execution is available.")}{" "}
      <a className={styles.link} href={definitionHref} onClick={open(definitionHref)}>{t("打开自动化", "Open automation")}</a>
    </p>}
    {load.truncated && <p className={styles.note}>{t(`只扫描了最近 ${PAGE_SCAN_LIMIT} 页执行；更早记录请在自动化页查看。`, `Only the most recent ${PAGE_SCAN_LIMIT} execution pages were scanned; open automations for older records.`)}</p>}
    {load.executions.length > 0 && definitionHref && <p className={styles.note}>
      <a className={styles.link} href={definitionHref} onClick={open(definitionHref)}>{t("在自动化页查看定义", "Open the definition in automations")}</a>
    </p>}
  </section>;
}
