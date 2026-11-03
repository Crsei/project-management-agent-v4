import { createStore } from "zustand/vanilla"

export type DisplayPreferences = {
  theme: "light" | "dark" | "system"
  accent: "indigo" | "blue" | "violet" | "teal" | "rose" | "graphite"
  sidebarDensity: "comfortable" | "compact"
  taskDensity: "comfortable" | "compact"
  motion: "system" | "reduce"
  spellcheck: boolean
  dateFormat: "MMM d" | "d/M" | "M/d" | "yyyy-MM-dd"
  weekStartsOn: 0 | 1 | 6
  timeFormat: "12" | "24"
  startPage: "home" | "dashboard" | "issues" | "projects" | "notifications" | "members?tab=members" | "members?tab=teams" | "members?tab=workload"
  taskOpenMode: "panel" | "page"
  projectTab: "list" | "board" | "table" | "timeline"
  showCompletedTasks: boolean
}

type BrowserPreferences = DisplayPreferences & { locale: "zh-CN" | "en" }
export type PreferenceStorage = "available" | "unavailable" | "recovered"
export type WorkspaceState = BrowserPreferences & {
  productWorkspaceId: string | null
  preferenceStorage: PreferenceStorage
  setPreferences: (patch: Partial<DisplayPreferences>) => void
  setLocale: (locale: BrowserPreferences["locale"]) => void
  setTheme: (theme: DisplayPreferences["theme"]) => void
  selectProduct: (workspaceId: string | null) => void
}

export const displayPreferencesKey = "pm.display-preferences.v1"
export const defaultDisplayPreferences: BrowserPreferences = {
  locale: "zh-CN", theme: "system", accent: "indigo",
  sidebarDensity: "comfortable", taskDensity: "comfortable", motion: "system",
  spellcheck: true, dateFormat: "MMM d", weekStartsOn: 1, timeFormat: "24",
  startPage: "home", taskOpenMode: "panel", projectTab: "board", showCompletedTasks: true,
}
const allowedValues: { [K in keyof BrowserPreferences]: readonly BrowserPreferences[K][] } = {
  locale: ["zh-CN", "en"], theme: ["light", "dark", "system"],
  accent: ["indigo", "blue", "violet", "teal", "rose", "graphite"],
  sidebarDensity: ["comfortable", "compact"], taskDensity: ["comfortable", "compact"],
  motion: ["system", "reduce"], spellcheck: [true, false],
  dateFormat: ["MMM d", "d/M", "M/d", "yyyy-MM-dd"], weekStartsOn: [0, 1, 6],
  timeFormat: ["12", "24"], startPage: ["home", "dashboard", "issues", "projects", "notifications", "members?tab=members", "members?tab=teams", "members?tab=workload"],
  taskOpenMode: ["panel", "page"], projectTab: ["list", "board", "table", "timeline"],
  showCompletedTasks: [true, false],
}

/** Migrate saved people destinations without restoring the removed formal route. */
const legacyPeopleStartPages: Readonly<Record<string, DisplayPreferences["startPage"]>> = {
  members: "members?tab=members",
  "members?view=member1": "members?tab=members",
  "members?view=member2": "members?tab=members",
  "members?view=member3": "members?tab=members",
  teams: "members?tab=teams",
  "teams?view=team1": "members?tab=teams",
  "teams?view=team2": "members?tab=members",
  "teams?view=team3": "members?tab=workload",
}

/** Only known, correctly typed values can reach consumers or browser storage. */
export function sanitizeDisplayPreferences(value: unknown): Partial<BrowserPreferences> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const candidate = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(allowedValues) as (keyof BrowserPreferences)[]) {
    if (Object.hasOwn(candidate, key) && (allowedValues[key] as readonly unknown[]).includes(candidate[key])) result[key] = candidate[key]
  }
  if (typeof candidate.startPage === "string" && Object.hasOwn(legacyPeopleStartPages, candidate.startPage)) {
    result.startPage = legacyPeopleStartPages[candidate.startPage]
  }
  if (candidate.projectTab === "overview") result.projectTab = "board"
  return result as Partial<BrowserPreferences>
}

function loadPreferences(): { preferences: BrowserPreferences; preferenceStorage: PreferenceStorage } {
  if (typeof window === "undefined") return { preferences: { ...defaultDisplayPreferences }, preferenceStorage: "unavailable" }
  try {
    const raw = window.localStorage.getItem(displayPreferencesKey)
    if (!raw) return { preferences: { ...defaultDisplayPreferences }, preferenceStorage: "available" }
    const stored: unknown = JSON.parse(raw)
    if (!stored || typeof stored !== "object" || !("version" in stored) || stored.version !== 1 || !("preferences" in stored)) throw new Error("Unsupported preferences")
    const safe = sanitizeDisplayPreferences(stored.preferences)
    const complete = Object.keys(defaultDisplayPreferences).every(key => Object.hasOwn(safe, key))
    return { preferences: { ...defaultDisplayPreferences, ...safe }, preferenceStorage: complete ? "available" : "recovered" }
  } catch (error) {
    return { preferences: { ...defaultDisplayPreferences }, preferenceStorage: error instanceof SyntaxError || error instanceof Error && error.message === "Unsupported preferences" ? "recovered" : "unavailable" }
  }
}

// One store per mounted application / SSR render, never a server module singleton.
export function createWorkspaceStore() {
  const initial = loadPreferences()
  return createStore<WorkspaceState>()((set, get) => {
    function update(patch: Partial<BrowserPreferences>) {
      const safe = sanitizeDisplayPreferences(patch)
      const preferences = { ...sanitizeDisplayPreferences(get()), ...safe }
      let preferenceStorage: PreferenceStorage = "available"
      try {
        if (typeof window === "undefined") throw new Error("Browser storage unavailable")
        window.localStorage.setItem(displayPreferencesKey, JSON.stringify({ version: 1, preferences }))
      } catch {
        preferenceStorage = "unavailable"
      }
      set({ ...safe, preferenceStorage })
    }
    return {
      ...initial.preferences,
      preferenceStorage: initial.preferenceStorage,
      productWorkspaceId: null,
      setPreferences: update,
      setLocale: locale => update({ locale }),
      setTheme: theme => update({ theme }),
      selectProduct: productWorkspaceId => set({ productWorkspaceId }),
    }
  })
}
