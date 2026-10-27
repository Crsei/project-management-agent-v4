import type { AgentChatToolCall, AgentChatToolEntity } from "@contracts"

export type ToolIconKey = "read" | "search" | "create" | "edit" | "comment" | "relation" | "file" | "terminal" | "git" | "tool"
export type ToolObject = "task" | "project" | "document" | "comment" | "relation" | "search" | "unknown"

export type ToolPresentation = {
  actionZh: string
  actionEn: string
  icon: ToolIconKey
  write: boolean
  object: ToolObject
  nounZh?: string
  nounEn?: string
}

export type ToolTarget = { id: string | null; title: string | null; object: ToolObject }

export type FieldChange = {
  field: string
  zh: string
  en: string
  before: unknown
  after: unknown
  knownBefore: boolean
  verified: boolean
}

export type ToolTone = "running" | "success" | "warning" | "danger"

/**
 * Presentation registry: every tool gets a verb, an icon and the entity kind it
 * operates on. The UI composes "verb + entity noun + target" from this table,
 * so a new tool only needs one entry rather than a bespoke card.
 */
const registry: Record<string, ToolPresentation> = {
  pm_query: { actionZh: "搜索", actionEn: "Search", icon: "search", write: false, object: "search", nounZh: "工作项", nounEn: "work items" },
  pm_read: { actionZh: "读取", actionEn: "Read", icon: "read", write: false, object: "unknown" },
  pm_create_project: { actionZh: "创建", actionEn: "Create", icon: "create", write: true, object: "project" },
  pm_update_project: { actionZh: "更新", actionEn: "Update", icon: "edit", write: true, object: "project" },
  pm_create_task: { actionZh: "创建", actionEn: "Create", icon: "create", write: true, object: "task" },
  pm_update_task: { actionZh: "更新", actionEn: "Update", icon: "edit", write: true, object: "task" },
  pm_create_document: { actionZh: "创建", actionEn: "Create", icon: "create", write: true, object: "document" },
  pm_save_document: { actionZh: "保存", actionEn: "Save", icon: "file", write: true, object: "document" },
  pm_read_comments: { actionZh: "读取", actionEn: "Read", icon: "comment", write: false, object: "comment" },
  pm_create_comment: { actionZh: "添加", actionEn: "Add", icon: "comment", write: true, object: "comment" },
  pm_read_relations: { actionZh: "读取", actionEn: "Read", icon: "relation", write: false, object: "relation" },
  pm_add_relation: { actionZh: "添加", actionEn: "Add", icon: "relation", write: true, object: "relation" },
  pm_remove_relation: { actionZh: "移除", actionEn: "Remove", icon: "relation", write: true, object: "relation" },
  file_read: { actionZh: "读取", actionEn: "Read", icon: "file", write: false, object: "unknown", nounZh: "文件", nounEn: "file" },
  file_edit: { actionZh: "修改", actionEn: "Edit", icon: "edit", write: true, object: "unknown", nounZh: "文件", nounEn: "file" },
  shell_exec: { actionZh: "运行", actionEn: "Run", icon: "terminal", write: true, object: "unknown", nounZh: "终端命令", nounEn: "terminal command" },
  git_diff: { actionZh: "检查", actionEn: "Inspect", icon: "git", write: false, object: "unknown", nounZh: "代码变更", nounEn: "code changes" },
}

const generic: ToolPresentation = { actionZh: "调用", actionEn: "Call", icon: "tool", write: false, object: "unknown", nounZh: "工具", nounEn: "tool" }

const objectNouns: Record<Exclude<ToolObject, "unknown">, { zh: string; en: string }> = {
  task: { zh: "任务", en: "task" },
  project: { zh: "项目", en: "project" },
  document: { zh: "文档", en: "document" },
  comment: { zh: "评论", en: "comment" },
  relation: { zh: "关系", en: "relation" },
  search: { zh: "工作项", en: "work items" },
}

