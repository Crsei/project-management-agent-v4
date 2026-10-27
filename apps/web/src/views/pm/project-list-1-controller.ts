import { pmClock } from "./model"
import type {
  ProjectWriteOutcome,
  ProjectWriteResult,
} from "./project-write-domain"
import {
  type ProjectCardRecord,
  type ProjectCycle,
  type ProjectStatus,
} from "./project-list-1-fixtures"

export type ProjectDraft = {
  title: string
  dueDate: string
  teamSize: string
  cycle: ProjectCycle
  status: ProjectStatus
}
export type ProjectQuickView =
  "all" | "active" | "archived" | "recent" | "three" | "larger"
export type ProjectCollectionInteraction = {
  quickView: ProjectQuickView
  search: string
  sort: "newest" | "oldest" | "name" | "name-desc"
  teamSize: "all" | "three" | "larger" | "small" | "medium" | "large"
  updatedWithin: 0 | 7 | 14
  archiveScope: "current" | "archived" | "all"
  status: "all" | ProjectStatus
  starredOnly: boolean
  filtersOpen: boolean
  selectedId: string | null
  detailOpen: boolean
  formOpen: boolean
  editingId: string | null
  editingFingerprint: string | null
  draft: ProjectDraft
  outcome: ProjectWriteOutcome
  checkOutcome: Exclude<ProjectWriteOutcome, "unknown">
  result: "none" | "invalid" | ProjectWriteResult["status"]
}
export const emptyProjectDraft = (): ProjectDraft => ({
  title: "",
  dueDate: "",
  teamSize: "4",
  cycle: "improvement",
  status: "active",
})
export function createProjectCollectionInteraction(): ProjectCollectionInteraction {
  return {
    quickView: "all",
    search: "",
    sort: "newest",
    teamSize: "all",
    updatedWithin: 0,
    archiveScope: "all",
    status: "all",
    starredOnly: false,
    filtersOpen: false,
    selectedId: null,
    detailOpen: false,
    formOpen: false,
    editingId: null,
    editingFingerprint: null,
    draft: emptyProjectDraft(),
    outcome: "confirmed",
    checkOutcome: "confirmed",
    result: "none",
  }
}
export function visibleProjects(
  projects: ProjectCardRecord[],
  state: Pick<
    ProjectCollectionInteraction,
    "quickView" | "search" | "sort" | "teamSize" | "status" | "starredOnly"
  > & Partial<Pick<ProjectCollectionInteraction, "updatedWithin" | "archiveScope">>,
  locale: "zh-CN" | "en",
) {
  const query = state.search.trim().toLocaleLowerCase(locale)
  const now = Date.parse(pmClock)
  const cutoff = now - 7 * 86400000
  const updatedCutoff = now - (state.updatedWithin ?? 0) * 86400000
  return projects
    .filter((p) => {
      const updatedAt = state.quickView === "recent" || state.updatedWithin ? Date.parse(p.updatedAt) : 0
      return (
        (!query || `${p.title.en} ${p.title["zh-CN"]} ${p.identifier}`.toLocaleLowerCase(locale).includes(query)) &&
        (state.quickView === "all" ||
          (state.quickView === "active" && p.status === "active" && !p.archived) ||
          (state.quickView === "archived" && p.archived) ||
          (state.quickView === "recent" && updatedAt >= cutoff && updatedAt <= now) ||
          (state.quickView === "three" && p.teamSize === 3) ||
          (state.quickView === "larger" && p.teamSize >= 4)) &&
        (!state.updatedWithin || (updatedAt >= updatedCutoff && updatedAt <= now)) &&
        (state.archiveScope === undefined || state.archiveScope === "all" ||
          (state.archiveScope === "current" && !p.archived) ||
          (state.archiveScope === "archived" && p.archived)) &&
        (state.status === "all" || p.status === state.status) &&
        (!state.starredOnly || p.starred) &&
        (state.teamSize === "all" ||
          (state.teamSize === "three" && p.teamSize === 3) ||
          (state.teamSize === "larger" && p.teamSize >= 4) ||
          (state.teamSize === "small" && p.teamSize <= 5) ||
          (state.teamSize === "medium" && p.teamSize >= 6 && p.teamSize <= 10) ||
          (state.teamSize === "large" && p.teamSize > 10))
      )
    })
    .sort((a, b) => {
      const order = state.sort === "name" || state.sort === "name-desc"
        ? a.title[locale].localeCompare(b.title[locale], locale) * (state.sort === "name-desc" ? -1 : 1)
        : a.createdAt.localeCompare(b.createdAt) * (state.sort === "oldest" ? 1 : -1)
      return order || a.id.localeCompare(b.id)
    })
}
export function projectDraftRecord(
  projects: ProjectCardRecord[],
  draft: ProjectDraft,
  editingId: string | null,
  sequence: number,
): ProjectCardRecord | null {
  const size = Number(draft.teamSize)
  const dateTime = Date.parse(`${draft.dueDate}T00:00:00Z`)
  const validDate =
    !draft.dueDate ||
    (/^\d{4}-\d{2}-\d{2}$/.test(draft.dueDate) &&
      Number.isFinite(dateTime) &&
      new Date(dateTime).toISOString().slice(0, 10) === draft.dueDate)
  const previous = projects.find((project) => project.id === editingId)
  if (
    !draft.title.trim() ||
    draft.title.trim().length > 160 ||
    !Number.isInteger(size) ||
    size < 1 ||
    size > 99 ||
    !validDate ||
    (editingId && !previous)
  )
    return null
  return {
    ...(previous ?? {
      id: `project-local-${sequence}`,
      identifier: `LOC-${String(sequence).padStart(3, "0")}`,
      ownerId: "member-alex",
      teamId: "team-local",
      health: null,
      archived: false,
      description: {
        en: "Local project brief not supplied.",
        "zh-CN": "尚未提供本地项目简报。",
      },
      cycleWeeks: 4,
      artwork: sequence % 4,
      starred: false,
      createdAt: new Date(Date.parse(pmClock) + sequence * 1000).toISOString(),
    }),
    title: { en: draft.title.trim(), "zh-CN": draft.title.trim() },
    updatedAt: pmClock,
    dueDate: draft.dueDate || null,
    teamSize: size,
    cycle: draft.cycle,
    status: draft.status,
  }
}
