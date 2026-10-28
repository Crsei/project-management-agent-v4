"use client"
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react"
import {
  Copy,
  RefreshCw,
  Plus,
  Trash2,
  Check,
  ExternalLink,
  UserRound,
  UsersRound,
  Bot,
  Save,
} from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Badge } from "@easyuse-ui/ui/components/ui/badge"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import { Field } from "@easyuse-ui/ui/components/ui/field"
import { Checkbox } from "@easyuse-ui/ui/components/ui/checkbox"
import { Label } from "@easyuse-ui/ui/components/ui/label"
import { DataRegion } from "@easyuse-ui/ui/components/ui/data-region"
import { Switch } from "@easyuse-ui/ui/components/ui/switch"
import styles from "./project-settings.module.css"
import {
  Table,
  TableContainer,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
} from "@easyuse-ui/ui/components/ui/table"
import {
  Tabs,
  TabsList,
  TabsTab,
  TabsPanel,
} from "@easyuse-ui/ui/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@easyuse-ui/ui/components/ui/dialog"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { ApPage, ApSelect, ApSearch } from "../shared"
import { useApState } from "../state"
import { useApAccountState } from "../account-state"
import {
  apAsOf,
  apScenarios,
  type ApOperationResult,
  type ApScenario,
} from "../model"
import type { RemainingPageProps } from "../../showcase/model"
import { createCatalogModels } from "../fixtures/models"
import type { ApAccountMember } from "../fixtures/accounts"
import {
  accountCapabilityCopy,
  accountCapabilityOrder,
  applyResolution,
  beginCheck,
  beginRefresh,
  beginSave,
  budgetMicroUsdMax,
  capabilityRows,
  closeCompletedDialog,
  completeLoad,
  createProjectState,
  dialogCloseBlocked,
  draftFor,
  effectiveModel,
  effectiveNumber,
  formatGrouped,
  hasErrors,
  isBuiltInRole,
  isProtectedProjectOwner,
  canDeleteProjectRole,
  isGeneralDirty,
  isLimitsDirty,
  parseIntegerText,
  parseUsdMicro,
  formatUsdMicro,
  validModelRates,
  projectSectionIds,
  resetSection,
  resolveSave,
  selectProject,
  setSection,
  settleRefresh,
  tokenLimitMax,
  updateDraft,
  validateGeneral,
  validateLimits,
  writeGate,
  writeLocked,
  type ProjectDraft,
  type ProjectRequest,
  type ProjectSectionId,
  type SaveState,
  type WriteGate,
} from "./controller"

const operationDelayMs = 1000
const idleSave: SaveState = {
  status: "idle",
  intent: null,
  operationId: null,
  section: null,
  request: null,
}

export const pageScenarios = apScenarios

/** The Lab supplies page/scenario caches and the shared account provider. */
export function RemainingPageView({ scenario }: RemainingPageProps) {
  const selected =
    pageScenarios.find((item) => item.id === scenario)?.id ?? "default"
  return <ProjectSettingsView scenario={selected} />
}

