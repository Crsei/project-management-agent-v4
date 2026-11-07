import type { TerminalDescriptor } from "@agent-workspace/contracts/inspector";

/** Workspace PTYs remain visible; Session PTYs are never shown under another Session. */
export function terminalBelongsToSessionView(terminal: Pick<TerminalDescriptor, "scope" | "threadId">, threadId?: string) {
  return terminal.scope === "workspace" || !!threadId && terminal.threadId === threadId;
}
