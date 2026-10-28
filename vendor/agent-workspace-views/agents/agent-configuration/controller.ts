import { environments, initialInstructions, models, previousInstructions, testMessage, tools, type ToolId } from "./fixtures.ts"

export type AgentConfig = {
  name: string
  description: string
  model: string
  environment: string
  instructions: string
  output: "text" | "json"
  maxTurns: string
  tools: ToolId[]
  approval: boolean
}
export type Version = { number: number; summary: string; savedAt: string; config: AgentConfig }
export type PreviewRun = {
  id: number
  config: AgentConfig
  prompt: string
  step: number
  status: "running" | "waiting" | "completed" | "cancelled" | "failed"
  ticket: "not-requested" | "waiting" | "approved" | "rejected" | "simulated"
}
export type ConfigurationState = {
  config: AgentConfig
  baseline: AgentConfig
  versions: Version[]
  section: "configuration" | "tools" | "versions"
  previewMode: "test" | "json"
  selectedVersion: number | null
  testMessage: string
  run: PreviewRun | null
  nextRunId: number
  data: "success" | "loading" | "error"
  readonly: boolean
  errors: Partial<Record<keyof AgentConfig | "testMessage", string>>
  notice: "saved" | "restored" | "discarded" | null
  scroll: number
}
const clone = (config: AgentConfig): AgentConfig => ({ ...config, tools: [...config.tools] })
export function createConfigurationState(scenario: string): ConfigurationState {
  const config: AgentConfig = {
    name: "Support triage", description: "Resolve common questions and route the rest to the right team.",
    model: models[0], environment: "production", instructions: initialInstructions, output: "text", maxTurns: "12",
    tools: ["file_search", "create_ticket"], approval: true,
  }
  const versions: Version[] = [
    { number: 3, summary: "Add escalation policy and source citations", savedAt: "Sep 11, 2026 · 10:24", config: clone(config) },
    { number: 2, summary: "Connect the customer help center", savedAt: "Sep 8, 2026 · 15:42", config: { ...clone(config), instructions: previousInstructions, tools: ["file_search"] } },
  ]
  if (scenario === "empty") { config.name = ""; config.description = ""; config.instructions = ""; config.tools = []; versions.length = 0 }
  if (scenario === "long-content") {
    config.name = "Support triage · Enterprise accounts and subscription billing"
    config.instructions = initialInstructions + "\n\n" + Array.from({ length: 16 }, (_, i) => `${i + 5}. Check the customer's account context, cite approved sources, and escalate sensitive changes. Never disclose account information or commit a refund without authorized review.`).join("\n\n")
  }
  return { config, baseline: clone(config), versions, section: "configuration", previewMode: "test", selectedVersion: null, testMessage, run: null, nextRunId: 1, data: scenario === "loading" ? "loading" : scenario === "refresh-error" ? "error" : "success", readonly: scenario === "readonly", errors: {}, notice: null, scroll: 0 }
}
export function isDirty(state: ConfigurationState) { return JSON.stringify(state.config) !== JSON.stringify(state.baseline) }
export function validateConfig(config: AgentConfig): ConfigurationState["errors"] {
  const errors: ConfigurationState["errors"] = {}
  if (!config.name.trim()) errors.name = "required"
  if (!config.instructions.trim()) errors.instructions = "required"
  if (!/^\d+$/.test(config.maxTurns) || Number(config.maxTurns) < 1 || Number(config.maxTurns) > 50) errors.maxTurns = "range"
  return errors
}
export function configurationJson(config: AgentConfig) {
  return JSON.stringify({ name: config.name, model: config.model, instructions: config.instructions, environment: environments.find((e) => e.value === config.environment)?.label.en, tools: config.tools.map((name) => ({ name })), output_format: config.output, require_approval: config.approval, max_turns: /^\d+$/.test(config.maxTurns) ? Number(config.maxTurns) : config.maxTurns }, null, 2)
}
export type ConfigurationAction =
  | { type: "field"; field: "name" | "description" | "instructions" | "maxTurns"; value: string }
  | { type: "model" | "environment" | "output"; value: string }
  | { type: "tool"; id: ToolId; checked: boolean }
  | { type: "approval"; checked: boolean }
  | { type: "section"; value: ConfigurationState["section"] }
  | { type: "preview-mode"; value: ConfigurationState["previewMode"] }
  | { type: "select-version"; number: number | null }
  | { type: "restore"; number: number }
  | { type: "save"; summary: string; savedAt: string }
  | { type: "discard" | "recover" | "run" | "clear" | "cancel" }
  | { type: "test-message"; value: string }
  | { type: "tick"; id: number; step: number }
  | { type: "decision"; id: number; approved: boolean }
  | { type: "scroll"; value: number }
