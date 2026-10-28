"use client"

import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react"
import { useComposerDemoController } from "../../demo-controller"
import type { ComposerController } from "../../controller"
import type { ComposerDemoSource } from "../../demo-source"
import type { Draft } from "../../model"
import type { RemainingPageProps } from "../../showcase/model"
import { useRemainingPageState } from "../../showcase/state"
import { agentItems, createComposer4Source, toolItems, workflowItems, type ToolId, type WorkspaceAgent } from "./fixtures"

import { createLocalAgent, emptyConfiguration, selectAgentConfiguration, toggleTool, type SessionConfiguration } from "./model"
export type Composer4State = {
  agents: WorkspaceAgent[]
  configuration: Record<string, SessionConfiguration>
  sidebarTab: "create" | "activity"
  unread: number
  loaded: boolean
  refreshFailed: boolean
  globalCollapsed: boolean
  sessionsVisible: boolean
  sequence: number
}


export type Composer4Panel = "connections" | "configure" | "build" | "library" | "workflow" | "voice" | "deliverables" | null
export type Composer4Controller = ComposerController & {
  state: Composer4State
  setState: Dispatch<SetStateAction<Composer4State>>
  configuration: SessionConfiguration
  updateConfiguration: (next: SessionConfiguration) => void
  chooseAgent: (agent: WorkspaceAgent) => void
  addAgent: (name: string, description: string, tools: ToolId[]) => boolean
  chooseWorkflow: (id: string) => void
  canEdit: boolean
  readonly: boolean
  panel: Composer4Panel
  setPanel: Dispatch<SetStateAction<Composer4Panel>>
  libraryQuery: string
  setLibraryQuery: Dispatch<SetStateAction<string>>
  scroll: RefObject<HTMLDivElement | null>
  toggleTool: (id: ToolId) => void
  loadFixtures: () => void
}

