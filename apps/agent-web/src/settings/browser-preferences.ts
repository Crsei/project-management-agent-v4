import { useEffect, useSyncExternalStore } from "react";
import "./chat-preferences.css";

export type ChatBrowserPreferences = {
  sendShortcut: "enter" | "ctrlEnter";
  fontSize: "small" | "medium" | "large";
  contentWidth: "standard" | "wide" | "full";
  codeWrap: boolean;
};
const STORAGE_KEY = "pm-v3:agent-browser-preferences:v1";
const defaults: ChatBrowserPreferences = { sendShortcut: "enter", fontSize: "medium", contentWidth: "standard", codeWrap: false };
type Snapshot = { preferences: ChatBrowserPreferences; storageError?: string };
let snapshot: Snapshot | undefined;
const listeners = new Set<() => void>();
function loadPreferences(): Snapshot {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { preferences: defaults };
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object" || !("version" in data) || data.version !== 1 || !("preferences" in data))
      throw new Error("浏览器偏好格式无效，当前使用默认值；重新选择后可保存。");
    const value = data.preferences as Partial<ChatBrowserPreferences> | null;
    return { preferences: {
      sendShortcut: value?.sendShortcut === "ctrlEnter" ? "ctrlEnter" : "enter",
      fontSize: value?.fontSize === "small" || value?.fontSize === "large" ? value.fontSize : "medium",
      contentWidth: value?.contentWidth === "wide" || value?.contentWidth === "full" ? value.contentWidth : "standard",
      codeWrap: value?.codeWrap === true,
    } };
  } catch (error) {
    return { preferences: defaults, storageError: error instanceof Error ? error.message : "无法读取浏览器偏好。" };
  }
}
function getSnapshot() {
  return snapshot ??= loadPreferences();
}
function notify() {
  for (const listener of listeners) listener();
}
function onStorage(event: StorageEvent) {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  snapshot = loadPreferences();
  notify();
}
function subscribe(listener: () => void) {
  if (!listeners.size) {
    // Re-entering this product must pick up changes made while it was unmounted.
    snapshot = loadPreferences();
    window.addEventListener("storage", onStorage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener("storage", onStorage);
  };
}
export function setChatBrowserPreferences(patch: Partial<ChatBrowserPreferences>) {
  const preferences = { ...getSnapshot().preferences, ...patch };
  let storageError: string | undefined;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, preferences })); }
  catch { storageError = "浏览器存储不可用；当前更改仅在此页面生效，刷新后可能丢失。"; }
  snapshot = { preferences, storageError };
  notify();
}
export function useChatBrowserPreferences() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
/** Mount once in each product surface, including the common settings shell. */
export function useChatAppearance() {
  const state = useChatBrowserPreferences();
  const { fontSize, contentWidth, codeWrap } = state.preferences;
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.agentChatFont = fontSize;
    root.dataset.agentChatWidth = contentWidth;
    root.dataset.agentChatCodeWrap = String(codeWrap);
  }, [fontSize, contentWidth, codeWrap]);
  return state;
}
