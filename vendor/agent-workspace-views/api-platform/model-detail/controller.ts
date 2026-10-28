import { createCatalogModels } from "../fixtures/models.ts"
import {
  detailMaxTokensCap,
  detailPreset,
  detailPresets,
  type DetailPresetId,
} from "./fixtures"
import type { ApModel, ApScenario } from "../model"

export type DetailLanguage = "curl" | "javascript" | "python"
export type DetailResponseTab = "output" | "json"
export type DetailReferenceTab = "parameters" | "schema"
export type DetailNotice =
  | "idle"
  | "copied-id"
  | "copied-code"
  | "copied-response"
  | "copied-schema"
  | "copy-error"
/** Sample load lifecycle; "failed" is entered by an explicit failed attempt in refresh-error. */
export type DetailSample = "idle" | "loaded" | "failed"
export type DetailDraft = {
  presetId: DetailPresetId
  /** Raw input text so invalid values stay editable. */
  maxTokens: string
  system: string
  stream: boolean
}
export type DetailState = {
  models: ApModel[]
  selectedId: string
  /** Per-model parameter drafts inside the page/scenario/scope cache. */
  drafts: Record<string, DetailDraft>
  language: DetailLanguage
  responseTab: DetailResponseTab
  referenceTab: DetailReferenceTab
  sample: DetailSample
  /** refresh-error scene: first sample load failed until an explicit retry. */
  recovered: boolean
  notice: DetailNotice
}
export function createDetailState(
  scenario: ApScenario,
  modelId?: string,
): DetailState {
  const models = createCatalogModels(scenario)
  return {
    models,
    selectedId: modelId ?? models[0]?.modelId ?? "",
    drafts: {},
    language: "curl",
    responseTab: "output",
    referenceTab: "parameters",
    sample: "idle",
    recovered: false,
    notice: "idle",
  }
}
export function defaultDraft(): DetailDraft {
  const preset = detailPresets[0]
  return {
    presetId: preset.id,
    maxTokens: "1024",
    system: preset.system,
    stream: preset.stream,
  }
}
export function draftFor(state: DetailState, modelId: string): DetailDraft {
  return state.drafts[modelId] ?? defaultDraft()
}
export function withDraft(
  state: DetailState,
  modelId: string,
  patch: Partial<DetailDraft>,
): DetailState {
  const draft = { ...draftFor(state, modelId), ...patch }
  return {
    ...state,
    drafts: { ...state.drafts, [modelId]: draft },
    notice: "idle",
  }
}
/** Loading a preset owns the system prompt and streaming flag; user-set max_tokens is retained. */
export function applyPreset(
  state: DetailState,
  modelId: string,
  presetId: DetailPresetId,
): DetailState {
  const preset = detailPreset(presetId)
  return withDraft(state, modelId, {
    presetId,
    system: preset.system,
    stream: preset.stream,
  })
}
export type DetailFieldErrors = { maxTokens?: string; stream?: string }
export function validateDraft(
  draft: DetailDraft,
  model: ApModel | null,
  en: boolean,
): DetailFieldErrors {
  const errors: DetailFieldErrors = {}
  const raw = draft.maxTokens.trim()
  if (!raw) errors.maxTokens = en ? "Enter max_tokens." : "请输入 max_tokens。"
  else if (!/^\d+$/.test(raw))
    errors.maxTokens = en
      ? "max_tokens must be a whole number."
      : "max_tokens 必须是整数。"
  else if (Number(raw) < 1)
    errors.maxTokens = en
      ? "max_tokens must be at least 1."
      : "max_tokens 必须至少为 1。"
  else if (Number(raw) > detailMaxTokensCap)
    errors.maxTokens = en
      ? `max_tokens cannot exceed ${detailMaxTokensCap} in this sample.`
      : `max_tokens 不能超过本样例的 ${detailMaxTokensCap}。`
  if (draft.stream && model) {
    if (model.capabilities === null)
      errors.stream = en
        ? "Capabilities are unknown; streaming support cannot be confirmed."
        : "能力未知，无法确认该模型是否支持流式输出。"
    else if (!model.capabilities.includes("streaming"))
      errors.stream = en
        ? "This model does not support streaming responses."
        : "该模型不支持流式输出。"
  }
  return errors
}
export type DetailExecution =
  | { kind: "ready" }
  | { kind: "idle" }
  | { kind: "blocked"; message: string; reason: string }
  | { kind: "invalid"; message: string; reason: string }
  | { kind: "failed"; message: string; reason: string }
