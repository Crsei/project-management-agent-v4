"use client"

import { useLayoutEffect, useRef, type FormEvent } from "react"
import {
  Activity,
  Blocks,
  Bot,
  CalendarDays,
  ChevronDown,
  Clock3,
  MessageSquare,
  Monitor,
  Moon,
  Pause,
  Play,
  Send,
  SlidersHorizontal,
  Sun,
} from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import { Field } from "@easyuse-ui/ui/components/ui/field"
import { Switch } from "@easyuse-ui/ui/components/ui/switch"
import { Item } from "@easyuse-ui/ui/components/ui/item"
import {
  Tabs,
  TabsList,
  TabsTab,
  TabsPanel,
} from "@easyuse-ui/ui/components/ui/tabs"
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@easyuse-ui/ui/components/ui/collapsible"
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@easyuse-ui/ui/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@easyuse-ui/ui/components/ui/dropdown-menu"
import { RuntimeStatusBadge } from "@easyuse-ui/ui/components/ui/runtime-status-badge"
import { Skeleton } from "@easyuse-ui/ui/components/ui/skeleton"
import { ChatMessage } from "@easyuse-ui/ui/components/blocks/chat-message"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import {
  remainingPageScenarios,
  type RemainingPageProps,
} from "../../showcase/model"
import { useRemainingPageState } from "../../showcase/state"
import {
  canEditAgent,
  createAgentDetailState,
  identityIsDirty,
  pauseAgent,
  recoverAgentData,
  resetIdentity,
  saveIdentity,
  scheduleForDay,
  sendLocalMessage,
  setCapability,
  toggleActivity,
  updateIdentityDraft,
  visibleActivities,
  type ActivityFilter,
  type AgentView,
  type ResourceView,
} from "./controller"
import { weekDays, type Capability, type Localized } from "./fixtures"
import styles from "./view.module.css"

export const pageScenarios = remainingPageScenarios

