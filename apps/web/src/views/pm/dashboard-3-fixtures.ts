/** Explicit Lab-only monthly budget observations, not inferred production history.
 * The January observations agree with the shared budget snapshot; future values
 * are fixture forecasts. Missing observations remain null, never zero. */
export const dashboard3HistoryMonths = [
  "2025-09-01", "2025-10-01", "2025-11-01", "2025-12-01", "2026-01-01",
  "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01",
] as const

export type Dashboard3BudgetHistory = {
  projectId: string
  actual: readonly (number | null)[]
  forecast: readonly (number | null)[]
}
export const dashboard3BudgetHistory: readonly Dashboard3BudgetHistory[] = [
  { projectId: "project-rev-241", actual: [0, 46800, 83400, 119800, 151200, null, null, null, null], forecast: [null, null, null, null, 151200, 181000, 210000, 228000, 236000] },
  { projectId: "project-onb-118", actual: [0, 41000, 73000, 104700, 132000, null, null, null, null], forecast: [null, null, null, null, 132000, 153000, 174000, 187000, 192000] },
  { projectId: "project-clm-084", actual: [0, 0, 0, 0, 0, null, null, null, null], forecast: [null, null, null, null, 0, 0, 0, 0, 0] },
  { projectId: "project-rtl-062", actual: [0, 145000, 258300, 371200, 468000, null, null, null, null], forecast: [null, null, null, null, 468000, 680000, 920000, 1100000, 1180000] },
  { projectId: "project-mob-092", actual: [0, 105900, 188500, 270800, 341500, null, null, null, null], forecast: [null, null, null, null, 341500, 347000, 352000, 356000, 358000] },
  { projectId: "project-kb-057", actual: [0, 8400, 14900, 21400, 27000, null, null, null, null], forecast: [null, null, null, null, 27000, 44000, 65000, 80000, 88000] },
  { projectId: "project-sla-203", actual: [0, 18600, 33100, 47600, 60000, null, null, null, null], forecast: [null, null, null, null, 60000, 60000, 60000, 60000, 60000] },
  { projectId: "project-hir-074", actual: [null, null, null, null, 40000, null, null, null, null], forecast: [null, null, null, null, null, null, null, null, null] },
  { projectId: "project-ren-133", actual: [0, 29500, 52400, 75300, 95000, null, null, null, null], forecast: [null, null, null, null, 95000, 210000, 340000, 430000, 470000] },
]

/** Seeded local activity is separate from subsequent confirmed Lab edits. */
export const dashboard3ActivitySeed = [
  { id: "dashboard3-comment", itemId: "issue-1", minutesAgo: 10, kind: "comment" },
  { id: "dashboard3-review", itemId: "issue-4", minutesAgo: 60, kind: "review" },
  { id: "dashboard3-completed", itemId: "issue-5", minutesAgo: 120, kind: "completed" },
  { id: "dashboard3-updated", itemId: "issue-2", minutesAgo: 180, kind: "updated" },
] as const
