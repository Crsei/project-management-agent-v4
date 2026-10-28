"use client"

import { useLayoutEffect, useRef, type Dispatch } from "react"
import {
  ArrowUp,
  BatteryFull,
  ChevronDown,
  ListChecks,
  Menu,
  Signal,
  Wifi,
  X,
} from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import {
  ChatComposer,
  ChatMessage,
} from "@easyuse-ui/ui/components/blocks/chat-message"
import { Skeleton } from "@easyuse-ui/ui/components/ui/skeleton"
import { starterPrompts } from "./fixtures"
import type { MobileAction, MobileState } from "./controller"
import styles from "./view.module.css"

type ScreenProps = {
  state: MobileState
  dispatch: Dispatch<MobileAction>
  locale: "zh-CN" | "en"
  active: boolean
}

/** A local interactive screen, not an iframe or a remote app session. */
export function MobilePreviewScreen({
  state,
  dispatch,
  locale,
  active,
}: ScreenProps) {
  const label = (zh: string, en: string) => (locale === "en" ? en : zh)
  const thread = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLElement>(null)
  const copy = (text: { "zh-CN": string; en: string }) => text[locale]
  const blocked = state.readonly || state.dataState === "loading"

  useLayoutEffect(() => {
    if (thread.current) thread.current.scrollTop = state.reading.mobile
  }, [state.view, locale, state.reading.mobile])

  useLayoutEffect(() => {
    const field = composer.current?.querySelector("textarea")
    const selection = state.selection.Message
    if (
      field &&
      selection &&
      (field.selectionStart !== selection.start ||
        field.selectionEnd !== selection.end ||
        field.selectionDirection !== selection.direction)
    )
      field.setSelectionRange(
        selection.start,
        selection.end,
        selection.direction,
      )
  }, [locale, state.view, state.selection.Message])

  useLayoutEffect(() => {
    if (state.menuOpen && active)
      menu.current?.querySelector<HTMLButtonElement>("button")?.focus()
  }, [state.menuOpen, active])

  const closeMenu = () => {
    dispatch({ type: "menu", open: false })
    requestAnimationFrame(() => opener.current?.focus())
  }
  const send = (text: string) => {
    const reader = thread.current
    const follow =
      !reader ||
      reader.scrollHeight - reader.scrollTop - reader.clientHeight <= 64
    dispatch({ type: "send", text })
    requestAnimationFrame(() => {
      if (reader && follow) {
        reader.scrollTop = reader.scrollHeight
        dispatch({ type: "scroll", region: "mobile", value: reader.scrollTop })
      }
      composer.current?.querySelector("textarea")?.focus()
    })
  }

  return (
    <div
      className={styles.mobileScreen}
      data-mobile-preview-screen
      aria-busy={state.dataState === "loading"}
    >
      <div className={styles.statusBar} aria-hidden="true">
        <span>9:41</span>
        <div>
          <Signal size={14} />
          <Wifi size={14} />
          <BatteryFull size={16} />
        </div>
      </div>
      <header className={styles.mobileHeader}>
        <Button
          ref={opener}
          variant="ghost"
          size="icon"
          aria-label={
            state.menuOpen
              ? label("关闭会话", "Close conversations")
              : label("打开会话", "Open conversations")
          }
          title={label("会话菜单", "Conversation menu")}
          aria-expanded={state.menuOpen}
          aria-controls="mobile-preview-conversations"
          onClick={() => dispatch({ type: "menu", open: !state.menuOpen })}
        >
          {state.menuOpen ? <X /> : <Menu />}
        </Button>
        <span className={styles.mobileIdentity}>
          <ListChecks size={16} />
        </span>
        <div className={styles.mobileTitle}>
          <p>{label("发布交接", "Release handoff")}</p>
          <p>{label("AI 工作台", "AI workspace")}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className={styles.model}
          aria-label={`${label("模型", "Model")}: ${state.model}. ${label("切换模型", "Switch model")}`}
          onClick={() => dispatch({ type: "model" })}
        >
          {state.model}
          <ChevronDown size={12} />
        </Button>
      </header>
      <div
        ref={thread}
        className={styles.mobileThread}
        data-mobile-thread
        role="region"
        aria-label={label("手机消息", "Mobile messages")}
        onScroll={(event) =>
          dispatch({
            type: "scroll",
            region: "mobile",
            value: event.currentTarget.scrollTop,
          })
        }
      >
        <p className={styles.today}>{label("今天", "Today")}</p>
        {state.dataState === "loading" ? (
          <div className={styles.loading}>
            <Skeleton className="h-16 w-4/5" />
            <Skeleton className="ml-auto h-10 w-3/5" />
            <Skeleton className="h-20 w-4/5" />
            <p role="status">
              {label("正在读取本地示例…", "Reading local example…")}
            </p>
          </div>
        ) : (
          <>
            {!state.messages.length && (
              <p className={styles.empty}>
                {label(
                  "尚无消息。选择一个提示或输入消息来体验预览。",
                  "No messages yet. Choose a prompt or enter a message to try the preview.",
                )}
              </p>
            )}
            <div className={styles.mobileMessages}>
              {state.messages.map((message) => (
                <ChatMessage
                  key={message.id}
                  id={message.id}
                  role={message.role === "assistant" ? "agent" : "user"}
                  content={copy(message.text)}
                  author={
                    message.role === "assistant"
                      ? label("本地示例回复", "Local example response")
                      : label("你", "You")
                  }
                />
              ))}
              {state.messages.length > 0 && (
                <section
                  className={styles.checklist}
                  aria-label={label("发布清单", "Release checklist")}
                >
                  <h2>{label("发布清单", "Release checklist")}</h2>
                  <ol>
                    {[
                      label("确认负责人", "Confirm owners"),
                      label("复核未完成检查", "Review open checks"),
                      label("发布状态更新", "Post launch update"),
                    ].map((step, index) => (
                      <li key={step}>
                        <span aria-hidden="true">{index + 1}</span>
                        {step}
                      </li>
                    ))}
                  </ol>
                </section>
              )}
            </div>
          </>
        )}
      </div>
      <div
        ref={composer}
        className={styles.mobileComposer}
        data-mobile-field="Message"
        onSelect={(event) => {
          const field = event.target
          if (field instanceof HTMLTextAreaElement)
            dispatch({
              type: "selection",
              field: "Message",
              value: {
                start: field.selectionStart,
                end: field.selectionEnd,
                direction: field.selectionDirection,
              },
            })
        }}
      >
        <div className={styles.prompts}>
          {starterPrompts.map((prompt) => (
            <Button
              key={prompt.id}
              variant="secondary"
              size="sm"
              disabled={blocked}
              onClick={() => {
                dispatch({ type: "draft", value: copy(prompt.text) })
                requestAnimationFrame(() =>
                  composer.current?.querySelector("textarea")?.focus(),
                )
              }}
            >
              {copy(prompt.text)}
            </Button>
          ))}
        </div>
        <ChatComposer
          value={state.draft}
          onChange={(value) => dispatch({ type: "draft", value })}
          onSend={send}
          disabled={blocked}
          inputLabel={label("消息", "Message")}
          formLabel={label("手机消息编辑器", "Mobile message composer")}
          placeholder={label("问点什么…", "Ask anything…")}
          sendLabel={label("发送消息", "Send message")}
          sendContent={<ArrowUp size={16} />}
          controls={
            <span className="sr-only">
              {label(
                "本地交互预览，不调用真实模型",
                "Local interactive preview; no real model request",
              )}
            </span>
          }
        />
        {state.readonly && (
          <p className={styles.mobileNotice}>
            {label(
              "只读预览：消息不可提交",
              "Read-only preview: sending is disabled",
            )}
          </p>
        )}
        {state.dataState === "loading" && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => dispatch({ type: "load" })}
          >
            {label("读取本地示例", "Load local example")}
          </Button>
        )}
      </div>
      <div className={styles.homeIndicator} aria-hidden="true">
        <span />
      </div>
      {state.menuOpen && (
        <nav
          ref={menu}
          id="mobile-preview-conversations"
          className={styles.mobileMenu}
          aria-label={label("手机会话", "Mobile conversations")}
          onKeyDown={(event) => {
            if (active && event.key === "Escape") {
              event.stopPropagation()
              closeMenu()
            }
          }}
        >
          <p>{label("会话", "Conversations")}</p>
          <Button variant="ghost" aria-current="page" onClick={closeMenu}>
            {label("发布交接", "Release handoff")}
          </Button>
          <Button
            variant="ghost"
            disabled={blocked}
            onClick={() => {
              dispatch({ type: "reset" })
              requestAnimationFrame(() => opener.current?.focus())
            }}
          >
            {label("重置预览", "Reset preview")}
          </Button>
        </nav>
      )}
    </div>
  )
}
