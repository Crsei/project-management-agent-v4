import { filters, fixtureClaims, sources, text, assessments, relations, type Claim, type Filter } from "./fixtures.ts"

export type MatrixState = {
  claims: Claim[]
  filter: Filter
  selectedClaim: string | null
  selectedSource: string
  reviewed: Record<string, boolean>
  data: "success" | "empty" | "loading" | "error"
  canReview: boolean
  scroll: { page: number; tableTop: number; tableLeft: number }
}
export type MatrixAction =
  | { type: "filter"; filter: Filter }
  | { type: "select"; claimId: string; sourceId: string }
  | { type: "review"; claimId: string; sourceId: string }
  | { type: "load-fixture" }
  | { type: "scroll"; area: "page" | "tableTop" | "tableLeft"; value: number }

export function createMatrixState(scenario: string): MatrixState {
  const claims = fixtureClaims(scenario)
  return {
    claims,
    filter: "all",
    selectedClaim: claims.find(claim => claim.assessment === "conflict")?.id ?? claims[0]?.id ?? null,
    selectedSource: sources[0].id,
    reviewed: {},
    data: scenario === "loading" ? "loading" : scenario === "empty" ? "empty" : scenario === "refresh-error" ? "error" : "success",
    canReview: scenario !== "readonly",
    scroll: { page: 0, tableTop: 0, tableLeft: 0 },
  }
}

export function visibleClaims(state: MatrixState): Claim[] {
  return state.filter === "all" ? state.claims : state.claims.filter(claim => claim.assessment === state.filter)
}

/** Review is a local reading flag, independent from assessment and evidence relation. */
export function matrixTransition(state: MatrixState, action: MatrixAction): MatrixState {
  switch (action.type) {
    case "filter": {
      if (!filters.includes(action.filter) || state.data === "loading") return state
      const visible = action.filter === "all" ? state.claims : state.claims.filter(claim => claim.assessment === action.filter)
      return {
        ...state, filter: action.filter,
        selectedClaim: visible[0]?.id ?? null,
        selectedSource: sources[0].id,
        scroll: { ...state.scroll, tableTop: 0 },
      }
    }
    case "select": {
      if (state.data === "loading" || !visibleClaims(state).some(claim => claim.id === action.claimId && claim.evidence[action.sourceId])) return state
      if (state.selectedClaim === action.claimId && state.selectedSource === action.sourceId) return state
      return { ...state, selectedClaim: action.claimId, selectedSource: action.sourceId }
    }
    case "review": {
      if (!state.canReview || state.data === "loading" || !state.claims.some(claim => claim.id === action.claimId && claim.evidence[action.sourceId])) return state
      const key = action.claimId + ":" + action.sourceId
      return { ...state, reviewed: { ...state.reviewed, [key]: !state.reviewed[key] } }
    }
    case "load-fixture": {
      if (state.data !== "empty" && state.data !== "loading" && state.data !== "error") return state
      if (state.claims.length) return { ...state, data: "success" }
      const claims = fixtureClaims("default")
      const selected = claims.find(claim => state.filter === "all" || claim.assessment === state.filter)
      return { ...state, claims, data: "success", selectedClaim: selected?.id ?? null }
    }
    case "scroll": {
      if (!Number.isFinite(action.value) || action.value < 0 || state.scroll[action.area] === action.value) return state
      return { ...state, scroll: { ...state.scroll, [action.area]: action.value } }
    }
  }
}

/** All cells are exported, including hidden rows, with provenance and review flags. */
export function exportMatrixCsv(state: MatrixState, locale: string): string {
  const header = locale === "en"
    ? ["Claim", "Assessment", "Source", "Provenance", "Relation", "Excerpt", "Interpretation", "Reviewed"]
    : ["主张", "评估", "来源", "来源性质", "关系", "片段", "解读", "已审阅"]
  const rows = state.claims.flatMap(claim => sources.map(source => {
    const evidence = claim.evidence[source.id]
    return [text(claim.title, locale), text(assessments[claim.assessment], locale), text(source.title, locale), text(source.provenance, locale), text(relations[evidence.relation], locale), evidence.quote ? text(evidence.quote, locale) : "", text(evidence.interpretation, locale), state.reviewed[claim.id + ":" + source.id] ? "true" : "false"]
  }))
  return "\uFEFF" + [header, ...rows].map(row => row.map(value => '"' + value.replaceAll('"', '""') + '"').join(",")).join("\r\n")
}