export function ProjectSettingsView({ scenario }: { scenario: ApScenario }) {
  const { locale } = useI18n()
  const en = locale === "en"
  const content = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (content.current) content.current.dataset.apReady = "true"
  }, [])
  const [account, updateAccountSnapshot] = useApAccountState()
  const [state, setState] = useApState("project-settings", () =>
    createProjectState(scenario),
  )
  const models = useMemo(() => createCatalogModels(scenario), [scenario])
  const projectGate = writeGate(account, scenario, "project.write")
  const membersGate = writeGate(account, scenario, "members.write")
  const locked = writeLocked(state)
  const loading = !state.loaded
  const project =
    account.projects.find(
      (item) => item.projectId === state.selectedProjectId,
    ) ?? account.projects[0]

  /** Confirmed writes are applied as functional patches so sibling snapshot updates are never replaced. */
  const patchAccount = useCallback(
    (request: ProjectRequest) => {
      updateAccountSnapshot((prev) => {
        switch (request.kind) {
          case "project-details":
          case "project-limits": {
            const patch =
              request.kind === "project-details"
                ? {
                    name: request.name,
                    description: request.description,
                    dataRegion: request.dataRegion,
                    logRetentionDays: request.logRetentionDays,
                    acceptsNewRequests: request.acceptsNewRequests,
                    integrationIds: [...request.integrationIds],
                  }
                : {
                    defaultModelId: request.defaultModelId,
                    modelTokenLimit: request.modelTokenLimit,
                    monthlyBudgetMicroUsd: request.monthlyBudgetMicroUsd,
                    modelLimits: request.modelLimits.map((row) => ({ ...row })),
                  }
            return {
              ...prev,
              projects: prev.projects.map((item) =>
                item.projectId === request.projectId
                  ? { ...item, ...patch }
                  : item,
              ),
            }
          }
          case "member-role":
            return {
              ...prev,
              members: prev.members.map((member) =>
                member.memberId === request.memberId
                  ? { ...member, roleId: request.roleId }
                  : member,
              ),
            }
          case "member-remove":
            return {
              ...prev,
              members: prev.members.map((member) =>
                member.memberId === request.memberId
                  ? {
                      ...member,
                      projectIds: member.projectIds.filter(
                        (id) => id !== request.projectId,
                      ),
                    }
                  : member,
              ),
            }
          case "invitation-cancel":
            return {
              ...prev,
              members: prev.members.filter(
                (member) => member.memberId !== request.memberId,
              ),
            }
          case "member-create":
            return {
              ...prev,
              members: [
                ...prev.members,
                {
                  memberId: request.memberId,
                  name: request.name,
                  email: request.email,
                  roleId: request.roleId,
                  projectIds: [request.projectId],
                  groupIds: [],
                  invitationState:
                    request.memberKind === "user" ? "invited" : "active",
                  type: request.memberKind,
                },
              ],
            }
          case "group-create":
            return {
              ...prev,
              groups: [
                ...prev.groups,
                {
                  groupId: request.groupId,
                  name: request.name,
                  description: request.description,
                  roleId: request.roleId,
                },
              ],
              members: prev.members.map((member) =>
                request.memberIds.includes(member.memberId)
                  ? {
                      ...member,
                      groupIds: [...member.groupIds, request.groupId],
                    }
                  : member,
              ),
            }
          case "group-delete":
            return {
              ...prev,
              groups: prev.groups.filter(
                (group) => group.groupId !== request.groupId,
              ),
              members: prev.members.map((member) => ({
                ...member,
                groupIds: member.groupIds.filter(
                  (id) => id !== request.groupId,
                ),
              })),
            }
          case "group-members":
            return {
              ...prev,
              groups: prev.groups.map((group) =>
                group.groupId === request.groupId
                  ? {
                      ...group,
                      description: request.description,
                      roleId: request.roleId,
                    }
                  : group,
              ),
              members: prev.members.map((member) => {
                // Preserve membership outside the project subset owned by this editor.
                if (!member.projectIds.includes(request.projectId))
                  return member
                const inside = request.memberIds.includes(member.memberId)
                const has = member.groupIds.includes(request.groupId)
                if (inside && !has)
                  return {
                    ...member,
                    groupIds: [...member.groupIds, request.groupId],
                  }
                if (!inside && has)
                  return {
                    ...member,
                    groupIds: member.groupIds.filter(
                      (id) => id !== request.groupId,
                    ),
                  }
                return member
              }),
            }
          case "role-create":
            return {
              ...prev,
              roles: [
                ...prev.roles,
                {
                  roleId: request.roleId,
                  name: { "zh-CN": request.name, en: request.name },
                  capabilities: [...request.capabilities],
                },
              ],
            }
          case "role-edit":
            return {
              ...prev,
              roles: prev.roles.map((role) =>
                role.roleId === request.roleId
                  ? {
                      ...role,
                      name: { "zh-CN": request.name, en: request.name },
                      capabilities: [...request.capabilities],
                    }
                  : role,
              ),
            }
          case "role-delete":
            return {
              ...prev,
              roles: prev.roles.filter(
                (role) => role.roleId !== request.roleId,
              ),
            }
        }
      })
    },
    [updateAccountSnapshot],
  )

  useEffect(() => {
    if (state.save.status !== "pending") return
    const captured = state.save
    const timer = setTimeout(() => {
      const resolution = resolveSave(captured)
      setState((current) => {
        const next = applyResolution(current, captured, resolution)
        return resolution.confirmed
          ? closeCompletedDialog(next, resolution.confirmed)
          : next
      })
      if (resolution.confirmed) patchAccount(resolution.confirmed)
    }, operationDelayMs)
    return () => clearTimeout(timer)
  }, [state.save, patchAccount, setState])

  useEffect(() => {
    if (state.refresh !== "pending") return
    const timer = setTimeout(() => setState(settleRefresh), operationDelayMs)
    return () => clearTimeout(timer)
  }, [state.refresh, state.refreshIntent, setState])

  const sectionLabel = (section: ProjectSectionId): string => {
    if (section === "general") return en ? "General" : "基本信息"
    if (section === "model-limits") return en ? "Model limits" : "模型限额"
    if (section === "members") return en ? "Members" : "成员"
    if (section === "groups") return en ? "Groups" : "用户组"
    return en ? "Roles" : "角色"
  }

  function submitGeneral(draft: ProjectDraft) {
    if (!project) return
    const errors = validateGeneral(account, draft)
    if (hasErrors(errors, ["name", "missingIntegrations"])) return
    const wanted = new Set(draft.integrationIds)
    setState((current) =>
      beginSave(
        current,
        "general",
        {
          kind: "project-details",
          projectId: project.projectId,
          name: draft.name.trim(),
          description: draft.description.trim(),
          dataRegion: draft.dataRegion,
          logRetentionDays: Number(draft.logRetentionDays),
          acceptsNewRequests: draft.acceptsNewRequests,
          integrationIds: account.integrations
            .map((item) => item.integrationId)
            .filter((id) => wanted.has(id)),
        },
        projectGate,
      ),
    )
  }

  function submitLimits(draft: ProjectDraft) {
    if (!project) return
    const errors = validateLimits(scenario, draft)
    if (hasErrors(errors, ["model", "token", "budget"])) return
    if (!validModelRates(draft)) return
    const tokenParsed =
      draft.tokenMode === "inherit"
        ? null
        : parseIntegerText(draft.tokenText, tokenLimitMax)
    const budgetParsed =
      draft.budgetMode === "inherit"
        ? null
        : parseIntegerText(draft.budgetText, budgetMicroUsdMax)
    // Validation above guarantees ok; these guards keep the narrowing cast-free.
    if (tokenParsed && !tokenParsed.ok) return
    if (budgetParsed && !budgetParsed.ok) return
    setState((current) =>
      beginSave(
        current,
        "model-limits",
        {
          kind: "project-limits",
          projectId: project.projectId,
          defaultModelId: draft.modelMode === "inherit" ? null : draft.modelId,
          modelTokenLimit: tokenParsed ? tokenParsed.value : null,
          monthlyBudgetMicroUsd: budgetParsed ? budgetParsed.value : null,
          modelLimits: draft.modelLimits.map((row) => ({
            modelId: row.modelId,
            requestsPerMinute: Number(row.requestsText),
            tokensPerMinute: Number(row.tokensText),
            enabled: row.enabled,
          })),
        },
        projectGate,
      ),
    )
  }

  function discard(section: ProjectSectionId) {
    if (!project) return
    setState((current) => ({
      ...resetSection(current, section, project),
      save: idleSave,
    }))
  }

  async function copyProjectId() {
    if (!project) return
    try {
      await navigator.clipboard.writeText(project.projectId)
      setState((current) => ({ ...current, notice: "copied-project" }))
    } catch {
      setState((current) => ({ ...current, notice: "copy-error" }))
    }
  }

  function renderReceipt(
    section: ProjectSectionId | null,
    scope: string,
  ): ReactNode {
    const save = state.save
    if (save.status === "idle") return null
    if (section === null) {
      // While an operation's dialog is open the receipt renders inside it.
      const dialogs = state.dialogs
      const owned =
        (save.section === "members" &&
          (!!dialogs.editMemberId || !!dialogs.createMember)) ||
        (save.section === "groups" &&
          (dialogs.createGroup || !!dialogs.manageGroupId)) ||
        (save.section === "roles" &&
          (dialogs.createRole || !!dialogs.editRoleId))
      if (owned) return null
    } else if (save.section !== section) return null
    const status: ApOperationResult = save.status
    const receiptGate =
      save.section === "general" || save.section === "model-limits"
        ? projectGate
        : membersGate
    const text =
      status === "pending"
        ? save.intent === "check"
          ? en
            ? "Checking the recorded result…"
            : "正在查询记录结果…"
          : en
            ? "Saving…"
            : "正在保存…"
        : status === "confirmed"
          ? en
            ? "Saved. Confirmed state updated."
            : "已保存，已更新确认状态。"
          : status === "rejected"
            ? en
              ? "Rejected. Confirmed state and drafts are kept."
              : "保存被拒绝，已保留确认状态与草稿。"
            : en
              ? `Result unknown for operation ${save.operationId ?? ""}. The original request is kept; check the recorded result.`
              : `结果未知（操作 ${save.operationId ?? ""}），原始请求已保留，请查询结果。`
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p
          role="status"
          data-ap-receipt={scope}
          data-status={status}
          data-ap-operation={save.operationId ?? undefined}
          className="text-sm"
        >
          {text}
        </p>
        {status === "unknown" && (
          <Button
            variant="secondary"
            data-ap-check
            disabled={!receiptGate.canWrite}
            onClick={() =>
              setState((current) => beginCheck(current, receiptGate))
            }
          >
            {en ? "Check result" : "查询结果"}
          </Button>
        )}
      </div>
    )
  }

  function gateNote(
    gateToNote: WriteGate,
    where: "toolbar" | "section",
  ): ReactNode {
    if (gateToNote.canWrite) return null
    const visible =
      where === "toolbar"
        ? gateToNote.blocked === "scope"
        : gateToNote.blocked !== "scope"
    if (!visible) return null
    return (
      <p
        data-ap-readonly-note
        data-blocked={gateToNote.blocked}
        data-where={where}
        className="text-xs text-muted-foreground"
      >
        {gateToNote.blocked === "scope"
          ? en
            ? "Read-only scope: this page cannot write."
            : "只读范围：本页无法写入。"
          : gateToNote.blocked === "capability"
            ? en
              ? "Your role lacks the required capability, so this section is read-only."
              : "当前账号角色缺少所需能力，本分区只读。"
            : en
              ? "Your role reference is missing; this section fails closed as unknown capability."
              : "当前账号角色引用缺失，本分区按未知能力停用写入。"}
      </p>
    )
  }

  function modeGroup(
    mode: "inherit" | "override",
    onChange: (next: "inherit" | "override") => void,
  ): ReactNode {
    return (
      <div
        role="group"
        aria-label={en ? "Override source" : "覆盖来源"}
        className="flex flex-wrap gap-2"
      >
        <Button
          size="sm"
          variant="outline"
          aria-pressed={mode === "inherit"}
          data-ap-mode="inherit"
          disabled={locked || !projectGate.canWrite}
          onClick={() => onChange("inherit")}
        >
          {en ? "Inherit organization" : "继承组织"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          aria-pressed={mode === "override"}
          data-ap-mode="override"
          disabled={locked || !projectGate.canWrite}
          onClick={() => onChange("override")}
        >
          {en ? "Project override" : "项目覆盖"}
        </Button>
      </div>
    )
  }

  function renderGeneral(): ReactNode {
    if (!project) return null
    const draft = draftFor(state, project)
    const dirty = isGeneralDirty(project, draft)
    const errors = validateGeneral(account, draft)
    const formLocked = locked || !projectGate.canWrite
    const statusText =
      state.notice === "copied-project"
        ? en
          ? "Project ID copied."
          : "已复制项目 ID。"
        : state.notice === "copy-error"
          ? en
            ? "Clipboard unavailable; select the ID and copy manually."
            : "剪贴板不可用，请手动选择项目 ID 复制。"
          : ""
    return (
      <div data-ap-section="general" className={styles.general}>
        <div className={styles.sectionHeading}>
          <h2>{en ? "General" : "基本信息"}</h2>
          <p>
            {en
              ? "The identity and operating defaults for this project."
              : "本项目的身份信息与运行默认值。"}
          </p>
          {gateNote(projectGate, "section")}
        </div>
        <div className={styles.identifier}>
          <div className="min-w-0 flex-1">
            <p>{en ? "Project ID" : "项目 ID"}</p>
            <code data-ap-project-id>{project.projectId}</code>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={en ? "Copy project ID" : "复制项目 ID"}
            onClick={() => void copyProjectId()}
          >
            <Copy aria-hidden="true" />
          </Button>
          {statusText && (
            <p role="status" data-ap-copy-status data-status={state.notice}>
              {statusText}
            </p>
          )}
        </div>
        <form
          className={styles.generalForm}
          onSubmit={(event) => {
            event.preventDefault()
            submitGeneral(draft)
          }}
        >
          <Field
            label={en ? "Project name" : "项目名称"}
            required
            error={
              errors.name
                ? en
                  ? "Project name is required."
                  : "项目名称必填。"
                : undefined
            }
          >
            {(props) => (
              <Input
                {...props}
                value={draft.name}
                maxLength={120}
                disabled={formLocked}
                data-ap-name-input
                onChange={(event) =>
                  setState((current) =>
                    updateDraft(current, project, { name: event.target.value }),
                  )
                }
              />
            )}
          </Field>
          <Field label={en ? "Description" : "项目描述"}>
            {(props) => (
              <Textarea
                {...props}
                rows={2}
                maxLength={400}
                disabled={formLocked}
                data-ap-description-input
                value={draft.description}
                onChange={(event) =>
                  setState((current) =>
                    updateDraft(current, project, {
                      description: event.target.value,
                    }),
                  )
                }
              />
            )}
          </Field>
          <div className={styles.operatingDefaults}>
            <Field
              label={en ? "Data region" : "数据区域"}
              description={
                en
                  ? "Applies to future requests in this demo."
                  : "适用于本演示中后续的请求。"
              }
            >
              {() => (
                <ApSelect
                  label={en ? "Data region" : "数据区域"}
                  value={draft.dataRegion}
                  disabled={formLocked}
                  options={[
                    { value: "us-east", label: en ? "US East" : "美国东部" },
                    { value: "eu-west", label: en ? "EU West" : "欧洲西部" },
                    {
                      value: "ap-southeast",
                      label: en ? "Asia Pacific" : "亚太地区",
                    },
                  ]}
                  onChange={(value) =>
                    setState((current) =>
                      updateDraft(current, project, { dataRegion: value }),
                    )
                  }
                />
              )}
            </Field>
            <Field label={en ? "Log retention" : "日志保留"}>
              {() => (
                <ApSelect
                  label={en ? "Log retention" : "日志保留"}
                  value={draft.logRetentionDays}
                  disabled={formLocked}
                  options={[7, 30, 90].map((days) => ({
                    value: String(days),
                    label: en ? days + " days" : days + " 天",
                  }))}
                  onChange={(value) =>
                    setState((current) =>
                      updateDraft(current, project, {
                        logRetentionDays: value,
                      }),
                    )
                  }
                />
              )}
            </Field>
          </div>
          <div className={styles.acceptRequests}>
            <div>
              <Label htmlFor="ap-accept-requests">
                {en ? "Accept new requests" : "接受新请求"}
              </Label>
              <p>
                {en
                  ? "Pause new work without removing files or member access."
                  : "暂停新任务，不移除文件或成员访问权限。"}
              </p>
            </div>
            <Switch
              id="ap-accept-requests"
              aria-label={en ? "Accept new requests" : "接受新请求"}
              checked={draft.acceptsNewRequests}
              disabled={formLocked}
              onCheckedChange={(checked) =>
                setState((current) =>
                  updateDraft(current, project, {
                    acceptsNewRequests: checked,
                  }),
                )
              }
            />
          </div>
          <div className={styles.generalFooter}>
            <span
              data-ap-dirty="general"
              data-dirty={dirty}
              className={styles.projectStatus}
            >
              {dirty
                ? en
                  ? "Unsaved changes"
                  : "有未保存更改"
                : draft.acceptsNewRequests
                  ? en
                    ? "Active"
                    : "活跃"
                  : en
                    ? "Paused"
                    : "已暂停"}
            </span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                data-ap-discard="general"
                disabled={!projectGate.canWrite || locked || !dirty}
                onClick={() => discard("general")}
              >
                {en ? "Discard" : "取消"}
              </Button>
              <Button
                type="submit"
                data-ap-save="general"
                disabled={
                  !projectGate.canWrite ||
                  locked ||
                  !dirty ||
                  hasErrors(errors, ["name", "missingIntegrations"])
                }
              >
                <Save aria-hidden="true" />
                {en ? "Save changes" : "保存更改"}
              </Button>
            </div>
          </div>
          <div className={styles.integrationLinks}>
            <div>
              <h3>{en ? "Project integrations" : "项目集成"}</h3>
              <p>
                {en
                  ? "Manage endpoints and evaluation providers in their workspaces."
                  : "在对应工作区管理端点和评测提供商。"}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                nativeButton={false}
                role="link"
                render={<a href="/showcase/api-requests" />}
              >
                {en ? "API requests" : "API 请求"}
              </Button>
              <Button
                variant="outline"
                nativeButton={false}
                role="link"
                render={<a href="/showcase/evaluations" />}
              >
                {en ? "Evaluations" : "评测"}
              </Button>
            </div>
          </div>
          <details
            data-ap-integrations
            className={styles.associations}
            open={!!errors.missingIntegrations}
          >
            <summary>{en ? "Integration associations" : "集成关联"}</summary>
            <p className="text-xs text-muted-foreground">
              {en
                ? "Project-only associations; connection status is inherited from the organization. Changing this list never authorizes a provider."
                : "关联仅属于项目；连接状态来自组织。修改列表不代表提供商授权。"}
            </p>
            {errors.missingIntegrations && (
              <p
                data-ap-missing-integrations
                className="text-xs text-destructive"
              >
                {en
                  ? "Missing integration reference. Remove it to continue."
                  : "缺失集成引用，请先移除。"}
              </p>
            )}
            {account.integrations.map((item) => (
              <div
                key={item.integrationId}
                data-ap-integration-row={item.integrationId}
                className={styles.associationRow}
              >
                <Checkbox
                  id={"ap-integration-" + item.integrationId}
                  checked={draft.integrationIds.includes(item.integrationId)}
                  disabled={formLocked}
                  aria-label={
                    (en ? "Associate" : "关联") +
                    " " +
                    item.name[locale] +
                    " · " +
                    item.provider
                  }
                  onCheckedChange={(checked) =>
                    setState((current) => {
                      const base = draftFor(current, project)
                      return updateDraft(current, project, {
                        integrationIds: checked
                          ? [...base.integrationIds, item.integrationId]
                          : base.integrationIds.filter(
                              (id) => id !== item.integrationId,
                            ),
                      })
                    })
                  }
                />
                <Label
                  htmlFor={"ap-integration-" + item.integrationId}
                  className="flex-1"
                >
                  {item.name[locale]} · {item.provider}
                </Label>
                <Badge
                  tone={
                    item.status === "configuration-error" ? "danger" : "neutral"
                  }
                >
                  {item.status === "connected"
                    ? en
                      ? "Connected"
                      : "已连接"
                    : item.status === "not-connected"
                      ? en
                        ? "Not connected"
                        : "未连接"
                      : item.status === "configuration-error"
                        ? en
                          ? "Configuration error"
                          : "配置错误"
                        : en
                          ? "Disabled"
                          : "已禁用"}
                </Badge>
                {item.disabledReason && (
                  <span className="text-xs text-muted-foreground">
                    {item.disabledReason[locale]}
                  </span>
                )}
              </div>
            ))}
            {(errors.missingIntegrations ?? []).map((id) => (
              <div
                key={id}
                data-ap-missing-integration={id}
                className={styles.associationRow}
              >
                <Badge tone="danger">
                  {en ? "Missing integration" : "缺失集成引用"}
                </Badge>
                <code className="min-w-0 flex-1 break-all text-xs">{id}</code>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={formLocked}
                  onClick={() =>
                    setState((current) =>
                      updateDraft(current, project, {
                        integrationIds: draft.integrationIds.filter(
                          (item) => item !== id,
                        ),
                      }),
                    )
                  }
                >
                  {en ? "Remove" : "移除"}
                </Button>
              </div>
            ))}
            {!account.integrations.length &&
              !errors.missingIntegrations?.length && (
                <p>
                  {en ? "No integrations to associate." : "没有可关联的集成。"}
                </p>
              )}
          </details>
        </form>
      </div>
    )
  }

  function renderLimits(): ReactNode {
    if (!project) return null
    const draft = draftFor(state, project)
    const dirty = isLimitsDirty(project, draft)
    const errors = validateLimits(scenario, draft)
    const formLocked = locked || !projectGate.canWrite
    const model = effectiveModel(project, account.organization.defaultModelId)
    const modelMissing = !models.some((item) => item.modelId === model.modelId)
    const token = effectiveNumber(
      project.modelTokenLimit,
      account.organization.modelTokenLimit,
    )
    const budget = effectiveNumber(
      project.monthlyBudgetMicroUsd,
      account.organization.monthlyBudgetMicroUsd,
    )
    const effectiveLine = (
      key: "model" | "token" | "budget",
      content: ReactNode,
      kind: "project" | "organization" | "inherited-unknown",
      extra?: ReactNode,
    ) => (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">
          {en ? "Effective" : "生效值"} ·
        </span>
        <span data-ap-effective={key} data-kind={kind} className="font-medium">
          {content}
        </span>
        <Badge tone={kind === "project" ? "info" : "neutral"}>
          {kind === "project"
            ? en
              ? "Project override"
              : "项目覆盖"
            : kind === "organization"
              ? en
                ? "Inherited from organization"
                : "组织继承"
              : en
                ? "Inherited · unknown"
                : "继承自组织 · 未知"}
        </Badge>
        {extra}
      </div>
    )
    return (
      <div data-ap-section="model-limits" className="space-y-6">
        <div className={styles.sectionHeading}>
          <h2 className="text-base font-semibold">
            {en ? "Model limits" : "模型限额"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {en
              ? "Control which models this project can use and cap its request rate."
              : "控制本项目可用的模型和请求速率。"}
          </p>
          {gateNote(projectGate, "section")}
        </div>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault()
            submitLimits(draft)
          }}
        >
          <TableContainer className={styles.tableViewport}>
            <Table data-ap-rate-limits className={styles.rateTable}>
              <TableHeader>
                <TableRow>
                  <TableHead>{en ? "Model" : "模型"}</TableHead>
                  <TableHead>
                    {en ? "Requests / minute" : "请求 / 分钟"}
                  </TableHead>
                  <TableHead>
                    {en ? "Tokens / minute" : "Token / 分钟"}
                  </TableHead>
                  <TableHead>{en ? "Enabled" : "启用"}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {draft.modelLimits.map((row, index) => {
                  const rateModel = models.find(
                    (item) => item.modelId === row.modelId,
                  )
                  const setRate = (patch: Partial<typeof row>) =>
                    setState((current) => {
                      const base = draftFor(current, project)
                      return updateDraft(current, project, {
                        modelLimits: base.modelLimits.map((item, i) =>
                          i === index ? { ...item, ...patch } : item,
                        ),
                      })
                    })
                  return (
                    <TableRow key={row.modelId} data-ap-rate-row={row.modelId}>
                      <TableCell>
                        <code>{rateModel?.name ?? row.modelId}</code>
                        {!rateModel && (
                          <Badge tone="danger">
                            {en ? "Missing model" : "模型缺失"}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Field
                          label={
                            (rateModel?.name ?? row.modelId) +
                            (en ? " requests per minute" : " 每分钟请求数")
                          }
                          className={styles.rateField}
                          error={
                            !parseIntegerText(row.requestsText, 1_000_000).ok
                              ? en
                                ? "Enter an integer from 0 to 1,000,000."
                                : "请输入 0 到 1,000,000 的整数。"
                              : undefined
                          }
                        >
                          {(props) => (
                            <Input
                              {...props}
                              inputMode="numeric"
                              value={row.requestsText}
                              disabled={formLocked || !rateModel}
                              onChange={(event) =>
                                setRate({ requestsText: event.target.value })
                              }
                            />
                          )}
                        </Field>
                      </TableCell>
                      <TableCell>
                        <Field
                          label={
                            (rateModel?.name ?? row.modelId) +
                            (en ? " tokens per minute" : " 每分钟 Token 数")
                          }
                          className={styles.rateField}
                          error={
                            !parseIntegerText(row.tokensText, tokenLimitMax).ok
                              ? en
                                ? "Enter an integer from 0 to 100,000,000."
                                : "请输入 0 到 100,000,000 的整数。"
                              : undefined
                          }
                        >
                          {(props) => (
                            <Input
                              {...props}
                              inputMode="numeric"
                              value={row.tokensText}
                              disabled={formLocked || !rateModel}
                              onChange={(event) =>
                                setRate({ tokensText: event.target.value })
                              }
                            />
                          )}
                        </Field>
                      </TableCell>
                      <TableCell>
                        <Switch
                          aria-label={
                            (en ? "Enable " : "启用 ") +
                            (rateModel?.name ?? row.modelId)
                          }
                          checked={row.enabled}
                          disabled={formLocked || !rateModel}
                          onCheckedChange={(enabled) => setRate({ enabled })}
                        />
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </TableContainer>
          {!draft.modelLimits.length && (
            <p className="text-sm text-muted-foreground">
              {en
                ? "No model rate limits configured in this fixture."
                : "本 fixture 未配置模型速率限额。"}
            </p>
          )}
          <div className={styles.planningBudget}>
            <Field
              label={
                en ? "Monthly planning budget (USD)" : "月度规划预算（USD）"
              }
              description={
                en
                  ? "A demo planning threshold; it does not change provider billing."
                  : "演示规划阈值，不会改变提供商账单。"
              }
              error={
                errors.budget
                  ? en
                    ? "Enter a valid USD amount with at most six decimal places."
                    : "请输入合法美元金额，最多六位小数。"
                  : undefined
              }
            >
              {(props) => (
                <Input
                  {...props}
                  data-ap-planning-budget
                  inputMode="decimal"
                  placeholder={
                    budget.kind === "inherited-unknown"
                      ? en
                        ? "Unknown"
                        : "未知"
                      : undefined
                  }
                  value={
                    draft.budgetMode === "inherit"
                      ? budget.kind === "inherited-unknown"
                        ? ""
                        : formatUsdMicro(budget.value)
                      : draft.budgetUsdText
                  }
                  disabled={formLocked}
                  onChange={(event) => {
                    const raw = event.target.value,
                      amount = parseUsdMicro(raw)
                    setState((current) =>
                      updateDraft(current, project, {
                        budgetMode: "override",
                        budgetText: amount === null ? "" : String(amount),
                        budgetUsdText: raw,
                      }),
                    )
                  }}
                />
              )}
            </Field>
            <p className="text-xs text-muted-foreground">
              {draft.budgetMode === "inherit"
                ? en
                  ? "Inherited from organization"
                  : "继承自组织"
                : en
                  ? "Project override"
                  : "项目覆盖"}
            </p>
          </div>
          <details
            data-ap-inheritance
            className={styles.inheritance}
            open={scenario === "missing-data" || scenario === "empty"}
          >
            <summary>
              {en
                ? "Organization defaults & project overrides"
                : "组织默认值与项目覆盖"}
            </summary>

            <div
              data-ap-field="model"
              className="space-y-2 rounded-control border p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  {en ? "Default model" : "默认模型"}
                </span>
                {modeGroup(draft.modelMode, (next) =>
                  setState((current) =>
                    updateDraft(current, project, {
                      modelMode: next,
                      modelId:
                        next === "override"
                          ? draft.modelId || account.organization.defaultModelId
                          : draft.modelId,
                    }),
                  ),
                )}
              </div>
              {draft.modelMode === "override" &&
                (errors.model === "missing" || errors.model === "required" ? (
                  <div
                    data-ap-missing-model
                    className="flex flex-wrap items-center gap-2"
                  >
                    <Badge tone="danger">
                      {en ? "Missing model reference" : "缺失模型引用"}
                    </Badge>
                    <code className="break-all text-xs">{draft.modelId}</code>
                    <span className="text-xs text-muted-foreground">
                      {en
                        ? "Choose an available model or inherit the organization value."
                        : "请选择可用模型，或改回继承组织值。"}
                    </span>
                  </div>
                ) : (
                  <ApSelect
                    label={en ? "Default model" : "默认模型"}
                    value={draft.modelId}
                    disabled={formLocked}
                    options={models.map((item) => ({
                      value: item.modelId,
                      label: `${item.name} · ${item.provider}`,
                    }))}
                    onChange={(value) =>
                      setState((current) =>
                        updateDraft(current, project, { modelId: value }),
                      )
                    }
                  />
                ))}
              {effectiveLine(
                "model",
                model.modelId,
                model.source,
                modelMissing ? (
                  <Badge tone="danger">
                    {en ? "Reference missing" : "引用缺失"}
                  </Badge>
                ) : undefined,
              )}
            </div>
            <div
              data-ap-field="token"
              className="space-y-2 rounded-control border p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  {en ? "Model token limit" : "模型 Token 上限"}
                </span>
                {modeGroup(draft.tokenMode, (next) =>
                  setState((current) =>
                    updateDraft(current, project, { tokenMode: next }),
                  ),
                )}
              </div>
              {draft.tokenMode === "override" && (
                <Field
                  label={en ? "Token limit (integer)" : "Token 上限（整数）"}
                  error={
                    errors.token
                      ? errors.token === "empty"
                        ? en
                          ? "Enter a token limit."
                          : "请输入 Token 上限。"
                        : errors.token === "format"
                          ? en
                            ? "Use digits only; formatted text is never parsed."
                            : "只接受纯数字，不解析格式化文本。"
                          : en
                            ? `Between 0 and ${formatGrouped(tokenLimitMax)}.`
                            : `须在 0 到 ${formatGrouped(tokenLimitMax)} 之间。`
                      : undefined
                  }
                >
                  {(props) => (
                    <Input
                      {...props}
                      inputMode="numeric"
                      value={draft.tokenText}
                      disabled={formLocked}
                      data-ap-token-input
                      onChange={(event) =>
                        setState((current) =>
                          updateDraft(current, project, {
                            tokenText: event.target.value,
                          }),
                        )
                      }
                    />
                  )}
                </Field>
              )}
              {effectiveLine(
                "token",
                token.kind === "inherited-unknown"
                  ? en
                    ? "Unknown (organization value is unset)"
                    : "未知（组织未设置）"
                  : `${formatGrouped(token.value)} Token`,
                token.kind,
              )}
            </div>
            <div
              data-ap-field="budget"
              className="space-y-2 rounded-control border p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  {en ? "Monthly budget" : "月度预算"}
                </span>
                {modeGroup(draft.budgetMode, (next) =>
                  setState((current) =>
                    updateDraft(current, project, { budgetMode: next }),
                  ),
                )}
              </div>
              {draft.budgetMode === "override" && (
                <Field
                  label={
                    en
                      ? "Budget (micro-USD, integer)"
                      : "预算（micro-USD，整数）"
                  }
                  description={
                    en
                      ? "1 USD = 1,000,000 micro-USD; raw integer text is the only accepted input."
                      : "1 USD = 1,000,000 micro-USD；只接受原始整数文本。"
                  }
                  error={
                    errors.budget
                      ? errors.budget === "empty"
                        ? en
                          ? "Enter a budget."
                          : "请输入预算。"
                        : errors.budget === "format"
                          ? en
                            ? "Use digits only; formatted text is never parsed."
                            : "只接受纯数字，不解析格式化文本。"
                          : en
                            ? `Between 0 and ${formatGrouped(budgetMicroUsdMax)} micro-USD.`
                            : `须在 0 到 ${formatGrouped(budgetMicroUsdMax)} micro-USD 之间。`
                      : undefined
                  }
                >
                  {(props) => (
                    <Input
                      {...props}
                      inputMode="numeric"
                      value={draft.budgetText}
                      disabled={formLocked}
                      data-ap-budget-input
                      onChange={(event) =>
                        setState((current) =>
                          updateDraft(current, project, {
                            budgetText: event.target.value,
                            budgetUsdText: /^\d+$/.test(event.target.value)
                              ? formatUsdMicro(Number(event.target.value))
                              : "",
                          }),
                        )
                      }
                    />
                  )}
                </Field>
              )}
              {effectiveLine(
                "budget",
                budget.kind === "inherited-unknown"
                  ? en
                    ? "Unknown (organization value is unset)"
                    : "未知（组织未设置）"
                  : `${formatGrouped(budget.value)} micro-USD · USD ${(budget.value / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 6 })}`,
                budget.kind,
              )}
            </div>
          </details>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <p
              data-ap-dirty="model-limits"
              data-dirty={dirty}
              className="text-xs text-muted-foreground"
            >
              {dirty
                ? en
                  ? "Unsaved changes in Model limits."
                  : "模型限额有未保存的更改。"
                : en
                  ? "No pending changes in Model limits."
                  : "模型限额没有待保存的更改。"}
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                data-ap-discard="model-limits"
                disabled={!projectGate.canWrite || locked || !dirty}
                onClick={() => discard("model-limits")}
              >
                {en ? "Discard" : "取消"}
              </Button>
              <Button
                type="submit"
                data-ap-save="model-limits"
                disabled={
                  !projectGate.canWrite ||
                  locked ||
                  !dirty ||
                  hasErrors(errors, ["model", "token", "budget"]) ||
                  !validModelRates(draft)
                }
              >
                {en ? "Save limits" : "保存限额"}
              </Button>
            </div>
          </div>
        </form>
      </div>
    )
  }

  function renderMembers(): ReactNode {
    if (!project) return null
    const projectMembers = account.members.filter((member) =>
      member.projectIds.includes(project.projectId),
    )
    const active = projectMembers.filter(
      (member) => member.invitationState === "active",
    )
    const invited = projectMembers.filter(
      (member) => member.invitationState === "invited",
    )
    const search = state.memberSearch.trim().toLowerCase()
    const visible = active.filter(
      (member) =>
        (state.memberType === "all" ||
          (member.type ?? "user") === state.memberType) &&
        (!search ||
          (member.name + " " + member.email).toLowerCase().includes(search)),
    )
    const formLocked = locked || !membersGate.canWrite
    const roleOf = (member: ApAccountMember) =>
      account.roles.find((role) => role.roleId === member.roleId)
    return (
      <div data-ap-section="members" className="space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">
              {en ? "Members" : "成员"}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {en
                ? "People and service accounts with access to this project."
                : "可访问本项目的人员与服务账号。"}
            </p>
            {gateNote(membersGate, "section")}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={formLocked}
              onClick={() =>
                setState((current) => ({
                  ...current,
                  dialogs: { ...current.dialogs, createMember: "service" },
                  memberForm: { name: "", email: "", roleId: "role-developer" },
                }))
              }
            >
              <Plus aria-hidden="true" />
              {en ? "Service account" : "服务账号"}
            </Button>
            <Button
              disabled={formLocked}
              onClick={() =>
                setState((current) => ({
                  ...current,
                  dialogs: { ...current.dialogs, createMember: "invite" },
                  memberForm: { name: "", email: "", roleId: "role-developer" },
                }))
              }
            >
              <Plus aria-hidden="true" />
              {en ? "Invite member" : "邀请成员"}
            </Button>
          </div>
        </div>
        <div className={styles.memberFilters}>
          <ApSearch
            label={en ? "Search members" : "搜索成员"}
            value={state.memberSearch}
            onChange={(value) =>
              setState((current) => ({ ...current, memberSearch: value }))
            }
          />
          <ApSelect
            label={en ? "Member type" : "成员类型"}
            value={state.memberType}
            options={[
              { value: "all", label: en ? "All members" : "全部成员" },
              { value: "user", label: en ? "Users" : "用户" },
              {
                value: "service-account",
                label: en ? "Service accounts" : "服务账号",
              },
            ]}
            onChange={(value) =>
              setState((current) => ({
                ...current,
                memberType: value as "all" | "user" | "service-account",
              }))
            }
          />
        </div>
        <DataRegion
          state={visible.length ? "success" : "empty"}
          hasContent={visible.length > 0}
          emptyTitle={
            active.length
              ? en
                ? "No matching members"
                : "没有匹配的成员"
              : en
                ? "No members in this project"
                : "本项目没有成员"
          }
          emptyDescription={
            active.length
              ? en
                ? "Adjust the search to find a member."
                : "请调整搜索词查找成员。"
              : en
                ? "This scene has no project members. Switch scenarios to explore access."
                : "本场景没有项目成员，请切换场景查看。"
          }
        >
          <TableContainer className={styles.tableViewport}>
            <Table data-ap-members-table>
              <TableHeader>
                <TableRow>
                  <TableHead>{en ? "Member" : "成员"}</TableHead>
                  <TableHead>{en ? "Type" : "类型"}</TableHead>
                  <TableHead>{en ? "Role" : "角色"}</TableHead>
                  <TableHead>{en ? "Actions" : "操作"}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((member) => {
                  const role = roleOf(member)
                  const selected = state.selectedMemberId === member.memberId
                  const owner = isProtectedProjectOwner(
                    account,
                    member.memberId,
                  )
                  return (
                    <TableRow
                      key={member.memberId}
                      data-ap-member-row={member.memberId}
                      data-selected={selected}
                      tabIndex={0}
                      className="cursor-pointer"
                      onClick={(event) => {
                        if ((event.target as HTMLElement).closest("button"))
                          return
                        setState((current) => ({
                          ...current,
                          selectedMemberId: selected ? null : member.memberId,
                        }))
                      }}
                      onKeyDown={(event) => {
                        if (
                          event.target !== event.currentTarget ||
                          event.key !== "Enter" ||
                          formLocked ||
                          owner
                        )
                          return
                        event.preventDefault()
                        setState((current) => ({
                          ...current,
                          selectedMemberId: member.memberId,
                          dialogs: {
                            ...current.dialogs,
                            editMemberId: member.memberId,
                          },
                        }))
                      }}
                    >
                      <TableCell>
                        <div className={styles.memberIdentity}>
                          {member.type === "service-account" ? (
                            <Bot aria-hidden="true" />
                          ) : (
                            <UserRound aria-hidden="true" />
                          )}
                          <div className="min-w-0">
                            <p className="font-medium">
                              {member.name}
                              {member.memberId === account.profile.memberId
                                ? en
                                  ? " (you)"
                                  : "（你）"
                                : ""}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {member.email}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {member.type === "service-account"
                          ? en
                            ? "Service account"
                            : "服务账号"
                          : en
                            ? "User"
                            : "用户"}
                      </TableCell>
                      <TableCell>
                        {role ? (
                          <Badge tone="neutral">{role.name[locale]}</Badge>
                        ) : (
                          <span data-ap-missing-role={member.memberId}>
                            <Badge tone="danger">
                              {en ? "Missing role reference" : "缺失角色引用"}
                            </Badge>
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={formLocked || owner}
                            title={
                              owner
                                ? en
                                  ? "The workspace owner always retains access."
                                  : "工作区所有者始终保留访问权限。"
                                : undefined
                            }
                            onClick={() =>
                              setState((current) => ({
                                ...current,
                                dialogs: {
                                  ...current.dialogs,
                                  editMemberId: member.memberId,
                                },
                              }))
                            }
                          >
                            {en ? "Edit role" : "编辑角色"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={formLocked || owner}
                            title={
                              owner
                                ? en
                                  ? "The workspace owner always retains access."
                                  : "工作区所有者始终保留访问权限。"
                                : undefined
                            }
                            onClick={() =>
                              setState((current) =>
                                beginSave(
                                  current,
                                  "members",
                                  {
                                    kind: "member-remove",
                                    memberId: member.memberId,
                                    projectId: project.projectId,
                                  },
                                  membersGate,
                                ),
                              )
                            }
                          >
                            {en ? "Remove" : "移出项目"}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
              <TableCaption data-ap-member-count>
                {en
                  ? `${active.length} members · ${invited.length} pending invitations. The workspace owner always retains access.`
                  : `${active.length} 名成员 · ${invited.length} 份待处理邀请。工作区所有者始终保留访问权限。`}
              </TableCaption>
            </Table>
          </TableContainer>
        </DataRegion>
        <div className={styles.pendingInvitations}>
          <h3 className="text-sm font-medium">
            {en ? "Pending invitations" : "待处理邀请"}
          </h3>
          {!invited.length && (
            <p className="text-sm text-muted-foreground">
              {en
                ? "No pending invitations in this scene."
                : "本场景没有待处理邀请。"}
            </p>
          )}
          {invited.map((member) => (
            <div
              key={member.memberId}
              data-ap-invited-row={member.memberId}
              className="flex flex-wrap items-center gap-3 py-2"
            >
              <span className="min-w-0 flex-1 text-sm">
                {member.email}
                <span className="ml-2 text-xs text-muted-foreground">
                  {roleOf(member)?.name[locale] ??
                    (en ? "Missing role reference" : "缺失角色引用")}
                </span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={formLocked}
                onClick={() =>
                  setState((current) =>
                    beginSave(
                      current,
                      "members",
                      { kind: "invitation-cancel", memberId: member.memberId },
                      membersGate,
                    ),
                  )
                }
              >
                {en ? "Cancel invitation" : "取消邀请"}
              </Button>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            {en
              ? "Invitations are organization-level records: cancelling removes every project invitation for that member. Local fixture only; no invitation email is ever sent."
              : "邀请为组织级记录：取消会移除该成员的全部项目邀请；仅本地 fixture，不会发送任何邀请邮件。"}
          </p>
        </div>
      </div>
    )
  }

  function renderGroups(): ReactNode {
    if (!project) return null
    const projectMembers = account.members.filter((member) =>
      member.projectIds.includes(project.projectId),
    )
    const formLocked = locked || !membersGate.canWrite
    return (
      <div data-ap-section="groups" className="space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">
              {en ? "Groups" : "用户组"}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {en
                ? "Shared membership buckets for this organization's project access."
                : "组织内共享的成员分组，用于聚合项目访问。"}
            </p>
            {gateNote(membersGate, "section")}
          </div>
          <Button
            variant="primary"
            disabled={formLocked}
            onClick={() =>
              setState((current) => ({
                ...current,
                groupCreateName: "",
                groupDescription: "",
                groupRoleId: "role-developer",
                groupMemberIds: [],
                dialogs: { ...current.dialogs, createGroup: true },
              }))
            }
          >
            <Plus aria-hidden="true" />
            {en ? "Create group" : "创建用户组"}
          </Button>
        </div>
        {!account.groups.length && (
          <p className="text-sm text-muted-foreground">
            {en
              ? "This scene has no groups. Switch scenarios to explore grouping."
              : "本场景没有用户组，请切换场景查看分组。"}
          </p>
        )}
        <div className={styles.groupList}>
          {account.groups.map((group) => {
            const count = projectMembers.filter((member) =>
              member.groupIds.includes(group.groupId),
            ).length
            return (
              <div
                key={group.groupId}
                data-ap-group={group.groupId}
                className={styles.groupRow}
              >
                <UsersRound aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-medium">{group.name}</h3>
                  <p className="text-xs text-muted-foreground">
                    {group.description ??
                      (en ? "Shared organization group" : "组织共享用户组")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {en ? `${count} members` : `${count} 名成员`}
                    {" · "}
                    {account.roles.find((role) => role.roleId === group.roleId)
                      ?.name[locale] ?? (en ? "Role not set" : "角色未设置")}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={formLocked}
                    onClick={() =>
                      setState((current) => ({
                        ...current,
                        groupDescription: group.description ?? "",
                        groupRoleId: group.roleId ?? "role-developer",
                        groupMemberIds: projectMembers
                          .filter((member) =>
                            member.groupIds.includes(group.groupId),
                          )
                          .map((member) => member.memberId),
                        dialogs: {
                          ...current.dialogs,
                          manageGroupId: group.groupId,
                        },
                      }))
                    }
                  >
                    {en ? "Manage" : "管理"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={formLocked}
                    onClick={() =>
                      setState((current) =>
                        beginSave(
                          current,
                          "groups",
                          { kind: "group-delete", groupId: group.groupId },
                          membersGate,
                        ),
                      )
                    }
                  >
                    <Trash2 aria-hidden="true" />
                    {en ? "Delete" : "删除"}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  function renderRoles(): ReactNode {
    const rows = capabilityRows(account.roles.map((role) => role.capabilities))
    const formLocked = locked || !membersGate.canWrite
    return (
      <div data-ap-section="roles" className="space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">
              {en ? "Roles & permissions" : "角色与权限"}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {en
                ? "Review the permission matrix or define a custom role."
                : "查看权限矩阵，或创建自定义角色。"}
            </p>
            {gateNote(membersGate, "section")}
          </div>
          <Button
            variant="primary"
            disabled={formLocked}
            onClick={() =>
              setState((current) => ({
                ...current,
                roleForm: { name: "", capabilities: [] },
                dialogs: { ...current.dialogs, createRole: true },
              }))
            }
          >
            <Plus aria-hidden="true" />
            {en ? "Create role" : "创建角色"}
          </Button>
        </div>
        <TableContainer className={styles.tableViewport}>
          <Table data-ap-roles-table>
            <TableHeader>
              <TableRow>
                <TableHead>{en ? "Permission" : "权限"}</TableHead>
                {account.roles.map((role) => (
                  <TableHead key={role.roleId} data-ap-role={role.roleId}>
                    {role.name[locale]}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((capability) => (
                <TableRow key={capability}>
                  <TableCell>
                    {accountCapabilityCopy[capability]?.[locale] ?? capability}
                  </TableCell>
                  {account.roles.map((role) => {
                    const allowed = role.capabilities.includes(capability)
                    return (
                      <TableCell
                        key={role.roleId}
                        data-ap-matrix-cell=""
                        data-role={role.roleId}
                        data-capability={capability}
                        data-allowed={allowed}
                      >
                        {allowed ? (
                          <Check
                            aria-label={en ? "Allowed" : "允许"}
                            className="size-4 text-success"
                          />
                        ) : (
                          <span aria-label={en ? "Not allowed" : "不允许"}>
                            —
                          </span>
                        )}
                      </TableCell>
                    )
                  })}
                </TableRow>
              ))}
              <TableRow>
                <TableCell>{en ? "Manage role" : "管理角色"}</TableCell>
                {account.roles.map((role) => (
                  <TableCell key={role.roleId}>
                    {isBuiltInRole(role.roleId) ? (
                      <Badge tone="neutral">{en ? "Built in" : "内置"}</Badge>
                    ) : (
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={formLocked}
                          onClick={() =>
                            setState((current) => ({
                              ...current,
                              roleForm: {
                                name: role.name[locale],
                                capabilities: [...role.capabilities],
                              },
                              dialogs: {
                                ...current.dialogs,
                                editRoleId: role.roleId,
                              },
                            }))
                          }
                        >
                          {en ? "Edit" : "编辑"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={
                            formLocked ||
                            !canDeleteProjectRole(account, role.roleId)
                          }
                          title={
                            !canDeleteProjectRole(account, role.roleId)
                              ? en
                                ? "Remove member and group assignments before deleting this role."
                                : "请先移除成员和用户组的角色分配。"
                              : undefined
                          }
                          onClick={() =>
                            setState((current) =>
                              beginSave(
                                current,
                                "roles",
                                { kind: "role-delete", roleId: role.roleId },
                                membersGate,
                              ),
                            )
                          }
                        >
                          {en ? "Delete" : "删除"}
                        </Button>
                      </div>
                    )}
                  </TableCell>
                ))}
              </TableRow>
            </TableBody>
            <TableCaption>
              {en
                ? "Built-in roles cannot be edited. Remove role assignments before deleting a custom role."
                : "内置角色不可编辑；删除自定义角色前需先移除角色分配。"}
            </TableCaption>
          </Table>
        </TableContainer>
      </div>
    )
  }

  const refreshError = state.refresh === "error"
  const chooserOptions = account.projects.map((item) => ({
    value: item.projectId,
    label: item.name,
  }))
  const sectionBody: Record<ProjectSectionId, ReactNode> = {
    general: renderGeneral(),
    "model-limits": renderLimits(),
    members: renderMembers(),
    groups: renderGroups(),
    roles: renderRoles(),
  }
  if (!project)
    return (
      <ApPage
        pageId="project-settings"
        title={en ? "Project settings" : "项目设置"}
        description={
          en ? "No project exists in this scene." : "本场景没有可用项目。"
        }
      >
        <p className="text-sm text-muted-foreground">
          {en
            ? "Switch scenarios to configure a project."
            : "请切换场景以配置项目。"}
        </p>
      </ApPage>
    )
  return (
    <ApPage
      pageId="project-settings"
      title={en ? "Project settings" : "项目设置"}
      description={`${project.name} · ${
        en
          ? "Configure resources and access for this project."
          : "配置本项目的资源与访问。"
      }`}
      variant="reference"
      actions={
        <Button
          variant="outline"
          nativeButton={false}
          role="link"
          render={<a href="/showcase/organization-settings" />}
        >
          {en ? "Organization" : "组织"}
          <ExternalLink aria-hidden="true" />
        </Button>
      }
    >
      <div ref={content} className={styles.content}>
        {gateNote(projectGate, "toolbar")}
        {renderReceipt(null, "page")}
        {loading && (
          <Button
            variant="secondary"
            data-ap-complete-load
            onClick={() => setState((current) => completeLoad(current))}
          >
            {en ? "Complete simulated load" : "完成模拟加载"}
          </Button>
        )}
        {state.notice === "refreshed" && (
          <p
            role="status"
            data-ap-refresh-notice
            className="text-sm text-muted-foreground"
          >
            {en
              ? `Re-read local account fixture as of ${apAsOf}`
              : `已按本地账户 fixture 重新读取 · asOf ${apAsOf}`}
          </p>
        )}
        <DataRegion
          state={
            loading
              ? "loading"
              : refreshError
                ? "error"
                : scenario === "missing-data"
                  ? "partial"
                  : "success"
          }
          hasContent={!loading}
          refreshing={state.refresh === "pending"}
          updatedAt={refreshError ? apAsOf : undefined}
          error={{
            category: "network",
            message: en ? "The account refresh failed." : "账户数据刷新失败。",
            reason: en
              ? "Existing project configuration is retained."
              : "已保留现有项目配置。",
          }}
          onRetry={
            refreshError
              ? () => setState((current) => beginRefresh(current, "retry"))
              : undefined
          }
          partialDescription={
            en
              ? "Some organization values are unknown; unknown is not zero."
              : "部分组织值未知；未知不代表零。"
          }
        >
          {!loading && (
            <Tabs
              value={state.activeSection}
              onValueChange={(value) => {
                if (!projectSectionIds.some((item) => item === value)) return
                const section = value as ProjectSectionId
                setState((current) => setSection(current, section))
              }}
              orientation="vertical"
            >
              <div className={styles.settingsGrid}>
                <TabsList
                  aria-label={en ? "Settings sections" : "设置分区"}
                  className={styles.sectionRail}
                >
                  {projectSectionIds.map((section) => (
                    <TabsTab
                      key={section}
                      value={section}
                      data-ap-section-tab={section}
                      className={styles.sectionTab}
                    >
                      {sectionLabel(section)}
                    </TabsTab>
                  ))}
                </TabsList>
                <div className="min-w-0">
                  {projectSectionIds.map((section) => (
                    <TabsPanel key={section} value={section} className="pt-0">
                      {sectionBody[section]}
                    </TabsPanel>
                  ))}
                </div>
              </div>
            </Tabs>
          )}
        </DataRegion>
        <details className={styles.scopeTools} data-ap-toolbar>
          <summary>
            {en ? "Project scope & fixture controls" : "项目范围与演示控件"}
          </summary>
          <div className="flex flex-wrap items-center gap-3">
            <ApSelect
              label={en ? "Project" : "选择项目"}
              value={project.projectId}
              options={chooserOptions}
              disabled={locked}
              onChange={(value) =>
                setState((current) => selectProject(current, value, account))
              }
            />
            <span className="text-xs text-muted-foreground" data-ap-scope>
              {account.organization.orgId} · UTC
            </span>
            <Button
              variant="outline"
              data-ap-refresh
              disabled={locked || state.refresh === "pending"}
              onClick={() =>
                setState((current) => beginRefresh(current, "refresh"))
              }
            >
              <RefreshCw aria-hidden="true" />
              {en ? "Refresh" : "刷新"}
            </Button>
          </div>
        </details>
      </div>
      {renderDialogs()}
    </ApPage>
  )

  function renderDialogs(): ReactNode {
    const editMember = account.members.find(
      (member) => member.memberId === state.dialogs.editMemberId,
    )
    const manageGroup = account.groups.find(
      (group) => group.groupId === state.dialogs.manageGroupId,
    )
    const editRole = account.roles.find(
      (role) => role.roleId === state.dialogs.editRoleId,
    )
    const roleOptions = account.roles.map((role) => ({
      value: role.roleId,
      label: role.name[locale],
    }))
    const closeBlocked = dialogCloseBlocked(state)
    const memberDraftRoleId = editMember
      ? (state.memberRoles[editMember.memberId] ?? editMember.roleId)
      : ""
    const memberRoleMissing =
      !!editMember &&
      !account.roles.some((role) => role.roleId === memberDraftRoleId)
    /** Cancel and dismiss discard the pending role draft, restoring the confirmed role. */
    const cancelEditMember = () =>
      setState((current) => ({
        ...current,
        memberRoles: state.dialogs.editMemberId
          ? Object.fromEntries(
              Object.entries(current.memberRoles).filter(
                ([key]) => key !== state.dialogs.editMemberId,
              ),
            )
          : current.memberRoles,
        dialogs: { ...current.dialogs, editMemberId: null },
        save: current.save.section === "members" ? idleSave : current.save,
      }))
    const groupMetadata = (includeMembers: boolean) => (
      <>
        <Field label={en ? "Role" : "角色"}>
          {() => (
            <ApSelect
              label={en ? "Group access role" : "用户组访问角色"}
              value={state.groupRoleId}
              options={roleOptions}
              disabled={locked || !membersGate.canWrite}
              onChange={(groupRoleId) =>
                setState((current) => ({ ...current, groupRoleId }))
              }
            />
          )}
        </Field>
        <Field label={en ? "Description" : "描述"}>
          {(props) => (
            <Textarea
              {...props}
              rows={2}
              maxLength={400}
              disabled={locked || !membersGate.canWrite}
              value={state.groupDescription}
              onChange={(event) =>
                setState((current) => ({
                  ...current,
                  groupDescription: event.target.value,
                }))
              }
            />
          )}
        </Field>
        {includeMembers && (
          <fieldset
            className="space-y-2"
            disabled={locked || !membersGate.canWrite}
          >
            <legend className="text-sm font-medium">
              {en ? "Group members" : "用户组成员"}
            </legend>
            <p className="text-sm text-muted-foreground">
              {en
                ? "Choose people or service accounts already in this project."
                : "选择已加入本项目的人员或服务账号。"}
            </p>
            {account.members
              .filter(
                (member) =>
                  member.projectIds.includes(project?.projectId ?? "") &&
                  member.invitationState === "active",
              )
              .map((member) => (
                <div key={member.memberId} className="flex items-center gap-3">
                  <Checkbox
                    id={"ap-create-group-" + member.memberId}
                    checked={state.groupMemberIds.includes(member.memberId)}
                    onCheckedChange={(checked) =>
                      setState((current) => ({
                        ...current,
                        groupMemberIds: checked
                          ? [...current.groupMemberIds, member.memberId]
                          : current.groupMemberIds.filter(
                              (id) => id !== member.memberId,
                            ),
                      }))
                    }
                  />
                  <Label htmlFor={"ap-create-group-" + member.memberId}>
                    {member.name}
                  </Label>
                </div>
              ))}
          </fieldset>
        )}
      </>
    )
    const memberFormValid =
      account.roles.some((role) => role.roleId === state.memberForm.roleId) &&
      (state.dialogs.createMember === "invite"
        ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.memberForm.email.trim())
        : !!state.memberForm.name.trim())

    return (
      <>
        <Dialog
          open={state.dialogs.createMember !== null}
          onOpenChange={(open) => {
            if (!open && !closeBlocked)
              setState((current) => ({
                ...current,
                dialogs: { ...current.dialogs, createMember: null },
                save:
                  current.save.section === "members" ? idleSave : current.save,
              }))
          }}
        >
          <DialogContent
            className={styles.dialog}
            data-ap-dialog="member-create"
          >
            <DialogTitle>
              {state.dialogs.createMember === "invite"
                ? en
                  ? "Invite member"
                  : "邀请成员"
                : en
                  ? "Create service account"
                  : "创建服务账号"}
            </DialogTitle>
            <DialogDescription>
              {state.dialogs.createMember === "invite"
                ? en
                  ? "This showcase records the invitation locally; no email is sent."
                  : "本展示仅记录本地邀请，不发送邮件。"
                : en
                  ? "Update access within this local project fixture; no secret is generated."
                  : "更新本地项目 fixture 的访问权限，不生成密钥。"}
            </DialogDescription>
            <form
              className="space-y-6"
              onSubmit={(event) => {
                event.preventDefault()
                if (!project || !memberFormValid) return
                setState((current) => {
                  const count = current.memberCreateCount + 1
                  return beginSave(
                    { ...current, memberCreateCount: count },
                    "members",
                    {
                      kind: "member-create",
                      memberId: "member-local-" + count,
                      name:
                        current.dialogs.createMember === "invite"
                          ? current.memberForm.email.trim()
                          : current.memberForm.name.trim(),
                      email:
                        current.dialogs.createMember === "invite"
                          ? current.memberForm.email.trim()
                          : "svc_local_" + count,
                      roleId: current.memberForm.roleId,
                      projectId: project.projectId,
                      memberKind:
                        current.dialogs.createMember === "invite"
                          ? "user"
                          : "service-account",
                    },
                    membersGate,
                  )
                })
              }}
            >
              {state.dialogs.createMember === "invite" ? (
                <Field label={en ? "Email address" : "电子邮箱"} required>
                  {(props) => (
                    <Input
                      {...props}
                      type="email"
                      placeholder="teammate@example.invalid"
                      value={state.memberForm.email}
                      disabled={locked || !membersGate.canWrite}
                      onChange={(event) =>
                        setState((current) => ({
                          ...current,
                          memberForm: {
                            ...current.memberForm,
                            email: event.target.value,
                          },
                        }))
                      }
                    />
                  )}
                </Field>
              ) : (
                <Field label={en ? "Name" : "名称"} required>
                  {(props) => (
                    <Input
                      {...props}
                      maxLength={120}
                      value={state.memberForm.name}
                      disabled={locked || !membersGate.canWrite}
                      onChange={(event) =>
                        setState((current) => ({
                          ...current,
                          memberForm: {
                            ...current.memberForm,
                            name: event.target.value,
                          },
                        }))
                      }
                    />
                  )}
                </Field>
              )}
              <Field label={en ? "Role" : "角色"}>
                {() => (
                  <ApSelect
                    label={en ? "Access role" : "访问角色"}
                    value={state.memberForm.roleId}
                    options={roleOptions}
                    disabled={locked || !membersGate.canWrite}
                    onChange={(roleId) =>
                      setState((current) => ({
                        ...current,
                        memberForm: { ...current.memberForm, roleId },
                      }))
                    }
                  />
                )}
              </Field>
              <DialogFooter>
                {renderReceipt("members", "dialog-member-create")}
                <Button
                  type="button"
                  variant="outline"
                  disabled={closeBlocked}
                  onClick={() =>
                    setState((current) => ({
                      ...current,
                      dialogs: { ...current.dialogs, createMember: null },
                    }))
                  }
                >
                  {en ? "Cancel" : "取消"}
                </Button>
                <Button
                  type="submit"
                  disabled={locked || !membersGate.canWrite || !memberFormValid}
                >
                  {state.dialogs.createMember === "invite"
                    ? en
                      ? "Add demo invitation"
                      : "添加演示邀请"
                    : en
                      ? "Save"
                      : "保存"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <Dialog
          open={!!editMember}
          onOpenChange={(open) => {
            if (open || closeBlocked) return
            cancelEditMember()
          }}
        >
          <DialogContent className={styles.dialog} data-ap-dialog="member-role">
            <DialogTitle>
              {editMember
                ? en
                  ? `Edit ${editMember.name}`
                  : `编辑 ${editMember.name}`
                : ""}
            </DialogTitle>
            <DialogDescription>
              {en
                ? "Role assignment is an organization-level record; saving updates the shared account fixture."
                : "角色分配为组织级记录；保存会更新共享账户 fixture。"}
            </DialogDescription>
            {editMember && (
              <div className="space-y-4">
                <ApSelect
                  label={en ? "Access role" : "访问角色"}
                  value={
                    roleOptions.some(
                      (option) => option.value === memberDraftRoleId,
                    )
                      ? memberDraftRoleId
                      : ""
                  }
                  options={roleOptions}
                  disabled={locked || !membersGate.canWrite}
                  onChange={(value) =>
                    setState((current) => ({
                      ...current,
                      memberRoles: {
                        ...current.memberRoles,
                        [editMember.memberId]: value,
                      },
                    }))
                  }
                />
                {memberRoleMissing && (
                  <p data-ap-role-error className="text-xs text-destructive">
                    {en
                      ? `Missing role reference: ${memberDraftRoleId}`
                      : `缺失角色引用：${memberDraftRoleId}`}
                  </p>
                )}
              </div>
            )}
            <DialogFooter className="px-1 pb-1">
              {renderReceipt("members", "dialog-member-role")}
              <Button
                variant="outline"
                disabled={closeBlocked}
                onClick={cancelEditMember}
              >
                {en ? "Cancel" : "取消"}
              </Button>
              <Button
                disabled={
                  !membersGate.canWrite ||
                  locked ||
                  !editMember ||
                  memberRoleMissing ||
                  memberDraftRoleId === editMember.roleId
                }
                onClick={() => {
                  if (!editMember) return
                  setState((current) =>
                    beginSave(
                      current,
                      "members",
                      {
                        kind: "member-role",
                        memberId: editMember.memberId,
                        roleId: memberDraftRoleId,
                      },
                      membersGate,
                    ),
                  )
                }}
              >
                {en ? "Save" : "保存"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog
          open={state.dialogs.createGroup}
          onOpenChange={(open) => {
            if (open || closeBlocked) return
            setState((current) => ({
              ...current,
              dialogs: { ...current.dialogs, createGroup: false },
              save: current.save.section === "groups" ? idleSave : current.save,
            }))
          }}
        >
          <DialogContent
            className={styles.dialog}
            data-ap-dialog="group-create"
          >
            <DialogTitle>{en ? "Create group" : "创建用户组"}</DialogTitle>
            <DialogDescription>
              {en
                ? "Adds an organization-level group record to the shared account fixture."
                : "向共享账户 fixture 添加组织级用户组记录。"}
            </DialogDescription>
            <Field label={en ? "Group name" : "用户组名称"} required>
              {(props) => (
                <Input
                  {...props}
                  value={state.groupCreateName}
                  disabled={locked || !membersGate.canWrite}
                  data-ap-group-name-input
                  onChange={(event) =>
                    setState((current) => ({
                      ...current,
                      groupCreateName: event.target.value,
                    }))
                  }
                />
              )}
            </Field>
            {groupMetadata(true)}
            <DialogFooter className="px-1 pb-1">
              {renderReceipt("groups", "dialog-group-create")}
              <Button
                variant="outline"
                disabled={closeBlocked}
                onClick={() =>
                  setState((current) => ({
                    ...current,
                    dialogs: { ...current.dialogs, createGroup: false },
                    save:
                      current.save.section === "groups"
                        ? idleSave
                        : current.save,
                  }))
                }
              >
                {en ? "Cancel" : "取消"}
              </Button>
              <Button
                disabled={
                  !membersGate.canWrite ||
                  locked ||
                  !state.groupCreateName.trim()
                }
                onClick={() =>
                  setState((current) => {
                    const count = current.groupCreateCount + 1
                    return beginSave(
                      {
                        ...current,
                        groupCreateCount: count,
                      },
                      "groups",
                      {
                        kind: "group-create",
                        groupId: `group-local-${count}`,
                        name: current.groupCreateName.trim(),
                        description: current.groupDescription.trim(),
                        roleId: current.groupRoleId,
                        memberIds: [...current.groupMemberIds],
                      },
                      membersGate,
                    )
                  })
                }
              >
                {en ? "Create" : "创建"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog
          open={!!manageGroup}
          onOpenChange={(open) => {
            if (open || closeBlocked) return
            setState((current) => ({
              ...current,
              dialogs: { ...current.dialogs, manageGroupId: null },
              save: current.save.section === "groups" ? idleSave : current.save,
            }))
          }}
        >
          <DialogContent
            className={styles.dialog}
            data-ap-dialog="group-members"
          >
            <DialogTitle>
              {manageGroup
                ? en
                  ? `Manage ${manageGroup.name}`
                  : `管理 ${manageGroup.name}`
                : ""}
            </DialogTitle>
            <DialogDescription>
              {en
                ? "Group membership is an organization-level field; the list below shows this project's members for convenience."
                : "用户组成员为组织级字段；下方仅列出本项目成员以便调整。"}
            </DialogDescription>
            {groupMetadata(false)}
            <div className="space-y-2">
              {!project && <p>{en ? "No project" : "没有项目"}</p>}
              {project &&
                account.members
                  .filter((member) =>
                    member.projectIds.includes(project.projectId),
                  )
                  .map((member) => {
                    const inside = state.groupMemberIds.includes(
                      member.memberId,
                    )
                    return (
                      <div
                        key={member.memberId}
                        className="flex items-center gap-3"
                      >
                        <Checkbox
                          id={`ap-group-member-${member.memberId}`}
                          checked={inside}
                          disabled={locked || !membersGate.canWrite}
                          onCheckedChange={(checked) =>
                            setState((current) => ({
                              ...current,
                              groupMemberIds: checked
                                ? [...current.groupMemberIds, member.memberId]
                                : current.groupMemberIds.filter(
                                    (id) => id !== member.memberId,
                                  ),
                            }))
                          }
                        />
                        <Label htmlFor={`ap-group-member-${member.memberId}`}>
                          {member.name} · {member.email}
                        </Label>
                      </div>
                    )
                  })}
            </div>
            <DialogFooter className="px-1 pb-1">
              {renderReceipt("groups", "dialog-group-members")}
              <Button
                variant="outline"
                disabled={closeBlocked}
                onClick={() =>
                  setState((current) => ({
                    ...current,
                    dialogs: { ...current.dialogs, manageGroupId: null },
                    save:
                      current.save.section === "groups"
                        ? idleSave
                        : current.save,
                  }))
                }
              >
                {en ? "Cancel" : "取消"}
              </Button>
              <Button
                disabled={!membersGate.canWrite || locked || !manageGroup}
                onClick={() => {
                  if (!manageGroup) return
                  setState((current) =>
                    beginSave(
                      current,
                      "groups",
                      {
                        kind: "group-members",
                        groupId: manageGroup.groupId,
                        projectId: project!.projectId,
                        description: current.groupDescription.trim(),
                        roleId: current.groupRoleId,
                        memberIds: [...current.groupMemberIds],
                      },
                      membersGate,
                    ),
                  )
                }}
              >
                {en ? "Save" : "保存"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog
          open={state.dialogs.createRole || state.dialogs.editRoleId !== null}
          onOpenChange={(open) => {
            if (open || closeBlocked) return
            setState((current) => ({
              ...current,
              dialogs: {
                ...current.dialogs,
                createRole: false,
                editRoleId: null,
              },
              save: current.save.section === "roles" ? idleSave : current.save,
            }))
          }}
        >
          <DialogContent className={styles.dialog} data-ap-dialog="role-form">
            <DialogTitle>
              {state.dialogs.createRole
                ? en
                  ? "Create role"
                  : "创建角色"
                : en
                  ? `Edit ${editRole?.name[locale] ?? ""}`
                  : `编辑 ${editRole?.name[locale] ?? ""}`}
            </DialogTitle>
            <DialogDescription>
              {en
                ? "Custom role capabilities apply organization-wide."
                : "自定义角色能力在组织范围内生效。"}
            </DialogDescription>
            <div className="space-y-4">
              <Field label={en ? "Role name" : "角色名称"} required>
                {(props) => (
                  <Input
                    {...props}
                    value={state.roleForm.name}
                    disabled={locked || !membersGate.canWrite}
                    data-ap-role-name-input
                    onChange={(event) =>
                      setState((current) => ({
                        ...current,
                        roleForm: {
                          ...current.roleForm,
                          name: event.target.value,
                        },
                      }))
                    }
                  />
                )}
              </Field>
              <fieldset
                className="space-y-2"
                disabled={locked || !membersGate.canWrite}
              >
                <legend className="text-[13px] font-medium">
                  {en ? "Permissions" : "权限"}
                </legend>
                {accountCapabilityOrder.map((capability) => (
                  <div key={capability} className="flex items-center gap-3">
                    <Checkbox
                      id={`ap-role-cap-${capability}`}
                      checked={state.roleForm.capabilities.includes(capability)}
                      onCheckedChange={(checked) =>
                        setState((current) => ({
                          ...current,
                          roleForm: {
                            ...current.roleForm,
                            capabilities: checked
                              ? [...current.roleForm.capabilities, capability]
                              : current.roleForm.capabilities.filter(
                                  (item) => item !== capability,
                                ),
                          },
                        }))
                      }
                    />
                    <Label htmlFor={`ap-role-cap-${capability}`}>
                      {accountCapabilityCopy[capability]?.[locale] ??
                        capability}
                    </Label>
                  </div>
                ))}
              </fieldset>
            </div>
            <DialogFooter className="px-1 pb-1">
              {renderReceipt("roles", "dialog-role-form")}
              <Button
                variant="outline"
                disabled={closeBlocked}
                onClick={() =>
                  setState((current) => ({
                    ...current,
                    dialogs: {
                      ...current.dialogs,
                      createRole: false,
                      editRoleId: null,
                    },
                    save:
                      current.save.section === "roles"
                        ? idleSave
                        : current.save,
                  }))
                }
              >
                {en ? "Cancel" : "取消"}
              </Button>
              <Button
                disabled={
                  !membersGate.canWrite || locked || !state.roleForm.name.trim()
                }
                onClick={() =>
                  setState((current) => {
                    const name = current.roleForm.name.trim()
                    const capabilities = [...current.roleForm.capabilities]
                    if (current.dialogs.editRoleId)
                      return beginSave(
                        current,
                        "roles",
                        {
                          kind: "role-edit",
                          roleId: current.dialogs.editRoleId,
                          name,
                          capabilities,
                        },
                        membersGate,
                      )
                    const count = current.roleCreateCount + 1
                    return beginSave(
                      { ...current, roleCreateCount: count },
                      "roles",
                      {
                        kind: "role-create",
                        roleId: `role-local-${count}`,
                        name,
                        capabilities,
                      },
                      membersGate,
                    )
                  })
                }
              >
                {state.dialogs.createRole
                  ? en
                    ? "Create"
                    : "创建"
                  : en
                    ? "Save"
                    : "保存"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    )
  }
}
