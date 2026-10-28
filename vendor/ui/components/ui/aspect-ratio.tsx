import type { ComponentProps } from "react"
import { cn } from "../../lib/utils"
export type AspectRatioProps = ComponentProps<"div"> & { ratio?: number }
export function AspectRatio({
  ratio = 16 / 9,
  style,
  className,
  ...props
}: AspectRatioProps) {
  return (
    <div
      {...props}
      style={{
        aspectRatio: Number.isFinite(ratio) && ratio > 0 ? ratio : 16 / 9,
        ...style,
      }}
      className={cn("relative w-full min-w-0 overflow-hidden", className)}
    />
  )
}
