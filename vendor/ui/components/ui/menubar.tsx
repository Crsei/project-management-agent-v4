"use client"
import { Menubar as Base } from "@base-ui/react/menubar"
import { cn } from "../../lib/utils"
export {
  Menu as MenubarMenu,
  MenuTrigger as MenubarTrigger,
  MenuContent as MenubarContent,
  MenuItem as MenubarItem,
} from "./menu"
export {
  DropdownMenuCheckboxItem as MenubarCheckboxItem,
  DropdownMenuRadioGroup as MenubarRadioGroup,
  DropdownMenuRadioItem as MenubarRadioItem,
  DropdownMenuSeparator as MenubarSeparator,
} from "./dropdown-menu"
export function Menubar({
  className,
  ...props
}: Omit<Base.Props, "className"> & { className?: string }) {
  return (
    <Base
      {...props}
      className={cn(
        "inline-flex gap-1 rounded-control border bg-surface p-1",
        className,
      )}
    />
  )
}
