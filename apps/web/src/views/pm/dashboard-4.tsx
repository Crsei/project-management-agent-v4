import { DashboardView } from "./dashboard"
import { DependencyDashboardFixture } from "./dashboard-4-fixture"
import type { DashboardViewProps } from "./controlled-contracts"
import type { PmPageProps } from "./model"

/** Explicit local showcase adapter; Product callers use DashboardView. */
export function Dashboard4FixtureView({ scenario }: PmPageProps) {
  return <DependencyDashboardFixture scenario={scenario} />
}

export function Dashboard4View(props: Omit<DashboardViewProps, "variant">) {
  return <DashboardView {...props} variant="dashboard4" />
}
