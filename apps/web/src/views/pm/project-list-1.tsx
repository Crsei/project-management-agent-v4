import type { PmPageProps } from "./model"
import { FixtureProjectCollection } from "./project-collection-fixture"

export function ProjectList1FixtureView(props: PmPageProps) {
  return <FixtureProjectCollection {...props} variant="cover" />
}
