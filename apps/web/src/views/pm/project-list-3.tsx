import type { PmPageProps } from "./model"
import type { ProjectCollectionViewProps } from "./project-collection-contracts"
import { ProjectCollectionView } from "./project-collection"
import { FixtureProjectCollection } from "./project-collection-fixture"

export function ProjectList3FixtureView({ scenario }: PmPageProps) {
  return <FixtureProjectCollection scenario={scenario} variant="table" />
}
export function ProjectList3View(props: Omit<ProjectCollectionViewProps, "variant">) {
  return <ProjectCollectionView {...props} variant="table" />
}
