import { useEffect, type ReactNode } from "react"
import { useWorkspaceStore } from "@/providers/app-providers"
import { I18nProvider } from "@/lib/i18n-provider"
import "./preferences.css"

export function Preferences({ children }: { children: ReactNode }) {
  const { locale, theme, accent, sidebarDensity, taskDensity, motion, setLocale } = useWorkspaceStore(state => state)
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])
  useEffect(() => {
    const root = document.documentElement
    const dark = window.matchMedia("(prefers-color-scheme: dark)")
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)")
    const apply = () => {
      const resolved = theme === "system" ? dark.matches ? "dark" : "light" : theme
      root.classList.toggle("dark", resolved === "dark")
      root.style.colorScheme = resolved
      root.dataset.pmMotion = motion === "reduce" || reduce.matches ? "reduce" : "full"
    }
    apply()
    dark.addEventListener("change", apply)
    reduce.addEventListener("change", apply)
    return () => { dark.removeEventListener("change", apply); reduce.removeEventListener("change", apply) }
  }, [theme, motion])
  useEffect(() => {
    const root = document.documentElement
    root.dataset.pmAccent = accent
    root.dataset.pmSidebarDensity = sidebarDensity
    root.dataset.pmTaskDensity = taskDensity
  }, [accent, sidebarDensity, taskDensity])
  return <I18nProvider locale={locale} onLocaleChange={setLocale}>{children}</I18nProvider>
}
