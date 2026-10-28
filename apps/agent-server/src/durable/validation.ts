import type { DurableRunRequest } from "@agent-workspace/contracts/durable";
import { DurableError } from "./errors.ts";

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function text(value: unknown, max: number, required = false): value is string {
  return typeof value === "string" && value.length <= max && (!required || value.trim().length > 0);
}
function invalid(message: string): never {
  throw new DurableError(400, "invalid_request", message);
}
export function validateRunRequest(value: unknown): asserts value is DurableRunRequest {
  if (!isObject(value)) invalid("请求必须是 JSON 对象。");
  const keys = [
    "runId",
    "threadId",
    "name",
    "kind",
    "idempotencyKey",
    "continuationOf",
    "input",
    "context",
    "temperature",
    "steps",
  ];
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid("请求含有未知字段。");
  for (const key of ["runId", "threadId"] as const) {
    if (!text(value[key], 120, true)) invalid(`${key} 必须为 1–120 字符。`);
  }
  if (!text(value.name, 200, true)) invalid("运行名称必须为 1–200 字符。");
  if (value.kind !== "agent" && value.kind !== "workflow")
    invalid("kind 必须是 agent 或 workflow。");
  if (!text(value.input, 8000, true)) invalid("任务输入必须为 1–8000 字符。");
  if (!text(value.context, 64000)) invalid("上下文不得超过 64000 字符。");
  if (
    typeof value.temperature !== "number" ||
    !Number.isFinite(value.temperature) ||
    value.temperature < 0 ||
    value.temperature > 2
  )
    invalid("temperature 必须为 0–2 的有限数字。");
  for (const key of ["idempotencyKey", "continuationOf"] as const) {
    if (value[key] !== undefined && !text(value[key], 200, true))
      invalid(`${key} 必须为 1–200 字符。`);
  }
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 8)
    invalid("运行必须包含 1–8 个步骤。");
  const ids = new Set<string>();
  for (const step of value.steps) {
    if (
      !isObject(step) ||
      Object.keys(step).some(
        (key) =>
          ![
            "id",
            "name",
            "agentName",
            "model",
            "providerInstanceId",
            "system",
            "instruction",
          ].includes(key),
      )
    )
      invalid("步骤字段无效。");
    if (!text(step.id, 120, true) || ids.has(step.id)) invalid("步骤 ID 必须非空且不重复。");
    ids.add(step.id);
    if (!text(step.name, 200, true) || !text(step.model, 200, true))
      invalid("步骤名称和模型必须为 1–200 字符。");
    if (step.agentName !== undefined && !text(step.agentName, 200, true))
      invalid("agentName 必须为 1–200 字符。");
    if (!text(step.system, 16000) || !text(step.instruction, 16000, true))
      invalid("步骤系统指令和任务指令不得超过 16000 字符。");
    if (step.providerInstanceId !== undefined && !text(step.providerInstanceId, 120, true))
      invalid("providerInstanceId 无效。");
  }
}
