import { useParams, useSearchParams } from "react-router"
import { PmFixtureRoute } from "@/features/pm/pm-fixture-route"
import { PmVariantNavigation } from "@/features/pm/pm-variant-navigation"
import { parseScenario } from "@/features/pm/scenario"
import { PmViewNotFound } from "@/routes/not-found"
import { Inbox1FixtureView } from "@/views/pm/inbox-1"
import { Inbox2FixtureView } from "@/views/pm/inbox-2"
import { Inbox3FixtureView } from "@/views/pm/inbox-3"
import { Inbox4FixtureView } from "@/views/pm/inbox-4"
import { InboxEmail1FixtureView } from "@/views/pm/inbox-email-1"

const views = {
  inbox1: Inbox1FixtureView,
  inbox2: Inbox2FixtureView,
  inbox3: Inbox3FixtureView,
  inbox4: Inbox4FixtureView,
  "inbox-email-1": InboxEmail1FixtureView,
} as const

export function PmNotificationsRoute() {
  const params = useParams()
  const [searchParams] = useSearchParams()
  const view = searchParams.get("view") ?? "inbox3"
  const View = views[view as keyof typeof views]
  const scenario = parseScenario(searchParams.get("scenario") ?? undefined)
  const baseHref = `/lab/pm/${encodeURIComponent(params.workspaceSlug ?? "")}/notifications`
  if (!View) {
    return (
      <PmViewNotFound
        feature="notifications"
        value={view}
        variants={Object.keys(views)}
        backHref={baseHref}
      />
    )
  }
  return (
    <PmFixtureRoute scenario={scenario}>
      <PmVariantNavigation
        baseHref={baseHref}
        value={view}
        variants={Object.keys(views)}
      />
      <View scenario={scenario} />
    </PmFixtureRoute>
  )
}
