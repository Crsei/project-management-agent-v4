// Turn events ported from t3code packages/provider-pi/src/server/adapter.ts (MIT).
import type { NativeOutputEvent, NativeOutputItem } from "@agent-workspace/contracts/output";
import type { CliTokenUsage } from "../../agents/cli-chat.ts";
import { piRecord, piString, type PiRecord } from "./pi-rpc.ts";
import type { NativeUsageUpdate, UsageTokenTotals } from "@agent-workspace/contracts/usage";
import { ReportedTurnAccumulator, reportedCount } from "./reported-turn.ts";

// Pi input, cacheRead and cacheWrite are disjoint; reasoning is included in
// output. Adapted from t3code provider-pi, Copyright (c) 2026 T3 Tools Inc.
// MIT; see LICENSE.t3code.
function piUsageCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function resultText(value: unknown): string | undefined {
  const result = piRecord(value);
  if (typeof value === "string") return value;
  if (Array.isArray(result.content)) {
    const text = result.content.flatMap((part) => {
      const record = piRecord(part);
      return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
    }).join("\n");
    if (text) return text;
  }
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
  return undefined;
}

export class PiTurnOutput {
  private messages: string[] = [];
  private current = "";
  private messageOpen = false;
  private messageOrdinal = 0;
  private readonly streams = new Map<string, NativeOutputItem>();
  private readonly tools = new Map<string, NativeOutputItem>();
  private compaction: NativeOutputItem | undefined;
  private compactionOrdinal = 0;
  private notificationOrdinal = 0;
  failure: string | undefined;
  aborted = false;
  compacting = false;
  activity = false;
  generation = 0;
  usage: CliTokenUsage = {};
  private readonly totals: UsageTokenTotals = { uncachedInputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  private totalCost = 0;
  private costComplete = true;
  private readonly usageMessages = new Set<string>();
  private readonly reportedTotals = new ReportedTurnAccumulator();
  private totalsComplete = true;
  private readonly onUsage?: (update: NativeUsageUpdate) => void;

  private readonly onText?: (text: string) => void;
  private readonly onEvent?: (event: NativeOutputEvent) => void;
  constructor(onText?: (text: string) => void, onEvent?: (event: NativeOutputEvent) => void, onUsage?: (update: NativeUsageUpdate) => void) {
    this.onText = onText;
    this.onEvent = onEvent;
    this.onUsage = onUsage;
  }
  get text() { return [...this.messages, ...(this.messageOpen ? [this.current] : [])].join("\n\n"); }
  private emit(item: NativeOutputItem) { this.onEvent?.({ type: "item.upsert", item: { ...item } }); }
  private begin() {
    if (this.messageOpen) return;
    this.messageOpen = true;
    this.messageOrdinal++;
    this.current = "";
    this.streams.clear();
    if (this.messages.length) this.onText?.("\n\n");
  }
  private stream(type: "assistant_message" | "reasoning", index: number, text: string, complete = false, terminalStatus: "completed" | "failed" | "cancelled" = "completed") {
    this.begin();
    const key = `${type}:${index}`;
    const previous = this.streams.get(key);
    const item: NativeOutputItem = {
      id: `pi:message:${this.messageOrdinal}:${key}`, type, status: complete ? terminalStatus : "running",
      text, streaming: !complete,
    };
    if (previous?.status === "completed" && !complete) return;
    this.streams.set(key, item);
    this.emit(item);
  }
  private tool(event: PiRecord, phase: "start" | "update" | "end") {
    const nativeId = piString(event, "toolCallId");
    if (!nativeId) return;
    const previous = this.tools.get(nativeId);
    const name = piString(event, "toolName") ?? previous?.toolName ?? "tool";
    const args = event.args ?? previous?.input;
    const input = piRecord(args);
    const type: NativeOutputItem["type"] = previous?.type ?? (name === "bash" || name === "powershell" ? "command_execution" :
      name === "write" || name === "edit" ? "file_change" :
      name === "find" || name === "grep" || name === "ls" ? "file_search" : "dynamic_tool");
    const result = phase === "end" ? event.result : event.partialResult;
    const output = resultText(result) ?? previous?.output;
    const details = piRecord(piRecord(result).details);
    const fileName = piString(input, "path") ?? piString(input, "file_path") ?? previous?.fileName;
    const exitCode = piRecord(piRecord(result).structuredContent).exit_code ?? details.exitCode;
    const item: NativeOutputItem = {
      ...previous, id: `pi:tool:${nativeId}`, nativeItemId: nativeId, type,
      status: phase === "end" ? (event.isError === true ? "failed" : "completed") : "running",
      toolName: name, title: name, ...(args !== undefined ? { input: args } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(fileName ? { fileName } : {}),
      ...(typeof exitCode === "number" && Number.isInteger(exitCode) ? { exitCode } : {}),
      ...(typeof details.patch === "string" ? { diff: details.patch } : typeof details.diff === "string" ? { diff: details.diff } : {}),
      ...(typeof input.oldText === "string" ? { oldText: input.oldText } : {}),
      ...(typeof input.newText === "string" ? { newText: input.newText } : typeof input.content === "string" && name === "write" ? { newText: input.content } : {}),
      ...(event.isError === true && output ? { error: output } : {}),
    };
    this.tools.set(nativeId, item);
    this.emit(item);
    if (type === "command_execution" && output !== undefined) {
      const before = previous?.output ?? "";
      if (output.startsWith(before) && output.length > before.length)
        this.onEvent?.({ type: "command.output", itemId: item.id, chunk: output.slice(before.length) });
    }
    if (name === "subagent" && Array.isArray(details.results)) {
      for (const [index, value] of details.results.entries()) {
        const task = piRecord(value);
        const agent = piString(task, "agent");
        const prompt = piString(task, "task");
        if (!agent || !prompt) continue;
        const finished = phase === "end" || task.finished === true;
        const status = !finished ? "running" : task.stopReason === "aborted" ? "cancelled" :
          task.stopReason === "error" || (typeof task.exitCode === "number" && task.exitCode !== 0) ? "failed" : "completed";
        const messages = Array.isArray(task.messages) ? task.messages : [];
        const assistant = messages.filter((message) => piRecord(message).role === "assistant").at(-1);
        const progress = resultText(assistant);
        this.emit({
          id: `pi:tool:${nativeId}:subagent:${typeof task.step === "number" ? task.step : index}`, type: "subagent",
          status, title: agent, parentItemId: item.id, input: { task: prompt },
          ...(progress ? { output: progress } : {}),
          ...(status === "failed" && typeof task.stderr === "string" && task.stderr ? { error: task.stderr } : {}),
        });
      }
    }
  }
  consume(event: PiRecord): boolean {
    switch (event.type) {
      case "agent_start":
        this.activity = true;
        this.aborted = false;
        this.generation++;
        break;
      case "message_start":
        if (piString(event.message, "role") === "assistant") { this.begin(); this.activity = true; }
        break;
      case "message_update": {
        this.activity = true;
        const delta = piRecord(event.assistantMessageEvent);
        const index = typeof delta.contentIndex === "number" && Number.isInteger(delta.contentIndex) && delta.contentIndex >= 0 ? delta.contentIndex : 0;
        const type = typeof delta.type === "string" && delta.type.startsWith("thinking_") ? "reasoning" : "assistant_message";
        if ((delta.type === "text_delta" || delta.type === "thinking_delta") && typeof delta.delta === "string") {
          this.begin();
          const previous = this.streams.get(`${type}:${index}`);
          this.stream(type, index, (previous?.text ?? "") + delta.delta);
          if (delta.type === "text_delta") { this.current += delta.delta; this.onText?.(delta.delta); }
        } else if (delta.type === "text_end" || delta.type === "thinking_end") {
          this.begin();
          const previous = this.streams.get(`${type}:${index}`);
          const final = type === "reasoning" ? delta.thinking : delta.content;
          this.stream(type, index, typeof final === "string" ? final : previous?.text ?? "", true);
        }
        break;
      }
      case "message_end": {
        const message = piRecord(event.message);
        if (message.role !== "assistant") break;
        this.begin();
        if (Array.isArray(message.content)) {
          const terminalStatus = message.stopReason === "error" ? "failed" : message.stopReason === "aborted" ? "cancelled" : "completed";
          for (const [index, part] of message.content.entries()) {
            const record = piRecord(part);
            if (record.type === "text" && typeof record.text === "string") this.stream("assistant_message", index, record.text, true, terminalStatus);
            if (record.type === "thinking" && typeof record.thinking === "string") this.stream("reasoning", index, record.thinking, true, terminalStatus);
          }
          const final = message.content.filter((part) => piRecord(part).type === "text").map((part) => piString(part, "text") ?? "").join("");
          if (final.startsWith(this.current)) this.onText?.(final.slice(this.current.length));
          this.current = final;
        }
        for (const item of this.streams.values()) {
          if (item.status === "running") this.emit({ ...item, status: message.stopReason === "error" ? "failed" : message.stopReason === "aborted" ? "cancelled" : "completed", streaming: false });
        }
        this.messages.push(this.current);
        this.current = "";
        this.messageOpen = false;
        if (message.stopReason === "error") this.failure = piString(message, "errorMessage") ?? "Pi reported a model error.";
        if (message.stopReason === "aborted") this.aborted = true;
        const usage = piRecord(message.usage);
        for (const [source, target] of [["input", "inputTokens"], ["output", "outputTokens"]] as const) {
          const value = usage[source];
          if (typeof value === "number" && Number.isFinite(value) && value >= 0) this.usage[target] = (this.usage[target] ?? 0) + value;
        }
        if (this.onUsage && [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.reasoning].some(
          (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
        )) {
          const id = piString(message, "id");
          if (!id || !this.usageMessages.has(id)) {
            if (id) this.usageMessages.add(id);
            const reportedTurn = this.reportedTotals.add(usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.reasoning);
            if (![usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.reasoning].every(reportedCount)
              || (reportedCount(usage.reasoning) && reportedCount(usage.output) && usage.reasoning > usage.output)) this.totalsComplete = false;
            const output = piUsageCount(usage.output);
            const step: UsageTokenTotals = {
              uncachedInputTokens: piUsageCount(usage.input), cachedInputTokens: piUsageCount(usage.cacheRead),
              cacheCreationTokens: piUsageCount(usage.cacheWrite), outputTokens: output,
              reasoningTokens: Math.min(output, piUsageCount(usage.reasoning)),
            };
            for (const key of Object.keys(this.totals) as (keyof UsageTokenTotals)[]) {
              const sum = this.totals[key] + step[key];
              if (!Number.isSafeInteger(sum)) this.totalsComplete = false;
              this.totals[key] = Math.min(Number.MAX_SAFE_INTEGER, sum);
            }
            const cost = piRecord(usage.cost).total;
            if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) this.totalCost += cost;
            else this.costComplete = false;
            const provider = piString(message, "provider");
            const model = piString(message, "responseModel") ?? piString(message, "model");
            const turn = this.totalsComplete ? { totals: { ...this.totals }, ...(provider && model ? { model: `${provider}/${model}` } : {}),
              ...(this.costComplete && this.totalCost > 0 && Number.isFinite(this.totalCost) ? { costUsd: this.totalCost } : {}) } : undefined;
            if (turn || reportedTurn) this.onUsage({ ...(turn ? { turn } : {}), ...(reportedTurn ? { reportedTurn } : {}) });
          }
        }
        break;
      }
      case "compaction_start":
        this.compacting = true;
        this.generation++;
        if (this.compaction) this.emit({ ...this.compaction, status: "cancelled" });
        this.compaction = { id: `pi:compaction:${++this.compactionOrdinal}`, type: "compaction", status: "running", title: "Context compaction" };
        this.emit(this.compaction);
        break;
      case "compaction_end": {
        this.compacting = false;
        if (event.willRetry === true && event.result != null && event.aborted !== true) this.failure = undefined;
        const item = this.compaction ?? { id: `pi:compaction:${++this.compactionOrdinal}`, type: "compaction" as const, status: "running" as const, title: "Context compaction" };
        const error = piString(event, "errorMessage") ?? "Pi context compaction failed.";
        this.emit({ ...item, status: event.aborted === true ? "cancelled" : event.result == null ? "failed" : "completed",
          ...(event.result == null && event.aborted !== true ? { error } : {}),
          ...(piString(event.result, "summary") !== undefined ? { text: piString(event.result, "summary") } : {}) });
        this.compaction = undefined;
        break;
      }
      case "auto_retry_end":
        this.failure = event.success === true ? undefined : piString(event, "finalError") ?? "Pi auto-retry failed.";
        break;
      case "tool_execution_start": this.activity = true; this.tool(event, "start"); break;
      case "tool_execution_update": this.tool(event, "update"); break;
      case "tool_execution_end": this.tool(event, "end"); break;
      case "extension_ui_request": {
        const method = piString(event, "method");
        if (method === "notify") {
          const text = piString(event, "message");
          if (text) this.emit({ id: `pi:notification:${++this.notificationOrdinal}`, type: "notification", status: "completed", text, title: piString(event, "notifyType") });
        } else if (method && ["confirm", "select", "input", "editor"].includes(method)) {
          const nativeId = piString(event, "id");
          if (!nativeId) break;
          const id = `pi:request:${nativeId}`;
          const title = piString(event, "title") ?? method;
          const detail = piString(event, "message");
          const approval = method === "confirm";
          const options = Array.isArray(event.options) ? event.options.flatMap((option) =>
            typeof option === "string" && option.length ? [{ id: option, label: option }] : []) : undefined;
          const request = {
            id, itemId: id, kind: approval ? "approval" as const : "user_input" as const, title,
            ...(detail ? { detail } : {}), respondable: false,
            unavailableReason: "Pi interactive requests are cancelled by the existing security policy; use a native terminal.",
            ...(!approval ? { questions: [{ id, prompt: title, ...(options ? { options } : {}), allowText: method !== "select" }] } : {}),
          };
          this.emit({ id, nativeItemId: nativeId, type: approval ? "approval_request" : "user_input_request", status: "cancelled", title, request });
        }
        break;
      }
      case "extension_error": {
        const text = piString(event, "error") ?? piString(event, "message") ?? "Pi extension reported an error.";
        this.emit({ id: `pi:extension-error:${++this.notificationOrdinal}`, type: "error", status: "failed", text, error: text });
        break;
      }
      case "agent_settled":
        this.aborted ||= event.aborted === true;
        return true;
    }
    return false;
  }
}

export function piStateIsIdle(value: unknown): boolean {
  const state = piRecord(value);
  return state.isStreaming !== true && state.isCompacting !== true && (typeof state.pendingMessageCount !== "number" || state.pendingMessageCount === 0);
}
