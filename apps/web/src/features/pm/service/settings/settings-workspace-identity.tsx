import { useEffect, useId, useState, type FormEvent } from "react"
import { ShieldAlert, Trash2 } from "lucide-react"
import type { WorkspaceIdentity, UpdateWorkspaceIdentityPayload } from "../../../../../../../packages/domain/src/workspace-identity"
import { WORKSPACE_COLORS, WORKSPACE_ICONS } from "../../../../../../../packages/domain/src/workspace-identity"
import { updateWorkspaceIdentityPayloadSchema, workspaceIdentitySchema } from "../../../../../../../packages/contracts/src/workspace-identity"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useWorkspaceIdentity } from "../pm-workspace-identity-hooks"
import { WorkspaceIdentityBadge } from "../pm-workspace-identity-badge"
import { usePmService } from "../pm-service"
import { allowed, CommandNotice, useAction, useDraftState, useText } from "../pm-ui"
import { SettingsNotice } from "./settings-shared"
import { RadixSelect } from "@/components/ui/radix-select"

type IdentityDraft = UpdateWorkspaceIdentityPayload & { version: number; pendingCommandId: string | null }
function identityDraft(identity: WorkspaceIdentity): IdentityDraft {
  return { name: identity.name, icon: identity.icon, color: identity.color, version: identity.version, pendingCommandId: null }
}

function IdentityFields({ value, disabled, onChange }: { value: UpdateWorkspaceIdentityPayload; disabled: boolean; onChange?: (patch: Partial<UpdateWorkspaceIdentityPayload>) => void }) {
  const id = useId()
  const t = useText()
  const labels = { building: t("建筑", "Building"), grid: t("网格", "Grid"), briefcase: t("公文包", "Briefcase"), layers: t("图层", "Layers"), rocket: t("火箭", "Rocket"), globe: t("地球", "Globe") }
  return <fieldset disabled={disabled} className="space-y-5">
    <label htmlFor={`${id}-name`} className="grid gap-2 text-sm"><span className="font-medium">{t("工作区名称", "Workspace name")}</span><Input id={`${id}-name`} value={value.name} required maxLength={200} onChange={event => onChange?.({ name: event.target.value })} /><span className="text-muted-foreground">{t("1–200 个字符；保存后工作区选择与侧栏共用此名称。不会改变工作区 ID、Markdown 目录或 URL。", "1–200 characters. Workspace selection and navigation use this saved name. The workspace ID, Markdown directory and URL never change.")}</span></label>
    <div className="flex flex-wrap items-center gap-4"><WorkspaceIdentityBadge icon={value.icon} color={value.color} className="size-12 [&>svg]:size-6" /><label htmlFor={`${id}-icon`} className="grid min-w-40 gap-2 text-sm"><span className="font-medium">{t("工作区图标", "Workspace icon")}</span><RadixSelect id={`${id}-icon`} value={value.icon} onChange={event => { const icon = event.target.value; if (WORKSPACE_ICONS.includes(icon as typeof value.icon)) onChange?.({ icon: icon as typeof value.icon }) }}>{WORKSPACE_ICONS.map(icon => <option key={icon} value={icon}>{labels[icon]}</option>)}</RadixSelect></label></div>
    <div className="space-y-2"><p id={`${id}-colors`} className="text-sm font-medium">{t("工作区颜色", "Workspace color")}</p><div role="group" aria-labelledby={`${id}-colors`} className="flex flex-wrap gap-3">{WORKSPACE_COLORS.map(color => <button key={color} type="button" aria-label={`${t("颜色", "Color")} ${color}`} aria-pressed={value.color === color} onClick={() => onChange?.({ color })} className="size-8 rounded-full border-2 border-background outline-offset-2 aria-pressed:outline aria-pressed:outline-2 aria-pressed:outline-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed" style={{ backgroundColor: color }} />)}</div><p className="text-sm text-muted-foreground">{t("图标是应用自带矢量图形，颜色来自固定安全色板；不加载外部图片或任意 SVG。", "Icons are built-in vector shapes with an allowlisted palette. No external images or arbitrary SVG are loaded.")}</p></div>
  </fieldset>
}

