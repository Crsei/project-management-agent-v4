import { apScope, type ApCopy, type ApScenario } from "../model.ts"
import { apModels } from "../fixtures/models.ts"

export type ApProfileEventKind = "chat" | "tool" | "agent"

/**
 * One aggregated fixture event. Every record carries the canonical
 * member / project / model identifiers, and all page statistics are
 * derived from this list only. Fixed inputs always produce the same
 * events: there is no runtime randomness.
 */
export type ApProfileEvent = {
  eventId: string
  dayId: string
  memberId: string
  projectId: string
  modelId: string
  kind: ApProfileEventKind
  toolId: string | null
  agentId: string | null
  count: number
  tokens: number
  sessionMinutes: number
  fastModeChats: number
  highReasoningChats: number
}

export type ApProfileTool = { toolId: string; label: ApCopy }
export type ApProfileAgent = { agentId: string; label: ApCopy }

/** Profile activity year, identical window to the reference calendar. */
export const profileYear = {
  startDayId: "2025-10-01",
  endDayId: "2026-09-30",
} as const

/** Missing-data scene: these days are unknown, never rendered or summed as zero. */
export const profileMissingRange = {
  from: "2026-03-02",
  to: "2026-03-15",
} as const

/** Agent runs exist only inside this window, which bounds month navigation. */
export const profileAgentWindow = {
  from: "2025-10-01",
  to: "2026-01-31",
} as const

/** Page-local tool fixtures; not account integrations and not real services. */
export const profileTools: readonly ApProfileTool[] = [
  {
    toolId: "tool-browser-session",
    label: { "zh-CN": "$shadcnblocks", en: "$shadcnblocks" },
  },
  {
    toolId: "tool-code-review",
    label: { "zh-CN": "$design-taste-frontend", en: "$design-taste-frontend" },
  },
  {
    toolId: "tool-doc-search",
    label: { "zh-CN": "$cloudflare", en: "$cloudflare" },
  },
  {
    toolId: "tool-deploy-check",
    label: { "zh-CN": "@browser", en: "@browser" },
  },
  {
    toolId: "tool-data-export",
    label: { "zh-CN": "$react-best-practices", en: "$react-best-practices" },
  },
  {
    toolId: "tool-alert-triage",
    label: { "zh-CN": "$typescript", en: "$typescript" },
  },
]

/** Page-local agent fixtures used by the monthly runs chart. */
export const profileAgents: readonly ApProfileAgent[] = [
  {
    agentId: "agent-triage",
    label: { "zh-CN": "分诊助手", en: "Triage agent" },
  },
  {
    agentId: "agent-research",
    label: { "zh-CN": "调研助手", en: "Research agent" },
  },
  {
    agentId: "agent-writer",
    label: { "zh-CN": "撰稿助手", en: "Writer agent" },
  },
  {
    agentId: "agent-release",
    label: { "zh-CN": "发布助手", en: "Release agent" },
  },
  { agentId: "agent-qa", label: { "zh-CN": "质检助手", en: "QA agent" } },
  {
    agentId: "agent-support",
    label: { "zh-CN": "支持助手", en: "Support agent" },
  },
  {
    agentId: "agent-report",
    label: { "zh-CN": "报表助手", en: "Report agent" },
  },
  { agentId: "agent-guard", label: { "zh-CN": "巡检助手", en: "Guard agent" } },
]

