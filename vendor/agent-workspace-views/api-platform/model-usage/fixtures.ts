import { apScope, type ApModel, type ApScenario } from "../model.ts"
import type { ModelUsageFixture, UsageRequest } from "./controller.ts"

/** Read-only reference-shaped facts; catalog quotes and billing balances are unchanged. */
const dailyCounts = [
  [
    [675, 3, 4],
    [767, 3, 5],
    [860, 4, 5],
    [827, 3, 5],
    [414, 2, 2],
    [782, 3, 5],
    [508, 2, 33],
    [601, 3, 4],
    [697, 3, 4],
    [793, 3, 5],
    [0, 0, 0],
    [0, 0, 0],
    [956, 3, 6],
    [808, 3, 5],
    [516, 2, 34],
    [614, 3, 4],
    [716, 3, 4],
    [818, 3, 5],
    [415, 2, 3],
    [1025, 4, 6],
    [988, 4, 6],
    [831, 3, 5],
    [936, 4, 61],
    [627, 3, 4],
    [732, 3, 5],
    [378, 2, 2],
    [947, 4, 6],
    [1058, 4, 6],
    [1018, 4, 6],
    [0, 0, 0],
  ],
  [
    [416, 2, 3],
    [462, 2, 3],
    [446, 2, 2],
    [377, 1, 2],
    [109, 0, 0],
    [289, 1, 2],
    [335, 1, 22],
    [384, 2, 2],
    [431, 2, 3],
    [480, 2, 3],
    [0, 0, 0],
    [0, 0, 0],
    [440, 1, 3],
    [296, 1, 2],
    [345, 1, 23],
    [396, 2, 3],
    [446, 2, 3],
    [498, 2, 3],
    [216, 0, 1],
    [401, 1, 2],
    [453, 1, 3],
    [301, 1, 2],
    [352, 1, 23],
    [406, 2, 3],
    [459, 18, 3],
    [231, 9, 1],
    [494, 19, 3],
    [549, 21, 3],
    [466, 17, 3],
    [0, 0, 0],
  ],
  [
    [297, 1, 2],
    [251, 1, 1],
    [158, 0, 0],
    [191, 0, 0],
    [100, 0, 0],
    [254, 0, 2],
    [287, 1, 18],
    [320, 1, 2],
    [309, 1, 2],
    [260, 1, 1],
    [0, 0, 0],
    [0, 0, 0],
    [228, 0, 1],
    [262, 0, 2],
    [297, 1, 20],
    [332, 1, 2],
    [319, 1, 2],
    [354, 2, 2],
    [137, 0, 1],
    [198, 0, 1],
    [234, 0, 1],
    [270, 0, 2],
    [306, 1, 20],
    [342, 1, 2],
    [329, 2, 2],
    [165, 0, 1],
    [311, 1, 1],
    [201, 0, 1],
    [238, 0, 1],
    [0, 0, 0],
  ],
] as const
const identities = [
  ["openai/gpt-4.1", "GPT-4.1", "OpenAI", "openai"],
  ["anthropic/claude-sonnet-4", "Claude Sonnet 4", "Anthropic", "anthropic"],
  ["google/gemini-2.5-flash", "Gemini 2.5 Flash", "Google", "google"],
  ["mistral/mistral-large", "Mistral Large", "Mistral", "mistral"],
] as const
const models: readonly ApModel[] = identities.map(
  ([modelId, name, provider, providerId]) => ({
    modelId,
    name,
    provider,
    providerId,
    modality: "text",
    capabilities: null,
    contextTokens: null,
    status: "available",
    inputPrice: { kind: "unknown" },
    outputPrice: { kind: "unknown" },
    latencyMs: null,
    zeroRetention: null,
    noTraining: null,
    freeTier: null,
    releasedAt: "2026-09-01T00:00:00Z",
  }),
)
export const referenceUsageProjects = [
  { projectId: "usage-support", name: "Support copilot" },
  { projectId: "usage-search", name: "Knowledge search" },
  { projectId: "usage-studio", name: "Content studio" },
] as const

function partition(value: number): number[] {
  const support = Math.floor(value * 0.56),
    search = Math.floor(value * 0.28)
  return [support, search, value - support - search]
}
function referenceRequests(): UsageRequest[] {
  const rows: UsageRequest[] = []
  dailyCounts.forEach((days, modelIndex) =>
    days.forEach(([count, failed, limited], dayIndex) => {
      const instant = new Date(
        Date.UTC(2026, 7, 26 + dayIndex, 12),
      ).toISOString()
      const countByProject = partition(count),
        failedByProject = partition(failed),
        limitedByProject = partition(limited)
      referenceUsageProjects.forEach((project, projectIndex) => {
        const requests = countByProject[projectIndex]
        const failure = failedByProject[projectIndex],
          rateLimit = limitedByProject[projectIndex]
        const outcomes = [
          {
            count: requests - failure - rateLimit,
            outcome: "success" as const,
            status: 200,
          },
          { count: failure, outcome: "failed" as const, status: 500 },
          { count: rateLimit, outcome: "failed" as const, status: 429 },
        ]
        outcomes.forEach(({ count: requestCount, outcome, status }) => {
          if (!requestCount) return
          rows.push({
            requestId:
              "daily-" +
              modelIndex +
              "-" +
              instant.slice(0, 10) +
              "-" +
              project.projectId +
              "-" +
              status,
            orgId: apScope.orgId,
            projectId: project.projectId,
            modelId: models[modelIndex].modelId,
            providerId: models[modelIndex].providerId,
            memberId: "fixture-member",
            agentId: "fixture-agent",
            startedAt: instant,
            outcome,
            httpStatus: status,
            requestCount,
            latencyMs: [820, 1180, 390][modelIndex],
            inputTokens: requestCount * [1000, 1320, 1680][modelIndex],
            outputTokens: requestCount * [240, 350, 430][modelIndex],
            cachedTokens: requestCount * 160,
            costMicroUsd: requestCount * [6000, 9000, 1800][modelIndex],
            credits: null,
          })
        })
      })
    }),
  )
  return rows
}
const requests = referenceRequests()
export function createReferenceUsageFixture(
  scenario: ApScenario,
): ModelUsageFixture {
  const fixtureModels = models.map((model, index) =>
    scenario === "long-content" && index === 0
      ? {
          ...model,
          name: "GPT-4.1 · Organization research deployment with an exceptionally long descriptive identifier",
        }
      : model,
  )
  return {
    models: fixtureModels,
    projects: referenceUsageProjects,
    period: {
      from: "2026-09-01T00:00:00Z",
      to: "2026-09-25T00:00:00Z",
      timeZone: "UTC",
      source: "fixture",
      revision: "model-usage-reference-shaped-v1",
    },
    requests:
      scenario === "empty"
        ? []
        : requests.map((row, index) =>
            scenario === "missing-data" && index === 120
              ? {
                  ...row,
                  outcome: "unknown",
                  httpStatus: null,
                  latencyMs: null,
                  inputTokens: null,
                  outputTokens: null,
                  costMicroUsd: null,
                }
              : row,
          ),
  }
}
