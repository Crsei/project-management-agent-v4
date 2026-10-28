import { apModels } from "../fixtures/models.ts"
import type { ApUsageRequest } from "../fixtures/usage-ledger.ts"

export const requestSources = [
  { id: "responses", label: "Responses", endpoint: "/v1/responses" },
  { id: "agents", label: "Agents", endpoint: "/v1/agents/runs" },
  { id: "traces", label: "SDK traces", endpoint: "/v1/traces" },
  { id: "realtime", label: "Realtime", endpoint: "/v1/realtime/sessions" },
  { id: "completions", label: "Completions", endpoint: "/v1/chat/completions" },
  {
    id: "conversations",
    label: "Conversations",
    endpoint: "/v1/conversations",
  },
  { id: "chatkit", label: "ChatKit", endpoint: "/v1/chatkit/sessions" },
] as const

/** Log-only fixture metadata. Never changes authoritative usage-ledger facts. */
export function requestLogMetadata(request: ApUsageRequest) {
  const ordinal = Number(request.requestId.match(/^req-demo-(\d+)/)?.[1] ?? 1)
  const source = requestSources[(ordinal - 1) % requestSources.length]
  const model = apModels.find((item) => item.modelId === request.modelId)
  const gatewayMs =
    request.latencyMs === null ? null : Math.min(24, request.latencyMs)
  const firstTokenMs =
    request.latencyMs === null
      ? null
      : Math.floor((request.latencyMs - gatewayMs!) * 0.3)
  const generationMs =
    request.latencyMs === null
      ? null
      : request.latencyMs - gatewayMs! - firstTokenMs!
  return {
    source,
    model,
    region: "iad1",
    environment: "Preview",
    cacheStatus:
      request.cachedTokens === null
        ? "unknown"
        : request.outcome === "failed"
          ? "bypass"
          : request.cachedTokens > 0
            ? "hit"
            : "miss",
    gatewayMs,
    firstTokenMs,
    generationMs,
  }
}

export type RequestPayload = {
  model: string
  messages: { role: string; content: string }[]
  stream: boolean
  metadata: { request_id: string; project_id: string; source: string }
}
export function requestPayload(request: ApUsageRequest): RequestPayload {
  const meta = requestLogMetadata(request)
  return {
    model: request.modelId,
    messages: [
      { role: "user", content: "Summarize this local fixture request." },
    ],
    stream: meta.source.id === "realtime",
    metadata: {
      request_id: request.requestId,
      project_id: request.projectId,
      source: "local-fixture",
    },
  }
}

export function responsePayload(request: ApUsageRequest) {
  return {
    id: request.requestId,
    model: request.modelId,
    outcome: request.outcome,
    http_status: request.httpStatus,
    ...(request.outcome === "success"
      ? {
          message: {
            role: "assistant",
            content:
              "This is a fixed local response sample. No provider was contacted.",
          },
        }
      : request.outcome === "failed"
        ? {
            error: {
              code:
                request.httpStatus === 429
                  ? "rate_limit_exceeded"
                  : request.httpStatus !== null && request.httpStatus >= 500
                    ? "gateway_error"
                    : "request_rejected",
              message: `Local fixture HTTP ${request.httpStatus ?? "unknown"} response; not automatically retried.`,
            },
          }
        : {
            error: null,
            result: null,
            note: "Result is unconfirmed. Query explicitly; never replay the request.",
          }),
    usage: {
      input_tokens: request.inputTokens,
      output_tokens: request.outputTokens,
      cached_tokens: request.cachedTokens,
      total_tokens:
        request.inputTokens === null || request.outputTokens === null
          ? null
          : request.inputTokens + request.outputTokens,
    },
    cost_micro_usd: request.costMicroUsd,
    credits: request.credits,
  }
}
