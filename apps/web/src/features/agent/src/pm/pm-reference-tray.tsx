import { ClipboardList, FileText, FolderKanban, X } from "lucide-react";

import { Button } from "@agent/components/ui/button";

import { useAgentText, type AgentText } from "../i18n";
import type { PmReference, PmReferenceKind } from "./pm-types";
import styles from "./pm-reference-tray.module.css";
import { ContextChipPopover } from "../chat/context-chip-parts";
import { ContextChipAction } from "../chat/context-chip";
import { bindClipboardContext } from "../chat/message-context-clipboard";

export function PmContextChip({ reference }: { reference: PmReference }) {
  const t = useAgentText();
  const availability = reference.availability ?? "unverified";
  const Icon = reference.kind === "issue" ? ClipboardList : reference.kind === "project" ? FolderKanban : FileText;
  return <span data-message-context-record ref={element => { bindClipboardContext(element, () => ({ type: "pm", reference })); }}><ContextChipPopover kind="mention" state={availability === "unverified" ? "unresolved" : availability === "available" ? undefined : "invalid"} icon={<Icon />} label={`${reference.id} · ${reference.title}`} accessibleLabel={`${kindLabels(t)[reference.kind]} ${reference.id}`}>
    <div className="space-y-2 text-sm"><strong>{reference.title || reference.id}</strong><p>{kindLabels(t)[reference.kind]} · {availabilityLabels(t)[availability]}</p><p className="break-all text-xs">{reference.workspaceId}{reference.projectId ? ` / ${reference.projectId}` : ""}</p><p className="break-all text-xs">revision {reference.revision ?? t("发送时核验", "Verified on send")}</p><p className="text-xs text-muted-foreground">{t("仅引用，不授予 PM 权限；发送时重新核验来源和版本。", "A reference is not PM permission; source and revision are checked again on send.")}</p></div>
  </ContextChipPopover></span>;
}

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
          return (
            <li key={`${reference.workspaceId}:${reference.kind}:${reference.projectId ?? ""}:${reference.id}`} className={styles.chip}>
              <PmContextChip reference={reference} />
              <ContextChipAction aria-label={t(`移除引用 ${reference.id}`, `Remove reference ${reference.id}`)} disabled={disabled} onClick={() => onRemove(reference)}><X aria-hidden="true" /></ContextChipAction>
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
