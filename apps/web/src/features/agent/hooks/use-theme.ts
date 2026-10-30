"use client";

import { useCallback, useEffect, useState } from "react";
import { useWorkspaceStore } from "@/providers/app-providers";

export type Theme = "light" | "dark";
export const THEME_STORAGE_KEY = "agent-workspace:theme";

/** Both products use the same live PM appearance store. */
export const useTheme = () => {
  const appearance = useWorkspaceStore(state => state);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const theme: Theme = appearance.theme === "system" ? (systemDark ? "dark" : "light") : appearance.theme;
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const change = () => setSystemDark(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* The live preference remains in the shared store. */ }
  }, [theme]);
  const toggle = useCallback(() => {
    appearance.setTheme(theme === "dark" ? "light" : "dark");
  }, [appearance.setTheme, theme]);
  return {
    theme, toggle, preference: appearance.theme, setTheme: appearance.setTheme,
    motion: appearance.motion, sidebarDensity: appearance.sidebarDensity,
    setPreferences: appearance.setPreferences, preferenceStorage: appearance.preferenceStorage,
  };
};
