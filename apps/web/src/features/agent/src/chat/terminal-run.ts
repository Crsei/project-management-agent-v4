import { useSyncExternalStore } from "react";

/** Cross-component seam for "run in terminal".
 * The timeline never creates PTYs itself: it asks the mounted execution terminal
 * surface, which owns the session attachment and reports the real outcome. */

export const TERMINAL_RUN_EVENT = "pm:agent-run-command";
export const TERMINAL_RUN_RESULT_EVENT = "pm:agent-run-command-result";

export type TerminalRunDetail = {
  requestId: string;
  command: string;
  /** Session scope stays authoritative on the listener side. */
  threadId?: string;
};

export type TerminalRunResult = {
  requestId: string;
  ok: boolean;
  message?: string;
};

let available = false;
const listeners = new Set<() => void>();

export function setTerminalRunAvailable(next: boolean): void {
  if (available === next) return;
  available = next;
  for (const listener of listeners) listener();
}

export function isTerminalRunAvailable(): boolean {
  return available;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Availability is published by the mounted execution terminal surface only. */
export function useTerminalRunAvailable(): boolean {
  return useSyncExternalStore(subscribe, isTerminalRunAvailable, () => false);
}

export function requestTerminalRun(command: string): string | undefined {
  if (!available) return undefined;
  const requestId = crypto.randomUUID();
  window.dispatchEvent(new CustomEvent<TerminalRunDetail>(TERMINAL_RUN_EVENT, { detail: { requestId, command } }));
  return requestId;
}

export function reportTerminalRun(result: TerminalRunResult): void {
  window.dispatchEvent(new CustomEvent<TerminalRunResult>(TERMINAL_RUN_RESULT_EVENT, { detail: result }));
}
