import { useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { z } from "zod"
import { ApiError, type Command } from "@contracts"
import type { FileRecord, WorkspaceSnapshot } from "@pm-schema"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { TaskCreationSurface } from "../markdown/TaskCreationSurface"
import { ApiError as CoreApiError } from "../markdown/api"
import { useCoreSession, useCreationDrafts, useSessionDrafts } from "../markdown/session"
import { usePmCommand, usePmService, usePrivateQuery } from "./pm-service"
import { useTeamWorkload } from "./pm-team-hooks"
import { CommandNotice, Form, allowed, useDraftState, useText, uuid } from "./pm-ui"
import { useProjectTaskEditing } from "./project-task-editing"
import { hasUncertainProjectTaskDraft, readProjectTaskDraft } from "./project-task-editing-model"
import { parseTeamPointsInput, teamCapacityExpected, type TeamCapacityBaseline } from "./team-task-actions-model"
import { hasUncertainCreationDrafts } from "../markdown/creation-model"

function useTeamTaskSources() {
  const session = useCoreSession()
  // usePrivateQuery appends the same membership version and actor epoch as CoreSession.
  return usePrivateQuery<WorkspaceSnapshot>(session.queryKey.slice(0, -2), "domain.read", undefined, async (_client, _workspaceId, signal) => {
    try { return await session.api.workspace(signal) }
    catch (cause) {
      if (cause instanceof CoreApiError && [401, 403, 404].includes(cause.status)) throw new ApiError(cause.status, { error: { code: cause.status === 401 ? "unauthenticated" : "not_found_or_forbidden", message: cause.message } })
      throw cause
    }
  })
}

type MemberTaskActionsProps = {
  userId: string | null
  memberName?: string | null
  membershipId?: string
  capacity?: number | null
  capacityVersion?: number | null
  canManageCapacity?: boolean
  onChanged?: () => void
}

/** Member cards and the unassigned pool share the same real creation surface. */
export function TeamMemberTaskActions({ userId, memberName, canManageCapacity, onChanged }: MemberTaskActionsProps) {
  const service = usePmService()
  const t = useText()
  const [open, setOpen] = useDraftState<"create" | "capacity" | null>(`team-task-actions:${userId ?? "unassigned"}`, "open", null)
  const canCreate = service.capabilities?.business.enabled === true && !!service.workspace?.capabilities.includes("planning.edit") && !!service.workspace.capabilities.includes("domain.read")
  const canSetCapacity = userId !== null && canManageCapacity !== false && service.capabilities?.business.enabled === true && allowed(service.workspace, "access.manage")
  return <div className="flex flex-wrap items-center gap-2" onClick={event => event.stopPropagation()}>
    <Button size="sm" variant="outline" disabled={!canCreate} onClick={() => setOpen("create")}>{t("添加任务", "Add task")}</Button>
    {canSetCapacity && <Button size="sm" variant="ghost" onClick={() => setOpen("capacity")}>{t("设置容量", "Set capacity")}</Button>}
    <Dialog open={open !== null} onOpenChange={value => { if (!value) setOpen(null) }}><DialogContent className={open === "create" ? "max-w-xl" : undefined}>
      <DialogTitle>{open === "capacity" ? t("成员并行工作容量", "Member concurrent-work capacity") : t("创建并分配任务", "Create and assign task")}</DialogTitle>
      <DialogDescription>{open === "capacity" ? t("容量使用并行未完成工作估算点，不是周工时。", "Capacity uses concurrent unfinished-work estimate points, not weekly hours.") : t("选择实际可写项目；统一写入 Markdown，不自动开始或完成任务。", "Choose an authorized writable project. Shared Markdown creation never starts or completes the task.")}</DialogDescription>
      <DialogBody>{open === "create" && <TeamMemberTaskCreate memberId={userId} memberName={memberName} onCreated={onChanged} onClose={() => setOpen(null)} />}{open === "capacity" && userId && <TeamMemberCapacityEditor memberId={userId} memberName={memberName} onSaved={onChanged} onClose={() => setOpen(null)} />}</DialogBody>
    </DialogContent></Dialog>
  </div>
}

/** Retain the original command recovery protocol; never turn an unknown command into a native create. */
export function TeamMemberTaskCreate({ memberId, memberName, onCreated, onClose }: { memberId: string | null; memberName?: string | null; onCreated?: () => void; onClose?: () => void }) {
  const command = usePmCommand()
  const t = useText()
  const scope = `team-task-create:${memberId ?? "unassigned"}`
  const original = command.unknownCommand?.commandType === "CreateWorkItem" && (command.unknownCommand.payload.assigneeId ?? null) === memberId ? command.unknownCommand : null
  const [attemptId, setAttemptId] = useDraftState<string | null>(scope, "attemptId", original?.commandId ?? null)
  const handled = useRef<string | null>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    const receipt = command.receipt
    if (!attemptId || command.unknownCommand?.commandId === attemptId || receipt?.commandId !== attemptId || handled.current === receipt.commandId) return
    handled.current = receipt.commandId
    setAttemptId(null)
    if (receipt.status !== "committed") return
    setSaved(true); onCreated?.(); onClose?.()
  }, [attemptId, command.receipt, command.unknownCommand, onClose, onCreated, setAttemptId])
  return <div className="space-y-4">
    <CommandNotice />
    <p className="text-sm">{t("入口默认负责人（恢复草稿保留原选择）：", "Default assignee context (resumed drafts keep their selection): ")}{memberId === null ? t("未分配任务池", "Unassigned task pool") : memberName ?? memberId}</p>
    {original && <p role="status" className="break-words text-sm">{t("旧创建命令仍待核对：", "The original creation command still needs reconciliation: ")}{original.commandId} · {original.payload.title}</p>}
    {command.pending || command.unknownCommand ? <p role="status">{t("请先用上方原 PM 命令收据入口核对；不会改走原生创建或生成新请求键。", "Use the original PM command receipt above first. No native creation or replacement request key is issued.")}</p> : !saved && <TaskCreationSurface mode="dialog" initial={{ assignee: memberId ?? "" }} onCreated={() => { setSaved(true); onCreated?.(); onClose?.() }} onClose={onClose} />}
    {saved && <p role="status">{t("任务已确认创建；负责人和项目均由服务端校验。", "Task creation is confirmed; the server validated assignee and project.")}</p>}
  </div>
}

