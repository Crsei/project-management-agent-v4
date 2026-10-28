"use client"

import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react"
import {
  ArrowLeftRight,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  FileDiff,
  Monitor,
  RotateCcw,
} from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Badge } from "@easyuse-ui/ui/components/ui/badge"
import { Checkbox } from "@easyuse-ui/ui/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@easyuse-ui/ui/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@easyuse-ui/ui/components/ui/sheet"
import { Skeleton } from "@easyuse-ui/ui/components/ui/skeleton"
import { ChatComposer, ChatMessage } from "@easyuse-ui/ui/components/blocks/chat-message"
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
  compareDocuments,
  contextKey,
  createComparisonState,
  diffText,
  pairKey,
  reduceComparison,
  type ComparisonAction,
  type Difference,
} from "./controller"
import styles from "./view.module.css"

export const pageScenarios = remainingPageScenarios

function PassageText({
  row,
  side,
  locale,
}: {
  row: Difference
  side: "before" | "after"
  locale: "zh-CN" | "en"
}) {
  const tokens = useMemo(
    () =>
      diffText(row.before?.text[locale] ?? "", row.after?.text[locale] ?? ""),
    [row, locale],
  )
  if (!row[side])
    return (
      <p className={styles.absent}>
        {locale === "en"
          ? "Section absent in this document"
          : "该文档中没有此段落"}
      </p>
    )
  const content: ReactNode[] = tokens
    .filter((token) =>
      side === "before" ? token.kind !== "added" : token.kind !== "removed",
    )
    .map((token, index) =>
      token.kind === "removed" ? (
        <del key={index}>{token.text}</del>
      ) : token.kind === "added" ? (
        <ins key={index}>{token.text}</ins>
      ) : (
        token.text
      ),
    )
  return <p>{content}</p>
}

export function RemainingPageView(props: RemainingPageProps) {
  return (
    <RemainingPageStateProvider cache={props.cache}>
      <ComparisonView key={props.scenario} {...props} />
    </RemainingPageStateProvider>
  )
}