export function toolPresentation(name: string): ToolPresentation {
  return registry[name] ?? generic
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function resultEntity(call: AgentChatToolCall): AgentChatToolEntity | undefined {
  return call.result?.items.find(item => "entity" in item) as AgentChatToolEntity | undefined
}

function objectOfEntity(entity: AgentChatToolEntity["entity"]): ToolObject {
  return entity === "work_item" ? "task" : entity
}

export function toolTarget(call: AgentChatToolCall): ToolTarget {
  const entity = resultEntity(call)
  const args = call.arguments
  const presentation = toolPresentation(call.name)
  const object = presentation.object !== "unknown" ? presentation.object : entity ? objectOfEntity(entity.entity) : "unknown"
  if (call.name === "pm_query") return { id: text(args.query) || text(args.projectId) || null, title: null, object }
  const explicit = text(args.id) || text(args.taskId) || text(args.sourceId)
  const id = entity?.id || explicit || (presentation.object === "project" ? text(args.projectId) : null)
  const title = entity?.title || (call.name.startsWith("pm_create_") ? text(args.title) : null)
  return { id, title, object }
}

/** Human label such as "读取任务" / "Update task"; the row adds the target id. */
export function toolLabel(call: AgentChatToolCall, target: ToolTarget, t: (zh: string, en: string) => string): string {
  const presentation = toolPresentation(call.name)
  const noun = presentation.nounZh
    ? { zh: presentation.nounZh, en: presentation.nounEn ?? presentation.nounZh }
    : target.object === "unknown" ? null : objectNouns[target.object]
  return t(`${presentation.actionZh}${noun?.zh ?? ""}`, `${presentation.actionEn}${noun ? ` ${noun.en}` : ""}`)
}

const fields: { key: string; zh: string; en: string }[] = [
  { key: "title", zh: "标题", en: "Title" },
  { key: "goal", zh: "目标", en: "Goal" },
  { key: "description", zh: "描述", en: "Description" },
  { key: "assigneeId", zh: "负责人", en: "Assignee" },
  { key: "priority", zh: "优先级", en: "Priority" },
  { key: "startDate", zh: "开始日期", en: "Start date" },
  { key: "dueDate", zh: "截止日期", en: "Due date" },
  { key: "labels", zh: "标签", en: "Labels" },
]

function currentValue(item: AgentChatToolEntity | undefined, key: string): unknown {
  if (!item) return undefined
  if (key === "title") return item.title
  if (key === "description") return item.body
  if (key === "goal") return item.fields?.goal
  if (key === "assigneeId") return item.fields?.assigneeId
  if (key === "priority") return item.fields?.priority
  if (key === "startDate") return item.fields?.startDate
  if (key === "dueDate") return item.fields?.dueDate
  if (key === "labels") return item.fields?.labels
  return undefined
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) return JSON.stringify(left) === JSON.stringify(right)
  return (left ?? null) === (right ?? null)
}

/**
 * Only fields explicitly present in the update arguments are considered.
 * `null` means unchanged; empty string clears an optional field. A prior read
 * in the same assistant turn supplies the before value; it is never guessed
 * from the update arguments or from a later entity state.
 */
export function toolChanges(call: AgentChatToolCall, previousRead?: AgentChatToolEntity): FieldChange[] {
  if (call.name === "pm_save_document") {
    if (!Object.hasOwn(call.arguments, "body")) return []
    const after = text(call.arguments.body)
    const completeBefore = previousRead?.entity === "document" && previousRead.body !== undefined
      && (previousRead.bodyOffset ?? 0) === 0 && previousRead.nextBodyOffset == null
    return [{
      field: "body", zh: "正文", en: "Body",
      before: completeBefore ? previousRead?.body : undefined,
      after,
      knownBefore: completeBefore && previousRead?.body !== undefined,
      verified: false,
    }]
  }
  if (!["pm_update_task", "pm_update_project"].includes(call.name)) return []
  const result = resultEntity(call)
  const changes: FieldChange[] = []
  for (const field of fields) {
    if (!Object.hasOwn(call.arguments, field.key)) continue
    const raw = call.arguments[field.key]
    if (raw === null) continue
    const after = raw === "" ? null : raw
    const before = currentValue(previousRead, field.key)
    const bodyComplete = field.key !== "description"
      || (previousRead !== undefined && (previousRead.bodyOffset ?? 0) === 0 && previousRead.nextBodyOffset == null)
    const knownBefore = previousRead !== undefined && before !== undefined && bodyComplete
    if (knownBefore && sameValue(before, after)) continue
    const actual = currentValue(result, field.key)
    // Update responses omit bodies, so a description cannot be verified from them.
    const verified = field.key === "description" ? false : sameValue(actual, after)
    changes.push({ field: field.key, zh: field.zh, en: field.en, before, after, knownBefore, verified })
  }
  return changes
}

export function previousReadEntity(calls: AgentChatToolCall[], index: number, targetId: string | null): AgentChatToolEntity | undefined {
  if (!targetId) return undefined
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = calls[cursor]
    if (candidate.name !== "pm_read" || text(candidate.arguments.id) !== targetId) continue
    const entity = resultEntity(candidate)
    if (entity) return entity
  }
  return undefined
}

