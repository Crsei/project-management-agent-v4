import * as CollapsiblePrimitive from "@radix-ui/react-collapsible"
import { cn } from "../../lib/utils"
export const Collapsible = CollapsiblePrimitive.Root
export const CollapsibleTrigger = CollapsiblePrimitive.CollapsibleTrigger
export function CollapsibleContent({
  className,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent> & {
  className?: string
}) {
  return (
    <CollapsiblePrimitive.CollapsibleContent
      {...props}
      className={cn("text-sm leading-6", className)}
    />
  )
}
