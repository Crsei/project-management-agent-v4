"use client"
import { Menu as Base } from "@base-ui/react/menu"
import { Check, ChevronRight } from "lucide-react"
import { cn } from "../../lib/utils"
export {
  Menu as DropdownMenu,
  MenuTrigger as DropdownMenuTrigger,
  MenuContent as DropdownMenuContent,
  MenuItem as DropdownMenuItem,
  MenuGroup as DropdownMenuGroup,
  MenuGroupLabel as DropdownMenuLabel,
} from "./menu"
export const DropdownMenuSub = Base.SubmenuRoot
export const DropdownMenuRadioGroup = Base.RadioGroup
export function DropdownMenuSeparator(props: Base.Separator.Props) {
  return <Base.Separator {...props} className="my-1 border-t" />
}
const item =
  "flex min-h-8 cursor-default items-center gap-2 rounded-sm px-3 text-sm outline-none data-highlighted:bg-surface-hover data-disabled:opacity-50 [@media(pointer:coarse)]:min-h-11"
export function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: Omit<Base.SubmenuTrigger.Props, "className"> & { className?: string }) {
  return (
    <Base.SubmenuTrigger {...props} className={cn(item, className)}>
      {children}
      <ChevronRight aria-hidden="true" size={14} className="ml-auto" />
    </Base.SubmenuTrigger>
  )
}
export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: Omit<Base.CheckboxItem.Props, "className"> & { className?: string }) {
  return (
    <Base.CheckboxItem {...props} className={cn(item, className)}>
      <span className="flex size-4 items-center">
        <Base.CheckboxItemIndicator>
          <Check aria-hidden="true" size={14} />
        </Base.CheckboxItemIndicator>
      </span>
      {children}
    </Base.CheckboxItem>
  )
}
export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: Omit<Base.RadioItem.Props, "className"> & { className?: string }) {
  return (
    <Base.RadioItem {...props} className={cn(item, className)}>
      <span className="flex size-4 items-center">
        <Base.RadioItemIndicator>
          <Check aria-hidden="true" size={14} />
        </Base.RadioItemIndicator>
      </span>
      {children}
    </Base.RadioItem>
  )
}
