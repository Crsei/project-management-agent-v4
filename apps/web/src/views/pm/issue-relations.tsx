import { WorkItemAssigneePicker, WorkItemStatePicker } from "@/components/blocks/work-item-properties"
import { isMutationLocked, type MutationState } from "@/lib/work-items-model"
import { useI18n } from "@/lib/i18n-provider"
import type { ControlledIssueCapabilities, ControlledIssueCatalog, ControlledIssuePatch, ControlledIssueRecord } from "./controlled-contracts"

const none = "__pm_none__"
export function IssueRelationFields({ item, catalog, capabilities, mutation, onPatch, fields = ["projectId", "moduleIds", "cycleId", "estimatePointId"] }: {
  item: ControlledIssueRecord
  catalog: ControlledIssueCatalog
  capabilities: ControlledIssueCapabilities
  mutation?: MutationState
  onPatch: (item: ControlledIssueRecord, patch: ControlledIssuePatch) => void
  fields?: readonly ("projectId" | "moduleIds" | "cycleId" | "estimatePointId")[]
}) {
  const { locale } = useI18n()
  const text = (zh: string, en: string) => locale === "en" ? en : zh
  const disabled = (field: "projectId" | "moduleIds" | "cycleId" | "estimatePointId") => isMutationLocked(mutation) || !capabilities.canEditRelation(item, field)
  const label = { projectId: text("项目", "Project"), moduleIds: text("模块", "Modules"), cycleId: text("周期", "Cycle"), estimatePointId: text("估点", "Estimate") }
  return <div className="grid gap-3" data-pm-issue-facts>{fields.map((field) => <div key={field} className="min-w-0 text-xs"><span className="text-muted-foreground">{label[field]}</span>{field === "moduleIds" ? <WorkItemAssigneePicker label={`${label[field]} ${item.identifier}`} value={item.moduleIds} options={catalog.modules.filter((entry) => entry.projectId === item.projectId)} disabled={disabled(field)} onChange={(moduleIds) => onPatch(item, { moduleIds })} /> : <WorkItemStatePicker label={`${label[field]} ${item.identifier}`} value={item[field] ?? none} options={field === "projectId" ? catalog.projects : [{ id: none, label: text("无", "None") }, ...(field === "cycleId" ? catalog.cycles : catalog.estimatePoints).filter((entry) => entry.projectId === item.projectId)]} disabled={disabled(field)} onChange={(value) => onPatch(item, { [field]: value === none ? null : value })} />}</div>)}</div>
}
