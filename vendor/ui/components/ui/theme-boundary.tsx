"use client"

import {
  createContext,
  useContext,
  useRef,
  type HTMLAttributes,
  type RefObject,
} from "react"
import "../../styles/theme-boundary.css"
const PortalScope = createContext<RefObject<HTMLDivElement | null> | undefined>(
  undefined,
)
export type ThemeBoundaryProps = HTMLAttributes<HTMLDivElement> & {
  mode?: "host" | "scoped"
  theme?: "light" | "dark"
  /** Bridge the original unnamespaced components during a legacy migration. */
  legacyAliases?: boolean
}
export function ThemeBoundary({
  mode = "host",
  theme = "light",
  legacyAliases = false,
  children,
  ...props
}: ThemeBoundaryProps) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <PortalScope.Provider value={ref}>
      <div
        {...props}
        ref={ref}
        data-eu-mode={mode}
        data-eu-theme={theme}
        data-eu-legacy-aliases={legacyAliases || undefined}
      >
        {children}
      </div>
    </PortalScope.Provider>
  )
}
export function useThemePortalContainer() {
  return useContext(PortalScope)
}

/** Keep nested portals inside their owning modal DOM subtree and inherited theme. */
export function ThemePortalScope({
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <PortalScope.Provider value={ref}>
      <div {...props} ref={ref}>
        {children}
      </div>
    </PortalScope.Provider>
  )
}