export function TeamTaskEstimateEditor({ workItemId, onSaved, onClose }: { workItemId: string; onSaved?: () => void; onClose?: () => void }) {
  const sources = useTeamTaskSources()
  const t = useText()
  const file = sources.data?.files.find(candidate => candidate.id === workItemId && candidate.entity.entity === "work_item")
  if (sources.error) return <div role="alert" className="space-y-2"><p>{sources.error.message}</p><Button variant="outline" onClick={() => { void sources.refetch() }}>{t("重新读取任务", "Read task again")}</Button></div>
  if (!sources.data) return <p role="status">{t("正在读取任务原文件…", "Reading the authoritative task source…")}</p>
  if (!file?.entity.project) return <p role="alert">{t("此任务原文件不可访问或无合法项目。", "This task source is inaccessible or has no valid project.")}</p>
  return <TaskEstimateForm key={workItemId} file={file} onSaved={onSaved} onClose={onClose} />
}

function TaskEstimateForm({ file, onSaved, onClose }: { file: FileRecord; onSaved?: () => void; onClose?: () => void }) {
  const editing = useProjectTaskEditing(file.entity.project!)
  const command = usePmCommand()
  const session = useCoreSession()
  const queryClient = useQueryClient()
  const t = useText()
  const native = editing.drafts[file.id]
  const foreignFields = !!native && Object.keys(native.changes).some(key => key !== "x-pm-estimate")
  const initial = native && Object.hasOwn(native.changes, "x-pm-estimate") ? native.changes["x-pm-estimate"] : file.entity["x-pm-estimate"]
  const [local, setLocal] = useDraftState(`team-task-estimate:${file.id}`, "input", () => ({ input: typeof initial === "number" ? String(initial) : "", revision: native?.revision ?? file.revision }))
  const [saved, setSaved] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const conflict = local.revision !== file.revision || native?.phase === "conflict"
  const recovering = native?.phase === "unknown" || native?.phase === "observed"
  const problem = editing.problem(file.id)
  const canRecover = !editing.pending && !command.pending && !command.unknownCommand && !foreignFields
  return <div className="space-y-4">
    <CommandNotice />
    <p className="text-sm">{file.entity.title} · {file.id}</p>
    <p className="text-xs text-muted-foreground">{t("并行未完成工作估算点；空白为未知，0 是明确零。最大 1,000,000 点。", "Concurrent unfinished-work estimate points. Blank means unknown; 0 is explicit zero. Maximum 1,000,000 points.")}</p>
    {foreignFields && <p role="alert">{t("此任务已有其他字段草稿；请在完整任务编辑器中处理，估算编辑不会提交其他字段或任务状态。", "This task already has a draft for other fields. Resolve it in the full task editor; estimate editing will not submit other fields or task status.")}</p>}
    {problem && <p role="status" className="text-sm">{problem}</p>}
    {(editing.error || localError) && <p role="alert" className="text-sm text-destructive">{localError ?? editing.error}</p>}
    {editing.diagnostics.length > 0 && <ul className="text-sm">{editing.diagnostics.map((issue, index) => <li key={`${issue.code}:${index}`}>{issue.field ? `${issue.field}: ` : ""}{issue.message}</li>)}</ul>}
    {native?.message && <p role="status" className="text-sm">{native.message}</p>}
    {(conflict || recovering) && <div className="space-y-2 rounded border p-3 text-sm"><p>{t("原草稿和 revision 保留；当前服务估算：", "Original draft and revision retained. Current source estimate: ")}{typeof file.entity["x-pm-estimate"] === "number" ? String(file.entity["x-pm-estimate"]) : t("未知", "Unknown")}</p>
      {native?.phase === "unknown" ? <Button variant="outline" disabled={!canRecover} onClick={() => { void editing.reconcile(file.id).catch(() => undefined) }}>{t("读取原任务核对结果", "Read original task to reconcile")}</Button> : <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={!canRecover} onClick={() => {
        if (native) editing.adoptCurrent(file.id)
        const retained = readProjectTaskDraft(session.drafts.getSnapshot()[file.id])
        if (native && retained?.phase !== "editing") return
        setLocal({ ...local, revision: retained?.revision ?? file.revision }); setLocalError(null); setSaved(false)
      }}>{t("保留点数草稿，采用当前 revision", "Keep point draft, adopt current revision")}</Button><Button variant="ghost" disabled={!canRecover} onClick={() => { if (native) editing.discardDraft(file.id); if (readProjectTaskDraft(session.drafts.getSnapshot()[file.id])) return; setLocal({ input: typeof file.entity["x-pm-estimate"] === "number" ? String(file.entity["x-pm-estimate"]) : "", revision: file.revision }); setLocalError(null) }}>{t("放弃草稿，保留服务值", "Discard draft, keep source value")}</Button></div>}
    </div>}
    <Form label={t("保存估算点", "Save estimate points")} disabled={!!problem || conflict || recovering || foreignFields} onSubmit={async () => {
      if (!editing.canEdit(file.id) || foreignFields || local.revision !== file.revision) throw new Error(t("任务已变化或不可写；草稿保留。", "The task changed or is read-only; the draft is retained."))
      const points = parseTeamPointsInput(local.input)
      editing.change(file.id, { "x-pm-estimate": points })
      const retained = readProjectTaskDraft(session.drafts.getSnapshot()[file.id])
      if (!retained || Object.keys(retained.changes).some(key => key !== "x-pm-estimate") || retained.changes["x-pm-estimate"] !== points) throw new Error(t("无法准备估算草稿；没有发送写入。", "Could not prepare the estimate draft; no write was sent."))
      await editing.save(file.id)
      const savedFile = queryClient.getQueryData<WorkspaceSnapshot>(session.queryKey)?.files.find(candidate => candidate.id === file.id)
      if (savedFile) setLocal({ input: points === null ? "" : String(points), revision: savedFile.revision })
      setSaved(true); setLocalError(null)
      onSaved?.(); onClose?.()
    }}>
      <label className="grid gap-1 text-sm"><span>{t("估算点（留空清除）", "Estimate points (blank to clear)")}</span><Input type="number" min={0} max={1_000_000} step="any" inputMode="decimal" value={local.input} onChange={event => {
        const input = event.target.value
        setLocal({ ...local, input }); setSaved(false); setLocalError(null)
        if (foreignFields || conflict || !editing.canEdit(file.id)) return
        try { editing.change(file.id, { "x-pm-estimate": parseTeamPointsInput(input) }) } catch (cause) { setLocalError(cause instanceof Error ? cause.message : String(cause)) }
      }} /></label>
    </Form>
    {saved && <p role="status">{t("估算点已确认写入 Markdown。", "Estimate points confirmed saved to Markdown.")}</p>}
  </div>
}

