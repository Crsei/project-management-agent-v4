import { createSkills, type Skill, type SkillSnapshot, type SkillVersion } from "./fixtures.ts"

export type SkillDialog = "metadata" | "instructions" | "add" | "upload" | "expanded" | "history" | "file" | null
export type SkillDraft = { slug: string; name: string; description: string; instructions: string; locale: "zh-CN" | "en" }
export type SkillsState = {
  skills: Skill[]
  selectedSlug: string | null
  readonly: boolean
  dataState: "ready" | "loading" | "refresh-error"
  dialog: SkillDialog
  drafts: Record<string, SkillDraft>
  error: "required" | "slug" | "duplicate" | "frontmatter" | "file" | null
  upload: { filename: string; text: string } | null
  uploadTarget: string | null
}
export function createSkillsState(scenario: string): SkillsState {
  const skills = scenario === "empty" || scenario === "loading" ? [] : createSkills()
  if (scenario === "long-content") {
    skills[0] = { ...skills[0], name: "agents-sdk · production architecture and durable application review", description: { "zh-CN": skills[0].description["zh-CN"].repeat(6), en: skills[0].description.en.repeat(6) } }
  }
  return { skills, selectedSlug: skills[0]?.slug ?? null, readonly: scenario === "readonly", dataState: scenario === "loading" ? "loading" : scenario === "refresh-error" ? "refresh-error" : "ready", dialog: null, drafts: {}, error: null, upload: null, uploadTarget: null }
}
export function selectSkill(state: SkillsState, slug: string): SkillsState {
  return state.skills.some((skill) => skill.slug === slug) ? { ...state, selectedSlug: slug } : state
}
export function draftKey(state: SkillsState, dialog = state.dialog): string {
  return dialog === "add" ? "add" : dialog === "upload" ? `upload:${state.uploadTarget ?? "new"}` : `${state.selectedSlug}:${dialog}`
}
export function openSkillDialog(state: SkillsState, dialog: NonNullable<SkillDialog>, locale: "zh-CN" | "en", uploadTarget: string | null = null): SkillsState {
  if (state.dataState === "loading" || state.readonly && ["metadata", "instructions", "add", "upload"].includes(dialog)) return state
  const skill = state.skills.find((item) => item.slug === state.selectedSlug)
  if (!skill && !["add", "upload"].includes(dialog)) return state
  const key = draftKey(dialog === "upload" ? { ...state, uploadTarget } : state, dialog)
  const draft = state.drafts[key] ?? {
    slug: dialog === "upload" ? uploadTarget ?? "" : dialog === "add" ? "" : skill?.slug ?? "",
    name: dialog === "add" ? "" : skill?.name ?? "",
    description: dialog === "add" ? "" : skill?.description[locale] ?? "",
    instructions: skill?.instructions ?? "",
    locale,
  }
  return { ...state, dialog, error: null, uploadTarget: dialog === "upload" ? uploadTarget : state.uploadTarget, upload: dialog === "upload" && uploadTarget !== state.uploadTarget ? null : state.upload, drafts: { ...state.drafts, [key]: draft } }
}
export function updateSkillDraft(state: SkillsState, patch: Partial<SkillDraft>): SkillsState {
  const key = draftKey(state)
  return state.drafts[key] ? { ...state, error: null, drafts: { ...state.drafts, [key]: { ...state.drafts[key], ...patch } } } : state
}
/** Explicit Cancel discards only the current transaction; Escape/close retains it. */
export function cancelSkillEdit(state: SkillsState): SkillsState {
  const drafts = { ...state.drafts }
  delete drafts[draftKey(state)]
  return { ...state, dialog: null, error: null, upload: null, drafts }
}
function snapshot(skill: Skill): SkillSnapshot {
  return { name: skill.name, description: skill.description, instructions: skill.instructions }
}
function revise(skill: Skill, next: SkillSnapshot, reason: SkillVersion["reason"]): Skill {
  return { ...skill, ...next, version: skill.version + 1, history: [{ ...snapshot(skill), version: skill.version, reason }, ...skill.history].slice(0, 20) }
}
export function saveSkillEdit(state: SkillsState): SkillsState {
  if (state.readonly || state.dataState === "loading") return state
  const key = draftKey(state), draft = state.drafts[key]
  if (!draft || !["metadata", "instructions", "add"].includes(state.dialog ?? "")) return state
  if (state.dialog !== "instructions" && (!draft.name.trim() || !draft.description.trim())) return { ...state, error: "required" }
  if (state.dialog === "instructions" && !draft.instructions.trim()) return { ...state, error: "required" }
  const drafts = { ...state.drafts }; delete drafts[key]
  if (state.dialog === "add") {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.slug)) return { ...state, error: "slug" }
    if (state.skills.some((item) => item.slug === draft.slug)) return { ...state, error: "duplicate" }
    const skill: Skill = { slug: draft.slug, name: draft.name.trim(), description: { "zh-CN": draft.description.trim(), en: draft.description.trim() }, instructions: `# ${draft.name.trim()}\n\n${draft.description.trim()}`, source: "local", version: 1, history: [] }
    return { ...state, skills: [...state.skills, skill], selectedSlug: skill.slug, dialog: null, drafts, error: null }
  }
  const skill = state.skills.find((item) => item.slug === state.selectedSlug)
  if (!skill) return state
  const next = state.dialog === "metadata" ? { ...snapshot(skill), name: draft.name.trim(), description: { ...skill.description, [draft.locale]: draft.description.trim() } } : { ...snapshot(skill), instructions: draft.instructions }
  const unchanged = next.name === skill.name && next.instructions === skill.instructions && next.description.en === skill.description.en && next.description["zh-CN"] === skill.description["zh-CN"]
  return { ...state, skills: unchanged ? state.skills : state.skills.map((item) => item.slug === skill.slug ? revise(item, next, state.dialog === "metadata" ? "metadata" : "instructions") : item), dialog: null, drafts, error: null }
}
export function restoreSkillVersion(state: SkillsState, version: number | "repository"): SkillsState {
  if (state.readonly) return state
  const skill = state.skills.find((item) => item.slug === state.selectedSlug)
  const target = version === "repository" ? skill?.repository : skill?.history.find((entry) => entry.version === version)
  if (!skill || !target) return state
  return { ...state, skills: state.skills.map((item) => item.slug === skill.slug ? revise(item, target, "restore") : item), error: null }
}
export function recoverSkills(state: SkillsState): SkillsState {
  if (state.dataState === "loading") {
    const skills = createSkills()
    return { ...state, skills, selectedSlug: skills[0].slug, dataState: "ready" }
  }
  return { ...state, dataState: "ready" }
}

