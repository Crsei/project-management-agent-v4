import type { GenerationOutputStatus, NativeOutputItem } from "@agent-workspace/contracts/output";

export type OutputPresentationRow =
  | { kind: "item"; key: string; item: NativeOutputItem }
  | { kind: "pm_tool"; key: string; item: NativeOutputItem; operationId: string }
  | { kind: "reasoning" | "tools"; key: string; items: NativeOutputItem[] };

export function isGenerationActive(status: GenerationOutputStatus): boolean {
  return status === "queued" || status === "running";
}

export function isItemActive(item: NativeOutputItem): boolean {
  return item.visibility !== "redacted" && item.visibility !== "unavailable"
    && (item.status === "pending" || item.status === "running" || item.status === "waiting");
}

export function canRespondToInteraction(item: NativeOutputItem, generationStatus: GenerationOutputStatus): boolean {
  return item.request?.respondable === true && isItemActive(item) && isGenerationActive(generationStatus);
}

/** These details must remain visible, never hidden behind an activity disclosure. */
export function requiresVisibleDetails(item: NativeOutputItem): boolean {
  return item.visibility === "redacted" || item.visibility === "unavailable" || item.status === "unknown"
    || !!item.request || item.type === "approval_request" || item.type === "user_input_request"
    || item.type === "error" || !!item.error || item.status === "failed" || item.status === "interrupted"
    || (item.exitCode !== undefined && item.exitCode !== 0) || !!item.mcpApp;
}

export function assistantMessageKind(item: NativeOutputItem): "progress" | "final" | "unknown" {
  return item.phase === "commentary" ? "progress" : item.phase === "final_answer" ? "final" : "unknown";
}

function operationIdFor(item: NativeOutputItem, operations: ReadonlySet<string>): string | undefined {
  if (item.id.startsWith("pm-tool:")) return item.id.slice("pm-tool:".length);
  if (item.type !== "dynamic_tool" || !item.output) return undefined;
  try {
    const value: unknown = JSON.parse(item.output);
    if (value && typeof value === "object" && "operationId" in value && typeof value.operationId === "string" && operations.has(value.operationId)) return value.operationId;
  } catch { /* Ordinary native tool output is not a PM receipt. */ }
  return undefined;
}

function groupKind(item: NativeOutputItem): "reasoning" | "tools" | undefined {
  if (requiresVisibleDetails(item) || item.status === "waiting") return undefined;
  if (item.type === "reasoning") return "reasoning";
  if (["command_execution", "file_change", "file_search", "web_search", "dynamic_tool", "subagent"].includes(item.type)) return "tools";
  return undefined;
}

function sameGroup(left: NativeOutputItem, right: NativeOutputItem): boolean {
  return left.parentItemId === right.parentItemId && left.order?.scope === right.order?.scope
    && (left.type !== "reasoning" || right.type !== "reasoning" || (
      left.reasoningPart?.kind === right.reasoningPart?.kind
      && (!(left.reasoningPart || right.reasoningPart) || (!!left.nativeItemId && left.nativeItemId === right.nativeItemId))
    ));
}

/** Consume the authoritative projection in order; never sort by activity type or text. */
export function presentOutputItems(items: readonly NativeOutputItem[], pmOperationIds: readonly string[] = []): OutputPresentationRow[] {
  const unique = new Map<string, NativeOutputItem>();
  for (const item of items) unique.set(item.id, item);
  const bridges = new Set([...unique.values()].filter(item => item.id.startsWith("pm-tool:")).map(item => item.id.slice("pm-tool:".length)));
  const operations = new Set([...pmOperationIds, ...bridges]);
  const renderedOperations = new Set<string>();
  const rows: OutputPresentationRow[] = [];
  let group: Extract<OutputPresentationRow, { kind: "reasoning" | "tools" }> | undefined;
  for (const item of unique.values()) {
    if (item.visibility === "redacted" || item.visibility === "unavailable") {
      group = undefined;
      rows.push({ kind: "item", key: item.id, item });
      continue;
    }
    if (item.id.startsWith("native-terminal:")) { group = undefined; continue; }
    const operationId = operationIdFor(item, operations);
    if (operationId && !item.mcpApp) {
      group = undefined;
      if (!item.id.startsWith("pm-tool:") && bridges.has(operationId)) continue;
      if (renderedOperations.has(operationId)) continue;
      renderedOperations.add(operationId);
      rows.push({ kind: "pm_tool", key: `pm:${operationId}`, item, operationId });
      continue;
    }
    // An absent summary is not evidence of hidden reasoning. Preserve its boundary only.
    if (item.type === "reasoning" && !item.text?.trim() && !requiresVisibleDetails(item)) { group = undefined; continue; }
    const kind = groupKind(item);
    if (!kind) {
      group = undefined;
      rows.push({ kind: "item", key: item.id, item });
    } else if (group?.kind === kind && sameGroup(group.items[group.items.length - 1]!, item)) {
      group.items.push(item);
    } else {
      group = { kind, key: item.id, items: [item] };
      rows.push(group);
    }
  }
  return rows;
}

/** Provider text only; the full unmodified parts remain available in the disclosure. */
export function reasoningPreview(items: readonly NativeOutputItem[]): string {
  const text = items.find(item => item.visibility !== "redacted" && item.visibility !== "unavailable" && item.text?.trim())?.text?.trim();
  if (!text) return "";
  const firstLine = text.split(/\r?\n/, 1)[0]!.trim();
  return firstLine.replace(/^#{1,6}\s+/u, "").replace(/^(\*\*|__)(.+)\1$/u, "$2");
}

export function generationIndicator(status: GenerationOutputStatus, items: readonly NativeOutputItem[]): "queued" | "processing" | "failed" | "cancelled" | "interrupted" | undefined {
  if (status === "completed") return undefined;
  if (status !== "running") return status;
  const specificActivity = items.some(item => isItemActive(item) && (
    (item.request?.respondable === true)
    || (item.type === "reasoning" ? !!item.text?.trim() : item.type === "assistant_message" ? item.streaming === true : !item.id.startsWith("native-terminal:") && groupKind(item) === "tools")
  ));
  return specificActivity ? undefined : "processing";
}

/** Never turn first-seen-at-completion timestamps into an exact model duration. */
export function reliableDurationMs(item: NativeOutputItem, generationStatus: GenerationOutputStatus, now: number): number | undefined {
  if (item.visibility === "redacted" || item.visibility === "unavailable" || item.status === "unknown") return undefined;
  if (item.timing?.source !== "provider" || !item.startedAt) return undefined;
  const start = Date.parse(item.startedAt);
  const end = item.completedAt ? Date.parse(item.completedAt) : isGenerationActive(generationStatus) && isItemActive(item) ? now : NaN;
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : undefined;
}

/** Volatile choices survive authoritative-history remounts, including explicit collapse. */
export function createOutputDisclosureStore(limit = 256) {
  const choices = new Map<string, boolean>();
  return {
    read(keys: readonly string[], fallback: boolean): boolean {
      for (const key of keys) { const value = choices.get(key); if (value !== undefined) return value; }
      return fallback;
    },
    set(keys: readonly string[], open: boolean): void {
      for (const key of keys) { choices.delete(key); choices.set(key, open); }
      while (choices.size > limit) choices.delete(choices.keys().next().value!);
    },
  };
}