type CapacityEditorProps = { memberId: string; memberName?: string | null; capacity?: number | null; capacityVersion?: number | null; capacityRecordId?: string | null; onSaved?: () => void; onClose?: () => void }
export function TeamMemberCapacityEditor({ memberId, memberName, onSaved, onClose }: CapacityEditorProps) {
  const workload = useTeamWorkload()
  const t = useText()
  const member = workload.data?.members.find(row => row.userId === memberId)
  if (workload.error) return <div role="alert" className="space-y-2"><p>{workload.error.message}</p><Button variant="outline" onClick={() => { void workload.refetch() }}>{t("重新读取容量", "Read capacity again")}</Button></div>
  if (!workload.data) return <p role="status">{t("正在读取成员当前容量记录…", "Reading the member's current capacity record…")}</p>
  if (!member) return <p role="alert">{t("此成员已不可访问或不再有效。", "This member is inaccessible or no longer active.")}</p>
  return <MemberCapacityForm key={memberId} memberId={memberId} memberName={memberName} current={member.capacity} onSaved={() => { void workload.refetch(); onSaved?.() }} onClose={onClose} />
}

function MemberCapacityForm({ memberId, memberName, current, onSaved, onClose }: { memberId: string; memberName?: string | null; current: TeamCapacityBaseline; onSaved: () => void; onClose?: () => void }) {
  const service = usePmService()
  const command = usePmCommand()
  const [sourceDrafts] = useSessionDrafts()
  const [creationDrafts] = useCreationDrafts()
  const session = useCoreSession()
  const t = useText()
  const scope = `team-capacity:${memberId}`
  const original = command.unknownCommand?.commandType === "SetMemberCapacity" && command.unknownCommand.payload.userId === memberId ? command.unknownCommand : null
  const [base, setBase] = useDraftState<TeamCapacityBaseline>(scope, "base", () => original?.targetId && original.expectedVersions?.[original.targetId] !== undefined ? { id: original.targetId, version: original.expectedVersions[original.targetId], capacityPoints: current?.capacityPoints ?? null } : original ? null : current)
  const [input, setInput] = useDraftState(scope, "points", () => { const points = original ? original.payload.capacityPoints : current?.capacityPoints; return typeof points === "number" ? String(points) : "" })
  const [attemptId, setAttemptId] = useDraftState<string | null>(scope, "attemptId", original?.commandId ?? null)
  const [saved, setSaved] = useState(false)
  const [receiptError, setReceiptError] = useState<string | null>(null)
  const handled = useRef<string | null>(null)
  const conflict = base?.id !== current?.id || base?.version !== current?.version
  const uncertain = hasUncertainProjectTaskDraft(sourceDrafts) || hasUncertainCreationDrafts(creationDrafts)
  const permitted = service.capabilities?.business.enabled === true && allowed(service.workspace, "access.manage") && !service.error
  const locked = !permitted || command.pending || !!command.unknownCommand || uncertain

  useEffect(() => {
    const receipt = command.receipt
    if (!attemptId || command.unknownCommand?.commandId === attemptId || receipt?.commandId !== attemptId || handled.current === receipt.commandId) return
    handled.current = receipt.commandId
    setAttemptId(null)
    if (receipt.status !== "committed") return
    const result = z.object({ id: uuid, version: z.number().int().positive(), data: z.object({ userId: uuid, capacityPoints: z.number().finite().min(0).max(1_000_000).nullable() }) }).safeParse(receipt.result)
    if (!result.success || result.data.data.userId !== memberId) { setReceiptError(t("原命令已提交，但结果记录无法解析。请重新读取容量；不要重复提交。", "The original command committed, but its result record could not be read. Refresh capacity; do not submit it again.")); return }
    setBase({ id: result.data.id, version: result.data.version, capacityPoints: result.data.data.capacityPoints })
    setInput(result.data.data.capacityPoints === null ? "" : String(result.data.data.capacityPoints))
    setSaved(true); setReceiptError(null)
    onSaved(); onClose?.()
  }, [attemptId, command.receipt, command.unknownCommand, memberId, onClose, onSaved, setAttemptId, setBase, setInput, t])

  return <div className="space-y-4"><CommandNotice />
    <p className="text-sm">{memberName ?? memberId}</p>
    <p className="text-xs text-muted-foreground">{t("并行未完成工作估算点，不是周工时。空白表示未知/清除，0 表示明确没有容量。允许 0–1,000,000 点。", "Concurrent unfinished-work estimate points, not weekly hours. Blank means unknown/clear; 0 explicitly means no capacity. Allowed: 0–1,000,000 points.")}</p>
    {!permitted && <p role="status">{t("需要无限制工作区的成员管理权限；团队维护者职责不授予此权限。", "Unrestricted workspace access.manage is required. Team maintainer duties do not grant this permission.")}</p>}
    {uncertain && <p role="status">{t("请先核对结果未知的原生任务写入。", "Reconcile the uncertain native task write first.")}</p>}
    {receiptError && <p role="alert">{receiptError}</p>}
    {conflict && <div role="status" className="space-y-2 rounded border p-3 text-sm"><p>{t("容量记录已变化，原草稿和版本保留。当前容量：", "The capacity record changed; your draft and original version are retained. Current capacity: ")}{current?.capacityPoints ?? t("未知", "Unknown")}</p><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={locked} onClick={() => { setBase(current); setReceiptError(null); setSaved(false) }}>{t("保留草稿，采用当前记录版本", "Keep draft, adopt current record version")}</Button><Button variant="ghost" disabled={locked} onClick={() => { setBase(current); setInput(current?.capacityPoints === null || !current ? "" : String(current.capacityPoints)); setReceiptError(null); setSaved(false) }}>{t("放弃草稿，读取服务值", "Discard draft, load saved value")}</Button></div></div>}
    <Form label={t("保存成员容量", "Save member capacity")} disabled={locked || conflict || !!receiptError} onSubmit={async () => {
      if (!allowed(service.workspace, "access.manage") || service.capabilities?.business.enabled !== true || base?.id !== current?.id || base?.version !== current?.version || hasUncertainProjectTaskDraft(session.drafts.getSnapshot()) || hasUncertainCreationDrafts(session.creationDrafts.getSnapshot())) throw new Error(t("权限或容量版本已变化；没有发送写入。", "Permission or capacity version changed; no write was sent."))
      const request: Command<"SetMemberCapacity"> = { commandId: crypto.randomUUID(), commandType: "SetMemberCapacity", ...teamCapacityExpected(base), payload: { userId: uuid.parse(memberId), capacityPoints: parseTeamPointsInput(input) } }
      setAttemptId(request.commandId); handled.current = null; setSaved(false)
      await command.execute(request)
    }}><label className="grid gap-1 text-sm"><span>{t("容量估算点（留空清除）", "Capacity estimate points (blank to clear)")}</span><Input type="number" min={0} max={1_000_000} step="any" inputMode="decimal" value={input} onChange={event => { setInput(event.target.value); setSaved(false) }} /></label></Form>
    {saved && <p role="status">{t("成员容量已确认保存。", "Member capacity confirmed saved.")}</p>}
  </div>
}
