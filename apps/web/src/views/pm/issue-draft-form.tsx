import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Field } from "@/components/ui/field"
import { WorkItemStatePicker, WorkItemPriorityPicker, WorkItemAssigneePicker } from "@/components/blocks/work-item-properties"
import type { WorkItemOption } from "@/lib/work-items-model"
import { useI18n } from "@/lib/i18n-provider"
import type { ControlledIssueCatalog, IssueDraft } from "./controlled-contracts"

export type IssueDraftFormProps = {
  id: string
  draft: IssueDraft
  catalog: ControlledIssueCatalog
  parentOptions: readonly WorkItemOption[]
  disabled: boolean
  canEdit: (field: keyof IssueDraft) => boolean
  fieldErrors?: Partial<Record<keyof IssueDraft, string>>
  onChange: (draft: IssueDraft) => void
  onSubmit: () => void
  onCancel: () => void
}
/** Host-owned draft; no mount write, fixture default or client-side save outcome. */
export function IssueDraftForm({ id, draft, catalog, parentOptions, disabled, canEdit, fieldErrors, onChange, onSubmit, onCancel }: IssueDraftFormProps) {
  const { locale } = useI18n()
  const en = locale === "en"
  const none = "__pm_none__"
  const options = {
    projectId: catalog.projects,
    stateId: catalog.states,
    priorityId: catalog.priorities,
    parentId: [{ id: none, label: en ? "No parent" : "无父任务" }, ...parentOptions],
    cycleId: [{ id: none, label: en ? "No cycle" : "无周期" }, ...catalog.cycles.filter((entry) => entry.projectId === draft.projectId)],
    estimatePointId: [{ id: none, label: en ? "No estimate" : "无估点" }, ...catalog.estimatePoints.filter((entry) => entry.projectId === draft.projectId)],
  }
  const labels: Record<keyof IssueDraft, string> = { title: en ? "Title" : "标题", description: en ? "Description" : "描述", projectId: en ? "Project" : "项目", stateId: en ? "State" : "状态", priorityId: en ? "Priority" : "优先级", assigneeIds: en ? "Assignees" : "负责人", labelIds: en ? "Labels" : "标签", moduleIds: en ? "Modules" : "模块", cycleId: en ? "Cycle" : "周期", estimatePointId: en ? "Estimate" : "估点", parentId: en ? "Parent" : "父任务", startDate: en ? "Start date" : "开始日期", dueDate: en ? "Due date" : "截止日期" }
  return <form className="grid gap-4" data-pm-controlled-draft onSubmit={(event) => { event.preventDefault(); if (!disabled) onSubmit() }}>
    <Field id={`${id}-title`} label={labels.title} error={fieldErrors?.title} required>{(control) => <Input {...control} value={draft.title} disabled={disabled || !canEdit("title")} onChange={(event) => onChange({ ...draft, title: event.target.value })} />}</Field>
    <Field id={`${id}-description`} label={labels.description} error={fieldErrors?.description}>{(control) => <Textarea {...control} value={draft.description} disabled={disabled || !canEdit("description")} className="min-h-32" onChange={(event) => onChange({ ...draft, description: event.target.value })} />}</Field>
    <div className="grid grid-cols-2 gap-4">
      {(["projectId", "stateId", "priorityId", "parentId", "cycleId", "estimatePointId"] as const).map((field) => { const Picker = field === "priorityId" ? WorkItemPriorityPicker : WorkItemStatePicker; return <Field key={field} id={`${id}-${field}`} label={labels[field]} error={fieldErrors?.[field]}>{(control) => <Picker {...control} label={labels[field]} value={draft[field] ?? none} options={options[field]} disabled={disabled || !canEdit(field)} onChange={(value) => onChange({ ...draft, [field]: value === none ? null : value })} />}</Field> })}
      {(["assigneeIds", "labelIds", "moduleIds"] as const).map((field) => <fieldset key={field} className="min-w-0"><legend className="mb-1 text-sm font-medium">{labels[field]}</legend><WorkItemAssigneePicker label={labels[field]} value={draft[field]} options={field === "assigneeIds" ? catalog.assignees : field === "labelIds" ? catalog.labels : catalog.modules.filter((entry) => entry.projectId === draft.projectId)} disabled={disabled || !canEdit(field)} onChange={(value) => onChange({ ...draft, [field]: value })} />{fieldErrors?.[field] && <p role="alert" className="mt-1 text-xs text-destructive">{fieldErrors[field]}</p>}</fieldset>)}
      {(["startDate", "dueDate"] as const).map((field) => <Field key={field} id={`${id}-${field}`} label={labels[field]} error={fieldErrors?.[field]}>{(control) => <Input {...control} type="date" value={draft[field] ?? ""} disabled={disabled || !canEdit(field)} onChange={(event) => onChange({ ...draft, [field]: event.target.value || null })} />}</Field>)}
    </div>
    <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onCancel}>{en ? "Cancel" : "取消"}</Button><Button type="submit" disabled={disabled}>{en ? "Save" : "保存"}</Button></div>
  </form>
}
