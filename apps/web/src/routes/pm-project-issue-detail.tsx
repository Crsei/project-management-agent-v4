import { useParams, useSearchParams } from "react-router"
import { PmFixtureRoute } from "@/features/pm/pm-fixture-route"
import { parseScenario } from "@/features/pm/scenario"
import { PmViewNotFound } from "@/routes/not-found"
import { IssueDetail1FixtureView } from "@/views/pm/issue-detail-1"
import { IssueDetail2FixtureView } from "@/views/pm/issue-detail-2"

const views = {
  detail1: IssueDetail1FixtureView,
  detail2: IssueDetail2FixtureView,
} as const

export function PmProjectIssueDetailRoute() {
  const params = useParams()
  const [searchParams] = useSearchParams()
  const issueId = params.issueId ?? ""
  const view = searchParams.get("view") ?? "detail1"
  const View = views[view as keyof typeof views]
  const scenario = parseScenario(searchParams.get("scenario") ?? undefined)
  const baseHref = `/lab/pm/${encodeURIComponent(params.workspaceSlug ?? "")}/projects/${encodeURIComponent(params.projectId ?? "")}/issues/${encodeURIComponent(issueId)}`
  if (!View) {
    return (
      <PmViewNotFound
        feature="issues/:issueId"
        value={view}
        variants={Object.keys(views)}
        backHref={baseHref}
      />
    )
  }
  return (
    <PmFixtureRoute scenario={scenario} entityId={issueId}>
      <View scenario={scenario} />
    </PmFixtureRoute>
  )
}
