import { apScope, type ApCopy, type ApScenario } from "../model.ts"
import { incidentSeverities, type ApIncident } from "./fixtures.ts"

export type ServiceIncident = Omit<ApIncident, "request"> & { request: null }
export type IncidentRecord = ApIncident | ServiceIncident
export type IncidentPeriod = {
  from: string
  to: string
  timeZone: string
  source: string
  revision: string
}
export const serviceIncidentPeriod: IncidentPeriod = {
  from: "2026-08-01T00:00:00Z",
  to: "2026-09-01T00:00:00Z",
  timeZone: "UTC",
  source: "fixture",
  revision: "incidents-service-sample-2026-10-13",
}

// Read-only reference tooltips measured on 2026-10-13; critical/high/medium/low.
// These counts reconstruct an explicitly local sample, not original incident identities.
export const serviceDailySeverities = [
  [3, 3, 2, 0],
  [7, 6, 5, 0],
  [5, 6, 4, 0],
  [4, 4, 4, 0],
  [34, 19, 9, 0],
  [35, 59, 24, 0],
  [38, 43, 27, 0],
  [53, 79, 56, 0],
  [36, 40, 26, 0],
  [7, 8, 7, 0],
  [0, 2, 5, 1],
  [0, 6, 10, 2],
  [0, 4, 9, 2],
  [0, 3, 5, 1],
  [0, 10, 12, 2],
  [27, 31, 20, 0],
  [17, 32, 49, 0],
  [31, 66, 98, 0],
  [63, 94, 53, 0],
  [22, 24, 16, 0],
  [34, 56, 22, 0],
  [0, 8, 12, 4],
  [0, 3, 5, 1],
  [0, 7, 8, 3],
  [0, 10, 14, 4],
  [0, 3, 5, 1],
  [0, 9, 11, 4],
  [8, 8, 6, 0],
  [0, 11, 16, 5],
  [0, 6, 9, 7],
  [0, 3, 6, 2],
] as const

const endpointCoverage = [
  ["POST /v1/chat/completions", 412],
  ["POST /v1/embeddings", 268],
  ["GET /v1/vector-stores/files", 154],
  ["POST /v1/audio/transcriptions", 96],
  ["GET /v1/models", 41],
] as const
const regionCoverage = [
  ["us-east", 388],
  ["eu-west", 246],
  ["ap-south", 172],
  ["us-west", 118],
  ["eu-central", 47],
] as const
function coveredValue(
  index: number,
  groups: readonly (readonly [string, number])[],
) {
  for (const [id, count] of groups) {
    if (index < count) return id
    index -= count
  }
  return null
}
const title: ApCopy = {
  en: "Inference gateway service incident",
  "zh-CN": "推理网关服务事件",
}

export function createServiceIncidents(
  scenario: ApScenario,
): ServiceIncident[] {
  if (scenario === "empty") return []
  const rows: ServiceIncident[] = []
  for (const [day, counts] of serviceDailySeverities.entries()) {
    for (const [severityIndex, count] of counts.entries()) {
      for (let occurrence = 0; occurrence < count; occurrence++) {
        const index = rows.length
        // Permute known-coverage positions to spread them across days/severities.
        const coverageIndex = (index * 613) % 1681
        const incidentId = `inc-service-aug-${String(index + 1).padStart(4, "0")}`
        const startedAt = new Date(
          Date.UTC(2026, 7, day + 1, 9, occurrence % 60),
        ).toISOString()
        const partial =
          coverageIndex >= 971 || (scenario === "missing-data" && index === 0)
        const stage = day === 30 ? "monitoring" : "resolved"
        rows.push({
          incidentId,
          title:
            scenario === "long-content"
              ? {
                  en: `${title.en} — sustained upstream retries across the production gateway; preserve the event history before adjusting client limits`,
                  "zh-CN": `${title["zh-CN"]}——生产网关持续收到上游重试；调整客户端限额前保留完整事件历史和相关证据`,
                }
              : title,
          severity: incidentSeverities[severityIndex],
          stage,
          orgId: apScope.orgId,
          projectId: apScope.projectId,
          startedAt,
          endpoint: partial
            ? null
            : coveredValue(coverageIndex, endpointCoverage),
          region: partial
            ? null
            : coveredValue((coverageIndex * 347) % 971, regionCoverage),
          request: null,
          description: partial
            ? null
            : {
                en: "Reconstructed local August service sample. The reference reports aggregate counts only; original request IDs, HTTP results and incident identities are unavailable.",
                "zh-CN":
                  "重建的本地八月服务样例。参考只提供聚合计数；原始请求 ID、HTTP 结果和事件身份不可得。",
              },
          events: partial
            ? null
            : [
                {
                  eventId: `${incidentId}-detected`,
                  at: startedAt,
                  stage: "investigating",
                  text: {
                    en: "Local sample: service degradation reported; inspect impact independently from severity.",
                    "zh-CN":
                      "本地样例：报告服务降级；影响范围与严重级别分别检查。",
                  },
                },
                {
                  eventId: `${incidentId}-reviewed`,
                  at: new Date(Date.parse(startedAt) + 300000).toISOString(),
                  stage,
                  text: {
                    en: "Local sample review recorded. No original request is replayed or inferred.",
                    "zh-CN": "已记录本地样例复核。不重放或推断原始请求。",
                  },
                },
              ],
        })
      }
    }
  }
  return rows
}
