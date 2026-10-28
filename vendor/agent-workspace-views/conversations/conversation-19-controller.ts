"use client"
import { useRef, useState, type Dispatch, type SetStateAction } from "react"
import { useThreadController, type ThreadController } from "./shared"
import type { ComposerDemoController } from "../demo-controller"
import type { ChatEntry } from "../model"
import type {
  Conversation19Fixture,
  Conversation19Scenario,
  SessionCheckpoint,
} from "./conversation-19-fixtures"
export interface ConversationBranch {
  id: string
  name: string
  messages: ChatEntry[]
  checkpointId: string | null
}
interface BranchHistory {
  branches: ConversationBranch[]
  activeId: string
}
export interface Conversation19Controller
  extends ComposerDemoController, ThreadController {
  checkpoints: SessionCheckpoint[]
  branches: ConversationBranch[]
  activeBranchId: string
  pending: SessionCheckpoint | null
  setPending: Dispatch<SetStateAction<SessionCheckpoint | null>>
  branchReader: string | null
  setBranchReader: Dispatch<SetStateAction<string | null>>
  requestRestore: (id: string) => void
  confirmRestore: (fork: boolean) => void
  switchBranch: (id: string) => void
  cursor: number
  timeline: BranchHistory[]
  undo: () => void
  redo: () => void
  unknown: boolean
  reconcile: () => void
  laterTurns: number
}
export function useConversation19Controller(
  fixture: Conversation19Fixture,
  scenario: Conversation19Scenario,
  active: boolean,
): Conversation19Controller {
  const [unknown, setUnknown] = useState(scenario === "unknown")
  const base = useThreadController(fixture.source, scenario, active, {
    canSend: !unknown,
  })
  const initial: BranchHistory = {
    branches: [
      {
        id: "main",
        name: "main",
        messages: fixture.source.sessions[0].messages,
        checkpointId: null,
      },
    ],
    activeId: "main",
  }
  const [branches, setBranches] = useState<ConversationBranch[]>(
    initial.branches,
  )
  const [activeBranchId, setActiveBranchId] = useState("main")
  const [timeline, setTimeline] = useState<BranchHistory[]>([initial])
  const [cursor, setCursor] = useState(0)
  const [pending, setPending] = useState<SessionCheckpoint | null>(null)
  const [branchReader, setBranchReader] = useState<string | null>(null)
  const sequence = useRef(1)
  const liveBranches = branches.map((branch) =>
    branch.id === activeBranchId
      ? {
          ...branch,
          messages:
            base.selectedId === fixture.source.selectedId
              ? base.selected.messages
              : branch.messages,
        }
      : branch,
  )
  function apply(snapshot: BranchHistory) {
    setBranches(snapshot.branches)
    setActiveBranchId(snapshot.activeId)
    const branch = snapshot.branches.find(
      (value) => value.id === snapshot.activeId,
    )!
    base.rememberPosition()
    base.setSessions((previous) =>
      previous.map((session) =>
        session.id === fixture.source.selectedId
          ? { ...session, messages: structuredClone(branch.messages) }
          : session,
      ),
    )
    base.focusComposer()
  }
  function commit(next: BranchHistory) {
    setTimeline((previous) => [
      ...previous.slice(0, cursor),
      { branches: structuredClone(liveBranches), activeId: activeBranchId },
      structuredClone(next),
    ])
    setCursor(cursor + 1)
    apply(next)
  }
  return {
    ...base,
    checkpoints: fixture.checkpoints,
    branches: liveBranches,
    activeBranchId,
    pending,
    setPending,
    branchReader,
    setBranchReader,
    cursor,
    timeline,
    unknown,
    laterTurns: pending
      ? Math.max(0, base.selected.messages.length - pending.messages.length)
      : 0,
    requestRestore: (id) => {
      if (!unknown)
        setPending(fixture.checkpoints.find((point) => point.id === id) ?? null)
    },
    confirmRestore: (fork) => {
      if (unknown || !pending) return
      const n = sequence.current++
      const messages = structuredClone(pending.messages)
      if (fork) {
        const id = "fork-" + n
        commit({
          branches: [
            ...liveBranches,
            { id, name: id, messages, checkpointId: pending.id },
          ],
          activeId: id,
        })
      } else {
        const retained = {
          ...liveBranches.find((branch) => branch.id === activeBranchId)!,
          id: "retained-" + n,
          name: activeBranchId + " · retained " + n,
        }
        commit({
          branches: [
            ...liveBranches.map((branch) =>
              branch.id === activeBranchId
                ? { ...branch, messages, checkpointId: pending.id }
                : branch,
            ),
            retained,
          ],
          activeId: activeBranchId,
        })
      }
      setPending(null)
    },
    switchBranch: (id) => {
      if (
        unknown ||
        id === activeBranchId ||
        !branches.some((branch) => branch.id === id)
      )
        return
      commit({ branches: liveBranches, activeId: id })
    },
    undo: () => {
      if (unknown || cursor === 0) return
      setTimeline((previous) =>
        previous.map((entry, index) =>
          index === cursor
            ? {
                branches: structuredClone(liveBranches),
                activeId: activeBranchId,
              }
            : entry,
        ),
      )
      setCursor(cursor - 1)
      apply(timeline[cursor - 1])
    },
    redo: () => {
      if (unknown || cursor >= timeline.length - 1) return
      setCursor(cursor + 1)
      apply(timeline[cursor + 1])
    },
    reconcile: () => {
      setUnknown(false)
      base.focusComposer()
    },
  }
}
