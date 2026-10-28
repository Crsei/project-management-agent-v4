"use client"
import {
  createContext,
  useContext,
  useId,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react"
import { PanelLeftClose, PanelLeftOpen } from "lucide-react"
import { useI18n } from "../../lib/i18n-provider"
import { cn } from "../../lib/utils"
import { Button } from "../ui/button"
const Context = createContext({ collapsed: false, id: "", toggle: () => {} })
export type SidebarProps = Omit<ComponentProps<"aside">, "onChange"> & {
  label: string
  collapsed?: boolean
  defaultCollapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
  width?: number
}
export function Sidebar({
  label,
  collapsed: provided,
  defaultCollapsed = false,
  onCollapsedChange,
  width = 256,
  id: providedId,
  style,
  className,
  children,
  ...props
}: SidebarProps) {
  const generated = useId()
  const id = providedId ?? generated
  const [internal, setInternal] = useState(defaultCollapsed)
  const collapsed = provided ?? internal
  return (
    <Context.Provider
      value={{
        collapsed,
        id,
        toggle: () => {
          if (provided === undefined) setInternal(!collapsed)
          onCollapsedChange?.(!collapsed)
        },
      }}
    >
      <aside
        {...props}
        id={id}
        aria-label={label}
        data-collapsed={collapsed || undefined}
        style={{
          width: collapsed
            ? 48
            : Number.isFinite(width)
              ? Math.max(48, Math.min(400, width))
              : 256,
          ...style,
        }}
        className={cn(
          "flex shrink-0 flex-col overflow-hidden border-r bg-background",
          className,
        )}
      >
        {children}
      </aside>
    </Context.Provider>
  )
}
export function SidebarTrigger() {
  const { t } = useI18n()
  const context = useContext(Context)
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={
        context.collapsed
          ? t("workspaceShell.expandSidebar")
          : t("workspaceShell.collapseSidebar")
      }
      aria-controls={context.id}
      aria-expanded={!context.collapsed}
      onClick={context.toggle}
    >
      {context.collapsed ? (
        <PanelLeftOpen aria-hidden="true" />
      ) : (
        <PanelLeftClose aria-hidden="true" />
      )}
    </Button>
  )
}
export function SidebarHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={cn(
        "flex min-h-11 items-center gap-2 border-b px-2",
        className,
      )}
    />
  )
}
export function SidebarContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={cn("min-h-0 flex-1 overflow-auto p-2", className)}
    />
  )
}
export function SidebarFooter({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={cn("border-t p-2", className)} />
}
export function SidebarLink({
  label,
  icon,
  active,
  className,
  ...props
}: Omit<ComponentProps<"a">, "children"> & {
  label: string
  icon?: ReactNode
  active?: boolean
}) {
  const { collapsed } = useContext(Context)
  return (
    <a
      {...props}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? label : undefined}
      className={cn(
        "flex min-h-8 items-center gap-2 rounded-control px-2 text-[13px] outline-none hover:bg-surface-hover aria-[current=page]:bg-selection aria-[current=page]:text-primary focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11",
        className,
      )}
    >
      {icon && (
        <span aria-hidden="true" className="inline-flex size-4 shrink-0">
          {icon}
        </span>
      )}
      <span className={collapsed ? "sr-only" : "truncate"}>{label}</span>
    </a>
  )
}