export function toolStatusLabel(call: AgentChatToolCall, t: (zh: string, en: string) => string): { label: string; tone: ToolTone } {
  if (call.status === "running") return { label: t("执行中", "Running"), tone: "running" }
  if (call.status === "failed") return { label: t("失败", "Failed"), tone: "danger" }
  if (call.status === "unknown") return { label: t("结果待核对", "Outcome unknown"), tone: "warning" }
  const presentation = toolPresentation(call.name)
  if (!presentation.write) {
    if (call.name === "pm_query") return { label: t("已搜索", "Searched"), tone: "success" }
    if (call.name === "pm_read_comments") return { label: t("已读取评论", "Comments read"), tone: "success" }
    if (call.name === "pm_read_relations") return { label: t("已读取关系", "Relations read"), tone: "success" }
    if (call.name === "git_diff") return { label: t("已检查", "Inspected"), tone: "success" }
    return { label: t("已读取", "Read"), tone: "success" }
  }
  const item = resultEntity(call)
  if (!item) return { label: t("已提交，结果待核对", "Submitted; result unverified"), tone: "warning" }
  if (call.name === "pm_create_task" || call.name === "pm_create_project" || call.name === "pm_create_document") return { label: t("已创建", "Created"), tone: "success" }
  if (call.name === "pm_create_comment") return { label: t("已添加", "Added"), tone: "success" }
  if (call.name === "pm_add_relation") return { label: t("已添加", "Added"), tone: "success" }
  if (call.name === "pm_remove_relation") return { label: t("已移除", "Removed"), tone: "success" }
  if (call.name === "pm_save_document") return { label: t("已保存", "Saved"), tone: "success" }
  return { label: t("已更新", "Updated"), tone: "success" }
}

export function toolEffectLabel(call: AgentChatToolCall, changes: FieldChange[], t: (zh: string, en: string) => string): { label: string; tone: ToolTone } {
  if (call.status !== "succeeded") return toolStatusLabel(call, t)
  if (changes.length > 0 && changes.every(change => change.verified)) return { label: t("已写入并核对", "Written and verified"), tone: "success" }
  return toolStatusLabel(call, t)
}

/** One compact line of context shown after the action and target. */
export function toolSummary(call: AgentChatToolCall, changes: FieldChange[], t: (zh: string, en: string) => string): string {
  if (call.status === "running") return t("正在执行", "In progress")
  if (call.status === "failed") return call.error?.code ?? t("调用失败", "Call failed")
  if (call.status === "unknown") return t("需要核对原操作", "Reconcile original operation")
  if (changes.length > 0) {
    const names = changes.map(change => t(change.zh, change.en)).join(t("、", ", "))
    return t(`${names}已更新 · ${changes.length} 个字段`, `${names} updated · ${changes.length} field${changes.length === 1 ? "" : "s"}`)
  }
  if (toolPresentation(call.name).write) {
    if (call.name === "pm_create_comment" || call.name === "pm_add_relation") return t("已添加", "Added")
    if (call.name.startsWith("pm_create_")) return t("已创建", "Created")
    if (call.name === "pm_remove_relation") return t("已移除", "Removed")
    if (call.name === "pm_save_document") return t("已保存", "Saved")
    if (call.name.startsWith("pm_update_")) return t("无字段变更", "No field changes")
    return t("已提交", "Submitted")
  }
  const count = call.result?.items.length ?? 0
  if (call.name === "pm_query") return count > 0 ? t(`找到 ${count} 项`, `${count} result${count === 1 ? "" : "s"}`) : t("无匹配结果", "No results")
  if (call.name === "pm_read_comments") return t(`${count} 条评论`, `${count} comment${count === 1 ? "" : "s"}`)
  if (call.name === "pm_read_relations") return t(`${count} 条关系`, `${count} relation${count === 1 ? "" : "s"}`)
  return count > 0 ? t(`${count} 项结果`, `${count} result${count === 1 ? "" : "s"}`) : t("无结果", "No results")
}

/** Compact, single-line preview; full values stay in the linked entity. */
export function formatToolValue(value: unknown, t: (zh: string, en: string) => string): string {
  if (value === null || value === undefined || value === "") return t("未设置", "Not set")
  if (Array.isArray(value)) return value.length ? value.join(", ") : t("未设置", "Not set")
  const normalized = String(value).replace(/\s+/g, " ").trim()
  return normalized.length > 120 ? `${normalized.slice(0, 120)}… (${normalized.length} ${t("字符", "chars")})` : normalized
}

/** Technical arguments are secondary output; never surface credentials or full bodies. */
export function redactToolArguments(args: Record<string, unknown>): Record<string, unknown> {
  const sensitive = /(token|secret|password|authorization|cookie|api[-_]?key|credential|session)/i
  return Object.fromEntries(Object.entries(args).map(([key, value]) => {
    if (sensitive.test(key)) return [key, "[redacted]"]
    if (typeof value === "string" && value.length > 160) return [key, `${value.slice(0, 160)}…`]
    return [key, value]
  }))
}
