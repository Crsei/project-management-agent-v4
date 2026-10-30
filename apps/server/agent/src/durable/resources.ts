import { createHash } from "node:crypto";
import type { ThreadWorkspace, WorkspaceRun } from "@agent-workspace/contracts/workspace";
import type { WorkspaceImportResult } from "@agent-workspace/contracts/durable";
import { ensureThread } from "./threads.ts";
import { DurableError } from "./errors.ts";
import { listRecords, readRecord, transaction, writeRecord } from "./store.ts";
import { isObject, text } from "./validation.ts";

export const RUN_NAMESPACE = "durable:runs";
const WORKSPACES = "durable:workspaces";
const IMPORTS = "durable:imports";
export function emptyWorkspace(): ThreadWorkspace {
  return {
    revision: 0,
    agents: [],
    workflows: [],
    documents: [],
    skills: [],
    runs: [],
    activeAgentId: null,
  };
}
export function getWorkspace(threadId: string): ThreadWorkspace {
  ensureThread(threadId);
  const workspace = readRecord<ThreadWorkspace>(WORKSPACES, threadId) ?? emptyWorkspace();
  return {
    ...workspace,
    runs: listRecords<WorkspaceRun>(RUN_NAMESPACE)
      .filter((run) => run.threadId === threadId)
      .reverse(),
  };
}

export function validateResources(
  value: unknown,
  requireRevision = true,
): asserts value is ThreadWorkspace {
  if (!isObject(value))
    throw new DurableError(400, "invalid_workspace", "工作区必须是 JSON 对象。");
  if (requireRevision && (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0))
    throw new DurableError(400, "invalid_revision", "缺少有效的 revision。");
  const limits: Record<string, number> = {
    agents: 200,
    workflows: 200,
    documents: 500,
    skills: 500,
  };
  for (const [field, max] of Object.entries(limits)) {
    const items = value[field];
    if (!Array.isArray(items) || items.length > max)
      throw new DurableError(400, "invalid_workspace", `${field} 超过资源限制。`);
    const ids = new Set<string>();
    for (const item of items) {
      if (!isObject(item) || !text(item.id, 120, true) || ids.has(item.id))
        throw new DurableError(400, "invalid_workspace", `${field} 资源 ID 无效或重复。`);
      ids.add(item.id);
      if (
        field === "agents" &&
        (!text(item.name, 200) ||
          !text(item.model, 200, true) ||
          !text(item.system, 16000) ||
          !Array.isArray(item.skillIds) ||
          item.skillIds.length > 500 ||
          item.skillIds.some((id) => !text(id, 120, true)) ||
          (item.providerInstanceId !== undefined && !text(item.providerInstanceId, 120, true)) ||
          (item.input !== undefined && !text(item.input, 8000)))
      )
        throw new DurableError(400, "invalid_workspace", "Agent 字段无效。");
      if (field === "skills" && (!text(item.name, 200) || !text(item.instructions, 64000)))
        throw new DurableError(400, "invalid_workspace", "Skill 字段无效。");
      if (
        field === "documents" &&
        (!text(item.title, 200) ||
          !text(item.content, 256000) ||
          typeof item.included !== "boolean" ||
          !text(item.updatedAt, 100, true))
      )
        throw new DurableError(400, "invalid_workspace", "文档字段无效。");
      if (field === "workflows") {
        if (
          !text(item.name, 200) ||
          !Array.isArray(item.steps) ||
          item.steps.length > 8 ||
          (item.input !== undefined && !text(item.input, 8000))
        )
          throw new DurableError(400, "invalid_workspace", "工作流字段无效。");
        const stepIds = new Set<string>();
        for (const step of item.steps) {
          if (
            !isObject(step) ||
            !text(step.id, 120, true) ||
            stepIds.has(step.id) ||
            !text(step.name, 200) ||
            !text(step.agentId, 120) ||
            !text(step.instruction, 16000)
          )
            throw new DurableError(400, "invalid_workspace", "工作流步骤字段无效。");
          stepIds.add(step.id);
        }
      }
    }
  }
  if (value.activeAgentId !== null && !text(value.activeAgentId, 120, true))
    throw new DurableError(400, "invalid_workspace", "activeAgentId 无效。");
}

/** Caller-supplied runs, metadata and unknown fields never enter the resource record. */
function resources(value: ThreadWorkspace, revision: number): ThreadWorkspace {
  return {
    revision,
    agents: value.agents,
    workflows: value.workflows,
    documents: value.documents,
    skills: value.skills,
    activeAgentId: value.activeAgentId,
    runs: [],
  };
}
export function putWorkspace(threadId: string, value: unknown): ThreadWorkspace {
  validateResources(value);
  transaction(() => {
    const current = readRecord<ThreadWorkspace>(WORKSPACES, threadId) ?? emptyWorkspace();
    if (value.revision !== current.revision)
      throw new DurableError(409, "revision_conflict", "工作区已在其他窗口更新，请合并后重试。");
    ensureThread(threadId);
    writeRecord(WORKSPACES, threadId, resources(value, current.revision + 1));
  });
  return getWorkspace(threadId);
}

