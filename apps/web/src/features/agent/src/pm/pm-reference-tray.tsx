import { X } from "lucide-react";

import { Button } from "@agent/components/ui/button";

import { useAgentText, type AgentText } from "../i18n";
import type { PmReference, PmReferenceKind } from "./pm-types";
import styles from "./pm-reference-tray.module.css";

export type PmReferenceTrayProps = {
  references: readonly PmReference[];
  onRemove: (reference: PmReference) => void;
  onClear: () => void;
  max?: number;
  disabled?: boolean;
};

type Availability = NonNullable<PmReference["availability"]>;

/** PM resolution is only known after a real resolve call; anything else stays unverified. */
const availabilityLabels = (t: AgentText): Record<Availability, string> => ({
  available: t("可用", "Available"),
  stale: t("已变更", "Changed"),
  forbidden: t("不可访问", "No access"),
  deleted: t("已删除", "Deleted"),
  unverified: t("未校验", "Unverified"),
});

const kindLabels = (t: AgentText): Record<PmReferenceKind, string> => ({
  issue: t("任务", "Task"),
  project: t("项目", "Project"),
  document: t("文档", "Document"),
});

/**
 * Composer-adjacent list of PM entities referenced by the next message.
 * Purely presentational: the caller owns the reference list and its lifecycle.
 * Chips are the whole message payload — the composer text is never rewritten.
 */
export function PmReferenceTray({
  references,
  onRemove,
  onClear,
  max = 20,
  disabled = false,
}: PmReferenceTrayProps) {
  const t = useAgentText();
  const AVAILABILITY_LABEL = availabilityLabels(t);
  const KIND_LABEL = kindLabels(t);
  const count = references.length;
  const overLimit = count > max;

  if (count === 0) return null;

  return (
    <section className={styles.tray} aria-label={t(`已引用 ${count} 项`, `${count} references`)}>
      {overLimit && (
        <span className={styles.warning} role="status" aria-live="polite">
          {t(`超过上限 ${max} 项，请先移除部分引用。`, `Over the limit of ${max}; remove some references first.`)}
        </span>
      )}

      <ul className={styles.chips}>
        {references.map((reference) => {
          const availability: Availability = reference.availability ?? "unverified";
          const availabilityText = AVAILABILITY_LABEL[availability];
          const text = `@${reference.id} · ${reference.title}`;
          return (
            <li key={`${reference.kind}:${reference.projectId ?? ""}:${reference.id}`} className={styles.chip}>
              <span className={styles.chipLabel} title={`${text} · ${KIND_LABEL[reference.kind]} · ${availabilityText}`}>
                <span className={styles.chipId}>@{reference.id}</span>
                {" · "}
                <span className={styles.chipTitle}>{reference.title}</span>
              </span>
              {availability !== "available" ? (
                <span className={styles.chipState} data-state={availability} title={t(`PM 核验状态：${availabilityText}`, `PM verification: ${availabilityText}`)}>
                  {availabilityText}
                </span>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className={styles.remove}
                aria-label={t(`移除引用 ${reference.id}`, `Remove reference ${reference.id}`)}
                title={t(`移除引用 ${reference.id}`, `Remove reference ${reference.id}`)}
                disabled={disabled}
                onClick={() => onRemove(reference)}
              >
                <X aria-hidden="true" />
              </Button>
            </li>
          );
        })}
        <li>
          <Button type="button" variant="ghost" size="xs" className={styles.clear} onClick={onClear} disabled={disabled}>
            <X aria-hidden="true" />
            {t("清除引用", "Clear references")}
          </Button>
        </li>
      </ul>
    </section>
  );
}
