export type Copy = { "zh-CN": string; en: string }
export type TaskStatus = "backlog" | "todo" | "in-progress" | "done"
export type Agent = "Scout" | "Builder" | "Reviewer" | "Verifier"
export type Task = {
  id: string
  title: Copy
  description: Copy
  detail: Copy
  status: TaskStatus
  priority: "low" | "medium" | "high"
  kind: "feature" | "maintenance"
  agent: Agent | null
  dependencies: string[]
  checks: Copy[]
  files: string[]
  runtime: "idle" | "running" | "queued" | "unknown"
  revision: number
}
export const copy = (zh: string, en: string): Copy => ({ "zh-CN": zh, en })
export const statuses: TaskStatus[] = ["backlog", "todo", "in-progress", "done"]
export const statusLabels: Record<TaskStatus, Copy> = {
  backlog: copy("待规划", "Backlog"),
  todo: copy("待办", "Todo"),
  "in-progress": copy("进行中", "In Progress"),
  done: copy("已完成", "Done"),
}
export const agents: Agent[] = ["Scout", "Builder", "Reviewer", "Verifier"]
export const taskFixtures: Task[] = [
  {
    id: "ARC-207",
    title: copy(
      "更新 Agent 运行说明，体现完整执行控制",
      "Update agent run description to reflect full execution control",
    ),
    description: copy(
      "在首次运行前，明确工厂可以更改的内容。",
      "Clarify what the factory can change before the first run starts.",
    ),
    detail: copy(
      "明确说明工作区、命令和文件修改边界。执行前始终显示启动配置，并保留取消操作。",
      "Describe workspace, command, and file modification boundaries. Show launch configuration before dispatch and keep cancellation available.",
    ),
    status: "backlog",
    priority: "low",
    kind: "maintenance",
    agent: null,
    dependencies: [],
    checks: [
      copy("说明执行权限边界", "Explain execution authority"),
      copy("保留启动确认", "Keep launch confirmation"),
    ],
    files: ["src/factory/run-description.tsx"],
    runtime: "idle",
    revision: 1,
  },
  {
    id: "ARC-211",
    title: copy(
      "根据产品简报检查任务依赖图",
      "Check task graph against product brief",
    ),
    description: copy(
      "审查依赖并找出缺失的实现步骤。",
      "Review dependencies and identify missing implementation steps.",
    ),
    detail: copy(
      "逐项核对简报中的交付物，并为实现、审查和验证任务建立无环依赖。",
      "Compare deliverables with the brief and connect implementation, review, and verification tasks without dependency cycles.",
    ),
    status: "backlog",
    priority: "medium",
    kind: "feature",
    agent: "Scout",
    dependencies: ["ARC-201"],
    checks: [
      copy("核对简报范围", "Resolve brief scope"),
      copy("验证无环依赖", "Validate acyclic dependencies"),
    ],
    files: ["src/factory/task-graph.ts"],
    runtime: "idle",
    revision: 1,
  },
  {
    id: "ARC-214",
    title: copy(
      "添加感知分支的启动配置",
      "Add branch-aware launch configuration",
    ),
    description: copy(
      "让操作员选择在当前分支或隔离分支中运行 Agent。",
      "Let operators run an agent in the active branch or an isolated branch.",
    ),
    detail: copy(
      "明确选择当前分支或独立任务分支。新分支需要安全、确定性的名称、可见的基础分支及可选本地工作区；确认运行前不更改仓库。",
      "Add an explicit launch choice between the active branch and an isolated task branch. New branches need a deterministic safe name, a visible base branch, and an optional local workspace without changing the current repository until the run is confirmed.",
    ),
    status: "todo",
    priority: "high",
    kind: "feature",
    agent: "Builder",
    dependencies: ["ARC-201"],
    checks: [
      copy("支持当前和新分支模式。", "Support current and new branch modes."),
      copy(
        "根据任务生成安全分支名称。",
        "Generate a safe branch name from the task.",
      ),
      copy("允许可选的本地工作区。", "Allow an optional local workspace."),
    ],
    files: [
      "src/factory/launch-config.tsx",
      "src/factory/launch-config.test.ts",
    ],
    runtime: "idle",
    revision: 1,
  },
  {
    id: "ARC-218",
    title: copy(
      "在 Agent 交接之间保留对话记忆",
      "Persist conversation memory between agent handoffs",
    ),
    description: copy(
      "当任务从 Builder 移交至 Reviewer 时，保留相关运行上下文。",
      "Keep the relevant run context when a task moves from Builder to Reviewer.",
    ),
    detail: copy(
      "只传递相关上下文；保留选择、任务标识及审查记录，不暴露工作区密钥。",
      "Pass only relevant context and preserve task identity, selection, and review history without exposing workspace secrets.",
    ),
    status: "todo",
    priority: "high",
    kind: "feature",
    agent: "Builder",
    dependencies: ["ARC-214"],
    checks: [
      copy("保留相关上下文", "Retain relevant context"),
      copy("隔离敏感信息", "Isolate sensitive data"),
    ],
    files: ["src/factory/handoff.ts"],
    runtime: "idle",
    revision: 1,
  },
  {
    id: "ARC-220",
    title: copy(
      "禁止生成命令中的空字节参数",
      "Prevent null-byte arguments in generated commands",
    ),
    description: copy(
      "在启动工作区进程前，验证生成的命令输入。",
      "Validate generated command input before a workspace process starts.",
    ),
    detail: copy(
      "拒绝含空字节的参数，并保留校验失败时的命令草稿。运行状态来自固定示例，不连接进程。",
      "Reject arguments containing null bytes and retain the command draft after validation errors. Runtime status is a fixed fixture, not a connected process.",
    ),
    status: "in-progress",
    priority: "high",
    kind: "maintenance",
    agent: "Verifier",
    dependencies: [],
    checks: [
      copy("拒绝空字节", "Reject null bytes"),
      copy("保留原始输入", "Preserve original input"),
    ],
    files: ["src/factory/commands.ts"],
    runtime: "running",
    revision: 1,
  },
  {
    id: "ARC-223",
    title: copy(
      "审查移动端任务检查器行为",
      "Review mobile task inspector behavior",
    ),
    description: copy(
      "验证窄屏下的全屏检查器和启动流程。",
      "Validate the full-screen inspector and launch sequence on narrow screens.",
    ),
    detail: copy(
      "检查关闭后焦点恢复、阅读位置与启动确认；本 Lab 仅验收指定桌面环境。",
      "Review focus restoration, reading position, and launch confirmation; this Lab accepts only the specified desktop environment.",
    ),
    status: "in-progress",
    priority: "medium",
    kind: "maintenance",
    agent: "Reviewer",
    dependencies: [],
    checks: [
      copy("恢复焦点", "Restore focus"),
      copy("保留阅读位置", "Retain reading position"),
    ],
    files: ["src/factory/task-inspector.tsx"],
    runtime: "idle",
    revision: 1,
  },
  {
    id: "ARC-201",
    title: copy(
      "为工厂运行添加仓库上下文",
      "Add repository context to factory runs",
    ),
    description: copy(
      "为每次派发的运行附加所选仓库元数据。",
      "Attach selected repository metadata to each dispatched run.",
    ),
    detail: copy(
      "记录仓库标识和基础分支。任务完成是工作流状态，不代表真实 Provider 已执行。",
      "Record repository identity and base branch. Task completion is a workflow state, not evidence of real Provider execution.",
    ),
    status: "done",
    priority: "medium",
    kind: "feature",
    agent: "Reviewer",
    dependencies: [],
    checks: [
      copy("附加仓库标识", "Attach repository identity"),
      copy("保留基础分支", "Preserve base branch"),
    ],
    files: ["src/factory/repository.ts"],
    runtime: "idle",
    revision: 1,
  },
]
