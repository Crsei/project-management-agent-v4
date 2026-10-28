"use client"

import { useLayoutEffect, useRef, useState, type CSSProperties } from "react"
import { ArrowUp, MessageSquare, Monitor, Smartphone } from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { ChatComposer } from "@easyuse-ui/ui/components/blocks/chat-message"
import { CodePreview } from "@easyuse-ui/ui/components/blocks/code-preview"
import { DiffViewer } from "@easyuse-ui/ui/components/blocks/agent-workbench/review"
import {
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
} from "@easyuse-ui/ui/components/ui/tabs"
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
  createMobileState,
  reduceMobile,
  type MobileAction,
  type WorkspaceView,
} from "./controller"
import { MobilePreviewScreen } from "./screen"
import { mobileSource, sourceFile } from "./source-snapshot"
import styles from "./view.module.css"

export const pageScenarios = remainingPageScenarios

export function RemainingPageView(props: RemainingPageProps) {
  return (
    <RemainingPageStateProvider cache={props.cache}>
      <MobileWorkspace key={props.scenario} {...props} />
    </RemainingPageStateProvider>
  )
}

function MobileWorkspace({ scenario, active, host }: RemainingPageProps) {
  const { locale } = useI18n()
  const label = (zh: string, en: string) => (locale === "en" ? en : zh)
  const [state, setState] = useRemainingPageState(
    `mobile-screen-workspace:${scenario}`,
    () => createMobileState(scenario),
  )
  const dispatch = (action: MobileAction) =>
    setState((previous) => reduceMobile(previous, action))
  const conversation = useRef<HTMLDivElement>(null)
  const noteComposer = useRef<HTMLDivElement>(null)
  const changes = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const screen = useRef<HTMLDivElement>(null)
  const [frameWidth, setFrameWidth] = useState(300)
  const [screenScale, setScreenScale] = useState(0.68)

  useLayoutEffect(() => {
    const element = stage.current
    const display = screen.current
    if (!element || !display) return
    const measure = () => {
      const padding = Math.max(16, element.clientWidth * 0.03)
      setFrameWidth(
        Math.max(
          1,
          Math.min(
            element.clientWidth - 2 * padding,
            ((element.clientHeight - 2 * padding) * 433) / 882,
          ),
        ),
      )
      setScreenScale(display.getBoundingClientRect().width / 390)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    observer.observe(display)
    measure()
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    if (conversation.current)
      conversation.current.scrollTop = state.reading.conversation
    if (changes.current) changes.current.scrollTop = state.reading.changes
  }, [state.view, locale, state.reading.conversation, state.reading.changes])

  useLayoutEffect(() => {
    const field = noteComposer.current?.querySelector("textarea")
    const selection = state.selection["Review note"]
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
  }, [locale, state.selection])

  const saveNote = (text: string) => {
    dispatch({ type: "save-note", text })
    requestAnimationFrame(() => {
      if (conversation.current) {
        conversation.current.scrollTop = conversation.current.scrollHeight
        dispatch({
          type: "scroll",
          region: "conversation",
          value: conversation.current.scrollTop,
        })
      }
      noteComposer.current?.querySelector("textarea")?.focus()
    })
  }

  return (
    <section  className={styles.page}
    data-remaining-page="mobile-screen-workspace"
    data-active={active}
    data-scenario={scenario}><header className={styles.header} data-mobile-workspace-header>
      <div>
        <Smartphone size={16} />
        <h1>{label("手机画面工作台", "Mobile screen workspace")}</h1>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        title={label("切换主题", "Toggle theme")}
        aria-label={label("切换主题", "Toggle theme")}
        onClick={() =>
          host.setTheme(host.resolvedTheme === "dark" ? "light" : "dark")
        }
      >
        <Monitor size={16} />
      </Button>
    </header>
    <div className={styles.workspace}>
      <aside
        className={styles.conversation}
        aria-label={label("审阅对话", "Review conversation")}
      >
        <div className={styles.conversationHeader}>
          <MessageSquare size={16} />
          {label("对话", "Conversation")}
        </div>
        <div
          ref={conversation}
          className={styles.reviewThread}
          onScroll={(event) =>
            dispatch({
              type: "scroll",
              region: "conversation",
              value: event.currentTarget.scrollTop,
            })
          }
        >
          <p className={styles.intro}>
            {label(
              "审阅手机聊天流程。让消息保持易读，并让输入区触手可及。",
              "Review the mobile chat flow. Keep messages readable and the composer within reach.",
            )}
          </p>
          <p className={styles.instructions}>
            {label(
              "在预览中选择提示、发送消息或打开会话菜单。",
              "Try a starter prompt, send a message, or open the conversation menu in the preview.",
            )}
          </p>
          {state.refreshError && (
            <div className={styles.warning} role="alert">
              <p>
                {label(
                  "刷新失败，保留上次示例与全部草稿。",
                  "Refresh failed. The last example and all drafts are preserved.",
                )}
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => dispatch({ type: "retry" })}
              >
                {label("重新读取本地快照", "Read local snapshot again")}
              </Button>
            </div>
          )}
          {state.readonly && (
            <p className={styles.instructions}>
              {label(
                "只读场景：可以查看源码、变更和会话；不能提交消息或审阅笔记。",
                "Read-only scenario: inspect source, changes, and conversations; messages and review notes cannot be submitted.",
              )}
            </p>
          )}
          {state.notes.length > 0 && (
            <ol
              className={styles.notes}
              aria-label={label("审阅笔记", "Review notes")}
            >
              {state.notes.map((note) => (
                <li key={note.id}>{note.text}</li>
              ))}
            </ol>
          )}
        </div>
        <div
          ref={noteComposer}
          className={styles.noteComposer}
          onSelect={(event) => {
            const field = event.target
            if (field instanceof HTMLTextAreaElement)
              dispatch({
                type: "selection",
                field: "Review note",
                value: {
                  start: field.selectionStart,
                  end: field.selectionEnd,
                  direction: field.selectionDirection,
                },
              })
          }}
        >
          <ChatComposer
            value={state.noteDraft}
            onChange={(value) => dispatch({ type: "note-draft", value })}
            onSend={saveNote}
            disabled={state.dataState === "loading" || state.readonly}
            sendDisabled={state.dataState !== "ready"}
            inputLabel={label("审阅笔记", "Review note")}
            formLabel={label("添加审阅笔记", "Add a review note")}
            placeholder={label("添加审阅笔记…", "Add a review note…")}
            sendLabel={label("保存审阅笔记", "Save review note")}
            sendContent={<ArrowUp size={16} />}
            controls={
              <span>
                {label("保存在本次会话中", "Saved in this session")}
              </span>
            }
          />
          {state.dataState === "empty" && (
            <p className={styles.instructions}>
              {label(
                "先在手机预览中发送一条消息，即可添加笔记。",
                "Send a message in the mobile preview to enable review notes.",
              )}
            </p>
          )}
        </div>
      </aside>
      <section
        className={styles.artifact}
        aria-label={label("审阅产物", "Review artifact")}
      >
        <Tabs
          value={state.view}
          onValueChange={(value) =>
            dispatch({ type: "view", value: value as WorkspaceView })
          }
          className={styles.tabs}
        >
          <div className={styles.toolbar} data-mobile-toolbar>
            <TabsList
              className={styles.tabList}
              aria-label={label("工作区视图", "Workspace view")}
            >
              <TabsTab className={styles.tab} value="preview">
                {label("预览", "Preview")}
              </TabsTab>
              <TabsTab className={styles.tab} value="source">
                {label("源码", "Source")}
              </TabsTab>
              <TabsTab className={styles.tab} value="changes">
                {label("变更", "Changes")}
              </TabsTab>
            </TabsList>
            <Button
              size="sm"
              variant="ghost"
              aria-label={label("显示手机预览", "Show mobile preview")}
              onClick={() => dispatch({ type: "view", value: "preview" })}
            >
              {label("显示预览", "Show preview")}
            </Button>
          </div>
          <div className={styles.panels} data-view={state.view}>
            <div className={styles.reader} hidden={state.view === "preview"}>
              <TabsPanel
                className={styles.sourcePanel}
                value="source"
                keepMounted
              >
                <section
                  aria-label={label("画面源码", "Screen source")}
                  className={styles.codePanel}
                >
                  <div className={styles.panelTitle}>
                    ai-mobile-preview-screen.tsx
                  </div>
                  <div className={styles.code}>
                    <CodePreview
                      identity={`mobile-screen-workspace:${scenario}:screen`}
                      revision="mobile-screen-1"
                      code={mobileSource}
                      language="tsx"
                      ariaLabel={label(
                        "手机画面源码（只读）",
                        "Mobile screen source (read only)",
                      )}
                      state={
                        state.dataState === "loading" ? "loading" : "success"
                      }
                    />
                  </div>
                </section>
              </TabsPanel>
              <TabsPanel
                className={styles.sourcePanel}
                value="changes"
                keepMounted
              >
                <section
                  aria-label={label("画面变更", "Screen changes")}
                  className={styles.codePanel}
                >
                  <div className={styles.panelTitle}>
                    ai-mobile-preview-screen.tsx
                  </div>
                  <div
                    ref={changes}
                    className={styles.diff}
                    onScroll={(event) =>
                      dispatch({
                        type: "scroll",
                        region: "changes",
                        value: event.currentTarget.scrollTop,
                      })
                    }
                  >
                    <DiffViewer file={sourceFile} maximumLines={1000} />
                  </div>
                </section>
              </TabsPanel>
            </div>
            <TabsPanel className="sr-only" value="preview" keepMounted>
              <span>
                {label(
                  "交互式手机聊天预览",
                  "Interactive mobile chat preview",
                )}
              </span>
            </TabsPanel>
            <section
              className={styles.previewPanel}
              aria-label={label("手机模拟预览", "Mobile mock preview")}
              id="mobile-workspace-preview"
            >
              <div className={styles.panelTitle}>
                {label("手机聊天", "Mobile chat")}
              </div>
              <div ref={stage} className={styles.stage}>
                <div
                  className={styles.phone}
                  aria-label={label(
                    "交互式手机聊天预览",
                    "Interactive mobile chat preview",
                  )}
                  style={{ width: frameWidth }}
                >
                  <div className={styles.notch} aria-hidden="true">
                    <span />
                  </div>
                  <div ref={screen} className={styles.screen}>
                    <div
                      className={styles.device}
                      style={
                        { "--device-scale": screenScale } as CSSProperties
                      }
                    >
                      <MobilePreviewScreen
                        state={state}
                        dispatch={dispatch}
                        locale={locale}
                        active={active}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </Tabs>
      </section>
    </div></section>
  )
}
