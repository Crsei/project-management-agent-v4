import type { DurableRunRequest } from "./durable.js";
import type { WorkspaceRun } from "./workspace.js";

/** A captured request, not a reference to mutable workspace resources. */
export type AutomationRunTemplate = Omit<
  DurableRunRequest,
  "runId" | "idempotencyKey" | "continuationOf"
>;

export type ScheduleTiming =
  | { type: "interval"; minutes: number }
  | { type: "fixed_time"; time: string; weekdays: number[] };
/** Skip all missed slots, or dispatch at most one latest missed slot. Never replay a backlog. */
export type ScheduleMissedPolicy = "skip" | "run_once";
export type ScheduleInput = {
  name: string;
  enabled: boolean;
  timing: ScheduleTiming;
  missedPolicy: ScheduleMissedPolicy;
  request: AutomationRunTemplate;
};
export type AutomationDispatch = {
  id: string;
  sourceType: "schedule" | "watch" | "recovery";
  sourceId: string;
  /** Stable slot/event identity; retries reuse this identity and the captured request. */
  key: string;
  reason: string;
  createdAt: string;
  status: "pending" | "dispatched" | "failed" | "cancelled";
  runId?: string;
  /** Execution status is separate from dispatch acceptance. */
  runStatus?: WorkspaceRun["status"];
  error?: string;
};
export type AutomationSchedule = ScheduleInput & {
  id: string;
  revision: number;
  timeZone: string;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastDispatch?: AutomationDispatch;
};
export type QuotaRecovery = {
  runId: string;
  enabled: boolean;
  state: "waiting" | "cancelled" | "dispatched" | "blocked";
  resetAt: string | null;
  providerInstanceId: string | null;
  updatedAt: string;
  continuationRunId?: string;
  error?: string;
};
export type PullRequestWatchInput = {
  name: string;
  owner: string;
  repo: string;
  number: number;
  enabled: boolean;
  /** At least 60 seconds. GitHub retry/reset headers may postpone this further. */
  pollIntervalSeconds: number;
  /** context is limited to 48000 characters, reserving room for bounded external evidence. */
  request: AutomationRunTemplate;
};
export type PullRequestWatch = PullRequestWatchInput & {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  status: "watching" | "paused" | "closed" | "merged" | "error";
  headSha: string | null;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  error?: string;
  lastDispatch?: AutomationDispatch;
};
export type SchedulesResponse = { schedules: AutomationSchedule[]; timeZone: string };
export type WatchesResponse = { watches: PullRequestWatch[] };
export type RecoveryResponse = { recoveries: QuotaRecovery[] };
export type DispatchesResponse = { dispatches: AutomationDispatch[] };
