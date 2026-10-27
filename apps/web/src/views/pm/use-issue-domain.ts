import { usePmDomainState } from "./domain-session"
import { createIssueDomain } from "./issue-domain"
import type { PmScenario } from "./model"
export function useIssueDomain(scenario: PmScenario) {
  return usePmDomainState("issues", () => createIssueDomain(scenario))
}
