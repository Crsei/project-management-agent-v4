import type { PmPageProps } from "./model"
import type { ProjectDetailViewProps } from "./controlled-contracts"
import { ProjectDetailView } from "./project-detail"
import { FixtureProjectDetail } from "./project-detail-fixture"

export function ProjectDetail1FixtureView({ scenario }: PmPageProps) {
  return <FixtureProjectDetail scenario={scenario} variant="detail1" />
}
export function ProjectDetail1View(props: Omit<ProjectDetailViewProps, "variant">) {
  return <ProjectDetailView {...props} variant="detail1" />
}
