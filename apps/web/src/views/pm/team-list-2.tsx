import type { PmPageProps } from "./model"
import { TeamCollectionFixture } from "./people-controlled-fixture"

export function TeamList2FixtureView({ scenario }: PmPageProps) {
  return <TeamCollectionFixture scenario={scenario} variant="team2" />
}
