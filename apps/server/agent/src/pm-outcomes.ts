import { pmToolCallRecordSchema, type PmToolCallRecord } from "@agent-workspace/contracts/pm-tools";
import type { NativeOutputItem } from "@agent-workspace/contracts/output";

/** Receiving a JSON failure record is not new execution evidence for an unproven legacy failure. */
export function normalizePmToolResult(record: PmToolCallRecord): PmToolCallRecord {
  if (record.status === "failed" && !record.certainty && (record.error?.code === "approval_rejected" || record.name === "pm_list_workspaces"))
    return { ...record, certainty: { dispatch: "not_sent", evidence: "local_rejection" } };
  if (record.status === "failed" && (!record.certainty || record.certainty.evidence === "unresolved")) return {
    ...record, status: "unknown", finishedAt: null, certainty: { dispatch: "possibly_sent", evidence: "unresolved" },
    error: { code: "outcome_unknown", message: "The original PM failure lacks definitive execution evidence; reconcile without redispatching." },
  };
  return { ...record, certainty: record.certainty ?? {
    dispatch: "possibly_sent", evidence: record.status === "succeeded" ? "pm_result" : "unresolved",
  } };
}
/** MCP isError describes delivery/tool transport, not the authoritative business outcome. */
export function pmOutcomeFromToolOutput(value: unknown, depth = 0): PmToolCallRecord | null {
  if (depth > 6) return null;
  if (typeof value === "string") {
    try { return pmOutcomeFromToolOutput(JSON.parse(value), depth + 1); } catch { return null; }
  }
  const parsed = pmToolCallRecordSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (typeof value !== "object" || value === null) return null;
  if (Array.isArray(value)) {
    for (const part of value) { const result = pmOutcomeFromToolOutput(part, depth + 1); if (result) return result; }
    return null;
  }
  const envelope = value as Record<string, unknown>;
  for (const name of ["structuredContent", "result", "output", "content", "text"]) {
    if (!(name in envelope)) continue;
    const result = pmOutcomeFromToolOutput(envelope[name], depth + 1);
    if (result) return result;
  }
  return null;
}
/** Keep every provider's duplicate PM tool item faithful to the same operation record. */
export function projectPmNativeOutcome(item: NativeOutputItem): NativeOutputItem {
  if (item.type !== "dynamic_tool") return item;
  const extracted = pmOutcomeFromToolOutput(item.output);
  if (!extracted) return item;
  const record = normalizePmToolResult(extracted);
  if (record.status === "running" && item.status === "unknown") return item;
  return { ...item, status: record.status === "pending_approval" ? "waiting" : record.status === "running" ? "running" : record.status === "succeeded" ? "completed" : record.status,
    ...(record.status === "unknown" ? { completedAt: undefined } : {}) };
}