export function RemainingPageView({
  scenario,
  active,
  host,
  cache,
}: RemainingPageProps) {
  const { locale } = useI18n()
  const label = (zh: string, en: string) => (locale === "en" ? en : zh)
  const copy = (value: Localized) => value[locale]
  const [state, setState] = useRemainingPageState(
    `agent-detail:${scenario}`,
    () => createAgentDetailState(scenario),
  )
  const profile = useRef<HTMLElement>(null)
  const workspace = useRef<HTMLElement>(null)
  const conversation = useRef<HTMLDivElement>(null)
  const loading = state.dataState === "loading"
  const editable = canEditAgent(state)
  const events = visibleActivities(state)
  const schedule = scheduleForDay(state)
  const name = copy(state.identity.name)
  const scrollKey = `agent-detail:${scenario}:workspace:${state.view}`
  const profileScrollKey = `agent-detail:${scenario}:profile:${state.resources}`

  useLayoutEffect(() => {
    if (!active) return
    if (profile.current)
      profile.current.scrollTop = Number(cache.get(profileScrollKey) ?? 0)
    if (workspace.current)
      workspace.current.scrollTop = Number(cache.get(scrollKey) ?? 0)
  }, [active, cache, profileScrollKey, scrollKey, locale, host.resolvedTheme])

  useLayoutEffect(() => {
    if (active && state.messageOpen && conversation.current)
      conversation.current.scrollTop = Number(
        cache.get(`agent-detail:${scenario}:messages-scroll`) ?? 0,
      )
  }, [active, cache, scenario, state.messageOpen, locale, host.resolvedTheme])

  function submitIdentity(event: FormEvent) {
    event.preventDefault()
    setState(saveIdentity)
  }

  function submitMessage(event: FormEvent) {
    event.preventDefault()
    setState(sendLocalMessage)
    cache.delete(`agent-detail:${scenario}:messages-scroll`)
    requestAnimationFrame(() => {
      if (conversation.current)
        conversation.current.scrollTop = conversation.current.scrollHeight
    })
  }

  function capabilitySwitch(
    item: Capability,
    collection: "tasks" | "applications" | "skills",
  ) {
    return (
      <Switch
        aria-label={label(
          `启用${copy(item.title)}`,
          `Enable ${copy(item.title)}`,
        )}
        checked={item.enabled}
        disabled={!editable}
        onCheckedChange={(enabled) =>
          setState((previous) =>
            setCapability(previous, collection, item.id, enabled),
          )
        }
      />
    )
  }

  const viewTabs = [
    { id: "skills", title: label("技能", "Skills"), Icon: Blocks },
    { id: "calendar", title: label("日历", "Calendar"), Icon: CalendarDays },
    { id: "activity", title: label("活动", "Activity"), Icon: Activity },
    {
      id: "identity",
      title: label("身份", "Identity"),
      Icon: SlidersHorizontal,
    },
  ] as const
  const filters = [
    { id: "all", title: label("全部", "All") },
    { id: "threads", title: label("会话", "Threads") },
    { id: "workflows", title: label("工作流", "Workflows") },
    { id: "checks", title: label("检查", "Checks") },
    { id: "tasks", title: label("任务", "Tasks") },
  ] as const

  return (
    <section  className={styles.page}
    data-agent-detail
    data-locale={locale}
    aria-busy={loading || undefined}><header className={styles.header}>
      <span>
        {label("Agents", "Agents")} / {name}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              size="icon"
              variant="ghost"
              aria-label={label("切换主题", "Toggle theme")}
            />
          }
        >
          {host.resolvedTheme === "dark" ? <Moon /> : <Monitor />}
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onClick={() => host.setTheme("light")}>
            <Sun />
            {label("浅色", "Light")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => host.setTheme("dark")}>
            <Moon />
            {label("深色", "Dark")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => host.setTheme("system")}>
            <Monitor />
            {label("跟随系统", "System")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
    {state.dataState === "refresh-error" && (
      <div className={styles.notice} role="alert">
        <span>
          {label(
            "刷新失败，已保留身份、草稿、能力和活动记录。",
            "Refresh failed. Identity, drafts, capabilities, and activity records are retained.",
          )}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setState(recoverAgentData)}
        >
          {label("重新读取本地示例", "Reload local sample")}
        </Button>
      </div>
    )}
    {state.readonly && (
      <div className={styles.notice} role="status">
        {label(
          "只读示例：可以查看活动和日历，不能修改身份、能力或发送消息。",
          "Read-only sample: activity and calendar are available; identity, capabilities, and messages cannot be changed.",
        )}
      </div>
    )}
    {loading && (
      <div className={styles.notice} role="status">
        <span>
          {label(
            "正在读取 Agent 示例数据。",
            "Reading the agent sample data.",
          )}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setState(recoverAgentData)}
        >
          {label("完成本地读取", "Complete local read")}
        </Button>
      </div>
    )}
    <div className={styles.columns}>
      <aside
        ref={profile}
        className={styles.profile}
        aria-label={label("Agent 简介", "Agent profile")}
        onScroll={(event) => {
          if (active)
            cache.set(profileScrollKey, event.currentTarget.scrollTop)
        }}
      >
        <section className={styles.summary}>
          <div className={styles.identityRow}>
            <span className={styles.avatar}>
              <Bot aria-hidden="true" size={24} />
            </span>
            <div>
              <h1>{name}</h1>
              <p className={styles.role}>{copy(state.identity.role)}</p>
            </div>
          </div>
          <p className={styles.introduction}>
            {copy(state.identity.introduction)}
          </p>
          <div className={styles.summaryActions}>
            <Dialog
              open={active && state.messageOpen}
              onOpenChange={(open) =>
                setState((previous) => ({ ...previous, messageOpen: open }))
              }
            >
              <DialogTrigger
                render={
                  <Button
                    variant="outline"
                    aria-label={label(`给 ${name} 发消息`, `Message ${name}`)}
                  />
                }
              >
                <MessageSquare aria-hidden="true" />
                {label("消息", "Message")}
              </DialogTrigger>
              <DialogContent className={styles.messageDialog}>
                <DialogTitle>
                  {label(`给 ${name} 发消息`, `Message ${name}`)}
                </DialogTitle>
                <DialogDescription>
                  {label(
                    "使用 Agent 示例活动的本地演示对话。",
                    "A demo conversation using sample agent activity.",
                  )}
                </DialogDescription>
                <div
                  ref={conversation}
                  role="log"
                  aria-live="polite"
                  aria-label={label(
                    "本地示例对话",
                    "Local sample conversation",
                  )}
                  className={styles.conversation}
                  onScroll={(event) => {
                    if (active)
                      cache.set(
                        `agent-detail:${scenario}:messages-scroll`,
                        event.currentTarget.scrollTop,
                      )
                  }}
                >
                  {state.messages.length ? (
                    state.messages.map((message) => (
                      <ChatMessage
                        key={message.id}
                        id={message.id}
                        role={message.role}
                        author={
                          message.role === "agent" ? name : label("你", "You")
                        }
                        content={copy(message.content)}
                      />
                    ))
                  ) : (
                    <p>
                      {label(
                        "询问最近的账户变化和团队交接事项。",
                        "Ask for a recap of the latest account changes and team handoffs.",
                      )}
                    </p>
                  )}
                </div>
                <form onSubmit={submitMessage} className={styles.messageForm}>
                  <Field label={label("消息", "Message")}>
                    {(props) => (
                      <Textarea
                        {...props}
                        className={styles.messageInput}
                        rows={2}
                        value={state.messageDraft}
                        disabled={!editable}
                        placeholder={label(
                          "今天有哪些事项需要关注？",
                          "What needs our attention today?",
                        )}
                        onChange={(event) =>
                          setState((previous) => ({
                            ...previous,
                            messageDraft: event.target.value,
                          }))
                        }
                      />
                    )}
                  </Field>
                  <Button
                    type="submit"
                    disabled={!editable || !state.messageDraft.trim()}
                  >
                    <Send aria-hidden="true" />
                    {label("发送消息", "Send message")}
                  </Button>
                  {!editable && (
                    <p className={styles.muted}>
                      {loading
                        ? label(
                            "数据读取完成后才能发送消息。",
                            "Messages are available after the sample finishes loading.",
                          )
                        : label(
                            "只读模式不允许发送消息。",
                            "Read-only mode does not allow messages.",
                          )}
                    </p>
                  )}
                </form>
              </DialogContent>
            </Dialog>
            <Button
              variant="outline"
              disabled={!editable}
              aria-label={
                state.paused
                  ? label("恢复 Agent", "Resume agent")
                  : label("暂停 Agent", "Pause agent")
              }
              onClick={() => setState(pauseAgent)}
            >
              {state.paused ? (
                <Play aria-hidden="true" />
              ) : (
                <Pause aria-hidden="true" />
              )}
              {state.paused
                ? label("恢复", "Resume")
                : label("暂停", "Pause")}
            </Button>
          </div>
          {state.paused && (
            <p className={styles.pauseNotice} role="status">
              {label(
                "本地 Agent 已暂停。已启用的配置保留，日历中不安排任务。",
                "The local agent is paused. Enabled settings are retained; no tasks are scheduled.",
              )}
            </p>
          )}
        </section>
        <Tabs
          value={state.resources}
          onValueChange={(value) =>
            setState((previous) => ({
              ...previous,
              resources: value as ResourceView,
            }))
          }
        >
          <TabsList
            className={styles.resourceTabs}
            aria-label={label("Agent 资源", "Agent resources")}
          >
            <TabsTab value="tasks">
              {label("后台任务", "Background tasks")}
            </TabsTab>
            <TabsTab value="applications">
              {label("应用", "Applications")}
            </TabsTab>
          </TabsList>
          <TabsPanel
            value="tasks"
            keepMounted
            className={styles.resourcePanel}
          >
            {loading ? (
              <div className={styles.skeletons}>
                {[0, 1, 2].map((index) => (
                  <Skeleton key={index} className={styles.taskSkeleton} />
                ))}
              </div>
            ) : state.tasks.length ? (
              state.tasks.map((task) => (
                <section
                  key={task.id}
                  className={styles.task}
                  data-task-id={task.id}
                >
                  <div className={styles.taskBody}>
                    <div className={styles.capabilityHeading}>
                      <h3>{copy(task.title)}</h3>
                      {capabilitySwitch(task, "tasks")}
                    </div>
                    <p>{copy(task.description)}</p>
                  </div>
                  <footer>
                    <span
                      className={
                        task.enabled && !state.paused
                          ? styles.taskActive
                          : styles.muted
                      }
                    >
                      <i aria-hidden="true" />
                      {task.enabled && !state.paused
                        ? label("启用", "Active")
                        : label("暂停", "Paused")}
                    </span>
                    <span>{copy(task.schedule)}</span>
                  </footer>
                </section>
              ))
            ) : (
              <div className={styles.empty}>
                <Clock3 aria-hidden="true" />
                <h3>{label("暂无后台任务", "No background tasks")}</h3>
                <p>
                  {label(
                    "载入本地示例可查看任务安排。",
                    "Load the local sample to explore the schedule.",
                  )}
                </p>
                <Button
                  variant="outline"
                  onClick={() => setState(recoverAgentData)}
                >
                  {label("载入示例", "Load sample")}
                </Button>
              </div>
            )}
          </TabsPanel>
          <TabsPanel
            value="applications"
            keepMounted
            className={styles.resourcePanel}
          >
            <p className={styles.resourceDescription}>
              {label(
                "选择可供此 Agent 使用的示例应用。",
                "Choose which sample applications are available to this agent.",
              )}
            </p>
            {loading ? (
              <div className={styles.skeletons}>
                {[0, 1, 2].map((index) => (
                  <Skeleton
                    key={index}
                    className={styles.applicationSkeleton}
                  />
                ))}
              </div>
            ) : (
              state.applications.map((application) => (
                <div key={application.id} className={styles.application}>
                  <div className={styles.capabilityHeading}>
                    <h3>{copy(application.title)}</h3>
                    {capabilitySwitch(application, "applications")}
                  </div>
                  <p>{copy(application.description)}</p>
                </div>
              ))
            )}
            {!loading && !state.applications.length && (
              <div className={styles.empty}>
                <Blocks aria-hidden="true" />
                <h3>{label("暂无应用", "No applications")}</h3>
                <Button
                  variant="outline"
                  onClick={() => setState(recoverAgentData)}
                >
                  {label("载入示例", "Load sample")}
                </Button>
              </div>
            )}
          </TabsPanel>
        </Tabs>
      </aside>
      <section
        ref={workspace}
        className={styles.workspace}
        aria-label={label("Agent 工作区", "Agent workspace")}
        onScroll={(event) => {
          if (active) cache.set(scrollKey, event.currentTarget.scrollTop)
        }}
      >
        <Tabs
          value={state.view}
          onValueChange={(value) =>
            setState((previous) => ({
              ...previous,
              view: value as AgentView,
            }))
          }
        >
          <TabsList
            className={styles.viewTabs}
            aria-label={label("Agent 视图", "Agent views")}
          >
            {viewTabs.map(({ id, title, Icon }) => (
              <TabsTab key={id} value={id}>
                <Icon aria-hidden="true" size={16} />
                {title}
              </TabsTab>
            ))}
          </TabsList>
          <div className={styles.workspaceContent} data-view={state.view}>
            <TabsPanel
              value="activity"
              keepMounted
              className={styles.activityPanel}
            >
              <header className={styles.activityHeader}>
                <h2>{label(`${name} 的活动`, `${name}’s activity`)}</h2>
                <span>
                  {label("今天，9 月 16 日", "Today, 16 September")}
                </span>
              </header>
              <Tabs
                value={state.filter}
                onValueChange={(value) =>
                  setState((previous) => ({
                    ...previous,
                    filter: value as ActivityFilter,
                  }))
                }
              >
                <TabsList
                  className={styles.filterTabs}
                  aria-label={label("活动类型", "Activity type")}
                >
                  {filters.map((filter) => (
                    <TabsTab key={filter.id} value={filter.id}>
                      {filter.title}
                    </TabsTab>
                  ))}
                </TabsList>
                {filters.map((filter) => (
                  <TabsPanel
                    key={filter.id}
                    value={filter.id}
                    className={styles.events}
                  >
                    {loading ? (
                      <div className={styles.skeletons}>
                        {[0, 1, 2].map((index) => (
                          <Skeleton
                            key={index}
                            className={styles.eventSkeleton}
                          />
                        ))}
                      </div>
                    ) : events.length ? (
                      <ol>
                        {events.map((event) => (
                          <li key={event.id} data-activity-id={event.id}>
                            <Collapsible
                              open={state.expanded.includes(event.id)}
                              onOpenChange={() =>
                                setState((previous) =>
                                  toggleActivity(previous, event.id),
                                )
                              }
                            >
                              <CollapsibleTrigger
                                className={styles.eventTrigger}
                              >
                                <time>{event.time}</time>
                                <span className={styles.eventTitle}>
                                  {copy(event.title)}
                                </span>
                                <span className={styles.eventSource}>
                                  {event.source}
                                  {event.duration
                                    ? ` · ${event.duration}`
                                    : ""}
                                </span>
                                <ChevronDown aria-hidden="true" size={14} />
                              </CollapsibleTrigger>
                              <CollapsibleContent
                                className={styles.eventDetails}
                              >
                                <div>
                                  <span>{label("请求", "Request")}</span>
                                  <p>{copy(event.request)}</p>
                                </div>
                                <div>
                                  <RuntimeStatusBadge status={event.status} />
                                  <p>{copy(event.result)}</p>
                                </div>
                              </CollapsibleContent>
                            </Collapsible>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <div className={styles.empty}>
                        <Activity aria-hidden="true" />
                        <h3>
                          {label("暂无活动记录", "No activity records")}
                        </h3>
                        <p>
                          {state.activities.length
                            ? label(
                                "此类别没有记录，请选择全部活动。",
                                "There are no records in this category. Choose all activity.",
                              )
                            : label(
                                "载入本地示例，查看请求与结果记录。",
                                "Load the local sample to explore requests and results.",
                              )}
                        </p>
                        <Button
                          variant="outline"
                          onClick={() =>
                            state.activities.length
                              ? setState((previous) => ({
                                  ...previous,
                                  filter: "all",
                                }))
                              : setState(recoverAgentData)
                          }
                        >
                          {state.activities.length
                            ? label("全部活动", "All activity")
                            : label("载入示例", "Load sample")}
                        </Button>
                      </div>
                    )}
                  </TabsPanel>
                ))}
              </Tabs>
              <footer className={styles.activityFooter}>
                {label(
                  `${events.length} 条记录 · 所有时间均为 UTC`,
                  `${events.length} events · All times in UTC`,
                )}
              </footer>
            </TabsPanel>
            <TabsPanel
              value="skills"
              keepMounted
              className={styles.contentPanel}
            >
              <div className={styles.sectionHeading}>
                <h2>{label(`${name} 能做什么`, `What ${name} can do`)}</h2>
                <p>
                  {label(
                    "适用于对话和后台工作的可复用技能。",
                    "Reusable skills available for conversations and background work.",
                  )}
                </p>
              </div>
              {loading ? (
                <div className={styles.skeletons}>
                  {[0, 1, 2].map((index) => (
                    <Skeleton key={index} className={styles.skillSkeleton} />
                  ))}
                </div>
              ) : (
                <ul className={styles.skills}>
                  {state.skills.map((skill) => (
                    <li key={skill.id}>
                      <Item
                        title={copy(skill.title)}
                        description={copy(skill.description)}
                        trailing={capabilitySwitch(skill, "skills")}
                        className={styles.skill}
                      />
                    </li>
                  ))}
                </ul>
              )}
              {!loading && !state.skills.length && (
                <div className={styles.empty}>
                  <Blocks aria-hidden="true" />
                  <h3>{label("暂无技能", "No skills")}</h3>
                  <Button
                    variant="outline"
                    onClick={() => setState(recoverAgentData)}
                  >
                    {label("载入示例", "Load sample")}
                  </Button>
                </div>
              )}
            </TabsPanel>
            <TabsPanel
              value="calendar"
              keepMounted
              className={styles.contentPanel}
            >
              <div className={styles.sectionHeading}>
                <h2>{label("本周", "This week")}</h2>
                <p>
                  {label(
                    "2026 年 9 月 14–18 日 · UTC",
                    "14–18 September 2026 · UTC",
                  )}
                </p>
              </div>
              <Tabs
                value={state.day}
                onValueChange={(value) =>
                  setState((previous) => ({
                    ...previous,
                    day: Number(value),
                  }))
                }
              >
                <TabsList
                  className={styles.dayTabs}
                  aria-label={label("日程日期", "Schedule day")}
                >
                  {weekDays.map((day, index) => (
                    <TabsTab key={index} value={index}>
                      {copy(day)}
                    </TabsTab>
                  ))}
                </TabsList>
                {weekDays.map((day, index) => (
                  <TabsPanel
                    key={index}
                    value={index}
                    className={styles.schedule}
                  >
                    {loading ? (
                      <div className={styles.skeletons}>
                        {[0, 1, 2].map((row) => (
                          <Skeleton
                            key={row}
                            className={styles.eventSkeleton}
                          />
                        ))}
                      </div>
                    ) : schedule.length ? (
                      <ul>
                        {schedule.map((task) => (
                          <li key={task.id}>
                            <Item
                              leading={
                                <Clock3 size={16} aria-hidden="true" />
                              }
                              title={copy(task.title)}
                              description={copy(task.schedule)}
                              trailing={
                                <span className={styles.scheduleTime}>
                                  {task.time === "event"
                                    ? label("事件触发", "On event")
                                    : task.time}
                                </span>
                              }
                            />
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className={styles.empty}>
                        <CalendarDays aria-hidden="true" />
                        <h3>
                          {state.paused
                            ? label("Agent 已暂停", "Agent is paused")
                            : label(
                                "当天没有启用的任务",
                                "No enabled tasks for this day",
                              )}
                        </h3>
                        <p>
                          {state.paused
                            ? label(
                                "恢复 Agent 后，日程会保留原有安排。",
                                "Resume the agent to restore its existing schedule.",
                              )
                            : label(
                                "在后台任务中启用任务后，这里会显示对应安排。",
                                "Enable a background task to show its schedule here.",
                              )}
                        </p>
                      </div>
                    )}
                  </TabsPanel>
                ))}
              </Tabs>
            </TabsPanel>
            <TabsPanel
              value="identity"
              keepMounted
              className={styles.contentPanel}
            >
              <div className={styles.sectionHeading}>
                <h2>{label("Agent 身份", "Agent identity")}</h2>
                <p>
                  {label(
                    "为 Agent 设置清晰的职责和实用的介绍。",
                    "Give your agent a clear role and a useful introduction.",
                  )}
                </p>
              </div>
              <form className={styles.identityForm} onSubmit={submitIdentity}>
                <Field
                  label={label("名称", "Name")}
                  error={
                    state.errors.name ? copy(state.errors.name) : undefined
                  }
                >
                  {(props) => (
                    <Input
                      {...props}
                      value={copy(state.draft.name)}
                      disabled={!editable}
                      onChange={(event) =>
                        setState((previous) =>
                          updateIdentityDraft(
                            previous,
                            "name",
                            event.target.value,
                          ),
                        )
                      }
                    />
                  )}
                </Field>
                <Field
                  label={label("职责", "Role")}
                  error={
                    state.errors.role ? copy(state.errors.role) : undefined
                  }
                >
                  {(props) => (
                    <Input
                      {...props}
                      value={copy(state.draft.role)}
                      disabled={!editable}
                      onChange={(event) =>
                        setState((previous) =>
                          updateIdentityDraft(
                            previous,
                            "role",
                            event.target.value,
                          ),
                        )
                      }
                    />
                  )}
                </Field>
                <Field
                  label={label("介绍", "Introduction")}
                  error={
                    state.errors.introduction
                      ? copy(state.errors.introduction)
                      : undefined
                  }
                >
                  {(props) => (
                    <Textarea
                      {...props}
                      className={styles.identityIntroduction}
                      rows={3}
                      value={copy(state.draft.introduction)}
                      disabled={!editable}
                      onChange={(event) =>
                        setState((previous) =>
                          updateIdentityDraft(
                            previous,
                            "introduction",
                            event.target.value,
                          ),
                        )
                      }
                    />
                  )}
                </Field>
                <div className={styles.formActions}>
                  <Button
                    type="submit"
                    disabled={!editable || !identityIsDirty(state)}
                  >
                    {label("保存更改", "Save changes")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!editable}
                    onClick={() => setState(resetIdentity)}
                  >
                    {label("重置", "Reset")}
                  </Button>
                </div>
                {state.saveFeedback && (
                  <p role="status" className={styles.muted}>
                    {label(
                      "身份已保存在当前本地场景中，没有写入服务器。",
                      "Identity saved in this local scenario. No server was updated.",
                    )}
                  </p>
                )}
              </form>
            </TabsPanel>
          </div>
        </Tabs>
      </section>
    </div></section>
  )
}