function StableIdentity({ workspaceId }: { workspaceId: string }) {
  const t = useText()
  const id = useId()
  const url = `${window.location.origin}/pm/${encodeURIComponent(workspaceId)}`
  return <div className="space-y-5">
    <label className="grid gap-2 text-sm"><span className="font-medium">{t("工作区 ID", "Workspace ID")}</span><Input value={workspaceId} readOnly className="font-mono text-xs" /></label>
    <label className="grid gap-2 text-sm"><span className="font-medium">{t("工作区 URL", "Workspace URL")}</span><Input value={url} readOnly /><span className="text-muted-foreground">{t("稳定入口按当前浏览器启动偏好打开。自定义 URL / slug、停用及删除需要另行确定策略，目前均不可执行。", "This stable entry uses the browser’s start-page preference. Custom URLs / slugs, deactivation and deletion require separate policy decisions and are unavailable.")}</span></label>
    <section aria-labelledby={`${id}-danger`} className="space-y-3 rounded-module border border-destructive/30 p-4"><h3 id={`${id}-danger`} className="flex items-center gap-2 text-sm font-medium text-destructive"><ShieldAlert aria-hidden="true" className="size-4" />{t("危险区域", "Danger zone")}</h3><p id={`${id}-reason`} className="text-sm leading-6 text-muted-foreground">{t("工作区删除、停用及数据保留没有已确定的服务策略，不会级联删除项目、任务、文件或账号。", "Workspace deletion, deactivation and retention have no agreed service policy. Projects, tasks, files and accounts are never cascade-deleted here.")}</p><Button variant="destructive" disabled aria-describedby={`${id}-reason`}><Trash2 aria-hidden="true" className="size-4" />{t("删除工作区", "Delete workspace")}</Button></section>
  </div>
}

