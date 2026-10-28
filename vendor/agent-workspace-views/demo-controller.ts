"use client"
import type { Dispatch, RefObject, SetStateAction } from "react"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import type { ComposerSession } from "./model"
import type { ComposerController } from "./controller"
import type { ComposerDemoSource } from "./demo-source"
import { useComposerStateController } from "./demo-state-controller"

/** Mutable local state contract; execution and persistence belong to the caller. */
export interface ComposerDemoController extends ComposerController {
  setSessions: Dispatch<SetStateAction<ComposerSession[]>>
  positions: RefObject<Map<string, number>>
  clearSession: (sessionId: string) => void
}

/** Existing Composer consumers keep their own language provider. Conversations inject the new provider directly into the neutral core. */
export function useComposerDemoController(
  source: ComposerDemoSource,
  active = true,
  shortcutsEnabled = true,
): ComposerDemoController {
  const preferences = useI18n()
  return useComposerStateController(
    source,
    preferences,
    active,
    shortcutsEnabled,
  )
}
