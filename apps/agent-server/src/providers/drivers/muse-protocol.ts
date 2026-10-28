// MSP event and catalog handling ported from t3code/packages/provider-muse/src/server/{protocol,modelCatalog,adapter}.ts (MIT).
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import type { ProviderModel } from "@agent-workspace/contracts/provider";
import type { NativeOutputEvent, NativeOutputItem, OutputStatus } from "@agent-workspace/contracts/output";
import type { NativeUsageUpdate, ServerProviderUsageWindow, UsageTokenTotals } from "@agent-workspace/contracts/usage";
import type { CliTokenUsage } from "../../agents/cli-chat.ts";

export function museRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

// MSP tokenUsage events describe individual model calls; turn/completed is the
// terminal aggregate. Cache and reasoning counters are subsets of input/output.
export function museTokens(value: unknown, inputOverride?: number): UsageTokenTotals | undefined {
  const usage = museRecord(value);
  const input = inputOverride ?? usage.inputTokens;
  const output = usage.outputTokens;
  const cached = usage.cacheReadTokens ?? usage.cachedTokens;
  if (!count(input) || !count(output) || !count(cached) || !count(usage.cacheWriteTokens) || !count(usage.reasoningTokens)) return;
  const write = usage.cacheWriteTokens;
  if (cached > input || write > input - cached || usage.reasoningTokens > output) return;
  return { uncachedInputTokens: input - cached - write, cachedInputTokens: cached, cacheCreationTokens: write, outputTokens: output, reasoningTokens: usage.reasoningTokens };
}

export function museLimits(value: unknown): NativeUsageUpdate["limits"] | undefined {
  const usage = museRecord(value);
  const windows: ServerProviderUsageWindow[] = [];
  for (const [key, id, kind, label] of [["window", "session", "session", "Session"], ["weekly", "weekly", "weekly", "Weekly"]] as const) {
    const window = museRecord(usage[key]);
    if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent) || window.usedPercent < 0) continue;
    const reset = window.resetsAtMs;
    const resetsAt = typeof reset === "number" && Number.isFinite(reset) && reset > 0 && reset <= 8.64e15 ? new Date(reset).toISOString() : undefined;
    windows.push({ id, kind, label, usedPercent: Math.min(100, window.usedPercent), ...(resetsAt ? { resetsAt } : {}), ...(count(window.windowDurationMins) && window.windowDurationMins > 0 ? { windowDurationMins: window.windowDurationMins } : {}) });
  }
  return windows.length ? { windows } : undefined;
}
const fallbackEfforts = ["low", "medium", "high", "xhigh", "max"];
export function parseMuseModels(value: unknown): ProviderModel[] {
  const catalog = museRecord(value);
  if (catalog.providerId !== "meta" || !Array.isArray(catalog.models)) throw new Error("Muse returned an invalid model catalog or a catalog for another provider.");
  const seen = new Set<string>();
  return catalog.models.flatMap((value): ProviderModel[] => {
    const model = museRecord(value);
    if (typeof model.modelId !== "string" || !model.modelId || typeof model.displayLabel !== "string" || typeof model.providerId !== "string" || typeof model.isDefault !== "boolean") throw new Error("Muse returned an invalid model identity.");
    if (model.providerId !== "meta" || seen.has(model.modelId)) return [];
    seen.add(model.modelId);
    const label = model.displayLabel.trim() || model.modelId;
    const efforts = Array.isArray(model.variants) ? model.variants : fallbackEfforts;
    return [{ id: model.modelId, label: label === model.modelId && label.startsWith("muse-") ? label.replaceAll("-", " ").replace(/\b[a-z]/g, (letter) => letter.toUpperCase()) : label, source: "discovered", temperature: false, reasoning: efforts.some((effort) => typeof effort === "string" && effort !== "none") }];
  });
}


type MuseMessage = Record<string, unknown> & { id: string; revision: number; status: string; kind: string };

