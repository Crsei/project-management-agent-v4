import { IssueCollectionView } from "./issue-collection"
import { FixtureIssueCollection } from "./issue-collection-fixture"
import type { IssueCollectionViewProps } from "./controlled-contracts"
import type { PmPageProps } from "./model"

export function IssueKanban2View(props: Omit<IssueCollectionViewProps, "variant">) {
  return <IssueCollectionView {...props} variant="board2" />
}
export function IssueKanban2FixtureView(props: PmPageProps) {
  return <FixtureIssueCollection {...props} variant="board2" />
}
