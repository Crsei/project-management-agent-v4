"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createWorkspaceStore, displayPreferencesKey, sanitizeDisplayPreferences } from "../../web/src/features/workspace/store";
export type Theme = "light" | "dark";
export const THEME_STORAGE_KEY = "agent-workspace:theme";

// Agent is one browser application. All mounted consumers share PM's real store,
// so appearance-page edits also reach the already-mounted settings shell.
const preferenceStore = createWorkspaceStore();
const subscribe = (listener: () => void) => {
  const current = preferenceStore;
  const unsubscribe = current.subscribe(listener);
  const storage = (event: StorageEvent) => {
    if (event.key !== displayPreferencesKey && event.key !== null) return;
    const next = createWorkspaceStore().getState();
    current.setState({ ...sanitizeDisplayPreferences(next), preferenceStorage: next.preferenceStorage });
  };
  window.addEventListener("storage", storage);
  return () => { unsubscribe(); window.removeEventListener("storage", storage); };
};

/** Product switches share the existing PM appearance, without a second theme. */
export const useTheme = () => {
  const appearance = useSyncExternalStore(subscribe, preferenceStore.getState, preferenceStore.getInitialState);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const theme: Theme = appearance.theme === "system" ? (systemDark ? "dark" : "light") : appearance.theme;
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const change = () => setSystemDark(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.dataset.pmAccent = appearance.accent;
    root.dataset.pmSidebarDensity = appearance.sidebarDensity;
    root.dataset.pmMotion = appearance.motion;
    // This is only the existing pre-paint cache, not an independent preference.
    try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* Live preference remains in PM's store. */ }
  }, [appearance.accent, appearance.sidebarDensity, appearance.motion, theme]);
  const toggle = useCallback(() => {
    preferenceStore.getState().setTheme(theme === "dark" ? "light" : "dark");
  }, [preferenceStore, theme]);
  return {
    theme, toggle, preference: appearance.theme, setTheme: appearance.setTheme,
    motion: appearance.motion, sidebarDensity: appearance.sidebarDensity,
    setPreferences: appearance.setPreferences, preferenceStorage: appearance.preferenceStorage,
  };
};
