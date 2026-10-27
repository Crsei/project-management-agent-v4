import { useParams, useSearchParams } from "react-router"
import { PmFixtureRoute } from "@/features/pm/pm-fixture-route"
import { parseScenario } from "@/features/pm/scenario"
import { PmViewNotFound } from "@/routes/not-found"
import { IssueCalendar1FixtureView } from "@/views/pm/issue-calendar-1"
import { IssueCalendar2FixtureView } from "@/views/pm/issue-calendar-2"
import { IssueGantt1FixtureView } from "@/views/pm/issue-gantt-1"
import { IssueKanban1FixtureView } from "@/views/pm/issue-kanban-1"
import { IssueKanban2FixtureView } from "@/views/pm/issue-kanban-2"
import { IssueKanban3FixtureView } from "@/views/pm/issue-kanban-3"
import { IssueList1FixtureView } from "@/views/pm/issue-list-1"
import { IssueList2FixtureView } from "@/views/pm/issue-list-2"
import { IssueSpreadsheet1FixtureView } from "@/views/pm/issue-spreadsheet-1"

const views = {
  list1: IssueList1FixtureView,
  list2: IssueList2FixtureView,
  board1: IssueKanban1FixtureView,
  board2: IssueKanban2FixtureView,
  board3: IssueKanban3FixtureView,
  calendar1: IssueCalendar1FixtureView,
  calendar2: IssueCalendar2FixtureView,
  gantt1: IssueGantt1FixtureView,
  spreadsheet1: IssueSpreadsheet1FixtureView,
} as const

export function PmProjectIssuesRoute() {
  const params = useParams()
  const [searchParams] = useSearchParams()
  const projectId = params.projectId ?? ""
  const view = searchParams.get("view") ?? "list1"
  const View = views[view as keyof typeof views]
  const scenario = parseScenario(searchParams.get("scenario") ?? undefined)
  const baseHref = `/lab/pm/${encodeURIComponent(params.workspaceSlug ?? "")}/projects/${encodeURIComponent(projectId)}/issues`
  if (!View) {
    return (
      <PmViewNotFound
        feature="projects/:projectId/issues"
        value={view}
        variants={Object.keys(views)}
        backHref={baseHref}
      />
    )
  }
  return (
    <PmFixtureRoute scenario={scenario} entityId={projectId}>
      <View scenario={scenario} />
    </PmFixtureRoute>
  )
}
