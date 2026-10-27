import { DashboardView } from "./dashboard"
import { PersonalDashboardFixture } from "./dashboard-1-fixture"
import type { DashboardViewProps } from "./controlled-contracts"
import type { PmPageProps } from "./model"

/** Explicit local showcase adapter; Product callers use DashboardView. */
export function Dashboard1FixtureView({ scenario }: PmPageProps) {
  return <PersonalDashboardFixture scenario={scenario} />
}

export function Dashboard1View(props: Omit<DashboardViewProps, "variant">) {
  return <DashboardView {...props} variant="dashboard1" />
}
