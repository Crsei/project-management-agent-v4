import { PmFixtureRoute } from "@/features/pm/pm-fixture-route"
import { HourCalendarFixtureView } from "@/views/pm/hour-calendar-fixture"

export function PmProjectEventsRoute() {
  return (
    <PmFixtureRoute scenario="default">
      <HourCalendarFixtureView />
    </PmFixtureRoute>
  )
}
