import type { ApCopy, ApScenario } from "../model.ts"
import { apAsOf } from "../model.ts"
import { apModels, createCatalogModels } from "../fixtures/models.ts"

export type ApBenchmarkResult = {
  /** Stable identity shared by chart point, table row, detail and export. */
  resultId: string
  modelId: string
  datasetId: string
  datasetVersion: string
  datasetLabel: ApCopy
  configId: string
  configLabel: ApCopy
  metricId: string
  metricLabel: ApCopy
  /** Dataset-scale metric points; null means not scored, never zero. */
  score: number | null
  /** Integer microUSD for the whole run; null means unknown. */
  costMicroUsd: number | null
  /** Integer p50 ms per case; 0 is a measured zero, null is unknown. */
  latencyMs: number | null
  /** Cases actually scored; null means the coverage denominator is unknown. */
  samplesObserved: number | null
  /** Planned sample denominator for the run. */
  samplesTotal: number
  asOf: string
}

const deepsec = {
  datasetId: "deepsec-lite",
  datasetVersion: "2.1",
  datasetLabel: {
    "zh-CN": "Deepsec 精简漏洞检测",
    en: "Deepsec lite vulnerability detection",
  },
} as const
const longbench = {
  datasetId: "longbench-cn",
  datasetVersion: "1.4",
  datasetLabel: {
    "zh-CN": "LongBench 中文长文",
    en: "LongBench Chinese long context",
  },
} as const
const effortHigh = {
  configId: "effort-high",
  configLabel: { "zh-CN": "高推理强度", en: "High effort" },
} as const
const effortMedium = {
  configId: "effort-medium",
  configLabel: { "zh-CN": "中推理强度", en: "Medium effort" },
} as const
const vulnScore = {
  metricId: "vuln-score",
  metricLabel: { "zh-CN": "漏洞检出分", en: "Vulnerability score" },
} as const
const rougeL = {
  metricId: "rouge-l",
  metricLabel: { "zh-CN": "ROUGE-L", en: "ROUGE-L" },
} as const

type FixtureRow = Omit<ApBenchmarkResult, "resultId" | "modelId" | "asOf"> & {
  modelRef: string
}

function row(
  modelRef: string,
  dataset: typeof deepsec | typeof longbench,
  config: typeof effortHigh | typeof effortMedium,
  metric: typeof vulnScore | typeof rougeL,
  values: {
    score: number | null
    costMicroUsd: number | null
    latencyMs: number | null
    samplesObserved: number | null
    samplesTotal: number
  },
): FixtureRow {
  return {
    modelRef,
    ...dataset,
    ...config,
    ...metric,
    ...values,
  }
}

