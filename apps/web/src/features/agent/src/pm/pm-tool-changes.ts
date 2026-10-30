import type { PmToolCallRecord } from "@agent-workspace/contracts/pm-tools";
import type { PmChangeKind, PmChangeSet, PmChangeState } from "./pm-types";
import { agentText } from "../i18n";

const writes: Record<string, { kind: PmChangeKind; zh: string; en: string }> = {
  pm_create_project: { kind: "create", zh: "创建项目", en: "Create project" },
  pm_update_project: { kind: "update", zh: "更新项目", en: "Update project" },
  pm_create_task: { kind: "create", zh: "创建任务", en: "Create task" },
  pm_update_task: { kind: "update", zh: "更新任务", en: "Update task" },
  pm_create_document: { kind: "create", zh: "创建文档", en: "Create document" },
  pm_save_document: { kind: "update", zh: "保存文档", en: "Save document" },
  pm_create_comment: { kind: "comment", zh: "创建评论", en: "Create comment" },
  pm_add_relation: { kind: "relation", zh: "添加关系", en: "Add relation" },
  pm_remove_relation: { kind: "relation", zh: "移除关系", en: "Remove relation" },
};
const states: Record<PmToolCallRecord["status"], PmChangeState> = { pending_approval: "proposed", running: "running", succeeded: "applied", failed: "failed", unknown: "unknown" };

/** The sidebar is a compact projection of the same persisted tool records. */
export function pmToolChanges(calls: readonly PmToolCallRecord[]): PmChangeSet[] {
  return calls.flatMap(call => {
    const definition = writes[call.name];
    if (!definition) return [];
    const result = call.result;
    const entity = result && result.kind !== "comment" && result.kind !== "relation" ? result.items[0] : undefined;
    const comment = result?.kind === "comment" ? result.items[0] : undefined;
    const relation = result?.kind === "relation" ? result.items[0] : undefined;
    const targetId = result?.receipt?.targetId ?? entity?.id ?? comment?.taskId ?? relation?.sourceId ?? null;
    return [{
      id: call.operationId,
      kind: definition.kind,
      state: states[call.status],
      targetId,
      targetTitle: entity?.title ?? null,
      projectId: entity?.projectId ?? comment?.projectId ?? null,
      summary: `${agentText(definition.zh, definition.en)}${targetId ? ` · ${targetId}` : ""}`,
      receiptId: result?.receipt?.operationId ?? null,
      commandId: result?.receipt?.commandId ?? null,
      error: call.error,
      createdAt: call.createdAt,
      updatedAt: call.finishedAt ?? undefined,
    }];
  });
}
