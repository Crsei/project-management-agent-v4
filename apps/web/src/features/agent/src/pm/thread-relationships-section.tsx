import { useId, useMemo } from "react";
import { CornerLeftUpIcon, GitForkIcon } from "lucide-react";
import styles from "./thread-details-sections.module.css";
import { useAgentText } from "../i18n";
import { buildThreadRelationships, type RelationshipThread, type ThreadRelation, type ThreadRelationships } from "./thread-relationships";

function RelationRow({
  relation,
  label,
  onOpenThread,
}: {
  relation: ThreadRelation;
  label: string;
  onOpenThread?: (id: string) => void;
}) {
  const t = useAgentText();
  const title = relation.title ?? relation.id;
  return <li className={styles.item}>
    {relation.relation === "parent"
      ? <CornerLeftUpIcon aria-hidden="true" className={styles.itemIcon} />
      : <GitForkIcon aria-hidden="true" className={styles.itemIcon} />}
    <div>
      <button type="button" className={styles.link} disabled={!onOpenThread} title={title} onClick={() => onOpenThread?.(relation.id)}>
        {title}
      </button>
      <span className={styles.itemMeta}>
        {label}
        {relation.missing ? ` · ${t("未在已加载会话列表中", "not in the loaded session list")}` : ""}
      </span>
    </div>
  </li>;
}

export function ThreadRelationshipsSection({
  threadId,
  threads,
  onOpenThread,
}: {
  threadId?: string;
  threads: ReadonlyArray<RelationshipThread>;
  onOpenThread?: (id: string) => void;
}) {
  const t = useAgentText();
  const headingId = useId();
  const relationships = useMemo<ThreadRelationships>(
    () => threadId ? buildThreadRelationships(threadId, threads) : { children: [] },
    [threadId, threads],
  );
  if (!relationships.parent && relationships.children.length === 0) return null;
  return <section className={styles.section} aria-labelledby={headingId}>
    <h3 id={headingId} className={styles.title}>{t("相关会话", "Related sessions")}</h3>
    <ul className={styles.list}>
      {relationships.parent && <RelationRow relation={relationships.parent} label={t("父会话", "Parent session")} onOpenThread={onOpenThread} />}
      {relationships.children.map(child => <RelationRow key={child.id} relation={child} label={t("分叉会话", "Forked session")} onOpenThread={onOpenThread} />)}
    </ul>
  </section>;
}
