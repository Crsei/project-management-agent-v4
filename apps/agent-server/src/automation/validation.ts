import type {
  AutomationRunTemplate,
  PullRequestWatchInput,
  ScheduleInput,
} from "@agent-workspace/contracts/automation";
import { isObject, text, validateRunRequest } from "../durable/validation.ts";
import { AutomationError } from "./service.ts";

function validateTemplate(value: unknown): asserts value is AutomationRunTemplate {
  if (
    !isObject(value) ||
    ["runId", "idempotencyKey", "continuationOf"].some((key) => key in value)
  ) {
    throw new AutomationError("执行模板不能包含 runId、idempotencyKey 或 continuationOf。");
  }
  validateRunRequest({ ...value, runId: "automation-template" });
}

export function validateSchedule(value: unknown): asserts value is ScheduleInput {
  if (
    !isObject(value) ||
    Object.keys(value).some(
      (key) => !["name", "enabled", "timing", "missedPolicy", "request"].includes(key),
    )
  ) {
    throw new AutomationError("定时任务字段无效。");
  }
  if (!text(value.name, 200, true) || typeof value.enabled !== "boolean")
    throw new AutomationError("名称不能为空，enabled 必须是布尔值。");
  if (value.missedPolicy !== "skip" && value.missedPolicy !== "run_once")
    throw new AutomationError("错过策略必须为 skip 或 run_once。");
  const timing = value.timing;
  if (!isObject(timing)) throw new AutomationError("必须提供定时配置。");
  if (timing.type === "interval") {
    if (
      Object.keys(timing).some((key) => !["type", "minutes"].includes(key)) ||
      typeof timing.minutes !== "number" ||
      !Number.isFinite(timing.minutes) ||
      timing.minutes < 1 ||
      timing.minutes > 525600
    ) {
      throw new AutomationError("间隔必须为 1–525600 分钟。");
    }
  } else if (timing.type === "fixed_time") {
    if (
      Object.keys(timing).some((key) => !["type", "time", "weekdays"].includes(key)) ||
      typeof timing.time !== "string" ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(timing.time) ||
      !Array.isArray(timing.weekdays) ||
      timing.weekdays.length < 1 ||
      timing.weekdays.length > 7 ||
      timing.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
      new Set(timing.weekdays).size !== timing.weekdays.length
    ) {
      throw new AutomationError("固定时间必须为 HH:mm，weekdays 为不重复的 0–6（周日–周六）。");
    }
  } else throw new AutomationError("定时类型必须为 interval 或 fixed_time。");
  validateTemplate(value.request);
}

export function validateWatch(value: unknown): asserts value is PullRequestWatchInput {
  if (
    !isObject(value) ||
    Object.keys(value).some(
      (key) =>
        !["name", "owner", "repo", "number", "enabled", "pollIntervalSeconds", "request"].includes(
          key,
        ),
    )
  ) {
    throw new AutomationError("PR 监测字段无效。");
  }
  if (!text(value.name, 200, true) || typeof value.enabled !== "boolean")
    throw new AutomationError("名称不能为空，enabled 必须是布尔值。");
  if (
    typeof value.owner !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value.owner) ||
    typeof value.repo !== "string" ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(value.repo) ||
    value.repo === "." ||
    value.repo === ".."
  ) {
    throw new AutomationError("GitHub owner/repo 格式无效。");
  }
  if (typeof value.number !== "number" || !Number.isSafeInteger(value.number) || value.number < 1)
    throw new AutomationError("PR number 必须为正整数。");
  if (
    typeof value.pollIntervalSeconds !== "number" ||
    !Number.isInteger(value.pollIntervalSeconds) ||
    value.pollIntervalSeconds < 60 ||
    value.pollIntervalSeconds > 86400
  ) {
    throw new AutomationError("轮询间隔必须为 60–86400 秒。");
  }
  validateTemplate(value.request);
  if (value.request.context.length > 48000)
    throw new AutomationError("PR 模板上下文不得超过 48000 字符，需要为外部事件预留空间。");
}