const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
function itemStatus(item: MuseMessage): OutputStatus {
  if (item.status === "inProgress") return "running";
  if (item.status === "cancelled") return "cancelled";
  if (item.status === "completed" && !(item.kind === "compaction" && item.outcome && item.outcome !== "compacted")) return "completed";
  return "failed";
}
function itemText(item: MuseMessage): string {
  return string(item.text) ?? (Array.isArray(item.summary) ? item.summary.filter((value): value is string => typeof value === "string").join("\n") : undefined) ?? string(item.fallbackText) ?? "";
}
function mapItem(item: MuseMessage): NativeOutputItem | undefined {
  if (item.kind === "userMessage" || item.kind === "reminderChild") return;
  const status = itemStatus(item);
  const base = { id: `muse:item:${item.id}`, nativeItemId: item.id, status, ...(string(item.recordedAt) ? { startedAt: string(item.recordedAt) } : {}) };
  const text = itemText(item);
  if (item.kind === "agentMessage" || item.kind === "reasoning") return { ...base, type: item.kind === "agentMessage" ? "assistant_message" : "reasoning", text: item.retracted === true ? "" : text, streaming: status === "running" };
  if (item.kind === "compaction") return { ...base, type: "compaction", text: text || string(item.reason), error: string(item.failureReason), outputTruncated: item.truncated === true };
  if (item.kind === "subagent" || item.kind === "workflow") {
    const result = museRecord(item.result);
    return { ...base, type: "subagent", title: string(item.objective) ?? string(item.role) ?? string(item.entryId) ?? (item.kind === "workflow" ? "Workflow" : "Muse agent"), text: string(item.objective), input: item.children, output: string(result.text) ?? string(result.summary) ?? string(item.finalSummary) ?? string(item.fallbackText), childSessionId: string(item.childSessionId), error: string(item.failureReason), outputTruncated: item.truncated === true };
  }
  let args: unknown = item.args;
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { /* Partial model-authored arguments are not yet JSON. */ } }
  const fields = museRecord(args);
  const arg = (...keys: string[]) => keys.map((key) => string(fields[key])).find((value) => value !== undefined);
  const tool = string(item.tool) ?? item.kind;
  const output = string(item.visibleOutput) ?? string(museRecord(item.result).summary) ?? (text || string(item.finalSummary) || "");
  const shared = { ...base, title: tool, toolName: tool, input: args, output, outputTruncated: item.truncated === true, error: string(item.failureReason) };
  if (item.kind === "userShell" || (item.kind === "toolCall" && /shell|bash|exec_command/i.test(tool))) return { ...shared, type: "command_execution", input: string(item.commandText) ?? arg("command", "cmd") ?? item.args, exitCode: Number.isInteger(item.exitCode) ? item.exitCode as number : undefined };
  if (item.kind === "toolCall" && /write|edit|patch/i.test(tool)) {
    const fileName = arg("file_path", "path", "filePath");
    const summary = museRecord(item.patchSummary);
    if (fileName) return { ...shared, type: "file_change", fileName, oldText: arg("old_string", "old_str", "oldStr", "oldText"), newText: arg("new_string", "new_str", "newStr", "newText", "content"), diff: arg("diff", "patch", "diffStr"), additions: Number.isInteger(summary.added) && Number(summary.added) >= 0 ? summary.added as number : undefined, deletions: Number.isInteger(summary.removed) && Number(summary.removed) >= 0 ? summary.removed as number : undefined };
  }
  if (item.kind === "webSearch" || (item.kind === "toolCall" && /web|browse|fetch/i.test(tool))) {
    let results: NativeOutputItem["results"];
    try {
      const parsed = museRecord(JSON.parse(output));
      if (Array.isArray(parsed.results)) results = parsed.results.map(museRecord).map((entry) => ({ title: string(entry.title), url: string(entry.url), text: string(entry.snippet) }));
    } catch { /* Non-JSON output remains visible as text. */ }
    return { ...shared, type: "web_search", text: arg("query", "url", "pattern"), results };
  }
  if (item.kind === "toolCall" && /glob|grep|search/i.test(tool)) return { ...shared, type: "file_search", text: arg("query", "pattern", "path") };
  return { ...shared, type: "dynamic_tool" };
}

