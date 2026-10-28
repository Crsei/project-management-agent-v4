"use client"

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { Menu as BaseMenu } from "@base-ui/react/menu"
import {
  Bot,
  CalendarDays,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Clock3,
  Code2,
  FolderGit2,
  GitBranch,
  History,
  ListChecks,
  Monitor,
  MoreHorizontal,
  PanelLeft,
  Plus,
  RotateCcw,
  Settings2,
  Sparkles,
  Square,
  Timer,
  Webhook,
  Zap,
} from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import { Switch } from "@easyuse-ui/ui/components/ui/switch"
import { Checkbox } from "@easyuse-ui/ui/components/ui/checkbox"
import { Field } from "@easyuse-ui/ui/components/ui/field"
import { DataRegion } from "@easyuse-ui/ui/components/ui/data-region"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@easyuse-ui/ui/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@easyuse-ui/ui/components/ui/dropdown-menu"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import {
  remainingPageScenarios,
  type RemainingPageProps,
} from "../../showcase/model"
import { useRemainingPageState } from "../../showcase/state"
import {
  automationDirty,
  cancelAutomation,
  draftErrors,
  literal,
  saveAutomation,
  selectAutomation,
  updateAutomation,
  type AutomationDraft,
  type TriggerKind,
} from "./controller"
import {
  agents,
  branches,
  conversations,
  createAutomationState,
  efforts,
  models,
  projects,
  triggerCopy,
} from "./fixtures"
import shellStyles from "../../composer-workspace.module.css"
import styles from "./view.module.css"

export const pageScenarios = remainingPageScenarios

