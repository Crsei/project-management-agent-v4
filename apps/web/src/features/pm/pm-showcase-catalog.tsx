import { Link } from "react-router"
import { useI18n } from "@/lib/i18n-provider"
import { settingsPages } from "./service/settings/settings-catalog"

const entries = [
  ...[1, 2, 3, 4].map(n => ({ slug: `dashboard-${n}`, path: `dashboard?view=dashboard${n}`, group: "Dashboard" })),
  ...[1, 2, 3, 4].map(n => ({ slug: `project-list-${n}`, path: `projects?view=list${n}`, group: "Projects" })),
  ...[1, 2].map(n => ({ slug: `project-detail-${n}`, path: `projects/project-rev-241?view=detail${n}`, group: "Projects" })),
  ...[1, 2, 3].map(n => ({ slug: `team-list-${n}`, path: `teams?view=team${n}`, group: "People" })),
  ...[1, 2, 3].map(n => ({ slug: `member-list-${n}`, path: `members?view=member${n}`, group: "People" })),
  ...[1, 2].map(n => ({ slug: `issue-list-${n}`, path: `issues?view=list${n}`, group: "Issues" })),
  ...[1, 2].map(n => ({ slug: `issue-detail-${n}`, path: `projects/project-rev-241/issues/issue-1?view=detail${n}`, group: "Issues" })),
  ...[1, 2, 3].map(n => ({ slug: `issue-kanban-${n}`, path: `issues?view=board${n}`, group: "Issues" })),
  ...[1, 2].map(n => ({ slug: `issue-calendar-${n}`, path: `issues?view=calendar${n}`, group: "Issues" })),
  { slug: "issue-gantt-1", path: "issues?view=gantt1", group: "Issues" },
  { slug: "issue-spreadsheet-1", path: "issues?view=spreadsheet1", group: "Issues" },
  ...[1, 2, 3, 4].map(n => ({ slug: `inbox-${n}`, path: `notifications?view=inbox${n}`, group: "Inbox" })),
  { slug: "inbox-email-1", path: "notifications?view=inbox-email-1", group: "Inbox" },
  ...settingsPages.map(page => ({ slug: `settings-${page.slug}`, path: `settings/${page.slug}`, group: "Settings" })),
]

export function PmShowcaseCatalog() {
  const en = useI18n().locale === "en"
  return <main className="overflow-auto p-6">
    <div className="flex flex-wrap items-center justify-between gap-4"><h1 className="text-xl font-semibold">{en ? `${entries.length}-page component showcase` : `${entries.length} 页组件展示`}</h1><Link to="/pm" className="rounded-control border px-3 py-2 text-sm hover:bg-surface-hover">{en ? "Open real application" : "进入真实应用"}</Link></div>
    <p className="my-4 max-w-3xl text-sm leading-6 text-muted-foreground">{en ? "Deterministic examples only. Editing these views does not write to the service. Empty, loading, refresh-error, readonly and long-content scenarios are available via the scenario query parameter." : "此处仅使用确定性示例；编辑不会写入真实服务。通过 scenario 查询参数可查看 empty、loading、refresh-error、readonly、long-content 场景。"}</p>
    {["Dashboard", "Projects", "People", "Issues", "Inbox", "Settings"].map(group => <section key={group} className="mb-6"><h2 className="mb-3 text-sm font-semibold">{group === "Settings" && !en ? "设置" : group}</h2>{group === "Settings" && <p className="mb-3 text-xs text-muted-foreground">{en ? `${settingsPages.length} settings pages. Browser appearance and interaction preferences apply and persist locally. Business forms are page-local previews; unsupported security and external services remain disabled. No payments or server writes occur. The scenario parameter does not apply.` : `${settingsPages.length} 个设置页面。浏览器外观与操作偏好真实生效并在本机保存；业务表单仅在本页预览，未支持的安全及外部服务保持禁用，不付款、不写服务器；这些页面不使用 scenario 参数。`}</p>}<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{entries.filter(entry => entry.group === group).map(entry => <Link key={entry.slug} to={`/lab/pm/execra-ai/${entry.path}`} className="rounded-module border bg-surface px-4 py-3 text-sm hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring">{entry.slug}</Link>)}</div></section>)}
  </main>
}
