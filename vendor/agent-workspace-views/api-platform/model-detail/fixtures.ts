import type { ApCopy } from "../model.ts"

/** Sample conversation/example presets for the detail page. Payload content is fixture data, not UI chrome. */
export type DetailPresetId = "instructions" | "handoff" | "streaming"
export type DetailMessage = { role: "user" | "assistant"; content: string }
export type DetailPreset = {
  id: DetailPresetId
  name: ApCopy
  description: ApCopy
  /** Fields the preset owns when it is loaded into a draft. */
  stream: boolean
  system: string
  messages: DetailMessage[]
  responseId: string
  responseText: string
  inputTokens: number
  outputTokens: number
}
export const detailPresets: readonly DetailPreset[] = [
  {
    id: "instructions",
    name: { "zh-CN": "系统指令", en: "System instructions" },
    description: {
      "zh-CN": "为助手设定角色与上下文。",
      en: "Give your assistant a role and context.",
    },
    stream: false,
    system:
      "You are a concise workspace assistant. Answer with concrete next steps.",
    messages: [
      {
        role: "user",
        content: "Summarize today's open tasks in three bullets.",
      },
    ],
    responseId: "msg_sample_instructions",
    responseText:
      "1. Finalize the onboarding checklist for the Northstar account.\n2. Reply to the pending security review with the data-flow diagram.\n3. Schedule the billing migration window before Friday.",
    inputTokens: 38,
    outputTokens: 64,
  },
  {
    id: "handoff",
    name: { "zh-CN": "多轮对话", en: "Multi-turn conversation" },
    description: {
      "zh-CN": "在更早的消息上下文上继续。",
      en: "Build on the context of earlier messages.",
    },
    stream: false,
    system:
      "You are a helpful workspace assistant. Keep answers brief and practical.",
    messages: [
      {
        role: "user",
        content: "We have 12 overdue invoices. How should we follow up?",
      },
      {
        role: "assistant",
        content:
          "Group them by days overdue, confirm the payment contact, then send a reminder with the invoice link.",
      },
      {
        role: "user",
        content: "Draft the reminder for the two oldest accounts.",
      },
    ],
    responseId: "msg_sample_handoff",
    responseText:
      "Subject: Invoice INV-2048 overdue\n\nHi both,\n\nInvoice INV-2048 is now 21 days overdue. Could you confirm the payment date this week? The invoice link is included below.",
    inputTokens: 139,
    outputTokens: 91,
  },
  {
    id: "streaming",
    name: { "zh-CN": "流式响应", en: "Streaming response" },
    description: {
      "zh-CN": "以增量方式返回回答。",
      en: "Deliver the answer as it is generated.",
    },
    stream: true,
    system: "You are a concise workspace assistant.",
    messages: [{ role: "user", content: "List the release checklist items." }],
    responseId: "msg_sample_streaming",
    responseText:
      "1. Freeze the release branch.\n2. Run the regression suite.\n3. Publish the release notes.",
    inputTokens: 31,
    outputTokens: 52,
  },
]
export function detailPreset(id: DetailPresetId): DetailPreset {
  const preset = detailPresets.find((item) => item.id === id)
  if (!preset) throw new Error(`Unknown detail preset ${id}`)
  return preset
}
/** Sample API maximum output for this fixture page; validation bound, not a live limit. */
export const detailMaxTokensCap = 128000

export type DetailParameterDoc = {
  name: string
  type: string
  required: boolean
  description: ApCopy
  /** Editable control bound to the draft; null documents a reference-only parameter. */
  control: "messages" | "max-tokens" | "system" | "stream" | null
}
export const detailInputParameters: readonly DetailParameterDoc[] = [
  {
    name: "messages",
    type: "object[]",
    required: true,
    control: "messages",
    description: {
      "zh-CN": "每条消息包含角色与内容的对话历史，由上方示例决定。",
      en: "Conversation history with a role and content for each message; set by the example above.",
    },
  },
  {
    name: "max_tokens",
    type: "number",
    required: true,
    control: "max-tokens",
    description: {
      "zh-CN": "响应生成的最大 Token 数。",
      en: "Maximum number of tokens to generate in the response.",
    },
  },
  {
    name: "system",
    type: "string",
    required: false,
    control: "system",
    description: {
      "zh-CN": "定义助手角色与行为的指令。",
      en: "Instructions that define the assistant's role and behavior.",
    },
  },
  {
    name: "stream",
    type: "boolean",
    required: false,
    control: "stream",
    description: {
      "zh-CN": "以服务器发送事件返回增量输出。",
      en: "Return incremental output as server-sent events.",
    },
  },
  {
    name: "metadata",
    type: "object",
    required: false,
    control: null,
    description: {
      "zh-CN": "与请求关联的可选元数据。",
      en: "Optional metadata associated with the request.",
    },
  },
]
export const detailOutputParameters: readonly DetailParameterDoc[] = [
  {
    name: "id",
    type: "string",
    required: false,
    control: null,
    description: {
      "zh-CN": "生成消息的唯一标识。",
      en: "Unique identifier for the generated message.",
    },
  },
  {
    name: "content",
    type: "object[]",
    required: false,
    control: null,
    description: {
      "zh-CN": "模型返回的文本与其它内容块。",
      en: "The text and other content blocks returned by the model.",
    },
  },
  {
    name: "stop_reason",
    type: "string | null",
    required: false,
    control: null,
    description: {
      "zh-CN": "停止原因，例如 end_turn 或 max_tokens。",
      en: "Why the model stopped, such as end_turn or max_tokens.",
    },
  },
  {
    name: "usage",
    type: "object",
    required: false,
    control: null,
    description: {
      "zh-CN": "本次请求的 input_tokens 与 output_tokens 计数。",
      en: "input_tokens and output_tokens counts for the completed request.",
    },
  },
]
/** JSON schema of the sample Messages API request body; API contract, independent of the current draft. */
export function detailInputSchema(): unknown {
  return {
    type: "object",
    required: ["messages", "max_tokens"],
    properties: {
      messages: {
        type: "array",
        items: {
          type: "object",
          required: ["role", "content"],
          properties: {
            role: { type: "string", enum: ["user", "assistant"] },
            content: { type: "string" },
          },
        },
      },
      max_tokens: {
        type: "integer",
        minimum: 1,
        maximum: detailMaxTokensCap,
        description: "Maximum number of tokens to generate in the response.",
      },
      system: { type: "string" },
      stream: { type: "boolean", default: false },
      metadata: { type: "object" },
    },
  }
}
