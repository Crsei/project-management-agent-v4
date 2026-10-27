import { DashboardView } from "./dashboard"
import { PortfolioDashboardFixture } from "./dashboard-3-fixture"
import type { DashboardViewProps } from "./controlled-contracts"
import type { PmPageProps } from "./model"

/** Explicit local showcase adapter; Product callers use DashboardView. */
export function Dashboard3FixtureView({ scenario }: PmPageProps) {
  return <PortfolioDashboardFixture scenario={scenario} />
}

export function Dashboard3View(props: Omit<DashboardViewProps, "variant">) {
  return <DashboardView {...props} variant="dashboard3" />
}
