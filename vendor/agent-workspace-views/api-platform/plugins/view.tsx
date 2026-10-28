"use client"
import { useEffect, useMemo, useRef } from "react"
import { Plus, RotateCcw, ShieldCheck } from "lucide-react"
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@easyuse-ui/ui/components/ui/collapsible"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Alert } from "@easyuse-ui/ui/components/ui/alert"
import { Avatar } from "@easyuse-ui/ui/components/ui/avatar"
import { Badge, type BadgeProps } from "@easyuse-ui/ui/components/ui/badge"
import { Checkbox } from "@easyuse-ui/ui/components/ui/checkbox"
import { Empty } from "@easyuse-ui/ui/components/ui/empty"
import { Field } from "@easyuse-ui/ui/components/ui/field"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Switch } from "@easyuse-ui/ui/components/ui/switch"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "@easyuse-ui/ui/components/ui/dialog"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@easyuse-ui/ui/components/ui/toggle-group"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetBody,
  SheetFooter,
} from "@easyuse-ui/ui/components/ui/sheet"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { ApPage, ApSearch, ApSelect } from "../shared"
import { useApState } from "../state"
import { useApAccountState } from "../account-state"
import {
  apAsOf,
  apFixtureRevision,
  apScope,
  apScenarios,
  type ApScenario,
} from "../model"
import type { RemainingPageProps } from "../../showcase/model"
import type { ApAccountIntegration } from "../fixtures/accounts"
import {
  pluginBrandSources,
  pluginGalleryCopy,
  pluginGalleryIds,
  pluginPresentation,
  pluginCategoryCopy,
  pluginCategoryIds,
  pluginConfigDefault,
  pluginDescription,
  pluginLoadDelayMs,
  pluginOperationDelayMs,
  pluginProjectIntegrationIds,
  pluginSkeletonDelayMs,
  pluginTestDelayMs,
  type PluginAction,
} from "./fixtures"
import {
  applyPluginOperation,
  beginCheck,
  beginOperation,
  beginPluginTest,
  beginRefresh,
  closePlugin,
  commitDraft,
  completeSkeleton,
  discardPluginDraft,
  createPluginsState,
  filterPlugins,
  openPlugin,
  openPluginForDisable,
  openPluginForConnect,
  pluginCounts,
  pluginDraftValidation,
  pluginOperationLocked,
  pluginSwitchOn,
  resolveCheck,
  resolveOperation,
  selectDraftProject,
  settlePluginTest,
  settleRefresh,
  submitIntegrationRequest,
  updateDraft,
  type PluginFilter,
  type PluginOperation,
} from "./controller"
import styles from "./plugins.module.css"

const statusCopy: Record<
  ApAccountIntegration["status"],
  { "zh-CN": string; en: string; tone: BadgeProps["tone"] }
> = {
  connected: { "zh-CN": "已连接", en: "Connected", tone: "success" },
  "not-connected": { "zh-CN": "可用", en: "Available", tone: "neutral" },
  disabled: { "zh-CN": "已停用", en: "Disabled", tone: "warning" },
  "configuration-error": {
    "zh-CN": "连接错误",
    en: "Connection error",
    tone: "danger",
  },
}

function describeOperation(op: PluginOperation, en: boolean): string {
  const action = en
    ? {
        connect: "Connect",
        disable: "Disable",
        enable: "Enable",
        save: "Save",
      }[op.action]
    : { connect: "连接", disable: "停用", enable: "启用", save: "保存" }[
        op.action
      ]
  if (op.status === "pending")
    return op.intent === "check"
      ? en
        ? `Checking operation ${op.operationId}…`
        : `正在查询操作 ${op.operationId} 的结果…`
      : en
        ? `${action} pending · ${op.operationId}`
        : `${action}处理中 · ${op.operationId}`
  if (op.status === "confirmed") {
    const version =
      op.config !== null || op.tools !== null
        ? op.configVersion + 1
        : op.configVersion
    return en
      ? `Confirmed · ${action} · ${op.integrationId} · ${op.projectId} · config v${version}`
      : `已确认 · ${action} · ${op.integrationId} · ${op.projectId} · 配置版本 v${version}`
  }
  if (op.status === "rejected")
    return en
      ? `Rejected · ${action} · ${op.integrationId} · data and draft unchanged`
      : `已拒绝 · ${action} · ${op.integrationId} · 数据与草稿未更改`
  return en
    ? `Unknown · ${op.operationId} · integration ${op.integrationId} · project ${op.projectId} · config v${op.configVersion}`
    : `结果未知 · ${op.operationId} · 集成 ${op.integrationId} · 项目 ${op.projectId} · 配置版本 v${op.configVersion}`
}

export const pageScenarios = apScenarios

export function RemainingPageView({ scenario, active }: RemainingPageProps) {
  return <PluginsView scenario={scenario as ApScenario} active={active} />
}

