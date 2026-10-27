import type { PmPageProps } from "./model"
import type { ProjectDetailViewProps } from "./controlled-contracts"
import { ProjectDetailView } from "./project-detail"
import { FixtureProjectDetail } from "./project-detail-fixture"

export function ProjectDetail2FixtureView({ scenario }: PmPageProps) {
  return <FixtureProjectDetail scenario={scenario} variant="detail2" />
}
export function ProjectDetail2View(props: Omit<ProjectDetailViewProps, "variant">) {
  return <ProjectDetailView {...props} variant="detail2" />
}