export function useComposer4Controller({ scenario, active, cache }: RemainingPageProps): Composer4Controller {
  const cacheKey = `composer-4:${scenario}`
  const [state, setState] = useRemainingPageState<Composer4State>(`${cacheKey}:workspace`, () => ({
    agents: scenario === "empty" || scenario === "loading" ? [] : structuredClone(agentItems),
    configuration: {}, sidebarTab: "create", unread: 3, loaded: scenario !== "loading", refreshFailed: scenario === "refresh-error", globalCollapsed: false, sessionsVisible: true, sequence: 0,
  }))
  const [source] = useState(() => (cache.get(`${cacheKey}:source`) as ComposerDemoSource | undefined) ?? createComposer4Source(scenario))
  const base = useComposerDemoController(source, active)
  const readonly = scenario === "readonly"
  const canEdit = !readonly && state.loaded
  const configuration = state.configuration[base.selectedId] ?? emptyConfiguration()
  const [panel, setPanel] = useState<Composer4Panel>(null)
  const [libraryQuery, setLibraryQuery] = useState("")
  const scroll = useRef<HTMLDivElement>(null)
  const saved = useRef((cache.get(`${cacheKey}:position`) as Record<string, { scroll: number; textareaScroll: number; start: number; end: number }> | undefined) ?? {})

  useEffect(() => {
    cache.set(`${cacheKey}:source`, { ...source, sessions: base.sessions, selectedId: base.selectedId, projectId: base.projectId, drafts: base.drafts })
  }, [cache, cacheKey, source, base.sessions, base.selectedId, base.projectId, base.drafts])
  useLayoutEffect(() => {
    if (!active) return
    const position = saved.current[base.selectedId]
    const frame = requestAnimationFrame(() => {
      if (scroll.current) scroll.current.scrollTop = position?.scroll ?? 0
      const field = base.textarea.current
      if (position && field) {
        field.setSelectionRange(position.start, position.end)
        field.scrollTop = position.textareaScroll ?? 0
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [active, base.selectedId, base.textarea])
  function rememberPosition() {
    base.rememberPosition()
    const field = base.textarea.current
    saved.current[base.selectedId] = { scroll: scroll.current?.scrollTop ?? 0, textareaScroll: field?.scrollTop ?? 0, start: field?.selectionStart ?? 0, end: field?.selectionEnd ?? 0 }
    cache.set(`${cacheKey}:position`, saved.current)
  }
  function updateConfiguration(next: SessionConfiguration) {
    if (!canEdit) return
    setState((previous) => ({ ...previous, configuration: { ...previous.configuration, [base.selectedId]: next } }))
  }
  function chooseAgent(agent: WorkspaceAgent) {
    if (!canEdit) return
    updateConfiguration(selectAgentConfiguration(configuration, agent))
    base.updateDraft({ text: base.draft.text.trim() ? base.draft.text : base.copy(agent.prompt) })
    setPanel(null)
    base.focusComposer()
  }
  function newSession(nextProject = base.projectId) {
    if (!canEdit) return
    rememberPosition()
    const nextSequence = state.sequence + 1
    const id = `composer-4-session-${nextSequence}`
    setState((previous) => ({ ...previous, sequence: nextSequence }))
    base.setSessions((previous) => [{ id, projectId: nextProject, title: { "zh-CN": "新会话", en: "New session" }, messages: [] }, ...previous])
    base.selectSession({ id, projectId: nextProject, title: { "zh-CN": "新会话", en: "New session" }, messages: [] })
    base.focusComposer()
  }
  function sendMessage() {
    const text = base.draft.text.trim()
    if (!canEdit || !text || !active) return
    const sequence = state.sequence + 1
    const selectedAgent = state.agents.find((agent) => agent.id === configuration.agentId)
    const contexts = [`GPT-${base.draft.model}`, configuration.mode === "review" ? base.label("审查模式", "Review mode") : base.label("规划模式", "Plan mode"), ...base.activeContexts.map((item) => item.name), ...configuration.tools.map((id) => `${toolItems.find((tool) => tool.id === id)!.name} · ${base.label("本地选择", "Local selection")}`), ...(selectedAgent ? [base.copy(selectedAgent.name)] : []), ...(configuration.workflowId ? [base.copy(workflowItems.find((workflow) => workflow.id === configuration.workflowId)!.name)] : [])]
    base.setSessions((previous) => previous.map((session) => session.id === base.selectedId ? { ...session, title: session.messages.length ? session.title : text.slice(0, 80), messages: [...session.messages, { id: `composer-4-user-${sequence}`, role: "user", text, contexts }, { id: `composer-4-plan-${sequence}`, role: "assistant", text: source.reply }] } : session))
    setState((previous) => ({ ...previous, sequence }))
    base.updateDraft({ text: "", contextIds: [] })
    base.focusComposer()
  }
  function addAgent(name: string, description: string, tools: ToolId[]) {
    if (!canEdit) return false
    const agent = createLocalAgent(name, description, tools, `custom-${state.sequence + 1}`)
    if (!agent) return false
    setState((previous) => ({ ...previous, sequence: previous.sequence + 1, agents: [...previous.agents, agent], configuration: { ...previous.configuration, [base.selectedId]: selectAgentConfiguration(configuration, agent) } }))
    if (!base.draft.text.trim()) base.updateDraft({ text: base.copy(agent.prompt) })
    setPanel(null)
    base.focusComposer()
    return true
  }
  function chooseWorkflow(id: string) {
    const workflow = workflowItems.find((item) => item.id === id)
    if (!canEdit || !workflow) return
    updateConfiguration({ ...configuration, workflowId: id, tools: Array.from(new Set([...configuration.tools, ...workflow.tools])) })
    if (!base.draft.text.trim()) base.updateDraft({ text: base.copy(workflow.prompt) })
    setPanel(null)
    base.focusComposer()
  }
  const updateDraft = (patch: Partial<Draft>) => { if (canEdit) base.updateDraft(patch) }
  return {
    ...base, updateDraft, sendMessage, newSession, rememberPosition,
    selectProject: (id: string) => {
      const existing = base.sessions.find((session) => session.projectId === id)
      if (existing) base.selectSession(existing)
      else newSession(id)
    },
    globalCollapsed: state.globalCollapsed,
    setGlobalCollapsed: (action: boolean | ((previous: boolean) => boolean)) => setState((previous) => ({ ...previous, globalCollapsed: typeof action === "function" ? action(previous.globalCollapsed) : action })),
    sessionsVisible: state.sessionsVisible,
    setSessionsVisible: (action: boolean | ((previous: boolean) => boolean)) => setState((previous) => ({ ...previous, sessionsVisible: typeof action === "function" ? action(previous.sessionsVisible) : action })),
    canSend: canEdit,
    state, setState, configuration, updateConfiguration, chooseAgent, addAgent, chooseWorkflow,
    canEdit, readonly, panel, setPanel, libraryQuery, setLibraryQuery, scroll,
    toggleTool: (id: ToolId) => updateConfiguration(toggleTool(configuration, id)),
    removeContext: (id: string) => { if (canEdit) base.removeContext(id) },
    toggleContext: (id: string) => { if (canEdit) base.toggleContext(id) },
    loadFixtures: () => setState((previous) => ({ ...previous, loaded: true, refreshFailed: false, agents: previous.agents.length ? previous.agents : structuredClone(agentItems) })),
  }
}


