import { IssueCollectionView } from "./issue-collection"
import { FixtureIssueCollection } from "./issue-collection-fixture"
import type { IssueCollectionViewProps } from "./controlled-contracts"
import type { PmPageProps } from "./model"

export function IssueGantt1View(props: Omit<IssueCollectionViewProps, "variant">) {
  return <IssueCollectionView {...props} variant="gantt1" />
}
export function IssueGantt1FixtureView(props: PmPageProps) {
  return <FixtureIssueCollection {...props} variant="gantt1" />
}
