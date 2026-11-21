import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react"
import { Link, useParams } from "react-router"
import { ArrowUpRight, Building2, CircleHelp, ImagePlus, IdCard, MapPin, RotateCcw, Save, ShieldAlert, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "@/components/ui/alert-dialog"
import type { WorkspaceIdentity } from "@contracts"
import { updateWorkspaceIdentityPayloadSchema, workspaceIdentitySchema } from "../../../../../../../packages/contracts/src/workspace-identity"
import { useWorkspaceStore } from "@/providers/app-providers"
import { allowed, useAction, useDraftState, useText } from "../pm-ui"
import { usePmService } from "../pm-service"
import { useWorkspaceIdentity, useWorkspaceOrganization } from "../pm-workspace-identity-hooks"
import { WorkspaceIdentityBadge } from "../pm-workspace-identity-badge"
import { isAccessError } from "../pm-errors"
import { FontPreferenceControl } from "./settings-font-preference"
import { AgentSettingsStatus } from "../../agent/agent-settings-status"
import { SettingsSection, type SettingsPageProps } from "./settings-shared"
import { RadixSelect } from "@/components/ui/radix-select"

type DemoBusiness = { taxId: string; address: string; logo: File | null }
type DemoStatus = "active" | "deactivated" | "deleted"
type DemoAction = "deactivate" | "delete"
type DemoFeedback = "saved" | "discarded" | "reset" | "deactivated" | "deleted" | null
type LogoError = "type" | "size" | "decode" | null

const emptyBusiness: DemoBusiness = { taxId: "", address: "", logo: null }
const logoTypes: Record<string, true> = { "image/png": true, "image/jpeg": true, "image/webp": true }
const logoSizeLimit = 2 * 1024 * 1024

function GeneralRow({ id, label, description, children }: {
  id?: string
  label: string
  description: string
  children: ReactNode
}) {
  return (
    <div className="grid min-w-0 gap-4 border-b py-6 first:pt-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:gap-6">
      <div className="space-y-1">
        {id ? <label htmlFor={id} className="text-sm font-medium">{label}</label> : <p className="text-sm font-medium">{label}</p>}
        <p id={id ? `${id}-description` : undefined} className="text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      <div className="min-w-0 space-y-2">{children}</div>
    </div>
  )
}

function AppearancePreferences({ preferencesHref }: { preferencesHref?: string }) {
  const t = useText()
  const id = useId()
  const theme = useWorkspaceStore((state) => state.theme)
  const setTheme = useWorkspaceStore((state) => state.setTheme)
  const locale = useWorkspaceStore((state) => state.locale)
  const setLocale = useWorkspaceStore((state) => state.setLocale)

  return (
    <GeneralRow
      label={t("外观、字体与语言", "Appearance, font & language")}
      description={t("立即应用并保存在当前浏览器；不写入账号。", "Applied immediately and saved in this browser; not stored in your account.")}
    >
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label htmlFor={`${id}-theme`} className="grid min-w-0 gap-2 text-sm">
          <span>{t("主题", "Theme")}</span>
          <RadixSelect id={`${id}-theme`} value={theme} onChange={(event) => {
            const value = event.target.value
            if (value === "light" || value === "dark" || value === "system") setTheme(value)
          }}>
            <option value="light">{t("浅色", "Light")}</option>
            <option value="dark">{t("深色", "Dark")}</option>
            <option value="system">{t("跟随系统", "System")}</option>
          </RadixSelect>
        </label>
        <label htmlFor={`${id}-locale`} className="grid min-w-0 gap-2 text-sm">
          <span>{t("界面语言", "Interface language")}</span>
          <RadixSelect id={`${id}-locale`} value={locale} onChange={(event) => {
            const value = event.target.value
            if (value === "zh-CN" || value === "en") setLocale(value)
          }}>
            <option value="zh-CN">{t("中文（简体）", "Chinese (Simplified)")}</option>
            <option value="en">{t("英文", "English")}</option>
          </RadixSelect>
        </label>
      </div>
      {preferencesHref && <Link to={preferencesHref} className="inline-flex items-center gap-1 rounded-control text-sm text-primary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {t("完整外观设置", "All appearance settings")}<ArrowUpRight aria-hidden="true" className="size-3.5" />
      </Link>}
    </GeneralRow>
  )
}

function FontPreference() {
  const t = useText()
  const id = useId()
  return (
    <GeneralRow id={id} label={t("界面字体", "Interface font")} description={t("立即应用并保存在当前浏览器；代码与等宽内容不受影响。", "Applied immediately and saved in this browser; code and monospace content are unchanged.")}>
      <FontPreferenceControl id={id} describedBy={`${id}-description`} />
    </GeneralRow>
  )
}

function BusinessFields({ value, disabled, onChange, errors, real = false }: {
  value: DemoBusiness
  disabled: boolean
  onChange?: (field: "taxId" | "address", value: string) => void
  errors?: { taxId: boolean; address: boolean }
  real?: boolean
}) {
  const t = useText()
  const id = useId()
  return <>
    <GeneralRow id={`${id}-tax`} label={t("企业税号", "Business Tax ID")} description={real
      ? t("工作区税务资料；仅工作区管理员可查看和编辑；可为空。", "Workspace tax details; visible and editable only to workspace administrators; optional.")
      : onChange
        ? t("仅用于示例的企业税号（必填）。", "Business tax ID for this demo only (required).")
        : t("后端未提供组织税务资料的读取与保存接口。", "The backend does not provide organizational tax information or a save API.")}>
      <InputGroup>
        <InputGroupInput
          id={`${id}-tax`}
          name="taxId"
          value={value.taxId}
          disabled={disabled}
          required={!!onChange && !real}
          maxLength={64}
          autoComplete="off"
          placeholder={onChange && !real ? t("例如：DEMO-TAX-2026", "e.g. DEMO-TAX-2026") : real ? t("可选", "Optional") : t("暂不可用", "Unavailable")}
          aria-describedby={`${id}-tax-description${errors?.taxId ? ` ${id}-tax-error` : ""}`}
          aria-invalid={errors?.taxId || undefined}
          onChange={onChange ? (event) => onChange("taxId", event.target.value) : undefined}
        />
        <InputGroupAddon aria-hidden="true"><IdCard className="size-4" /></InputGroupAddon>
      </InputGroup>
      {errors?.taxId && <p id={`${id}-tax-error`} role="alert" className="text-sm text-destructive">{real ? t("税号不能超过 64 个字符。", "Tax ID must be at most 64 characters.") : t("请输入 1–64 个字符的示例税号。", "Enter a demo tax ID of 1–64 characters.")}</p>}
    </GeneralRow>
    <GeneralRow id={`${id}-address`} label={t("企业地址", "Business Address")} description={real
      ? t("工作区企业地址；仅工作区管理员可查看和编辑；可为空。", "Workspace business address; visible and editable only to workspace administrators; optional.")
      : onChange
        ? t("仅用于示例的企业地址（必填）。", "Business address for this demo only (required).")
        : t("后端未提供组织地址的读取与保存接口。", "The backend does not provide an organizational address or a save API.")}>
      <InputGroup>
        <InputGroupInput
          id={`${id}-address`}
          name="businessAddress"
          value={value.address}
          disabled={disabled}
          required={!!onChange && !real}
          maxLength={300}
          autoComplete="off"
          placeholder={onChange && !real ? t("例如：示例城市，示例街道 123 号", "e.g. 123 Example Street, Demo City") : real ? t("可选", "Optional") : t("暂不可用", "Unavailable")}
          aria-describedby={`${id}-address-description${errors?.address ? ` ${id}-address-error` : ""}`}
          aria-invalid={errors?.address || undefined}
          onChange={onChange ? (event) => onChange("address", event.target.value) : undefined}
        />
        <InputGroupAddon aria-hidden="true"><MapPin className="size-4" /></InputGroupAddon>
      </InputGroup>
      {errors?.address && <p id={`${id}-address-error`} role="alert" className="text-sm text-destructive">{real ? t("企业地址不能超过 300 个字符。", "Business address must be at most 300 characters.") : t("请输入 1–300 个字符的示例地址。", "Enter a demo address of 1–300 characters.")}</p>}
    </GeneralRow>
  </>
}

function AccountDanger({ disabled, deleted = false, onAction }: {
  disabled: boolean
  deleted?: boolean
  onAction?: (action: DemoAction) => void
}) {
  const t = useText()
  const id = useId()
  return (
    <section aria-labelledby={`${id}-title`} aria-describedby={`${id}-reason`} className="flex min-w-0 flex-col justify-between gap-4 rounded-module border border-destructive/25 bg-surface p-4 lg:flex-row lg:items-center">
      <div className="min-w-0 space-y-1">
        <h3 id={`${id}-title`} className="flex items-center gap-2 text-sm font-medium"><ShieldAlert aria-hidden="true" className="size-4 text-destructive" />{t("移除账号", "Remove Account")}</h3>
        <p id={`${id}-reason`} className="text-sm leading-6 text-muted-foreground">{onAction
          ? t("以下操作仅修改本页可重置的示例状态，不会停用或删除真实账号。", "These actions only change this page’s resettable demo state. No real account is deactivated or deleted.")
          : t("暂不可用：后端未提供账号停用或删除接口。此处不会改变账号或工作区。", "Unavailable: the backend has no account deactivation or deletion API. These controls cannot change your account or workspace.")}</p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button variant="outline" disabled={disabled} aria-describedby={`${id}-reason`} className="text-destructive" onClick={() => onAction?.("deactivate")}>{t("停用账号", "Deactivate Account")}</Button>
        <Button variant="destructive" disabled={onAction ? deleted : true} aria-describedby={`${id}-reason`} onClick={() => onAction?.("delete")}><Trash2 aria-hidden="true" className="size-4" />{t("删除账号", "Delete Account")}</Button>
      </div>
    </section>
  )
}

type OrganizationDraft = { taxId: string; address: string; version: number; pendingCommandId: string | null }

function OrganizationProfile({ identity, identityReadBlocked, refreshIdentity, draft, setDraft }: {
  identity: WorkspaceIdentity
  identityReadBlocked: boolean
  refreshIdentity: () => void
  draft: OrganizationDraft | null
  setDraft: (next: OrganizationDraft | null | ((previous: OrganizationDraft | null) => OrganizationDraft | null)) => void
}) {
  const t = useText()
  const query = useWorkspaceOrganization()
  const action = useAction()
  const [errors, setErrors] = useState({ taxId: false, address: false })
  const [saved, setSaved] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [receiptNeedsAdoption, setReceiptNeedsAdoption] = useState(false)
  const lostAccess = isAccessError(query.error)
  const snapshotsReady = !identityReadBlocked && !query.isFetching && !query.error &&
    query.data?.workspaceId === identity.workspaceId && query.data.version === identity.version
  const original = action.unknownCommand?.commandType === "UpdateWorkspaceIdentity" &&
    action.unknownCommand.targetId === identity.workspaceId ? action.unknownCommand : null
  const originalPayload = original ? updateWorkspaceIdentityPayloadSchema.safeParse(original.payload) : null
  const originalVersion = original?.expectedVersions?.[identity.workspaceId]
  const recoveringOrganization = !!original && originalPayload?.success === true &&
    originalPayload.data.taxId !== undefined && originalPayload.data.businessAddress !== undefined && originalVersion !== undefined

  useEffect(() => {
    if (lostAccess) {
      if (draft) setDraft(null)
      return
    }
    // Journal restoration can finish after this editor mounts. Associate the
    // original command without replacing an already retained, unsaved draft.
    if (recoveringOrganization && original && originalPayload?.success && originalVersion !== undefined) {
      if (draft && draft.pendingCommandId !== original.commandId) {
        setDraft({ ...draft, pendingCommandId: original.commandId })
        setSaved(false)
      } else if (!draft && snapshotsReady) {
        setDraft({ taxId: originalPayload.data.taxId ?? "", address: originalPayload.data.businessAddress ?? "", version: originalVersion, pendingCommandId: original.commandId })
      }
      return
    }
    const data = query.data
    if (!draft && data && snapshotsReady) {
      setDraft({ taxId: data.taxId ?? "", address: data.businessAddress ?? "", version: data.version, pendingCommandId: null })
    }
  }, [draft, lostAccess, original, originalPayload, originalVersion, query.data, recoveringOrganization, setDraft, snapshotsReady])

  useEffect(() => {
    if (lostAccess || !draft?.pendingCommandId || action.pending || submitting || action.unknownCommand) return
    const receipt = action.receipt
    if (receipt?.commandId !== draft.pendingCommandId) {
      // No matching receipt is available for this settled attempt. Release its
      // local marker only; unknown operations remain locked by the guard above.
      setDraft(previous => previous ? { ...previous, pendingCommandId: null } : previous)
      return
    }
    if (receipt.status === "committed") {
      const result = workspaceIdentitySchema.safeParse(receipt.result)
      if (result.success && result.data.workspaceId === identity.workspaceId) {
        setDraft(previous => previous ? { ...previous, version: result.data.version, pendingCommandId: null } : previous)
        setReceiptNeedsAdoption(false)
        action.setError(null)
        setSaved(true)
      } else {
        setDraft(previous => previous ? { ...previous, pendingCommandId: null } : previous)
        setReceiptNeedsAdoption(true)
        setSaved(false)
      }
    } else {
      setDraft(previous => previous ? { ...previous, pendingCommandId: null } : previous)
      setSaved(false)
    }
  }, [action.pending, action.receipt, action.unknownCommand, action.setError, draft?.pendingCommandId, identity.workspaceId, lostAccess, setDraft, submitting])

  const dirty = !!draft && !!query.data && (
    draft.taxId !== (query.data.taxId ?? "") ||
    draft.address !== (query.data.businessAddress ?? "")
  )
  const busy = action.locked || submitting || !!draft?.pendingCommandId
  const conflict = !!draft && (identity.version > draft.version || (query.data?.version ?? 0) > draft.version || receiptNeedsAdoption)
  const awaitingSnapshot = !snapshotsReady || !!draft && identity.version < draft.version
  const refresh = () => { refreshIdentity(); void query.refetch() }
  const adoptCurrentVersion = (keepDraft: boolean) => {
    if (!query.data || !draft || !snapshotsReady || busy) return
    setDraft(keepDraft
      ? { ...draft, version: identity.version, pendingCommandId: null }
      : { taxId: query.data.taxId ?? "", address: query.data.businessAddress ?? "", version: query.data.version, pendingCommandId: null })
    setErrors({ taxId: false, address: false })
    setReceiptNeedsAdoption(false)
    setSaved(false)
    action.setError(null)
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!draft || !query.data || busy || awaitingSnapshot || conflict || !dirty || draft.version !== identity.version) return
    const taxId = draft.taxId.trim()
    const address = draft.address.trim()
    const nextErrors = { taxId: taxId.length > 64, address: address.length > 300 }
    setErrors(nextErrors)
    setSaved(false)
    if (nextErrors.taxId || nextErrors.address) return
    const commandId = crypto.randomUUID()
    setDraft({ ...draft, taxId, address, pendingCommandId: commandId })
    setSubmitting(true)
    try {
      await action.run(() => action.execute({
        commandId,
        commandType: "UpdateWorkspaceIdentity",
        targetId: identity.workspaceId,
        expectedVersions: { [identity.workspaceId]: draft.version },
        payload: { name: identity.name, icon: identity.icon, color: identity.color, taxId: taxId || null, businessAddress: address || null },
      }))
    } finally { setSubmitting(false) }
  }

  return (
    <div className="space-y-3">
      {query.isPending && !query.data && <p role="status" className="text-sm text-muted-foreground">{t("正在读取组织资料…", "Reading organization details…")}</p>}
      {query.error && <div role="alert" className="space-y-2 text-sm">
        <p className="break-words text-destructive">{query.data ? t("组织资料刷新失败，上次快照可能已过期：", "Organization refresh failed; the previous snapshot may be stale: ") : ""}{query.error.message}</p>
        <Button type="button" variant="outline" disabled={query.isFetching} onClick={refresh}>{t("重试读取", "Retry read")}</Button>
      </div>}
      {lostAccess && <p role="status" className="text-sm text-muted-foreground">{t("组织资料读取权限已失效；受保护的快照和草稿已清除。", "Organization access is no longer available; protected snapshots and drafts were cleared.")}</p>}
      {!lostAccess && <>
      {recoveringOrganization && original && <div role="status" className="space-y-2 rounded-module border p-4 text-sm">
        <p>{t("组织资料原请求结果未知；现有输入保持不变，不能再次提交。请查询原命令收据，不会自动重发。", "The original organization request has an unknown outcome. Existing input is retained and saving is blocked. Check the original receipt; the request is never resent automatically.")}</p>
        <p className="break-all font-mono text-xs">{original.commandId}</p>
        <Button type="button" variant="outline" disabled={action.pending || submitting} onClick={() => { void action.run(action.reconcile) }}>{t("查询原命令收据", "Check original command receipt")}</Button>
      </div>}
      {awaitingSnapshot && !query.isPending && <div role="status" className="space-y-2 text-sm"><p>{t("等待工作区与组织资料同步到同一已确认版本；此时不能提交。未保存草稿保持不变。", "Waiting for workspace identity and organization details to reach the same confirmed version. Saving is blocked; unsaved drafts remain intact.")}</p><Button type="button" variant="outline" disabled={query.isFetching} onClick={refresh}>{t("刷新资料", "Refresh details")}</Button></div>}
      {draft && conflict && <div role="status" className="space-y-3 rounded-module border p-4 text-sm">
        <p>{receiptNeedsAdoption
          ? t("原请求已提交，但收据未提供有效的资料版本。请刷新并明确采用当前版本；输入不会被清除。", "The original request committed, but its receipt did not provide a valid identity version. Refresh and explicitly adopt the current version; your input is retained.")
          : t("服务端资料已更新；你的完整草稿及原版本仍保留。请比较后明确选择，不会自动合并或重试。", "Saved details changed. Your complete draft and original version remain intact. Compare before choosing; nothing is merged or retried automatically.")}</p>
        <div className="flex min-w-0 items-center gap-3"><WorkspaceIdentityBadge icon={identity.icon} color={identity.color} /><p className="min-w-0 break-words">{t("最新工作区资料", "Latest workspace identity")}: {identity.name} · {identity.icon} · {identity.color}</p></div>
        <p className="break-words">{t("服务端税号 / 地址", "Saved tax ID / address")}: {query.data?.taxId ?? "—"} / {query.data?.businessAddress ?? "—"}</p>
        <p>{t("草稿 / 组织 / 工作区版本", "Draft / organization / identity version")}: {draft.version} / {query.data?.version ?? "—"} / {identity.version}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={busy || !snapshotsReady} onClick={() => adoptCurrentVersion(true)}>{t("保留草稿，使用最新版本", "Keep draft, use latest version")}</Button>
          <Button type="button" variant="outline" disabled={busy || !snapshotsReady} onClick={() => adoptCurrentVersion(false)}>{t("使用服务端资料", "Use saved details")}</Button>
        </div>
      </div>}
      {draft && <form noValidate onSubmit={save} className="space-y-2">
        <fieldset disabled={busy || !snapshotsReady} className="space-y-2">
          <BusinessFields value={{ taxId: draft.taxId, address: draft.address, logo: null }} disabled={busy || !snapshotsReady} errors={errors} real onChange={(field, value) => {
            setDraft((previous) => previous ? { ...previous, [field]: value } : previous)
            setErrors((previous) => ({ ...previous, [field]: false }))
            setSaved(false)
            action.setError(null)
          }} />
          <div className="flex flex-wrap items-center gap-2 pt-4">
            <Button type="submit" disabled={!dirty || busy || awaitingSnapshot || conflict}><Save aria-hidden="true" className="size-4" />{t("保存更改", "Save Changes")}</Button>
            <Button type="button" variant="outline" disabled={!dirty || busy || !snapshotsReady} onClick={() => adoptCurrentVersion(false)}>{t("撤销更改", "Discard changes")}</Button>
          </div>
          {action.localError && <p role="alert" className="text-sm text-destructive">{action.localError}</p>}
          {saved && <p role="status" className="text-sm text-muted-foreground">{t("组织资料原请求已由收据确认提交。当前输入保持不变；若与最新快照不同，仍属于未保存草稿。", "The original organization request was confirmed committed by its receipt. Current input is retained; any differences from the latest snapshot remain unsaved.")}</p>}
        </fieldset>
      </form>}
      </>}
    </div>
  )
}

