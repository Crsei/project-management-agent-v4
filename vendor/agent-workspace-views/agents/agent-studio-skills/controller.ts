import { skillCollections, skillTypeLabels, studioAgents, studioSkills, type Copy, type SkillType, type StudioSkill } from "./fixtures.ts"

export type SkillDraft = { instructions: Copy; agentIds: string[] }
export type CreateDraft = { name: string; description: string; instructions: string }
export type StudioState = {
  skills: StudioSkill[]
  query: string
  type: SkillType | "all"
  sort: { field: "name" | "agents"; direction: "asc" | "desc" } | null
  selectedId: string | null
  collectionId: string | null
  collectionAgentId: string
  createOpen: boolean
  createDraft: CreateDraft
  drafts: Record<string, SkillDraft>
  dataState: "ready" | "loading" | "refresh-error"
  readonly: boolean
  feedback: Copy | null
  createError: "duplicate" | null
}

export function createStudioState(scenario: string): StudioState {
  const skills = scenario === "empty" || scenario === "loading" ? [] : structuredClone(studioSkills)
  if (scenario === "long-content") {
    skills[0].name = "signal-clustering-customer-feedback-evidence-and-recurring-opportunity-analysis"
    skills[0].description = {
      "zh-CN": "汇总来自支持工单、客户访谈和产品研究的反馈；区分来源、保留相互冲突的证据，并按客户需求而非解决方案对主题分组。",
      en: "Combine feedback from support tickets, customer interviews, and product research; distinguish sources, preserve conflicting evidence, and group themes by customer need rather than proposed solution.",
    }
    skills[0].instructions = {
      "zh-CN": Array.from({ length: 12 }, (_, i) => `${i + 1}. 保留原始来源与上下文，记录证据强度、冲突和下一步验证方法。`).join("\n\n"),
      en: Array.from({ length: 12 }, (_, i) => `${i + 1}. Preserve the original source and context. Record evidence strength, conflicting findings, and the next validation step.`).join("\n\n"),
    }
  }
  return { skills, query: "", type: "all", sort: null, selectedId: null, collectionId: null, collectionAgentId: studioAgents[0].id, createOpen: false, createDraft: { name: "", description: "", instructions: "" }, drafts: {}, dataState: scenario === "loading" ? "loading" : scenario === "refresh-error" ? "refresh-error" : "ready", readonly: scenario === "readonly", feedback: null, createError: null }
}

export function visibleStudioSkills(state: StudioState, locale: keyof Copy): StudioSkill[] {
  const query = state.query.trim().toLocaleLowerCase(locale)
  const filtered = state.skills.filter(skill => (state.type === "all" || state.type === skill.type) && (!query || [skill.name, skill.description[locale], skillTypeLabels[skill.type][locale], ...studioAgents.filter(agent => skill.agentIds.includes(agent.id)).map(agent => agent.name[locale])].some(value => value.toLocaleLowerCase(locale).includes(query))))
  if (!state.sort) return filtered
  const { field, direction } = state.sort
  return filtered.sort((a, b) => {
    const difference = field === "name" ? a.name.localeCompare(b.name, locale) : a.agentIds.length - b.agentIds.length
    return (direction === "asc" ? 1 : -1) * (difference || a.name.localeCompare(b.name, locale))
  })
}

export function sortStudioSkills(state: StudioState, field: "name" | "agents"): StudioState {
  return { ...state, sort: { field, direction: state.sort?.field === field && state.sort.direction === "asc" ? "desc" : "asc" } }
}

export function openStudioSkill(state: StudioState, id: string): StudioState {
  const skill = state.skills.find(item => item.id === id)
  if (!skill) return state
  return { ...state, selectedId: id, drafts: state.drafts[id] ? state.drafts : { ...state.drafts, [id]: { instructions: { ...skill.instructions }, agentIds: [...skill.agentIds] } } }
}

export function editStudioSkill(state: StudioState, id: string, draft: SkillDraft): StudioState {
  if (state.readonly || state.dataState === "loading" || !state.skills.some(skill => skill.id === id)) return state
  return { ...state, drafts: { ...state.drafts, [id]: { instructions: { ...draft.instructions }, agentIds: [...draft.agentIds] } } }
}

export function saveStudioSkill(state: StudioState, id: string): StudioState {
  const draft = state.drafts[id]
  if (!draft || state.readonly || state.dataState === "loading") return state
  const validIds = [...new Set(draft.agentIds)].filter(agentId => studioAgents.some(agent => agent.id === agentId))
  return { ...state, skills: state.skills.map(skill => skill.id === id ? { ...skill, instructions: { ...draft.instructions }, agentIds: validIds, updated: { "zh-CN": "刚刚", en: "Just now" } } : skill), selectedId: null, feedback: { "zh-CN": "已在本地工作区保存更改。", en: "Changes saved in the local workspace." } }
}

export function assignStudioCollection(state: StudioState, collectionId: string, agentId: string): StudioState {
  const collection = skillCollections.find(item => item.id === collectionId)
  if (!collection || !studioAgents.some(agent => agent.id === agentId) || state.readonly || state.dataState === "loading") return state
  const skills = [...state.skills]
  const drafts = { ...state.drafts }
  for (const id of collection.skillIds) {
    const index = skills.findIndex(skill => skill.id === id)
    const current = index === -1 ? { ...structuredClone(studioSkills.find(skill => skill.id === id)!), agentIds: [] } : skills[index]
    const agentIds = [...new Set([...current.agentIds, agentId])]
    const updated = { ...current, agentIds, updated: { "zh-CN": "刚刚", en: "Just now" } }
    if (index === -1) skills.push(updated)
    else skills[index] = updated
    if (drafts[id]) drafts[id] = { ...drafts[id], agentIds: [...new Set([...drafts[id].agentIds, agentId])] }
  }
  return { ...state, skills, drafts, collectionId: null, feedback: { "zh-CN": `已在本地将 ${collection.skillIds.length} 项技能分配给所选 Agent。`, en: `${collection.skillIds.length} skills assigned to the selected agent locally.` } }
}

export function createStudioSkill(state: StudioState, locale: keyof Copy, id: string): StudioState {
  const name = state.createDraft.name.trim()
  if (!name || state.readonly || state.dataState === "loading") return state
  if (state.skills.some(skill => skill.name.toLowerCase() === name.toLowerCase())) return { ...state, createError: "duplicate" }
  const description = state.createDraft.description.trim()
  const instructions = state.createDraft.instructions.trim()
  const skill: StudioSkill = { id, name, type: "Writing", description: { "zh-CN": description, en: description }, instructions: { "zh-CN": instructions, en: instructions }, author: locale === "en" ? "You" : "你", updated: { "zh-CN": "刚刚", en: "Just now" }, agentIds: [] }
  return { ...state, skills: [skill, ...state.skills], createOpen: false, createDraft: { name: "", description: "", instructions: "" }, createError: null, feedback: { "zh-CN": "已创建本地技能；尚未分配给 Agent。", en: "Local skill created; not assigned to an agent yet." } }
}

export function recoverStudioSkills(state: StudioState): StudioState {
  if (state.dataState === "ready") return state
  return { ...state, skills: state.dataState === "loading" ? structuredClone(studioSkills) : state.skills, dataState: "ready", feedback: { "zh-CN": "本地示例数据已加载；未连接远程服务。", en: "Local example data loaded; no remote service is connected." } }
}
