import { useSyncExternalStore } from "react";
import type { ResponseStreamingMode } from "@agent-workspace/contracts/output";

const key = "pm-v3:response-streaming-mode";
const listeners = new Set<() => void>();
let mode: ResponseStreamingMode | undefined;
export function getResponseStreamingMode(): ResponseStreamingMode {
  if (mode) return mode;
  try { mode = localStorage.getItem(key) === "turn" ? "turn" : "paragraph"; }
  catch { mode = "paragraph"; }
  return mode;
}
export function setResponseStreamingMode(value: ResponseStreamingMode) {
  mode = value;
  try { localStorage.setItem(key, value); } catch { /* Retain the current page's preference. */ }
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) { mode = undefined; for (const current of listeners) current(); }
  };
  listeners.add(listener);
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
}
export function useResponseStreamingMode() {
  return useSyncExternalStore(subscribe, getResponseStreamingMode, () => "paragraph" as const);
}
