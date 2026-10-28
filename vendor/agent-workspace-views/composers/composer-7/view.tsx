"use client"

import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react"
import { BookOpen, Bot, Box, Braces, GitPullRequest, PencilLine, Plus, Terminal, Wrench } from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { ComposerWorkspaceView } from "../../composer-workspace-view"
import { ComposerInput } from "../../composer-input"
import { useComposerDemoController } from "../../demo-controller"
import type { ComposerDemoSource } from "../../demo-source"
import type { Draft } from "../../model"
import { remainingPageScenarios, type RemainingPageProps } from "../../showcase/model"
import { RemainingPageStateProvider, useRemainingPageState } from "../../showcase/state"
import { acceptSuggestion, canSubmit, createLocalResponse, filterSuggestions, findTrigger } from "./controller"
import { createFixture, type ShortcutItem } from "./fixtures"
import styles from "./view.module.css"

export const pageScenarios = [
  ...remainingPageScenarios,
  { id: "context", name: { "zh-CN": "上下文建议", en: "Context suggestions" } },
  { id: "shell", name: { "zh-CN": "Shell 模式", en: "Shell mode" } },
] as const

type SavedWorkspace = { source: ComposerDemoSource; globalCollapsed: boolean; sessionsVisible: boolean }
type EditorState = { caret: number; selectionEnd: number; dismissed: string | null; selected: number; readingPosition: number }

const subscribeHydration = () => () => {}
const clientHydrated = () => true
const serverHydrated = () => false

export function RemainingPageView(props: RemainingPageProps) {
  return <RemainingPageStateProvider cache={props.cache}><ComposerPage key={props.scenario} {...props} /></RemainingPageStateProvider>
}

