import type { ThreadWorkspace, WorkspaceAgent } from "@agent-workspace/contracts/workspace";

export const WORKSPACE_STORAGE_KEY = "agent-workspace:live-workspaces:v1";
export const WORKSPACE_BACKUP_KEY = `${WORKSPACE_STORAGE_KEY}:backup`;
export const WORKSPACE_IMPORT_KEY = `${WORKSPACE_STORAGE_KEY}:imported`;
export type WorkspaceStorage = { version: 1; threads: Record<string, ThreadWorkspace> };
export const emptyWorkspace: ThreadWorkspace = {
  revision: 0,
  agents: [],
  workflows: [],
  documents: [],
  skills: [],
  runs: [],
  activeAgentId: null,
};

export function agentInstructions(agent: WorkspaceAgent, state: ThreadWorkspace) {
  return [
    agent.system,
    ...state.skills
      .filter((skill) => agent.skillIds.includes(skill.id))
      .map((skill) => `技能：${skill.name}\n${skill.instructions}`),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function documentContext(state: ThreadWorkspace) {
  return state.documents
    .filter((doc) => doc.included)
    .map((doc) => `参考文档：${doc.title}\n${doc.content}`)
    .join("\n\n---\n\n");
}

export function loadWorkspaces(): {
  data: WorkspaceStorage;
  error: string | null;
  blocked: boolean;
} {
  const empty: WorkspaceStorage = { version: 1, threads: {} };
  let raw: string | null;
  try {
    raw = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (raw && localStorage.getItem(WORKSPACE_BACKUP_KEY) === null) {
      localStorage.setItem(WORKSPACE_BACKUP_KEY, raw);
    }
  } catch {
    return {
      data: empty,
      error: "旧工作区读取或备份失败，尚未迁移。原始浏览器数据没有被覆盖。",
      blocked: true,
    };
  }
  if (!raw) return { data: empty, error: null, blocked: false };
  try {
    const data: WorkspaceStorage = JSON.parse(raw);
    if (
      data.version !== 1 ||
      !data.threads ||
      typeof data.threads !== "object" ||
      Array.isArray(data.threads)
    )
      throw new Error("版本或结构不正确");
    for (const [threadId, state] of Object.entries(data.threads)) {
      if (
        !state ||
        ![state.agents, state.workflows, state.documents, state.skills, state.runs].every(
          Array.isArray,
        )
      )
        throw new Error("会话工作区结构不正确");
      if (!(state.activeAgentId === null || typeof state.activeAgentId === "string"))
        throw new Error("Agent 选择损坏");
      state.revision ??= 0;
      for (const agent of state.agents) {
        if (
          !agent ||
          typeof agent.id !== "string" ||
          typeof agent.name !== "string" ||
          typeof agent.system !== "string" ||
          typeof agent.model !== "string" ||
          !agent.model.trim() ||
          (agent.providerInstanceId !== undefined &&
            typeof agent.providerInstanceId !== "string") ||
          !Array.isArray(agent.skillIds) ||
          !agent.skillIds.every((id) => typeof id === "string") ||
          (agent.input !== undefined && typeof agent.input !== "string")
        )
          throw new Error("Agent 数据损坏");
        // Preserve the old implicit identity for historical data only; it is inert until explicitly reselected.
        if (typeof agent.providerInstanceId !== "string" || !agent.providerInstanceId.trim())
          agent.providerInstanceId = "deepseek";
      }
      for (const skill of state.skills)
        if (
          !skill ||
          typeof skill.id !== "string" ||
          typeof skill.name !== "string" ||
          typeof skill.instructions !== "string"
        )
          throw new Error("技能数据损坏");
      for (const doc of state.documents)
        if (
          !doc ||
          typeof doc.id !== "string" ||
          typeof doc.title !== "string" ||
          typeof doc.content !== "string" ||
          typeof doc.included !== "boolean"
        )
          throw new Error("文档数据损坏");
      for (const workflow of state.workflows)
        if (
          !workflow ||
          typeof workflow.id !== "string" ||
          typeof workflow.name !== "string" ||
          (workflow.input !== undefined && typeof workflow.input !== "string") ||
          !Array.isArray(workflow.steps) ||
          !workflow.steps.every(
            (step) =>
              step &&
              typeof step.id === "string" &&
              typeof step.name === "string" &&
              typeof step.agentId === "string" &&
              typeof step.instruction === "string",
          )
        )
          throw new Error("工作流数据损坏");
      for (const run of state.runs) {
        if (
          !run ||
          typeof run.id !== "string" ||
          typeof run.name !== "string" ||
          typeof run.input !== "string" ||
          typeof run.startedAt !== "string" ||
          !["agent", "workflow"].includes(run.kind) ||
          !["running", "completed", "failed", "cancelled", "interrupted"].includes(run.status) ||
          (run.error !== undefined && typeof run.error !== "string") ||
          !Array.isArray(run.steps) ||
          !run.steps.every(
            (step) =>
              step &&
              typeof step.id === "string" &&
              typeof step.name === "string" &&
              typeof step.agentName === "string" &&
              typeof step.model === "string" &&
              Boolean(step.model.trim()) &&
              (step.providerInstanceId === undefined ||
                typeof step.providerInstanceId === "string") &&
              typeof step.output === "string" &&
              ["pending", "running", "completed", "failed", "cancelled", "interrupted"].includes(
                step.status,
              ) &&
              (step.error === undefined || typeof step.error === "string") &&
              (step.inputTokens === undefined || typeof step.inputTokens === "number") &&
              (step.outputTokens === undefined || typeof step.outputTokens === "number"),
          )
        )
          throw new Error("运行记录损坏");
        run.threadId = threadId;
        if (run.status === "running") {
          run.status = "interrupted";
          run.error = "页面已重新打开，原连接已断开；未确认完成，不会自动重新执行。";
          for (const step of run.steps) if (step.status === "running") step.status = "interrupted";
        }
      }
    }
    return { data, error: null, blocked: false };
  } catch {
    return {
      data: empty,
      error: `旧工作区数据无法读取，已跳过迁移；原始 ${WORKSPACE_STORAGE_KEY} 与备份 ${WORKSPACE_BACKUP_KEY} 均保留，未被覆盖。服务端已有资源仍可继续使用。`,
      blocked: true,
    };
  }
}
