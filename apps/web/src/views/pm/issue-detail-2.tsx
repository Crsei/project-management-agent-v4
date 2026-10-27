import { IssueDetailView } from "./issue-detail"
import { FixtureIssueDetail } from "./issue-detail-fixture"
import type { IssueDetailViewProps } from "./controlled-contracts"
import type { PmPageProps } from "./model"

export function IssueDetail2View(props: Omit<IssueDetailViewProps, "variant">) {
  return <IssueDetailView {...props} variant="detail2" />
}
export function IssueDetail2FixtureView(props: PmPageProps) {
  return <FixtureIssueDetail {...props} variant="detail2" />
}
