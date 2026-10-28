import {
  choices,
  createConfig,
  type AgentConfig,
  type NodeId,
} from "./fixtures.ts"

export type BuilderState = {
  config: AgentConfig
  saved: AgentConfig
  version: number
  editor: {
    node: NodeId
    draft: AgentConfig
    errors: Record<string, string>
  } | null
  panelOpen: boolean
  zoom: number
  readState: "ready" | "loading" | "error"
  readonly: boolean
  reviewDraft: string
  notes: { id: number; text: string; runId: number }[]
  nextId: number
  run: {
    id: number
    status: "running" | "complete" | "failed" | "stopped"
    stage: number
    snapshot: AgentConfig
    error?: "instructions" | "tools"
  } | null
  reading: { canvasX: number; canvasY: number; conversationY: number }
}
export type BuilderAction =
  | { type: "open"; node: NodeId }
  | { type: "edit"; patch: Partial<AgentConfig> }
  | {
      type: "toggle"
      group: "tools" | "skills" | "subagents"
      id: string
      checked: boolean
    }
  | { type: "memory-add" }
  | { type: "memory-remove"; id: string }
  | {
      type: "memory-edit"
      id: string
      patch: { name?: string; content?: string }
    }
  | { type: "apply" }
  | { type: "dismiss" }
  | { type: "save" }
  | { type: "run" }
  | { type: "advance"; runId: number }
  | { type: "stop" }
  | { type: "note-draft"; value: string }
  | { type: "note-add" }
  | { type: "panel"; open: boolean }
  | { type: "zoom"; value: number }
  | { type: "recover" }
  | { type: "reading"; patch: Partial<BuilderState["reading"]> }

export function createBuilderState(scenario: string): BuilderState {
  const config = createConfig(scenario)
  return {
    config,
    saved: structuredClone(config),
    version: 1,
    editor: null,
    panelOpen: true,
    zoom: 0.9,
    readState:
      scenario === "loading"
        ? "loading"
        : scenario === "refresh-error"
          ? "error"
          : "ready",
    readonly: scenario === "readonly",
    reviewDraft: "",
    notes: [],
    nextId: 20,
    run:
      scenario === "empty" || scenario === "loading"
        ? null
        : {
            id: 1,
            status: "complete",
            stage: 4,
            snapshot: structuredClone(config),
          },
    reading: { canvasX: 0, canvasY: 0, conversationY: 0 },
  }
}
export function validateSection(
  node: NodeId,
  config: AgentConfig,
): Record<string, string> {
  const errors: Record<string, string> = {}
  if (node === "agent")
    for (const key of ["name", "purpose", "instructions"] as const)
      if (!config[key].trim()) errors[key] = "required"
  if (node === "schedule" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(config.time))
    errors.time = "time"
  if (node === "event" && !config.condition.trim() && config.event !== "manual")
    errors.condition = "required"
  if (node === "channels" && !config.destination.trim())
    errors.destination = "required"
  if (node === "memory")
    for (const memory of config.memory) {
      if (!memory.name.trim()) errors[memory.id + ":name"] = "required"
      if (!memory.content.trim()) errors[memory.id + ":content"] = "required"
    }
  return errors
}
export function builderTransition(
  state: BuilderState,
  action: BuilderAction,
): BuilderState {
  const locked = state.readonly || state.readState === "loading"
  switch (action.type) {
    case "open":
      return {
        ...state,
        editor: {
          node: action.node,
          draft: structuredClone(state.config),
          errors: {},
        },
      }
    case "dismiss":
      return { ...state, editor: null }
    case "edit": {
      if (locked || !state.editor) return state
      return {
        ...state,
        editor: {
          ...state.editor,
          draft: { ...state.editor.draft, ...action.patch },
          errors: {},
        },
      }
    }
    case "toggle": {
      if (
        locked ||
        !state.editor ||
        state.editor.node !== action.group ||
        !choices[action.group].some((choice) => choice.id === action.id)
      )
        return state
      const values = state.editor.draft[action.group]
      const next = action.checked
        ? values.includes(action.id)
          ? values
          : [...values, action.id]
        : values.filter((id) => id !== action.id)
      return {
        ...state,
        editor: {
          ...state.editor,
          draft: { ...state.editor.draft, [action.group]: next },
        },
      }
    }
    case "memory-add": {
      if (locked || state.editor?.node !== "memory") return state
      return {
        ...state,
        nextId: state.nextId + 1,
        editor: {
          ...state.editor,
          draft: {
            ...state.editor.draft,
            memory: [
              ...state.editor.draft.memory,
              { id: `memory-${state.nextId}`, name: "", content: "" },
            ],
          },
        },
      }
    }
    case "memory-remove": {
      if (locked || state.editor?.node !== "memory") return state
      return {
        ...state,
        editor: {
          ...state.editor,
          draft: {
            ...state.editor.draft,
            memory: state.editor.draft.memory.filter(
              (memory) => memory.id !== action.id,
            ),
          },
          errors: {},
        },
      }
    }
    case "memory-edit": {
      if (locked || state.editor?.node !== "memory") return state
      return {
        ...state,
        editor: {
          ...state.editor,
          draft: {
            ...state.editor.draft,
            memory: state.editor.draft.memory.map((memory) =>
              memory.id === action.id ? { ...memory, ...action.patch } : memory,
            ),
          },
          errors: {},
        },
      }
    }
    case "apply": {
      if (locked || !state.editor) return state
      const errors = validateSection(state.editor.node, state.editor.draft)
      if (Object.keys(errors).length)
        return { ...state, editor: { ...state.editor, errors } }
      return {
        ...state,
        config: structuredClone(state.editor.draft),
        editor: null,
      }
    }
    case "save": {
      if (
        locked ||
        state.editor ||
        JSON.stringify(state.config) === JSON.stringify(state.saved)
      )
        return state
      return {
        ...state,
        saved: structuredClone(state.config),
        version: state.version + 1,
      }
    }
    case "run": {
      if (locked || state.run?.status === "running") return state
      const error = Object.keys(validateSection("agent", state.config)).length
        ? "instructions"
        : !state.config.tools.length
          ? "tools"
          : undefined
      return {
        ...state,
        panelOpen: true,
        nextId: state.nextId + 1,
        run: {
          id: state.nextId,
          status: error ? "failed" : "running",
          stage: 0,
          snapshot: structuredClone(state.config),
          error,
        },
      }
    }
    case "advance": {
      if (state.run?.id !== action.runId || state.run.status !== "running")
        return state
      const stage = state.run.stage + 1
      return {
        ...state,
        run: {
          ...state.run,
          stage,
          status: stage >= 4 ? "complete" : "running",
        },
      }
    }
    case "stop":
      return state.run?.status === "running"
        ? { ...state, run: { ...state.run, status: "stopped" } }
        : state
    case "note-draft":
      return locked ? state : { ...state, reviewDraft: action.value }
    case "note-add": {
      if (locked || !state.run || !state.reviewDraft.trim()) return state
      return {
        ...state,
        nextId: state.nextId + 1,
        notes: [
          ...state.notes,
          {
            id: state.nextId,
            text: state.reviewDraft.trim(),
            runId: state.run.id,
          },
        ],
        reviewDraft: "",
      }
    }
    case "panel":
      return { ...state, panelOpen: action.open }
    case "zoom":
      return {
        ...state,
        zoom: Math.min(1.4, Math.max(0.6, Number(action.value.toFixed(2)))),
      }
    case "recover":
      return { ...state, readState: "ready" }
    case "reading":
      return { ...state, reading: { ...state.reading, ...action.patch } }
  }
}
