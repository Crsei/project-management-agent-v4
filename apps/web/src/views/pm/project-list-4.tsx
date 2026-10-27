import type { PmPageProps } from "./model"
import type { ProjectCollectionViewProps } from "./project-collection-contracts"
import { ProjectCollectionView } from "./project-collection"
import { FixtureProjectCollection } from "./project-collection-fixture"

export function ProjectList4FixtureView({ scenario }: PmPageProps) {
  return <FixtureProjectCollection scenario={scenario} variant="compact" />
}
export function ProjectList4View(props: Omit<ProjectCollectionViewProps, "variant">) {
  return <ProjectCollectionView {...props} variant="compact" />
}
