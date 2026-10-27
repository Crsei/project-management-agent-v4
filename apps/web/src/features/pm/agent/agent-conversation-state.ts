export type AgentConversationLocation = {
  threadId: string | null
  projectId: string | null
  taskId: string | null
  returnTo: string | null
  newChat: boolean
}

type ConversationAction =
  | { type: "task"; taskId: string | null }
  | { type: "history"; threadId: string }
  | { type: "created"; threadId: string }
  | { type: "new" }

/** A per-message task target must never silently follow a different conversation. */
export function nextAgentConversation(location: AgentConversationLocation, action: ConversationAction): AgentConversationLocation {
  switch (action.type) {
    case "task": return { ...location, taskId: action.taskId, newChat: !location.threadId || location.newChat }
    case "history": return action.threadId === location.threadId ? location : { ...location, threadId: action.threadId, taskId: null, newChat: false }
    case "created": return { ...location, threadId: action.threadId, newChat: false }
    case "new": return { ...location, threadId: null, taskId: null, newChat: true }
  }
}

export function agentConversationParams(location: AgentConversationLocation): URLSearchParams {
  const params = new URLSearchParams()
  if (location.threadId) params.set("thread", location.threadId)
  else if (location.newChat) params.set("new", "1")
  if (location.projectId) params.set("project", location.projectId)
  if (location.taskId) params.set("task", location.taskId)
  if (location.returnTo) params.set("returnTo", location.returnTo)
  return params
}
