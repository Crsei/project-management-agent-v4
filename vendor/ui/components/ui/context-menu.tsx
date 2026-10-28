"use client"
import { ContextMenu as Base } from "@base-ui/react/context-menu"
import { cn } from "../../lib/utils"
import { useThemePortalContainer } from "./theme-boundary"
export const ContextMenu = Base.Root
export const ContextMenuTrigger = Base.Trigger
export {
  MenuItem as ContextMenuItem,
  MenuGroup as ContextMenuGroup,
  MenuGroupLabel as ContextMenuLabel,
} from "./menu"
export {
  DropdownMenuCheckboxItem as ContextMenuCheckboxItem,
  DropdownMenuRadioGroup as ContextMenuRadioGroup,
  DropdownMenuRadioItem as ContextMenuRadioItem,
  DropdownMenuSeparator as ContextMenuSeparator,
} from "./dropdown-menu"
export function ContextMenuContent({
  className,
  ...props
}: Omit<Base.Popup.Props, "className"> & { className?: string }) {
  const container = useThemePortalContainer()
  return (
    <Base.Portal container={container}>
      <Base.Positioner className="z-[70]">
        <Base.Popup
          {...props}
          className={cn(
            "max-h-[var(--available-height)] min-w-40 overflow-auto rounded-lg border bg-surface p-1 text-foreground shadow-[var(--shadow-floating)] outline-none",
            className,
          )}
        />
      </Base.Positioner>
    </Base.Portal>
  )
}
