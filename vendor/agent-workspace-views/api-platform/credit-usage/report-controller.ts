import { apScope, type ApLocale } from "../model.ts"
import type { CreditRanking, CreditUsageState } from "./controller.ts"
import { creditReportAgents, creditReportMembers, creditReportSource } from "./report-fixtures.ts"

export function creditReportSelection(state: CreditUsageState, locale: ApLocale) {
  const buckets = (state.reportBuckets ?? []).filter((bucket) =>
    bucket.orgId === apScope.orgId &&
    (state.filter.projectId === "all" || bucket.projectId === state.filter.projectId) &&
    bucket.date >= state.filter.from && bucket.date <= state.filter.to)
  const agents = state.breakdown === "agents"
  const roster = agents ? creditReportAgents : creditReportMembers
  const all = new Map<string, CreditRanking>()
  for (const identity of roster) {
    all.set(identity.id, {
      id: identity.id,
      name: identity.name[locale] + (state.reportLongNames ? ` · ${locale === "en" ? "Global customer operations and multilingual workflow workspace" : "全球客户运营与多语言工作流工作区"}` : ""),
      category: identity.group[locale],
      groupId: identity.group.en,
      unknownIdentity: false,
      requests: 0,
      completedRequests: 0,
      hoursSaved: 0,
      knownCredits: 0,
      credits: 0,
      missingCredits: 0,
      share: null,
    })
  }
  let directCredits = 0, agentCredits = 0, directMissing = 0, agentMissing = 0
  let completedRequests = 0, hoursSaved: number | null = 0
  const active = new Set<string>()
  for (const bucket of buckets) {
    const id = (agents ? bucket.agentId : bucket.memberId) ?? "credit-member-unknown"
    active.add(id)
    let row = all.get(id)
    if (!row) {
      row = {
        id, name: locale === "en" ? "Unknown member" : "未知成员",
        category: null, groupId: "Unknown", unknownIdentity: true,
        requests: 0, completedRequests: 0, hoursSaved: 0, knownCredits: 0,
        credits: 0, missingCredits: 0, share: null,
      }
      all.set(id, row)
    }
    completedRequests += bucket.runs
    hoursSaved = hoursSaved === null || bucket.hoursSaved === null ? null : hoursSaved + bucket.hoursSaved
    directCredits += bucket.organizationCredits ?? 0
    agentCredits += bucket.agentCredits ?? 0
    directMissing += bucket.organizationCredits === null ? 1 : 0
    agentMissing += bucket.agentCredits === null ? 1 : 0
    row.requests++
    row.completedRequests += bucket.runs
    row.hoursSaved = row.hoursSaved === null || bucket.hoursSaved === null ? null : row.hoursSaved + bucket.hoursSaved
    row.knownCredits += (bucket.agentCredits ?? 0) + (agents ? 0 : bucket.organizationCredits ?? 0)
    row.missingCredits += bucket.agentCredits === null || (!agents && bucket.organizationCredits === null) ? 1 : 0
  }
  const knownCredits = directCredits + agentCredits
  const missingCredits = buckets.filter((bucket) => bucket.agentCredits === null || bucket.organizationCredits === null).length
  const credits = missingCredits ? null : knownCredits
  const denominator = agents ? (agentMissing ? null : agentCredits) : credits
  const allRows = [...all.values()]
  for (const row of allRows) {
    row.credits = row.missingCredits ? null : row.knownCredits
    row.share = denominator === null || row.credits === null ? null : denominator === 0 ? 0 : row.credits / denominator * 100
  }
  const search = state.searches[state.breakdown].trim().toLocaleLowerCase(locale)
  const groups = state.groupSelections?.[state.breakdown] ?? []
  const rows = allRows.filter((row) =>
    (!state.filter.identities.length || state.filter.identities.includes(row.id)) &&
    (!groups.length || groups.includes(row.groupId ?? "Unknown")) &&
    (!search || `${row.name} ${row.category ?? ""} ${roster.find((identity) => identity.id === row.id)?.name.en ?? ""} ${roster.find((identity) => identity.id === row.id)?.name["zh-CN"] ?? ""} ${row.groupId ?? ""}`.toLocaleLowerCase(locale).includes(search)))
  const sort = state.sorts[state.breakdown]
  if (sort) rows.sort((a, b) => {
    const key = sort.columnId as "completedRequests" | "hoursSaved" | "credits"
    const av = a[key], bv = b[key]
    if (av === null) return bv === null ? 0 : 1
    if (bv === null) return -1
    return (av - bv) * (sort.direction === "asc" ? 1 : -1)
  })
  const days = (Date.parse(state.filter.to) - Date.parse(state.filter.from)) / 86_400_000 + 1
  return {
    requests: [], buckets, allRows, rows, knownCredits, missingCredits, credits,
    directCredits, directMissing, agentCredits, agentMissing, completedRequests,
    hoursSaved, active: active.size, days,
    average: completedRequests / (state.period === "daily" && !state.customRange ? 24 : days),
    creditCoverage: { observed: buckets.length - missingCredits, total: buckets.length },
  }
}

export function creditReportExport(state: CreditUsageState, locale: ApLocale) {
  const selection = creditReportSelection(state, locale)
  return JSON.stringify({
    source: creditReportSource.source,
    ledgerRevision: creditReportSource.revision,
    scope: { orgId: apScope.orgId, projectId: state.filter.projectId },
    range: {
      from: `${state.filter.from}T00:00:00Z`,
      to: new Date(Date.parse(state.filter.to) + 86_400_000).toISOString(),
      timeZone: "UTC",
    },
    period: state.period, breakdown: state.breakdown,
    search: state.searches[state.breakdown], identities: state.filter.identities,
    groups: state.groupSelections?.[state.breakdown] ?? [], sort: state.sorts[state.breakdown],
    unit: "credits", credits: selection.credits, knownCredits: selection.knownCredits,
    coverage: selection.creditCoverage, hoursSaved: selection.hoursSaved,
    completedRuns: selection.completedRequests,
    countDefinition: "Completed runs from a local daily run report; not API requests.",
    shareDefinition: state.breakdown === "agents" ? "Share of scoped agent credits; filtering does not change the denominator." : "Share of scoped organization plus agent credits; filtering does not change the denominator.",
    rows: selection.rows, bucketIds: selection.buckets.map((bucket) => bucket.id),
  }, null, 2)
}
