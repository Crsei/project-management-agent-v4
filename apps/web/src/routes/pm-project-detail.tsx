import { useParams, useSearchParams } from "react-router"
import { PmFixtureRoute } from "@/features/pm/pm-fixture-route"
import { parseScenario } from "@/features/pm/scenario"
import { PmViewNotFound } from "@/routes/not-found"
import { ProjectDetail1FixtureView } from "@/views/pm/project-detail-1"
import { ProjectDetail2FixtureView } from "@/views/pm/project-detail-2"

const views = {
  detail1: ProjectDetail1FixtureView,
  detail2: ProjectDetail2FixtureView,
} as const

export function PmProjectDetailRoute() {
  const params = useParams()
  const [searchParams] = useSearchParams()
  const projectId = params.projectId ?? ""
  const view = searchParams.get("view") ?? "detail1"
  const View = views[view as keyof typeof views]
  const scenario = parseScenario(searchParams.get("scenario") ?? undefined)
  const baseHref = `/lab/pm/${encodeURIComponent(params.workspaceSlug ?? "")}/projects/${encodeURIComponent(projectId)}`
  if (!View) {
    return (
      <PmViewNotFound
        feature="projects/:projectId"
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