function ContextChoice({
  label,
  value,
  options,
  onChange,
  disabled,
  icon,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  disabled: boolean
  icon: ReactNode
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            className={styles.contextChoice}
            disabled={disabled}
            aria-label={label}
          />
        }
      >
        {icon}
        <span>
          {options.find((option) => option.value === value)?.label ?? value}
        </span>
        <ChevronDown size={12} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function RemainingPageView({
  scenario,
  active,
  host,
  cache,
}: RemainingPageProps) {
  const { locale } = useI18n()
  const prefix = useId()
  const label = (zh: string, en: string) => (locale === "en" ? en : zh)
  const [state, setState] = useRemainingPageState(
    `automation-1:${scenario}:state`,
    () => createAutomationState(scenario),
  )
  const [dialog, setDialog] = useState<"cancel" | "workspace" | null>(null)
  const body = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const draft = state.drafts[state.selected]
  const disabled = state.readonly || state.data === "loading" || !active
  const errors = draftErrors(draft, locale)
  const change = (patch: Partial<AutomationDraft>) =>
    setState((previous) => updateAutomation(previous, patch))
  const Link = host.Link
  const title = literal(draft.name, locale)
  const selectedTrigger = draft.trigger ? triggerCopy[draft.trigger] : null
  const chooseTrigger = (trigger: TriggerKind) => change({ trigger })
  useLayoutEffect(() => {
    if (body.current)
      body.current.scrollTop = Number(
        cache.get("automation-1:reading-position") ?? 0,
      )
  }, [cache])
  useLayoutEffect(() => {
    const position = cache.get(`automation-1:${state.selected}:selection`) as
      { start: number; end: number; scroll: number } | undefined
    const element = textarea.current
    if (!position || !element) return
    // Native click processing can reset a selection restored during layout; apply it before the next paint.
    const frame = requestAnimationFrame(() => {
      element.setSelectionRange(position.start, position.end)
      element.scrollTop = position.scroll
    })
    return () => cancelAnimationFrame(frame)
  }, [
    cache,
    state.selected,
    locale,
    host.resolvedTheme,
    state.settingsOpen,
    dialog,
  ])
  const rememberSelection = () => {
    const element = textarea.current
    if (element)
      cache.set(`automation-1:${state.selected}:selection`, {
        start: element.selectionStart,
        end: element.selectionEnd,
        scroll: element.scrollTop,
      })
  }
  const rememberScroll = () => {
    const element = textarea.current
    const key = `automation-1:${state.selected}:selection`
    const position = cache.get(key) as
      { start: number; end: number; scroll: number } | undefined
    // Value changes can queue scroll events after navigation; they must not replace the saved selection.
    if (element && position)
      cache.set(key, { ...position, scroll: element.scrollTop })
  }
  const select = (id: string) => {
    // Blur/onSelect already captured the real editor range; an unrelated click can clear the inactive DOM range.
    if (
      textarea.current === textarea.current?.ownerDocument.activeElement ||
      !cache.has(`automation-1:${state.selected}:selection`)
    )
      rememberSelection()
    setState((previous) => selectAutomation(previous, id))
  }
  return (
    <div className={styles.workspace} data-remaining-page="automation-1">
      <aside
        className={shellStyles.sessionSidebar}
        hidden={!state.sidebarVisible}
        aria-label={label("自动化导航", "Automation navigation")}
      >
        <div className={shellStyles.teamHeader}>
          <Button
            variant="ghost"
            className={styles.teamButton}
            onClick={() => setDialog("workspace")}
          >
            <Sparkles size={18} aria-hidden="true" />
            EasyuseUI
            <ChevronDown size={12} aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={label("切换主题", "Toggle theme")}
            onClick={() =>
              host.setTheme(host.resolvedTheme === "dark" ? "light" : "dark")
            }
          >
            <Monitor size={16} />
          </Button>
        </div>
        <div className={shellStyles.sidebarScroll}>
          <h2 className={shellStyles.sectionTitle}>
            {label("操作", "Actions")}
          </h2>
          <Button
            variant="ghost"
            className={styles.navButton}
            onClick={() => select("new")}
          >
            <ListChecks size={16} aria-hidden="true" />
            {label("自动化", "Automations")}
          </Button>
          <Link
            href="/showcase/automation-run-history"
            className={styles.navLink}
          >
            <History size={16} aria-hidden="true" />
            {label("运行历史", "Run history")}
          </Link>
          <h2 className={`${shellStyles.sectionTitle} ${styles.savedHeading}`}>
            {label("已保存的自动化", "Saved automations")}
          </h2>
          {state.saved.length ? (
            <ul className={shellStyles.navList}>
              {state.saved.map((record) => (
                <li key={record.id}>
                  <Button
                    variant="ghost"
                    className={styles.navButton}
                    aria-current={
                      state.selected === record.id ? "page" : undefined
                    }
                    title={literal(record.draft.name, locale)}
                    onClick={() => select(record.id)}
                  >
                    <Timer size={16} aria-hidden="true" />
                    <span>{literal(record.draft.name, locale)}</span>
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.emptySaved}>
              {label("尚未保存自动化。", "No saved automations yet.")}
            </p>
          )}
        </div>
      </aside>
      <section
        className={styles.main}
        aria-label={label("自动化工作空间", "Automations workspace")}
      >
        <header className={styles.pageHeader}>
          <Button
            variant="ghost"
            size="icon"
            aria-label={label("切换自动化导航", "Toggle automation navigation")}
            aria-expanded={state.sidebarVisible}
            onClick={() =>
              setState((previous) => ({
                ...previous,
                sidebarVisible: !previous.sidebarVisible,
              }))
            }
          >
            <PanelLeft size={16} />
          </Button>
          <span className={styles.headerDivider} aria-hidden="true" />{" "}
          <span>{label("自动化", "Automations")}</span>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto"
                  aria-label={label("自动化操作", "Automation actions")}
                />
              }
            >
              <MoreHorizontal size={16} />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem
                render={<Link href="/showcase/automation-run-history" />}
              >
                {label("运行历史", "Run history")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setDialog("workspace")}>
                {label("工作空间设置", "Workspace settings")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>
        <div className={styles.breadcrumb}>
          {label("自动化", "Automations")} <span aria-hidden="true">/</span>{" "}
          <span>
            {state.selected === "new"
              ? label("新自动化", "New automation")
              : title}
          </span>
        </div>
        <div
          className={styles.scroll}
          ref={body}
          onScroll={(event) =>
            cache.set(
              "automation-1:reading-position",
              event.currentTarget.scrollTop,
            )
          }
        >
          <div className={styles.canvas}>
            <h1 className="sr-only">
              {label("创建自动化", "Create automation")}
            </h1>
            {state.data === "loading" ? (
              <>
                <DataRegion
                  state="loading"
                  loadingLabel={label("正在加载自动化", "Loading automation")}
                />
                <Button
                  className="mt-4"
                  variant="outline"
                  onClick={() =>
                    setState((previous) => ({ ...previous, data: "ready" }))
                  }
                >
                  {label("载入示例数据", "Load fixture data")}
                </Button>
              </>
            ) : (
              <>
                {state.data === "refresh-error" && (
                  <div className={styles.notice} role="alert">
                    <span>
                      {label(
                        "刷新失败，保留现有自动化和草稿。",
                        "Refresh failed. Existing automations and drafts are preserved.",
                      )}
                    </span>
                    <Button
                      variant="outline"
                      onClick={() =>
                        setState((previous) => ({ ...previous, data: "ready" }))
                      }
                    >
                      {label("重试", "Retry")}
                    </Button>
                  </div>
                )}
                {state.readonly && (
                  <p className={styles.permission}>
                    {label(
                      "只读访问：可以查看上下文，但无法修改或保存自动化。",
                      "Read-only access: inspect context, but editing and saving are unavailable.",
                    )}
                  </p>
                )}
                <header className={styles.draftHeader}>
                  <div className={styles.titleRow}>
                    <Input
                      ref={nameInput}
                      className={styles.titleInput}
                      title={title}
                      aria-label={label("自动化名称", "Automation name")}
                      placeholder={label("未命名自动化", "Untitled automation")}
                      value={title}
                      readOnly={disabled}
                      onChange={(event) => change({ name: event.target.value })}
                    />
                    <div className={styles.actions}>
                      <Button
                        variant="ghost"
                        disabled={disabled}
                        onClick={() =>
                          automationDirty(state)
                            ? setDialog("cancel")
                            : setState(cancelAutomation)
                        }
                      >
                        {label("取消", "Cancel")}
                      </Button>
                      <Button
                        className={styles.createButton}
                        disabled={disabled || errors.length > 0}
                        aria-describedby={`${prefix}-create-status`}
                        onClick={() => {
                          setState((previous) =>
                            saveAutomation(previous, locale),
                          )
                          nameInput.current?.focus()
                        }}
                      >
                        {state.selected === "new"
                          ? label("创建", "Create")
                          : label("保存", "Save")}
                      </Button>
                    </div>
                  </div>
                  <div className={styles.contextRow}>
                    <div className={styles.activeControl}>
                      <Switch
                        aria-label={label("自动化启用", "Automation active")}
                        checked={draft.enabled}
                        disabled={disabled}
                        onCheckedChange={(enabled) => change({ enabled })}
                      />
                      <span data-enabled={draft.enabled}>
                        {draft.enabled
                          ? label("已启用", "Active")
                          : label("已暂停", "Paused")}
                      </span>
                    </div>
                    <ContextChoice
                      label={label("项目", "Project")}
                      value={draft.project}
                      options={projects.map((value) => ({
                        value,
                        label: value,
                      }))}
                      onChange={(project) => change({ project })}
                      disabled={disabled}
                      icon={<FolderGit2 size={14} aria-hidden="true" />}
                    />
                    <ContextChoice
                      label={label("分支", "Branch")}
                      value={draft.branch}
                      options={branches.map((value) => ({
                        value,
                        label: value,
                      }))}
                      onChange={(branch) => change({ branch })}
                      disabled={disabled}
                      icon={<GitBranch size={14} aria-hidden="true" />}
                    />
                    <ContextChoice
                      label={label("执行会话", "Execution conversation")}
                      value={draft.conversation}
                      options={conversations.map((option) => ({
                        value: option.value,
                        label: option.label[locale],
                      }))}
                      onChange={(conversation) => change({ conversation })}
                      disabled={disabled}
                      icon={<Square size={14} aria-hidden="true" />}
                    />
                  </div>
                </header>
                <section
                  className={styles.section}
                  aria-labelledby={`${prefix}-instructions-heading`}
                >
                  <h2
                    id={`${prefix}-instructions-heading`}
                    className={styles.stepHeading}
                  >
                    <span aria-hidden="true">1</span>
                    {label("Agent 应执行什么", "What the agent should do")}
                  </h2>
                  <div
                    className={styles.instructions}
                    role="group"
                    aria-label={label("Agent 指令", "Agent instructions")}
                  >
                    <Textarea
                      ref={textarea}
                      className={styles.textarea}
                      aria-label={label("Agent 指令", "Agent instructions")}
                      placeholder={label(
                        "描述预期结果、约束与不应修改的内容…",
                        "Describe the outcome, constraints, and what not to touch…",
                      )}
                      value={literal(draft.instructions, locale)}
                      readOnly={disabled}
                      onChange={(event) =>
                        change({ instructions: event.target.value })
                      }
                      onSelect={rememberSelection}
                      onBlur={rememberSelection}
                      onScroll={rememberScroll}
                    />
                    <div className={styles.composerTools}>
                      <ContextChoice
                        label={label("模型", "Model")}
                        value={draft.model}
                        options={models.map((value) => ({
                          value,
                          label: value.replace("GPT-", ""),
                        }))}
                        onChange={(model) => change({ model })}
                        disabled={disabled}
                        icon={<Sparkles size={16} aria-hidden="true" />}
                      />
                      <ContextChoice
                        label={label("推理强度", "Reasoning effort")}
                        value={draft.effort}
                        options={efforts.map((option) => ({
                          value: option.value,
                          label: option.label[locale],
                        }))}
                        onChange={(effort) => change({ effort })}
                        disabled={disabled}
                        icon={<Zap size={16} aria-hidden="true" />}
                      />
                      <div className="ml-auto">
                        <ContextChoice
                          label={label("执行 Agent", "Execution agent")}
                          value={draft.agent}
                          options={agents.map((option) => ({
                            value: option.value,
                            label: option.label[locale],
                          }))}
                          onChange={(agent) => change({ agent })}
                          disabled={disabled}
                          icon={<Bot size={16} aria-hidden="true" />}
                        />
                      </div>
                    </div>
                  </div>
                </section>
                <section
                  className={styles.section}
                  aria-labelledby={`${prefix}-trigger-heading`}
                >
                  <h2
                    id={`${prefix}-trigger-heading`}
                    className={styles.stepHeading}
                  >
                    <span aria-hidden="true">2</span>
                    {label("何时运行", "When it should run")}
                  </h2>
                  {selectedTrigger && (
                    <div className={styles.triggerSummary}>
                      {draft.trigger === "webhook" ? (
                        <Webhook size={16} aria-hidden="true" />
                      ) : draft.trigger === "test" ? (
                        <Zap size={16} aria-hidden="true" />
                      ) : (
                        <Clock3 size={16} aria-hidden="true" />
                      )}
                      <div>
                        <p>{selectedTrigger.title[locale]}</p>
                        <small>{selectedTrigger.description[locale]}</small>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="ml-auto"
                        aria-label={label("移除触发条件", "Remove trigger")}
                        disabled={disabled}
                        onClick={() => change({ trigger: null })}
                      >
                        <RotateCcw size={16} />
                      </Button>
                    </div>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="outline"
                          className={styles.addTrigger}
                          disabled={disabled}
                        />
                      }
                    >
                      <Plus size={16} aria-hidden="true" />
                      {label("添加触发条件", "Add trigger")}
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className="min-w-64">
                      <BaseMenu.SubmenuRoot>
                        <BaseMenu.SubmenuTrigger
                          className={styles.submenuTrigger}
                        >
                          <Clock3 size={16} aria-hidden="true" />
                          {label("定时运行", "Scheduled")}
                          <ChevronRight
                            size={16}
                            className="ml-auto"
                            aria-hidden="true"
                          />
                        </BaseMenu.SubmenuTrigger>
                        <DropdownMenuContent>
                          {(
                            ["hourly", "daily", "weekly", "custom"] as const
                          ).map((kind) => (
                            <DropdownMenuItem
                              key={kind}
                              onClick={() => chooseTrigger(kind)}
                            >
                              {kind === "custom" ? (
                                <Code2 size={16} aria-hidden="true" />
                              ) : (
                                <CalendarDays size={16} aria-hidden="true" />
                              )}
                              {
                                {
                                  hourly: label("每小时", "Hourly"),
                                  daily: label("每天", "Daily"),
                                  weekly: label("每周", "Weekly"),
                                  custom: label(
                                    "自定义计划",
                                    "Custom schedule",
                                  ),
                                }[kind]
                              }
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </BaseMenu.SubmenuRoot>
                      <DropdownMenuItem onClick={() => chooseTrigger("once")}>
                        <Clock3 size={16} aria-hidden="true" />
                        {label("指定时间…", "Once at…")}
                        <small className="ml-auto text-text-muted">
                          {label("然后暂停", "then pause")}
                        </small>
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => chooseTrigger("test")}>
                        <Zap size={16} aria-hidden="true" />
                        {label("运行一次", "Run once")}
                        <small className="ml-auto text-text-muted">
                          {label("测试", "test")}
                        </small>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => chooseTrigger("webhook")}
                      >
                        <Webhook size={16} aria-hidden="true" />
                        Webhook
                        <small className="ml-auto text-text-muted">
                          {label("连接的应用", "Connected apps")}
                        </small>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </section>
                <section
                  className={styles.settings}
                  aria-label={label("运行设置", "Run settings")}
                >
                  <div className={styles.settingsHeader}>
                    <Button
                      variant="ghost"
                      aria-expanded={state.settingsOpen}
                      aria-controls={`${prefix}-settings`}
                      onClick={() =>
                        setState((previous) => ({
                          ...previous,
                          settingsOpen: !previous.settingsOpen,
                        }))
                      }
                    >
                      <Settings2 size={16} aria-hidden="true" />
                      {state.settingsOpen
                        ? label("隐藏设置", "Hide settings")
                        : label("设置", "Settings")}
                    </Button>
                    {!state.settingsOpen && (
                      <span>
                        {draft.checks
                          ? label("检查已开启", "Checks on")
                          : label("检查已关闭", "Checks off")}{" "}
                        · {draft.repairs} {label("次修复", "repair")} ·{" "}
                        {draft.minutes} {label("分钟", "min")}
                      </span>
                    )}
                  </div>
                  {state.settingsOpen && (
                    <div
                      id={`${prefix}-settings`}
                      className={styles.settingsPanel}
                    >
                      <div className={styles.checkRow}>
                        <Checkbox
                          id={`${prefix}-checks`}
                          checked={draft.checks}
                          disabled={disabled}
                          onCheckedChange={(checks) => change({ checks })}
                        />
                        <label htmlFor={`${prefix}-checks`}>
                          <span>
                            <CheckCheck size={16} aria-hidden="true" />
                            {label(
                              "运行结束时执行项目检查",
                              "Run project checks when a run ends",
                            )}
                          </span>
                          <small>
                            {label(
                              "仅验证无人值守的运行，可在停止前重试失败的检查。",
                              "Verification only runs for unattended turns and can retry a failed check before the run stops.",
                            )}
                          </small>
                        </label>
                      </div>
                      <div className={styles.settingsFields}>
                        <Field
                          label={label("修复次数", "Repair attempts")}
                          error={
                            errors.includes("repairs")
                              ? label(
                                  "请输入 0–5 的整数。",
                                  "Enter a whole number from 0 to 5.",
                                )
                              : undefined
                          }
                        >
                          {(props) => (
                            <Input
                              {...props}
                              type="number"
                              min={0}
                              max={5}
                              value={draft.repairs}
                              disabled={disabled}
                              onChange={(event) =>
                                change({ repairs: event.target.value })
                              }
                            />
                          )}
                        </Field>
                        <Field
                          label={label(
                            "时间限制（分钟）",
                            "Time limit (minutes)",
                          )}
                          error={
                            errors.includes("minutes")
                              ? label(
                                  "请输入 1–240 的整数。",
                                  "Enter a whole number from 1 to 240.",
                                )
                              : undefined
                          }
                        >
                          {(props) => (
                            <Input
                              {...props}
                              type="number"
                              min={1}
                              max={240}
                              value={draft.minutes}
                              disabled={disabled}
                              onChange={(event) =>
                                change({ minutes: event.target.value })
                              }
                            />
                          )}
                        </Field>
                      </div>
                    </div>
                  )}
                </section>
                <p
                  id={`${prefix}-create-status`}
                  className={styles.status}
                  role="status"
                >
                  {state.notice === "saved"
                    ? label(
                        "已保存到此 Lab 会话的内存中；未注册计划或执行 Agent。",
                        "Saved in this Lab session's memory; no schedule was registered and no agent was executed.",
                      )
                    : state.notice === "cancelled"
                      ? label(
                          "已恢复上次保存的内容。",
                          "Restored the last saved values.",
                        )
                      : !draft.trigger
                        ? label(
                            "添加触发条件后即可创建自动化。",
                            "Add a trigger to create this automation.",
                          )
                        : errors.length
                          ? label(
                              "填写名称、指令和有效的运行设置。",
                              "Provide a name, instructions, and valid run settings.",
                            )
                          : label(
                              "可以创建此自动化。",
                              "Ready to create this automation.",
                            )}
                </p>
              </>
            )}
          </div>
        </div>
      </section>
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null)
        }}
      >
        <DialogContent>
          <DialogTitle>
            {dialog === "cancel"
              ? label("放弃未保存的修改？", "Discard unsaved changes?")
              : label("工作空间设置", "Workspace settings")}
          </DialogTitle>
          <DialogDescription>
            {dialog === "cancel"
              ? label(
                  "将恢复上次保存的自动化。其他自动化草稿不受影响。",
                  "Restore the last saved automation. Drafts for other automations are unaffected.",
                )
              : label(
                  "此页面使用内存示例数据。项目、分支和 Agent 仅作为执行上下文，未连接真实服务。",
                  "This page uses in-memory fixtures. Projects, branches, and agents are execution context only; no live services are connected.",
                )}
          </DialogDescription>
          {dialog === "cancel" ? (
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDialog(null)}>
                {label("继续编辑", "Keep editing")}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  setState(cancelAutomation)
                  setDialog(null)
                  nameInput.current?.focus()
                }}
              >
                {label("放弃修改", "Discard changes")}
              </Button>
            </div>
          ) : (
            <div className="mt-6 flex justify-end">
              <Button variant="outline" onClick={() => setDialog(null)}>
                {label("关闭", "Close")}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