/** Whether a simulated sample request may run. Never issues a request when blocked or invalid. */
export function executionState(
  state: DetailState,
  scenario: ApScenario,
  model: ApModel | null,
  errors: DetailFieldErrors,
  en: boolean,
): DetailExecution {
  if (!model)
    return {
      kind: "blocked",
      message: en ? "No model is selected." : "未选择模型。",
      reason: en
        ? "Choose a model to open its detail page."
        : "请选择模型以打开详情页。",
    }
  if (scenario === "readonly")
    return {
      kind: "blocked",
      message: en
        ? "Read-only scenes do not run sample requests."
        : "只读场景不执行示例请求。",
      reason: en
        ? "Parameters and outputs stay local; no request is sent."
        : "参数与输出保持本地 fixture，不发送任何请求。",
    }
  if (model.status !== "available")
    return {
      kind: "blocked",
      message: en
        ? "This model is unavailable; the sample request did not run."
        : "模型当前不可用，示例请求未执行。",
      reason: en
        ? "Unavailable models keep their documentation and code samples only."
        : "不可用模型只保留文档与代码示例。",
    }
  if (errors.maxTokens || errors.stream)
    return {
      kind: "invalid",
      message: en
        ? "Parameters are invalid; the sample request is paused."
        : "参数无效，示例请求已暂停。",
      reason: en
        ? "Fix the highlighted fields to load the sample response."
        : "修正标红字段后即可加载示例响应。",
    }
  const draft = draftFor(state, model.modelId)
  if (Number(draft.maxTokens) < detailPreset(draft.presetId).outputTokens)
    return {
      kind: "blocked",
      message: en
        ? "No fixed response fixture fits this output budget."
        : "没有符合此输出预算的固定响应样例。",
      reason: en
        ? "Request code still uses your parameters. Increase max_tokens to the preset’s recorded output_tokens to inspect its response; this page does not tokenize or truncate responses."
        : "请求代码仍使用当前参数。将 max_tokens 增大到预设记录的 output_tokens 后可查看该响应；此页面不执行 Token 编码或响应截断。",
    }
  if (state.sample === "failed")
    return {
      kind: "failed",
      message: en
        ? "The sample response failed to load."
        : "示例响应加载失败。",
      reason: en
        ? "Your parameter input is preserved; retry when ready."
        : "参数输入已保留，可随时重试。",
    }
  if (state.sample === "idle") return { kind: "idle" }
  return { kind: "ready" }
}
function requestBody(
  model: ApModel,
  draft: DetailDraft,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: model.modelId,
    max_tokens: Number(draft.maxTokens),
    system: draft.system,
  }
  if (draft.stream) body.stream = true
  body.messages = detailPreset(draft.presetId).messages
  return body
}
function pythonLiteral(value: unknown, indent: string): string {
  if (typeof value === "boolean") return value ? "True" : "False"
  if (typeof value === "number") return String(value)
  if (typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) {
    if (!value.length) return "[]"
    const inner = value
      .map((item) => `${indent}  ${pythonLiteral(item, `${indent}  `)}`)
      .join(",\n")
    return `[\n${inner}\n${indent}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (!entries.length) return "{}"
  const inner = entries
    .map(
      ([key, item]) =>
        `${indent}  ${JSON.stringify(key)}: ${pythonLiteral(item, `${indent}  `)}`,
    )
    .join(",\n")
  return `{\n${inner}\n${indent}}`
}
/** Deterministic sample request snippet generated from the current valid parameters. */
export function requestSnippet(
  model: ApModel,
  draft: DetailDraft,
  language: DetailLanguage,
): string {
  const body = requestBody(model, draft)
  const json = JSON.stringify(body, null, 2)
  if (language === "curl")
    return [
      'curl "$API_BASE_URL/v1/messages" \\',
      '  -H "$API_AUTH_HEADER" \\',
      '  -H "Content-Type: application/json" \\',
      `  -d '${json.replace(/'/g, "'\\''")}'`,
    ].join("\n")
  if (language === "javascript")
    return [
      "const body = " + json,
      "",
      "const API_BASE_URL = process.env.API_BASE_URL",
      "const authHeaders = JSON.parse(process.env.API_AUTH_HEADERS)",
      "",
      "const response = await fetch(`${API_BASE_URL}/v1/messages`, {",
      '  method: "POST",',
      "  headers: {",
      "    ...authHeaders,",
      '    "Content-Type": "application/json",',
      "  },",
      "  body: JSON.stringify(body),",
      "})",
      "",
      "const message = await response.json()",
      "console.log(message)",
    ].join("\n")
  return [
    "import json",
    "import os",
    "",
    "import requests",
    "",
    "body = " + pythonLiteral(body, ""),
    "",
    'auth_headers = json.loads(os.environ["API_AUTH_HEADERS"])',
    "",
    "response = requests.post(",
    "    f\"{os.environ['API_BASE_URL']}/v1/messages\",",
    "    headers={",
    "        **auth_headers,",
    '        "Content-Type": "application/json",',
    "    },",
    "    json=body,",
    "    timeout=30,",
    ")",
    "",
    "print(response.json())",
  ].join("\n")
}
/** Sample output text shared by the rendered Output tab and the JSON content block. */
export function responseOutputText(draft: DetailDraft): string {
  return detailPreset(draft.presetId).responseText
}
/** Fixed fixture content and recorded usage; model/stream select its display envelope, never live inference. */
export function responseJson(model: ApModel, draft: DetailDraft): string {
  const preset = detailPreset(draft.presetId),
    usage = {
      input_tokens: preset.inputTokens,
      output_tokens: preset.outputTokens,
    },
    text = responseOutputText(draft)
  if (draft.stream)
    return [
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          id: preset.responseId,
          role: "assistant",
          model: model.modelId,
        },
      })}`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text },
      })}`,
      `event: message_stop\ndata: ${JSON.stringify({
        type: "message_stop",
        stop_reason: "end_turn",
        usage,
      })}`,
      "",
    ].join("\n\n")
  return JSON.stringify(
    {
      id: preset.responseId,
      type: "message",
      role: "assistant",
      model: model.modelId,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage,
    },
    null,
    2,
  )
}
