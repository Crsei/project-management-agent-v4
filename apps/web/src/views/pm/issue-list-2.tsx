import { IssueCollectionView } from "./issue-collection"
import { FixtureIssueCollection } from "./issue-collection-fixture"
import type { IssueCollectionViewProps } from "./controlled-contracts"
import type { PmPageProps } from "./model"

export function IssueList2View(props: Omit<IssueCollectionViewProps, "variant">) {
  return <IssueCollectionView {...props} variant="list2" />
}
export function IssueList2FixtureView(props: PmPageProps) {
  return <FixtureIssueCollection {...props} variant="list2" />
}