function IdentityEditor({ identity, readBlocked }: { identity: WorkspaceIdentity; readBlocked: boolean }) {
  const t = useText()
  const action = useAction()
  const original = action.unknownCommand?.commandType === "UpdateWorkspaceIdentity" && action.unknownCommand.targetId === identity.workspaceId ? action.unknownCommand : null
  const [draft, setDraft] = useDraftState<IdentityDraft>("settings-workspace-identity", "draft", () => {
    const initial = identityDraft(identity)
    if (!original) return initial
    const payload = updateWorkspaceIdentityPayloadSchema.safeParse(original.payload)
    return payload.success ? { ...payload.data, version: original.expectedVersions?.[identity.workspaceId] ?? initial.version, pendingCommandId: original.commandId } : initial
  })
  const [submitting, setSubmitting] = useState(false)
  const [saved, setSaved] = useState(false)
  const [validationError, setValidationError] = useState(false)
  const conflict = identity.version > draft.version
  const awaitingSnapshot = identity.version < draft.version
  const dirty = draft.name !== identity.name || draft.icon !== identity.icon || draft.color !== identity.color
  const locked = action.locked || submitting || !!draft.pendingCommandId && action.receipt?.commandId === draft.pendingCommandId
  useEffect(() => {
    const receipt = action.receipt
    if (!draft.pendingCommandId || receipt?.commandId !== draft.pendingCommandId || action.unknownCommand?.commandId === draft.pendingCommandId) return
    if (receipt.status === "committed") {
      const parsed = workspaceIdentitySchema.safeParse(receipt.result)
      if (!parsed.success || parsed.data.workspaceId !== identity.workspaceId) return
      setDraft(identityDraft(parsed.data))
      setSaved(true)
    } else {
      setDraft(previous => ({ ...previous, pendingCommandId: null }))
      setSaved(false)
    }
  }, [action.receipt, action.unknownCommand, draft.pendingCommandId, identity.workspaceId, setDraft])
  const change = (patch: Partial<IdentityDraft>) => {
    setDraft(previous => ({ ...previous, ...patch }))
    setSaved(false)
    setValidationError(false)
    action.setError(null)
  }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (locked || readBlocked || conflict || awaitingSnapshot || !dirty) return
    const payload = updateWorkspaceIdentityPayloadSchema.safeParse({ name: draft.name, icon: draft.icon, color: draft.color })
    setValidationError(!payload.success)
    if (!payload.success) return
    const commandId = crypto.randomUUID()
    setDraft(previous => ({ ...previous, pendingCommandId: commandId }))
    setSaved(false)
    setSubmitting(true)
    try {
      await action.run(() => action.execute({ commandId, commandType: "UpdateWorkspaceIdentity", targetId: identity.workspaceId, expectedVersions: { [identity.workspaceId]: draft.version }, payload: payload.data }))
    } finally { setSubmitting(false) }
  }
  return <div className="space-y-5">
    <SettingsNotice>{t("仅工作区级 access.manage 可以保存。普通草稿按账号和工作区保留在当前应用会话内；刷新会清除普通草稿。未知请求由原 commandId 的持久收据日志恢复，不自动重发。", "Only workspace-scoped access.manage can save. Ordinary drafts are retained per account and workspace in this app session, not across reloads. Unknown requests recover through the original commandId in the persistent receipt journal and are never resent automatically.")}</SettingsNotice>
    <CommandNotice />
    {conflict && <div role="status" className="space-y-3 rounded-module border p-4 text-sm"><p>{t("服务端资料已更新；你的完整草稿及原版本仍保留。请比较后明确选择，系统不会合并或自动重试。", "The saved identity changed. Your complete draft and original version remain intact. Compare before choosing; nothing is merged or retried automatically.")}</p><div className="flex items-center gap-3"><WorkspaceIdentityBadge icon={identity.icon} color={identity.color} /><span className="min-w-0 break-words">{identity.name} · {identity.icon} · {identity.color}</span></div><p>{t("草稿 / 服务版本", "Draft / saved version")}: {draft.version} / {identity.version}</p><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={locked || readBlocked} onClick={() => change({ version: identity.version, pendingCommandId: null })}>{t("保留完整草稿，采用最新版本", "Keep complete draft, use latest version")}</Button><Button type="button" variant="ghost" disabled={locked || readBlocked} onClick={() => change(identityDraft(identity))}>{t("放弃草稿，读取服务值", "Discard draft, load saved values")}</Button></div></div>}
    {awaitingSnapshot && <p role="status" className="text-sm">{t("等待服务端快照追上已确认版本；此时不能再次提交。", "Waiting for the snapshot to reach the confirmed version; another save is blocked.")}</p>}
    <form noValidate className="space-y-5" onSubmit={event => { void submit(event) }}><IdentityFields value={draft} disabled={locked} onChange={change} />{validationError && <p role="alert" className="text-sm text-destructive">{t("请输入 1–200 个字符的名称，并选择支持的图标与颜色。", "Enter a name of 1–200 characters and choose a supported icon and color.")}</p>}{action.localError && !action.error && <p role="alert" className="text-sm text-destructive">{action.localError}</p>}{saved && <p role="status" className="text-sm">{t("工作区资料已通过服务端原命令收据确认保存。", "Workspace identity was saved and confirmed by the original server command receipt.")}</p>}<div className="flex flex-wrap gap-2"><Button type="submit" loading={submitting || action.pending} disabled={locked || readBlocked || conflict || awaitingSnapshot || !dirty}>{t("保存工作区资料", "Save workspace identity")}</Button>{dirty && !conflict && <Button type="button" variant="ghost" disabled={locked || readBlocked || awaitingSnapshot} onClick={() => change(identityDraft(identity))}>{t("放弃完整草稿", "Discard complete draft")}</Button>}</div></form>
  </div>
}

export function ServiceWorkspaceIdentity() {
  const query = useWorkspaceIdentity()
  const { workspace } = usePmService()
  const t = useText()
  const identity = query.data
  return <div className="space-y-6">
    {query.isPending && <p role="status" className="text-sm">{t("正在读取工作区资料…", "Loading workspace identity…")}</p>}
    {query.isFetching && identity && <p role="status" className="text-sm">{t("正在刷新资料；未保存草稿不会被覆盖。", "Refreshing identity; unsaved drafts will not be overwritten.")}</p>}
    {query.error && <div role="alert" className="space-y-3 text-sm"><p>{identity ? t("快照可能已过期：", "The snapshot may be stale: ") : ""}{query.error.message}</p><Button variant="outline" disabled={query.isFetching} onClick={() => { void query.refetch() }}>{t("重试读取", "Retry read")}</Button></div>}
    {identity && <>{allowed(workspace, "access.manage") ? <IdentityEditor identity={identity} readBlocked={!!query.error || query.isFetching} /> : <><SettingsNotice>{t("当前账号没有工作区级 access.manage，只能读取已保存资料。", "This account has no workspace-scoped access.manage and can only read saved identity.")}</SettingsNotice><IdentityFields value={identity} disabled /></>}<StableIdentity workspaceId={identity.workspaceId} /></>}
  </div>
}
