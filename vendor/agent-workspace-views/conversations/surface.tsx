"use client"
import { useState, type ReactNode } from "react"
import { UIProvider } from "./ui/provider"
import styles from "./frame.module.css"

/** Page-level dialogs are siblings of ThreadView; their portals need the same scoped theme. */
export function ConversationSurface({ children }: { children: ReactNode }) {
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(
    null,
  )
  return (
    <UIProvider portalContainer={portalContainer}>
      <div
        ref={setPortalContainer}
        className={styles.surface}
        data-conversation-surface
      >
        {children}
      </div>
    </UIProvider>
  )
}
