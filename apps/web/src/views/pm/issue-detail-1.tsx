import { IssueDetailView } from "./issue-detail"
import { FixtureIssueDetail } from "./issue-detail-fixture"
import type { IssueDetailViewProps } from "./controlled-contracts"
import type { PmPageProps } from "./model"

export function IssueDetail1View(props: Omit<IssueDetailViewProps, "variant">) {
  return <IssueDetailView {...props} variant="detail1" />
}
export function IssueDetail1FixtureView(props: PmPageProps) {
  return <FixtureIssueDetail {...props} variant="detail1" />
}
