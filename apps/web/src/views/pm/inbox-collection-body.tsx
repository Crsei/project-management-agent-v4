import type { ReactNode } from "react"
import styles from "./inbox.module.css"

/** Approved Inbox4 body geometry, shared without mail or notification semantics. */
export function InboxCollectionBody({ title, description, actions, search, children }: { title: string; description: string; actions?: ReactNode; search: ReactNode; children: ReactNode }) {
  return <div className={styles.projectMail}><header className={styles.projectMailHeader} data-inbox-owned-header><h2 data-inbox-owned-title>{title}</h2><small>{description}</small>{actions}</header><div className={styles.projectSearch}>{search}</div>{children}</div>
}
