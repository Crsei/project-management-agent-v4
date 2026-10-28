import type { ToolId, WorkspaceAgent } from "./fixtures"

export type SessionConfiguration = {
  tools: ToolId[]
  agentId: string | null
  workflowId: string | null
  mode: "plan" | "review"
}

export const emptyConfiguration = (): SessionConfiguration => ({ tools: [], agentId: null, workflowId: null, mode: "plan" })

export function toggleTool(configuration: SessionConfiguration, id: ToolId): SessionConfiguration {
  return { ...configuration, tools: configuration.tools.includes(id) ? configuration.tools.filter((tool) => tool !== id) : [...configuration.tools, id] }
}

export function selectAgentConfiguration(configuration: SessionConfiguration, agent: WorkspaceAgent): SessionConfiguration {
  return { ...configuration, agentId: agent.id, tools: Array.from(new Set([...configuration.tools, ...agent.tools])) }
}

export function createLocalAgent(name: string, description: string, tools: ToolId[], id: string): WorkspaceAgent | null {
  const normalizedName = name.trim()
  const normalizedDescription = description.trim()
  if (!normalizedName || !normalizedDescription) return null
  return { id, name: { "zh-CN": normalizedName, en: normalizedName }, shortName: { "zh-CN": normalizedName, en: normalizedName }, description: { "zh-CN": normalizedDescription, en: normalizedDescription }, tools: [...tools], kind: "review", prompt: { "zh-CN": `请${normalizedName}帮我`, en: `Ask ${normalizedName} to ` } }
}
