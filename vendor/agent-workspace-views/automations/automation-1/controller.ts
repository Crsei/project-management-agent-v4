import type { Copy } from "../../model"

export type TriggerKind = "hourly" | "daily" | "weekly" | "custom" | "once" | "test" | "webhook"
export type AutomationDraft = {
  name: string | Copy
  instructions: string | Copy
  enabled: boolean
  project: string
  branch: string
  conversation: string
  model: string
  effort: string
  agent: string
  trigger: TriggerKind | null
  checks: boolean
  repairs: string
  minutes: string
}
export type AutomationRecord = { id: string; draft: AutomationDraft }
export type AutomationState = {
  selected: string
  drafts: Record<string, AutomationDraft>
  saved: AutomationRecord[]
  baseline: Record<string, AutomationDraft>
  sequence: number
  data: "loading" | "ready" | "refresh-error"
  readonly: boolean
  settingsOpen: boolean
  sidebarVisible: boolean
  notice: "saved" | "cancelled" | null
}
export const literal = (value: string | Copy, locale: "zh-CN" | "en") =>
  typeof value === "string" ? value : value[locale]

export function draftErrors(draft: AutomationDraft, locale: "zh-CN" | "en") {
  const errors: string[] = []
  if (!literal(draft.name, locale).trim()) errors.push("name")
  if (!literal(draft.instructions, locale).trim()) errors.push("instructions")
  if (!draft.trigger) errors.push("trigger")
  if (!/^\d+$/.test(draft.repairs) || Number(draft.repairs) > 5) errors.push("repairs")
  if (!/^\d+$/.test(draft.minutes) || Number(draft.minutes) < 1 || Number(draft.minutes) > 240) errors.push("minutes")
  return errors
}
export function updateAutomation(state: AutomationState, patch: Partial<AutomationDraft>): AutomationState {
  if (state.readonly || state.data === "loading") return state
  return { ...state, notice: null, drafts: { ...state.drafts, [state.selected]: { ...state.drafts[state.selected], ...patch } } }
}
export function selectAutomation(state: AutomationState, id: string): AutomationState {
  if (!state.drafts[id]) return state
  return { ...state, selected: id, notice: null }
}
export function saveAutomation(state: AutomationState, locale: "zh-CN" | "en"): AutomationState {
  const draft = state.drafts[state.selected]
  if (state.readonly || state.data === "loading" || draftErrors(draft, locale).length) return state
  const id = state.selected === "new" ? `automation-local-${state.sequence + 1}` : state.selected
  const snapshot = { ...draft }
  const record = { id, draft: snapshot }
  return {
    ...state,
    selected: id,
    sequence: state.selected === "new" ? state.sequence + 1 : state.sequence,
    drafts: { ...state.drafts, [id]: snapshot },
    baseline: { ...state.baseline, [id]: snapshot },
    saved: state.saved.some(item => item.id === id)
      ? state.saved.map(item => item.id === id ? record : item)
      : [...state.saved, record],
    notice: "saved",
  }
}
export function cancelAutomation(state: AutomationState): AutomationState {
  if (state.readonly || state.data === "loading") return state
  return { ...state, drafts: { ...state.drafts, [state.selected]: { ...state.baseline[state.selected] } }, notice: "cancelled" }
}
export function automationDirty(state: AutomationState) {
  return JSON.stringify(state.drafts[state.selected]) !== JSON.stringify(state.baseline[state.selected])
}
