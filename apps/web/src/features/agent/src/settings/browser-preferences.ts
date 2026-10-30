import { useEffect, useSyncExternalStore } from "react";
import { agentText } from "../i18n-text.ts";
import "./chat-preferences.css";

export type ChatBrowserPreferences = {
  sendShortcut: "enter" | "ctrlEnter";
  fontSize: "small" | "medium" | "large";
  promptFontSize: number;
  codeFontSize: number;
  terminalFontSize: number;
  contentWidth: "standard" | "wide" | "full";
  codeWrap: boolean;
  diffLayout: "unified" | "split";
  threadSortOrder: "updated_at" | "created_at";
  confirmThreadArchive: boolean;
};
const STORAGE_KEY = "pm-v3:agent-browser-preferences:v1";
const defaults: ChatBrowserPreferences = {
  sendShortcut: "enter",
  fontSize: "medium",
  promptFontSize: 14,
  codeFontSize: 13,
  terminalFontSize: 12,
  contentWidth: "standard",
  codeWrap: false,
  diffLayout: "unified",
  threadSortOrder: "updated_at",
  confirmThreadArchive: false,
};
type Snapshot = { preferences: ChatBrowserPreferences; storageError?: string };
let snapshot: Snapshot | undefined;
const listeners = new Set<() => void>();
function integer(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
function normalize(value: Partial<ChatBrowserPreferences> | null | undefined): ChatBrowserPreferences {
  return {
    sendShortcut: value?.sendShortcut === "ctrlEnter" ? "ctrlEnter" : "enter",
    fontSize: value?.fontSize === "small" || value?.fontSize === "large" ? value.fontSize : "medium",
    promptFontSize: integer(value?.promptFontSize, 12, 20, defaults.promptFontSize),
    codeFontSize: integer(value?.codeFontSize, 10, 18, defaults.codeFontSize),
    terminalFontSize: integer(value?.terminalFontSize, 8, 20, defaults.terminalFontSize),
    contentWidth: value?.contentWidth === "wide" || value?.contentWidth === "full" ? value.contentWidth : "standard",
    codeWrap: value?.codeWrap === true,
    diffLayout: value?.diffLayout === "split" ? "split" : "unified",
    threadSortOrder: value?.threadSortOrder === "created_at" ? "created_at" : "updated_at",
    confirmThreadArchive: value?.confirmThreadArchive === true,
  };
}
function loadPreferences(): Snapshot {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { preferences: defaults };
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object" || !("version" in data) || (data.version !== 1 && data.version !== 2) || !("preferences" in data))
      throw new Error(agentText("浏览器偏好格式无效，当前使用默认值；重新选择后可保存。", "Browser preferences are invalid; defaults are active. Selecting again saves valid values."));
    return { preferences: normalize(data.preferences as Partial<ChatBrowserPreferences> | null) };
  } catch (error) {
    return { preferences: defaults, storageError: error instanceof Error ? error.message : agentText("无法读取浏览器偏好。", "Browser preferences could not be read.") };
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
export function getChatBrowserPreferences() {
  return getSnapshot().preferences;
}
export function setChatBrowserPreferences(patch: Partial<ChatBrowserPreferences>) {
  const preferences = normalize({ ...getSnapshot().preferences, ...patch });
  let storageError: string | undefined;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, preferences })); }
  catch { storageError = agentText("浏览器存储不可用；当前更改仅在此页面生效，刷新后可能丢失。", "Browser storage is unavailable; changes apply only to this page and may be lost on reload."); }
  snapshot = { preferences, storageError };
  notify();
}
export function useChatBrowserPreferences() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
/** Mount once in each product surface, including the common settings shell. */
export function useChatAppearance() {
  const state = useChatBrowserPreferences();
  const { fontSize, promptFontSize, codeFontSize, contentWidth, codeWrap } = state.preferences;
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.agentChatFont = fontSize;
    root.dataset.agentChatWidth = contentWidth;
    root.dataset.agentChatCodeWrap = String(codeWrap);
    root.dataset.agentChatPromptFont = String(promptFontSize);
    root.dataset.agentChatCodeFont = String(codeFontSize);
    root.style.setProperty("--agent-chat-prompt-font-size", `${promptFontSize}px`);
    root.style.setProperty("--agent-chat-code-font-size", `${codeFontSize}px`);
  }, [fontSize, contentWidth, codeWrap, promptFontSize, codeFontSize]);
  return state;
}
