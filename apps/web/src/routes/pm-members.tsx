import { useParams, useSearchParams } from "react-router"
import { PmFixtureRoute } from "@/features/pm/pm-fixture-route"
import { parseScenario } from "@/features/pm/scenario"
import { PmViewNotFound } from "@/routes/not-found"
import { MemberList1FixtureView } from "@/views/pm/member-list-1"
import { MemberList2FixtureView } from "@/views/pm/member-list-2"
import { MemberList3FixtureView } from "@/views/pm/member-list-3"

const views = {
  member1: MemberList1FixtureView,
  member2: MemberList2FixtureView,
  member3: MemberList3FixtureView,
} as const

export function PmMembersRoute() {
  const params = useParams()
  const [searchParams] = useSearchParams()
  const view = searchParams.get("view") ?? "member1"
  const View = views[view as keyof typeof views]
  const scenario = parseScenario(searchParams.get("scenario") ?? undefined)
  if (!View) {
    return (
      <PmViewNotFound
        feature="members"
        value={view}
        variants={Object.keys(views)}
        backHref={`/lab/pm/${encodeURIComponent(params.workspaceSlug ?? "")}/members`}
      />
    )
  }
  return (
    <PmFixtureRoute scenario={scenario}>
      <View scenario={scenario} />
    </PmFixtureRoute>
  )
}