function ServiceGeneral() {
  const t = useText()
  const id = useId()
  const { workspaceSlug } = useParams()
  const identity = useWorkspaceIdentity()
  const { actor, actorEpoch, workspace } = usePmService()
  const workspaceRoot = `/pm/${encodeURIComponent(workspace?.id ?? workspaceSlug ?? "")}`
  const root = `${workspaceRoot}/settings`
  const canManage = allowed(workspace, "access.manage")
  const [organizationDraft, setOrganizationDraft] = useDraftState<OrganizationDraft | null>("settings-workspace-organization", "draft", null)
  const identityAccessLost = isAccessError(identity.error)
  // Keep this owner mounted for ordinary members too, so losing the ability
  // clears retained organization plaintext instead of just hiding its form.
  useEffect(() => {
    if ((!canManage || identityAccessLost) && organizationDraft) setOrganizationDraft(null)
  }, [canManage, identityAccessLost, organizationDraft, setOrganizationDraft])
  return (
    <SettingsSection title={t("常规", "General")}>
      <div className="flex min-w-0 flex-col gap-4 rounded-module border bg-surface p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 gap-3">
          <CircleHelp aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="space-y-1">
            <p className="text-sm font-medium">{t("方案状态暂不可用", "Plan status unavailable")}</p>
            <p className="text-sm leading-6 text-muted-foreground">{t("当前服务未提供订阅或计费数据；不会推定为免费方案。", "This service does not expose subscription or billing data. No free plan is assumed.")}</p>
          </div>
        </div>
        <Button variant="outline" render={<Link to={`${root}/plans`} />}>{t("查看方案支持情况", "View plan availability")}<ArrowUpRight aria-hidden="true" className="size-4" /></Button>
      </div>
      <GeneralRow label={t("工作区资料", "Workspace identity")} description={t("名称、图标和颜色由工作区服务保存；不改动 URL 或组织资料。", "Name, icon and color save through the workspace service; URLs and organization details are unchanged.")}><Link to={`${root}/workspace`} className="inline-flex items-center gap-1 text-sm text-primary hover:text-foreground">{t("管理工作区名称、图标与颜色", "Manage workspace name, icon and color")}<ArrowUpRight aria-hidden="true" className="size-3.5" /></Link></GeneralRow>
      <GeneralRow label={t("开始使用引导", "Getting started guide")} description={t("重新打开当前工作区的引导；不会重置进度。", "Reopen this workspace’s guide; progress is not reset.")}>
        <Link to={`${workspaceRoot}/onboarding`} className="inline-flex items-center gap-1 rounded-control text-sm text-primary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">{t("打开当前工作区引导", "Open this workspace’s guide")}<ArrowUpRight aria-hidden="true" className="size-3.5" /></Link>
      </GeneralRow>
      <GeneralRow label={t("设置保存范围", "Where settings are stored")} description={t("各设置使用现有保存边界，不等同于账号同步。", "Each setting keeps its existing storage boundary; none is account sync.")}>
        <dl className="space-y-3 text-sm leading-6">
          <div><dt className="font-medium">{t("当前浏览器", "Browser")}</dt><dd className="text-muted-foreground">{t("主题、字体、语言及显示偏好保存在此浏览器；存储不可用时仅本次会话有效。", "Theme, font, language and display preferences live in this browser; without storage they last for this session only.")}</dd></div>
          <div><dt className="font-medium">{t("PM 账号", "Account")}</dt><dd className="text-muted-foreground">{t("个人资料、账号安全和引导进度按账号管理。", "Profile, account security and guide progress are managed per account.")}</dd></div>
          <div><dt className="font-medium">{t("PM 工作区", "Workspace")}</dt><dd className="text-muted-foreground">{t("工作区资料与共享配置使用当前工作区服务及既有权限。", "Workspace identity and shared configuration use this workspace’s services and existing permissions.")}</dd></div>
          <div><dt className="font-medium">{t("本机 Agent 服务", "Local Agent")}</dt><dd className="text-muted-foreground">{t("Provider、MCP 和 Skills 属于本机 Agent，不是 PM 账号隔离。", "Providers, MCP and Skills belong to the local Agent, not PM-account isolation.")}</dd></div>
          <div><dt className="font-medium">{t("部署配置", "Deployment")}</dt><dd className="text-muted-foreground">{t("邮件、附件存储和出站目标受部署配置控制。", "Mail, attachment storage and outbound targets depend on deployment configuration.")}</dd></div>
        </dl>
      </GeneralRow>
      <AgentSettingsStatus />
      <div>
        {identity.isPending && !identity.data && <p role="status" className="py-3 text-sm text-muted-foreground">{t("正在读取工作区资料…", "Reading workspace identity…")}</p>}
        {identity.isFetching && identity.data && <p role="status" className="py-3 text-sm text-muted-foreground">{t("正在刷新工作区资料；组织草稿保持不变。", "Refreshing workspace identity; the organization draft is retained.")}</p>}
        {identity.error && <div role="alert" className="space-y-2 py-3 text-sm"><p className="break-words text-destructive">{identity.data ? t("工作区资料刷新失败，上次快照可能已过期：", "Identity refresh failed; the previous snapshot may be stale: ") : ""}{identity.error.message}</p><Button variant="outline" disabled={identity.isFetching} onClick={() => { void identity.refetch() }}>{t("重试读取工作区资料", "Retry identity read")}</Button></div>}
        <GeneralRow label={t("公司标志", "Company Logo")} description={t("以工作区名称、图标和颜色表示；不支持上传图片。", "Represented by the workspace name, icon and color; image upload is unsupported.")}>
          <div className="flex min-w-0 items-center gap-3">
            {identity.data
              ? <WorkspaceIdentityBadge icon={identity.data.icon} color={identity.data.color} className="size-12" />
              : <div aria-hidden="true" className="flex size-12 shrink-0 items-center justify-center rounded-module border border-dashed bg-surface-raised"><Building2 className="size-5 text-muted-foreground" /></div>}
            <div className="min-w-0 space-y-1">
              <p className="truncate text-sm font-medium">{identity.data?.name ?? (identity.isPending ? t("读取工作区资料…", "Reading workspace identity…") : t("工作区资料不可用", "Workspace identity unavailable"))}</p>
              <Link to={`${root}/workspace`} className="inline-flex items-center gap-1 rounded-control text-sm text-primary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("查看或管理图标与颜色", "View or manage icon and color")}<ArrowUpRight aria-hidden="true" className="size-3.5" /></Link>
            </div>
          </div>
        </GeneralRow>
        <FontPreference />
        <AppearancePreferences preferencesHref={`${root}/appearance`} />
        {canManage
          ? identity.data
            ? <OrganizationProfile key={`${actor?.id}:${actorEpoch}:${workspace?.id}`} identity={identity.data} identityReadBlocked={!!identity.error || identity.isFetching} refreshIdentity={() => { void identity.refetch() }} draft={organizationDraft} setDraft={setOrganizationDraft} />
            : !identity.isPending && !identity.error && <p className="text-sm text-muted-foreground">{t("没有可用的工作区资料；请重新读取。", "No workspace identity is available; read it again.")}</p>
          : <div className="space-y-2 pt-5">
              <Button disabled aria-describedby={`${id}-save-reason`}>{t("保存组织资料", "Save organization details")}</Button>
              <p id={`${id}-save-reason`} className="text-sm text-muted-foreground">{t("仅工作区管理员可读取和保存企业税号与地址。上方主题、字体与语言在选择后立即生效。", "Only workspace administrators can read or save the business tax ID and address. Theme, font and language changes above apply immediately.")}</p>
            </div>}
      </div>
      <div className="pt-6"><AccountDanger disabled /></div>
    </SettingsSection>
  )
}