export function PluginsView({
  scenario,
  active = true,
}: {
  scenario: ApScenario
  active?: boolean
}) {
  const { locale } = useI18n()
  const en = locale === "en"
  const [account, setAccount] = useApAccountState()
  const [state, setState] = useApState("plugins", () =>
    createPluginsState(scenario),
  )

  const integrations = useMemo(
    () =>
      account.integrations
        .filter((integration) =>
          pluginGalleryIds.some((id) => id === integration.integrationId),
        )
        .sort(
          (a, b) =>
            pluginGalleryIds.indexOf(
              a.integrationId as (typeof pluginGalleryIds)[number],
            ) -
            pluginGalleryIds.indexOf(
              b.integrationId as (typeof pluginGalleryIds)[number],
            ),
        )
        .map((integration) => ({
          ...integration,
          description: pluginDescription(
            pluginGalleryCopy[integration.integrationId] ??
              integration.description,
            scenario,
          ),
        })),
    [account.integrations, scenario],
  )
  const counts = pluginCounts(integrations)
  const visible = filterPlugins(integrations, state)
  const selected =
    state.selectedId == null
      ? null
      : (integrations.find((i) => i.integrationId === state.selectedId) ?? null)
  const draft =
    state.selectedId == null ? null : (state.drafts[state.selectedId] ?? null)
  const selectedTools = selected?.capabilities ?? []
  const op = state.op
  const locked = pluginOperationLocked(state)
  const missingIds = [
    ...new Set(
      account.projects
        .flatMap((project) =>
          pluginProjectIntegrationIds(project.integrationIds, scenario),
        )
        .filter(
          (id) => !account.integrations.some((i) => i.integrationId === id),
        ),
    ),
  ]
  const hasAlerts =
    !state.canWrite ||
    state.load !== "idle" ||
    state.notice === "refreshed" ||
    missingIds.length > 0 ||
    op !== null
  const openerRef = useRef<HTMLElement | null>(null)

  // Escape/close returns focus to the card control that opened the sheet.
  useEffect(() => {
    if (!active || state.selectedId != null || !openerRef.current) return
    const opener = openerRef.current
    openerRef.current = null
    const frame = requestAnimationFrame(() => opener.focus())
    return () => cancelAnimationFrame(frame)
  }, [active, state.selectedId])

  useEffect(() => {
    if (!state.skeleton) return
    const timer = setTimeout(
      () => setState(completeSkeleton),
      pluginSkeletonDelayMs,
    )
    return () => clearTimeout(timer)
  }, [state.skeleton, setState])

  useEffect(() => {
    if (state.load !== "pending") return
    const timer = setTimeout(() => setState(settleRefresh), pluginLoadDelayMs)
    return () => clearTimeout(timer)
  }, [state.load, setState])

  useEffect(() => {
    if (op?.status !== "pending") return
    const timer = setTimeout(() => {
      if (op.intent === "check") {
        const current =
          account.integrations.find((i) => i.integrationId === op.integrationId)
            ?.configVersion ?? -1
        setState((s) => resolveCheck(s, current))
      } else setState(resolveOperation)
    }, pluginOperationDelayMs)
    return () => clearTimeout(timer)
  }, [op, account.integrations, setState])

  // Confirmed receipts fold into the shared snapshot with absolute field
  // patches; re-running the effect can never double-increment a version.
  useEffect(() => {
    if (op?.status !== "confirmed") return
    setAccount((prev) => applyPluginOperation(prev, op))
    setState((s) => {
      const next = commitDraft(s, op)
      return s.connectionDialog ? closePlugin(next) : next
    })
  }, [op, setAccount, setState])

  useEffect(() => {
    if (state.test.status !== "pending") return
    const timer = setTimeout(
      () =>
        setState((s) =>
          settlePluginTest(
            s,
            integrations.find((i) => i.integrationId === s.test.integrationId),
          ),
        ),
      pluginTestDelayMs,
    )
    return () => clearTimeout(timer)
  }, [state.test, setState, integrations])

  const linkedProjects = (integrationId: string) =>
    account.projects.filter((project) =>
      project.integrationIds.includes(integrationId),
    )
  const linkedInScope = (integrationId: string) =>
    account.projects.some(
      (project) =>
        project.projectId === apScope.projectId &&
        project.integrationIds.includes(integrationId),
    )
  const startConnect = (integration: ApAccountIntegration) => {
    openerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    setState((s) =>
      openPluginForConnect(
        s,
        integration,
        linkedInScope(integration.integrationId),
      ),
    )
  }
  const saveDraft = () => {
    if (!selected || !draft) return
    const baselineEnabled = pluginSwitchOn(selected.status)
    const project = account.projects.find(
      (p) => p.projectId === draft.projectId,
    )
    const currentLinked =
      project?.integrationIds.includes(selected.integrationId) ?? false
    const stored = state.configs[selected.integrationId]
    const committedConfig =
      stored?.config ?? pluginConfigDefault(selected.integrationId)
    const committedTools = stored?.tools ?? [...selectedTools]
    const enabled =
      draft.enabled !== baselineEnabled ||
      (selected.status === "configuration-error" && draft.enabled)
        ? draft.enabled
        : null
    const linked = draft.linked !== currentLinked ? draft.linked : null
    const config = draft.config !== committedConfig ? draft.config : null
    const tools =
      draft.tools.length === committedTools.length &&
      draft.tools.every((tool, index) => tool === committedTools[index])
        ? null
        : [...draft.tools]
    const action: PluginAction = state.connectionDialog
      ? "connect"
      : enabled === true
        ? "enable"
        : enabled === false
          ? "disable"
          : "save"
    setState((s) =>
      beginOperation(s, {
        kind:
          action === "connect"
            ? "connect"
            : action === "disable"
              ? "disable"
              : "save",
        action,
        integrationId: selected.integrationId,
        projectId: draft.projectId,
        configVersion: selected.configVersion,
        enabled,
        linked,
        config,
        tools,
        reason: enabled === false ? draft.reason.trim() || null : null,
      }),
    )
  }

  const pillItems: { value: PluginFilter; label: string; count: number }[] = [
    { value: "all", label: en ? "All apps" : "全部应用", count: counts.all },
    {
      value: "connected",
      label: en ? "Connected" : "已连接",
      count: counts.connected,
    },
    ...pluginCategoryIds.map((category) => ({
      value: category as PluginFilter,
      label: pluginCategoryCopy[category][locale],
      count: counts[category],
    })),
  ]
  const opText = op ? describeOperation(op, en) : ""
  const validation =
    selected && draft
      ? pluginDraftValidation(draft, pluginSwitchOn(selected.status))
      : null
  const draftDirty =
    selected && draft
      ? draft.enabled !== pluginSwitchOn(selected.status) ||
        draft.config !==
          (state.configs[selected.integrationId]?.config ??
            pluginConfigDefault(selected.integrationId)) ||
        draft.tools.join("\0") !==
          (state.configs[selected.integrationId]?.tools ?? selectedTools).join(
            "\0",
          ) ||
        draft.linked !==
          Boolean(
            account.projects
              .find((p) => p.projectId === draft.projectId)
              ?.integrationIds.includes(selected.integrationId),
          )
      : false
  const catalogEmptyState =
    counts.all === 0 && state.search.trim() === "" && state.filter === "all"
  const requestNotice = state.notice === "request"
  const selectedProject = draft
    ? (account.projects.find((p) => p.projectId === draft.projectId)?.name ??
      draft.projectId)
    : ""

  const discardDraft = () => {
    if (!selected || !draft) return
    const linked =
      account.projects
        .find((p) => p.projectId === apScope.projectId)
        ?.integrationIds.includes(selected.integrationId) ?? false
    setState((s) => discardPluginDraft(s, selected, linked))
  }
  const exportConfiguration = () => {
    if (!selected || !draft) return
    const payload = {
      source: "fixture",
      integrationId: selected.integrationId,
      projectId: draft.projectId,
      configVersion: selected.configVersion,
      enabled: draft.enabled,
      linked: draft.linked,
      configuration: draft.config,
      tools: draft.tools,
    }
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      }),
    )
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = selected.integrationId + "-configuration.json"
    anchor.click()
    URL.revokeObjectURL(url)
  }
  const configuration = selected && draft && (
    <>
      {!state.canWrite && (
        <p
          className="rounded-control border border-warning/30 p-2 text-xs text-warning"
          data-ap-readonly-note
        >
          {en
            ? "Read-only access: this scenario never performs writes."
            : "只读访问：此场景不执行任何写入。"}
        </p>
      )}
      <div className={styles.sheetSection}>
        <span className={styles.label}>
          {en ? "Project access" : "项目访问"}
        </span>
        <ApSelect
          label={en ? "Project access" : "项目访问"}
          value={draft.projectId}
          disabled={!state.canWrite || locked}
          options={account.projects.map((project) => ({
            value: project.projectId,
            label: project.name,
          }))}
          onChange={(projectId) => {
            const linked =
              account.projects
                .find((p) => p.projectId === projectId)
                ?.integrationIds.includes(selected.integrationId) ?? false
            setState((s) =>
              selectDraftProject(s, selected.integrationId, projectId, linked),
            )
          }}
        />
      </div>

      <div className={styles.group}>
        <div className={styles.groupHead}>
          <span className={styles.label}>
            {en ? "Enable connection" : "启用连接"}
          </span>
          <Switch
            checked={draft.enabled}
            disabled={!state.canWrite || locked}
            aria-label={`${en ? "Enable connection" : "启用连接"} ${selected.name[locale]}`}
            onCheckedChange={(checked) =>
              setState((s) =>
                updateDraft(s, selected.integrationId, {
                  enabled: checked,
                  ...(checked ? { reason: "" } : {}),
                }),
              )
            }
          />
        </div>
        <p className={styles.help}>
          {en
            ? "Allow assistants to call the selected tools."
            : "允许助手调用所选工具。"}
        </p>
        {pluginSwitchOn(selected.status) && !draft.enabled && (
          <Field
            label={en ? "Disable reason" : "停用原因"}
            required
            description={
              en
                ? "Disabling requires a reason; it is stored with the fixture connection."
                : "停用必须填写原因，原因会随 fixture 连接一起保存。"
            }
          >
            {(props) => (
              <Textarea
                {...props}
                rows={2}
                value={draft.reason}
                disabled={!state.canWrite || locked}
                placeholder={
                  en ? "Why this connection is disabled" : "填写停用原因"
                }
                onChange={(event) =>
                  setState((s) =>
                    updateDraft(s, selected.integrationId, {
                      reason: event.target.value,
                    }),
                  )
                }
              />
            )}
          </Field>
        )}
      </div>

      <div className={styles.sheetSection}>
        <span className={styles.label}>
          {en ? "Available tools" : "可用工具"}
        </span>
        <ul className={styles.tools}>
          {selectedTools.map((tool) => (
            <li key={tool}>
              <label className={styles.tool}>
                <Checkbox
                  aria-label={tool}
                  checked={draft.tools.includes(tool)}
                  disabled={!state.canWrite || locked}
                  onCheckedChange={(checked) =>
                    setState((s) =>
                      updateDraft(s, selected.integrationId, {
                        tools: checked
                          ? [...draft.tools, tool]
                          : draft.tools.filter((t) => t !== tool),
                      }),
                    )
                  }
                />
                <code>{tool}</code>
              </label>
            </li>
          ))}
        </ul>
        <p className={styles.help} data-ap-tools-hint>
          {en
            ? "Select at least one tool to enable this connection."
            : "启用连接至少选择一个工具。"}
        </p>
      </div>

      <div className={styles.sheetSection}>
        <span className={styles.label}>{en ? "Permissions" : "权限"}</span>
        {(pluginPresentation[selected.integrationId]?.permissions ?? []).map(
          (permission) => (
            <p key={permission.en} className={styles.permission}>
              <ShieldCheck size={14} aria-hidden="true" />
              {permission[locale]}
            </p>
          ),
        )}
      </div>

      {!state.connectionDialog && (
        <div className={styles.group} data-ap-test-panel>
          <div className={styles.groupHead}>
            <span className={styles.label}>
              {en ? "Connection test" : "连接测试"}
            </span>
            <Button
              variant="secondary"
              data-ap-run-test
              disabled={state.test.status === "pending"}
              onClick={() =>
                setState((s) => beginPluginTest(s, selected.integrationId))
              }
            >
              {en ? "Run demo test" : "运行演示测试"}
            </Button>
          </div>
          <p className={styles.help}>
            {en
              ? "Verify the selected configuration using a scripted response."
              : "使用固定的脚本结果验证当前配置。"}
          </p>
          {state.test.integrationId === selected.integrationId &&
            state.test.status !== "idle" && (
              <p
                role="status"
                data-ap-test-result
                data-test-status={state.test.status}
                className={`mt-2 text-xs ${
                  state.test.status === "passed"
                    ? "text-success"
                    : state.test.status === "failed"
                      ? "text-destructive"
                      : "text-muted-foreground"
                }`}
              >
                {state.test.status === "pending"
                  ? en
                    ? "Running scripted test…"
                    : "正在运行脚本测试…"
                  : state.test.status === "passed"
                    ? en
                      ? `Passed: ${state.test.toolCount ?? 0} selected tools returned scripted sample results.`
                      : `已通过：${state.test.toolCount ?? 0} 个所选工具返回脚本样例结果。`
                    : selected.status === "configuration-error"
                      ? en
                        ? "Failed: the stored configuration is invalid."
                        : "未通过：当前配置无效。"
                      : selected.status === "not-connected"
                        ? en
                          ? "Failed: this integration is not connected yet."
                          : "未通过：此集成尚未连接。"
                        : state.test.configurationValid === false
                          ? en
                            ? "Failed: the selected configuration is invalid or disabled."
                            : "未通过：所选配置无效或已停用。"
                          : en
                            ? "Failed: this connection is disabled."
                            : "未通过：此连接已停用。"}
              </p>
            )}
        </div>
      )}
      {!state.connectionDialog && (
        <Button
          variant="secondary"
          className="self-start"
          data-ap-export
          onClick={exportConfiguration}
        >
          {en ? "Export configuration" : "导出配置"}
        </Button>
      )}

      {!state.connectionDialog && (
        <Collapsible
          defaultOpen={selected.status === "configuration-error"}
          className={styles.advanced}
        >
          <CollapsibleTrigger
            render={<Button variant="ghost" className="self-start" />}
            data-ap-advanced
          >
            {en
              ? "Project links and local configuration"
              : "项目关联与本地配置"}
          </CollapsibleTrigger>
          <CollapsibleContent keepMounted className={styles.advancedBody}>
            <p className={styles.sheetMeta} data-ap-sheet-meta>
              {selected.integrationId} ·{" "}
              {en
                ? `config v${selected.configVersion}`
                : `配置版本 v${selected.configVersion}`}
            </p>
            <p data-ap-linked-projects className={styles.help}>
              {en ? "Linked projects: " : "已关联项目："}
              {linkedProjects(selected.integrationId)
                .map((p) => p.name)
                .join(en ? ", " : "、") || (en ? "None" : "暂无")}
            </p>
            <div className={styles.group}>
              <div className={styles.groupHead}>
                <div className="min-w-0">
                  <span className={styles.label}>
                    {en ? "Link to selected project" : "关联到所选项目"}
                  </span>
                  <p className={styles.help}>{selectedProject}</p>
                </div>
                <Switch
                  checked={draft.linked}
                  disabled={!state.canWrite || locked}
                  aria-label={`${en ? "Link to selected project" : "关联到所选项目"} ${selectedProject}`}
                  onCheckedChange={(checked) =>
                    setState((s) =>
                      updateDraft(s, selected.integrationId, {
                        linked: checked,
                      }),
                    )
                  }
                />
              </div>
            </div>

            <Field
              label={en ? "Configuration" : "配置"}
              required={draft.enabled}
              description={
                en
                  ? "Local fixture value; never sent to a provider."
                  : "本地 fixture 值，不会发送给任何服务商。"
              }
              error={
                validation?.configError
                  ? en
                    ? "Configuration cannot be empty while the connection is enabled."
                    : "启用连接时配置不能为空。"
                  : undefined
              }
            >
              {(props) => (
                <Input
                  {...props}
                  value={draft.config}
                  disabled={!state.canWrite || locked}
                  onChange={(event) =>
                    setState((s) =>
                      updateDraft(s, selected.integrationId, {
                        config: event.target.value,
                      }),
                    )
                  }
                />
              )}
            </Field>
          </CollapsibleContent>
        </Collapsible>
      )}
    </>
  )

  return (
    <ApPage
      pageId="plugins"
      variant="full-width"
      title={en ? "Plugins" : "插件"}
      description={
        en
          ? "Connect the tools your team already uses and make them available to assistants."
          : "连接团队已经在用的工具，让助手可以直接调用。"
      }
      actions={
        <div className={styles.actions}>
          <Button
            variant="secondary"
            data-ap-request-integration
            disabled={!state.canWrite}
            onClick={() =>
              setState((s) => ({ ...s, request: { ...s.request, open: true } }))
            }
          >
            {en ? "Request integration" : "集成申请"}
          </Button>
          <Button
            data-ap-browse-all
            onClick={() =>
              setState((s) => ({ ...s, search: "", filter: "all" }))
            }
          >
            <Plus size={16} aria-hidden="true" />
            {en ? "Browse all" : "浏览全部"}
          </Button>
        </div>
      }
    >
      <section className={styles.gallery} data-ap-gallery>
        <div className={styles.head}>
          <div className="min-w-0">
            <p className={styles.title}>
              {en ? "Connection gallery" : "连接目录"}
            </p>
            <p className={styles.summary} data-ap-summary>
              {en
                ? `${counts.active} active · ${counts.all} available`
                : `${counts.active} 个已启用 · ${counts.all} 个可用`}
            </p>
          </div>
          <ApSearch
            label={en ? "Search plugins" : "搜索插件"}
            placeholder={en ? "Search integrations…" : "搜索集成…"}
            value={state.search}
            onChange={(value) => setState((s) => ({ ...s, search: value }))}
          />
        </div>
        <div className={styles.pills}>
          <ToggleGroup<PluginFilter>
            value={[state.filter]}
            aria-label={en ? "Filter connections" : "筛选连接"}
            onValueChange={(next) => {
              const picked = next[next.length - 1]
              if (picked) setState((s) => ({ ...s, filter: picked }))
            }}
            className={styles.filters}
          >
            {pillItems.map((item) => (
              <ToggleGroupItem
                key={item.value}
                value={item.value}
                disabled={state.skeleton}
              >
                {item.label}
                <span className={styles.pillCount} aria-hidden="true">
                  {item.count}
                </span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        {requestNotice && (
          <div
            role="status"
            data-ap-request-notice
            className="flex items-center justify-between gap-3 py-2 text-xs text-muted-foreground"
          >
            <span>
              {en
                ? `${state.requests.at(-1)?.name} · ${state.requests.length} request(s) recorded in this local workspace only; not sent to a provider.`
                : `${state.requests.at(-1)?.name} · 已在本地工作区记录 ${state.requests.length} 个申请，未发送给任何服务商。`}
            </span>
            <Button
              variant="ghost"
              onClick={() => setState((s) => ({ ...s, notice: "idle" }))}
            >
              {en ? "Dismiss" : "关闭提示"}
            </Button>
          </div>
        )}

        {hasAlerts && (
          <div className={styles.alerts}>
            {!state.canWrite && (
              <Alert tone="info" data-ap-readonly-gallery>
                {en
                  ? "Read-only access: inspect instructions and export local configuration; connection changes and integration requests are disabled."
                  : "只读访问：可查看说明与导出本地配置，不可更改连接或申请集成。"}
              </Alert>
            )}
            {(state.load === "error" || state.load === "pending") && (
              <Alert
                tone={state.load === "pending" ? "info" : "error"}
                data-ap-load-error
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {state.load === "pending"
                      ? en
                        ? "Refreshing the local connection gallery; existing data is retained."
                        : "正在刷新本地连接目录，现有数据仍保留。"
                      : en
                        ? "Connection gallery refresh failed. Showing the last local data."
                        : "连接目录刷新失败，仍显示上一次的本地数据。"}
                  </span>
                  <Button
                    variant="secondary"
                    data-ap-retry
                    disabled={state.load === "pending"}
                    onClick={() => setState(beginRefresh)}
                  >
                    <RotateCcw size={16} aria-hidden="true" />
                    {en ? "Retry read" : "重试读取"}
                  </Button>
                </div>
              </Alert>
            )}
            {state.notice === "refreshed" && (
              <p
                role="status"
                data-ap-refresh-notice
                className="text-xs text-success"
              >
                {en ? `Refreshed · ${apAsOf}` : `已刷新 · ${apAsOf}`}
              </p>
            )}
            {missingIds.length > 0 && (
              <Alert tone="warning" data-ap-missing-ref>
                {en
                  ? `${missingIds.length} linked reference unavailable in the catalog: ${missingIds.join(", ")}`
                  : `${missingIds.length} 个关联引用在目录中不可用：${missingIds.join("、")}`}
              </Alert>
            )}
            {op && (
              <div role="status" className={styles.strip} data-ap-op-strip>
                <span data-ap-op-status={op.status}>{opText}</span>
                {op.status === "unknown" && (
                  <Button
                    variant="secondary"
                    data-ap-check-result
                    disabled={!state.canWrite}
                    onClick={() => setState(beginCheck)}
                  >
                    {en ? "Check result" : "查询结果"}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
        {state.skeleton ? (
          <div
            role="region"
            className={styles.body}
            data-ap-skeleton
            aria-busy="true"
            aria-label={en ? "Loading connections" : "正在加载连接"}
          >
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <div key={index} className={styles.skeleton} />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div className={styles.empty}>
            <Empty
              data-ap-empty
              title={
                catalogEmptyState
                  ? en
                    ? "No plugins yet"
                    : "尚无任何插件"
                  : en
                    ? "No matching integrations"
                    : "没有匹配的集成"
              }
              description={
                catalogEmptyState
                  ? en
                    ? "The fixture connection catalog is empty in this scenario."
                    : "此场景的 fixture 连接目录为空。"
                  : en
                    ? "Try another category or clear your search."
                    : "调整分类或清除搜索后重试。"
              }
              action={
                catalogEmptyState ? undefined : (
                  <Button
                    variant="secondary"
                    data-ap-clear-filters
                    onClick={() =>
                      setState((s) => ({ ...s, search: "", filter: "all" }))
                    }
                  >
                    {en ? "Clear filters" : "清除筛选"}
                  </Button>
                )
              }
            />
          </div>
        ) : (
          <div className={styles.body} data-ap-grid>
            {visible.map((integration) => {
              const name = integration.name[locale]
              const status = statusCopy[integration.status]
              const switchOn = pluginSwitchOn(integration.status)
              const disabledReason = integration.disabledReason
              return (
                <article
                  key={integration.integrationId}
                  className={styles.card}
                  data-ap-card={integration.integrationId}
                  data-ap-status={integration.status}
                >
                  <div className={styles.cardMain}>
                    <div className={styles.cardHead}>
                      <Avatar
                        name={integration.provider}
                        src={pluginBrandSources[integration.integrationId]}
                        size={40}
                        className={`${styles.logo} ${["integration-github", "integration-notion"].includes(integration.integrationId) ? styles.monoLogo : ""}`}
                      />
                      <div className={styles.identity}>
                        <h2 className={styles.name} title={name}>
                          {name}
                        </h2>
                        {pluginPresentation[integration.integrationId]
                          ?.isNew && (
                          <span className={styles.newLabel}>
                            {en ? "New" : "新"}
                          </span>
                        )}
                        <span className={styles.vendor}>
                          {en
                            ? `By ${pluginPresentation[integration.integrationId]?.vendor ?? integration.provider}`
                            : `由 ${pluginPresentation[integration.integrationId]?.vendor ?? integration.provider} 提供`}
                        </span>
                      </div>
                      <Switch
                        checked={switchOn}
                        disabled={!state.canWrite || locked}
                        aria-label={`${switchOn ? (en ? "Disable" : "停用") : en ? "Enable" : "启用"} ${name}`}
                        onCheckedChange={(checked) => {
                          if (checked) startConnect(integration)
                          else {
                            openerRef.current =
                              document.activeElement instanceof HTMLElement
                                ? document.activeElement
                                : null
                            setState((s) =>
                              openPluginForDisable(
                                s,
                                integration,
                                linkedInScope(integration.integrationId),
                              ),
                            )
                          }
                        }}
                      />
                    </div>
                    <p
                      data-ap-description
                      className={styles.desc}
                      title={integration.description[locale]}
                    >
                      {integration.description[locale]}
                    </p>
                    <div className={styles.meta}>
                      <Badge tone="neutral" size="sm">
                        {pluginCategoryCopy[
                          integration.category as keyof typeof pluginCategoryCopy
                        ]?.[locale] ?? integration.category}
                      </Badge>
                      <Badge tone="neutral" size="sm">
                        {en
                          ? `${pluginPresentation[integration.integrationId]?.steps ?? integration.capabilities.length} steps`
                          : `${pluginPresentation[integration.integrationId]?.steps ?? integration.capabilities.length} 个步骤`}
                      </Badge>
                    </div>
                    {integration.status === "disabled" && disabledReason && (
                      <p
                        className={styles.reason}
                        title={disabledReason[locale]}
                        data-ap-disabled-reason
                      >
                        {en ? "Disabled: " : "停用原因："}
                        {disabledReason[locale]}
                      </p>
                    )}
                  </div>
                  <div className={styles.cardFoot}>
                    {integration.status === "configuration-error" && (
                      <Badge tone="danger" size="sm" data-ap-status-badge>
                        {status[locale]}
                      </Badge>
                    )}
                    {integration.status === "disabled" && (
                      <Badge tone="warning" size="sm" data-ap-status-badge>
                        {status[locale]}
                      </Badge>
                    )}
                    <Button
                      variant="ghost"
                      aria-label={
                        en ? `View details: ${name}` : `查看详情：${name}`
                      }
                      data-ap-details={integration.integrationId}
                      onClick={() => {
                        openerRef.current =
                          document.activeElement instanceof HTMLElement
                            ? document.activeElement
                            : null
                        if (
                          integration.status === "not-connected" ||
                          integration.status === "disabled"
                        )
                          startConnect(integration)
                        else
                          setState((s) =>
                            openPlugin(
                              s,
                              integration,
                              linkedInScope(integration.integrationId),
                            ),
                          )
                      }}
                    >
                      {en ? "View instruction" : "查看说明"}
                    </Button>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>
      <p className={styles.note} data-ap-fixture-note>
        {en
          ? `Connections use scripted fixture results; configuration stays in this demo workspace · ${apFixtureRevision}`
          : `连接使用本地 fixture 脚本结果，配置仅保留在本演示工作区 · ${apFixtureRevision}`}
      </p>

      {active && state.request.open && (
        <Dialog
          open
          onOpenChange={(open) =>
            setState((s) => ({ ...s, request: { ...s.request, open } }))
          }
        >
          <DialogContent data-ap-request-dialog>
            <form
              onSubmit={(event) => {
                event.preventDefault()
                setState(submitIntegrationRequest)
              }}
            >
              <DialogTitle>
                {en ? "Request integration" : "申请集成"}
              </DialogTitle>
              <DialogDescription>
                {en
                  ? "Record an integration request in this local workspace. Nothing is sent to a provider."
                  : "在本地工作区记录集成申请，不会发送给任何服务商。"}
              </DialogDescription>
              <DialogBody className={styles.requestForm}>
                <Field label={en ? "App name" : "应用名称"} required>
                  {(props) => (
                    <Input
                      {...props}
                      required
                      value={state.request.name}
                      onChange={(event) =>
                        setState((s) => ({
                          ...s,
                          request: { ...s.request, name: event.target.value },
                        }))
                      }
                    />
                  )}
                </Field>
                <Field label={en ? "Website" : "应用网址"}>
                  {(props) => (
                    <Input
                      {...props}
                      type="url"
                      value={state.request.url}
                      onChange={(event) =>
                        setState((s) => ({
                          ...s,
                          request: { ...s.request, url: event.target.value },
                        }))
                      }
                    />
                  )}
                </Field>
                <Field
                  label={en ? "How will your team use it?" : "团队将如何使用？"}
                  required
                >
                  {(props) => (
                    <Textarea
                      {...props}
                      required
                      value={state.request.purpose}
                      onChange={(event) =>
                        setState((s) => ({
                          ...s,
                          request: {
                            ...s.request,
                            purpose: event.target.value,
                          },
                        }))
                      }
                    />
                  )}
                </Field>
              </DialogBody>
              <DialogFooter>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    setState((s) => ({
                      ...s,
                      request: { ...s.request, open: false },
                    }))
                  }
                >
                  {en ? "Cancel" : "取消"}
                </Button>
                <Button
                  type="submit"
                  disabled={
                    !state.canWrite ||
                    !state.request.name.trim() ||
                    !state.request.purpose.trim()
                  }
                >
                  {en ? "Record request locally" : "在本地记录申请"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}

      {active && selected && draft && !state.connectionDialog && (
        <Sheet
          open
          onOpenChange={(open) => {
            if (!open) setState(closePlugin)
          }}
        >
          <SheetContent side="right" size={512} data-ap-sheet>
            <SheetHeader className={styles.instructionHeader}>
              <div className={styles.sheetHead}>
                <Avatar
                  name={selected.provider}
                  src={pluginBrandSources[selected.integrationId]}
                  size={40}
                  className={`${styles.logo} ${["integration-github", "integration-notion"].includes(selected.integrationId) ? styles.monoLogo : ""}`}
                />
                <div className="min-w-0 flex-1">
                  <SheetTitle className="text-base">
                    {selected.name[locale]}
                  </SheetTitle>
                  <SheetDescription>
                    {en
                      ? `By ${pluginPresentation[selected.integrationId]?.vendor ?? selected.provider}`
                      : `由 ${pluginPresentation[selected.integrationId]?.vendor ?? selected.provider} 提供`}
                  </SheetDescription>
                </div>
              </div>
              <p className={styles.instructionDescription}>
                {selected.description[locale]}
              </p>
            </SheetHeader>
            <SheetBody
              className={`${styles.configuration} ${styles.instructionBody}`}
            >
              {selected.status === "configuration-error" && (
                <Alert tone="warning">
                  {en
                    ? "Reconnect this integration to restore access to its selected tools."
                    : "重新连接此集成以恢复所选工具的访问权限。"}
                </Alert>
              )}
              {configuration}
            </SheetBody>

            <SheetFooter className={styles.sheetFooterRow}>
              <div className={styles.receiptRow}>
                <p className={styles.receiptText}>
                  {op && op.integrationId === selected.integrationId
                    ? opText
                    : ""}
                </p>
                {op &&
                  op.integrationId === selected.integrationId &&
                  op.status === "unknown" && (
                    <Button
                      variant="secondary"
                      data-ap-check-result-sheet
                      className={styles.receiptAction}
                      disabled={!state.canWrite}
                      onClick={() => setState(beginCheck)}
                    >
                      {en ? "Check result" : "查询结果"}
                    </Button>
                  )}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="ghost"
                  data-ap-remove
                  disabled={
                    !state.canWrite ||
                    locked ||
                    !pluginSwitchOn(selected.status)
                  }
                  onClick={() =>
                    setState((s) =>
                      openPluginForDisable(
                        s,
                        selected,
                        linkedInScope(selected.integrationId),
                      ),
                    )
                  }
                >
                  {en ? "Remove connection" : "停用连接"}
                </Button>
                <Button
                  variant="secondary"
                  data-ap-discard
                  hidden={!draftDirty}
                  disabled={!state.canWrite || locked || !draftDirty}
                  onClick={discardDraft}
                >
                  {en ? "Discard" : "放弃更改"}
                </Button>
                <Button
                  data-ap-save
                  disabled={
                    !state.canWrite ||
                    locked ||
                    !draftDirty ||
                    !validation?.valid
                  }
                  onClick={saveDraft}
                >
                  {en ? "Save changes" : "保存更改"}
                </Button>
              </div>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      )}

      {active && selected && draft && state.connectionDialog && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setState(closePlugin)
          }}
        >
          <DialogContent
            className={styles.connectDialog}
            data-ap-connect-dialog
          >
            <div className={styles.sheetHead}>
              <Avatar
                name={selected.provider}
                src={pluginBrandSources[selected.integrationId]}
                size={40}
                className={`${styles.logo} ${["integration-github", "integration-notion"].includes(selected.integrationId) ? styles.monoLogo : ""}`}
              />
              <div>
                <DialogTitle>
                  {en ? "Connect " : "连接 "}
                  {selected.name[locale]}
                </DialogTitle>
                <p className={styles.vendor}>
                  {en ? "By " : "提供商："}
                  {pluginPresentation[selected.integrationId]?.vendor ??
                    selected.provider}
                </p>
              </div>
            </div>
            <DialogDescription>
              {en
                ? "Choose where this connection can be used and review its tool permissions."
                : "选择可使用连接的项目并审阅工具权限。"}
            </DialogDescription>
            <DialogBody className={styles.configuration}>
              {configuration}
            </DialogBody>
            {op?.integrationId === selected.integrationId && (
              <p
                role="status"
                className={styles.receipt}
                data-ap-dialog-receipt
              >
                {opText}
              </p>
            )}
            <DialogFooter>
              <Button
                variant="secondary"
                disabled={locked}
                onClick={() => {
                  discardDraft()
                  setState(closePlugin)
                }}
              >
                {en ? "Cancel" : "取消"}
              </Button>
              <Button
                data-ap-connect-submit
                disabled={!state.canWrite || locked || !validation?.valid}
                onClick={saveDraft}
              >
                {en ? "Connect integration" : "连接集成"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </ApPage>
  )
}
