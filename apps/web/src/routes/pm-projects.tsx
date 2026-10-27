import { useParams, useSearchParams } from "react-router"
import { PmFixtureRoute } from "@/features/pm/pm-fixture-route"
import { parseScenario } from "@/features/pm/scenario"
import { PmViewNotFound } from "@/routes/not-found"
import { ProjectList1FixtureView } from "@/views/pm/project-list-1"
import { ProjectList2FixtureView } from "@/views/pm/project-list-2"
import { ProjectList3FixtureView } from "@/views/pm/project-list-3"
import { ProjectList4FixtureView } from "@/views/pm/project-list-4"

const views = {
  list1: ProjectList1FixtureView,
  list2: ProjectList2FixtureView,
  list3: ProjectList3FixtureView,
  list4: ProjectList4FixtureView,
} as const

export function PmProjectsRoute() {
  const params = useParams()
  const [searchParams] = useSearchParams()
  const view = searchParams.get("view") ?? "list1"
  const View = views[view as keyof typeof views]
  const scenario = parseScenario(searchParams.get("scenario") ?? undefined)
  const baseHref = `/lab/pm/${encodeURIComponent(params.workspaceSlug ?? "")}/projects`
  if (!View) {
    return (
      <PmViewNotFound
        feature="projects"
        value={view}
        variants={Object.keys(views)}
        backHref={baseHref}
      />
    )
  }
  return (
    <PmFixtureRoute scenario={scenario}>
      <View scenario={scenario} />
    </PmFixtureRoute>
  )
}
