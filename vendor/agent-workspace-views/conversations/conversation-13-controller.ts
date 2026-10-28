"use client"
import { useRef, useState, type RefObject } from "react"
import type { Copy } from "../model"
import type { ComposerDemoController } from "../demo-controller"
import { useThreadController, type ThreadController } from "./shared"
import type {
  Conversation13Fixture,
  Conversation13Scenario,
  QueuedRequest,
} from "./conversation-13-fixtures"
export type QueueState = {
  items: QueuedRequest[]
  phase: "busy" | "ready" | "unknown"
  attempted: boolean
  notice?: Copy
  editId?: string
  editText: string
  editError?: Copy
}
export interface Conversation13Controller extends ComposerDemoController {
  readState: ThreadController["readState"]
  setReadState: ThreadController["setReadState"]
  queue: QueueState
  enqueueMode: boolean
  editFocus: RefObject<HTMLElement | null>
  finish: () => void
  reconcile: () => void
  move: (id: string, offset: number) => void
  remove: (id: string) => void
  beginEdit: (id: string) => void
  setEditText: (text: string) => void
  closeEdit: () => void
  saveEdit: () => void
  deliver: () => void
}
export function useConversation13Controller(
  fixture: Conversation13Fixture,
  scenario: Conversation13Scenario,
  active: boolean,
): Conversation13Controller {
  const base = useThreadController(
    {
      ...fixture.source,
      initialReadingPosition: scenario === "long" ? "start" : "latest",
    },
    scenario,
    active,
  )
  const sequence = useRef(4)
  const editFocus = useRef<HTMLElement | null>(null)
  const [states, setStates] = useState<Record<string, QueueState>>(() => ({
    [fixture.source.selectedId]: {
      items: structuredClone(fixture.items),
      phase:
        scenario === "unknown"
          ? "unknown"
          : scenario === "delivery-error" || scenario === "empty"
            ? "ready"
            : "busy",
      attempted: false,
      editText: "",
    },
  }))
  const state = states[base.selectedId] ?? {
    items: [],
    phase: "ready" as const,
    attempted: false,
    editText: "",
  }
  const update = (patch: Partial<QueueState>) =>
    setStates((previous) => ({
      ...previous,
      [base.selectedId]: { ...state, ...patch },
    }))
  const enqueueMode = state.phase !== "ready" || state.items.length > 0
  return {
    ...base,
    queue: state,
    enqueueMode,
    editFocus,
    sendMessage: () => {
      if (!base.draft.text.trim() || !base.canSend) return
      if (!enqueueMode) {
        base.sendMessage()
        return
      }
      update({
        items: [
          ...state.items,
          { id: `q${sequence.current++}`, draft: structuredClone(base.draft) },
        ],
      })
      base.updateDraft({ text: "", contextIds: [] })
      base.focusComposer()
    },
    finish: () => {
      if (state.phase === "busy") {
        update({ phase: "ready" })
        base.focusComposer()
      }
    },
    reconcile: () => {
      if (state.phase === "unknown")
        update({
          phase: "ready",
          notice: {
            "zh-CN": "本地回执确认尚未投递；队列未自动重放。",
            en: "Fixture receipt confirms no delivery; the queue was not replayed.",
          },
        })
      base.focusComposer()
    },
    move: (id: string, offset: number) => {
      const index = state.items.findIndex((item) => item.id === id)
      const target = index + offset
      if (index < 0 || target < 0 || target >= state.items.length) return
      const items = [...state.items]
      ;[items[index], items[target]] = [items[target], items[index]]
      update({ items })
    },
    remove: (id: string) => {
      update({ items: state.items.filter((item) => item.id !== id) })
      base.focusComposer()
    },
    beginEdit: (id: string) => {
      const item = state.items.find((item) => item.id === id)
      if (!item) return
      editFocus.current = document.activeElement as HTMLElement
      update({
        editId: id,
        editText: base.copy(item.draft.text),
        editError: undefined,
      })
    },
    setEditText: (editText: string) =>
      update({ editText, editError: undefined }),
    closeEdit: () => update({ editId: undefined }),
    saveEdit: () => {
      if (!state.editText.trim()) {
        update({
          editError: {
            "zh-CN": "指令不能为空。",
            en: "An instruction cannot be empty.",
          },
        })
        return
      }
      update({
        items: state.items.map((item) =>
          item.id === state.editId
            ? { ...item, draft: { ...item.draft, text: state.editText.trim() } }
            : item,
        ),
        editId: undefined,
        editError: undefined,
      })
    },
    deliver: () => {
      if (state.phase !== "ready" || !state.items.length) return
      if (scenario === "delivery-error" && !state.attempted) {
        update({
          attempted: true,
          notice: {
            "zh-CN": "本地投递示例失败；指令保留，可显式重试。",
            en: "Local delivery example failed; request preserved for explicit retry.",
          },
        })
        return
      }
      const item = state.items[0]
      const id = sequence.current++
      base.setSessions((previous) =>
        previous.map((session) =>
          session.id === base.selectedId
            ? {
                ...session,
                messages: [
                  ...session.messages,
                  {
                    id: `queued-user-${id}`,
                    role: "user",
                    text: item.draft.text,
                    contexts: item.draft.contextIds.map(
                      (id) =>
                        base.contextItems.find((context) => context.id === id)
                          ?.name ?? id,
                    ),
                  },
                  {
                    id: `queued-answer-${id}`,
                    role: "assistant",
                    text: {
                      "zh-CN": "已收到这条本地队列指令；没有调用 Agent 服务。",
                      en: "Received this local queued instruction; no Agent service was called.",
                    },
                  },
                ],
              }
            : session,
        ),
      )
      update({
        items: state.items.slice(1),
        notice: {
          "zh-CN": "队列指令已加入本地会话。",
          en: "Queued instruction added to the local conversation.",
        },
      })
      base.focusComposer()
    },
  }
}
