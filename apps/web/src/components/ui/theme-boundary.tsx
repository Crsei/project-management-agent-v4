import {
  createContext,
  useContext,
  useRef,
  type HTMLAttributes,
  type RefObject,
} from "react"

const PortalScope = createContext<RefObject<HTMLDivElement | null> | undefined>(
  undefined,
)

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
