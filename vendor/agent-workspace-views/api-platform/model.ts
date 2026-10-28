export type ApLocale = "zh-CN" | "en"
export type ApCopy = Record<ApLocale, string>
export type ApScope = {
  orgId: string
  projectId: string
  timeZone: string
  canWrite: boolean
}
export type ApOperationResult =
  "idle" | "pending" | "confirmed" | "rejected" | "unknown"
export type ApModality =
  "text" | "image" | "video" | "audio" | "retrieval" | "evaluation" | "tools"
export type ApCapability =
  | "vision"
  | "reasoning"
  | "tools"
  | "streaming"
  | "audio"
  | "embedding"
  | "image-generation"
  | "video-generation"
  | "evaluation"
export type ApPrice =
  | {
      kind: "known"
      microUsd: number
      unit: "million-tokens" | "second" | "hour" | "thousand-requests"
    }
  | { kind: "unknown" }
  | { kind: "not-applicable" }
export type ApTokenPriceUnit = "million-tokens" | "thousand-tokens"
export type ApModel = {
  modelId: string
  name: string
  providerId: string
  provider: string
  modality: ApModality
  capabilities: readonly ApCapability[] | null
  contextTokens: number | null
  status: "available" | "unavailable"
  inputPrice: ApPrice
  outputPrice: ApPrice
  latencyMs: number | null
  zeroRetention: boolean | null
  noTraining: boolean | null
  freeTier: boolean | null
  releasedAt: string
}
export const apScenarioIds = [
  "default",
  "empty",
  "loading",
  "refresh-error",
  "readonly",
  "long-content",
  "missing-data",
] as const
export type ApScenario = (typeof apScenarioIds)[number]
export const apScenarios = [
  { id: "default", name: { "zh-CN": "默认", en: "Default" } },
  { id: "empty", name: { "zh-CN": "空集合", en: "Empty" } },
  { id: "loading", name: { "zh-CN": "加载中", en: "Loading" } },
  { id: "refresh-error", name: { "zh-CN": "刷新失败", en: "Refresh error" } },
  { id: "readonly", name: { "zh-CN": "只读", en: "Read only" } },
  { id: "long-content", name: { "zh-CN": "长内容", en: "Long content" } },
  { id: "missing-data", name: { "zh-CN": "缺失数据", en: "Missing data" } },
] as const
export const modalityCopy: Record<ApModality, ApCopy> = {
  text: { "zh-CN": "文本", en: "Text" },
  image: { "zh-CN": "图像", en: "Image" },
  video: { "zh-CN": "视频", en: "Video" },
  audio: { "zh-CN": "音频", en: "Audio" },
  retrieval: { "zh-CN": "检索", en: "Retrieval" },
  evaluation: { "zh-CN": "评测", en: "Evaluation" },
  tools: { "zh-CN": "工具", en: "Tools" },
}
export const capabilityCopy: Record<ApCapability, ApCopy> = {
  vision: { "zh-CN": "视觉", en: "Vision" },
  reasoning: { "zh-CN": "推理", en: "Reasoning" },
  tools: { "zh-CN": "工具调用", en: "Tool use" },
  streaming: { "zh-CN": "流式输出", en: "Streaming" },
  audio: { "zh-CN": "音频", en: "Audio" },
  embedding: { "zh-CN": "向量嵌入", en: "Embedding" },
  "image-generation": { "zh-CN": "图像生成", en: "Image generation" },
  "video-generation": { "zh-CN": "视频生成", en: "Video generation" },
  evaluation: { "zh-CN": "评测", en: "Evaluation" },
}
export function formatApPrice(
  price: ApPrice,
  locale: ApLocale,
  tokenUnit: ApTokenPriceUnit = "million-tokens",
) {
  if (price.kind === "unknown") return locale === "en" ? "Unknown" : "未知"
  if (price.kind === "not-applicable")
    return locale === "en" ? "Not applicable" : "不适用"
  if (price.microUsd === 0) return locale === "en" ? "Free" : "免费"
  const perThousand =
    price.unit === "million-tokens" && tokenUnit === "thousand-tokens"
  const suffix = {
    "million-tokens": perThousand
      ? locale === "en"
        ? "K tokens"
        : "千 Token"
      : locale === "en"
        ? "M tokens"
        : "百万 Token",
    second: locale === "en" ? "s" : "秒",
    hour: locale === "en" ? "hour" : "小时",
    "thousand-requests": locale === "en" ? "K requests" : "千次请求",
  }[price.unit]
  return `USD ${new Intl.NumberFormat(locale, { maximumFractionDigits: perThousand ? 9 : 6 }).format(price.microUsd / (perThousand ? 1_000_000_000 : 1_000_000))} / ${suffix}`
}
export const apFixtureRevision = "api-platform-v1-2026-10-12"
export const apAsOf = "2026-10-12T00:00:00Z"
export const apScope: ApScope = {
  orgId: "org-demo",
  projectId: "api-project-demo",
  timeZone: "UTC",
  canWrite: true,
}
