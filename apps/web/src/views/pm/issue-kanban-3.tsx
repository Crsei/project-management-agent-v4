import { IssueCollectionView } from "./issue-collection"
import { FixtureIssueCollection } from "./issue-collection-fixture"
import type { IssueCollectionViewProps } from "./controlled-contracts"
import type { PmPageProps } from "./model"

export function IssueKanban3View(props: Omit<IssueCollectionViewProps, "variant">) {
  return <IssueCollectionView {...props} variant="board3" />
}
export function IssueKanban3FixtureView(props: PmPageProps) {
  return <FixtureIssueCollection {...props} variant="board3" />
}
