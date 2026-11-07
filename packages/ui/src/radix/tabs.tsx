import {
  Children,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"
import { cn } from "../lib/utils"

/**
 * Base UI types tab values as `any | null` and takes `activateOnFocus` on the
 * List; Radix requires string values and takes `activationMode` on the Root.
 * Both differences are absorbed here so pages keep their existing call shape.
 */
type TabId = string | number
type ActivationMode = "automatic" | "manual"

const SelectedTab = createContext<string | undefined>(undefined)
const SetActivationMode = createContext<
  ((mode: ActivationMode) => void) | null
>(null)
/** Panel values mounted under this Tabs; filter tabs without panels stay valid. */
const PanelValues = createContext<ReadonlySet<string> | undefined>(undefined)
const RegisterPanel = createContext<
  ((value: string, mounted: boolean) => void) | null
>(null)

function firstTabValue(children: ReactNode): string | undefined {
  for (const child of Children.toArray(children)) {
    if (!isValidElement(child)) continue
    const props: unknown = child.props
    if (typeof props !== "object" || props === null) continue
    if (!("value" in props)) continue
    const value: unknown = props.value
    if (typeof value === "string" || typeof value === "number")
      return String(value)
  }
  return undefined
}

export function Tabs({
  className,
  activateOnFocus,
  value,
  defaultValue,
  onValueChange,
  children,
  ...props
}: Omit<
  React.ComponentProps<typeof TabsPrimitive.Root>,
  "value" | "defaultValue" | "onValueChange" | "activationMode"
> & {
  className?: string
  /** Base UI compatibility: focus activation, mirrored from the list. */
  activateOnFocus?: boolean
  value?: TabId | null
  defaultValue?: TabId
  onValueChange?: (value: TabId) => void
  children?: ReactNode
}) {
  const [internal, setInternal] = useState<string | undefined>(
    defaultValue === null || defaultValue === undefined
      ? undefined
      : String(defaultValue),
  )
  const [mode, setMode] = useState<ActivationMode>(
    activateOnFocus ? "automatic" : "manual",
  )
  const [panels, setPanels] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  )
  const controlled =
    value === null || value === undefined ? undefined : String(value)
  // Selection is kept here because inactive tabs must not advertise
  // `aria-controls`, exactly like the Base UI panel model.
  const selected = controlled ?? internal ?? firstTabValue(children)
  const registerPanel = useCallback((panel: string, mounted: boolean) => {
    setPanels((previous) => {
      const next = new Set(previous)
      if (mounted) next.add(panel)
      else next.delete(panel)
      return next.size === previous.size ? previous : next
    })
  }, [])

  return (
    <SelectedTab.Provider value={selected}>
      <PanelValues.Provider value={panels}>
        <RegisterPanel.Provider value={registerPanel}>
          <SetActivationMode.Provider value={setMode}>
            <TabsPrimitive.Root
              {...props}
              activationMode={mode}
              value={selected}
              onValueChange={(next) => {
                if (controlled === undefined) setInternal(next)
                // Radix returns the stringified value we passed in; restore T.
                onValueChange?.(next as TabId)
              }}
              className={className}
            >
              {children}
            </TabsPrimitive.Root>
          </SetActivationMode.Provider>
        </RegisterPanel.Provider>
      </PanelValues.Provider>
    </SelectedTab.Provider>
  )
}

export function TabsList({
  className,
  activateOnFocus,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & {
  className?: string
  /** Base UI compatibility: focus activation lives on the list. */
  activateOnFocus?: boolean
}) {
  const setMode = useContext(SetActivationMode)
  useEffect(() => {
    if (activateOnFocus !== undefined)
      setMode?.(activateOnFocus ? "automatic" : "manual")
  }, [activateOnFocus, setMode])
  return (
    <TabsPrimitive.List
      {...props}
      className={cn("flex gap-1 border-b", className)}
    />
  )
}

/** Radix reports selection through `data-state`; keep the same visual contract. */
export function TabsTab<T extends TabId>({
  className,
  value,
  ...props
}: Omit<React.ComponentProps<typeof TabsPrimitive.Trigger>, "value"> & {
  className?: string
  value?: T
}) {
  const selected = useContext(SelectedTab)
  const panels = useContext(PanelValues)
  const tabValue = String(value ?? "")
  // Filter tabs without a mounted panel must not dangle `aria-controls`.
  const ownsPanel = panels?.has(tabValue) ?? false
  return (
    <TabsPrimitive.Trigger
      {...props}
      {...(selected === tabValue && ownsPanel
        ? {}
        : { "aria-controls": undefined })}
      value={tabValue}
      className={cn(
        "min-h-8 rounded-control px-3 text-sm text-muted-foreground outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:bg-selection data-[state=active]:font-medium data-[state=active]:text-foreground forced-colors:data-[state=active]:outline forced-colors:data-[state=active]:outline-[Highlight] disabled:opacity-50 [@media(pointer:coarse)]:min-h-11",
        className,
      )}
    />
  )
}

/** `keepMounted` maps to `forceMount`, matching the Base UI panel model. */
export function TabsPanel<T extends TabId>({
  className,
  children,
  value,
  ...props
}: Omit<React.ComponentProps<typeof TabsPrimitive.Content>, "value"> & {
  children?: ReactNode
  value?: T
  /** Base UI compatibility: always keep inactive panels mounted. */
  keepMounted?: boolean
  /** Base UI compatibility: callers may force a panel hidden. */
  hidden?: boolean
}) {
  const register = useContext(RegisterPanel)
  const panelValue = String(value ?? "")
  useEffect(() => {
    register?.(panelValue, true)
    return () => register?.(panelValue, false)
  }, [register, panelValue])
  const panelProps: Record<string, unknown> = {
    ...(props as Record<string, unknown>),
  }
  // Base UI's default is to unmount inactive panels; `keepMounted` opts in.
  delete panelProps.keepMounted
  return (
    <TabsPrimitive.Content
      forceMount={props.keepMounted === true ? true : undefined}
      {...panelProps}
      value={panelValue}
      className={cn(
        "py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {children}
    </TabsPrimitive.Content>
  )
}
