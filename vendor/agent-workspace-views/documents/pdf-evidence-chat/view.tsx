"use client"

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react"
import { ArrowDown,
ArrowRight,
ArrowUp,
Check,
ChevronLeft,
ChevronRight, Copy as CopyIcon, Download,
FileText,
ListTree,
Monitor,
Moon,
PanelRight,
RotateCcw,
Search,
Sun,
X, } from "lucide-react"
import {
  Conversation,
  ChatComposer,
  type ConversationActions,
  type ChatMessageProps,
} from "@easyuse-ui/ui/components/blocks/chat-message"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { NativeSelect } from "@easyuse-ui/ui/components/ui/native-select"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@easyuse-ui/ui/components/ui/popover"
import { ResizableHandle } from "@easyuse-ui/ui/components/ui/resizable"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import {
  remainingPageScenarios,
  type RemainingPageProps,
} from "../../showcase/model"
import {
  RemainingPageStateProvider,
  useRemainingPageState,
} from "../../showcase/state"
import {
  answers,
  passages,
  reportPages,
  type Copy,
  type Passage,
} from "./fixtures"
import {
  createEvidenceState,
  reduceEvidence,
  researchPdf,
  searchEvidence,
  type EvidenceAction,
  type EvidenceState,
} from "./controller"
import styles from "./view.module.css"

export const pageScenarios = remainingPageScenarios

export function RemainingPageView(props: RemainingPageProps) {
  return (
    <RemainingPageStateProvider cache={props.cache}>
      <EvidenceWorkspace key={props.scenario} {...props} />
    </RemainingPageStateProvider>
  )
}