/** Fixed demonstrative runs; never a live benchmark or provider capability claim. */
const fixtureRows: readonly FixtureRow[] = [
  // deepsec-lite@2.1 · effort-high · vulnerability-score · denominator 500
  row("openai/gpt-6-astra", deepsec, effortHigh, vulnScore, {
    score: 37.8,
    costMicroUsd: 63_700_000,
    latencyMs: 4_200,
    samplesObserved: 500,
    samplesTotal: 500,
  }),
  row("anthropic/claude-fable-5.1", deepsec, effortHigh, vulnScore, {
    score: 32.4,
    costMicroUsd: 127_930_000,
    latencyMs: 5_100,
    samplesObserved: 500,
    samplesTotal: 500,
  }),
  row("zai/glm-5.3-flashx", deepsec, effortHigh, vulnScore, {
    score: 21.9,
    costMicroUsd: 16_220_000,
    latencyMs: 3_900,
    samplesObserved: 500,
    samplesTotal: 500,
  }),
  row("deepseek/deepseek-v4.1-flash", deepsec, effortHigh, vulnScore, {
    score: 16.5,
    costMicroUsd: 5_940_000,
    latencyMs: 2_800,
    samplesObserved: 500,
    samplesTotal: 500,
  }),
  // Unequal sample count: 460 of 500 cases scored.
  row("alibaba/qwen3.8-omni-flash", deepsec, effortHigh, vulnScore, {
    score: 16.5,
    costMicroUsd: 6_330_000,
    latencyMs: 3_100,
    samplesObserved: 460,
    samplesTotal: 500,
  }),
  // Score missing: harness aborted before scoring; cost/latency still measured.
  row("google/gemini-3.8-flash", deepsec, effortHigh, vulnScore, {
    score: null,
    costMicroUsd: 8_800_000,
    latencyMs: 3_400,
    samplesObserved: 500,
    samplesTotal: 500,
  }),
  // Measured zero latency, distinct from unknown.
  row("inception/mercury-2.5", deepsec, effortHigh, vulnScore, {
    score: 12.2,
    costMicroUsd: 4_100_000,
    latencyMs: 0,
    samplesObserved: 500,
    samplesTotal: 500,
  }),
  // deepsec-lite@2.1 · effort-medium · vulnerability-score · denominator 500
  row("openai/gpt-6-astra", deepsec, effortMedium, vulnScore, {
    score: 29.3,
    costMicroUsd: 35_200_000,
    latencyMs: 2_100,
    samplesObserved: 500,
    samplesTotal: 500,
  }),
  row("anthropic/claude-fable-5.1", deepsec, effortMedium, vulnScore, {
    score: 28.3,
    costMicroUsd: 31_960_000,
    latencyMs: 2_600,
    samplesObserved: 500,
    samplesTotal: 500,
  }),
  row("zai/glm-5.3-flashx", deepsec, effortMedium, vulnScore, {
    score: 18.4,
    costMicroUsd: 11_300_000,
    latencyMs: 2_200,
    samplesObserved: 500,
    samplesTotal: 500,
  }),
  row("deepseek/deepseek-v4.1-flash", deepsec, effortMedium, vulnScore, {
    score: 13.1,
    costMicroUsd: 3_450_000,
    latencyMs: 1_600,
    samplesObserved: 500,
    samplesTotal: 500,
  }),
  // longbench-cn@1.4 · effort-high · rouge-l · denominator 300
  row("google/gemini-3.8-flash", longbench, effortHigh, rougeL, {
    score: 44.6,
    costMicroUsd: 12_400_000,
    latencyMs: 3_700,
    samplesObserved: 300,
    samplesTotal: 300,
  }),
  row("alibaba/qwen3.8-omni-flash", longbench, effortHigh, rougeL, {
    score: 41.2,
    costMicroUsd: 5_800_000,
    latencyMs: 3_300,
    samplesObserved: 300,
    samplesTotal: 300,
  }),
  // Unequal sample count across cohorts: 275 of 300 cases scored.
  row("anthropic/claude-fable-5.1", longbench, effortHigh, rougeL, {
    score: 39.8,
    costMicroUsd: 88_600_000,
    latencyMs: 4_900,
    samplesObserved: 275,
    samplesTotal: 300,
  }),
  row("zai/glm-5.3-flashx", longbench, effortHigh, rougeL, {
    score: 36.7,
    costMicroUsd: 9_100_000,
    latencyMs: 3_000,
    samplesObserved: 300,
    samplesTotal: 300,
  }),
  // Unknown latency: exporter lost the timing span; never rendered as 0.
  row("inception/mercury-2.5", longbench, effortHigh, rougeL, {
    score: 28.4,
    costMicroUsd: 3_900_000,
    latencyMs: null,
    samplesObserved: 300,
    samplesTotal: 300,
  }),
]

export function createBenchmarkResults(
  scenario: ApScenario,
): ApBenchmarkResult[] {
  if (scenario === "empty") return []
  // Anchor every row to the scenario-resolved catalog identity (long-content
  // and missing-data scenarios rename/patch the same canonical model records).
  const scenarioModels = createCatalogModels(scenario),
    resolved = new Map<string, string>()
  apModels.forEach((model, index) => {
    const current = scenarioModels[index]
    if (current) resolved.set(model.modelId, current.modelId)
  })
  const rows: ApBenchmarkResult[] = fixtureRows.map((fixture) => {
    const modelId = resolved.get(fixture.modelRef) ?? fixture.modelRef,
      rest: Partial<FixtureRow> = { ...fixture }
    delete rest.modelRef
    return {
      ...(rest as Omit<FixtureRow, "modelRef">),
      modelId,
      resultId: `bench:${rest.datasetId}@${rest.datasetVersion}:${rest.configId}:${modelId}`,
      asOf: apAsOf,
    }
  })
  if (scenario === "missing-data") {
    for (const result of rows) {
      if (result.metricId === "rouge-l") result.samplesObserved = null
      if (
        result.configId === "effort-high" &&
        result.datasetId === "deepsec-lite"
      )
        if (result.modelId.startsWith("openai/")) result.score = null
      if (
        result.modelId.startsWith("alibaba/") &&
        result.datasetId === "deepsec-lite"
      )
        result.costMicroUsd = null
    }
  }
  return rows
}