/** Supports the skill's YAML string fields (plain, quoted, folded or literal).
 * Other frontmatter fields are ignored; imported Markdown is rendered inertly. */
export function parseSkillFile(text: string): { name: string; description: string; instructions: string } | null {
  const match = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n([\s\S]+)$/)
  if (!match) return null
  const lines = match[1].split("\n"), fields: Record<string, string> = {}
  for (let index = 0; index < lines.length; index++) {
    const field = lines[index].match(/^(name|description):\s*(.*)$/)
    if (!field) continue
    let value = field[2]
    if (/^[|>][-+]?$/.test(value)) {
      const parts: string[] = []
      while (index + 1 < lines.length && (/^\s/.test(lines[index + 1]) || lines[index + 1] === "")) parts.push(lines[++index].trim())
      value = parts.join(value.startsWith(">") ? " " : "\n").trim()
    } else if (value.startsWith('"')) {
      try { value = JSON.parse(value) } catch { return null }
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/''/g, "'")
    fields[field[1]] = value.trim()
  }
  return fields.name && fields.description && match[2].trim() ? { name: fields.name, description: fields.description, instructions: match[2] } : null
}
export function importSkillFile(state: SkillsState): SkillsState {
  if (state.readonly || state.dataState === "loading" || state.dialog !== "upload" || !state.upload) return state
  const draft = state.drafts[draftKey(state)]
  if (!draft || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.slug)) return { ...state, error: "slug" }
  const parsed = parseSkillFile(state.upload.text)
  if (!parsed) return { ...state, error: "frontmatter" }
  const existing = state.skills.find((skill) => skill.slug === draft.slug)
  const next: SkillSnapshot = { ...parsed, description: { "zh-CN": parsed.description, en: parsed.description } }
  const skill = existing ? revise(existing, next, "upload") : { ...next, slug: draft.slug, source: "upload" as const, version: 1, history: [] }
  const drafts = { ...state.drafts }; delete drafts[draftKey(state)]
  return { ...state, skills: existing ? state.skills.map((item) => item.slug === skill.slug ? skill : item) : [...state.skills, skill], selectedSlug: skill.slug, dialog: null, upload: null, drafts, error: null }
}
export function exportSkillFile(skill: Skill, locale: "zh-CN" | "en"): string {
  return `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description[locale])}\n---\n\n${skill.instructions}`
}
