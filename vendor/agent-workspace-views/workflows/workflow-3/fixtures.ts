import type { ComposerDemoSource } from "../../demo-source"
import type { Copy } from "../../model"

export const text = (zh: string, en: string): Copy => ({ "zh-CN": zh, en })
export type ReviewNodeId = "planner" | "researcher" | "implementer" | "tester" | "reviewer" | "approval" | "published"
export type ReviewNode = {
  id: ReviewNodeId
  kind: Copy
  title: Copy
  description: Copy
  owner: string
  duration: string
  position: { x: number; y: number }
  tool?: string
  file?: string
  tasks: Copy[]
  evidence: Copy
}
export const reviewNodes: ReviewNode[] = [
  { id: "planner", kind: text("规划 Agent", "Planning agent"), title: text("规划发布迁移", "Plan release migration"), description: text("将请求拆分为可验证的工作流和检查点。", "Break the request into verifiable workstreams and checkpoints."), owner: "Planner", duration: "18.2s", position: { x: 0, y: 220 }, tasks: [text("梳理需求", "Map requirements"), text("分配工作流", "Assign workstreams")], evidence: text("范围与职责映射：研究和实现拥有独立任务，审批依赖两路证据。", "Scope and ownership map: research and implementation own independent tasks; approval depends on both evidence streams.") },
  { id: "researcher", kind: text("研究 Agent", "Research agent"), title: text("审计依赖", "Audit dependencies"), description: text("独立验证包契约和迁移风险。", "Verify package contracts and migration risks independently."), owner: "Researcher", duration: "31.4s", position: { x: 350, y: 70 }, tool: "search", file: "package.json", tasks: [text("核实依赖契约", "Verify dependency contracts"), text("记录迁移风险", "Record migration risks")], evidence: text("依赖审计：运行时适配器须保留断线和未知结果语义。", "Dependency audit: the runtime adapter must preserve disconnect and unknown-outcome semantics.") },
  { id: "implementer", kind: text("实现 Agent", "Implementation agent"), title: text("应用迁移", "Apply migration"), description: text("实现限定范围的更改并记录受影响界面。", "Implement the scoped changes and record touched surfaces."), owner: "Implementer", duration: "42.6s", position: { x: 350, y: 370 }, tool: "apply_patch", file: "src/lib/runtime-adapter.ts", tasks: [text("应用初始更改", "Apply initial change"), text("审阅后重开适配器", "Reopen adapter after review")], evidence: text("修订补丁：未知结果不再被当作成功；补丁范围仅涉及运行时适配器。", "Revision patch: unknown outcomes are no longer treated as success; the patch is scoped to the runtime adapter.") },
  { id: "tester", kind: text("验证 Agent", "Verification agent"), title: text("验证契约", "Verify contracts"), description: text("对两条并行工作流运行定向检查。", "Run focused checks against both parallel workstreams."), owner: "Tester", duration: "36.8s", position: { x: 720, y: 70 }, tool: "pnpm test", tasks: [text("检查依赖边界", "Check dependency boundaries"), text("验证修订路径", "Verify revision path")], evidence: text("示例检查记录：覆盖断线、保留草稿和未知结果确认路径。这不是本仓库测试结果。", "Fixture check record: covers disconnect, retained drafts, and unknown-outcome reconciliation. This is not a test result for this repository.") },
  { id: "reviewer", kind: text("审阅 Agent", "Review agent"), title: text("审阅变更界面", "Review changed surfaces"), description: text("比较声明范围与实际文件，并请求一次返工。", "Compare declared scope with observed files and request one revision."), owner: "Reviewer", duration: "27.3s", position: { x: 720, y: 370 }, tool: "diff", file: "src/lib/runtime-adapter.ts", tasks: [text("请求一次修订", "Request one revision"), text("复查修订证据", "Review revised evidence")], evidence: text("审阅发现：实现曾把未知结果标记为成功。实现 Agent 完成修订，审阅 Agent 复查后汇入审批。", "Review finding: implementation marked an unknown outcome as success. The implementer revised it, and the reviewer rechecked the evidence before approval.") },
  { id: "approval", kind: text("人工检查点", "Human checkpoint"), title: text("批准发布", "Approve release"), description: text("发布前审阅每个 Agent 提供的证据。", "Review evidence from every agent before publishing the run."), owner: "Rakesh", duration: "22.7s", position: { x: 1090, y: 220 }, tasks: [text("汇合验证与审阅证据", "Converge verification and review evidence"), text("人工批准", "Human approval")], evidence: text("历史示例审批：Rakesh 在两路证据汇合、返工关闭后批准发布。", "Historical fixture approval: Rakesh approved after both evidence streams converged and the revision was closed.") },
  { id: "published", kind: text("运行产物", "Run output"), title: text("发布就绪", "Release ready"), description: text("所有必需证据已附上，受控路径已完成。", "All required evidence is attached and the guarded path completed."), owner: "Workflow system", duration: "0.0s", position: { x: 1450, y: 220 }, tasks: [], evidence: text("本地示例发布包：职责、依赖审计、补丁、验证、审阅和人工批准。未执行真实发布。", "Local fixture release packet: ownership, dependency audit, patch, verification, review, and human approval. No real release was executed.") },
]
export const handoffs: { source: ReviewNodeId; target: ReviewNodeId; revision?: boolean }[] = [
  { source: "planner", target: "researcher" }, { source: "planner", target: "implementer" },
  { source: "researcher", target: "tester" }, { source: "implementer", target: "reviewer" },
  { source: "tester", target: "approval" }, { source: "reviewer", target: "approval" },
  { source: "approval", target: "published" }, { source: "reviewer", target: "implementer", revision: true },
]
export const stages = [text("规划", "Plan"), text("并行工作", "Parallel work"), text("验证", "Verification"), text("返工", "Revision"), text("审批", "Approval"), text("发布", "Release")]
export const workflowTitle = text("Workflow 3 · 多 Agent 审阅", "Workflow 3 · Multi-agent review")
export function createComposerSource(): ComposerDemoSource {
  return {
    sessions: [{ id: "workflow-3-thread", projectId: "release", title: workflowTitle, messages: [
      { id: "request", role: "user", text: text("展示 Agent 如何交接工作、实现在哪里被重开，以及哪些证据到达了最终审批。", "Show me how the agents handed work off, where the implementation was reopened, and what evidence reached the final approval.") },
      { id: "summary", role: "assistant", text: text("已完成的示例运行保留了并行职责、审阅到实现的返工循环，以及审批处汇合的证据。你可以回放路径，而不丢失最终审计状态。", "The completed run preserves parallel ownership, the reviewer-to-implementer revision loop, and the evidence that converged at approval. You can replay the route without losing the final audit state.") },
    ] }], selectedId: "workflow-3-thread", projectId: "release", drafts: {}, projects: [{ id: "release", name: "Release migration" }],
    contextItems: [{ id: "run", name: "Release migration · run review", kind: text("运行记录", "Run record"), description: text("职责、返工和审批证据", "Ownership, revision, and approval evidence") }],
    models: ["GPT-5.6 Sol", "Claude Sonnet 4.6", "Gemini 3.1 Pro"], suggestions: [], reply: text("本地审阅笔记已记录。", "Local review note recorded."), canSend: true,
  }
}
