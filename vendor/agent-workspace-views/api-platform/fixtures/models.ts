import type { ApModel, ApScenario, ApPrice } from "../model.ts"
const perMillion = (microUsd: number): ApPrice => ({
  kind: "known",
  microUsd,
  unit: "million-tokens",
})
function model(
  modelId: string,
  provider: string,
  options: Partial<ApModel> = {},
): ApModel {
  return {
    modelId,
    name: modelId.split("/").at(-1)!,
    providerId: provider.toLowerCase(),
    provider,
    modality: "text",
    capabilities: ["reasoning", "tools", "streaming"],
    contextTokens: 128000,
    status: "available",
    inputPrice: perMillion(750000),
    outputPrice: perMillion(3000000),
    latencyMs: 1500,
    zeroRetention: true,
    noTraining: true,
    freeTier: false,
    releasedAt: "2026-09-08",
    ...options,
  }
}
/** Demonstrative local data, never a live quote or claim of provider capability. */
export const apModels: readonly ApModel[] = [
  model("zai/glm-5.3-flashx", "Z.ai", {
    capabilities: ["vision", "reasoning", "tools", "streaming"],
    inputPrice: perMillion(370000),
    outputPrice: perMillion(1250000),
    releasedAt: "2026-09-18",
  }),
  model("alibaba/qwen3.8-omni-flash", "Alibaba", {
    capabilities: ["vision", "reasoning", "tools"],
    inputPrice: perMillion(150000),
    outputPrice: perMillion(470000),
    freeTier: true,
    releasedAt: "2026-09-17",
  }),
  model("google/gemini-3.8-live", "Google", {
    modality: "audio",
    capabilities: ["audio", "streaming"],
    latencyMs: null,
    releasedAt: "2026-09-15",
  }),
  model("typesafe-ai/jev", "Typesafe-ai", {
    modality: "evaluation",
    capabilities: ["evaluation"],
    contextTokens: null,
    inputPrice: perMillion(0),
    outputPrice: perMillion(0),
    latencyMs: null,
    freeTier: true,
  }),
  model("sakana/fugu-max", "Sakana", {
    inputPrice: perMillion(2000000),
    outputPrice: perMillion(6000000),
    zeroRetention: null,
  }),
  model("openai/gpt-live-1", "OpenAI", {
    modality: "audio",
    capabilities: ["audio"],
    contextTokens: null,
    inputPrice: { kind: "known", microUsd: 3000000, unit: "hour" },
    outputPrice: {
      kind: "known",
      microUsd: 10000000,
      unit: "thousand-requests",
    },
    latencyMs: null,
  }),
  model("inclusionai/ling-3.0-flash-vl", "Inclusionai", {
    capabilities: ["vision", "tools"],
    inputPrice: perMillion(0),
    outputPrice: perMillion(0),
    freeTier: true,
  }),
  model("deepseek/deepseek-v4.1-flash", "DeepSeek", {
    capabilities: ["vision", "reasoning", "tools"],
    latencyMs: 400,
  }),
  model("openai/gpt-image-2.5-sunburst", "OpenAI", {
    modality: "image",
    capabilities: ["image-generation"],
    contextTokens: null,
    latencyMs: null,
  }),
  model("anthropic/claude-fable-5.1", "Anthropic", {
    capabilities: ["vision", "reasoning", "tools", "streaming"],
    contextTokens: 200000,
    inputPrice: perMillion(10000000),
    outputPrice: perMillion(50000000),
    releasedAt: "2026-08-31",
  }),
  model("alibaba/wan-v3.0-video-prime", "Alibaba", {
    modality: "video",
    capabilities: ["video-generation", "vision"],
    contextTokens: null,
    inputPrice: { kind: "not-applicable" },
    outputPrice: { kind: "known", microUsd: 70000, unit: "second" },
    latencyMs: null,
  }),
  model("local/demo-embedding", "Local", {
    modality: "retrieval",
    capabilities: ["embedding"],
    contextTokens: 8192,
    inputPrice: perMillion(0),
    outputPrice: { kind: "not-applicable" },
    latencyMs: 0,
    freeTier: true,
  }),
  model("local/demo-tools", "Local", {
    modality: "tools",
    capabilities: ["tools"],
    inputPrice: { kind: "unknown" },
    outputPrice: { kind: "not-applicable" },
    latencyMs: null,
    status: "unavailable",
  }),
  model("google/gemini-3.8-flash", "Google", {
    capabilities: ["vision", "reasoning", "tools", "streaming"],
    contextTokens: 1000000,
  }),
  model("openai/gpt-6-astra", "OpenAI", {
    capabilities: ["vision", "reasoning", "tools", "streaming"],
    inputPrice: perMillion(10000000),
    outputPrice: perMillion(50000000),
  }),
  model("inception/mercury-2.5", "Inception", {
    inputPrice: perMillion(40000),
    outputPrice: perMillion(150000),
    latencyMs: 1700,
  }),
]
export function createCatalogModels(scenario: ApScenario): ApModel[] {
  if (scenario === "empty") return []
  const models = apModels.map((m) => ({
    ...m,
    capabilities: m.capabilities ? [...m.capabilities] : null,
  }))
  if (scenario === "missing-data")
    models[0] = {
      ...models[0],
      capabilities: null,
      contextTokens: null,
      inputPrice: { kind: "unknown" },
      latencyMs: null,
      noTraining: null,
    }
  if (scenario === "long-content")
    models[0] = {
      ...models[0],
      modelId:
        "local/organization-research/experimental-multilingual-reasoning-model-with-an-extraordinarily-long-stable-version-identifier-2026-10-12",
      name: "Experimental multilingual reasoning model with a long version identifier 2026-10-12",
    }
  return models
}
