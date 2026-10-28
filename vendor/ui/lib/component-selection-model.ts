/** Portable selection contract. Storage, downloads and Agent execution belong to callers. */
export type SelectionText = string | { "zh-CN": string; en: string }
export type SelectionDecision =
  "undecided" | "preferred" | "alternative" | "rejected"
export type SelectionCandidate = {
  id: string
  name: string
  description: SelectionText
  suitableFor: SelectionText
  limitation: SelectionText
  source: string
  registryId?: string
  origin: string
  version: string
  license: string
}
export type SelectionGroup = {
  id: string
  title: SelectionText
  purpose: SelectionText
  candidates: readonly SelectionCandidate[]
}
export type SelectionTemplate = {
  id: string
  revision: string
  groups: readonly SelectionGroup[]
}
export type CandidateSelection = {
  id: string
  decision: SelectionDecision
  note: string
}
export type GroupSelection = {
  id: string
  requirement: string
  candidates: CandidateSelection[]
}
export type ComponentSelectionDraft = {
  format: "easyuseui.component-selection"
  schemaVersion: 1
  templateId: string
  templateRevision: string
  projectName: string
  goal: string
  constraints: string
  groups: GroupSelection[]
}
export const selectionImportLimit = 128 * 1024
export const selectionTextLimit = 4000
export function createSelectionDraft(
  template: SelectionTemplate,
): ComponentSelectionDraft {
  return {
    format: "easyuseui.component-selection",
    schemaVersion: 1,
    templateId: template.id,
    templateRevision: template.revision,
    projectName: "",
    goal: "",
    constraints: "",
    groups: template.groups.map((group) => ({
      id: group.id,
      requirement: "",
      candidates: group.candidates.map((candidate) => ({
        id: candidate.id,
        decision: "undecided",
        note: "",
      })),
    })),
  }
}
export function setSelectionDecision(
  draft: ComponentSelectionDraft,
  groupId: string,
  candidateId: string,
  decision: SelectionDecision,
): ComponentSelectionDraft {
  if (
    !draft.groups
      .find((group) => group.id === groupId)
      ?.candidates.some((candidate) => candidate.id === candidateId)
  )
    return draft
  return {
    ...draft,
    groups: draft.groups.map((group) =>
      group.id !== groupId
        ? group
        : {
            ...group,
            candidates: group.candidates.map((candidate) => ({
              ...candidate,
              decision:
                candidate.id === candidateId
                  ? decision
                  : decision === "preferred" &&
                      candidate.decision === "preferred"
                    ? "alternative"
                    : candidate.decision,
            })),
          },
    ),
  }
}
export function unresolvedSelectionGroups(
  draft: ComponentSelectionDraft,
): GroupSelection[] {
  return draft.groups.filter(
    (group) =>
      !group.candidates.some((candidate) => candidate.decision === "preferred"),
  )
}
export type SelectionImportError = "tooLarge" | "invalid" | "mismatch"
export type SelectionImportResult =
  | { ok: true; draft: ComponentSelectionDraft }
  | { ok: false; error: SelectionImportError }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function text(value: unknown, max = selectionTextLimit): value is string {
  return typeof value === "string" && value.length <= max
}
/** Entire draft is validated before replacing caller state. Imported catalog metadata is never trusted. */
export function parseSelectionDraft(
  source: string,
  template: SelectionTemplate,
): SelectionImportResult {
  if (new TextEncoder().encode(source).byteLength > selectionImportLimit)
    return { ok: false, error: "tooLarge" }
  try {
    const value: unknown = JSON.parse(source)
    if (
      !record(value) ||
      value.format !== "easyuseui.component-selection" ||
      value.schemaVersion !== 1
    )
      return { ok: false, error: "invalid" }
    if (
      value.templateId !== template.id ||
      value.templateRevision !== template.revision
    )
      return { ok: false, error: "mismatch" }
    if (
      !text(value.projectName, 160) ||
      !text(value.goal) ||
      !text(value.constraints) ||
      !Array.isArray(value.groups) ||
      value.groups.length !== template.groups.length
    )
      return { ok: false, error: "invalid" }
    const groups: GroupSelection[] = []
    const seen = new Set<string>()
    for (const input of value.groups) {
      if (!record(input) || typeof input.id !== "string" || seen.has(input.id))
        return { ok: false, error: "invalid" }
      seen.add(input.id)
      const definition = template.groups.find((group) => group.id === input.id)
      if (
        !definition ||
        !text(input.requirement) ||
        !Array.isArray(input.candidates) ||
        input.candidates.length !== definition.candidates.length
      )
        return { ok: false, error: "invalid" }
      const ids = new Set<string>()
      const candidates: CandidateSelection[] = []
      for (const item of input.candidates) {
        if (
          !record(item) ||
          typeof item.id !== "string" ||
          ids.has(item.id) ||
          !definition.candidates.some(
            (candidate) => candidate.id === item.id,
          ) ||
          !text(item.note) ||
          !["undecided", "preferred", "alternative", "rejected"].includes(
            String(item.decision),
          )
        )
          return { ok: false, error: "invalid" }
        ids.add(item.id)
        candidates.push({
          id: item.id,
          note: item.note,
          decision: item.decision as SelectionDecision,
        })
      }
      if (
        candidates.filter((candidate) => candidate.decision === "preferred")
          .length > 1
      )
        return { ok: false, error: "invalid" }
      groups.push({
        id: input.id,
        requirement: input.requirement,
        candidates: definition.candidates.map((candidate) =>
          candidates.find((item) => item.id === candidate.id)!,
        ),
      })
    }
    return {
      ok: true,
      draft: {
        format: "easyuseui.component-selection",
        schemaVersion: 1,
        templateId: template.id,
        templateRevision: template.revision,
        projectName: value.projectName,
        goal: value.goal,
        constraints: value.constraints,
        groups: template.groups.map((group) =>
          groups.find((item) => item.id === group.id)!,
        ),
      },
    }
  } catch {
    return { ok: false, error: "invalid" }
  }
}
/** A handoff keeps all alternatives, exclusions and notes, including unresolved groups. */
export function createSelectionHandoff(
  draft: ComponentSelectionDraft,
  template: SelectionTemplate,
) {
  return {
    ...draft,
    catalog: template.groups,
    unresolvedGroupIds: unresolvedSelectionGroups(draft).map(
      (group) => group.id,
    ),
  }
}