function ComparisonView({ scenario, active, host }: RemainingPageProps) {
  const { locale } = useI18n()
  const label = (zh: string, en: string) => (locale === "en" ? en : zh)
  const [state, setState] = useRemainingPageState(
    `document-comparison:${scenario}`,
    () => createComparisonState(scenario),
  )
  const reader = useRef<HTMLDivElement>(null)
  const chat = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLDivElement>(null)
  const rows = useMemo(
    () =>
      compareDocuments(
        state.documents.find((document) => document.id === state.beforeId),
        state.documents.find((document) => document.id === state.afterId),
      ),
    [state.documents, state.beforeId, state.afterId],
  )
  const changes = rows.filter((row) => row.kind !== "unchanged")
  const selected = changes.find((row) => row.id === state.selectedId)
  const reviewed = state.reviewed[pairKey(state)] ?? []
  const key = contextKey(state)
  const messages = state.messages[key] ?? []
  const draft = state.drafts[key] ?? ""
  const unavailable = state.dataState === "loading" || !state.documents.length
  const dispatch = (action: ComparisonAction) =>
    setState((previous) => reduceComparison(previous, action))
  const seek = (action: ComparisonAction) => {
    setState((previous) => {
      const next = reduceComparison(previous, action)
      requestAnimationFrame(() => {
        const section = reader.current?.querySelector<HTMLElement>(
          `[data-passage="${next.selectedId}"]`,
        )
        if (section && reader.current?.getClientRects().length) {
          const passageBounds = section.getBoundingClientRect()
          const readerBounds = reader.current.getBoundingClientRect()
          if (passageBounds.top < readerBounds.top + 24)
            reader.current.scrollTop +=
              passageBounds.top - readerBounds.top - 24
          else if (passageBounds.bottom > readerBounds.bottom - 24)
            reader.current.scrollTop +=
              passageBounds.bottom - readerBounds.bottom + 24
        }
      })
      return next
    })
  }
  useLayoutEffect(() => {
    if (active && reader.current?.getClientRects().length)
      reader.current.scrollTop = state.scrollTop
    if (active && chat.current?.getClientRects().length)
      chat.current.scrollTop = state.chatScrollTop
  })
  const send = (text: string) => {
    if (!text.trim()) return
    const follow =
      !chat.current ||
      chat.current.scrollHeight -
        chat.current.scrollTop -
        chat.current.clientHeight <
        64
    dispatch({ type: "ask", text, locale })
    requestAnimationFrame(() => {
      if (follow && chat.current)
        chat.current.scrollTop = chat.current.scrollHeight
      composer.current?.querySelector("textarea")?.focus()
    })
  }
  return (
    <section className={styles.page}
    data-document-comparison
    data-active={active} ><header className={styles.header}>
      <span>{label("文档比较", "Document comparison")}</span>
      <div className={styles.actions}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label("重置文档比较", "Reset document comparison")}
          onClick={() => {
            dispatch({ type: "reset" })
            if (reader.current) reader.current.scrollTop = 0
          }}
        >
          <RotateCcw aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label("切换主题", "Toggle theme")}
          onClick={() =>
            host.setTheme(host.resolvedTheme === "dark" ? "light" : "dark")
          }
        >
          <Monitor aria-hidden="true" />
        </Button>
      </div>
    </header>
    <div className={styles.summary}>
      <div className={styles.intro}>
        <h1>{label("审阅入职指南", "Review the onboarding guide")}</h1>
        <p>
          {label(
            "原创演示文档 · 更改仅保留在本次会话",
            "Original demo documents · changes stay in this session",
          )}
        </p>
      </div>
      <div className={styles.reviewControls}>
        <label className={styles.filter}>
          <Checkbox
            checked={state.changesOnly}
            onCheckedChange={(value) => dispatch({ type: "filter", value })}
            disabled={unavailable}
          />
          <span>{label("仅显示差异", "Changes only")}</span>
        </label>
        <span className={styles.count} role="status">
          {label(
            `已审阅 ${reviewed.filter((id) => changes.some((row) => row.id === id)).length} / ${changes.length}`,
            `${reviewed.filter((id) => changes.some((row) => row.id === id)).length} of ${changes.length} reviewed`,
          )}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={unavailable || !changes.length}
          aria-label={label("上一处差异", "Previous difference")}
          onClick={() => seek({ type: "navigate", direction: -1 })}
        >
          <ChevronUp aria-hidden="true" />
        </Button>
        <span
          className={styles.position}
          aria-label={label("当前差异", "Current difference")}
        >
          {selected ? changes.indexOf(selected) + 1 : 0} / {changes.length}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={unavailable || !changes.length}
          aria-label={label("下一处差异", "Next difference")}
          onClick={() => seek({ type: "navigate", direction: 1 })}
        >
          <ChevronDown aria-hidden="true" />
        </Button>
      </div>
    </div>
    <div className={styles.documentSelectors}>
      {(["before", "after"] as const).map((side, index) => {
        const document = state.documents.find(
          (document) =>
            document.id ===
            (side === "before" ? state.beforeId : state.afterId),
        )
        return (
          <div
            key={side}
            className={styles.documentSelector}
            style={{ gridColumn: index ? 3 : 1 }}
          >
            <span>
              {side === "before"
                ? label("更改前", "Before")
                : label("更改后", "After")}
            </span>
            <Select
              value={side === "before" ? state.beforeId : state.afterId}
              onValueChange={(value) => {
                if (value) {
                  dispatch({ type: "documents", side, id: value })
                  if (reader.current) reader.current.scrollTop = 0
                }
              }}
              disabled={unavailable}
            >
              <SelectTrigger
                aria-label={
                  side === "before"
                    ? label("更改前的文档", "Before document")
                    : label("更改后的文档", "After document")
                }
                className={styles.selectTrigger}
              >
                <span>
                  {document?.label[locale] ??
                    label("选择文档", "Select document")}
                </span>
                <ChevronDown size={14} aria-hidden="true" />
              </SelectTrigger>
              <SelectContent>
                {state.documents.map((document) => (
                  <SelectItem key={document.id} value={document.id}>
                    {document.label[locale]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p>
              {document
                ? `${document.author} · ${document.date[locale]}`
                : "—"}
            </p>
          </div>
        )
      })}
      <Button
        className={styles.swap}
        variant="ghost"
        size="icon-sm"
        disabled={unavailable}
        aria-label={label("交换文档", "Swap documents")}
        onClick={() => {
          dispatch({ type: "swap" })
          if (reader.current) reader.current.scrollTop = 0
        }}
      >
        <ArrowLeftRight aria-hidden="true" />
      </Button>
    </div>
    {state.dataState === "refresh-error" && (
      <div className={styles.notice} role="alert">
        <span>
          {label(
            "刷新失败；仍保留上次读取的文档和审阅记录。",
            "Refresh failed; the last documents and review decisions are retained.",
          )}
        </span>
        <Button
          variant="secondary"
          onClick={() => dispatch({ type: "load" })}
        >
          {label("重新读取样例", "Reload fixture")}
        </Button>
      </div>
    )}
    {state.readonly && (
      <div className={styles.notice}>
        <span>
          {label(
            "只读审阅：可以比较文档和询问差异，但不能修改审阅记录。",
            "Read-only review: compare documents and ask about changes without changing review decisions.",
          )}
        </span>
      </div>
    )}
    <div
      ref={reader}
      className={styles.readers}
      aria-label={label("对齐文档阅读器", "Aligned document readers")}
      role="region"
      aria-busy={state.dataState === "loading"}
      onScroll={(event) => {
        if (active)
          dispatch({ type: "scroll", value: event.currentTarget.scrollTop })
      }}
      onKeyDown={(event) => {
        if (
          !active ||
          state.panelOpen ||
          !event.altKey ||
          (event.key !== "ArrowDown" && event.key !== "ArrowUp")
        )
          return
        event.preventDefault()
        seek({
          type: "navigate",
          direction: event.key === "ArrowDown" ? 1 : -1,
        })
      }}
      tabIndex={0}
    >
      {state.dataState === "loading" ? (
        <div className={styles.loading}>
          <p role="status">
            {label("正在读取文档样例…", "Loading document fixtures…")}
          </p>
          {[0, 1, 2].map((id) => (
            <div key={id} className={styles.skeletonRow}>
              <Skeleton className="h-3 w-28" />
              <div className={styles.columns}>
                <Skeleton className="h-20" />
                <Skeleton className="h-20" />
              </div>
            </div>
          ))}
          <Button
            variant="secondary"
            onClick={() => dispatch({ type: "load" })}
          >
            {label("完成样例读取", "Finish fixture load")}
          </Button>
        </div>
      ) : !state.documents.length ? (
        <div className={styles.empty}>
          <FileDiff size={20} aria-hidden="true" />
          <h2>{label("没有可比较的文档", "No documents to compare")}</h2>
          <p>
            {label(
              "载入两份本地样例，逐段查看差异及上下文。",
              "Load the two local documents to review changes in context.",
            )}
          </p>
          <Button onClick={() => dispatch({ type: "load" })}>
            {label("载入样例文档", "Load demo documents")}
          </Button>
        </div>
      ) : (
        <div className={styles.readerContent}>
          {!changes.length && (
            <div className={styles.noDifferences} role="status">
              <Check size={16} aria-hidden="true" />
              <span>
                {label(
                  "所选文档内容相同，没有差异。",
                  "The selected documents are identical. No differences to review.",
                )}
              </span>
            </div>
          )}
          {rows
            .filter((row) => !state.changesOnly || row.kind !== "unchanged")
            .map((row) => {
              const isSelected = selected?.id === row.id
              const isReviewed = reviewed.includes(row.id)
              const kindLabel =
                row.kind === "added"
                  ? label("新增", "added")
                  : row.kind === "removed"
                    ? label("删除", "removed")
                    : row.kind === "changed"
                      ? label("修改", "changed")
                      : label("未更改", "unchanged")
              return (
                <section
                  key={row.id}
                  data-passage={row.id}
                  aria-label={`${row.heading[locale]}: ${kindLabel}`}
                  className={`${styles.passage} ${isSelected ? styles.selected : ""}`}
                >
                  <div className={styles.passageHeading}>
                    <h2>{row.heading[locale]}</h2>
                    {row.kind !== "unchanged" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`${label("选择差异", "Select change")}: ${row.heading[locale]}`}
                        aria-pressed={isSelected}
                        onClick={() =>
                          dispatch({ type: "select", id: row.id })
                        }
                      >
                        <Badge size="sm" data-kind={row.kind}>
                          {kindLabel}
                        </Badge>
                        {isReviewed && (
                          <Check
                            size={12}
                            aria-label={label("已审阅", "Reviewed")}
                          />
                        )}
                        <span>
                          {isSelected
                            ? label("已选择", "Selected")
                            : label("选择差异", "Select change")}
                        </span>
                      </Button>
                    )}
                  </div>
                  <div className={styles.columns}>
                    <div className={styles.before}>
                      <PassageText row={row} side="before" locale={locale} />
                    </div>
                    <div className={styles.after}>
                      <PassageText row={row} side="after" locale={locale} />
                    </div>
                  </div>
                </section>
              )
            })}
        </div>
      )}
    </div>
    <footer className={styles.footer}>
      <div>
        <p>
          {selected?.heading[locale] ??
            label("没有选中的差异", "No difference selected")}
        </p>
        <span>
          {label(
            "结合完整文档上下文，逐段审阅。",
            "Review one passage in its full document context.",
          )}
        </span>
      </div>
      <div className={styles.actions}>
        <Button
          variant="secondary"
          disabled={unavailable || !selected || state.readonly}
          onClick={() => dispatch({ type: "review" })}
        >
          {selected && reviewed.includes(selected.id)
            ? label("标记未审阅", "Mark unreviewed")
            : label("标记已审阅", "Mark reviewed")}
        </Button>
        <Sheet
          open={active && state.panelOpen}
          onOpenChange={(open) => dispatch({ type: "panel", open })}
        >
          <SheetTrigger
            render={
              <Button
                disabled={unavailable || !selected}
                aria-expanded={state.panelOpen}
              />
            }
          >
            {label("询问这处差异", "Ask about this change")}
          </SheetTrigger>
          <SheetContent size={512} className={styles.contextPanel}>
            <SheetHeader className={styles.contextHeader}>
              <SheetTitle>
                {selected?.heading[locale] ??
                  label("差异上下文", "Change context")}
              </SheetTitle>
              <SheetDescription>
                {
                  state.documents.find(
                    (document) => document.id === state.beforeId,
                  )?.label[locale]
                }{" "}
                →{" "}
                {
                  state.documents.find(
                    (document) => document.id === state.afterId,
                  )?.label[locale]
                }
                .{" "}
                {label(
                  "回答仅基于所选段落。",
                  "Answers use only this selected passage.",
                )}
              </SheetDescription>
            </SheetHeader>
            <div
              ref={chat}
              className={styles.contextMessages}
              onScroll={(event) => {
                if (active)
                  dispatch({
                    type: "scroll",
                    chat: true,
                    value: event.currentTarget.scrollTop,
                  })
              }}
              role="log"
              aria-live="polite"
              aria-label={label(
                "所选段落问答",
                "Selected passage conversation",
              )}
            >
              {!messages.length && (
                <p className={styles.chatHint}>
                  {label(
                    "解释差异或检查需要审阅的内容。这是使用预先编写回答的本地演示。",
                    "Explain the difference or check what needs review. This is a local demo with authored answers.",
                  )}
                </p>
              )}
              {messages.map((message) => (
                <ChatMessage
                  key={`${key}:${message.id}`}
                  id={`comparison-${key}-${message.id}`}
                  role={message.role === "user" ? "user" : "agent"}
                  author={message.role === "user"
                    ? label("你", "You")
                    : label("本地审阅助手", "Local review assistant")}
                  content={typeof message.text === "string"
                    ? message.text
                    : message.text[locale]}
                />
              ))}
            </div>
            <div className={styles.contextComposer}>
              <Button
                variant="secondary"
                onClick={() =>
                  send(label("解释这处差异", "Explain this change"))
                }
              >
                {label("解释这处差异", "Explain this change")}
              </Button>
              <div ref={composer} className={styles.composer}>
                <ChatComposer
                  formLabel={label(
                    "询问所选差异",
                    "Ask about selected change",
                  )}
                  inputLabel={label(
                    "询问所选段落",
                    "Ask about the selected passage",
                  )}
                  placeholder={label(
                    "我应该检查什么？",
                    "What should I check?",
                  )}
                  value={draft}
                  onChange={(text) => dispatch({ type: "draft", text })}
                  onSend={send}
                  sendContent={<ArrowUp aria-hidden="true" />}
                  sendLabel={label("发送问题", "Send question")}
                  controls={
                    <span>
                      {label("仅限所选段落", "Selected passage only")}
                    </span>
                  }
                />
              </div>
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </footer></section>
  )
}
