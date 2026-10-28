"use client"
import { createContext, useContext, useMemo, type ReactNode } from "react"
import type { Locale } from "../model"
import type { ComposerDemoSource } from "../demo-source"
import {
  useComposerStateController,
  type ComposerLocaleControls,
} from "../demo-state-controller"

const ConversationLocaleContext = createContext<ComposerLocaleControls | null>(
  null,
)

export function ConversationLocaleProvider({
  locale,
  onLocaleChange,
  children,
}: {
  locale: Locale
  onLocaleChange: (locale: Locale) => void
  children: ReactNode
}) {
  const value = useMemo(
    () => ({ locale, setLocale: onLocaleChange }),
    [locale, onLocaleChange],
  )
  return (
    <ConversationLocaleContext.Provider value={value}>
      {children}
    </ConversationLocaleContext.Provider>
  )
}

export function useConversationLocale(): ComposerLocaleControls {
  const value = useContext(ConversationLocaleContext)
  if (!value) throw new Error("Conversation language provider is missing")
  return value
}

export function useConversationController(
  source: ComposerDemoSource,
  active = true,
  shortcutsEnabled = true,
) {
  const preferences = useConversationLocale()
  return useComposerStateController(
    source,
    preferences,
    active,
    shortcutsEnabled,
  )
}

/** UI routing only; the server-side Lab authorization remains the sole route gate. */
export function isConversationRoute(pathname: string) {
  return /^\/showcase\/(?:conversation-(?:[1-9]|1[0-9]|2[0-3])|parent-child-conversations|web-answer)\/?$/.test(
    pathname,
  )
}
