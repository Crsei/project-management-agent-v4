/**
 * Deterministic PM7 dashboard fixtures.
 *
 * Budgets and dependency records are separate projectId-keyed facts; they never
 * change the agreed `ProjectCardRecord[]` shape returned for the "projects"
 * domain key. Dependency edges are stored records only — canvas node positions
 * are presentation and never create a dependency.
 */
export type DashboardCurrency = "USD" | "EUR" | "CNY"
export type DashboardBudget = {
  projectId: string
  currency: DashboardCurrency
  /** null = budget not set; 0 = budget explicitly zero. */
  cap: number | null
  /** null = not recorded, never rendered or summed as 0. */
  actual: number | null
  forecast: number | null
}
export const dashboardBudgetRevision = "pm-dashboards-budgets-2026-10-12-v1"
export const dashboardBudgets: readonly DashboardBudget[] = [
  {
    projectId: "project-rev-241",
    currency: "USD",
    cap: 240000,
    actual: 151200,
    forecast: 236000,
  },
  {
    projectId: "project-onb-118",
    currency: "EUR",
    cap: 180000,
    actual: 132000,
    forecast: 192000,
  },
  {
    projectId: "project-clm-084",
    currency: "USD",
    cap: 0,
    actual: 0,
    forecast: 0,
  },
  {
    projectId: "project-rtl-062",
    currency: "CNY",
    cap: 1200000,
    actual: 468000,
    forecast: 1180000,
  },
  {
    projectId: "project-mob-092",
    currency: "USD",
    cap: 320000,
    actual: 341500,
    forecast: 358000,
  },
  {
    projectId: "project-inv-176",
    currency: "USD",
    cap: null,
    actual: null,
    forecast: null,
  },
  {
    projectId: "project-kb-057",
    currency: "EUR",
    cap: 90000,
    actual: 27000,
    forecast: 88000,
  },
  {
    projectId: "project-sla-203",
    currency: "USD",
    cap: 60000,
    actual: 60000,
    forecast: 60000,
  },
  {
    projectId: "project-hir-074",
    currency: "CNY",
    cap: null,
    actual: 40000,
    forecast: null,
  },
  {
    projectId: "project-ren-133",
    currency: "CNY",
    cap: 500000,
    actual: 95000,
    forecast: 470000,
  },
]
export type DashboardDependencyEdge = {
  id: string
  source: string
  target: string
  label: string
}
export const dashboardDependencyRevision =
  "pm-dashboards-dependencies-2026-10-12-v1"
/** Projects with recorded dependencies; other projects have no graph record. */
export const dashboardDependencyProjectIds: readonly string[] = [
  "project-rev-241",
  "project-onb-118",
  "project-clm-084",
  "project-rtl-062",
  "project-mob-092",
  "project-kb-057",
  "project-sla-203",
]
/** Presentation-only canvas layout; never read to infer a dependency. */
export const dashboardDependencyPositions: Readonly<
  Record<string, { x: number; y: number }>
> = {
  "project-rev-241": { x: 24, y: 40 },
  "project-kb-057": { x: 336, y: 40 },
  "project-onb-118": { x: 648, y: 40 },
  "project-rtl-062": { x: 960, y: 40 },
  "project-mob-092": { x: 24, y: 224 },
  "project-clm-084": { x: 492, y: 224 },
  "project-sla-203": { x: 804, y: 224 },
}
export const dashboardDependencies: readonly DashboardDependencyEdge[] = [
  {
    id: "dep-rev-kb",
    source: "project-rev-241",
    target: "project-kb-057",
    label: "data contract",
  },
  {
    id: "dep-kb-onb",
    source: "project-kb-057",
    target: "project-onb-118",
    label: "content readiness",
  },
  {
    id: "dep-onb-rtl",
    source: "project-onb-118",
    target: "project-rtl-062",
    label: "launch assets",
  },
  {
    id: "dep-mob-rtl",
    source: "project-mob-092",
    target: "project-rtl-062",
    label: "release train",
  },
  {
    id: "dep-clm-sla",
    source: "project-clm-084",
    target: "project-sla-203",
    label: "escalation path",
  },
  {
    id: "dep-sla-clm",
    source: "project-sla-203",
    target: "project-clm-084",
    label: "policy review",
  },
  {
    id: "dep-mob-self",
    source: "project-mob-092",
    target: "project-mob-092",
    label: "internal release gate",
  },
  {
    id: "dep-rev-vendor",
    source: "project-rev-241",
    target: "project-ext-999",
    label: "vendor security review",
  },
]
export type DashboardNoteRecord = {
  id: string
  title: string
  body: string
  tag: string
  at: string
}
export const dashboardNoteSeed: readonly DashboardNoteRecord[] = [
  {
    id: "note-1",
    title: "Confirm revenue review owners",
    body: "Assign final reviewers for the REV-241 dashboard exceptions.",
    tag: "Today",
    at: "2026-01-12",
  },
  {
    id: "note-2",
    title: "Review unscheduled issues",
    body: "Two local issues have no due date; decide owners before sprint planning.",
    tag: "Backlog",
    at: "2026-01-11",
  },
]
