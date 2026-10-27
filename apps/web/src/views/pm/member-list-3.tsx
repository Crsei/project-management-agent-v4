import type { PmPageProps } from "./model"
import { MemberDirectoryFixture } from "./people-controlled-fixture"

export function MemberList3FixtureView({ scenario }: PmPageProps) {
  return <MemberDirectoryFixture scenario={scenario} variant="member3" />
}