/** Deterministic FNV-1a; identical strings always hash identically. */
function fnv1a(text: string): number {
  let hash = 2166136261
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function dayIdsBetween(from: string, to: string): string[] {
  const ids: string[] = []
  let time = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  while (time <= end) {
    ids.push(new Date(time).toISOString().slice(0, 10))
    time += 86_400_000
  }
  return ids
}

/** Observed daily activity fixture; reference DOM titles, 2026-10-13. */
export const profileDailyActivities: readonly number[] = [
  0, 12, 8, 0, 0, 12, 8, 0, 12, 0, 4, 0, 0, 8, 0, 12, 0, 4, 0, 12, 8, 0, 0, 8,
  4, 0, 12, 0, 0, 12, 8, 0, 0, 12, 0, 0, 8, 4, 0, 12, 0, 4, 12, 8, 0, 0, 12, 8,
  4, 12, 0, 4, 0, 0, 8, 4, 12, 0, 4, 0, 12, 8, 0, 0, 8, 4, 0, 12, 0, 4, 8, 4, 0,
  12, 8, 0, 0, 8, 4, 0, 12, 0, 4, 0, 8, 0, 0, 12, 8, 4, 0, 0, 4, 0, 0, 8, 4, 0,
  0, 4, 0, 12, 8, 0, 0, 4, 0, 0, 8, 0, 0, 12, 4, 0, 12, 8, 0, 0, 0, 4, 0, 12, 0,
  4, 0, 0, 0, 0, 12, 8, 4, 0, 12, 4, 0, 0, 8, 4, 0, 12, 0, 0, 8, 4, 0, 12, 8, 0,
  0, 8, 0, 0, 12, 0, 0, 12, 8, 0, 0, 0, 8, 0, 12, 0, 4, 0, 0, 8, 0, 12, 8, 4, 0,
  12, 8, 12, 0, 4, 0, 12, 8, 0, 0, 8, 4, 0, 12, 8, 4, 0, 8, 0, 0, 12, 0, 4, 12,
  8, 0, 0, 0, 8, 4, 16, 0, 8, 4, 0, 12, 0, 12, 8, 4, 16, 12, 8, 4, 12, 8, 4, 16,
  12, 8, 4, 12, 8, 4, 16, 12, 8, 4, 12, 8, 4, 16, 12, 8, 4, 12, 8, 4, 16, 12, 8,
  4, 8, 4, 16, 12, 8, 4, 16, 8, 4, 16, 12, 8, 4, 16, 8, 4, 16, 12, 8, 4, 16, 8,
  4, 16, 12, 8, 4, 16, 12, 8, 20, 16, 12, 8, 20, 8, 20, 16, 12, 8, 20, 16, 8,
  20, 16, 12, 8, 20, 16, 8, 20, 16, 12, 8, 20, 16, 8, 20, 16, 12, 8, 20, 16, 8,
  20, 16, 12, 8, 20, 16, 20, 16, 12, 8, 20, 16, 12, 20, 16, 12, 8, 20, 16, 12,
  20, 16, 12, 8, 20, 16, 12, 20, 16, 12, 8, 20, 16, 12, 20, 16, 12, 8, 20, 16,
  12, 16, 12, 8, 20, 16, 12, 8, 16, 12, 8, 20, 16, 12, 8, 16,
]

export const profileDayIds: readonly string[] = dayIdsBetween(
  profileYear.startDayId,
  profileYear.endDayId,
)

/** Unknown day IDs for one scenario; unknown days are excluded from every total. */
export function profileUnknownDayIds(scenario: ApScenario): string[] {
  if (scenario !== "missing-data") return []
  return profileDayIds.filter(
    (dayId) =>
      dayId >= profileMissingRange.from && dayId <= profileMissingRange.to,
  )
}

/**
 * Builds the fixed event list for a scenario. Deterministic generation from
 * date strings only; totals, coverage, calendar levels, insights, tool runs
 * and both charts are derived downstream from these records.
 */
export function createProfileEvents(
  scenario: ApScenario,
  memberId: string,
): ApProfileEvent[] {
  if (scenario === "empty") return []
  const unknown = new Set(profileUnknownDayIds(scenario))
  const events: ApProfileEvent[] = []
  const modelAt = (dayId: string, salt: string) =>
    apModels[fnv1a(`${dayId}${salt}`) % apModels.length].modelId
  profileDayIds.forEach((dayId, index) => {
    if (unknown.has(dayId)) return
    const units = (profileDailyActivities[index] ?? 0) / 4
    if (units === 0) return
    const chatRatio = 0.5 + (fnv1a(`${dayId}|chat`) % 20) / 100
    const chatUnits = Math.min(units, Math.max(1, Math.ceil(units * chatRatio)))
    const rest = units - chatUnits
    let toolUnits = Math.floor(rest / 2)
    let agentUnits = rest - toolUnits
    const inAgentWindow =
      dayId >= profileAgentWindow.from && dayId <= profileAgentWindow.to
    if (!inAgentWindow) {
      toolUnits += agentUnits
      agentUnits = 0
    }
    const unitTokens = 4_000_000 + (fnv1a(`${dayId}|tokens`) % 4) * 1_000_000
    const push = (
      kind: ApProfileEventKind,
      kindUnits: number,
      modelId: string,
      toolId: string | null,
      agentId: string | null,
    ) => {
      if (kindUnits <= 0) return
      events.push({
        eventId: `${dayId}:${kind}`,
        dayId,
        memberId,
        projectId: apScope.projectId,
        modelId,
        kind,
        toolId,
        agentId,
        count: kindUnits * 4,
        tokens: kindUnits * 4 * unitTokens,
        sessionMinutes: kind === "chat" ? fnv1a(`${dayId}|session`) % 1530 : 0,
        fastModeChats: kind === "chat" ? Math.round(kindUnits * 4 * 0.42) : 0,
        highReasoningChats:
          kind === "chat" ? Math.round(kindUnits * 4 * 0.8) : 0,
      })
    }
    push("chat", chatUnits, modelAt(dayId, "|model-chat"), null, null)
    push(
      "tool",
      toolUnits,
      modelAt(dayId, "|model-tool"),
      profileTools[fnv1a(`${dayId}|tool`) % profileTools.length].toolId,
      null,
    )
    push(
      "agent",
      agentUnits,
      modelAt(dayId, "|model-agent"),
      null,
      profileAgents[fnv1a(`${dayId}|agent`) % profileAgents.length].agentId,
    )
  })
  return events
}
