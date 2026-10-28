import type { CanvasDocument, CanvasNodeDefinition } from "@easyuse-ui/ui/lib/canvas-model"
import type { ComposerDemoSource } from "../../demo-source"
import type { Copy } from "../../model"

export const workflowSteps = [
  { id: "context", category: { "zh-CN": "上下文", en: "Context" }, title: { "zh-CN": "读取项目上下文", en: "Read project context" }, description: { "zh-CN": "根据当前仓库理解所请求的变更。", en: "Resolve the requested change against the current repository." }, tool: "read", file: "AGENTS.md", owner: "Codex", duration: "1.2s", position: { x: 0, y: 130 } },
  { id: "map", category: { "zh-CN": "研究", en: "Research" }, title: { "zh-CN": "定位受影响的界面", en: "Map affected surfaces" }, description: { "zh-CN": "检查路由、组件及其最近的设计模式。", en: "Inspect routes, components, and their nearest design patterns." }, tool: "search", file: "src/components/ai-chat", owner: "Codex", duration: "3.8s", position: { x: 340, y: 130 } },
  { id: "build", category: { "zh-CN": "实现", en: "Implementation" }, title: { "zh-CN": "构建工作流组件", en: "Build workflow primitives" }, description: { "zh-CN": "组合仓库原生画布、节点、连线与面板组件。", en: "Compose repository-native canvas, node, edge, and panel blocks." }, tool: "apply_patch", file: "src/components/ai-elements/node.tsx", owner: "Codex", duration: "00:18", position: { x: 680, y: 130 } },
  { id: "tests", category: { "zh-CN": "验证", en: "Verification" }, title: { "zh-CN": "运行定向检查", en: "Run focused checks" }, description: { "zh-CN": "验证行为、响应布局与类型集成。", en: "Validate behavior, responsiveness, and typed integrations." }, owner: "Verification agent", duration: "4.2s", position: { x: 1020, y: 30 }, checklist: [{ "zh-CN": "检查变更文件", en: "Lint changed files" }, { "zh-CN": "验证交互", en: "Exercise interactions" }] },
  { id: "review", category: { "zh-CN": "审阅", en: "Review" }, title: { "zh-CN": "视觉质量审阅", en: "Visual quality review" }, description: { "zh-CN": "检查间距、连线对齐、主题与移动布局。", en: "Inspect spacing, edge alignment, themes, and mobile behavior." }, owner: "Design reviewer", duration: "4.2s", position: { x: 1020, y: 260 } },
  { id: "complete", category: { "zh-CN": "输出", en: "Output" }, title: { "zh-CN": "发布验证证据", en: "Publish evidence" }, description: { "zh-CN": "总结变更并将验证证据附到执行记录。", en: "Summarize changes and attach validation evidence to the run." }, owner: "Release owner", duration: "4.2s", position: { x: 1370, y: 130 } },
] satisfies { id: string; category: Copy; title: Copy; description: Copy; tool?: string; file?: string; owner: string; duration: string; position: { x: number; y: number }; checklist?: Copy[] }[]

export const workflowEdges = [
  ["context", "map"], ["map", "build"], ["build", "tests"],
  ["build", "review"], ["tests", "complete"], ["review", "complete"],
] as const

/** Observed activity is distinct from the declared node presentation. */
export const observedActivities: Record<string, { tool: string; file: string }> = {
  context: { tool: "read", file: "AGENTS.md" },
  map: { tool: "search", file: "src/components/ai-chat" },
  build: { tool: "apply_patch", file: "src/components/ai-elements/node.tsx" },
  tests: { tool: "pnpm lint", file: "src/components/ai-chat/ai-workflow-canvas.tsx" },
}

export const workflowDefinitions: CanvasNodeDefinition[] = [{
  type: "execution-step", label: "Workflow step", category: "Workflow",
  defaults: {}, ports: [
    { id: "in", label: "Input", direction: "input", type: "object" },
    { id: "out", label: "Output", direction: "output", type: "object" },
  ],
}]

export function createWorkflowDocument(): CanvasDocument {
  return {
    schemaVersion: 1, id: "workflow-2-local", revision: 1,
    nodes: workflowSteps.map(step => ({ id: step.id, type: "execution-step", title: step.title.en, position: { ...step.position }, config: {} })),
    edges: workflowEdges.map(([source, target]) => ({ id: `${source}-${target}`, source, target, sourcePort: "out", targetPort: "in" })),
    frames: [], notes: [],
    viewport: { x: -87, y: 219, zoom: 0.55 },
  }
}

export function createWorkflowSource(scenario: string): ComposerDemoSource {
  const messages = scenario === "empty" ? [] : [
    { id: "workflow-2-request", role: "user" as const, text: { "zh-CN": "运行工作流并保持执行过程可见。我想知道哪个步骤正在执行、正在使用什么工具，以及正在修改哪个文件。", en: "Run the workflow and keep the execution visible. I want to know which step is active, what tool it is using, and which file it is touching." } },
    { id: "workflow-2-answer", role: "assistant" as const, text: { "zh-CN": "执行图将声明的工作流进度与观察到的工具和文件活动分开。执行推进时，活动路径随之移动，每个节点保留自己的证据。", en: "The execution map separates declared workflow progress from observed tool and file activity. The active route moves as the run advances, while each node retains its evidence." } },
  ]
  if (scenario === "long-content") {
    for (let i = 0; i < 12; i++) messages.push({ id: `workflow-2-history-${i}`, role: "assistant", text: { "zh-CN": `历史记录 ${i + 1}：检查节点依赖、工具参数与文件活动；每个事件独立保留执行状态与证据。`, en: `History ${i + 1}: Inspect node dependencies, tool arguments and file activity; every event retains its own execution status and evidence.` } })
  }
  return {
    initialReadingPosition: "start", sessions: [{ id: "workflow-2", projectId: "workflow", title: { "zh-CN": "Workflow 2 · 实时执行", en: "Workflow 2 · Live execution" }, messages }],
    selectedId: "workflow-2", projectId: "workflow", drafts: { "workflow-2": { text: "", contextIds: [], model: "5.6 Sol", blocks: false } },
    projects: [{ id: "workflow", name: "Workflow" }],
    contextItems: [{ id: "workflow", name: "workflow.json", description: { "zh-CN": "本地工作流定义", en: "Local workflow definition" }, kind: { "zh-CN": "工作流", en: "Workflow" } }, { id: "agents", name: "AGENTS.md", description: { "zh-CN": "仓库上下文示例", en: "Repository context fixture" }, kind: { "zh-CN": "文件", en: "File" } }],
    models: ["5.6 Sol", "5.5", "5.4 Mini"], suggestions: [],
    reply: { "zh-CN": "已将请求添加到本地工作流线程。此页面只演示工具与文件活动，不执行仓库操作。", en: "Your request has been added to the local workflow thread. This page demonstrates tool and file activity; no repository operations are executed." },
    canSend: scenario !== "readonly" && scenario !== "loading",
  }
}
