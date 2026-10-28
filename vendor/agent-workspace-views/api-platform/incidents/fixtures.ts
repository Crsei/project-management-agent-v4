import { apScope, type ApCopy, type ApScenario } from "../model.ts"
import {
  apUsagePeriod,
  createApUsageRequests,
  type ApUsageRequest,
} from "../fixtures/usage-ledger.ts"
import { requestLogMetadata } from "../api-requests/fixtures.ts"

export const incidentSeverities = ["critical", "high", "medium", "low"] as const
export type IncidentSeverity = (typeof incidentSeverities)[number]
export const severityCopy: Record<IncidentSeverity, ApCopy> = {
  critical: { en: "Critical", "zh-CN": "严重" },
  high: { en: "High", "zh-CN": "高" },
  medium: { en: "Medium", "zh-CN": "中" },
  low: { en: "Low", "zh-CN": "低" },
}
export type IncidentStage = "investigating" | "monitoring" | "resolved"
export const stageCopy: Record<IncidentStage, ApCopy> = {
  investigating: { en: "Investigating", "zh-CN": "调查中" },
  monitoring: { en: "Monitoring", "zh-CN": "监测中" },
  resolved: { en: "Resolved", "zh-CN": "已解决" },
}
export type IncidentEvent = {
  eventId: string
  at: string
  stage: IncidentStage
  text: ApCopy
}
export type ApIncident = {
  incidentId: string
  title: ApCopy
  severity: IncidentSeverity
  stage: IncidentStage
  orgId: string
  projectId: string
  startedAt: string
  endpoint: string | null
  region: string | null
  description: ApCopy | null
  request: ApUsageRequest
  events: IncidentEvent[] | null
}
export const incidentPeriod = apUsagePeriod
export const incidentFixtureRevision = "incidents-ledger-v1-2026-10-13"

/** Failed / unknown shared requests become incidents; no extra request facts are invented. */
export function createIncidents(scenario: ApScenario): ApIncident[] {
  return createApUsageRequests(scenario)
    .filter((request) => request.outcome !== "success")
    .map((request) => {
      const metadata = requestLogMetadata(request)
      const unknown = request.outcome === "unknown"
      const firstIncident = request.requestId === "req-demo-0007"
      const stage = unknown
        ? "investigating"
        : firstIncident
          ? "resolved"
          : "monitoring"
      const title: ApCopy = unknown
        ? { en: "Request outcome not confirmed", "zh-CN": "请求结果尚未确认" }
        : {
            en: "Rate limit interrupted an API request",
            "zh-CN": "速率限制中断 API 请求",
          }
      return {
        incidentId: `inc-${request.requestId}`,
        title:
          scenario === "long-content"
            ? {
                en:
                  title.en +
                  " — upstream retry pressure across the production inference gateway; preserve the original request before adjusting limits",
                "zh-CN":
                  title["zh-CN"] +
                  "——生产推理网关的上游重试压力；调整限额前保留原始请求和关联证据",
              }
            : title,
        severity: unknown ? "medium" : firstIncident ? "critical" : "high",
        stage,
        orgId: request.orgId,
        projectId: request.projectId,
        startedAt: request.startedAt,
        // Impact coverage can be unknown even when the linked request's log endpoint is known.
        endpoint: unknown ? null : metadata.source.endpoint,
        region: unknown ? null : metadata.region,
        description: unknown
          ? null
          : {
              en: "The shared request ledger recorded HTTP 429. Severity is an incident assessment; the lifecycle is not inferred from the HTTP status. This is a fixed local sample.",
              "zh-CN":
                "共享请求账本记录 HTTP 429。严重级别为事件评估，处理阶段不从 HTTP 状态推断。这是固定本地样例。",
            },
        request,
        events: unknown
          ? null
          : [
              {
                eventId: `evt-${request.requestId}-detected`,
                at: request.startedAt,
                stage: "investigating",
                text: {
                  en: "Rate limit observed in the request ledger.",
                  "zh-CN": "请求账本观察到速率限制。",
                },
              },
              {
                eventId: `evt-${request.requestId}-reviewed`,
                at: new Date(
                  Date.parse(request.startedAt) + 300000,
                ).toISOString(),
                stage,
                text: {
                  en:
                    stage === "resolved"
                      ? "Fixture review completed; request history remains unchanged."
                      : "Fixture monitoring is in progress; no request is replayed.",
                  "zh-CN":
                    stage === "resolved"
                      ? "样例复核已完成；请求历史保持不变。"
                      : "样例处于监测阶段；不会重放请求。",
                },
              },
            ],
      }
    })
}
export const incidentScope = apScope
