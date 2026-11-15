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

/** Only a provider-projected accepted automatic decision may become a quiet record. */
export function isCompletedAutoApproval(item: NativeOutputItem): boolean {
  const request = item.request;
  return item.type === "approval_request" && item.status === "completed"
    && request?.kind === "approval" && request.respondable === false
    && "resolution" in request && request.resolution === "auto_approved";
}

/** These details must remain visible, never hidden behind an activity disclosure. */
export function requiresVisibleDetails(item: NativeOutputItem): boolean {
  const unsafe = item.visibility === "redacted" || item.visibility === "unavailable" || item.status === "unknown"
    || item.type === "error" || !!item.error || item.status === "failed" || item.status === "interrupted"
    || (item.exitCode !== undefined && item.exitCode !== 0) || !!item.mcpApp;
  return unsafe || (!isCompletedAutoApproval(item)
    && (!!item.request || item.type === "approval_request" || item.type === "user_input_request"));
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
  if (isCompletedAutoApproval(item)) return "tools";
  if (isItemActive(item)) return undefined;
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

export type ToolSummary = {
  action: "read" | "edit" | "search" | "web" | "command" | "tool" | "subagent" | "approval";
  target?: string;
};

export function commandText(item: NativeOutputItem): string | undefined {
  if (typeof item.input === "string") return item.input;
  const input = item.input;
  return input && typeof input === "object" && "command" in input && typeof input.command === "string"
    ? input.command : undefined;
}

function inputText(item: NativeOutputItem, keys: readonly string[]): string | undefined {
  const input = item.input;
  if (!input || typeof input !== "object") return undefined;
  for (const key of keys) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** Labels describe observed inputs, never claim that a command achieved its goal. */
export function semanticToolSummary(item: NativeOutputItem): ToolSummary {
  if (item.visibility === "redacted" || item.visibility === "unavailable") return { action: "tool" };
  if (isCompletedAutoApproval(item)) return { action: "approval" };
  if (item.type === "file_change") return { action: "edit", target: item.changes?.length ? `${item.changes[0]!.path}${item.changes.length > 1 ? ` (+${item.changes.length - 1})` : ""}` : item.fileName };
  if (item.type === "file_search") return { action: "search", target: inputText(item, ["query", "pattern", "path"]) || item.title };
  if (item.type === "web_search") return { action: "web", target: inputText(item, ["query", "search_query"]) || item.title };
  if (item.type === "subagent") return { action: "subagent", target: item.title || item.model };
  if (item.type === "command_execution") {
    const command = commandText(item)?.trim();
    // Deliberately recognize only simple read commands. Compound shell input
    // retains a neutral command label and the exact input in expanded details.
    const read = command && /^(?:cat|head|tail)\s+(?:--\s+)?(["']?)([^;&|<>`$()\r\n]+)\1$/u.exec(command);
    if (read && read[2] && !read[2].trim().startsWith("-")) return { action: "read", target: read[2].trim() };
    return { action: "command", target: command?.split(/\r?\n/u, 1)[0] };
  }
  const name = item.toolName?.split(/[.:/]/u).at(-1) || item.toolName;
  if (name && /^(?:read|read_file|readfile)$/iu.test(name)) return { action: "read", target: inputText(item, ["path", "file_path", "filePath", "filename"]) };
  if (name && /^(?:edit|write|apply_patch|edit_file|write_file)$/iu.test(name)) return { action: "edit", target: inputText(item, ["path", "file_path", "filePath", "filename"]) };
  if (name && /^(?:grep|glob|search|file_search)$/iu.test(name)) return { action: "search", target: inputText(item, ["pattern", "query", "path"]) };
  return { action: "tool", target: item.toolName || item.title };
}

export type ChangedFileSummary = {
  path: string;
  oldPath?: string;
  records: NativeOutputItem[];
  additions?: number;
  deletions?: number;
  partialCounts?: boolean;
};

/** Only visible, explicitly projected file changes contribute to the summary. */
export function changedFileSummary(items: readonly NativeOutputItem[]): ChangedFileSummary[] {
  const files = new Map<string, ChangedFileSummary>();
  const unique = new Map(items.map(item => [item.id, item]));
  for (const item of unique.values()) {
    if (item.type !== "file_change" || item.visibility === "redacted" || item.visibility === "unavailable") continue;
    const changes = item.changes?.length ? item.changes : item.fileName ? [{ path: item.fileName, operation: "", diff: item.diff }] : [];
    for (const change of changes) {
      if (!change.path) continue;
      let file = files.get(change.path);
      if (!file) {
        file = { path: change.path, oldPath: change.oldPath, records: [] };
        files.set(change.path, file);
      }
      if (!file.records.some(record => record.id === item.id)) file.records.push(item);
      let additions: number | undefined;
      let deletions: number | undefined;
      if (changes.length === 1 && (item.additions !== undefined || item.deletions !== undefined)) {
        additions = item.additions;
        deletions = item.deletions;
      } else if (change.diff !== undefined && /^@@ /mu.test(change.diff)) {
        additions = 0; deletions = 0;
        for (const line of change.diff.split("\n")) {
          if (line.startsWith("+") && !line.startsWith("+++ ")) additions++;
          if (line.startsWith("-") && !line.startsWith("--- ")) deletions++;
        }
      }
      if (additions === undefined || deletions === undefined) file.partialCounts = true;
      if (additions !== undefined) file.additions = (file.additions ?? 0) + additions;
      if (deletions !== undefined) file.deletions = (file.deletions ?? 0) + deletions;
    }
  }
  return [...files.values()];
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
    || (item.type === "reasoning" ? !!item.text?.trim() : item.type === "assistant_message" ? item.streaming === true : !item.id.startsWith("native-terminal:") && ["command_execution", "file_change", "file_search", "web_search", "dynamic_tool", "subagent"].includes(item.type))
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
