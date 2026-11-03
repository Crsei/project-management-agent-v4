import { Link } from "react-router"
import { z } from "zod"
import type { Entity } from "@contracts"
import type { FileRecord } from "@pm-schema"
import { CoreBusinessPanel } from "./pm-core-business-panel"
import { CompletionActions, DeliveryWorkflow } from "./pm-delivery"
import { CoreLifecycle } from "./pm-forms"
import { MilestoneAssignment, PlanningPanel } from "./pm-planning"
import { usePmCommand, usePmEntity, usePmService } from "./pm-service"
import { allowed, CommandNotice, Field, Form, lines, makeCommand, QueryNotice, required, strings, useDraftState, useText } from "./pm-ui"

export { CoreScheduleView, type CoreScheduleViewProps } from "./pm-core-schedule"

export type CoreBusinessSectionsProps = { file: FileRecord }

export function CoreBusinessSections({ file }: CoreBusinessSectionsProps) {
  const { actor, workspace } = usePmService()
  const t = useText()
  const kind = file.entity.entity
  if (kind !== "project" && kind !== "work_item") {
    return <p className="text-sm text-muted-foreground">{t("此类型没有独立的 PM 业务流程。请使用同一详情中的内容、属性与关系。", "This entity type has no separate PM business workflow. Use Content, Properties, and Relations in this same detail.")}</p>
  }
  if (!actor || !workspace) {
    return <p role="status" className="text-sm text-muted-foreground">{t("请先选择可访问的工作区以读取业务操作。", "Select an accessible workspace to load business operations.")}</p>
  }
  if (!workspace.capabilities.includes("domain.read")) {
    return <p className="text-sm text-muted-foreground">{t("当前权限不能读取 PM 业务记录；不会以源文件伪造业务数据。", "Your current permissions cannot read PM business records; source files are not used to fabricate business data.")}</p>
  }
  return <AuthorizedBusinessSections key={`${actor.id}:${workspace.id}:${file.id}`} file={file} kind={kind} />
}

function AuthorizedBusinessSections({ file, kind }: CoreBusinessSectionsProps & { kind: "project" | "work_item" }) {
  const { workspace } = usePmService()
  const t = useText()
  const query = usePmEntity(file.id)
  const record = query.data?.id === file.id && query.data.kind === kind && query.data.workspaceId === workspace?.id ? query.data : undefined
  const sourceReadOnly = !!file.stale || !!file.error || !!file.diagnostics?.some(diagnostic => diagnostic.severity === "error")
  const root = `/pm/${encodeURIComponent(workspace!.id)}`
  return <div className="min-w-0 space-y-4">
    <CommandNotice />
    <QueryNotice query={{ ...query, data: query.data ? [query.data] : undefined }}>
      {!record ? <p className="text-sm text-muted-foreground">{t("此源文件没有可访问的 PM 业务记录。内容、属性与关系仍在同一详情中可用；不会创建额外副本。", "No accessible PM business record exists for this source. Content, Properties, and Relations remain available in this detail; no parallel copy is created.")}</p>
        : <>
          {sourceReadOnly && <p role="alert" className="text-sm text-muted-foreground">{t("源文件存在诊断或陈旧状态；业务操作暂为只读。请在源文件或设置中修复。", "The source has diagnostics or is stale; business operations are read-only until repaired in Source or Settings.")}</p>}
          <fieldset disabled={sourceReadOnly || !!query.error} className="min-w-0 space-y-4">
            <legend className="sr-only">{t("PM 业务操作", "PM business operations")}</legend>
            {kind === "project" ? <>
              <nav aria-label={t("项目工具", "Project tools")} className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
                <Link className="text-primary hover:text-foreground" to={`${root}/projects/${encodeURIComponent(record.id)}/issues`}>{t("项目工作项", "Project work items")}</Link>
                <Link className="text-primary hover:text-foreground" to={`${root}/projects/${encodeURIComponent(record.id)}/events`}>{t("项目排期", "Project schedule")}</Link>
                <Link className="text-primary hover:text-foreground" to={`${root}/whiteboard?projectId=${encodeURIComponent(record.id)}`}>{t("个人本地白板", "Personal local whiteboard")}</Link>
              </nav>
              <fieldset disabled={file.entity.archived === true} className="min-w-0"><PlanningPanel project={record} /></fieldset>
              <CoreBusinessPanel title={t("项目生命周期", "Project lifecycle")}><CoreLifecycle entity={record} /></CoreBusinessPanel>
            </> : <>
              {record.projectId
                ? <fieldset disabled={file.entity.archived === true} className="min-w-0"><DeliveryWorkflow item={record} /></fieldset>
                : <fieldset disabled={file.entity.archived === true} className="min-w-0 space-y-3">
                  <CompletionActions item={record} />
                  <p className="text-sm text-muted-foreground">{t("此工作项尚未关联项目。交付与里程碑需要项目范围，请在属性中设置项目；生命周期与显式完成仍可按权限使用。", "This work item has no project. Set its project in Properties to use delivery and milestones; lifecycle and explicit completion remain available according to your permissions.")}</p>
                </fieldset>}
              <CoreBusinessPanel title={t("里程碑、阻塞与生命周期", "Milestone, blockers, and lifecycle")}>
                <fieldset disabled={file.entity.archived === true} className="min-w-0 space-y-4">
                  {record.projectId && <MilestoneAssignment item={record} />}
                  <WorkItemBlockers item={record} file={file} />
                </fieldset>
                <CoreLifecycle entity={record} />
              </CoreBusinessPanel>
            </>}
          </fieldset>
        </>}
    </QueryNotice>
  </div>
}

function WorkItemBlockers({ item, file }: { item: Entity; file: FileRecord }) {
  const { workspace } = usePmService()
  const command = usePmCommand()
  const t = useText()
  const scope = `core-blockers:${item.id}`
  const [base, setBase] = useDraftState(scope, "base", item)
  const [blockers, setBlockers] = useDraftState(scope, "reasons", strings(file.entity["x-pm-manual-block-reasons"] ?? item.data.manualBlockReasons).join("\n"))
  return <Form title={t("手动阻塞", "Manual blockers")} disabled={command.pending || !!command.unknownCommand || item.data.archived === true || !!item.data.archivedAt || !allowed(workspace, "planning.edit", item.projectId)} onSubmit={async () => {
    await command.execute(makeCommand("SetWorkItemBlockers", { manualBlockReasons: z.array(required).max(100).parse(lines(blockers)) }, base, item.projectId!))
  }}>
    <Field label={t("阻塞原因（每行一项；清空可解除）", "Block reasons (one per line; clear to unblock)")} value={blockers} onChange={setBlockers} multiline />
    <p className="text-sm text-muted-foreground">{t("对象间依赖在同一详情的关系中管理。", "Manage dependencies between entities in Relations in this same detail.")}</p>
    {base.version !== item.version && <div role="alert" className="space-y-2 text-sm">
      <p>{t("业务记录版本已变化；草稿保留，提交仍使用原版本以检测冲突。", "The business record changed; the draft is retained and submits its original version to detect conflicts.")}</p>
      <button type="button" className="font-medium hover:bg-selection" disabled={command.pending} onClick={() => setBase(item)}>{t("采用当前版本并保留草稿", "Use current version, retain draft")}</button>
    </div>}
  </Form>
}