export class MuseTurnOutput {
  private readonly items = new Map<string, MuseMessage>();
  private readonly joined = new Set<string>();
  private readonly emitted = new Map<string, string>();
  usage: CliTokenUsage | undefined;
  terminal: string | undefined;
  failure: string | undefined;
  readonly sessionId: string;
  readonly turnId: string;
  private readonly onText?: (text: string) => void;
  private readonly onEvent?: (event: NativeOutputEvent) => void;
  constructor(sessionId: string, turnId: string, onText?: (text: string) => void, onEvent?: (event: NativeOutputEvent) => void) {
    this.sessionId = sessionId; this.turnId = turnId; this.onText = onText; this.onEvent = onEvent;
  }
  get text() { return [...this.items.values()].filter((item) => item.kind === "agentMessage" && item.retracted !== true).map(itemText).join("\n\n"); }
  ownsTurn(id: string) { return id === this.turnId || this.joined.has(id); }
  references() {
    return [...this.items.values()].flatMap((item) => {
      const result: { itemId: string; revision: number; refId: string; kind: "output" | "patch" }[] = [];
      for (const [field, kind] of [["outputRef", "output"], ["patchRef", "patch"]] as const) {
        const ref = museRecord(item[field]);
        if ((kind === "patch" || item.truncated === true) && ref.availability === "available" && typeof ref.id === "string" && ref.id) result.push({ itemId: item.id, revision: item.revision, refId: ref.id, kind });
      }
      return result;
    });
  }
  applyReference(ref: { itemId: string; revision: number; kind: "output" | "patch" }, content: string, truncated: boolean) {
    const previous = this.items.get(ref.itemId);
    if (!previous || previous.revision !== ref.revision) return;
    if (ref.kind === "output") {
      const next = { ...previous, visibleOutput: content, truncated };
      this.items.set(next.id, next);
      this.publish(next, previous);
    } else {
      let input: unknown = content;
      if (!truncated) { try { input = JSON.parse(content); } catch { /* Retain the original stored bytes. */ } }
      this.onEvent?.({ type: "item.upsert", item: { id: `muse:patch:${ref.itemId}`, parentItemId: `muse:item:${ref.itemId}`, nativeItemId: ref.itemId, type: "dynamic_tool", status: itemStatus(previous), title: "Muse structured patch", toolName: "tool_patch", input, outputTruncated: truncated } });
    }
  }
  private publish(item: MuseMessage, previous?: MuseMessage) {
    const mapped = mapItem(item);
    if (mapped) {
      this.onEvent?.({ type: "item.upsert", item: mapped });
      if (mapped.type === "command_execution") {
        const before = previous ? string(previous.visibleOutput) ?? "" : "";
        const after = string(item.visibleOutput) ?? "";
        if (after.startsWith(before) && after.length > before.length) this.onEvent?.({ type: "command.output", itemId: mapped.id, chunk: after.slice(before.length) });
      }
    }
    if (item.kind === "workflow" && Array.isArray(item.children)) {
      for (const child of item.children.map(museRecord)) {
        if (typeof child.childId !== "string" || !child.childId || !Number.isInteger(child.attempt)) continue;
        const terminal = string(child.terminal) ?? string(child.status);
        const status: OutputStatus = child.failureKind || terminal === "failed" || terminal === "rejected" ? "failed" : terminal === "completed" ? "completed" : terminal === "cancelled" ? "cancelled" : terminal === "pending" || terminal === "queued" ? "pending" : "running";
        this.onEvent?.({ type: "item.upsert", item: { id: `muse:workflow:${item.id}:${child.childId}:${child.attempt}`, nativeItemId: child.childId, parentItemId: `muse:item:${item.id}`, type: "subagent", status, title: string(child.label) ?? child.childId, text: string(child.phase), output: string(child.resultRef), error: string(child.failureReason) } });
      }
    }
    if (item.kind !== "agentMessage" || item.retracted === true) return;
    const text = itemText(item);
    if (!text && !this.emitted.has(item.id)) return;
    const prior = this.emitted.get(item.id) ?? "";
    if (!this.emitted.has(item.id) && this.emitted.size > 0 && text) this.onText?.("\n\n");
    if (text.startsWith(prior)) {
      const delta = text.slice(prior.length);
      if (delta) this.onText?.(delta);
    }
    this.emitted.set(item.id, text);
  }
  consume(method: string, raw: unknown): boolean {
    const params = museRecord(raw);
    if (params.sessionId !== undefined && params.sessionId !== this.sessionId) return false;
    if (method === "view/gap") throw new Error("Muse MSP reported a view gap; part of the response was lost.");
    if (method === "turn/started" && typeof params.turnId === "string" && params.turnId !== this.turnId) {
      this.joined.add(params.turnId);
      return false;
    }
    if (typeof params.turnId === "string" && params.turnId !== this.turnId && !this.joined.has(params.turnId)) return false;
    if (["item/started", "item/updated", "item/completed"].includes(method)) {
      const item = museRecord(params.item);
      if (typeof item.turnId === "string" && item.turnId !== this.turnId && !this.joined.has(item.turnId)) return false;
      if (typeof item.itemId !== "string" || !item.itemId || typeof item.kind !== "string" || !Number.isInteger(item.revision) || Number(item.revision) < 1 || typeof item.status !== "string") throw new Error("Invalid Muse item notification.");
      const previous = this.items.get(item.itemId);
      if (previous && previous.revision >= Number(item.revision)) return false;
      const next: MuseMessage = { ...item, id: item.itemId, kind: item.kind, revision: Number(item.revision), status: item.status };
      this.items.set(next.id, next);
      this.publish(next, previous);
    } else if (method === "item/delta") {
      if (typeof params.itemId !== "string" || typeof params.delta !== "string") throw new Error("Invalid Muse delta notification.");
      const previous = this.items.get(params.itemId);
      if (!previous || previous.status !== "inProgress") return false;
      const field = params.field ?? "text";
      let next: MuseMessage;
      if (field === "text") next = { ...previous, text: (string(previous.text) ?? "") + params.delta };
      else if (field === "output" || field === "visibleOutput") next = { ...previous, visibleOutput: (string(previous.visibleOutput) ?? "") + params.delta };
      else if (typeof field === "string" && /^summary\.\d+$/.test(field)) {
        const index = Number(field.slice(8));
        if (!Number.isSafeInteger(index) || index >= 100) return false;
        const summary = Array.isArray(previous.summary) ? [...previous.summary] : [];
        summary[index] = (string(summary[index]) ?? "") + params.delta;
        next = { ...previous, summary };
      } else return false;
      this.items.set(next.id, next);
      this.publish(next, previous);
    } else if (method === "session/todoListChanged") {
      if (!Array.isArray(params.items)) throw new Error("Invalid Muse todo list notification.");
      const steps: NonNullable<NativeOutputItem["steps"]> = params.items.map(museRecord).flatMap((entry, index) => {
        if (typeof entry.text !== "string" || !entry.text.trim()) return [];
        const status = entry.status === "completed" ? "completed" : entry.status === "cancelled" ? "cancelled" : entry.status === "inProgress" ? "running" : "pending";
        return [{ id: `muse:todo:${index}`, text: entry.text, status }];
      });
      this.onEvent?.({ type: "item.upsert", item: { id: "muse:todo", type: "todo_list", status: steps.every((step) => step.status === "completed" || step.status === "cancelled") ? "completed" : "running", steps } });
    } else if (method === "turn/completed") {
      if (params.turnId !== this.turnId) return false;
      if (typeof params.terminal !== "string") throw new Error("Invalid Muse terminal notification.");
      this.terminal = params.terminal;
      const error = museRecord(params.error);
      this.failure = typeof error.message === "string" ? error.message : typeof params.reason === "string" ? params.reason : undefined;
      const usage = museRecord(params.usage);
      if (typeof usage.inputTokens === "number" && typeof usage.outputTokens === "number" && Number.isFinite(usage.inputTokens) && Number.isFinite(usage.outputTokens) && usage.inputTokens >= 0 && usage.outputTokens >= 0) this.usage = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
      if ([...this.items.values()].some((item) => item.kind === "agentMessage" && !item.retracted && item.truncated)) throw new Error("Muse returned a truncated agent message.");
      return true;
    }
    return false;
  }
}
