import type { ReactNode } from "react"
import { Bell, Search, UsersRound, X } from "lucide-react"
import { Avatar } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useI18n } from "@/lib/i18n-provider"
import styles from "./dashboards-views.module.css"

/** Display-only navigation; search and destinations remain owned by the caller. */
export function DashboardNavigation({ query, onQueryChange, onPeople, onActivity, members = [], breadcrumb, disabled = false }: {
  query: string
  onQueryChange: (value: string) => void
  onPeople?: () => void
  onActivity?: () => void
  members?: readonly { id: string; name: string; avatarUrl?: string | null }[]
  breadcrumb?: ReactNode
  disabled?: boolean
}) {
  const en = useI18n().locale === "en"
  return <div className={styles.navigation} data-pm-dashboard-navigation>
    <nav aria-label={en ? "Breadcrumb" : "面包屑"} className={styles.breadcrumb}>{breadcrumb ?? <><span>{en ? "Workspace" : "工作区"}</span><span aria-hidden="true">/</span><strong>{en ? "Dashboard" : "仪表盘"}</strong></>}</nav>
    <div className={styles.navigationActions}>
      <div className={styles.navigationSearch}>
        <Search size={16} aria-hidden="true" />
        <Input value={query} disabled={disabled} onChange={event => onQueryChange(event.target.value)} aria-label={en ? "Search projects" : "搜索项目"} placeholder={en ? "Search projects…" : "搜索项目…"} />
        {query && <Button size="icon" variant="ghost" disabled={disabled} onClick={() => onQueryChange("")} aria-label={en ? "Clear search" : "清除搜索"}><X size={14} /></Button>}
      </div>
      {members.length > 0 && <div className={styles.navigationMembers}>{members.slice(0, 3).map(member => <Avatar key={member.id} name={member.name} src={member.avatarUrl ?? undefined} size={24} />)}{members.length > 3 && <span>+{members.length - 3}</span>}</div>}
      {onPeople && <Button onClick={onPeople} disabled={disabled} className={styles.navigationPeople}><UsersRound size={16} aria-hidden="true" />{en ? "Members" : "成员"}</Button>}
      {onActivity && <Button size="icon" variant="ghost" disabled={disabled} onClick={onActivity} aria-label={en ? "Open activity" : "打开动态"}><Bell size={16} aria-hidden="true" /></Button>}
    </div>
  </div>
}
