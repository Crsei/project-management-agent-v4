import type { TerminalDescriptor } from "@agent-workspace/contracts/inspector";

export type PendingTerminalCreation = {
  requestId: string;
  expectedServiceId: string;
  scope: "workspace" | "session";
  agentWorkspaceId: string;
  agentWorkspaceRevision: number;
  threadId?: string;
  relativePath: string;
};
export type TerminalCreationReadback =
  | { status: "found"; terminal: TerminalDescriptor }
  | { status: "not-found" }
  | { status: "service-changed" };

/** A restart invalidates the original request, even if no terminal is listed. */
export function terminalCreationReadback(request: PendingTerminalCreation, result: { serviceId: string; terminals: TerminalDescriptor[] }): TerminalCreationReadback {
  if (result.serviceId !== request.expectedServiceId) return { status: "service-changed" };
  const terminal = result.terminals.find(item => item.requestId === request.requestId && item.serviceId === request.expectedServiceId && item.scope === request.scope && item.agentWorkspaceId === request.agentWorkspaceId && item.agentWorkspaceRevision === request.agentWorkspaceRevision && item.threadId === (request.threadId ?? null));
  return terminal ? { status: "found", terminal } : { status: "not-found" };
}

/** Delayed list/DELETE replies cannot resurrect an exit already observed on WS. */
export function acceptTerminalDescriptor(current: TerminalDescriptor | undefined, incoming: TerminalDescriptor) {
  return current?.id === incoming.id && current.serviceId === incoming.serviceId && current.status === "exited" && incoming.status === "running" ? current : incoming;
}
