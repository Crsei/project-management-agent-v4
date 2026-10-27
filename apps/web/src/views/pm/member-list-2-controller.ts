import type { Locale } from "@/lib/i18n-core"
import type { Availability } from "./people-fixtures"
import {
  directoryRows,
  personMatchesQuery,
  type PersonRow,
} from "./people-controller"
import type { PeopleDomain } from "./people-domain"

export interface MemberList2State {
  query: string
  sort: "name" | "joined" | "availability"
  view: "grid" | "list"
  detailsId: string | null
  copyReceipt: {
    memberId: string
    kind: "email" | "phone" | "contact"
    ok: boolean
  } | null
}

export function createMemberList2State(): MemberList2State {
  return {
    query: "",
    sort: "name",
    view: "grid",
    detailsId: null,
    copyReceipt: null,
  }
}

export function visibleCardRows(
  state: MemberList2State,
  domain: PeopleDomain,
  locale: Locale,
): PersonRow[] {
  const availabilityOrder: Record<Availability, number> = {
    available: 0,
    away: 1,
    offline: 2,
  }
  return directoryRows(domain)
    .filter((row) => personMatchesQuery(domain, row, state.query, locale))
    .sort((a, b) => {
      if (state.sort === "joined")
        return (
          b.person.joinedAt.localeCompare(a.person.joinedAt) ||
          a.member.name.localeCompare(b.member.name, locale)
        )
      if (state.sort === "availability") {
        const byAvailability =
          availabilityOrder[a.person.availability] -
          availabilityOrder[b.person.availability]
        if (byAvailability !== 0) return byAvailability
      }
      return a.member.name.localeCompare(b.member.name, locale)
    })
}
