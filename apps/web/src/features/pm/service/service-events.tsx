import { useLocation, useNavigate, useParams } from "react-router"
import { useWorkspaceStore } from "@/providers/app-providers"
import { ServiceGuard, queryData } from "./pm-ui"
import { usePmEntities } from "./pm-service"
import { ServiceHourCalendar } from "./service-hour-calendar"

/** Production events page. The showcase HourCalendarView owns the page shell;
 * this wrapper only supplies authorized work item dates and issue navigation. */
export function ServiceEvents() {
  const { projectId, workspaceSlug } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const taskOpenMode = useWorkspaceStore(state => state.taskOpenMode)
  const items = usePmEntities("work_item", projectId)
  const projects = usePmEntities("project")
  return (
    <ServiceGuard>
      <ServiceHourCalendar
        items={items.data ?? []}
        projects={projects.data ?? []}
        data={queryData(items, items.data?.length ?? 0)}
        onOpenIssue={(item) => {
          const root = `/pm/${encodeURIComponent(workspaceSlug ?? "")}`
          const returnTo = `${location.pathname}${location.search}`
          navigate(taskOpenMode === "panel" ? `${root}/issues?${new URLSearchParams({ entity: item.id, returnTo })}` : `${root}/entities/${encodeURIComponent(item.id)}?${new URLSearchParams({ returnTo })}`, { state: { returnTo } })
        }}
      />
    </ServiceGuard>
  )
}
