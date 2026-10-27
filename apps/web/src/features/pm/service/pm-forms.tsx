import { z } from "zod"
import type { Entity, CommandType } from "@contracts"
import { Button } from "@/components/ui/button"
import { RichTextEditor } from "../components/rich-text-editor"
import { usePmCommand, usePmService } from "./pm-service"
import { Field, Choice, Form, Panel, useText, string, required, nullableUuid, criterionReference, makeCommand, allowed, useDraftState, entitySchema } from "./pm-ui"

export function WorkItemForm({ projectId, intent, onSaved }: { projectId: string; intent: Entity; onSaved?: (entity: Entity) => void }) {
  const draftScope = `work:${projectId}:${intent.id}`
  const { actor, workspace } = usePmService(); const command = usePmCommand(); const t = useText()
  const [title, setTitle] = useDraftState(draftScope, "title", string(intent.data.summary)); const [description, setDescription] = useDraftState(draftScope, "description", string(intent.data.goal)); const [criteria, setCriteria] = useDraftState<{ id: string; text: string }[]>(draftScope, "criteria", []); const [assignee, setAssignee] = useDraftState(draftScope, "assignee", actor?.id ?? ""); const [priority, setPriority] = useDraftState(draftScope, "priority", "normal")
  return <Form title={t("从已接受意图建项", "Create work from accepted intent")} disabled={command.pending || !!command.unknownCommand || !allowed(workspace, "planning.edit", projectId)} onSubmit={async () => {
    const payload = z.object({
      title: required.max(300),
      description: z.string().max(64000),
      acceptanceCriteria: z.array(z.object({ id: criterionReference, text: required })).max(100),
      assigneeId: nullableUuid,
      priority: z.enum(["low", "normal", "high", "urgent"]),
    }).parse({ title, description, acceptanceCriteria: criteria, assigneeId: assignee, priority })
    const receipt = await command.execute(makeCommand("CreateWorkItemFromIntent", { ...payload, intentId: intent.id, acceptedRevision: Number(intent.data.revision), decisionId: string(intent.data.acceptedDecisionId) }, undefined, projectId))
    if (receipt.status === "committed") onSaved?.(entitySchema.parse(receipt.result))
  }}>
    <Field label={t("标题", "Title")} value={title} onChange={setTitle} required /><RichTextEditor label={t("工作范围 / 描述", "Work scope / description")} value={description} onChange={setDescription} />
    <fieldset className="space-y-2"><legend>{t("验收标准", "Acceptance criteria")}</legend>{criteria.map((criterion, index) => <div key={criterion.id} className="flex items-end gap-2"><Field label={`${t("标准", "Criterion")} ${index + 1}`} value={criterion.text} onChange={value => setCriteria(rows => rows.map(row => row.id === criterion.id ? { ...row, text: value } : row))} required /><Button type="button" variant="outline" onClick={() => setCriteria(rows => rows.filter(row => row.id !== criterion.id))}>{t("移除", "Remove")}</Button></div>)}<Button type="button" variant="outline" onClick={() => setCriteria(rows => [...rows, { id: crypto.randomUUID(), text: "" }])}>{t("添加验收标准", "Add acceptance criterion")}</Button></fieldset>
    <Field label={t("负责人用户 UUID", "Assignee user UUID")} value={assignee} onChange={setAssignee} /><Choice label={t("优先级", "Priority")} value={priority} onChange={setPriority} options={["low", "normal", "high", "urgent"].map(value => ({ value, label: value }))} />
  </Form>
}
export function CoreLifecycle({ entity }: { entity: Entity }) {
  const draftScope = `lifecycle:${entity.id}`
  const { workspace } = usePmService(); const command = usePmCommand(); const t = useText(); const [reason, setReason] = useDraftState(draftScope, "reason", ""); const [operation, setOperation] = useDraftState(draftScope, "operation", "")
  const projectId = entity.kind === "project" ? entity.id : entity.projectId!; const isProject = entity.kind === "project"; const status = string(entity.data.status); const terminal = isProject ? ["completed", "cancelled"].includes(status) : ["done", "cancelled"].includes(status)
  const archived = entity.data.archived === true || Boolean(entity.data.archivedAt)
  const commands: { value: string; label: string; capability: string }[] = []
  if (archived) commands.push({ value: "RestoreArchivedObject", label: t("恢复归档", "Restore archive"), capability: "planning.lifecycle" })
  else {
    if (isProject && status === "planning") commands.push({ value: "ActivateProject", label: t("激活项目", "Activate project"), capability: "planning.lifecycle" })
    if (!isProject && status === "draft") commands.push({ value: "ReadyWorkItem", label: t("就绪", "Ready"), capability: "planning.edit" })
    if (!isProject && status === "ready") commands.push({ value: "StartWorkItem", label: t("开始", "Start"), capability: "planning.edit" })
    if (isProject && status === "active") commands.push({ value: "CompleteProject", label: t("完成项目", "Complete project"), capability: "planning.lifecycle" })
    if (!terminal) commands.push({ value: isProject ? "CancelProject" : "CancelWorkItem", label: t("取消", "Cancel"), capability: isProject ? "planning.lifecycle" : "workitem.cancel_reopen" })
    if (terminal) commands.push({ value: isProject ? "ReopenProject" : "ReopenWorkItem", label: t("重开", "Reopen"), capability: isProject ? "planning.lifecycle" : "workitem.cancel_reopen" }, { value: "ArchiveObject", label: t("归档", "Archive"), capability: "planning.lifecycle" })
  }
  const permitted = commands.filter(option => allowed(workspace, option.capability, projectId)); const selected = permitted.find(option => option.value === operation)?.value ?? permitted[0]?.value ?? ""; const noReason = ["ActivateProject", "ReadyWorkItem", "StartWorkItem"].includes(selected)
  return <Panel title={t("显式生命周期命令", "Explicit lifecycle commands")}>
    <p>{status}{archived ? " · archived" : ""} · v{entity.version}</p>
    {permitted.length ? <Form label={t("执行所选命令", "Execute selected command")} disabled={command.pending || !!command.unknownCommand} onSubmit={async () => {
      const payload: Record<string, unknown> = noReason ? {} : { reason: required.parse(reason) }
      if (selected === "ArchiveObject" || selected === "RestoreArchivedObject") payload.kind = entity.kind
      if (selected === "CompleteProject") payload.criteriaChecks = []
      await command.execute(makeCommand(selected as CommandType, payload as never, entity, projectId))
    }}>
      <Choice label={t("操作", "Operation")} value={selected} onChange={setOperation} options={permitted} />
      {!noReason && <Field label={t("原因", "Reason")} value={reason} onChange={setReason} multiline required />}
    </Form> : <p>{t("没有可用的生命周期权限或操作。", "No available lifecycle permissions or actions.")}</p>}
  </Panel>
}
