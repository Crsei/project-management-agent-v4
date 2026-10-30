import type { NativeOutputItem } from "@agent-workspace/contracts/output";

import { changeSetFromToolItem, pmChangeKindLabel, pmChangeStateLabel } from "./pm-change-model";
import { useI18n } from "@/lib/i18n-provider";
import { useAgentText } from "../i18n";
import type { PmChangeSet } from "./pm-types";
import styles from "./pm-change-set.module.css";

const timestampFormats = new Map<string, Intl.DateTimeFormat>();
function formatChangeTime(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  let format = timestampFormats.get(locale);
  if (!format) { format = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short", hour12: false }); timestampFormats.set(locale, format); }
  return format.format(date);
}

export function PmChangeSetCard({
  change,
  onOpenTarget,
}: {
  change: PmChangeSet;
  onOpenTarget?: (change: PmChangeSet) => void;
}) {
  const t = useAgentText();
  const { locale } = useI18n();
  const fields = change.fields ?? [];
  const stamp = change.updatedAt ?? change.createdAt;
  const receiptId = change.receiptId;
  const commandId = change.commandId;

  return (
    <article
      className={styles.card}
      data-kind={change.kind}
      data-state={change.state}
      aria-label={`${pmChangeKindLabel(change.kind, t)}: ${change.summary}`}
    >
      <header className={styles.header}>
        <span className={styles.kind}>{pmChangeKindLabel(change.kind, t)}</span>
        <span className={styles.badge} data-state={change.state}>
          {pmChangeStateLabel(change.state, t)}
        </span>
      </header>

      <div className={styles.target}>
        {change.targetTitle ? <span className={styles.title}>{change.targetTitle}</span> : null}
        {change.targetId ? <code className={styles.id}>{change.targetId}</code> : null}
        {!change.targetTitle && !change.targetId ? (
          <span className={styles.muted}>{t("未关联目标", "No linked target")}</span>
        ) : null}
      </div>

      <p className={styles.summary}>{change.summary}</p>

      {fields.length > 0 ? (
        <details className={styles.fields} open={fields.length <= 2}>
          <summary>{t("字段变更", "Field changes")} ({fields.length})</summary>
          <dl className={styles.fieldList}>
            {fields.map((field, index) => (
              <div className={styles.field} key={`${field.field}-${index}`}>
                <dt>{field.label || field.field}</dt>
                <dd>
                  <span className={styles.before} data-empty={field.before === null}>
                    {field.before ?? t("空", "Empty")}
                  </span>
                  <span className={styles.arrow} aria-hidden="true">
                    →
                  </span>
                  <span className={styles.srOnly}>{t("变更为", "Changed to")}</span>
                  <span className={styles.after} data-empty={field.after === null}>
                    {field.after ?? t("空", "Empty")}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}

      {change.error ? (
        <div className={styles.error} role="alert">
          {change.error.code ? <code className={styles.errorCode}>{change.error.code}</code> : null}
          <span>{change.error.message}</span>
        </div>
      ) : null}

      {receiptId || commandId || change.projectId ? (
        <dl className={styles.meta}>
          {change.projectId ? (
            <div>
              <dt>{t("项目", "Project")}</dt>
              <dd>
                <code>{change.projectId}</code>
              </dd>
            </div>
          ) : null}
          {receiptId ? (
            <div>
              <dt>{t("回执", "Receipt")}</dt>
              <dd>
                <code>{receiptId}</code>
              </dd>
            </div>
          ) : null}
          {commandId ? (
            <div>
              <dt>{t("命令", "Command")}</dt>
              <dd>
                <code>{commandId}</code>
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {stamp || onOpenTarget ? (
        <footer className={styles.footer}>
          {stamp ? (
            <time className={styles.time} dateTime={stamp}>
              {change.updatedAt ? t("更新于 ", "Updated ") : t("创建于 ", "Created ")}
              {formatChangeTime(stamp, locale)}
            </time>
          ) : null}
          {onOpenTarget ? (
            <button className={styles.open} type="button" onClick={() => onOpenTarget(change)}>
              {t("查看目标", "View target")}
            </button>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}

export function PmChangeSetList({
  changes,
  emptyLabel,
  onOpenTarget,
}: {
  changes: readonly PmChangeSet[];
  emptyLabel?: string;
  onOpenTarget?: (change: PmChangeSet) => void;
}) {
  const t = useAgentText();
  if (changes.length === 0) {
    return (
      <p className={styles.empty} role="status">
        {emptyLabel ?? t("当前会话还没有 PM 变更", "No PM changes in this session yet")}
      </p>
    );
  }

  return (
    <ul className={styles.list} aria-label={t("PM 变更", "PM changes")}>
      {changes.map((change) => (
        <li className={styles.listItem} key={change.id}>
          <PmChangeSetCard change={change} onOpenTarget={onOpenTarget} />
        </li>
      ))}
    </ul>
  );
}

export function PmToolChangeCard({ item }: { item: NativeOutputItem }) {
  const change = changeSetFromToolItem(item);
  return change ? <PmChangeSetCard change={change} /> : null;
}
