"use client"
import { Toolbar as Base } from "@base-ui/react/toolbar"
import { Button } from "./button"
import { Input } from "./input"
import { cn } from "../../lib/utils"

export function Toolbar({
  className,
  ...props
}: Omit<Base.Root.Props, "className"> & { className?: string }) {
  return (
    <Base.Root
      {...props}
      className={cn("flex min-w-0 items-center gap-2", className)}
    />
  )
}
/** Disabled commands are skipped by arrow navigation and cannot execute. */
export function ToolbarButton(props: Base.Button.Props) {
  return (
    <Base.Button
      focusableWhenDisabled={false}
      render={<Button variant="ghost" />}
      {...props}
    />
  )
}
export function ToolbarInput(props: Base.Input.Props) {
  return <Base.Input render={<Input />} {...props} />
}
export const ToolbarGroup = Base.Group
export const ToolbarSeparator = Base.Separator
