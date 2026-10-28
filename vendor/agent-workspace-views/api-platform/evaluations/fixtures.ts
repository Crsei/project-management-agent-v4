import { apModels } from "../fixtures/models.ts"
import type { ApScenario } from "../model.ts"

export type EvaluationExample = {
  exampleId: string
  input: string
  expected: string
  candidate: string | null
}
export type EvaluationDataset = {
  datasetId: string
  name: string
  description: string
  version: number
  examples: EvaluationExample[]
}
export type EvaluationGrader = "contains" | "exact"
export type EvaluationStatus =
  "completed" | "partial" | "running" | "failed" | "cancelled"
export type EvaluationResult = EvaluationExample & { passed: boolean | null }
export type EvaluationRun = {
  evaluationId: string
  name: string
  dataset: EvaluationDataset
  providerId: string
  modelId: string | null
  modelLabel: string
  grader: EvaluationGrader
  configVersion: string
  status: EvaluationStatus
  results: EvaluationResult[] | null
  createdAt: string
  failure: string | null
}
export type EvaluationProvider = {
  providerId: string
  name: string
  endpoint: string
  modelId: string | null
  modelLabel: string
  enabled: boolean
  version: number
}
const supportExamples: EvaluationExample[] = [
  {
    exampleId: "support-1",
    input: "How long do refunds take?",
    expected: "5–10 business days",
    candidate: "Refunds arrive within 5–10 business days after approval.",
  },
  {
    exampleId: "support-2",
    input: "Can I change my delivery address?",
    expected: "before dispatch",
    candidate:
      "You can update your address before dispatch in your order details.",
  },
  {
    exampleId: "support-3",
    input: "My package is missing.",
    expected: "tracking",
    candidate: "Please share your tracking number so we can investigate.",
  },
  {
    exampleId: "support-4",
    input: "How do I cancel my subscription?",
    expected: "billing settings",
    candidate: "Contact support to cancel your subscription.",
  },
  {
    exampleId: "support-5",
    input: "Can I export my data?",
    expected: "settings",
    candidate: "Open Settings, then Data controls, and choose Export.",
  },
]
export const evaluationDatasets: readonly EvaluationDataset[] = [
  {
    datasetId: "ds_support",
    name: "Support answer quality",
    description:
      "Common support questions with expected phrases and candidate answers.",
    version: 3,
    examples: supportExamples,
  },
  {
    datasetId: "ds_intent",
    name: "Intent classification",
    description: "Exact-match labels for the customer request router.",
    version: 1,
    examples: [
      {
        exampleId: "intent-1",
        input: "Where is my package?",
        expected: "delivery",
        candidate: "delivery",
      },
      {
        exampleId: "intent-2",
        input: "Please return my payment.",
        expected: "refund",
        candidate: "refund",
      },
      {
        exampleId: "intent-3",
        input: "I cannot log in.",
        expected: "account",
        candidate: "general",
      },
    ],
  },
]
export function copyDataset(dataset: EvaluationDataset): EvaluationDataset {
  return { ...dataset, examples: dataset.examples.map((e) => ({ ...e })) }
}
export function createEvaluationFixtures(scenario: ApScenario) {
  const datasets =
    scenario === "empty" ? [] : evaluationDatasets.map(copyDataset)
  if (scenario === "long-content") {
    datasets[0].name +=
      " — multilingual support quality and long candidate responses"
    datasets[0].examples = [
      ...datasets[0].examples,
      ...Array.from({ length: 24 }, (_, i) => ({
        exampleId: "long-" + i,
        input: "Long support question " + (i + 1),
        expected: "documented policy",
        candidate:
          "According to our documented policy, " +
          "the response must retain its evidence and context. ".repeat(22),
      })),
    ]
    datasets[0].version = 4
  }
  const runs: EvaluationRun[] = datasets.map((dataset, index) => ({
    evaluationId: index === 0 ? "eval_092" : "eval_091",
    name: index === 0 ? "Support baseline" : "Intent router",
    dataset: copyDataset(dataset),
    providerId: "openai",
    modelId: null,
    modelLabel: index === 0 ? "GPT-4.1" : "GPT-4.1 mini",
    grader: index === 0 ? "contains" : "exact",
    configVersion: index === 0 ? "contains-expected-v1" : "exact-match-v1",
    status: "completed",
    failure: null,
    results: dataset.examples.map((e) => ({
      ...e,
      passed:
        e.candidate === null
          ? null
          : index === 0
            ? e.candidate.toLowerCase().includes(e.expected.toLowerCase())
            : e.candidate.trim().toLowerCase() ===
              e.expected.trim().toLowerCase(),
    })),
    createdAt: index === 0 ? "2026-09-11T10:42:00Z" : "2026-09-10T16:18:00Z",
  }))
  if (scenario === "missing-data") {
    runs[0].status = "partial"
    runs[0].results![4] = {
      ...runs[0].results![4],
      candidate: null,
      passed: null,
    }
  }
  const openai = apModels.find(
    (m) => m.providerId === "openai" && m.modality === "text",
  )!
  const anthropic = apModels.find(
    (m) => m.providerId === "anthropic" && m.modality === "text",
  )!
  const providers: EvaluationProvider[] = [
    {
      providerId: "openai",
      name: "OpenAI",
      endpoint: "https://api.openai.com/v1",
      modelId: openai.modelId,
      modelLabel: openai.name,
      enabled: true,
      version: 1,
    },
    {
      providerId: "anthropic",
      name: "Anthropic",
      endpoint: "https://api.anthropic.com/v1",
      modelId: anthropic.modelId,
      modelLabel: anthropic.name,
      enabled: false,
      version: 1,
    },
    {
      providerId: "custom",
      name: "Custom provider",
      endpoint: "https://example.invalid/v1",
      modelId: null,
      modelLabel: "custom-model",
      enabled: false,
      version: 1,
    },
  ]
  return { datasets, runs, providers }
}
