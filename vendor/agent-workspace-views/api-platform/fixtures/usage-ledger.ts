import { apScope, type ApScenario } from "../model.ts"
import { apModels } from "./models.ts"
import { createApAccountData } from "./accounts.ts"

/** A deterministic local ledger; credits, currency and tokens remain distinct. */
export type ApUsageRequest = {
  requestId: string
  orgId: string
  projectId: string
  modelId: string
  providerId: string
  memberId: string
  agentId: string
  startedAt: string
  outcome: "success" | "failed" | "unknown"
  httpStatus: number | null
  latencyMs: number | null
  inputTokens: number | null
  outputTokens: number | null
  cachedTokens: number | null
  costMicroUsd: number | null
  credits: number | null
}

export const apUsagePeriod = {
  from: "2026-09-01T00:00:00Z",
  to: "2026-10-01T00:00:00Z",
  timeZone: "UTC",
  source: "fixture",
  revision: "api-platform-usage-ledger-v1",
} as const

export const apUsageMembers = createApAccountData("default")
  .members.filter((member) => member.invitationState === "active")
  .map((member) => ({ memberId: member.memberId, name: member.name }))
export const apUsageAgents = [
  { agentId: "agent-support", name: "Support assistant" },
  { agentId: "agent-research", name: "Research assistant" },
  { agentId: "agent-coding", name: "Coding assistant" },
] as const

const usageModels = apModels
  .filter((model) => model.modality === "text")
  .slice(0, 3)
// Fixed local statement costs, not estimates from the independent catalog quotes.
const statementMicroUsd = 273940000
const weights = Array.from({ length: 30 }, (_, index) =>
  index === 6 || index === 19 ? 0 : 1200 + index * 311,
)
const totalWeight = weights.reduce((sum, value) => sum + value, 0)
let accumulatedWeight = 0
let allocatedMicroUsd = 0

export const apUsageRequests: readonly ApUsageRequest[] = Array.from(
  { length: 30 },
  (_, index) => {
    const model = usageModels[index % usageModels.length]
    const inputTokens = 1200 + index * 137
    const outputTokens = 300 + index * 43
    const failed = index === 6 || index === 19
    accumulatedWeight += weights[index]
    const cumulativeMicroUsd = Math.round(
      (statementMicroUsd * accumulatedWeight) / totalWeight,
    )
    const costMicroUsd = cumulativeMicroUsd - allocatedMicroUsd
    allocatedMicroUsd = cumulativeMicroUsd
    return {
      requestId: `req-demo-${String(index + 1).padStart(4, "0")}`,
      orgId: apScope.orgId,
      projectId: index % 5 === 0 ? "api-project-research" : apScope.projectId,
      modelId: model.modelId,
      providerId: model.providerId,
      memberId: apUsageMembers[index % apUsageMembers.length].memberId,
      agentId: apUsageAgents[index % apUsageAgents.length].agentId,
      startedAt: new Date(
        Date.UTC(2026, 8, index + 1, 9 + (index % 8)),
      ).toISOString(),
      outcome: failed ? "failed" : "success",
      httpStatus: failed ? 429 : 200,
      latencyMs: 620 + index * 83,
      inputTokens: failed ? 0 : inputTokens,
      outputTokens: failed ? 0 : outputTokens,
      cachedTokens: failed ? 0 : Math.floor(inputTokens / 4),
      costMicroUsd,
      credits: failed ? 0 : 2 + (index % 7),
    }
  },
)

export function createApUsageRequests(scenario: ApScenario): ApUsageRequest[] {
  if (scenario === "empty") return []
  return apUsageRequests.map((request, index) => ({
    ...request,
    ...(scenario === "long-content" && index === 0
      ? {
          requestId: `${request.requestId}-long-fixture-identifier-for-overflow-verification`,
        }
      : {}),
    ...(scenario === "missing-data" && index === 3
      ? {
          memberId: "member-unavailable",
          modelId: "model-unavailable",
          outcome: "unknown" as const,
          httpStatus: null,
          latencyMs: null,
          inputTokens: null,
          outputTokens: null,
          cachedTokens: null,
          costMicroUsd: null,
          credits: null,
        }
      : {}),
  }))
}
