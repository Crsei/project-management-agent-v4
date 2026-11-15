import type { AgentWorkspace, ExecutionEnvironment, ExecutionSelection } from "@agent-workspace/contracts/chat";
import type { TerminalDescriptor } from "@agent-workspace/contracts/inspector";

export type SessionTerminalTarget = { threadId: string; agentWorkspaceId: string; agentWorkspaceRevision: number };

export function sessionTerminalMatches(terminal: TerminalDescriptor, target: SessionTerminalTarget): boolean {
  return terminal.scope === "session" && terminal.threadId === target.threadId
    && terminal.agentWorkspaceId === target.agentWorkspaceId && terminal.agentWorkspaceRevision === target.agentWorkspaceRevision;
}

/** A pre-generation rebind detaches old Session PTYs before selection effects run. */
export function terminalBelongsToSessionView(terminal: TerminalDescriptor, current: SessionTerminalTarget | null, selected?: SessionTerminalTarget): boolean {
  const sessionOnly = !!current && !!selected && current.threadId === selected.threadId
    && current.agentWorkspaceId === selected.agentWorkspaceId && current.agentWorkspaceRevision === selected.agentWorkspaceRevision;
  return terminal.scope === "workspace" ? !sessionOnly : !!current && sessionTerminalMatches(terminal, current);
}

export function sessionTerminalTarget(threadId: string, environment: ExecutionEnvironment): SessionTerminalTarget | null {
  return environment.version === 2 && environment.agentWorkspaceId && environment.agentWorkspaceRevision !== null && environment.executionPath
    ? { threadId, agentWorkspaceId: environment.agentWorkspaceId, agentWorkspaceRevision: environment.agentWorkspaceRevision } : null;
}

/** Both the registered selection and the freshly resolved Session must agree. */
export function verifiedSessionTerminalTarget(threadId: string, selection: ExecutionSelection | undefined, environment: ExecutionEnvironment | undefined, workspace: AgentWorkspace | undefined, expectedWorkspaceId?: string): SessionTerminalTarget | null {
  if (!selection || !environment || !workspace || workspace.status !== "available"
    || selection.agentWorkspaceId !== workspace.id || selection.agentWorkspaceRevision === null || selection.agentWorkspaceRevision > workspace.revision
    || environment.sourcePath !== workspace.path || environment.agentWorkspaceId !== selection.agentWorkspaceId || environment.agentWorkspaceRevision !== selection.agentWorkspaceRevision
    || expectedWorkspaceId !== undefined && expectedWorkspaceId !== workspace.id) return null;
  return sessionTerminalTarget(threadId, environment);
}
