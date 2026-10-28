"use client"
import type { ComponentProps } from "react"
import { DirectionProvider as Base } from "@base-ui/react/direction-provider"
export type DirectionProviderProps = Omit<ComponentProps<"div">, "dir"> & {
  direction?: "ltr" | "rtl"
}
/** Coordinates DOM direction and Base UI keyboard direction in one boundary. */
export function DirectionProvider({
  direction = "ltr",
  children,
  ...props
}: DirectionProviderProps) {
  return (
    <Base direction={direction}>
      <div {...props} dir={direction}>
        {children}
      </div>
    </Base>
  )
}
