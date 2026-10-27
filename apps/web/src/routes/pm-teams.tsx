import { useParams, useSearchParams } from "react-router"
import { PmFixtureRoute } from "@/features/pm/pm-fixture-route"
import { parseScenario } from "@/features/pm/scenario"
import { PmViewNotFound } from "@/routes/not-found"
import { TeamList1FixtureView } from "@/views/pm/team-list-1"
import { TeamList2FixtureView } from "@/views/pm/team-list-2"
import { TeamList3FixtureView } from "@/views/pm/team-list-3"

const views = {
  team1: TeamList1FixtureView,
  team2: TeamList2FixtureView,
  team3: TeamList3FixtureView,
} as const

export function PmTeamsRoute() {
  const params = useParams()
  const [searchParams] = useSearchParams()
  const view = searchParams.get("view") ?? "team1"
  const View = views[view as keyof typeof views]
  const scenario = parseScenario(searchParams.get("scenario") ?? undefined)
  const baseHref = `/lab/pm/${encodeURIComponent(params.workspaceSlug ?? "")}/teams`
  if (!View) {
    return (
      <PmViewNotFound
        feature="teams"
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
