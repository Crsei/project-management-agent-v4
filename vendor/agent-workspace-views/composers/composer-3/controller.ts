"use client"

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useComposerDemoController } from "../../demo-controller"
import type { ComposerDemoSource } from "../../demo-source"
import { useRemainingPageState } from "../../showcase/state"
import { createComposer3Fixture, directoryContexts, tools } from "./fixtures"
import { configureTools, initialDirectoryState, prepareAgent, prepareWorkflow, type Shortcut } from "./model"

type Snapshot = {
  source: ComposerDemoSource
  globalCollapsed: boolean
  sessionsVisible: boolean
  positions: [string, number][]
  selection?: { sessionId: string; start: number; end: number }
}

export function useComposer3Controller(scenario: string, active: boolean, cache: Map<string, unknown>) {
  const key = `composer-3:${scenario}:conversation`
  const shortcutReturnFocus = useRef<HTMLElement | null>(null)
  const [restored] = useState(() => cache.get(key) as Snapshot | undefined)
  const [initialSource] = useState(() => restored?.source ?? createComposer3Fixture(scenario))
  const [directory, setDirectory] = useRemainingPageState(`composer-3:${scenario}:directory`, () => initialDirectoryState(scenario))
  const editable = scenario !== "readonly" && directory.readState !== "loading"
  const source = useMemo(() => ({ ...initialSource, contextItems: [...initialSource.contextItems.filter((item) => !item.id.startsWith("tool-") && !item.id.startsWith("workflow-") && item.id !== "agent-brief"), ...directoryContexts(directory.preparedAgentName || "Agent brief")], canSend: editable }), [initialSource, directory.preparedAgentName, editable])
  const base = useComposerDemoController(source, active, active)
  const { setGlobalCollapsed, setSessionsVisible, positions, history, textarea } = base

  useLayoutEffect(() => {
    if (!restored) return
    setGlobalCollapsed(restored.globalCollapsed)
    setSessionsVisible(restored.sessionsVisible)
    for (const [id, position] of restored.positions) positions.current.set(id, position)
    history.current?.scrollTo({ top: positions.current.get(restored.source.selectedId) ?? 0 })
    if (restored.selection?.sessionId === restored.source.selectedId) {
      const selection = restored.selection
      const frame = requestAnimationFrame(() => textarea.current?.setSelectionRange(selection.start, selection.end))
      return () => cancelAnimationFrame(frame)
    }
  }, [restored, setGlobalCollapsed, setSessionsVisible, positions, history, textarea])

  useEffect(() => {
    cache.set(key, {
      source: { ...source, sessions: base.sessions, selectedId: base.selectedId, projectId: base.projectId, drafts: base.drafts },
      globalCollapsed: base.globalCollapsed,
      sessionsVisible: base.sessionsVisible,
      positions: [...base.positions.current],
      selection: base.textarea.current ? { sessionId: base.selectedId, start: base.textarea.current.selectionStart, end: base.textarea.current.selectionEnd } : undefined,
    } satisfies Snapshot)
  }, [cache, key, source, base.sessions, base.selectedId, base.projectId, base.drafts, base.globalCollapsed, base.sessionsVisible, base.positions, base.textarea])

  function rememberPosition() {
    base.rememberPosition()
    const snapshot = cache.get(key) as Snapshot | undefined
    if (!snapshot) return
    snapshot.positions = [...base.positions.current]
    if (base.textarea.current) snapshot.selection = { sessionId: base.selectedId, start: base.textarea.current.selectionStart, end: base.textarea.current.selectionEnd }
  }

  function openShortcut(dialog: Shortcut) {
    if (!editable || !active) return
    rememberPosition()
    shortcutReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setDirectory((previous) => ({ ...previous, dialog, error: null, toolIds: dialog === "tools" ? base.draft.contextIds.filter((id) => tools.some((tool) => tool.id === id)) : previous.toolIds }))
  }

  function applyShortcut() {
    if (!editable) return
    if (directory.dialog === "tools") {
      base.updateDraft(configureTools(base.draft, directory.toolIds))
    } else {
      const result = directory.dialog === "agent"
        ? prepareAgent(base.draft, directory.agent, base.locale)
        : prepareWorkflow(base.draft, directory.workflowId, directory.workflowGoal, base.locale)
      if (result.error) {
        setDirectory((previous) => ({ ...previous, error: result.error }))
        return
      }
      base.updateDraft(result.draft)
    }
    shortcutReturnFocus.current = base.textarea.current
    setDirectory((previous) => ({ ...previous, preparedAgentName: previous.dialog === "agent" ? previous.agent.name.trim() : previous.preparedAgentName, notice: previous.dialog, dialog: null, error: null }))
    base.focusComposer()
  }

  return { ...base, rememberPosition, directory, setDirectory, editable, openShortcut, applyShortcut, shortcutReturnFocus }
}
