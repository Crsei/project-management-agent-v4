import type { NativeOutputItem } from "@agent-workspace/contracts/output";

import type { PmChangeKind, PmChangeSet, PmChangeState } from "./pm-types";
import { agentText, type AgentText } from "../i18n";

/** Display labels for the change kinds the PM tool bridge can report. */
const KIND_LABELS: Readonly<Record<PmChangeKind, [string, string]>> = {
  create: ["新建", "Created"],
  update: ["更新", "Updated"],
  delete: ["删除", "Deleted"],
  archive: ["归档", "Archived"],
  status: ["状态变更", "Status changed"],
  comment: ["评论", "Comment"],
  relation: ["关联", "Relation"],
};
export function pmChangeKindLabel(kind: PmChangeKind, t: AgentText) { return t(...KIND_LABELS[kind]); }

const STATE_LABELS: Readonly<Record<PmChangeState, [string, string]>> = {
  proposed: ["待确认", "Pending approval"],
  approved: ["已批准", "Approved"],
  queued: ["排队中", "Queued"],
  running: ["进行中", "Running"],
  applied: ["已应用", "Applied"],
  failed: ["失败", "Failed"],
  conflict: ["冲突", "Conflict"],
  unknown: ["结果未知", "Unknown result"],
  reverted: ["已撤销", "Reverted"],
};
export function pmChangeStateLabel(state: PmChangeState, t: AgentText) { return t(...STATE_LABELS[state]); }

const TOOL_STATE: Readonly<Record<NativeOutputItem["status"], PmChangeState>> = {
  pending: "proposed",
  running: "running",
  waiting: "running",
  completed: "applied",
  failed: "failed",
  cancelled: "failed",
  interrupted: "failed",
};

const KIND_ACTIONS: Readonly<Record<PmChangeKind, [string, string]>> = {
  create: ["创建", "Create"],
  update: ["更新", "Update"],
  delete: ["删除", "Delete"],
  archive: ["归档", "Archive"],
  status: ["更新状态", "Update status"],
  comment: ["评论", "Comment"],
  relation: ["建立关联", "Add relation"],
};
function kindAction(kind: PmChangeKind) { return agentText(...KIND_ACTIONS[kind]); }

const KIND_TOKENS: Readonly<Record<PmChangeKind, true>> = {
  create: true,
  update: true,
  delete: true,
  archive: true,
  status: true,
  comment: true,
  relation: true,
};

const TARGET_ID_KEYS = ["id", "taskId", "projectId", "sourceId"] as const;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

/** Accepts an already-structured value or a JSON object payload embedded in a string. */
function parseRecord(value: unknown): JsonRecord | null {
  const direct = asRecord(value);
  if (direct) return direct;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    return asRecord(JSON.parse(trimmed) as unknown);
  } catch {
    return null;
  }
}

function textValue(value: unknown): string | null {
  if (typeof value === "string") {
    const text = value.trim();
    return text ? text : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** Derives the kind from tokens in the tool name; unknown names are updates. */
function kindFromToolName(toolName: string): PmChangeKind {
  const tokens = toolName.toLowerCase().split(/[^a-z0-9]+/);
  for (const token of tokens) {
    if (token in KIND_TOKENS) return token as PmChangeKind;
  }
  return "update";
}

function targetIdFrom(input: JsonRecord | null): string | null {
  if (!input) return null;
  for (const key of TARGET_ID_KEYS) {
    const value = textValue(input[key]);
    if (value) return value;
  }
  return null;
}

function outputError(
  item: NativeOutputItem,
  state: PmChangeState,
): { code: string | null; message: string } | null {
  if (state !== "failed") return null;

  const explicit = item.error ? item.error.trim() : "";
  if (explicit) return { code: null, message: explicit };

  const payload = parseRecord(item.output);
  const nested = payload ? asRecord(payload.error) : null;
  if (nested) {
    const message = textValue(nested.message);
    if (message) return { code: textValue(nested.code), message };
  }
  if (payload) {
    const message = textValue(payload.error) ?? textValue(payload.message);
    if (message) return { code: null, message };
  }

  if (item.status === "cancelled") return { code: null, message: agentText("工具调用已取消", "Tool call cancelled") };
  if (item.status === "interrupted") return { code: null, message: agentText("工具调用已中断", "Tool call interrupted") };
  return { code: null, message: agentText("工具执行失败，未提供错误信息", "Tool execution failed without error details") };
}

/**
 * Maps a PM dynamic-tool output item to a presentation-only change set.
 *
 * Only data carried by the item is used: no timestamps are synthesized, no
 * success is inferred from output text, and malformed payloads degrade to
 * nulls instead of throwing.
 */
export function changeSetFromToolItem(item: NativeOutputItem): PmChangeSet | null {
  const toolName = item.toolName;
  if (item.type !== "dynamic_tool" || typeof toolName !== "string" || !toolName.startsWith("pm_")) {
    return null;
  }

  const kind = kindFromToolName(toolName);
  const state = TOOL_STATE[item.status];
  const input = parseRecord(item.input);
  const output = parseRecord(item.output);

  const targetId = targetIdFrom(input);
  const targetTitle = output ? textValue(output.title) : null;
  const projectId =
    (input ? textValue(input.projectId) : null) ?? (output ? textValue(output.projectId) : null);

  const summary =
    textValue(item.title) ??
    (targetId ? `${kindAction(kind)} ${targetId}` : agentText(`${KIND_ACTIONS[kind][0]}请求`, `${KIND_ACTIONS[kind][1]} request`));

  return {
    id: item.id,
    kind,
    state,
    targetId,
    targetTitle,
    projectId,
    summary,
    receiptId: output ? textValue(output.receiptId) ?? textValue(output.receipt_id) : null,
    commandId: output ? textValue(output.commandId) ?? textValue(output.command_id) : null,
    error: outputError(item, state),
    createdAt: item.startedAt ?? item.completedAt ?? "",
    ...(item.completedAt ? { updatedAt: item.completedAt } : {}),
  };
}
