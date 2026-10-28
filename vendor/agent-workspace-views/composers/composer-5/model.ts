import type { AppId, WorkspaceReference } from "./fixtures.ts"
import { references } from "./fixtures.ts"
import type { Copy } from "../../model.ts"

export type SourceState = { connected: AppId[]; selectedIds: string[] }
export function setConnection(state: SourceState, app: AppId, connected: boolean): SourceState {
  return {
    connected: connected ? [...new Set([...state.connected, app])] : state.connected.filter(id => id !== app),
    selectedIds: connected ? state.selectedIds : state.selectedIds.filter(id => references.find(r => r.id === id)?.app !== app),
  }
}
export function selectReference(state: SourceState, id: string): SourceState {
  const reference = references.find(r => r.id === id)
  if (!reference || !state.connected.includes(reference.app)) return state
  return { ...state, selectedIds: state.selectedIds.includes(id) ? state.selectedIds.filter(value => value !== id) : [...state.selectedIds, id] }
}
export function evidenceForPrompt(state: SourceState, text: string): WorkspaceReference[] {
  const available = references.filter(r => state.connected.includes(r.app))
  if (state.selectedIds.length) return available.filter(r => state.selectedIds.includes(r.id))
  const query = text.toLowerCase()
  const ids = /csv/.test(query) ? [] : /atlas|project|migration|项目|迁移/.test(query) ? ["project", "brief"]
    : /brief|launch|简报|发布/.test(query) ? ["brief", "discussion", "project"]
      : /meeting|follow.up|会议|跟进/.test(query) ? ["meeting", "discussion"] : references.map(r => r.id)
  return available.filter(r => ids.includes(r.id))
}
export function buildReply(evidence: WorkspaceReference[]): Copy {
  const compose = (locale: "zh-CN" | "en") => {
    const intro = locale === "en" ? "Local workspace example — based only on the selected fixture sources, not an external model or app."
      : "本地工作空间示例——仅依据已选的固定来源，没有调用外部模型或应用。"
    if (!evidence.length) return `${intro}\n\n${locale === "en" ? "No connected source matches this question. Connect a fixture source or choose a reference before asking for source-backed details." : "没有与问题匹配的已连接来源。连接示例来源或选择引用后，再询问有依据的细节。"}`
    return `${intro}\n\n${evidence.map((r, i) => `### ${i + 1}. ${r.name}\n${r.content[locale]}`).join("\n\n")}\n\n${locale === "en" ? "Review the sources below before using these details in your follow-up or brief." : "将这些信息用于跟进邮件或简报前，请核对下方来源。"}`
  }
  return { "zh-CN": compose("zh-CN"), en: compose("en") }
}