function EvidenceWorkspace({ scenario, active, host }: RemainingPageProps) {
  const { locale } = useI18n()
  const copy = (value: Copy) => value[locale]
  const label = (zh: string, en: string) => (locale === "en" ? en : zh)
  const [state, setState] = useRemainingPageState(
    `pdf-evidence-chat:${scenario}`,
    () => createEvidenceState(scenario),
  )
  const retained = useRef(state)
  const [feedback, setFeedback] = useState<Copy | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [pageError, setPageError] = useState(false)
  const [width, setWidth] = useState(0)
  const frame = useRef<HTMLDivElement>(null)
  const reader = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const searchField = useRef<HTMLInputElement>(null)
  const composer = useRef<HTMLDivElement>(null)
  const conversation = useRef<ConversationActions>(null)
  const jump = useRef<string | null>(
    state.positions[state.page] ? null : state.selectedId,
  )
  const id = useId()
  const selected = passages.find((passage) => passage.id === state.selectedId)
  const page = reportPages[state.page - 1]
  const matches = searchEvidence(state.search, locale)
  const unavailable =
    state.dataState === "loading" || state.dataState === "empty"
  const dispatch = useCallback(
    (action: EvidenceAction) =>
      setState((before) => reduceEvidence(before, action)),
    [setState],
  )

  useLayoutEffect(() => {
    retained.current = state
  }, [state])
  useLayoutEffect(() => {
    const element = frame.current
    if (!element) return
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    if (!active || !state.readerOpen || unavailable || !reader.current) return
    const scroll = reader.current
    if (jump.current) {
      const target = scroll.querySelector<HTMLElement>(
        `[data-passage-id="${jump.current}"]`,
      )
      if (target) {
        scroll.scrollTop = Math.max(
          0,
          target.getBoundingClientRect().top -
            scroll.getBoundingClientRect().top +
            scroll.scrollTop -
            100,
        )
        scroll.scrollLeft = 0
      }
      jump.current = null
    } else {
      const position = retained.current.positions[state.page]
      scroll.scrollTop = position?.top ?? 0
      scroll.scrollLeft = position?.left ?? 0
    }
  }, [
    active,
    state.readerOpen,
    state.page,
    state.selectedId,
    state.selectionRevision,
    state.zoom,
    unavailable,
  ])

  useLayoutEffect(() => {
    const history = frame.current?.querySelector<HTMLElement>(
      '[data-pdf-conversation] [tabindex="0"]',
    )
    if (history && active) history.scrollTop = retained.current.chatPosition
    const textarea = composer.current?.querySelector("textarea")
    if (textarea && active)
      textarea.setSelectionRange(
        retained.current.draftSelection.start,
        retained.current.draftSelection.end,
      )
    // Locale and theme updates deliberately leave the same editor and scroll elements mounted.
  }, [active])

  useEffect(() => {
    if (!active || !state.searchOpen) return
    searchField.current?.focus()
  }, [active, state.searchOpen])

  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        state.searchOpen &&
        reader.current?.parentElement?.contains(document.activeElement)
      ) {
        event.preventDefault()
        dispatch({ type: "search-toggle" })
        frame.current
          ?.querySelector<HTMLButtonElement>("[data-search-toggle]")
          ?.focus()
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [active, state.searchOpen, dispatch])

  const selectPassage = (passage: Passage) => {
    jump.current = passage.id
    dispatch({ type: "select", id: passage.id })
  }
  const navigatePage = (number: number) => {
    jump.current = null
    setPageError(false)
    dispatch({ type: "page", page: number })
  }
  const submitPage = () => {
    const number = Number(state.pageInput)
    if (
      !/^\d+$/.test(state.pageInput) ||
      !Number.isInteger(number) ||
      number < 1 ||
      number > reportPages.length
    ) {
      setPageError(true)
      return
    }
    navigatePage(number)
  }
  const closeReader = () => {
    dispatch({ type: "reader", open: false })
    requestAnimationFrame(() => opener.current?.focus())
  }
  const send = (value: string) => {
    if (!active || unavailable || state.readonly || !value.trim()) return
    dispatch({ type: "send", text: value })
  }
  const choosePrompt = (prompt: Copy) => {
    dispatch({ type: "draft", value: copy(prompt) })
    requestAnimationFrame(() =>
      composer.current?.querySelector("textarea")?.focus(),
    )
  }
  const copyPassage = async () => {
    if (!selected) return
    try {
      await navigator.clipboard.writeText(
        `${copy(selected.title)}\n${copy(selected.text)}\nfirst-week-research.pdf · p. ${selected.page}`,
      )
      setCopiedId(selected.id)
      setFeedback({
        "zh-CN": "已复制引用段落和页码。",
        en: "Cited passage and page number copied.",
      })
    } catch {
      setFeedback({
        "zh-CN": "剪贴板不可用；请在文档中选择段落后手动复制。",
        en: "Clipboard unavailable. Select the passage in the document and copy manually.",
      })
    }
  }
  const messages: ChatMessageProps[] = state.messages.map((message) => {
    if (message.role === "user")
      return {
        id: message.id,
        role: "user",
        author: "",
        content:
          typeof message.text === "string"
            ? message.text
            : message.text
              ? copy(message.text)
              : "",
      }
    const answer = answers[message.answer!]
    const sources = [...new Set(answer.points.map((point) => point.passageId))]
    return {
      id: message.id,
      role: "agent",
      author: label("EasyuseUI AI · 研究", "EasyuseUI AI · Research"),
      content: `${copy(answer.intro)}\n\n${answer.points.map((point) => copy(point.text)).join("\n\n")}`,
      renderContent: () => (
        <>
          <p>{copy(answer.intro)}</p>
          {answer.points.map((point) => {
            const passage = passages.find(
              (candidate) => candidate.id === point.passageId,
            )!
            return (
              <p key={point.passageId} className={styles.answerPoint}>
                <span>{copy(point.text)}</span>{" "}
                <Button
                  variant="ghost"
                  size="sm"
                  className={styles.citation}
                  aria-label={label(
                    `查看第 ${passage.page} 页证据：${copy(passage.title)}`,
                    `View evidence on page ${passage.page}: ${copy(passage.title)}`,
                  )}
                  aria-pressed={state.selectedId === passage.id}
                  onClick={() => selectPassage(passage)}
                >
                  p. {passage.page}
                </Button>
              </p>
            )
          })}
          <Button
            variant="ghost"
            size="default"
            className={styles.sourceTrigger}
            aria-expanded={state.sourcesOpen === message.id}
            aria-controls={`${id}-${message.id}-source`}
            onClick={() =>
              dispatch({
                type: "sources",
                messageId: state.sourcesOpen === message.id ? null : message.id,
              })
            }
          >
            <FileText aria-hidden="true" />
            {label(
              `1 个来源 · ${sources.length} 段证据`,
              `1 source · ${sources.length} passages`,
            )}
          </Button>
          {state.sourcesOpen === message.id && (
            <div id={`${id}-${message.id}-source`} className={styles.sources}>
              <p className={styles.sourceFilename}>
                {copy(reportPages[0].title)}
              </p>
              <p className={styles.sourceDescription}>
                {label(
                  "3 页 · 虚构研究报告",
                  "3 pages · Fictional research report",
                )}
              </p>
              <Button
                variant="outline"
                size="default"
                className={styles.sourceRead}
                onClick={() => {
                  navigatePage(1)
                  dispatch({ type: "reader", open: true })
                  dispatch({ type: "sources", messageId: message.id })
                }}
              >
                <FileText aria-hidden="true" />
                {label("阅读报告", "Read report")}
              </Button>
            </div>
          )}
        </>
      ),
    }
  })
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([researchPdf()], { type: "application/pdf" }),
    )
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = "first-week-research-local-fixture.pdf"
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  const readerWidth = width ? width * state.readerFraction : undefined
  const ThemeIcon =
    host.resolvedTheme === "dark"
      ? Moon
      : host.resolvedTheme === "light"
        ? Sun
        : Monitor
  return (
    <section ref={frame}
    className={styles.workspace}
    data-page="pdf-evidence-chat"
    data-scenario={scenario}
    data-active={active}><header className={styles.workspaceHeader}>
      <span>{label("PDF 证据", "PDF evidence")}</span>
      <div className={styles.headerActions}>
        <span>{label("示例工作空间", "Demo workspace")}</span>
        <Button
          variant="ghost"
          size="default"
          onClick={() => {
            jump.current = "setup"
            setState(createEvidenceState(scenario))
            setFeedback(null)
            setPageError(false)
            setCopiedId(null)
          }}
        >
          <RotateCcw aria-hidden="true" />
          {label("重置", "Reset")}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label("切换主题", "Toggle theme")}
          onClick={() =>
            host.setTheme(host.resolvedTheme === "dark" ? "light" : "dark")
          }
        >
          <ThemeIcon aria-hidden="true" />
        </Button>
      </div>
    </header>
    <div className={styles.split}>
      <section
        className={styles.thread}
        aria-label={label("报告对话", "Report conversation")}
      >
        <header className={styles.panelHeader}>
          <h1>{label("首周研究", "First-week research")}</h1>
          <Button
            ref={opener}
            variant="ghost"
            size="icon-sm"
            aria-label={
              state.readerOpen
                ? label("隐藏 PDF 阅读器", "Hide PDF reader")
                : label("显示 PDF 阅读器", "Show PDF reader")
            }
            aria-pressed={state.readerOpen}
            aria-controls={`${id}-reader`}
            onClick={() =>
              dispatch({ type: "reader", open: !state.readerOpen })
            }
          >
            <PanelRight aria-hidden="true" />
          </Button>
        </header>
        {state.dataState === "refresh-error" && (
          <div role="alert" className={styles.dataNotice}>
            <span>
              {label(
                "刷新失败，已有报告、对话与草稿已保留。",
                "Refresh failed; report, conversation, and draft are preserved.",
              )}
            </span>
            <Button
              variant="outline"
              size="default"
              onClick={() => dispatch({ type: "load" })}
            >
              {label("重试", "Retry")}
            </Button>
          </div>
        )}
        {state.readonly && (
          <p role="status" className={styles.dataNotice}>
            {label(
              "只读会话：可以编辑草稿与核对证据，但不能发送。",
              "Read-only conversation: draft and inspect evidence; sending is unavailable.",
            )}
          </p>
        )}
        <div
          className={styles.conversationArea}
          data-pdf-conversation
          onScrollCapture={(event) => {
            if ((event.target as HTMLElement).hasAttribute("tabindex"))
              dispatch({
                type: "chat-position",
                top: (event.target as HTMLElement).scrollTop,
              })
          }}
        >
          <Conversation
            presentation="workspace"
            layout="fill"
            initialScroll="top"
            actionsRef={conversation}
            className={styles.conversation}
            messages={messages}
            revision={state.messages.length}
            data={{
              state:
                state.dataState === "loading"
                  ? "loading"
                  : state.messages.length
                    ? "success"
                    : "empty",
              emptyTitle: label("向报告提问", "Ask about the report"),
              emptyDescription: label(
                "从一个问题开始；回答会关联可核对的 PDF 页码和段落。",
                "Start with a question. Prepared answers link to inspectable PDF pages and passages.",
              ),
            }}
          />
          {state.messages.length > 2 && (
            <Button
              variant="outline"
              size="icon-sm"
              className={styles.latest}
              aria-label={label("滚动到最新消息", "Scroll to latest message")}
              onClick={() => conversation.current?.jumpToLatest()}
            >
              <ArrowDown aria-hidden="true" />
            </Button>
          )}
          {unavailable && (
            <div className={styles.loadAction}>
              <Button
                variant="outline"
                onClick={() => dispatch({ type: "load" })}
              >
                {state.dataState === "loading"
                  ? label("完成示例加载", "Finish fixture load")
                  : label("加载示例报告", "Load sample report")}
              </Button>
            </div>
          )}
        </div>
        <div
          ref={composer}
          className={styles.composer}
          onSelectCapture={() => {
            const textarea = composer.current?.querySelector("textarea")
            if (textarea)
              dispatch({
                type: "draft-selection",
                start: textarea.selectionStart,
                end: textarea.selectionEnd,
              })
          }}
        >
          <div className={styles.suggestions}>
            <Button
              variant="outline"
              size="default"
              disabled={unavailable}
              onClick={() =>
                choosePrompt({
                  "zh-CN": "这项研究有哪些局限？",
                  en: "What are the study limitations?",
                })
              }
            >
              {label("研究局限", "Study limitations")}
              <ArrowRight aria-hidden="true" />
            </Button>
            <Button
              variant="outline"
              size="default"
              disabled={unavailable}
              onClick={() =>
                choosePrompt({
                  "zh-CN": "我们应该怎样开展首周试点？",
                  en: "What should the first-week pilot plan look like?",
                })
              }
            >
              {label("试点计划", "Pilot plan")}
              <ArrowRight aria-hidden="true" />
            </Button>
          </div>
          <ChatComposer textareaMinHeight={64} presentation="workspace"
          inputLabel={label("关于报告的问题", "Question about the report")}
          placeholder={label("向报告提问…", "Ask about the report…")}
          formLabel={label("向这份 PDF 提问", "Ask about this PDF")}
          sendContent={<ArrowUp aria-hidden="true" />}
          value={state.draft}
          onChange={(value) => dispatch({ type: "draft", value })}
          onSend={send}
          sendDisabled={!active || unavailable || state.readonly}
          controls={
            <span className={styles.reportCount}>
              <FileText aria-hidden="true" />
              {label("1 份报告", "1 report")}
            </span>
          }
          sendLabel={label("发送消息", "Send message")} />
          <p className={styles.disclaimer}>
            {label(
              "预设示例回答 · 请核对引用段落",
              "Prepared demo answers · verify against the cited passage",
            )}
          </p>
        </div>
      </section>
      {state.readerOpen && (
        <>
          <ResizableHandle
            unstyled
            className={styles.separator}
            label={label("调整 PDF 阅读器宽度", "Resize PDF reader")}
            controls={`${id}-reader`}
            reverse
            value={readerWidth ?? 800}
            min={width * 0.32 || 320}
            max={width * 0.76 || 1100}
            onValueChange={(value) => {
              if (width) dispatch({ type: "resize", fraction: value / width })
            }}
          />
          <section
            id={`${id}-reader`}
            className={styles.reader}
            aria-label={label("PDF 证据阅读器", "PDF evidence reader")}
            style={{ width: readerWidth ?? "60%" }}
          >
            <header className={styles.panelHeader}>
              <div className={styles.filename}>
                <FileText aria-hidden="true" />
                <span>first-week-research.pdf</span>
              </div>
              <div className={styles.readerHeaderActions}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={label("下载示例 PDF", "Download fixture PDF")}
                  disabled={unavailable}
                  onClick={download}
                >
                  <Download aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={label("关闭 PDF 阅读器", "Close PDF reader")}
                  onClick={closeReader}
                >
                  <X aria-hidden="true" />
                </Button>
              </div>
            </header>
            <div
              role="toolbar"
              aria-label={label("PDF 导航", "PDF navigation")}
              className={styles.readerToolbar}
            >
              <div className={styles.readerTools}>
                <Popover
                  open={active && state.outlineOpen}
                  onOpenChange={(open) => dispatch({ type: "outline", open })}
                >
                  <PopoverTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={label("文档大纲", "Document outline")}
                        disabled={unavailable}
                      />
                    }
                  >
                    <ListTree aria-hidden="true" />
                  </PopoverTrigger>
                  <PopoverContent className={styles.outline}>
                    {reportPages.map((item) => (
                      <Button
                        key={item.number}
                        variant="ghost"
                        aria-current={
                          item.number === state.page ? "page" : undefined
                        }
                        onClick={() => navigatePage(item.number)}
                      >
                        <span>{item.number}</span>
                        {copy(item.section)}
                      </Button>
                    ))}
                  </PopoverContent>
                </Popover>
                <Button
                  data-search-toggle
                  variant="ghost"
                  size="icon-sm"
                  aria-label={label("搜索 PDF", "Search PDF")}
                  aria-pressed={state.searchOpen}
                  aria-controls={`${id}-search`}
                  disabled={unavailable}
                  onClick={() => dispatch({ type: "search-toggle" })}
                >
                  <Search aria-hidden="true" />
                </Button>
              </div>
              <div className={styles.pageControls}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={label("上一页 PDF", "Previous PDF page")}
                  disabled={state.page === 1 || unavailable}
                  onClick={() => navigatePage(state.page - 1)}
                >
                  <ChevronLeft aria-hidden="true" />
                </Button>
                <Input
                  aria-label={label("PDF 页码", "PDF page number")}
                  aria-invalid={pageError}
                  aria-describedby={
                    pageError ? `${id}-page-error` : undefined
                  }
                  inputMode="numeric"
                  className={styles.pageNumber}
                  value={state.pageInput}
                  disabled={unavailable}
                  onChange={(event) => {
                    setPageError(false)
                    dispatch({
                      type: "page-input",
                      value: event.target.value,
                    })
                  }}
                  onBlur={submitPage}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault()
                      submitPage()
                    }
                  }}
                />
                <span>/ {reportPages.length}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={label("下一页 PDF", "Next PDF page")}
                  disabled={state.page === reportPages.length || unavailable}
                  onClick={() => navigatePage(state.page + 1)}
                >
                  <ChevronRight aria-hidden="true" />
                </Button>
              </div>
              <NativeSelect
                aria-label={label("PDF 缩放", "PDF zoom")}
                value={state.zoom}
                disabled={unavailable}
                className={styles.zoom}
                onChange={(event) =>
                  dispatch({
                    type: "zoom",
                    zoom: event.target.value as EvidenceState["zoom"],
                  })
                }
              >
                <option value="fit">{label("适合宽度", "Fit width")}</option>
                {[75, 100, 125, 150].map((zoom) => (
                  <option key={zoom} value={zoom}>
                    {zoom}%
                  </option>
                ))}
              </NativeSelect>
            </div>
            {pageError && (
              <p
                role="alert"
                id={`${id}-page-error`}
                className={styles.pageError}
              >
                {label(
                  "请输入 1 到 3 之间的页码。",
                  "Enter a page number between 1 and 3.",
                )}
              </p>
            )}
            {state.searchOpen && (
              <div id={`${id}-search`} className={styles.searchBar}>
                <div className={styles.searchInput}>
                  <Search aria-hidden="true" />
                  <Input
                    ref={searchField}
                    aria-label={label("搜索报告文本", "Search report text")}
                    placeholder={label("在报告中查找…", "Find in report…")}
                    value={state.search}
                    onChange={(event) => {
                      const found = searchEvidence(event.target.value, locale)
                      jump.current = found[0]?.id ?? null
                      dispatch({
                        type: "search",
                        value: event.target.value,
                        locale,
                      })
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && matches.length) {
                        event.preventDefault()
                        const delta = event.shiftKey ? -1 : 1
                        jump.current =
                          matches[
                            (((state.searchIndex + delta) % matches.length) +
                              matches.length) %
                              matches.length
                          ].id
                        dispatch({ type: "search-step", delta, locale })
                      }
                    }}
                  />
                </div>
                <span role="status">
                  {state.search.trim()
                    ? matches.length
                      ? `${Math.min(state.searchIndex + 1, matches.length)} / ${matches.length}`
                      : label("无结果", "No results")
                    : ""}
                </span>
                {([-1, 1] as const).map((delta) => (
                  <Button
                    key={delta}
                    variant="ghost"
                    size="icon-sm"
                    disabled={!matches.length}
                    aria-label={
                      delta < 0
                        ? label("上一个搜索结果", "Previous search result")
                        : label("下一个搜索结果", "Next search result")
                    }
                    onClick={() => {
                      jump.current =
                        matches[
                          (((state.searchIndex + delta) % matches.length) +
                            matches.length) %
                            matches.length
                        ].id
                      dispatch({ type: "search-step", delta, locale })
                    }}
                  >
                    {delta < 0 ? (
                      <ChevronLeft aria-hidden="true" />
                    ) : (
                      <ChevronRight aria-hidden="true" />
                    )}
                  </Button>
                ))}
              </div>
            )}
            {selected && !unavailable && (
              <div className={styles.selectionBar}>
                <span className={styles.selectionDot} />
                <span className={styles.selectionTitle}>
                  {copy(selected.title)}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={label("复制引用段落", "Copy cited passage")}
                  onClick={() => void copyPassage()}
                >
                  {copiedId === selected.id ? (
                    <Check aria-hidden="true" />
                  ) : (
                    <CopyIcon aria-hidden="true" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={label(
                    "清除段落高亮",
                    "Clear passage highlight",
                  )}
                  onClick={() => {
                    setCopiedId(null)
                    dispatch({ type: "clear-highlight" })
                  }}
                >
                  <X aria-hidden="true" />
                </Button>
              </div>
            )}
            <div
              ref={reader}
              className={styles.paperViewport}
              data-pdf-reader-scroll
              aria-label={label(
                `PDF 第 ${state.page} 页：${copy(page.title)}`,
                `PDF page ${state.page}: ${copy(page.title)}`,
              )}
              tabIndex={0}
              onScroll={(event) =>
                dispatch({
                  type: "reader-position",
                  top: event.currentTarget.scrollTop,
                  left: event.currentTarget.scrollLeft,
                })
              }
            >
              {unavailable ? (
                <div
                  className={styles.readerEmpty}
                  aria-busy={state.dataState === "loading"}
                >
                  <FileText aria-hidden="true" />
                  <h2>
                    {state.dataState === "loading"
                      ? label("正在载入报告", "Loading report")
                      : label("尚未加载报告", "No report loaded")}
                  </h2>
                  <p>
                    {label(
                      "加载本地示例后，可查看页码和可核对的证据。",
                      "Load the local fixture to read pages and inspect evidence.",
                    )}
                  </p>
                </div>
              ) : (
                <article
                  className={styles.paper}
                  style={
                    {
                      "--pdf-paper-width":
                        state.zoom === "fit"
                          ? "100%"
                          : `${(816 * Number(state.zoom)) / 100}px`,
                      "--pdf-page-scale":
                        state.zoom === "fit"
                          ? Math.max(0.5, ((readerWidth ?? 864) - 48) / 612)
                          : (816 * Number(state.zoom)) / 100 / 612,
                    } as CSSProperties
                  }
                  data-pdf-page={state.page}
                >
                  <div className={styles.paperBrand}>
                    <span>
                      {state.page === 1
                        ? label(
                            "产品研究 / 实地笔记 07",
                            "PRODUCT RESEARCH / FIELD NOTES 07",
                          )
                        : state.page === 2
                          ? label(
                              "发现 / 观察笔记",
                              "FINDINGS / OBSERVATION NOTES",
                            )
                          : label(
                              "后续步骤 / 决策笔记",
                              "NEXT STEPS / DECISION NOTES",
                            )}
                    </span>
                    <span>{label("2026 年 9 月", "SEPTEMBER 2026")}</span>
                  </div>
                  <h2>{copy(page.title)}</h2>
                  <p className={styles.paperSubtitle}>
                    {copy(page.subtitle)}
                  </p>
                  <div className={styles.passages}>
                    {page.passageIds.map((passageId) => {
                      const passage = passages.find(
                        (candidate) => candidate.id === passageId,
                      )!
                      const match =
                        state.search.trim() &&
                        `${copy(passage.title)} ${copy(passage.text)}`
                          .toLocaleLowerCase(locale)
                          .includes(
                            state.search.trim().toLocaleLowerCase(locale),
                          )
                      return (
                        <section key={passage.id} className={styles.passage}>
                          <h3>{copy(passage.title)}</h3>
                          <button
                            type="button"
                            data-passage-id={passage.id}
                            aria-label={label(
                              `选择段落：${copy(passage.title)}`,
                              `Select passage: ${copy(passage.title)}`,
                            )}
                            aria-pressed={state.selectedId === passage.id}
                            className={styles.passageText}
                            data-match={match || undefined}
                            onClick={() => {
                              setCopiedId(null)
                              dispatch({ type: "select", id: passage.id })
                            }}
                          >
                            {copy(passage.text)}
                          </button>
                        </section>
                      )
                    })}
                  </div>
                  <footer className={styles.paperFooter}>
                    <span>
                      {label("首周研究报告", "First-week research report")}
                    </span>
                    <span>{state.page}</span>
                  </footer>
                </article>
              )}
            </div>
            <footer className={styles.readerFooter}>
              <span>
                {label(
                  `第 ${state.page} 页，共 ${reportPages.length} 页`,
                  `Page ${state.page} of ${reportPages.length}`,
                )}{" "}
                · {copy(page.section)}
              </span>
              <span>{label("示例研究报告", "Demo research report")}</span>
            </footer>
          </section>
        </>
      )}
    </div>
    {feedback && (
      <p role="status" className={styles.feedback}>
        {copy(feedback)}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label("关闭提示", "Dismiss notice")}
          onClick={() => setFeedback(null)}
        >
          <X aria-hidden="true" />
        </Button>
      </p>
    )}</section>
  )
}
