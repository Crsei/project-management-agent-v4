export type AgentAttachment = {
  id: string
  name: string
  kind: "file" | "image"
  status: "idle" | "uploading" | "processing" | "done" | "error" | "unknown"
  size?: number
  mediaType?: string
  src?: string
  alt?: string
  error?: string
  disabled?: boolean
  removable?: boolean
}

export type ToolTask = { id: string; title: string; status: string }
export type ToolSearchResult = {
  id: string
  title: string
  source: string
  date?: string
  href?: string
}

/** Display data is supplied or adapted by the host, independently of execution status. */
export type ToolDisplay =
  | { kind: "bash"; command?: string; cwd?: string }
  | {
      kind: "edit"
      path: string
      before: string
      after: string
      language?: string
    }
  | {
      kind: "search"
      query: string
      results: readonly ToolSearchResult[]
      partial?: boolean
    }
  | { kind: "todo"; items: readonly ToolTask[]; previous?: readonly ToolTask[] }
  | {
      kind: "plan"
      title: string
      summary: string
      steps: readonly ToolTask[]
      revision: string
    }
  | { kind: "subagent"; agentName: string; description?: string }
  | { kind: "mcp"; serverName: string; toolName: string; content?: unknown }
  | { kind: "thinking"; text?: string }
  | { kind: "generic" }

export type ToolKind = ToolDisplay["kind"]
