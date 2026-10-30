// Adapted from t3code usage interfaces. Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import type {
  ProviderConsumeResetCreditInput, ProviderConsumeResetCreditResult, ThreadUsageSnapshot,
  UsageLimitSourceInput, UsageLimitSourceView, UsageLimitsReport, UsageSettings,
  UsageSettingsUpdate, UsageSummaryInput,
} from "@agent-workspace/contracts/usage";
import { agentText } from "../i18n";
import { workspaceClient } from "../network.ts";
import { decodeUsageSummary, invalidateUsageSettings } from "./usage-summary-data.ts";

const json = (method: string, value: unknown): RequestInit => ({
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
});

/** All usage operations stay on the authenticated same-origin workspace client. */
export const usageApi = {
  summary: async (input: UsageSummaryInput, refresh = false) => {
    const summary = decodeUsageSummary(await workspaceClient.json<unknown>(refresh ? "/api/usage/refresh" : "/api/usage/summary", json("POST", input)));
    if (summary.sinceDay !== input.sinceDay || summary.untilDay !== input.untilDay || summary.timeZone !== input.timeZone)
      throw new Error(agentText("Usage 返回的数据时间范围与当前查询不一致，未显示该结果。", "Usage returned data for a different time range than the current query; the result was not shown."));
    return summary;
  },
  settings: () => workspaceClient.json<UsageSettings>("/api/usage/settings"),
  updateSettings: async (input: UsageSettingsUpdate) => {
    const saved = await workspaceClient.json<UsageSettings>("/api/usage/settings", json("PATCH", input));
    invalidateUsageSettings();
    return saved;
  },
  limits: () => workspaceClient.json<UsageLimitsReport>("/api/usage/limits"),
  refreshLimits: (instanceIds?: string[]) => workspaceClient.json<UsageLimitsReport>("/api/usage/limits/refresh", json("POST", instanceIds === undefined ? {} : { instanceIds })),
  reset: (input: ProviderConsumeResetCreditInput) => workspaceClient.json<ProviderConsumeResetCreditResult>("/api/usage/limits/reset", json("POST", input)),
  sources: async () => (await workspaceClient.json<{ sources: UsageLimitSourceView[] }>("/api/usage/sources")).sources,
  createSource: async (input: UsageLimitSourceInput) => (await workspaceClient.json<{ source: UsageLimitSourceView }>("/api/usage/sources", json("POST", input))).source,
  updateSource: async (id: string, input: UsageLimitSourceInput) => (await workspaceClient.json<{ source: UsageLimitSourceView }>(`/api/usage/sources/${encodeURIComponent(id)}`, json("PUT", input))).source,
  deleteSource: async (id: string, revision: number) => { await workspaceClient.json<{ deleted: true }>(`/api/usage/sources/${encodeURIComponent(id)}?revision=${encodeURIComponent(revision)}`, { method: "DELETE" }); },
  thread: (threadId: string) => workspaceClient.json<ThreadUsageSnapshot>(`/api/usage/threads/${encodeURIComponent(threadId)}`),
};
