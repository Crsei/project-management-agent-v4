import type { PmPageProps } from "./model"
import { MemberDirectoryFixture } from "./people-controlled-fixture"

export function MemberList1FixtureView({ scenario }: PmPageProps) {
  return <MemberDirectoryFixture scenario={scenario} variant="member1" />
}
