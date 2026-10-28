"use client"

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Bold,
  Check,
  ChevronDown,
  Download,
  FileText,
  Italic,
  List,
  Maximize2,
  Minimize2,
  PanelRight,
  RotateCcw,
  Undo2,
  Redo2,
  X,
} from "lucide-react"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@easyuse-ui/ui/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@easyuse-ui/ui/components/ui/dialog"
import { ResizableHandle } from "@easyuse-ui/ui/components/ui/resizable"
import { DataRegion } from "@easyuse-ui/ui/components/ui/data-region"
import {
  ChatComposer,
  ChatMessage,
} from "@easyuse-ui/ui/components/blocks/chat-message"
import {
  RemainingPageStateProvider,
  useRemainingPageState,
} from "../../showcase/state"
import {
  remainingPageScenarios,
  type RemainingPageProps,
} from "../../showcase/model"
import {
  acceptRevision,
  commitDocument,
  createWritingState,
  passageIsCurrent,
  redoDocument,
  suggestRevision,
  undoDocument,
  wordCount,
  type Revision,
} from "./controller"
import {
  editorPassage,
  editorSnapshot,
  passageRange,
  plainTextExport,
  replacePassage,
  restorePassage,
} from "./editor"
import styles from "./view.module.css"

export const pageScenarios = remainingPageScenarios
export function RemainingPageView(props: RemainingPageProps) {
  return (
    <RemainingPageStateProvider cache={props.cache}>
      <WritingWorkspace key={props.scenario} {...props} />
    </RemainingPageStateProvider>
  )
}
function WritingWorkspace({ scenario, active }: RemainingPageProps) {
  const { locale } = useI18n()
  const label = (zh: string, en: string) => (locale === "en" ? en : zh)
  const [state, setState] = useRemainingPageState(
    "document-writing-workspace:" + scenario,
    () => createWritingState(scenario),
  )
  const frame = useRef<HTMLDivElement>(null)
  const editor = useRef<HTMLDivElement>(null)
  const history = useRef<HTMLDivElement>(null)
  const documentScroll = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLDivElement>(null)
  const initial = useRef({
    chat: state.chatScroll,
    document: state.documentScroll,
    input: state.inputSelection,
  })
  const id = useId()
  const [frameWidth, setFrameWidth] = useState(1451)
  const [formats, setFormats] = useState({
    bold: false,
    italic: false,
    list: false,
    block: "p",
  })
  const readonly = scenario === "readonly"
  const ready = state.readState !== "loading"
  const words = wordCount(state.document.html.replace(/<[^>]*>/g, " "))

  useLayoutEffect(() => {
    const element = editor.current
    if (!element) return
    if (element.innerHTML !== state.document.html) {
      const focused = element.contains(document.activeElement)
      element.innerHTML = state.document.html
      if (focused && state.selection) restorePassage(element, state.selection)
    }
  }, [state.document.html, state.selection, ready])
  useLayoutEffect(() => {
    if (history.current) history.current.scrollTop = initial.current.chat
    if (documentScroll.current)
      documentScroll.current.scrollTop = initial.current.document
    const input = composer.current?.querySelector("textarea")
    input?.setSelectionRange(...initial.current.input)
  }, [])
  useLayoutEffect(() => {
    if (!active) return
    if (state.open && documentScroll.current)
      documentScroll.current.scrollTop = state.documentScroll
    if (!state.expanded && history.current)
      history.current.scrollTop = state.chatScroll
  }, [
    active,
    state.open,
    state.expanded,
    state.documentScroll,
    state.chatScroll,
  ])
  useEffect(() => {
    if (!active) return
    const remember = () => {
      const element = editor.current
      if (!element) return
      const passage = editorPassage(element)
      if (passage) {
        const node = window.getSelection()?.anchorNode?.parentElement
        setFormats({
          bold: document.queryCommandState("bold"),
          italic: document.queryCommandState("italic"),
          list: document.queryCommandState("insertUnorderedList"),
          block: node?.closest("h1,h2,h3") ? "h2" : "p",
        })
        setState((previous) =>
          previous.selection?.from === passage.from &&
          previous.selection?.to === passage.to &&
          previous.selection?.text === passage.text
            ? previous
            : { ...previous, selection: passage },
        )
      }
    }
    document.addEventListener("selectionchange", remember)
    return () => document.removeEventListener("selectionchange", remember)
  }, [active, setState])
  useEffect(() => {
    const root = frame.current
    if (!root) return
    const observer = new ResizeObserver(() => {
      const width = root.clientWidth
      setFrameWidth(width)
      setState((previous) =>
        previous.threadWidth === null || previous.threadWidth <= width - 420
          ? previous
          : { ...previous, threadWidth: Math.max(300, width - 420) },
      )
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [setState])
  const focusComposer = () =>
    requestAnimationFrame(() =>
      composer.current?.querySelector("textarea")?.focus(),
    )
  const rememberEdit = () => {
    if (!editor.current || readonly) return
    const snapshot = editorSnapshot(editor.current)
    const selection = editorPassage(editor.current)
    const node = window.getSelection()?.anchorNode?.parentElement
    setFormats({
      bold: document.queryCommandState("bold"),
      italic: document.queryCommandState("italic"),
      list: document.queryCommandState("insertUnorderedList"),
      block: node?.closest("h1,h2,h3") ? "h2" : "p",
    })
    setState((previous) => ({
      ...commitDocument(previous, snapshot),
      selection,
    }))
  }
  const locate = (revision: Revision) => {
    setState((previous) => ({
      ...previous,
      open: true,
      expanded: false,
      selection: revision.passage,
    }))
    requestAnimationFrame(() => {
      if (!editor.current) return
      if (restorePassage(editor.current, revision.passage)) {
        const range = passageRange(editor.current, revision.passage)
        const element = range?.startContainer.parentElement
        element?.scrollIntoView({ block: "center", behavior: "instant" })
      }
    })
  }
  const format = (command: string, value?: string) => {
    if (!editor.current || readonly) return
    if (state.selection) restorePassage(editor.current, state.selection)
    else editor.current.focus()
    document.execCommand(command, false, value)
    rememberEdit()
  }
  const accept = (revision: Revision) => {
    if (readonly || !editor.current) return
    if (!passageIsCurrent(state.document, revision.passage)) {
      setState((previous) => ({ ...previous, notice: "stale" }))
      return
    }
    const snapshot = replacePassage(
      editor.current,
      revision.passage,
      revision.replacement,
    )
    if (snapshot) {
      setState((previous) => acceptRevision(previous, revision.id, snapshot))
      requestAnimationFrame(
        () =>
          editor.current &&
          restorePassage(editor.current, {
            from: revision.passage.from,
            to: revision.passage.from + revision.replacement.length,
            text: revision.replacement,
          }),
      )
    }
  }
  const exportDocument = () => {
    if (!editor.current) return
    const url = URL.createObjectURL(
      new Blob([plainTextExport(editor.current)], {
        type: "text/plain;charset=utf-8",
      }),
    )
    const link = document.createElement("a")
    link.href = url
    link.download = "onboarding-brief.txt"
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
    setState((previous) => ({ ...previous, notice: "exported" }))
  }
  const selection = state.selection?.text.trim() ? state.selection : null
  const revisionStyleItems = [
    { value: "concise", label: label("更简洁", "More concise") },
    { value: "direct", label: label("更直接", "More direct") },
  ]
  const textStyleItems = [
    { value: "p", label: label("正文", "Text") },
    { value: "h2", label: label("标题", "Heading") },
  ]
  return (
    <div className={styles.page} data-document-writing-workspace>
      <header className={styles.pageHeader}>
        <h1>{label("文档写作", "Document writing")}</h1>
        <div>
          <span>{label("示例工作区", "Demo workspace")}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setState((previous) => ({ ...previous, resetOpen: true }))
            }
          >
            <RotateCcw />
            {label("重置", "Reset")}
          </Button>
        </div>
      </header>
      <div ref={frame} className={styles.workbench}>
        <section
          className={styles.thread}
          hidden={state.expanded && state.open}
          style={{ width: state.open ? (state.threadWidth ?? "38%") : "100%" }}
          aria-label={label("写作对话", "Writing conversation")}
        >
          <header className={styles.panelHeader}>
            <h2>{label("入门简报", "Onboarding brief")}</h2>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={label("打开文档", "Open document")}
              title={label("打开文档", "Open document")}
              onClick={() =>
                setState((previous) => ({ ...previous, open: true }))
              }
            >
              <PanelRight />
            </Button>
          </header>
          <div className={styles.historyFrame}>
            <div
              ref={history}
              className={styles.history}
              role="region"
              aria-label={label("对话消息", "Conversation messages")}
              tabIndex={0}
              onScroll={(event) => {
                if (!active || state.expanded) return
                const top = event.currentTarget.scrollTop
                setState((previous) =>
                  previous.chatScroll === top
                    ? previous
                    : { ...previous, chatScroll: top },
                )
              }}
            >
              <DataRegion
                state={state.readState === "loading" ? "loading" : "success"}
                hasContent={ready && !!state.revisions.length}
                emptyTitle={label("开始写作", "Start writing")}
                emptyDescription={label(
                  "直接编辑文档，然后选取一段文字进行修改。",
                  "Edit the document, then select a passage to revise.",
                )}
              >
                {state.revisions.length > 0 && (
                  <div
                    className={styles.messages}
                    role="log"
                    aria-live="polite"
                  >
                    <div className={styles.userRequest}>
                      {label(
                        "将我们的入门笔记整理成一份给产品团队的简短建议。",
                        "Turn our onboarding notes into a short recommendation for the product team.",
                      )}
                    </div>
                    <ChatMessage
                      id="document-ready"
                      role="agent"
                      author={label(
                        "EasyuseUI AI · 写作",
                        "EasyuseUI AI · Writing",
                      )}
                      content={label(
                        "草稿已显示在对话旁。你可以直接编辑，也可以选取一段文字进行有针对性的修改。",
                        "The draft is ready beside this conversation. You can edit it directly or select a passage for a focused revision.",
                      )}
                    >
                      <Button
                        variant="ghost"
                        className={styles.resourceCard}
                        onClick={() =>
                          setState((previous) => ({
                            ...previous,
                            open: true,
                            expanded: false,
                          }))
                        }
                      >
                        <FileText />
                        <span>
                          <strong>
                            {label("入门简报", "Onboarding brief")}
                          </strong>
                          <small>
                            {label("可编辑文档", "Editable document")} · {words}{" "}
                            {label("词", "words")}
                          </small>
                        </span>
                        <ArrowUpRight />
                      </Button>
                    </ChatMessage>
                    {state.revisions.map((revision) => (
                      <div key={revision.id}>
                        <div className={styles.userRequest}>
                          {revision.id === 1
                            ? label(
                                "将建议写得更简短、更直接。",
                                revision.instruction,
                              )
                            : revision.instruction}
                        </div>
                        <ChatMessage
                          id={"revision-" + revision.id}
                          role="agent"
                          author={label(
                            "EasyuseUI AI · 写作",
                            "EasyuseUI AI · Writing",
                          )}
                          content=""
                          renderContent={() => (
                            <>
                              <Button
                                variant="ghost"
                                className={styles.passage}
                                onClick={() => locate(revision)}
                              >
                                <span>
                                  {label("选中的段落", "Selected passage")}
                                </span>
                                <span>{revision.passage.text}</span>
                                <u>
                                  {label("在文档中定位", "Locate in document")}
                                </u>
                              </Button>
                              <section
                                className={styles.revision}
                                aria-label={label(
                                  "建议修改",
                                  "Suggested revision",
                                )}
                              >
                                <header>
                                  <span>
                                    {label("建议修改", "Suggested revision")}
                                  </span>
                                  <span>
                                    {revision.status === "pending"
                                      ? label("待审阅", "For review")
                                      : revision.status === "accepted"
                                        ? label("已应用", "Applied")
                                        : label("已忽略", "Dismissed")}
                                  </span>
                                </header>
                                {revision.status === "pending" ? (
                                  <div className={styles.revisionBody}>
                                    <label
                                      className="sr-only"
                                      htmlFor={id + revision.id}
                                    >
                                      {label(
                                        "替换内容",
                                        "Proposed replacement",
                                      )}
                                    </label>
                                    <Textarea
                                      id={id + revision.id}
                                      value={revision.replacement}
                                      readOnly={readonly}
                                      rows={5}
                                      onChange={(event) =>
                                        setState((previous) => ({
                                          ...previous,
                                          revisions: previous.revisions.map(
                                            (item) =>
                                              item.id === revision.id
                                                ? {
                                                    ...item,
                                                    replacement:
                                                      event.target.value,
                                                  }
                                                : item,
                                          ),
                                        }))
                                      }
                                    />
                                    <div className={styles.revisionActions}>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        disabled={readonly}
                                        onClick={() =>
                                          setState((previous) => ({
                                            ...previous,
                                            revisions: previous.revisions.map(
                                              (item) =>
                                                item.id === revision.id
                                                  ? {
                                                      ...item,
                                                      status: "dismissed",
                                                    }
                                                  : item,
                                            ),
                                          }))
                                        }
                                      >
                                        {label("忽略", "Dismiss")}
                                      </Button>
                                      <Button
                                        size="sm"
                                        disabled={
                                          readonly ||
                                          !revision.replacement.trim()
                                        }
                                        onClick={() => accept(revision)}
                                      >
                                        <Check />
                                        {label("接受修改", "Accept edit")}
                                      </Button>
                                    </div>
                                  </div>
                                ) : (
                                  <p className={styles.revisionBody}>
                                    {revision.replacement}
                                  </p>
                                )}
                              </section>
                            </>
                          )}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </DataRegion>
            </div>
            {state.revisions.length > 0 && (
              <Button
                className={styles.latest}
                variant="secondary"
                size="icon-sm"
                aria-label={label("滚动到最新消息", "Scroll to latest message")}
                onClick={() =>
                  history.current?.scrollTo({
                    top: history.current.scrollHeight,
                    behavior: "instant",
                  })
                }
              >
                <ArrowDown />
              </Button>
            )}
          </div>
          <div
            className={styles.composerDock}
            ref={composer}
            onSelect={(event) => {
              const input = event.target
              if (input instanceof HTMLTextAreaElement)
                setState((previous) => ({
                  ...previous,
                  inputSelection: [input.selectionStart, input.selectionEnd],
                }))
            }}
          >
            <ChatComposer
              presentation="workspace"
              inputLabel={label("修改指令", "Revision instruction")}
              formLabel={label("继续写作对话", "Continue writing conversation")}
              placeholder={
                selection
                  ? label(
                      "这段文字应该怎样修改？",
                      "How should this passage change?",
                    )
                  : label(
                      "选取一段文字以建议修改…",
                      "Select a passage to suggest an edit…",
                    )
              }
              sendContent={<ArrowUp />}
              value={state.instruction}
              onChange={(instruction) =>
                setState((previous) => ({ ...previous, instruction }))
              }
              onSend={() => {
                setState(suggestRevision)
                requestAnimationFrame(() =>
                  history.current?.scrollTo({
                    top: history.current.scrollHeight,
                    behavior: "instant",
                  }),
                )
                focusComposer()
              }}
              sendDisabled={readonly || !ready || !selection}
              sendLabel={label("建议修改", "Suggest revision")}
              controls={
                <div>
                <Select
                  items={revisionStyleItems}
                  value={state.style}
                  onValueChange={(value) =>
                    value &&
                    setState((previous) => ({
                      ...previous,
                      style: value as "concise" | "direct",
                    }))
                  }
                >
                  <SelectTrigger
                    className={styles.styleSelect}
                    aria-label={label("修改风格", "Revision style")}
                  >
                    <SelectValue />
                    <ChevronDown />
                  </SelectTrigger>
                  <SelectContent>
                    {revisionStyleItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                </div>
              }
            />
            <p>
              {readonly
                ? label(
                    "只读文档 · 无法应用修改",
                    "Read-only document · edits cannot be applied",
                  )
                : label(
                    "本地示例建议 · 应用前请审阅",
                    "Demo suggestions · review before applying",
                  )}
            </p>
          </div>
        </section>
        {state.open && !state.expanded && (
          <ResizableHandle
            unstyled
            className={styles.separator}
            value={state.threadWidth ?? frameWidth * 0.38}
            min={300}
            max={Math.max(300, frameWidth - 420)}
            onValueChange={(threadWidth) =>
              setState((previous) => ({ ...previous, threadWidth }))
            }
            label={label("调整文档编辑器宽度", "Resize document editor")}
            controls={id + "-document"}
          />
        )}
        <section
          id={id + "-document"}
          className={styles.document}
          hidden={!state.open}
          aria-label={label("写作文档", "Writing document")}
        >
          <header className={styles.panelHeader}>
            <FileText />
            <span>onboarding-brief</span>
            <small>{label("草稿", "Draft")}</small>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={
                state.expanded
                  ? label("显示对话", "Show conversation")
                  : label("展开文档", "Expand document")
              }
              title={
                state.expanded
                  ? label("显示对话", "Show conversation")
                  : label("展开文档", "Expand document")
              }
              onClick={() =>
                setState((previous) => ({
                  ...previous,
                  expanded: !previous.expanded,
                }))
              }
            >
              {state.expanded ? <Minimize2 /> : <Maximize2 />}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={label("关闭文档", "Close document")}
              title={label("关闭文档", "Close document")}
              onClick={() => {
                setState((previous) => ({
                  ...previous,
                  open: false,
                  expanded: false,
                }))
                focusComposer()
              }}
            >
              <X />
            </Button>
          </header>
          <div
            className={styles.toolbar}
            role="toolbar"
            aria-label={label("文档格式", "Document formatting")}
            onMouseDown={(event) => {
              if (
                event.target instanceof Element &&
                event.target.closest('button:not([role="combobox"])')
              )
                event.preventDefault()
            }}
          >
            <Select
              items={textStyleItems}
              value={formats.block}
              onValueChange={(value) => value && format("formatBlock", value)}
              disabled={readonly || !ready}
            >
              <SelectTrigger
                className={styles.styleSelect}
                aria-label={label("文字样式", "Text style")}
              >
                <SelectValue />
                <ChevronDown />
              </SelectTrigger>
              <SelectContent>
                {textStyleItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className={styles.toolDivider} />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={label("粗体", "Bold")}
              aria-pressed={formats.bold}
              title={label("粗体", "Bold")}
              disabled={readonly || !ready}
              onClick={() => format("bold")}
            >
              <Bold />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={label("斜体", "Italic")}
              aria-pressed={formats.italic}
              title={label("斜体", "Italic")}
              disabled={readonly || !ready}
              onClick={() => format("italic")}
            >
              <Italic />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={label("项目列表", "Bullet list")}
              aria-pressed={formats.list}
              title={label("项目列表", "Bullet list")}
              disabled={readonly || !ready}
              onClick={() => format("insertUnorderedList")}
            >
              <List />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={label("撤销文档修改", "Undo document edit")}
              title={label("撤销文档修改", "Undo document edit")}
              disabled={readonly || !state.undo.length}
              onClick={() => setState(undoDocument)}
            >
              <Undo2 />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={label("重做文档修改", "Redo document edit")}
              title={label("重做文档修改", "Redo document edit")}
              disabled={readonly || !state.redo.length}
              onClick={() => setState(redoDocument)}
            >
              <Redo2 />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={styles.export}
              disabled={!ready || !state.document.text}
              onClick={exportDocument}
            >
              <Download />
              {label("导出", "Export")}
            </Button>
          </div>
          {state.readState === "error" && (
            <div className={styles.notice} role="alert">
              {label(
                "刷新失败。保留当前文档和草稿。",
                "Refresh failed. Your document and draft are preserved.",
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setState((previous) => ({ ...previous, readState: "ready" }))
                }
              >
                {label("重新读取示例", "Reload fixture")}
              </Button>
            </div>
          )}
          {state.notice && (
            <div
              className={styles.notice}
              role={state.notice === "stale" ? "alert" : "status"}
            >
              {state.notice === "stale"
                ? label(
                    "原段落已经改变。重新选择文字后再建议修改。",
                    "The original passage has changed. Select the current text and request a new revision.",
                  )
                : label(
                    "已生成本地文本下载。",
                    "A local text download was generated.",
                  )}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={label("关闭提示", "Dismiss notice")}
                onClick={() =>
                  setState((previous) => ({ ...previous, notice: "" }))
                }
              >
                <X />
              </Button>
            </div>
          )}
          <div
            ref={documentScroll}
            className={styles.documentScroll}
            tabIndex={0}
            aria-label={label("文档阅读区", "Document reading area")}
            onScroll={(event) => {
              if (!active || !state.open) return
              const top = event.currentTarget.scrollTop
              setState((previous) =>
                previous.documentScroll === top
                  ? previous
                  : { ...previous, documentScroll: top },
              )
            }}
          >
            {state.readState === "loading" ? (
              <div className={styles.paperWrap}>
                <DataRegion
                  state="loading"
                  loadingLabel={label(
                    "正在读取示例文档",
                    "Loading fixture document",
                  )}
                />
                <Button
                  variant="secondary"
                  onClick={() =>
                    setState((previous) => ({
                      ...previous,
                      readState: "ready",
                    }))
                  }
                >
                  {label("载入示例文档", "Load fixture document")}
                </Button>
              </div>
            ) : (
              <div className={styles.paperWrap}>
                <article className={styles.paper}>
                  <div className={styles.documentMeta}>
                    {label(
                      "产品策略 · 2026年9月",
                      "Product strategy · September 2026",
                    )}
                  </div>
                  <div
                    ref={editor}
                    role="textbox"
                    aria-label={label("文档编辑器", "Document editor")}
                    aria-multiline="true"
                    aria-readonly={readonly}
                    contentEditable={!readonly}
                    suppressContentEditableWarning
                    className={styles.editor}
                    onInput={rememberEdit}
                    onPaste={(event) => {
                      event.preventDefault()
                      if (!readonly) {
                        document.execCommand(
                          "insertText",
                          false,
                          event.clipboardData.getData("text/plain"),
                        )
                        rememberEdit()
                      }
                    }}
                    onDrop={(event) => event.preventDefault()}
                    onKeyDown={(event) => {
                      if (
                        (event.ctrlKey || event.metaKey) &&
                        event.key.toLowerCase() === "z"
                      ) {
                        event.preventDefault()
                        setState(event.shiftKey ? redoDocument : undoDocument)
                      } else if (
                        (event.ctrlKey || event.metaKey) &&
                        event.key.toLowerCase() === "y"
                      ) {
                        event.preventDefault()
                        setState(redoDocument)
                      }
                    }}
                  />
                </article>
              </div>
            )}
          </div>
          <footer className={styles.documentFooter}>
            <span>
              {words} {label("词", "words")}
            </span>
            <span>
              {readonly
                ? label("只读", "Read only")
                : label(
                    "选取文字以修改段落",
                    "Select text to revise a passage",
                  )}
            </span>
          </footer>
        </section>
      </div>
      <Dialog
        open={state.resetOpen}
        onOpenChange={(resetOpen) =>
          setState((previous) => ({ ...previous, resetOpen }))
        }
      >
        <DialogContent>
          <DialogTitle>
            {label("重置示例工作区？", "Reset demo workspace?")}
          </DialogTitle>
          <DialogDescription>
            {label(
              "这会清除本场景内存中的文档修改、建议和草稿，不影响其他场景。",
              "This clears document edits, suggestions, and drafts in this scenario only. Other scenarios are unchanged.",
            )}
          </DialogDescription>
          <div className={styles.dialogActions}>
            <Button
              variant="secondary"
              onClick={() =>
                setState((previous) => ({ ...previous, resetOpen: false }))
              }
            >
              {label("取消", "Cancel")}
            </Button>
            <Button onClick={() => setState(createWritingState(scenario))}>
              {label("重置示例", "Reset demo")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
