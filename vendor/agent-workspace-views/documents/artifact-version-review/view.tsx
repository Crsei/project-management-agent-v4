"use client"

import { useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  Check,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  FileText,
  Monitor,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
} from "lucide-react"
import {
  Conversation,
  ChatComposer,
} from "@easyuse-ui/ui/components/blocks/chat-message"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Checkbox } from "@easyuse-ui/ui/components/ui/checkbox"
import { DataRegion } from "@easyuse-ui/ui/components/ui/data-region"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "@easyuse-ui/ui/components/ui/dialog"
import { ResizableHandle } from "@easyuse-ui/ui/components/ui/resizable"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@easyuse-ui/ui/components/ui/select"
import {
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
} from "@easyuse-ui/ui/components/ui/tabs"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import {
  RemainingPageStateProvider,
  useRemainingPageState,
} from "../../showcase/state"
import {
  remainingPageScenarios,
  type RemainingPageProps,
} from "../../showcase/model"
import { artifactFile, type ArtifactVersion } from "./fixtures"
import {
  askAboutVersions,
  compareVersions,
  createReviewState,
  getVersion,
  loadVersions,
  restoreVersion,
  selectVersion,
  versionMarkdown,
  wordDifference,
  type ArtifactChange,
} from "./controller"
import styles from "./review.module.css"

export const pageScenarios = remainingPageScenarios

export function RemainingPageView(props: RemainingPageProps) {
  return (
    <RemainingPageStateProvider cache={props.cache}>
      <ArtifactReview {...props} />
    </RemainingPageStateProvider>
  )
}

