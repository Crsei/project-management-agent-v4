import { IssueCollectionView } from "./issue-collection"
import { FixtureIssueCollection } from "./issue-collection-fixture"
import type { IssueCollectionViewProps } from "./controlled-contracts"
import type { PmPageProps } from "./model"

export function IssueKanban1View(props: Omit<IssueCollectionViewProps, "variant">) {
  return <IssueCollectionView {...props} variant="board1" />
}
export function IssueKanban1FixtureView(props: PmPageProps) {
  return <FixtureIssueCollection {...props} variant="board1" />
}
