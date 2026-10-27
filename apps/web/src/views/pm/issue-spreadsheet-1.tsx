import { IssueCollectionView } from "./issue-collection"
import { FixtureIssueCollection } from "./issue-collection-fixture"
import type { IssueCollectionViewProps } from "./controlled-contracts"
import type { PmPageProps } from "./model"

export function IssueSpreadsheet1View(props: Omit<IssueCollectionViewProps, "variant">) {
  return <IssueCollectionView {...props} variant="spreadsheet1" />
}
export function IssueSpreadsheet1FixtureView(props: PmPageProps) {
  return <FixtureIssueCollection {...props} variant="spreadsheet1" />
}
