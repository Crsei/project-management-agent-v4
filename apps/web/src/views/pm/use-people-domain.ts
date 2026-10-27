import type { Dispatch, SetStateAction } from "react"
import { usePmDomainState } from "./domain-session"
import { createPeopleDomain, restorePeopleDomain, type PeopleDomain } from "./people-domain"
import type { PmScenario } from "./model"

export function usePeopleDomain(
  scenario: PmScenario,
): [PeopleDomain, Dispatch<SetStateAction<PeopleDomain>>] {
  return usePmDomainState("people", () => createPeopleDomain(scenario), restorePeopleDomain)
}