function ComposerPage({ scenario, active, host }: RemainingPageProps) {
  const hydrated = useSyncExternalStore(subscribeHydration, clientHydrated, serverHydrated)
  const [saved, setSaved] = useRemainingPageState<SavedWorkspace>(`composer-7:${scenario}:workspace`, () => ({ source: createFixture(scenario), globalCollapsed: false, sessionsVisible: true }))
  const [source] = useState(() => saved.source)
  const controller = useComposerDemoController(source, active)
  const [editors, setEditors] = useRemainingPageState<Record<string, EditorState>>(`composer-7:${scenario}:editors`, () => ({}))
  const [dataState, setDataState] = useRemainingPageState(`composer-7:${scenario}:data`, () => scenario === "loading" ? "loading" : scenario === "refresh-error" ? "error" : "ready")
  const { label, copy, draft, selectedId, textarea: textareaRef, history: historyRef } = controller
  const editor = editors[selectedId]
  const caret = editor?.caret ?? draft.text.length
  const shell = draft.text.startsWith("!")
  const blocked = scenario === "readonly" || dataState === "loading"
  const trigger = shell || editor?.dismissed === draft.text ? null : findTrigger(draft.text, caret)
  const extraContexts: ShortcutItem[] = controller.contextItems.filter((item) => item.id === "long-file").map((item) => ({ id: item.id, title: { "zh-CN": item.name, en: item.name }, description: item.description, trailing: item.kind, kind: "component" }))
  const items = filterSuggestions(trigger, controller.locale, extraContexts)
  const selectedIndex = Math.min(editor?.selected ?? 0, Math.max(0, items.length - 1))
  const prefix = useId()
  const listId = `${prefix}-suggestions`
  const sequence = useRef(0)

  useEffect(() => {
    setSaved({ source: { ...source, sessions: controller.sessions, drafts: controller.drafts, selectedId, projectId: controller.projectId }, globalCollapsed: controller.globalCollapsed, sessionsVisible: controller.sessionsVisible })
  }, [controller.sessions, controller.drafts, selectedId, controller.projectId, controller.globalCollapsed, controller.sessionsVisible, setSaved, source])

  useLayoutEffect(() => {
    controller.setGlobalCollapsed(saved.globalCollapsed)
    controller.setSessionsVisible(saved.sessionsVisible)
    // These values initialize the mounted shell; subsequent changes belong to it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useLayoutEffect(() => {
    if (!active) return
    const position = editors[selectedId]
    const field = textareaRef.current
    const start = position?.caret ?? controller.draft.text.length

    if (field) field.setSelectionRange(start, position?.selectionEnd ?? start)
    if (historyRef.current) historyRef.current.scrollTop = position?.readingPosition ?? historyRef.current.scrollHeight
    // Selection and reading position are restored only on scenario/session activation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, active])

  function updateEditor(update: Partial<EditorState>) {
    setEditors((previous) => ({ ...previous, [selectedId]: { ...(previous[selectedId] ?? { caret, selectionEnd: caret, dismissed: null, selected: 0, readingPosition: 0 }), ...update } }))
  }
  function focusAt(position: number, selectionEnd = position) {
    updateEditor({ caret: position, selectionEnd })
    requestAnimationFrame(() => {
      textareaRef.current?.focus({ preventScroll: true })
      textareaRef.current?.setSelectionRange(position, selectionEnd)
    })
  }
  function updateDraft(update: Partial<Draft>) {
    if (blocked) return
    controller.updateDraft(update)
    if (update.text !== undefined) {
      const next = textareaRef.current?.selectionStart ?? update.text.length

      updateEditor({ caret: next, selectionEnd: next, dismissed: null, selected: 0 })
    }
  }
  function openShortcut(value: "/" | "@" | "!") {
    if (blocked) return
    const existing = shell ? draft.text.slice(1) : draft.text
    const isPrefixOnly = ["/", "@", "!"].includes(existing.trim())
    const insertionPoint = Math.max(0, caret - (shell ? 1 : 0))
    const before = existing.slice(0, insertionPoint)
    const insertion = `${before && !/\s$/.test(before) ? " " : ""}${value}`
    const text = value === "!" ? (shell ? draft.text : `!${isPrefixOnly ? "" : existing}`) : isPrefixOnly || !existing ? value : before + insertion + existing.slice(insertionPoint)
    controller.updateDraft({ text })
    updateEditor({ dismissed: null, selected: 0 })
    focusAt(value === "!" || isPrefixOnly || !existing ? text.length : before.length + insertion.length)
  }
  function selectItem(item: ShortcutItem) {
    if (!trigger || blocked) return
    const next = acceptSuggestion(draft, trigger, item)
    controller.updateDraft(next.draft)
    updateEditor({ dismissed: next.draft.text, selected: 0 })
    focusAt(next.caret)
  }
  function submit() {
    if (!canSubmit(draft, blocked) || trigger) return
    const text = draft.text.trim()
    const references = controller.contextItems.filter((item) => draft.contextIds.includes(item.id)).map((item) => item.name)
    const localId = () => `composer-7-${Date.now()}-${++sequence.current}`
    controller.setSessions((sessions) => sessions.map((session) => session.id === selectedId ? {
      ...session,
      title: session.messages.length ? session.title : text.slice(0, 80),
      messages: [...session.messages, { id: localId(), role: "user", text, contexts: references }, { id: localId(), role: "assistant", text: createLocalResponse(draft) }],
    } : session))
    controller.updateDraft({ text: shell ? "!" : "", contextIds: [] })
    updateEditor({ dismissed: null, selected: 0 })
    focusAt(shell ? 1 : 0)
    requestAnimationFrame(() => {
      if (historyRef.current) historyRef.current.scrollTop = historyRef.current.scrollHeight
    })
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!active || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    if (event.key === "Escape" && (trigger || shell)) {
      event.preventDefault()
      if (shell) {
        const start = Math.max(0, event.currentTarget.selectionStart - 1)
        const end = Math.max(0, event.currentTarget.selectionEnd - 1)
        controller.updateDraft({ text: draft.text.slice(1) })
        focusAt(start, end)
      } else updateEditor({ dismissed: draft.text })
    } else if (trigger && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault()
      if (items.length) updateEditor({ selected: (selectedIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length })
    } else if (trigger && event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      if (items[selectedIndex]) selectItem(items[selectedIndex])
    }
  }
  const inputController = { ...controller, updateDraft, sendMessage: submit, canSend: canSubmit(draft, blocked) && !trigger, removeContext: (id: string) => { if (!blocked) controller.removeContext(id) } }

  return <ComposerWorkspaceView controller={{ ...controller, chats: controller.chats.filter((session) => session.id !== "initial" || session.messages.length > 0), searchResults: controller.searchResults.filter((session) => session.id !== "initial" || session.messages.length > 0) }} host={host} presentation={{
    id: "composer-7",
    title: { "zh-CN": "Composer 7", en: "Composer 7" },
    welcome: { title: { "zh-CN": "开始一项专注任务", en: "Start a focused task" }, description: { "zh-CN": "描述你想达成的结果，或使用快捷入口。", en: "Describe the outcome below, or start with a shortcut." } },
    renderBody: () => <div className={styles.body} data-composer7-region="body">
      <div className={styles.content} ref={historyRef} onScroll={() => updateEditor({ readingPosition: historyRef.current?.scrollTop ?? 0 })} role="region" aria-label={label("对话记录", "Conversation history")} tabIndex={controller.hasMessages ? 0 : undefined}>
        {controller.hasMessages ? <div className={styles.history}>{controller.selected.messages.map((message) => <article key={message.id} className={styles.message} data-role={message.role}>
          <div className={styles.messageLabel}>{message.role === "user" ? label("你", "You") : label("本地 fixture 回复", "Local fixture response")}</div>
          <p>{copy(message.text)}</p>{!!message.contexts?.length && <small>{label("上下文", "Context")}: {message.contexts.join(" · ")}</small>}
        </article>)}</div> : <div className={styles.welcomeSpace}><div className={styles.welcome}>
          <span className={styles.logo}><Box size={20} aria-hidden="true" /></span>
          <h1>{label("开始一项专注任务", "Start a focused task")}</h1>
          <p>{label("描述你想达成的结果，或使用快捷入口。", "Describe the outcome below, or start with a shortcut.")}</p>
          <div className={styles.shortcuts}><Button variant="secondary" disabled={blocked} onClick={() => openShortcut("/")}><kbd>/</kbd>{label("运行命令", "Run a command")}</Button><Button variant="secondary" disabled={blocked} onClick={() => openShortcut("@")}><kbd>@</kbd>{label("添加上下文", "Attach context")}</Button><Button variant="secondary" disabled={blocked} onClick={() => openShortcut("!")}><kbd>!</kbd>{label("打开 Shell 模式", "Open shell mode")}</Button></div>
        </div></div>}
      </div>
      <div className={styles.dock}><div className={styles.inputShell} data-shell={shell} data-composer7-region="input-shell">
        {trigger && <div className={styles.palette} role="region" aria-label={trigger.kind === "command" ? label("命令建议", "Commands suggestions") : label("上下文建议", "Add context suggestions")}>
          <div className={styles.paletteHeader}><div><strong>{trigger.kind === "command" ? label("命令", "Commands") : label("添加上下文", "Add context")}</strong><p>{trigger.kind === "command" ? label("选择工作流", "Choose a workflow") : label("文件、文档和 Agent", "Files, documents, and agents")}</p></div><span className={styles.keys}><kbd>↑</kbd><kbd>↓</kbd><kbd>Enter</kbd></span></div>
          <div id={listId} role="listbox" aria-label={label("建议", "Suggestions")} aria-busy={dataState === "loading"} className={styles.options}>
            {dataState === "loading" ? <p role="status" className={styles.empty}>{label("正在加载建议…", "Loading suggestions…")} <Button variant="secondary" size="sm" onClick={() => setDataState("ready")}>{label("载入本地示例", "Load local fixtures")}</Button></p> : items.length ? items.map((item, index) => {
              const Icon = trigger.kind === "command" ? item.id === "review" ? GitPullRequest : item.id === "test" ? PencilLine : item.id === "explain" ? BookOpen : Wrench : item.kind === "agent" ? Bot : item.kind === "document" ? BookOpen : Braces
              return <div key={item.id} id={`${listId}-${item.id}`} role="option" aria-selected={selectedIndex === index} aria-disabled={blocked} className={styles.option} onPointerMove={() => updateEditor({ selected: index })} onMouseDown={(event) => event.preventDefault()} onClick={() => selectItem(item)}><span className={styles.optionIcon}><Icon size={16} aria-hidden="true" /></span><span className={styles.optionText}><strong>{copy(item.title)}</strong><small>{copy(item.description)}</small></span><span className={styles.trailing}>{copy(item.trailing)}</span></div>
            }) : <p className={styles.empty}>{label("没有匹配的建议。按 Esc 继续编辑。", "No matching suggestions. Press Esc to continue editing.")}</p>}
          </div>
        </div>}
        {dataState === "error" && <div className={styles.notice} role="alert">{label("建议刷新失败；现有建议和草稿已保留。", "Suggestions could not refresh; existing suggestions and drafts were preserved.")}<Button variant="secondary" size="sm" onClick={() => setDataState("ready")}>{label("重试本地读取", "Retry local read")}</Button></div>}
        {scenario === "readonly" && <p className={styles.notice} role="status">{label("只读示例：不能编辑、添加引用或提交。", "Read-only fixture: editing, attaching context, and submitting are unavailable.")}</p>}
        <ComposerInput controller={inputController} helpId={`${prefix}-help`} options={{
          hideSuggestion: true, showBlocksControl: false, showModelControl: !shell,
          formLabel: { "zh-CN": "命令与上下文 AI 输入", en: "Command and context AI composer" },
          inputLabel: { "zh-CN": "消息", en: "Message" },
          placeholder: shell ? { "zh-CN": "!输入 Shell 命令…", en: "!Enter shell command..." } : { "zh-CN": "随时提问，/ 选择命令，@ 添加上下文，! 进入 Shell…", en: "Ask anything, / for commands, @ for context, ! for shell..." },
          sendLabel: shell ? { "zh-CN": "记录 Shell 请求", en: "Record shell request" } : { "zh-CN": "发送消息", en: "Send message" },
          leadingAction: shell ? <span className={styles.shellLabel}><Terminal size={16} aria-hidden="true" />{label("Shell 模式", "Shell mode")}</span> : <Button variant="ghost" size="icon" disabled={blocked} aria-label={label("添加上下文", "Add context")} title={label("添加上下文", "Add context")} onClick={() => openShortcut("@")}><Plus /></Button>,
          tools: <span className={styles.help}>{shell ? label("Esc 退出 · 仅本地记录", "Esc to exit · Local record only") : trigger ? label("Esc 关闭", "Esc to close") : label("Shift + Enter 换行", "Shift + Enter for new line")}</span>,
          textareaProps: { role: "combobox", "aria-autocomplete": "list", "aria-expanded": Boolean(trigger), "aria-controls": trigger ? listId : undefined, "aria-activedescendant": trigger && items[selectedIndex] ? `${listId}-${items[selectedIndex].id}` : undefined, disabled: blocked || !hydrated, onKeyDown: keyDown, onSelect: (event) => { updateEditor({ caret: event.currentTarget.selectionStart, selectionEnd: event.currentTarget.selectionEnd }) } },
        }} />
      </div></div>
    </div>,
  }} />
}
