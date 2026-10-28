"use client"
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog"
import { Input } from "../ui/input"
import { Kbd } from "../ui/kbd"
import { useControllableValue } from "../../lib/use-controllable-value"
import { useI18n } from "../../lib/i18n-provider"
export type CommandPaletteItem = {
  id: string
  label: string
  description?: string
  shortcut?: string
  disabled?: boolean
  icon?: ReactNode
}
export type CommandPaletteGroup = {
  id: string
  label: string
  items: readonly CommandPaletteItem[]
}
export type CommandPaletteProps = {
  presentation?: "dialog" | "inline"
  title: string
  description?: string
  groups: readonly CommandPaletteGroup[]
  onSelect: (item: CommandPaletteItem) => void
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  query?: string
  defaultQuery?: string
  onQueryChange?: (query: string) => void
  loading?: boolean
  error?: string
  onRetry?: () => void
  emptyMessage?: string
  shortcut?: {
    key: string
    mod?: boolean
    scope?: RefObject<HTMLElement | null>
  }
  finalFocus?: DialogContentFinalFocus
  className?: string
  /** Non-interactive option content; the palette retains activation and keyboard ownership. */
  renderItem?: (item: CommandPaletteItem) => ReactNode
}
type DialogContentFinalFocus = React.ComponentProps<
  typeof DialogContent
>["finalFocus"]
export function CommandPalette({
  presentation = "dialog",
  title,
  description,
  groups,
  onSelect,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  query: controlledQuery,
  defaultQuery = "",
  onQueryChange,
  loading,
  error,
  onRetry,
  emptyMessage,
  shortcut,
  finalFocus,
  className,
  renderItem,
}: CommandPaletteProps) {
  const { t } = useI18n()
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useControllableValue(
    controlledOpen,
    defaultOpen,
    onOpenChange,
  )
  const [query, setQuery] = useControllableValue(
    controlledQuery,
    defaultQuery,
    onQueryChange,
  )
  const [activeId, setActiveId] = useState<string | null>(null)
  const flat = groups
    .flatMap((group) => group.items)
    .filter((item) => !item.disabled)
  const active = flat.find((item) => item.id === activeId) ?? flat[0]
  const select = (item: CommandPaletteItem) => {
    if (item.disabled) return
    onSelect(item)
    if (presentation === "dialog") setOpen(false)
  }
  const setOpenRef = useRef(setOpen)
  useEffect(() => {
    setOpenRef.current = setOpen
  })
  useEffect(() => {
    if (!shortcut) return
    const target = shortcut.scope?.current ?? document
    const handler = (event: Event) => {
      const e = event as KeyboardEvent
      const element = e.target instanceof Element ? e.target : null
      if (
        e.defaultPrevented ||
        e.isComposing ||
        e.repeat ||
        e.altKey ||
        e.shiftKey ||
        element?.closest(
          'input,textarea,select,[contenteditable="true"],.react-flow',
        )
      )
        return
      if (
        e.key.toLowerCase() !== shortcut.key.toLowerCase() ||
        (shortcut.mod !== false && !(e.metaKey || e.ctrlKey))
      )
        return
      e.preventDefault()
      if (presentation === "inline") input.current?.focus()
      else setOpenRef.current(true)
    }
    target.addEventListener("keydown", handler)
    return () => target.removeEventListener("keydown", handler)
  }, [shortcut, presentation])
  useEffect(() => {
    if ((open || presentation === "inline") && active)
      document
        .getElementById(`${id}-${active.id}`)
        ?.scrollIntoView({ block: "nearest" })
  }, [open, active, id, presentation])
  const content = (
    <>
      <div className="border-b p-4 pr-16">
        {presentation === "inline" ? (
          <h2 className="text-sm font-medium">{title}</h2>
        ) : (
          <DialogTitle>{title}</DialogTitle>
        )}
        {description &&
          (presentation === "inline" ? (
            <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          ) : (
            <DialogDescription>{description}</DialogDescription>
          ))}
      </div>
      <div className="p-3">
        <Input
          ref={input}
          role="combobox"
          aria-label={t("commonComponents.searchCommands")}
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={`${id}-results`}
          aria-activedescendant={active ? `${id}-${active.id}` : undefined}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActiveId(null)
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            const index = flat.findIndex((item) => item.id === active?.id)
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault()
              if (flat.length)
                setActiveId(
                  flat[
                    (index +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      flat.length) %
                      flat.length
                  ].id,
                )
            } else if (event.key === "Home" || event.key === "End") {
              event.preventDefault()
              setActiveId(
                (event.key === "Home" ? flat[0] : flat.at(-1))?.id ?? null,
              )
            } else if (event.key === "Enter" && active && !loading && !error) {
              event.preventDefault()
              select(active)
            }
          }}
        />
      </div>
      {loading && (
        <p role="status" className="px-4 py-2 text-xs">
          {t("commonComponents.searching")}
        </p>
      )}
      {error && (
        <div role="alert" className="px-4 py-2 text-sm text-destructive">
          {error}
          {onRetry && (
            <button
              type="button"
              className="ml-2 min-h-8 underline [@media(pointer:coarse)]:min-h-11"
              onClick={onRetry}
            >
              {t("workspaceShellDemo.retryRead")}
            </button>
          )}
        </div>
      )}
      <div
        id={`${id}-results`}
        role="listbox"
        aria-label={title}
        aria-busy={loading}
        className="min-h-0 max-h-80 flex-1 overflow-auto overscroll-contain p-1"
      >
        {groups.map((group) => (
          <div
            key={group.id}
            role="group"
            aria-labelledby={`${id}-group-${group.id}`}
          >
            <p
              id={`${id}-group-${group.id}`}
              className="px-3 py-2 text-xs text-muted-foreground"
            >
              {group.label}
            </p>
            {group.items.map((item) => (
              <div
                id={`${id}-${item.id}`}
                key={item.id}
                role="option"
                aria-selected={active?.id === item.id}
                aria-disabled={item.disabled || loading || Boolean(error)}
                onPointerMove={() => {
                  if (!item.disabled) setActiveId(item.id)
                }}
                onClick={() => {
                  if (!loading && !error) select(item)
                }}
                className="flex min-h-8 cursor-default items-center gap-2 rounded-md px-3 py-2 text-sm aria-selected:bg-selection aria-disabled:opacity-50 [@media(pointer:coarse)]:min-h-11"
              >
                {renderItem?.(item) ?? (
                  <>
                    {item.icon && <span aria-hidden="true">{item.icon}</span>}
                    <span className="min-w-0 flex-1">
                      {item.label}
                      {item.description && (
                        <span className="block text-xs text-muted-foreground">
                          {item.description}
                        </span>
                      )}
                    </span>
                    {item.shortcut && <Kbd>{item.shortcut}</Kbd>}
                  </>
                )}
              </div>
            ))}
          </div>
        ))}
        {!groups.some((group) => group.items.length) && !loading && !error && (
          <p className="p-4 text-sm text-muted-foreground">
            {emptyMessage ?? t("commonComponents.noCommands")}
          </p>
        )}
      </div>
    </>
  )
  if (presentation === "inline")
    return (
      <section
        aria-label={title}
        className={
          className
            ? `rounded-control border ${className}`
            : "rounded-control border"
        }
      >
        {content}
      </section>
    )
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        finalFocus={finalFocus}
        initialFocus={input}
        className={className ? `p-0 ${className}` : "p-0"}
      >
        {content}
      </DialogContent>
    </Dialog>
  )
}