export function copyWorkspace(sourceThreadId: string, targetThreadId: string): void {
  if (readRecord(WORKSPACES, targetThreadId))
    throw new DurableError(409, "thread_exists", "目标 Thread 已存在。");
  writeRecord(WORKSPACES, targetThreadId, resources(getWorkspace(sourceThreadId), 1));
}

export function importWorkspaces(value: unknown): WorkspaceImportResult {
  if (
    !isObject(value) ||
    !text(value.importId, 200, true) ||
    !isObject(value.threads) ||
    Object.keys(value.threads).length > 1000
  )
    throw new DurableError(400, "invalid_import", "导入需要 importId 和 threads 对象。");
  const importId = value.importId;
  const validated = new Map<string, ThreadWorkspace>();
  for (const [threadId, workspace] of Object.entries(value.threads)) {
    if (!text(threadId, 120, true))
      throw new DurableError(400, "invalid_import", "Thread ID 无效。");
    validateResources(workspace, false);
    if (
      workspace.runs !== undefined &&
      (!Array.isArray(workspace.runs) || workspace.runs.length > 1000)
    )
      throw new DurableError(400, "invalid_import", "运行历史无效或过大。");
    for (const run of workspace.runs ?? []) {
      if (
        !isObject(run) ||
        !text(run.id, 120, true) ||
        !text(run.name, 200, true) ||
        !["agent", "workflow"].includes(String(run.kind)) ||
        !text(run.input, 8000) ||
        !text(run.startedAt, 100, true) ||
        !["queued", "running", "completed", "failed", "cancelled", "interrupted"].includes(
          String(run.status),
        ) ||
        !Array.isArray(run.steps) ||
        run.steps.length > 8
      )
        throw new DurableError(400, "invalid_import", "旧运行字段无效。");
      if (
        (run.error !== undefined && !text(run.error, 10000)) ||
        (run.endedAt !== undefined && !text(run.endedAt, 100))
      )
        throw new DurableError(400, "invalid_import", "旧运行错误或时间字段无效。");
      const stepIds = new Set<string>();
      for (const step of run.steps) {
        if (
          !isObject(step) ||
          !text(step.id, 120, true) ||
          !text(step.name, 200, true) ||
          !text(step.agentName, 200) ||
          !text(step.model, 200, true) ||
          !text(step.output, 1_000_000) ||
          !["pending", "running", "completed", "failed", "cancelled", "interrupted"].includes(
            String(step.status),
          )
        )
          throw new DurableError(400, "invalid_import", "旧步骤字段无效。");
        if (stepIds.has(step.id)) throw new DurableError(400, "invalid_import", "旧步骤 ID 重复。");
        stepIds.add(step.id);
      }
    }
    validated.set(threadId, workspace);
  }
  const fingerprint = createHash("sha256").update(JSON.stringify(value.threads)).digest("hex");
  return transaction(() => {
    const previous = readRecord<{ fingerprint: string; result: WorkspaceImportResult }>(
      IMPORTS,
      importId,
    );
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new DurableError(409, "idempotency_conflict", "相同 importId 对应了不同的历史。");
      return previous.result;
    }
    const result: WorkspaceImportResult = { imported: [], skipped: [] };
    for (const [threadId, workspace] of validated) {
      if (readRecord(WORKSPACES, threadId)) {
        result.skipped.push(threadId);
        continue;
      }
      ensureThread(threadId);
      writeRecord(WORKSPACES, threadId, resources(workspace, 1));
      for (const legacy of workspace.runs ?? []) {
        const id = `import-${createHash("sha256")
          .update(JSON.stringify([threadId, legacy.id]))
          .digest("hex")
          .slice(0, 32)}`;
        if (readRecord(RUN_NAMESPACE, id)) continue;
        const interrupted = legacy.status === "running" || legacy.status === "queued";
        const run: WorkspaceRun = {
          id,
          threadId,
          name: legacy.name,
          kind: legacy.kind,
          input: legacy.input,
          startedAt: legacy.startedAt,
          endedAt: interrupted ? new Date().toISOString() : legacy.endedAt,
          status: interrupted ? "interrupted" : legacy.status,
          imported: true,
          error: interrupted
            ? "导入的执行没有服务端请求快照；保留历史，不会自动重放。"
            : legacy.error,
          steps: legacy.steps.map((step) => ({
            id: step.id,
            name: step.name,
            agentName: step.agentName,
            model: step.model,
            output: step.output,
            status: step.status === "running" ? "interrupted" : step.status,
            ...(text(step.error, 10000) ? { error: step.error } : {}),
            ...(text(step.startedAt, 100) ? { startedAt: step.startedAt } : {}),
            ...(text(step.endedAt, 100) ? { endedAt: step.endedAt } : {}),
            ...(typeof step.inputTokens === "number" && Number.isFinite(step.inputTokens)
              ? { inputTokens: step.inputTokens }
              : {}),
            ...(typeof step.outputTokens === "number" && Number.isFinite(step.outputTokens)
              ? { outputTokens: step.outputTokens }
              : {}),
          })),
        };
        writeRecord(RUN_NAMESPACE, id, run);
      }
      result.imported.push(threadId);
    }
    writeRecord(IMPORTS, importId, { fingerprint, result });
    return result;
  });
}
