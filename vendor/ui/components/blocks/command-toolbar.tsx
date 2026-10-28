"use client"
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { MoreHorizontal } from "lucide-react"
import { Toolbar, ToolbarButton } from "../ui/toolbar"
import { Button } from "../ui/button"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../ui/menu"
import { useI18n } from "../../lib/i18n-provider"
import {
  allocateCommands,
  commandWidth,
  type CommandSpace,
} from "../../lib/command-toolbar-model"
export type CommandToolbarAction = CommandSpace & {
  label: string
  icon?: ReactNode
  iconOnly?: boolean
  disabled?: boolean
  busy?: boolean
  onInvoke: () => void | Promise<void>
}
export type CommandToolbarProps = {
  label: string
  actions: readonly CommandToolbarAction[]
  leading?: ReactNode
  leadingWidth?: number
  onError?: (error: unknown, action: CommandToolbarAction) => void
  className?: string
}
export function CommandToolbar({
  label,
  actions,
  leading,
  leadingWidth = 160,
  onError,
  className,
}: CommandToolbarProps) {
  const { t } = useI18n()
  const root = useRef<HTMLDivElement>(null),
    more = useRef<HTMLButtonElement>(null)
  const returnCommand = useRef<string | null>(null)
  const focusPending = useRef<string | null>(null),
    openRef = useRef(false),
    inFlight = useRef(new Set<string>())
  const [width, setWidth] = useState(0),
    [open, setOpen] = useState(false),
    [frozenWidth, setFrozenWidth] = useState(0)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set()),
    [failed, setFailed] = useState<string | null>(null)
  const reserved = leading ? Math.max(44, leadingWidth) + 8 : 0
  const allocation = allocateCommands(
    actions,
    open ? frozenWidth : width,
    reserved,
  )
  useEffect(() => {
    const element = root.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const next = entry.contentRect.width
      const active =
        document.activeElement instanceof HTMLElement
          ? document.activeElement.dataset.commandId
          : undefined
      if (
        !openRef.current &&
        active &&
        !allocateCommands(actions, next, reserved).visible.some(
          (a) => a.id === active,
        )
      )
        focusPending.current = active
      setWidth(next)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [actions, reserved])
  useLayoutEffect(() => {
    if (!focusPending.current) return
    const target = Array.from(
      root.current?.querySelectorAll<HTMLElement>("[data-command-id]") ?? [],
    ).find((node) => node.dataset.commandId === focusPending.current)
    ;(
      target ??
      more.current ??
      root.current?.querySelector<HTMLElement>("[data-command-id]")
    )?.focus()
    focusPending.current = null
  }, [width, open])
  async function invoke(action: CommandToolbarAction) {
    if (action.disabled || action.busy || inFlight.current.has(action.id))
      return
    inFlight.current.add(action.id)
    setBusy(new Set(inFlight.current))
    setFailed(null)
    try {
      await action.onInvoke()
    } catch (error) {
      setFailed(action.label)
      onError?.(error, action)
    } finally {
      inFlight.current.delete(action.id)
      setBusy(new Set(inFlight.current))
    }
  }
  return (
    <div className={className}>
      <Toolbar ref={root} aria-label={label}>
        {leading && (
          <div style={{ width: Math.max(44, leadingWidth), flexShrink: 0 }}>
            {leading}
          </div>
        )}
        {allocation.visible.map((action) => (
          <ToolbarButton
            key={action.id}
            data-command-id={action.id}
            aria-label={action.label}
            title={action.label}
            disabled={action.disabled || action.busy || busy.has(action.id)}
            style={{ width: commandWidth(action) }}
            render={
              <Button
                variant="ghost"
                size={action.iconOnly ? "icon" : undefined}
                loading={action.busy || busy.has(action.id)}
              />
            }
            onClick={() => void invoke(action)}
          >
            {action.icon}
            {!action.iconOnly && (
              <span className="truncate">{action.label}</span>
            )}
          </ToolbarButton>
        ))}
        {allocation.overflow.length > 0 && (
          <Menu
            open={open}
            onOpenChange={(next) => {
              // ResizeObserver may still hold the previous width when Escape
              // follows a resize. Allocate against the live container before
              // the menu unmounts and Base UI resolves its final-focus target.
              const measured =
                root.current?.getBoundingClientRect().width ?? width
              setWidth(measured)
              if (next) setFrozenWidth(measured)
              else
                focusPending.current =
                  document.activeElement instanceof HTMLElement
                    ? (document.activeElement.dataset.commandId ?? null)
                    : null
              if (!next) returnCommand.current = focusPending.current
              openRef.current = next
              setOpen(next)
            }}
          >
            <MenuTrigger
              render={
                <ToolbarButton
                  ref={more}
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("toolbar.more")}
                    />
                  }
                />
              }
            >
              <MoreHorizontal />
            </MenuTrigger>
            <MenuContent
              finalFocus={() => {
                const target = Array.from(
                  root.current?.querySelectorAll<HTMLElement>(
                    "[data-command-id]",
                  ) ?? [],
                ).find(
                  (node) =>
                    node.dataset.commandId === returnCommand.current &&
                    !node.hasAttribute("disabled"),
                )
                return (
                  target ??
                  more.current ??
                  root.current?.querySelector<HTMLElement>(
                    "[data-command-id]",
                  ) ??
                  root.current
                )
              }}
            >
              {allocation.overflow.map((action) => (
                <MenuItem
                  key={action.id}
                  data-command-id={action.id}
                  disabled={
                    action.disabled || action.busy || busy.has(action.id)
                  }
                  onClick={() => void invoke(action)}
                >
                  {action.icon}
                  {action.label}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        )}
      </Toolbar>
      {failed && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {t("toolbar.failed", { label: failed })}
        </p>
      )}
    </div>
  )
}