function LabGeneral() {
  const t = useText()
  const id = useId()
  const { workspaceSlug } = useParams()
  const [draft, setDraft] = useState<DemoBusiness>(emptyBusiness)
  const [saved, setSaved] = useState<DemoBusiness>(emptyBusiness)
  const [status, setStatus] = useState<DemoStatus>("active")
  const [pendingAction, setPendingAction] = useState<DemoAction | null>(null)
  const [feedback, setFeedback] = useState<DemoFeedback>(null)
  const [errors, setErrors] = useState({ taxId: false, address: false })
  const [logoError, setLogoError] = useState<LogoError>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [logoReady, setLogoReady] = useState(true)
  const currentUrl = useRef<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const active = status === "active"
  const dirty = draft.taxId !== saved.taxId || draft.address !== saved.address || draft.logo !== saved.logo

  useEffect(() => () => {
    if (currentUrl.current) URL.revokeObjectURL(currentUrl.current)
  }, [])

  const replacePreview = (file: File | null) => {
    if (currentUrl.current) URL.revokeObjectURL(currentUrl.current)
    const next = file ? URL.createObjectURL(file) : null
    currentUrl.current = next
    setPreview(next)
    setLogoReady(!file)
    setLogoError(null)
    if (fileInput.current) fileInput.current.value = ""
  }

  const resetDemo = () => {
    replacePreview(null)
    setDraft(emptyBusiness)
    setSaved(emptyBusiness)
    setErrors({ taxId: false, address: false })
    setStatus("active")
    setPendingAction(null)
    setFeedback("reset")
  }

  const saveDemo = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!active || !logoReady) return
    const taxId = draft.taxId.trim()
    const address = draft.address.trim()
    const nextErrors = { taxId: !taxId || taxId.length > 64, address: !address || address.length > 300 }
    setErrors(nextErrors)
    setFeedback(null)
    if (nextErrors.taxId || nextErrors.address) return
    const next = { ...draft, taxId, address }
    setDraft(next)
    setSaved(next)
    setFeedback("saved")
  }

  const confirmAction = () => {
    if (!pendingAction) return
    if (pendingAction === "deactivate") {
      setStatus("deactivated")
      setFeedback("deactivated")
    } else {
      replacePreview(null)
      setDraft(emptyBusiness)
      setSaved(emptyBusiness)
      setErrors({ taxId: false, address: false })
      setStatus("deleted")
      setFeedback("deleted")
    }
    setPendingAction(null)
  }

  return (
    <SettingsSection title={t("常规", "General")} description={t("管理应用选项；组织资料示例仅在本页有效。", "Manage application options; the organization demo applies only to this page.")}>
      <div className="flex min-w-0 flex-col gap-4 rounded-module border bg-surface p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 gap-3">
          <Building2 aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="space-y-1">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium">{t("示例账号", "Demo account")}<span className="rounded-pill border bg-surface-raised px-2 py-0.5 text-xs">{status === "active" ? t("启用中", "Active") : status === "deactivated" ? t("已停用（示例）", "Deactivated (demo)") : t("已删除（示例）", "Deleted (demo)")}</span></p>
            <p className="text-sm leading-6 text-muted-foreground">{t("仅为本地交互示例，无订阅或付费方案。", "A local interaction demo, with no subscription or paid plan.")}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="outline" render={<Link to={`/lab/pm/${encodeURIComponent(workspaceSlug ?? "")}/settings/plans`} />}>{t("套餐与用量说明", "Plans & usage guidance")}</Button>
          <Button variant="outline" onClick={resetDemo}><RotateCcw aria-hidden="true" className="size-4" />{t("重置示例", "Reset demo")}</Button>
        </div>
      </div>
      <form noValidate onSubmit={saveDemo}>
        <GeneralRow id={`${id}-logo`} label={t("公司标志", "Company Logo")} description={t("支持 PNG、JPEG 或 WebP，最大 2 MiB。", "PNG, JPEG or WebP, up to 2 MiB.")}>
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-module border bg-surface-raised">
              {preview ? <img
                src={preview}
                alt={t("公司标志示例预览", "Demo company logo preview")}
                className="size-full object-contain"
                onLoad={() => { if (currentUrl.current === preview) setLogoReady(true) }}
                onError={() => {
                  if (currentUrl.current !== preview) return
                  replacePreview(null)
                  setDraft((previous) => ({ ...previous, logo: null }))
                  setLogoError("decode")
                  setFeedback(null)
                }}
              /> : <ImagePlus aria-hidden="true" className="size-5 text-muted-foreground" />}
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <Input
                ref={fileInput}
                id={`${id}-logo`}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={!active}
                aria-describedby={`${id}-logo-description${logoError ? ` ${id}-logo-error` : ""}`}
                aria-invalid={!!logoError || undefined}
                className="h-auto min-h-9 min-w-0 py-1.5 text-xs"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ""
                  if (!file) return
                  setFeedback(null)
                  if (!Object.hasOwn(logoTypes, file.type)) { setLogoError("type"); return }
                  if (file.size === 0 || file.size > logoSizeLimit) { setLogoError("size"); return }
                  replacePreview(file)
                  setDraft((previous) => ({ ...previous, logo: file }))
                }}
              />
              {draft.logo && <p className="break-all text-xs text-muted-foreground">{draft.logo.name}</p>}
            </div>
          </div>
          <Button variant="ghost" size="sm" disabled={!active || !draft.logo} onClick={() => {
            replacePreview(null)
            setDraft((previous) => ({ ...previous, logo: null }))
            setFeedback(null)
          }}>{t("移除标志", "Remove logo")}</Button>
          {preview && !logoReady && <p role="status" className="text-sm text-muted-foreground">{t("正在读取预览…", "Reading preview…")}</p>}
          {logoError && <p id={`${id}-logo-error`} role="alert" className="text-sm text-destructive">{logoError === "type"
            ? t("未选择此文件。请选择 PNG、JPEG 或 WebP 图片。", "This file was not selected. Choose a PNG, JPEG, or WebP image.")
            : logoError === "size"
              ? t("未选择此文件。图片不能为空，且不能超过 2 MiB。", "This file was not selected. The image must be non-empty and no larger than 2 MiB.")
              : t("无法解码此图片，已移除预览。请选择有效的图片文件。", "This image could not be decoded, so its preview was removed. Choose a valid image file.")}</p>}
        </GeneralRow>
        <FontPreference />
        <AppearancePreferences preferencesHref={`/lab/pm/${encodeURIComponent(workspaceSlug ?? "")}/settings/appearance`} />
        <BusinessFields value={draft} disabled={!active} errors={errors} onChange={(field, value) => {
          setDraft((previous) => ({ ...previous, [field]: value }))
          setErrors((previous) => ({ ...previous, [field]: false }))
          setFeedback(null)
        }} />
        <div className="flex flex-wrap gap-2 pt-5">
          <Button type="submit" disabled={!active || !logoReady}><Save aria-hidden="true" className="size-4" />{t("保存更改", "Save Changes")}</Button>
          <Button variant="outline" disabled={!active || !dirty} onClick={() => {
            replacePreview(saved.logo)
            setDraft(saved)
            setErrors({ taxId: false, address: false })
            setFeedback("discarded")
          }}>{t("撤销未保存的更改", "Discard unsaved changes")}</Button>
        </div>
        {!active && <p className="mt-3 text-sm text-muted-foreground">{t("示例编辑已暂停。点击“重置示例”即可恢复，不影响真实账号。", "Demo editing is paused. Use Reset demo to restore it; your real account is unaffected.")}</p>}
        <div aria-live="polite" className="mt-3 text-sm leading-6 text-muted-foreground">
          {feedback === "saved" && <p>{t("更改已保存到本页的示例快照，未发送至服务器。离开页面后会重置。", "Changes saved to this page’s demo snapshot, not to a server. Leaving this page resets them.")}</p>}
          {feedback === "discarded" && <p>{t("已恢复本页最后保存的示例快照。", "The last saved demo snapshot on this page has been restored.")}</p>}
          {feedback === "reset" && <p>{t("本页示例状态已重置，示例账号已恢复启用。", "This page’s demo state was reset and its demo account is active again.")}</p>}
          {feedback === "deactivated" && <p>{t("仅本页示例账号已停用。真实登录、账号和工作区均未更改。", "Only this page’s demo account was deactivated. Your real session, account, and workspace are unchanged.")}</p>}
          {feedback === "deleted" && <p>{t("仅本页示例资料已清除，示例账号标记为已删除。可随时重置；未删除任何真实数据。", "Only this page’s demo details were cleared and its demo account marked deleted. Reset is always available; no real data was deleted.")}</p>}
        </div>
      </form>
      <div className="pt-6"><AccountDanger disabled={!active} deleted={status === "deleted"} onAction={setPendingAction} /></div>
      <AlertDialog open={pendingAction !== null} onOpenChange={(open) => { if (!open) setPendingAction(null) }}>
        <AlertDialogContent>
          <AlertDialogTitle className="text-base font-semibold">{pendingAction === "delete" ? t("删除本页的示例账号？", "Delete this page’s demo account?") : t("停用本页的示例账号？", "Deactivate this page’s demo account?")}</AlertDialogTitle>
          <AlertDialogDescription className="text-sm leading-6 text-muted-foreground">{pendingAction === "delete"
            ? t("这只会清除本页的示例标志、税号、地址和保存快照，并标记示例账号为已删除。不会调用服务或删除真实账号；点击“重置示例”可重新开始。", "This only clears this page’s demo logo, tax ID, address, and saved snapshot, then marks the demo account as deleted. No service is called and no real account is deleted. Reset demo lets you start again.")
            : t("这只会暂停本页示例资料的编辑，保留示例内容。不会退出登录或停用真实账号；点击“重置示例”可恢复。", "This only pauses editing of this page’s demo details and retains their contents. It does not sign you out or deactivate a real account. Reset demo restores editing.")}</AlertDialogDescription>
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            <AlertDialogCancel asChild><Button variant="outline">{t("取消", "Cancel")}</Button></AlertDialogCancel>
            <Button variant={pendingAction === "delete" ? "destructive" : "primary"} onClick={confirmAction}>{pendingAction === "delete" ? t("仅删除示例", "Delete demo only") : t("仅停用示例", "Deactivate demo only")}</Button>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  )
}

export function SettingsGeneral({ mode }: SettingsPageProps) {
  return mode === "service" ? <ServiceGeneral /> : <LabGeneral />
}
