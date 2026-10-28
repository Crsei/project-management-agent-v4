// Adapted from t3code usage interfaces. Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import type {
  ProviderConsumeResetCreditInput, ProviderConsumeResetCreditResult, ThreadUsageSnapshot,
  UsageLimitSourceInput, UsageLimitSourceView, UsageLimitsReport, UsageSettings,
  UsageSettingsUpdate, UsageSummary, UsageSummaryInput,
} from "@agent-workspace/contracts/usage";
import { workspaceClient } from "../network.ts";

const json = (method: string, value: unknown): RequestInit => ({
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
});

/** All usage operations stay on the authenticated same-origin workspace client. */
export const usageApi = {
  summary: (input: UsageSummaryInput, refresh = false) => workspaceClient.json<UsageSummary>(refresh ? "/api/usage/refresh" : "/api/usage/summary", json("POST", input)),
  settings: () => workspaceClient.json<UsageSettings>("/api/usage/settings"),
  updateSettings: (input: UsageSettingsUpdate) => workspaceClient.json<UsageSettings>("/api/usage/settings", json("PATCH", input)),
  limits: () => workspaceClient.json<UsageLimitsReport>("/api/usage/limits"),
  refreshLimits: (instanceIds?: string[]) => workspaceClient.json<UsageLimitsReport>("/api/usage/limits/refresh", json("POST", instanceIds === undefined ? {} : { instanceIds })),
  reset: (input: ProviderConsumeResetCreditInput) => workspaceClient.json<ProviderConsumeResetCreditResult>("/api/usage/limits/reset", json("POST", input)),
  sources: async () => (await workspaceClient.json<{ sources: UsageLimitSourceView[] }>("/api/usage/sources")).sources,
  createSource: async (input: UsageLimitSourceInput) => (await workspaceClient.json<{ source: UsageLimitSourceView }>("/api/usage/sources", json("POST", input))).source,
  updateSource: async (id: string, input: UsageLimitSourceInput) => (await workspaceClient.json<{ source: UsageLimitSourceView }>(`/api/usage/sources/${encodeURIComponent(id)}`, json("PUT", input))).source,
  deleteSource: async (id: string, revision: number) => { await workspaceClient.json<{ deleted: true }>(`/api/usage/sources/${encodeURIComponent(id)}?revision=${encodeURIComponent(revision)}`, { method: "DELETE" }); },
  thread: (threadId: string) => workspaceClient.json<ThreadUsageSnapshot>(`/api/usage/threads/${encodeURIComponent(threadId)}`),
};
