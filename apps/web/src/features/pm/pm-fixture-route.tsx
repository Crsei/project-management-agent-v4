import { useLocation, useNavigate, useParams, useSearchParams } from "react-router"
import type { ReactNode } from "react"
import { PmDomainProvider } from "@/views/pm/domain-session"
import { PmScenarioProvider } from "@/views/pm/shared"
import type { PmScenario } from "@/views/pm/model"
import { usePmClient } from "./pm-session"

const DEFAULT_PROJECT = "project-rev-241"
const DEFAULT_ISSUE = "issue-1"

/** Lab showcase slugs mapped onto the product route tree. */
const showcaseRoutes: Record<
  string,
  (entityId?: string) => { path: string; view?: string }
> = {
  "dashboard-1": () => ({ path: "dashboard", view: "dashboard1" }),
  "dashboard-2": () => ({ path: "dashboard", view: "dashboard2" }),
  "dashboard-3": () => ({ path: "dashboard", view: "dashboard3" }),
  "dashboard-4": () => ({ path: "dashboard", view: "dashboard4" }),
  "project-list-1": () => ({ path: "projects", view: "list1" }),
  "project-list-2": () => ({ path: "projects", view: "list2" }),
  "project-list-3": () => ({ path: "projects", view: "list3" }),
  "project-list-4": () => ({ path: "projects", view: "list4" }),
  "project-detail-1": (id) => ({
    path: `projects/${id ?? DEFAULT_PROJECT}`,
    view: "detail1",
  }),
  "project-detail-2": (id) => ({
    path: `projects/${id ?? DEFAULT_PROJECT}`,
    view: "detail2",
  }),
  "issue-list-1": (id) => ({
    path: id ? `projects/${id}/issues` : "issues",
    view: "list1",
  }),
  "issue-list-2": (id) => ({
    path: id ? `projects/${id}/issues` : "issues",
    view: "list2",
  }),
  "issue-kanban-1": (id) => ({
    path: id ? `projects/${id}/issues` : "issues",
    view: "board1",
  }),
  "issue-kanban-2": (id) => ({
    path: id ? `projects/${id}/issues` : "issues",
    view: "board2",
  }),
  "issue-kanban-3": (id) => ({
    path: id ? `projects/${id}/issues` : "issues",
    view: "board3",
  }),
  "issue-calendar-1": (id) => ({
    path: id ? `projects/${id}/issues` : "issues",
    view: "calendar1",
  }),
  "issue-calendar-2": (id) => ({
    path: id ? `projects/${id}/issues` : "issues",
    view: "calendar2",
  }),
  "issue-gantt-1": (id) => ({
    path: id ? `projects/${id}/issues` : "issues",
    view: "gantt1",
  }),
  "issue-spreadsheet-1": (id) => ({
    path: id ? `projects/${id}/issues` : "issues",
    view: "spreadsheet1",
  }),
  "issue-detail-1": (id) => ({
    path: `projects/${DEFAULT_PROJECT}/issues/${id ?? DEFAULT_ISSUE}`,
    view: "detail1",
  }),
  "issue-detail-2": (id) => ({
    path: `projects/${DEFAULT_PROJECT}/issues/${id ?? DEFAULT_ISSUE}`,
    view: "detail2",
  }),
  "member-list-1": () => ({ path: "members", view: "member1" }),
  "member-list-2": () => ({ path: "members", view: "member2" }),
  "member-list-3": () => ({ path: "members", view: "member3" }),
  "team-list-1": () => ({ path: "teams", view: "team1" }),
  "team-list-2": () => ({ path: "teams", view: "team2" }),
  "team-list-3": () => ({ path: "teams", view: "team3" }),
  "inbox-1": () => ({ path: "notifications", view: "inbox1" }),
  "inbox-2": () => ({ path: "notifications", view: "inbox2" }),
  "inbox-3": () => ({ path: "notifications", view: "inbox3" }),
  "inbox-4": () => ({ path: "notifications", view: "inbox4" }),
  "inbox-email-1": () => ({ path: "notifications", view: "inbox4" }),
  "hour-calendar": () => ({ path: `projects/${DEFAULT_PROJECT}/events` }),
}

/**
 * Fixture pages keep the Lab's controlled navigation: `navigate(slug, entityId)`
 * resolves to the product route that renders the same view, so drill-downs from
 * dashboards and collections land on real routes instead of Lab URLs.
 */
export function PmFixtureRoute({
  scenario,
  entityId = null,
  children,
}: {
  scenario: PmScenario
  entityId?: string | null
  children: ReactNode
}) {
  const navigate = useNavigate()
  const params = useParams()
  const { domains, pages } = usePmClient()
  const location = useLocation()
  const [search] = useSearchParams()
  const domainKey = `${params.workspaceSlug}:${scenario}`
  const pageKey = `${domainKey}:${location.pathname}`
  if (!domains.has(domainKey)) domains.set(domainKey, new Map())
  if (!pages.has(pageKey)) pages.set(pageKey, new Map())
  const base = `/lab/pm/${encodeURIComponent(params.workspaceSlug ?? "execra-ai")}`
  return (
    <PmDomainProvider
      key={`${pageKey}:${search.get("view") ?? ""}`}
      cache={domains.get(domainKey)!}
      entityId={entityId}
      back={(fallback) => {
        if (typeof window !== "undefined" && window.history.length > 1) {
          navigate(-1)
          return
        }
        const fallbackRoute = showcaseRoutes[fallback]
        if (fallbackRoute) {
          const { path, view } = fallbackRoute()
          navigate(`${base}/${path}${view ? `?view=${view}` : ""}`)
        }
      }}
      navigate={(target, targetEntityId) => {
        const route = showcaseRoutes[target]
        if (!route) return
        const { path, view } = route(targetEntityId)
        navigate(`${base}/${path}${view ? `?view=${view}` : ""}`)
      }}
    >
      <PmScenarioProvider cache={pages.get(pageKey)!}>{children}</PmScenarioProvider>
    </PmDomainProvider>
  )
}
