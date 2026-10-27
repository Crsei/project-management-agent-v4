import { useParams, useSearchParams } from "react-router"
import { PmFixtureRoute } from "@/features/pm/pm-fixture-route"
import { parseScenario } from "@/features/pm/scenario"
import { PmViewNotFound } from "@/routes/not-found"
import { Dashboard1FixtureView } from "@/views/pm/dashboard-1"
import { Dashboard2FixtureView } from "@/views/pm/dashboard-2"
import { Dashboard3FixtureView } from "@/views/pm/dashboard-3"
import { Dashboard4FixtureView } from "@/views/pm/dashboard-4"

const views = {
  dashboard1: Dashboard1FixtureView,
  dashboard2: Dashboard2FixtureView,
  dashboard3: Dashboard3FixtureView,
  dashboard4: Dashboard4FixtureView,
} as const

export function PmDashboardRoute() {
  const params = useParams()
  const [searchParams] = useSearchParams()
  const view = searchParams.get("view") ?? "dashboard1"
  const View = views[view as keyof typeof views]
  const scenario = parseScenario(searchParams.get("scenario") ?? undefined)
  const baseHref = `/lab/pm/${encodeURIComponent(params.workspaceSlug ?? "")}/dashboard`
  if (!View) {
    return (
      <PmViewNotFound
        feature="dashboard"
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
