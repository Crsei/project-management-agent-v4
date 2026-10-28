"use client"
import { useState, type Dispatch, type SetStateAction } from "react"
import { useThreadController } from "./shared"
import { useCitationPreview, type CitationController } from "./citations"
import type {
  Conversation10Fixture,
  Conversation10Scenario,
} from "./conversation-10-fixtures"
export interface Conversation10Controller extends CitationController {
  usage: Conversation10Fixture["usage"]
  sourcesOpen: boolean
  setSourcesOpen: Dispatch<SetStateAction<boolean>>
  contextOpen: boolean
  setContextOpen: Dispatch<SetStateAction<boolean>>
}
export function useConversation10Controller(
  fixture: Conversation10Fixture,
  scenario: Conversation10Scenario,
  active: boolean,
): Conversation10Controller {
  const base = useThreadController(fixture.source, scenario, active)
  const citations = useCitationPreview(fixture.sources)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  return {
    ...base,
    ...citations,
    usage: fixture.usage,
    sourcesOpen,
    setSourcesOpen,
    contextOpen,
    setContextOpen,
  }
}