function ArtifactReview({ scenario, active, host, cache }: RemainingPageProps) {
  const { locale } = useI18n()
  const en = locale === "en"
  const label = (zh: string, english: string) => (en ? english : zh)
  const [state, setState] = useRemainingPageState(
    `artifact-version-review:${scenario}`,
    () => createReviewState(scenario),
  )
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [feedback, setFeedback] = useState<
    "copied" | "copy-error" | "downloaded" | ""
  >("")
  const [available, setAvailable] = useState(1000)
  const root = useRef<HTMLDivElement>(null)
  const split = useRef<HTMLDivElement>(null)
  const preview = useRef<HTMLDivElement>(null)
  const compare = useRef<HTMLDivElement>(null)
  const restoredReading = useRef<{
    preview: number | null
    compare: number | null
  }>({ preview: null, compare: null })
  const previousOpen = useRef(state.open)
  const reopen = useRef<HTMLButtonElement>(null)
  const historyTrigger = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const selected = getVersion(state, state.selected)
  const from = getVersion(state, state.from)
  const latest = state.versions.at(-1)
  const differences = useMemo(
    () => (selected && from ? compareVersions(from, selected) : []),
    [selected, from],
  )
  const changes = differences.filter((change) => change.kind !== "unchanged")
  const displayed = state.changesOnly ? changes : differences
  const width = Math.max(
    320,
    Math.min(available - 380, state.conversationWidth ?? (available - 1) * 0.4),
  )
  const scrollKey = `artifact-version-review:${scenario}:reading:${state.selected}:${state.from}:${state.tab}`
  useLayoutEffect(() => {
    const element = split.current
    if (!element) return
    const observer = new ResizeObserver(() => setAvailable(element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    if (!active || !state.open) return
    const element = state.tab === "preview" ? preview.current : compare.current
    if (!element) return
    element.scrollTop = Number(cache.get(scrollKey) ?? 0)
    // A translation may clamp the DOM without changing the saved logical position.
    restoredReading.current[state.tab] = element.scrollTop
  }, [
    active,
    cache,
    scrollKey,
    state.tab,
    state.open,
    locale,
    host.resolvedTheme,
    width,
  ])
  useLayoutEffect(() => {
    const history = root.current?.querySelector<HTMLElement>(
      "[data-follow-tail-list]",
    )?.parentElement?.parentElement
    if (history && cache.has("artifact-review:conversation-scroll"))
      history.scrollTop = Number(
        cache.get("artifact-review:conversation-scroll"),
      )
  }, [cache])
  useLayoutEffect(() => {
    if (previousOpen.current && !state.open && active) reopen.current?.focus()
    previousOpen.current = state.open
  }, [state.open, active])
  const canReview = Boolean(
    selected && from && state.data !== "loading" && active,
  )
  const historical = selected && latest && selected.id !== latest.id
  const versionOptions = [...state.versions].reverse().map((version) => ({
    value: String(version.id),
    label: `v${version.id}${version.id === latest?.id ? label(" · 最新", " · latest") : ""}`,
  }))
  const compareOptions = state.versions
    .filter((version) => version.id !== selected?.id)
    .map((version) => ({ value: String(version.id), label: `v${version.id}` }))
  const ask = (
    question: string,
    intent: "explain" | "impact" | "question" = "question",
  ) => {
    if (canReview)
      setState((previous) =>
        askAboutVersions(previous, question, locale, intent),
      )
  }
  const select = (id: number) => {
    setFeedback("")
    setState((previous) => selectVersion(previous, id))
  }
  const moveChange = (direction: number) => {
    if (!changes.length) return
    const index =
      state.activeChange < 0
        ? direction > 0
          ? 0
          : changes.length - 1
        : (state.activeChange + direction + changes.length) % changes.length
    setState((previous) => ({ ...previous, activeChange: index }))
    const target = compare.current?.querySelector<HTMLElement>(
      `[data-artifact-change="${changes[index].id}"]`,
    )
    target?.scrollIntoView({ block: "nearest", behavior: "instant" })
    target?.focus({ preventScroll: true })
  }
  return (
    <div
      ref={root}
      className={styles.page}
      data-page="artifact-version-review"
      data-review-scenario={scenario}
    >
      <header className={styles.header} data-artifact-region="header">
        <h1>{label("产物审阅", "Artifact review")}</h1>
        <div className={styles.headerActions}>
          <Button
            ref={reopen}
            variant="ghost"
            onClick={() =>
              setState((previous) => ({ ...previous, open: !previous.open }))
            }
            aria-expanded={state.open}
            aria-controls={panelId}
          >
            {state.open ? (
              <PanelRightClose aria-hidden="true" />
            ) : (
              <PanelRightOpen aria-hidden="true" />
            )}
            {state.open
              ? label("隐藏产物", "Hide artifact")
              : label("打开产物", "Open artifact")}
          </Button>
          <span>
            {label("演示 · 保存在本次会话", "Demo · saved in this session")}
          </span>
          <Dialog open={resetOpen} onOpenChange={setResetOpen}>
            <DialogTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={label("重置版本演示", "Reset version demo")}
                />
              }
            >
              <RotateCcw aria-hidden="true" />
            </DialogTrigger>
            <DialogContent>
              <DialogTitle>
                {label("重置版本演示？", "Reset version demo?")}
              </DialogTitle>
              <DialogDescription>
                {label(
                  "这会清除当前场景中的本地恢复版本、问题和草稿，重新载入示例。其他场景不受影响。",
                  "This clears local restored versions, questions, and drafts in this scenario and reloads the example. Other scenarios are unchanged.",
                )}
              </DialogDescription>
              <DialogFooter>
                <Button variant="secondary" onClick={() => setResetOpen(false)}>
                  {label("取消", "Cancel")}
                </Button>
                <Button
                  onClick={() => {
                    setState(createReviewState(scenario))
                    setFeedback("")
                    setResetOpen(false)
                    for (const key of cache.keys())
                      if (
                        key.startsWith(
                          `artifact-version-review:${scenario}:reading:`,
                        ) ||
                        key === "artifact-review:conversation-scroll"
                      )
                        cache.delete(key)
                  }}
                >
                  {label("重置演示", "Reset demo")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Button
            variant="ghost"
            size="icon"
            aria-label={label("切换主题", "Toggle theme")}
            onClick={() =>
              host.setTheme(host.resolvedTheme === "dark" ? "light" : "dark")
            }
          >
            {host.resolvedTheme === "dark" ? (
              <Moon aria-hidden="true" />
            ) : (
              <Monitor aria-hidden="true" />
            )}
          </Button>
        </div>
      </header>
      <div ref={split} className={styles.split} data-artifact-region="split">
        <section
          className={styles.conversation}
          style={{ flexBasis: state.open ? width : "100%" }}
          aria-label={label("版本审阅对话", "Version review conversation")}
        >
          <div className={styles.conversationHeader}>
            <h2>{label("对话", "Conversation")}</h2>
            <span>{label("产物审阅", "Artifact review")}</span>
          </div>
          <div
            className={styles.chat}
            onScrollCapture={(event) => {
              const target = event.target as HTMLElement
              if (target.querySelector("[data-follow-tail-list]"))
                cache.set(
                  "artifact-review:conversation-scroll",
                  target.scrollTop,
                )
            }}
          >
            <Conversation
              presentation="workspace"
              layout="fill"
              initialScroll="top"
              revision={state.messages.length}
              messages={state.messages.map((message) => ({
                id: message.id,
                role: message.role,
                author: message.role === "agent" ? "EasyuseUI AI" : "",
                content: message.text[locale],
              }))}
              data={{
                state:
                  state.data === "loading"
                    ? "loading"
                    : state.messages.length
                      ? "success"
                      : "empty",
                emptyTitle: label("尚无审阅记录", "No review history yet"),
                emptyDescription: label(
                  "载入示例版本后可以开始审阅。",
                  "Load the example versions to begin reviewing.",
                ),
              }}
            />
          </div>
          <div className={styles.composer} data-artifact-region="composer">
            <div className={styles.prompts}>
              <Button
                variant="secondary"
                disabled={!canReview}
                onClick={() =>
                  ask(
                    label("解释这些变化。", "Explain these changes."),
                    "explain",
                  )
                }
              >
                {label("解释变化", "Explain changes")}
              </Button>
              <Button
                variant="secondary"
                disabled={!canReview}
                onClick={() =>
                  ask(
                    label(
                      "恢复旧版本会产生什么影响？",
                      "What would restoring the earlier version change?",
                    ),
                    "impact",
                  )
                }
              >
                {label("恢复影响", "Restore impact")}
              </Button>
            </div>
            <ChatComposer
              presentation="workspace"
              inputLabel={label("版本审阅问题", "Artifact review question")}
              formLabel={label("询问版本变更", "Ask about artifact changes")}
              placeholder={label("询问这些变更…", "Ask about these changes…")}
              sendContent={<ArrowUp aria-hidden="true" />}
              value={state.draft}
              onChange={(draft) =>
                setState((previous) => ({ ...previous, draft }))
              }
              onSend={(question) => ask(question)}
              sendDisabled={!canReview}
              controls={
                <span className={styles.context}>
                  <FileText size={14} aria-hidden="true" />
                  {from && selected
                    ? `v${from.id} → v${selected.id}`
                    : label("无版本", "No version")}
                </span>
              }
              sendLabel={label("发送消息", "Send message")}
            />
            <p>
              {label(
                "回答来自已保存版本 · 无实时模型",
                "Demo answers from saved versions · no live model",
              )}
            </p>
          </div>
        </section>
        {state.open && (
          <ResizableHandle
            value={width}
            min={320}
            max={Math.max(320, available - 380)}
            onValueChange={(conversationWidth) =>
              setState((previous) => ({ ...previous, conversationWidth }))
            }
            label={label("调整产物审阅区域", "Resize artifact review")}
            controls={panelId}
            unstyled
            className={styles.divider}
          />
        )}
        <section
          id={panelId}
          className={styles.artifact}
          hidden={!state.open}
          aria-label={label("产物版本", "Artifact versions")}
        >
          <Tabs
            className={styles.artifactTabs}
            value={state.tab}
            onValueChange={(tab) => {
              if (tab === "preview" || tab === "compare")
                setState((previous) => ({ ...previous, tab }))
            }}
          >
            <div
              className={styles.artifactToolbar}
              data-artifact-region="artifact-toolbar"
            >
              <Select
                value={String(state.selected)}
                items={versionOptions}
                disabled={!selected}
                onValueChange={(value) => {
                  if (value) select(Number(value))
                }}
              >
                <SelectTrigger
                  ref={historyTrigger}
                  className={styles.versionSelect}
                  aria-label={label("版本历史", "Version history")}
                >
                  <SelectValue placeholder={label("无版本", "No version")} />
                  <ChevronDown size={14} aria-hidden="true" />
                </SelectTrigger>
                <SelectContent>
                  {state.versions.toReversed().map((version) => (
                    <SelectItem
                      key={version.id}
                      value={String(version.id)}
                    >{`v${version.id} · ${version.reason[locale]}`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className={styles.artifactActions}>
                <TabsList
                  aria-label={label("产物视图", "Artifact view")}
                  className={styles.viewTabs}
                >
                  <TabsTab value="preview">{label("预览", "Preview")}</TabsTab>
                  <TabsTab value="compare">{label("比较", "Compare")}</TabsTab>
                </TabsList>
                {historical && (
                  <Dialog open={restoreOpen} onOpenChange={setRestoreOpen}>
                    <DialogTrigger
                      render={
                        <Button
                          variant="secondary"
                          disabled={state.readonly || !active}
                        />
                      }
                    >
                      {label(
                        `恢复为 v${(latest?.id ?? 0) + 1}`,
                        `Restore as v${(latest?.id ?? 0) + 1}`,
                      )}
                    </DialogTrigger>
                    <DialogContent>
                      <DialogTitle>
                        {label(
                          `恢复版本 v${selected.id}？`,
                          `Restore version v${selected.id}?`,
                        )}
                      </DialogTitle>
                      <DialogDescription>
                        {label(
                          `将 v${selected.id} 的完整内容保存为新版本 v${(latest?.id ?? 0) + 1}。现有版本不会删除。此操作仅改变本次会话的本地示例。`,
                          `Save the full content of v${selected.id} as new version v${(latest?.id ?? 0) + 1}. Existing versions will not be deleted. This changes only the local example in this session.`,
                        )}
                      </DialogDescription>
                      <DialogFooter>
                        <Button
                          variant="secondary"
                          onClick={() => setRestoreOpen(false)}
                        >
                          {label("取消", "Cancel")}
                        </Button>
                        <Button
                          onClick={() => {
                            setState((previous) =>
                              restoreVersion(previous, selected.id),
                            )
                            setRestoreOpen(false)
                            setFeedback("")
                            if (active)
                              requestAnimationFrame(() =>
                                historyTrigger.current?.focus(),
                              )
                          }}
                        >
                          {label("确认恢复", "Confirm restore")}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={!selected}
                  aria-label={label(
                    `复制版本 ${state.selected}`,
                    `Copy version ${state.selected}`,
                  )}
                  onClick={async () => {
                    if (!selected) return
                    try {
                      await navigator.clipboard.writeText(
                        versionMarkdown(selected, locale),
                      )
                      setFeedback("copied")
                    } catch {
                      setFeedback("copy-error")
                    }
                  }}
                >
                  {feedback === "copied" ? (
                    <Check aria-hidden="true" />
                  ) : (
                    <Copy aria-hidden="true" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={!selected}
                  aria-label={label(
                    `下载版本 ${state.selected}`,
                    `Download version ${state.selected}`,
                  )}
                  onClick={() => {
                    if (!selected) return
                    const url = URL.createObjectURL(
                      new Blob([versionMarkdown(selected, locale)], {
                        type: "text/markdown;charset=utf-8",
                      }),
                    )
                    const link = document.createElement("a")
                    link.href = url
                    link.download = `onboarding-rollout-v${selected.id}.md`
                    link.click()
                    setTimeout(() => URL.revokeObjectURL(url), 1000)
                    setFeedback("downloaded")
                  }}
                >
                  <Download aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={label("关闭产物", "Close artifact")}
                  onClick={() =>
                    setState((previous) => ({ ...previous, open: false }))
                  }
                >
                  <PanelRightClose aria-hidden="true" />
                </Button>
              </div>
            </div>
            {feedback && (
              <p className={styles.feedback} role="status">
                {feedback === "copied"
                  ? label("已复制当前版本。", "Current version copied.")
                  : feedback === "copy-error"
                    ? label(
                        "剪贴板不可用，请下载版本。",
                        "Clipboard unavailable. Download this version instead.",
                      )
                    : label(
                        "已生成当前版本的 Markdown 下载。",
                        "Markdown download generated for this version.",
                      )}
              </p>
            )}
            <TabsPanel value="preview" keepMounted className={styles.panel}>
              <div
                ref={preview}
                className={styles.reviewScroll}
                onScroll={(event) => {
                  const node = event.currentTarget
                  if (
                    !active ||
                    !state.open ||
                    state.tab !== "preview" ||
                    !node.clientHeight ||
                    !node.clientWidth
                  )
                    return
                  if (restoredReading.current.preview === node.scrollTop) return
                  restoredReading.current.preview = null
                  cache.set(scrollKey, node.scrollTop)
                }}
                data-artifact-region="preview-scroll"
              >
                <DataRegion
                  state={
                    state.data === "ready"
                      ? "success"
                      : state.data === "error"
                        ? "error"
                        : state.data
                  }
                  hasContent={Boolean(selected)}
                  error={{
                    category: "request",
                    message: label("版本刷新失败", "Version refresh failed"),
                    reason: label(
                      "本地示例读取失败；已保存版本和草稿保留。",
                      "The local fixture read failed; saved versions and drafts are preserved.",
                    ),
                  }}
                  onRetry={() =>
                    setState((previous) => loadVersions(previous, scenario))
                  }
                  emptyTitle={label("暂无产物版本", "No artifact versions")}
                  emptyDescription={label(
                    "载入本地示例来预览、比较和恢复版本。",
                    "Load the local example to preview, compare, and restore versions.",
                  )}
                  emptyAction={
                    <Button
                      onClick={() =>
                        setState((previous) => loadVersions(previous, scenario))
                      }
                    >
                      {label("载入示例", "Load example")}
                    </Button>
                  }
                >
                  {selected && <DocumentPreview version={selected} />}
                </DataRegion>
                {state.data === "loading" && (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      setState((previous) => loadVersions(previous, scenario))
                    }
                  >
                    {label("完成示例读取", "Complete fixture read")}
                  </Button>
                )}
              </div>
            </TabsPanel>
            <TabsPanel value="compare" keepMounted className={styles.panel}>
              <div
                ref={compare}
                className={styles.reviewScroll}
                onScroll={(event) => {
                  const node = event.currentTarget
                  if (
                    !active ||
                    !state.open ||
                    state.tab !== "compare" ||
                    !node.clientHeight ||
                    !node.clientWidth
                  )
                    return
                  if (restoredReading.current.compare === node.scrollTop) return
                  restoredReading.current.compare = null
                  cache.set(scrollKey, node.scrollTop)
                }}
                data-artifact-region="compare-scroll"
              >
                <DataRegion
                  state={
                    state.data === "ready"
                      ? "success"
                      : state.data === "error"
                        ? "error"
                        : state.data
                  }
                  hasContent={Boolean(selected && from)}
                  error={{
                    category: "request",
                    message: label("版本刷新失败", "Version refresh failed"),
                    reason: label(
                      "已保存的比较结果与草稿保留。",
                      "Saved comparison results and drafts are preserved.",
                    ),
                  }}
                  onRetry={() =>
                    setState((previous) => loadVersions(previous, scenario))
                  }
                  emptyTitle={label(
                    "暂无可比较的版本",
                    "No versions to compare",
                  )}
                  emptyDescription={label(
                    "载入本地示例版本开始审阅。",
                    "Load local example versions to begin reviewing.",
                  )}
                  emptyAction={
                    <Button
                      onClick={() =>
                        setState((previous) => loadVersions(previous, scenario))
                      }
                    >
                      {label("载入示例", "Load example")}
                    </Button>
                  }
                >
                  {selected && from && (
                    <div className={styles.diff} data-artifact-region="diff">
                      <div className={styles.diffToolbar}>
                        <span>{label("比较", "Compare")}</span>
                        <Select
                          value={String(state.from)}
                          items={compareOptions}
                          disabled={!compareOptions.length}
                          onValueChange={(value) => {
                            if (value)
                              setState((previous) => ({
                                ...previous,
                                from: Number(value),
                                activeChange: -1,
                              }))
                          }}
                        >
                          <SelectTrigger
                            className={styles.fromSelect}
                            aria-label={label(
                              "比较起始版本",
                              "Compare from version",
                            )}
                          >
                            <SelectValue />
                            <ChevronDown size={14} aria-hidden="true" />
                          </SelectTrigger>
                          <SelectContent>
                            {compareOptions.map((option) => (
                              <SelectItem
                                key={option.value}
                                value={option.value}
                              >
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <span>→ v{selected.id}</span>
                        <span className={styles.changeCount}>
                          {label(
                            `${changes.length} 处变化`,
                            `${changes.length} changes`,
                          )}
                        </span>
                        <label className={styles.onlyChanges}>
                          <Checkbox
                            checked={state.changesOnly}
                            onCheckedChange={(changesOnly) =>
                              setState((previous) => ({
                                ...previous,
                                changesOnly,
                              }))
                            }
                          />
                          {label("仅显示变化", "Changes only")}
                        </label>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={label("上一处变化", "Previous change")}
                          disabled={!changes.length}
                          onClick={() => moveChange(-1)}
                        >
                          <ChevronUp aria-hidden="true" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={label("下一处变化", "Next change")}
                          disabled={!changes.length}
                          onClick={() => moveChange(1)}
                        >
                          <ChevronDown aria-hidden="true" />
                        </Button>
                      </div>
                      {!displayed.length && (
                        <p className={styles.noChanges}>
                          {label(
                            "两个版本的内容相同。取消“仅显示变化”以查看所有章节。",
                            "Both versions have the same content. Clear Changes only to view every section.",
                          )}
                        </p>
                      )}
                      {displayed.map((change) => (
                        <ChangeSection
                          key={change.id}
                          change={change}
                          from={from.id}
                          to={selected.id}
                          selected={
                            changes[state.activeChange]?.id === change.id
                          }
                        />
                      ))}
                    </div>
                  )}
                </DataRegion>
                {state.data === "loading" && (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      setState((previous) => loadVersions(previous, scenario))
                    }
                  >
                    {label("完成示例读取", "Complete fixture read")}
                  </Button>
                )}
              </div>
            </TabsPanel>
            {state.readonly && (
              <p className={styles.readonly}>
                {label(
                  "只读：可以审阅版本，不能修改版本历史。",
                  "Read only: versions can be reviewed, but version history cannot be changed.",
                )}
              </p>
            )}
          </Tabs>
        </section>
      </div>
    </div>
  )
}

function DocumentPreview({ version }: { version: ArtifactVersion }) {
  const { locale } = useI18n()
  return (
    <article className={styles.document} data-artifact-version={version.id}>
      <p className={styles.category}>{version.category[locale]}</p>
      <h1>{version.title[locale]}</h1>
      <p className={styles.subtitle}>{version.subtitle[locale]}</p>
      <div className={styles.sections}>
        {version.sections.map((section) => (
          <section key={section.id}>
            <h2>{section.title[locale]}</h2>
            <p>{section.body[locale]}</p>
          </section>
        ))}
      </div>
      <footer>
        {artifactFile} · {locale === "en" ? "Version" : "版本"} {version.id}
        {version.restoredFrom ? ` · ${version.reason[locale]}` : ""}
      </footer>
    </article>
  )
}

function ChangeSection({
  change,
  from,
  to,
  selected,
}: {
  change: ArtifactChange
  from: number
  to: number
  selected: boolean
}) {
  const { locale } = useI18n()
  const en = locale === "en"
  const diff = useMemo(
    () =>
      wordDifference(
        change.before?.[locale] ?? "",
        change.after?.[locale] ?? "",
      ),
    [change.before, change.after, locale],
  )
  const kindLabels = {
    changed: en ? "changed" : "修改",
    removed: en ? "removed" : "删除",
    added: en ? "added" : "新增",
    unchanged: en ? "unchanged" : "未变化",
  }
  return (
    <section
      className={styles.change}
      data-artifact-change={change.id}
      data-current={selected || undefined}
      tabIndex={-1}
    >
      <div className={styles.changeHeading}>
        <h2>{change.title[locale]}</h2>
        <span>{kindLabels[change.kind]}</span>
      </div>
      <div className={styles.changeColumns}>
        {(["before", "after"] as const).map((side) => (
          <div key={side}>
            <p className={styles.versionLabel}>
              {side === "before" ? (en ? "FROM" : "从") : en ? "TO" : "到"} · v
              {side === "before" ? from : to}
            </p>
            <p className={!change[side] ? styles.missing : undefined}>
              {change[side]
                ? diff[side].map((word, index) =>
                    word.changed ? (
                      side === "before" ? (
                        <del key={index}>{word.text}</del>
                      ) : (
                        <ins key={index}>{word.text}</ins>
                      )
                    ) : (
                      <span key={index}>{word.text}</span>
                    ),
                  )
                : en
                  ? "No section in this version"
                  : "此版本中无此章节"}
            </p>
          </div>
        ))}
      </div>
    </section>
  )
}
