import { DashboardView } from "./dashboard"
import { OverviewDashboardFixture } from "./dashboard-2-fixture"
import type { DashboardViewProps } from "./controlled-contracts"
import type { PmPageProps } from "./model"

/** Explicit local showcase adapter; Product callers use DashboardView. */
export function Dashboard2FixtureView({ scenario }: PmPageProps) {
  return <OverviewDashboardFixture scenario={scenario} />
}

export function Dashboard2View(props: Omit<DashboardViewProps, "variant">) {
  return <DashboardView {...props} variant="dashboard2" />
}
