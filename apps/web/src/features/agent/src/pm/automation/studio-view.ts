import type { StudioConfig, StudioExecution, StudioPage } from "../../../../../../../../packages/contracts/src/automation-studio";
import type { AgentText } from "../../i18n";

export type StudioDraftRoute = { templateId: string | null; projectId: string };
/** Local recovery IDs are not server definition IDs. Preserve blank/template/project identity on Chat return. */
export function parseStudioDraftRoute(value: string | null): StudioDraftRoute | null {
  const match = /^new:([^:]+):(PRJ-\d+)?$/.exec(value ?? "");
  return match ? { templateId: match[1] === "blank" ? null : match[1]!, projectId: match[2] ?? "" } : null;
}

export function studioTriggerLabel(trigger: StudioConfig["trigger"], t: AgentText): string {
  if (trigger.kind === "manual") return t("仅手动", "Manual only");
  if (trigger.kind === "once") {
    const at = new Intl.DateTimeFormat(undefined, { timeZone: trigger.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(trigger.at));
    return t(`单次 · ${at} · ${trigger.timezone}`, `Once · ${at} · ${trigger.timezone}`);
  }
  if (trigger.kind === "event") return `${trigger.source} · ${trigger.key}`;
  return `${trigger.expression} · ${trigger.timezone}`;
}
export function studioStatusLabel(status: string, t: AgentText): string {
  const copy: Record<string, [string, string]> = { draft: ["已存草稿", "Saved draft"], enabled: ["已启用", "Active"], paused: ["已暂停", "Inactive"], queued: ["排队中", "Queued"], running: ["运行中", "Running"], completed: ["完成", "Completed"], failed: ["失败", "Failed"], skipped: ["已跳过", "Skipped"], cancelled: ["已取消", "Cancelled"], cancel_requested: ["取消待核对", "Cancellation requested"], outcome_unknown: ["结果未知", "Outcome unknown"] };
  const value = copy[status]; return value ? t(...value) : status;
}
export function studioExecutionNeedsRefresh(run: Pick<StudioExecution, "status">): boolean {
  return run.status === "queued" || run.status === "running" || run.status === "cancel_requested" || run.status === "outcome_unknown";
}
export function executionDuration(run: Pick<StudioExecution, "startedAt" | "finishedAt">): number | null {
  if (!run.startedAt || !run.finishedAt) return null;
  const value = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  return Number.isFinite(value) && value >= 0 ? value : null;
}
/** A repeated cursor is an error, never a silently truncated successful export. */
export async function readEveryStudioPage<T>(read: (cursor?: string) => Promise<StudioPage<T>>): Promise<T[]> {
  const items: T[] = []; const seen = new Set<string>(); let cursor: string | undefined;
  do {
    const page = await read(cursor); items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error("invalid_pagination_cursor");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return items;
}
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value) ?? "";
  // Spreadsheet applications must not treat log/error text as a formula.
  const safe = /^[\s\u0000]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function downloadStudioFile(contents: string, filename: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
