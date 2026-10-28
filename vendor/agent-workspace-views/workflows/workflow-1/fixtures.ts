import type {
  CanvasDocument,
  CanvasNodeDefinition,
} from "@easyuse-ui/ui/lib/canvas-model"
import type { ComposerDemoSource } from "../../demo-source"
import type { Copy } from "../../model"

export type StepKind =
  "input" | "agent" | "decision" | "approval" | "code" | "quality"
export const stepCopy: Record<
  string,
  { title: Copy; description: Copy; owner: Copy; tasks: Copy[] }
> = {
  brief: {
    title: { "zh-CN": "发布简报", en: "Release brief" },
    description: {
      "zh-CN": "收集范围、约束和目标发布窗口。",
      en: "Collect scope, constraints, and the target release window.",
    },
    owner: { "zh-CN": "产品负责人", en: "Product lead" },
    tasks: [
      { "zh-CN": "记录发布目标", en: "Capture release goal" },
      { "zh-CN": "附加验收标准", en: "Attach acceptance criteria" },
    ],
  },
  research: {
    title: { "zh-CN": "研究依赖", en: "Research dependencies" },
    description: {
      "zh-CN": "梳理受影响的包、路由和兼容性约束。",
      en: "Map affected packages, routes, and compatibility constraints.",
    },
    owner: { "zh-CN": "研究代理", en: "Research agent" },
    tasks: [
      { "zh-CN": "检查仓库结构", en: "Inspect repository map" },
      { "zh-CN": "检查包契约", en: "Check package contracts" },
    ],
  },
  decision: {
    title: { "zh-CN": "风险决策", en: "Risk decision" },
    description: {
      "zh-CN": "选择标准或受保护的实施路径。",
      en: "Choose the standard or guarded implementation path.",
    },
    owner: { "zh-CN": "流程路由器", en: "Workflow router" },
    tasks: [],
  },
  implement: {
    title: { "zh-CN": "实施变更", en: "Implement changes" },
    description: {
      "zh-CN": "使用现有仓库模式实施已批准的计划。",
      en: "Apply the approved plan using existing repository patterns.",
    },
    owner: { "zh-CN": "实施代理", en: "Implementation agent" },
    tasks: [
      { "zh-CN": "更新共享原语", en: "Update shared primitives" },
      { "zh-CN": "添加路由集成", en: "Add route integration" },
    ],
  },
  approval: {
    title: { "zh-CN": "人工审批", en: "Human approval" },
    description: {
      "zh-CN": "暂停高风险迁移，等待审阅者明确确认。",
      en: "Pause risky migrations for explicit reviewer confirmation.",
    },
    owner: { "zh-CN": "发布负责人", en: "Release owner" },
    tasks: [],
  },
  verify: {
    title: { "zh-CN": "验证与发布", en: "Verify and publish" },
    description: {
      "zh-CN": "运行定向检查、汇总证据并准备发布。",
      en: "Run focused checks, summarize evidence, and prepare release.",
    },
    owner: { "zh-CN": "验证代理", en: "Verification agent" },
    tasks: [
      { "zh-CN": "运行定向测试", en: "Run targeted tests" },
      { "zh-CN": "准备发布摘要", en: "Prepare release summary" },
    ],
  },
}
export const kindLabels: Record<StepKind, Copy> = {
  input: { "zh-CN": "输入", en: "Input" },
  agent: { "zh-CN": "代理", en: "Agent" },
  decision: { "zh-CN": "路由", en: "Routing" },
  approval: { "zh-CN": "检查点", en: "Checkpoint" },
  code: { "zh-CN": "代码", en: "Code" },
  quality: { "zh-CN": "质量", en: "Quality" },
}
export const definitions: CanvasNodeDefinition[] = (
  Object.keys(kindLabels) as StepKind[]
).map((type) => ({
  type,
  label: kindLabels[type].en,
  category: "Release workflow",
  ports: [
    ...(type === "input"
      ? []
      : [
          {
            id: "in",
            label: "",
            direction: "input" as const,
            type: "object" as const,
          },
        ]),
    ...(type === "quality"
      ? []
      : [
          {
            id: "out",
            label: "",
            direction: "output" as const,
            type: "object" as const,
          },
        ]),
  ],
  defaults: {
    description: "",
    owner: "",
    condition: "risk == high",
    required: true,
  },
  fields: [
    {
      key: "description",
      label: "Instructions",
      kind: "textarea" as const,
      required: true,
    },
    { key: "owner", label: "Owner", kind: "text" as const, required: true },
  ],
  summary: (node) => String(node.config.description),
}))
export function createWorkflow(scenario = "default"): CanvasDocument {
  const ids = [
    "brief",
    "research",
    "decision",
    "implement",
    "approval",
    "verify",
  ]
  const types: StepKind[] = [
    "input",
    "agent",
    "decision",
    "code",
    "approval",
    "quality",
  ]
  const positions = [
    { x: 0, y: 120 },
    { x: 340, y: 120 },
    { x: 680, y: 120 },
    { x: 1020, y: 20 },
    { x: 1020, y: 250 },
    { x: 1370, y: 120 },
  ]
  return {
    schemaVersion: 1,
    id: "guarded-release",
    revision: 0,
    frames: [],
    notes: [],
    nodes:
      scenario === "empty"
        ? []
        : ids.map((id, index) => ({
            id,
            type: types[index],
            title: stepCopy[id].title.en,
            position: positions[index],
            config: {
              description: stepCopy[id].description.en,
              owner: stepCopy[id].owner.en,
              condition: "risk == high",
              required: true,
              tasks: stepCopy[id].tasks.map((task) => task.en),
            },
          })),
    edges:
      scenario === "empty"
        ? []
        : [
            ["brief", "research"],
            ["research", "decision"],
            ["decision", "implement"],
            ["decision", "approval"],
            ["approval", "verify"],
            ["implement", "verify"],
          ].map(([source, target]) => ({
            id: `${source}-${target}`,
            source,
            sourcePort: "out",
            target,
            targetPort: "in",
          })),
  }
}
export const initialPrompt: Copy = {
  "zh-CN":
    "创建一个从探索到验证的受保护发布流程。我需要一条可视化路径，在执行前能够检查并调整。",
  en: "Create a guarded release workflow from discovery through verification. I need a visual route I can inspect and adjust before anything runs.",
}
export const initialReply: Copy = {
  "zh-CN":
    "我创建了一个可编辑的流程，包含风险分支、明确的审批检查点和共享验证输出。打开工作区以移动步骤、检查配置或添加另一条路径。",
  en: "I created an editable workflow with a risk branch, an explicit approval checkpoint, and a shared verification output. Open the workspace to move steps, inspect configuration, or add another route.",
}
export function composerSource(scenario: string): ComposerDemoSource {
  const source: ComposerDemoSource = {
    sessions: [
      {
        id: "workflow-thread",
        projectId: "release",
        title: { "zh-CN": "受保护发布流程", en: "Guarded release workflow" },
        messages:
          scenario === "empty"
            ? []
            : [
                { id: "request", role: "user", text: initialPrompt },
                { id: "workspace", role: "assistant", text: initialReply },
              ],
      },
    ],
    selectedId: "workflow-thread",
    projectId: "release",
    drafts: {},
    projects: [{ id: "release", name: "Release workflow" }],
    models: ["5.6 Sol", "5.5", "5.4 Mini"],
    contextItems: [
      {
        id: "brief",
        name: "release-brief.md",
        description: {
          "zh-CN": "范围与验收标准",
          en: "Scope and acceptance criteria",
        },
        kind: { "zh-CN": "本地引用", en: "Local reference" },
      },
      {
        id: "contracts",
        name: "package-contracts.md",
        description: {
          "zh-CN": "包依赖与兼容性",
          en: "Package dependencies and compatibility",
        },
        kind: { "zh-CN": "本地引用", en: "Local reference" },
      },
    ],
    suggestions: [],
    reply: {
      "zh-CN": "已记录为本地流程讨论，没有调用外部模型或运行流程。",
      en: "Recorded in the local workflow discussion. No external model was called and no workflow was run.",
    },
    canSend: scenario !== "readonly" && scenario !== "loading",
    initialReadingPosition: "start",
  }
  if (scenario === "long-content")
    source.sessions[0].messages.push(
      ...Array.from({ length: 16 }, (_, index) => ({
        id: `review-${index}`,
        role: "assistant" as const,
        text: {
          "zh-CN": `发布检查 ${index + 1}：保留审批检查点，核对依赖与可回滚条件，并在发布之前检查所有验收证据。`,
          en: `Release review ${index + 1}: preserve the approval checkpoint, inspect dependencies and rollback constraints, and review all acceptance evidence before publishing.`,
        },
      })),
    )
  return source
}
