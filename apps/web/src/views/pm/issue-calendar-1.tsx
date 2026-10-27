import { IssueCollectionView } from "./issue-collection"
import { FixtureIssueCollection } from "./issue-collection-fixture"
import type { IssueCollectionViewProps } from "./controlled-contracts"
import type { PmPageProps } from "./model"

export function IssueCalendar1View(props: Omit<IssueCollectionViewProps, "variant">) {
  return <IssueCollectionView {...props} variant="calendar1" />
}
export function IssueCalendar1FixtureView(props: PmPageProps) {
  return <FixtureIssueCollection {...props} variant="calendar1" />
}
