import { initialEnabled, initialInstalled, skillsFixture, type Skill } from "./fixtures.ts"

export type SkillDraft = { name: string; description: string; instructions: string }
export type SkillsState = {
  skills: Skill[]
  installed: string[]
  enabled: string[]
  query: string
  selectedId: string | null
  dialog: "closed" | "detail" | "edit" | "create"
  createDraft: SkillDraft
  instructionDrafts: Record<string, string>
  savedInstructions: Record<string, string>
  dataState: "ready" | "loading" | "refresh-error"
  readonly: boolean
  nextId: number
  notice: { "zh-CN": string; en: string } | null
}

const emptyDraft = (): SkillDraft => ({ name: "", description: "", instructions: "" })
export function createSkillsState(scenario: string): SkillsState {
  const skills = scenario === "empty" ? [] : skillsFixture.map((skill) =>
    scenario === "long-content" ? {
      ...skill,
      name: { "zh-CN": `${skill.name["zh-CN"]}：跨团队项目与复杂决策的完整工作流程`, en: `${skill.name.en}: a complete workflow for cross-functional projects and complex decisions` },
      description: { "zh-CN": `${skill.description["zh-CN"]} 请保留完整背景、证据来源、负责人和约束，并清晰记录无法确认的结论。`, en: `${skill.description.en} Preserve the full context, evidence sources, ownership, and constraints, and clearly record any conclusions that cannot be confirmed.` },
      instructions: { "zh-CN": Array(12).fill(skill.instructions["zh-CN"]).join("\n\n"), en: Array(12).fill(skill.instructions.en).join("\n\n") },
    } : { ...skill },
  )
  return {
    skills, installed: scenario === "empty" ? [] : [...initialInstalled],
    enabled: scenario === "empty" ? [] : [...initialEnabled],
    query: "", selectedId: null, dialog: "closed", createDraft: emptyDraft(),
    instructionDrafts: {}, savedInstructions: {},
    dataState: scenario === "loading" ? "loading" : scenario === "refresh-error" ? "refresh-error" : "ready",
    readonly: scenario === "readonly", nextId: 1, notice: null,
  }
}

export function filterSkills(state: SkillsState): Skill[] {
  const query = state.query.trim().toLocaleLowerCase()
  if (!query) return state.skills
  return state.skills.filter((skill) =>
    [skill.name.en, skill.name["zh-CN"], skill.description.en, skill.description["zh-CN"], skill.author.en, skill.author["zh-CN"]]
      .some((value) => value.toLocaleLowerCase().includes(query)),
  )
}
export function installedSkills(state: SkillsState): Skill[] {
  const matched = new Map(filterSkills(state).map((skill) => [skill.id, skill]))
  return state.installed.flatMap((id) => matched.has(id) ? [matched.get(id)!] : [])
}
export function skillsCounts(state: SkillsState) {
  return { installed: state.installed.length, enabled: state.enabled.length, recent: filterSkills(state).length }
}
export function canModifySkills(state: SkillsState): boolean {
  return !state.readonly && state.dataState !== "loading"
}
export function openSkill(state: SkillsState, id: string): SkillsState {
  return state.skills.some((skill) => skill.id === id) ? { ...state, selectedId: id, dialog: "detail" } : state
}
export function installSkill(state: SkillsState, id: string): SkillsState {
  const skill = state.skills.find((item) => item.id === id)
  if (!canModifySkills(state) || !skill || state.installed.includes(id)) return state
  return { ...state, installed: [...state.installed, id], enabled: [...state.enabled, id], notice: { "zh-CN": `已在本地会话安装并启用「${skill.name["zh-CN"]}」。`, en: `${skill.name.en} installed and enabled in this local session.` } }
}
export function setSkillEnabled(state: SkillsState, id: string, enabled: boolean): SkillsState {
  if (!canModifySkills(state) || !state.installed.includes(id)) return state
  return { ...state, enabled: enabled ? state.enabled.includes(id) ? state.enabled : [...state.enabled, id] : state.enabled.filter((item) => item !== id) }
}
export function removeSkill(state: SkillsState, id: string): SkillsState {
  const skill = state.skills.find((item) => item.id === id)
  if (!canModifySkills(state) || !skill || !state.installed.includes(id)) return state
  return { ...state, installed: state.installed.filter((item) => item !== id), enabled: state.enabled.filter((item) => item !== id), dialog: "closed", selectedId: null, notice: { "zh-CN": `已从本地已安装列表移除「${skill.name["zh-CN"]}」，仍可重新安装。`, en: `${skill.name.en} removed from the local installed list; it can be installed again.` } }
}
export function beginInstructionEdit(state: SkillsState, locale: "zh-CN" | "en"): SkillsState {
  const skill = state.skills.find((item) => item.id === state.selectedId)
  if (!canModifySkills(state) || !skill || !state.installed.includes(skill.id)) return state
  return { ...state, dialog: "edit", instructionDrafts: { ...state.instructionDrafts, [skill.id]: state.instructionDrafts[skill.id] ?? state.savedInstructions[skill.id] ?? skill.instructions[locale] } }
}
export function saveInstructions(state: SkillsState): SkillsState {
  const id = state.selectedId
  const draft = id ? state.instructionDrafts[id]?.trim() : ""
  if (!canModifySkills(state) || !id || !draft || !state.installed.includes(id)) return state
  return { ...state, savedInstructions: { ...state.savedInstructions, [id]: draft }, instructionDrafts: { ...state.instructionDrafts, [id]: draft }, dialog: "detail", notice: { "zh-CN": "技能指令已保存到本地会话。", en: "Skill instructions saved in this local session." } }
}
export function cancelInstructionEdit(state: SkillsState): SkillsState {
  const drafts = { ...state.instructionDrafts }
  if (state.selectedId) delete drafts[state.selectedId]
  return { ...state, dialog: "detail", instructionDrafts: drafts }
}
export function validSkillDraft(draft: SkillDraft): boolean {
  return Boolean(draft.name.trim() && draft.description.trim() && draft.instructions.trim())
}
export function createSkill(state: SkillsState): SkillsState {
  if (!canModifySkills(state) || !validSkillDraft(state.createDraft)) return state
  const draft = state.createDraft
  const id = `local-skill-${state.nextId}`
  const same = (value: string) => ({ "zh-CN": value.trim(), en: value.trim() })
  const skill: Skill = { id, name: same(draft.name), description: same(draft.description), instructions: same(draft.instructions), author: { "zh-CN": "你", en: "You" }, category: "writing", added: { "zh-CN": "刚刚", en: "Just now" }, icon: "file", source: "custom" }
  return { ...state, skills: [skill, ...state.skills], installed: [id, ...state.installed], enabled: [...state.enabled, id], query: "", nextId: state.nextId + 1, createDraft: emptyDraft(), dialog: "closed", selectedId: null, notice: { "zh-CN": `已在本地会话创建并启用「${draft.name.trim()}」。`, en: `${draft.name.trim()} created and enabled in this local session.` } }
}
export function recoverSkills(state: SkillsState): SkillsState {
  return { ...state, dataState: "ready", notice: { "zh-CN": "本地技能示例已就绪；没有请求远程安装服务。", en: "The local skill sample is ready; no remote installation service was requested." } }
}
