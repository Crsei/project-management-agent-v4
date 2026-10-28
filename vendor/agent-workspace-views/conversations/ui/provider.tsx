"use client"

import { createContext, useContext, type ReactNode } from "react"
import type { DialogPortalProps } from "@radix-ui/react-dialog"
import { TooltipProvider } from "@radix-ui/react-tooltip"

export interface UIProviderProps {
  children: ReactNode
  /** The stable theme-owning Lab element; portals inherit its variables and dark class. */
  portalContainer?: DialogPortalProps["container"]
  tooltipDelayDuration?: number
}

const PortalContainerContext =
  createContext<DialogPortalProps["container"]>(undefined)

export function UIProvider({
  children,
  portalContainer,
  tooltipDelayDuration = 0,
}: UIProviderProps) {
  return (
    <PortalContainerContext.Provider value={portalContainer}>
      <TooltipProvider delayDuration={tooltipDelayDuration}>
        {children}
      </TooltipProvider>
    </PortalContainerContext.Provider>
  )
}

export function usePortalContainer(
  container?: DialogPortalProps["container"],
): DialogPortalProps["container"] {
  const inheritedContainer = useContext(PortalContainerContext)
  return container ?? inheritedContainer
}
