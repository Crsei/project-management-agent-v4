import type { AgentWorkspace, ExecutionSelection } from "@agent-workspace/contracts/chat";

/** Metadata changes never rewrite an existing directory binding. */
export function agentWorkspaceSelectionIssue(selection: ExecutionSelection, workspace: AgentWorkspace | undefined, allowChatOnly: boolean): "folder-required" | "unavailable" | "revision-unavailable" | null {
  if (selection.version !== 2) return "folder-required";
  if (!selection.agentWorkspaceId) return allowChatOnly ? null : "folder-required";
  if (!workspace || workspace.id !== selection.agentWorkspaceId || workspace.status !== "available") return "unavailable";
  return selection.agentWorkspaceRevision == null || selection.agentWorkspaceRevision > workspace.revision ? "revision-unavailable" : null;
}