export function configurationTransition(state: ConfigurationState, action: ConfigurationAction): ConfigurationState {
  const writable = !state.readonly && state.data !== "loading"
  const changed = (config: AgentConfig): ConfigurationState => ({ ...state, config, errors: {}, notice: null })
  switch (action.type) {
    case "field": return writable ? changed({ ...state.config, [action.field]: action.value }) : state
    case "model": return writable && models.some((m) => m === action.value) ? changed({ ...state.config, model: action.value }) : state
    case "environment": return writable && environments.some((e) => e.value === action.value) ? changed({ ...state.config, environment: action.value }) : state
    case "output": return writable && (action.value === "text" || action.value === "json") ? changed({ ...state.config, output: action.value }) : state
    case "tool": {
      if (!writable || !tools.some((t) => t.id === action.id)) return state
      const selected = new Set(state.config.tools)
      if (action.checked) selected.add(action.id); else selected.delete(action.id)
      return changed({ ...state.config, tools: tools.filter((t) => selected.has(t.id)).map((t) => t.id) })
    }
    case "approval": return writable ? changed({ ...state.config, approval: action.checked }) : state
    case "section": return { ...state, section: action.value }
    case "preview-mode": return { ...state, previewMode: action.value }
    case "select-version": return action.number === null || state.versions.some((v) => v.number === action.number) ? { ...state, selectedVersion: action.number } : state
    case "restore": {
      const version = state.versions.find((v) => v.number === action.number)
      return writable && version ? { ...state, config: clone(version.config), selectedVersion: null, section: "configuration", errors: {}, notice: "restored" } : state
    }
    case "save": {
      if (!writable || !isDirty(state)) return state
      const errors = validateConfig(state.config)
      if (Object.keys(errors).length) return { ...state, errors }
      const snapshot = clone(state.config)
      return { ...state, baseline: snapshot, versions: [{ number: Math.max(0, ...state.versions.map((v) => v.number)) + 1, summary: action.summary.trim() || "Update agent configuration", savedAt: action.savedAt, config: clone(snapshot) }, ...state.versions], errors: {}, notice: "saved" }
    }
    case "discard": return writable ? { ...state, config: clone(state.baseline), errors: {}, notice: "discarded" } : state
    case "recover": return { ...state, data: "success" }
    case "test-message": return { ...state, testMessage: action.value, errors: { ...state.errors, testMessage: undefined } }
    case "run": {
      if (state.data === "loading" || state.run?.status === "running" || state.run?.status === "waiting") return state
      const errors = validateConfig(state.config)
      if (!state.testMessage.trim()) errors.testMessage = "required"
      if (Object.keys(errors).length) return { ...state, errors }
      return { ...state, errors: {}, previewMode: "test", nextRunId: state.nextRunId + 1, run: { id: state.nextRunId, config: clone(state.config), prompt: state.testMessage, step: 0, status: "running", ticket: "not-requested" } }
    }
    case "tick": {
      const run = state.run
      if (!run || run.id !== action.id || run.step !== action.step || run.status !== "running") return state
      const step = run.step + 1
      if (step > Number(run.config.maxTurns)) return { ...state, run: { ...run, status: "failed" } }
      if (step === 3 && run.config.tools.includes("create_ticket") && run.config.approval) return { ...state, run: { ...run, step, status: "waiting", ticket: "waiting" } }
      return { ...state, run: { ...run, step, status: step >= 4 ? "completed" : "running", ticket: step === 3 && run.config.tools.includes("create_ticket") ? "simulated" : run.ticket } }
    }
    case "decision": {
      const run = state.run
      if (!run || run.id !== action.id || run.status !== "waiting") return state
      return { ...state, run: { ...run, status: "running", ticket: action.approved ? "approved" : "rejected" } }
    }
    case "cancel": return state.run && ["running", "waiting"].includes(state.run.status) ? { ...state, run: { ...state.run, status: "cancelled" } } : state
    case "clear": return { ...state, run: null }
    case "scroll": return { ...state, scroll: action.value }
  }
}
export function previewResponse(run: PreviewRun, locale: string) {
  const zh = locale !== "en"
  const summary = zh ? "先核对两笔扣款是否均已入账，不承诺退款。确认重复扣款后，交由账单团队审核。" : "First check whether both charges have settled; do not promise a refund. If the duplicate charge is confirmed, route it to the billing team for review."
  const next = run.ticket === "rejected" ? (zh ? "工单模拟已拒绝；请人工联系账单团队。" : "Ticket simulation rejected; contact the billing team manually.") : run.config.tools.includes("create_ticket") ? (zh ? "工单仅在此预览中模拟，未写入外部系统。" : "The ticket was simulated in this preview only; no external system was changed.") : (zh ? "未启用工单工具；请人工转交问题。" : "Ticket tool is disabled; hand off the issue manually.")
  return run.config.output === "json" ? JSON.stringify({ issue: "duplicate_subscription_charge", urgency: "high", summary, source: run.config.tools.includes("file_search") ? "Help center · Duplicate subscription charges" : null, next_step: next, simulated: true }, null, 2) : summary + "\n\n" + (run.config.tools.includes("file_search") ? (zh ? "来源：帮助中心 · 订阅重复扣款。\n\n" : "Source: Help center · Duplicate subscription charges.\n\n") : "") + next
}
