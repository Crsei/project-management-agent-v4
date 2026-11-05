import type { ManagementEvent } from "@pm/cc-switch-ui";
import { workspaceClient } from "../network";

export class ExtensionManagementError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number) { super(message); }
}
/** Browser HttpOnly cookies preserve both existing Agent access and PM identity boundaries. */
export async function extensionJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(workspaceClient.url(`/api/extensions${path}`), {
    ...init, credentials: "same-origin", cache: "no-store", redirect: "error",
    headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
  });
  const value = await response.json().catch(() => undefined) as { error?: string; code?: string; details?: { references?: unknown } } | undefined;
  if (!response.ok) {
    const references = value?.code === "definition_in_use" && Array.isArray(value.details?.references)
      ? value.details.references.flatMap(reference => reference && typeof reference === "object"
        && typeof reference.id === "string" && typeof reference.label === "string" && typeof reference.projectId === "string"
        ? [`${reference.label} (${reference.projectId} / ${reference.id})`] : [])
      : [];
    throw new ExtensionManagementError([value?.error ?? `HTTP ${response.status}`, ...references].join("\n"), value?.code ?? "extension_request_failed", response.status);
  }
  if (!value) throw new ExtensionManagementError("The extension service did not return JSON.", "invalid_extension_response");
  return value as T;
}
export async function uploadExtensionZip(contextId: string, file: File): Promise<string> {
  const result = await extensionJson<{ uploadId: string }>(`/contexts/${encodeURIComponent(contextId)}/uploads`, { method: "POST", body: file, headers: { "Content-Type": "application/zip" } });
  return result.uploadId;
}

/** One authenticated stream; disconnects are visible and never replay commands. */
export async function readExtensionEvents(contextId: string, signal: AbortSignal, onReady: () => void, onEvent: (event: ManagementEvent) => void): Promise<void> {
  const response = await fetch(workspaceClient.url(`/api/extensions/contexts/${encodeURIComponent(contextId)}/events`), { credentials: "same-origin", cache: "no-store", redirect: "error", signal, headers: { Accept: "text/event-stream" } });
  if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new ExtensionManagementError(`Extension event stream failed (HTTP ${response.status}).`, "extension_events_failed", response.status);
  onReady();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let event = "message";
  let data: string[] = [];
  const dispatch = () => {
    if (data.length && ["mcp-connectivity", "operation", "changed", "status", "warning", "heartbeat"].includes(event)) onEvent({ event: event as ManagementEvent["event"], data: JSON.parse(data.join("\n")) });
    event = "message"; data = [];
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end).replace(/\r$/, ""); pending = pending.slice(end + 1);
        if (!line) dispatch();
        else if (line.startsWith("event:")) event = line.slice(6).trimStart();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (!signal.aborted) throw new ExtensionManagementError("The extension event stream disconnected. Read current state before retrying an operation.", "extension_events_disconnected");
  } finally { reader.releaseLock(); }
}
