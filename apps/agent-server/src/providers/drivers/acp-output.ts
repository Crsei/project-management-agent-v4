// Adapted from t3code packages/provider-acp and effect-acp protocol (MIT).
// Copyright (c) 2026 T3 Tools Inc. See LICENSE.t3code.
import type { NativeInteractionRequest, NativeInteractionResponse, NativeOutputEvent, NativeOutputItem, OutputStatus } from "@agent-workspace/contracts/output";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const contentText = (value: unknown): string => {
  if (Array.isArray(value)) return value.map(contentText).join("");
  const block = record(value);
  return block.type === "text" && typeof block.text === "string" ? block.text : "";
};
const status = (value: unknown): OutputStatus => value === "completed" ? "completed" : value === "failed" ? "failed" : value === "cancelled" ? "cancelled" : value === "pending" ? "pending" : "running";
const outputString = (value: unknown): string | undefined => value === undefined || value === null ? undefined : typeof value === "string" ? value : JSON.stringify(value);

export class AcpTurnOutput {
  private readonly items = new Map<string, NativeOutputItem>();
  private readonly tools = new Map<string, RecordValue>();
  private readonly terminalParents = new Map<string, string>();
  private serial = 0;
  private current?: { key: string; kind: string };
  private readonly emit?: (event: NativeOutputEvent) => void;
  private readonly grok: boolean;
  constructor(emit?: (event: NativeOutputEvent) => void, grok = false) {
    this.emit = emit;
    this.grok = grok;
  }
  private put(item: NativeOutputItem) { this.items.set(item.id, item); this.emit?.({ type: "item.upsert", item }); }
  private closeMessage() {
    if (!this.current) return;
    const item = this.items.get(this.current.key);
    if (item && item.status === "running") this.put({ ...item, status: "completed", streaming: false });
    this.current = undefined;
  }
  finish() { this.closeMessage(); }
  error(message: string) {
    this.closeMessage();
    this.put({ id: `acp:error:${++this.serial}`, type: "error", status: "failed", error: message });
  }
  private message(update: RecordValue, kind: "assistant_message" | "reasoning", full: boolean, childSessionId?: string) {
    const native = string(update.messageId);
    const identity = `${childSessionId ?? "root"}:${kind}:${native ?? ""}`;
    if (this.current && this.current.kind !== identity) this.closeMessage();
    const id = native ? `acp:${identity}` : this.current?.key ?? `acp:${kind}:${++this.serial}`;
    const old = this.items.get(id);
    const text = contentText(update.content);
    this.current = { key: id, kind: identity };
    const parent = childSessionId?.startsWith("copilot-task:") ? childSessionId.slice("copilot-task:".length) : childSessionId;
    this.put({ id, type: kind, status: full ? "completed" : "running", streaming: !full, ...(native ? { nativeItemId: native } : {}), ...(parent ? { parentItemId: `acp:subagent:${parent}` } : {}), text: full ? text : (old?.text ?? "") + text });
    if (full) this.current = undefined;
  }
  consumeChild(update: RecordValue, childSessionId: string) {
    const type = update.sessionUpdate;
    if (type === "agent_message_chunk" || type === "agent_thought_chunk" || type === "agent_message" || type === "agent_thought") this.message(update, type === "agent_message_chunk" || type === "agent_message" ? "assistant_message" : "reasoning", type === "agent_message" || type === "agent_thought", childSessionId);
  }
  consume(update: RecordValue) {
    const type = update.sessionUpdate;
    if (type === "agent_message_chunk" || type === "agent_thought_chunk" || type === "agent_message" || type === "agent_thought") {
      this.message(update, type === "agent_message_chunk" || type === "agent_message" ? "assistant_message" : "reasoning", type === "agent_message" || type === "agent_thought"); return;
    }
    if (type === "tool_call" || type === "tool_call_update" || type === "tool_call_content_chunk") {
      this.closeMessage();
      const native = string(update.toolCallId); if (!native) return;
      const previous = this.tools.get(native) ?? {};
      const patch = type === "tool_call_content_chunk" ? { content: [...(Array.isArray(previous.content) ? previous.content : []), update.content] } : update;
      const tool = { ...previous, ...patch }; this.tools.set(native, tool);
      const meta = record(tool._meta); const started = record(meta["cognition.ai/subagent_started"]); const completed = record(meta["cognition.ai/subagent_completed"]);
      const agent = string(completed.agentId) ?? string(started.agentId);
      if (agent) {
        const childId = `acp:subagent:${agent}`; const old = this.items.get(childId);
        this.put({ id: childId, type: "subagent", nativeItemId: agent, childSessionId: agent, status: Object.keys(completed).length ? completed.success === false ? "failed" : "completed" : "running", ...(string(started.title) ?? old?.title ? { title: string(started.title) ?? old?.title } : {}), ...(string(started.task) ?? old?.text ? { text: string(started.task) ?? old?.text } : {}), ...(string(started.model) ?? old?.model ? { model: string(started.model) ?? old?.model } : {}), ...(string(completed.summary) ? { output: string(completed.summary) } : {}) });
      }
      const id = `acp:tool:${native}`; const kind = tool.kind;
      let itemType: NativeOutputItem["type"] = kind === "execute" ? "command_execution" : kind === "edit" || kind === "delete" || kind === "move" ? "file_change" : kind === "search" ? "file_search" : kind === "fetch" ? "web_search" : "dynamic_tool";
      const parts = Array.isArray(tool.content) ? tool.content.map(record) : [];
      const diffs = parts.filter((part) => part.type === "diff");
      if (diffs.length) itemType = "file_change";
      const diff = diffs[0];
      const changes = diffs.flatMap((part) => Array.isArray(part.changes) ? part.changes.map(record).flatMap((entry) => typeof entry.path === "string" ? [{ path: entry.path, operation: string(entry.operation) ?? "edit", ...(string(entry.oldPath) ? { oldPath: string(entry.oldPath) } : {}) }] : []) : typeof part.path === "string" ? [{ path: part.path, operation: "edit" }] : []);
      for (const part of parts) if (part.type === "terminal" && typeof part.terminalId === "string") this.terminalParents.set(part.terminalId, id);
      const text = parts.filter((part) => part.type === "content").map((part) => contentText(part.content)).join("");
      const rawOutput = outputString(tool.rawOutput);
      const rawInput = record(tool.rawInput);
      const toolName = (string(tool.name) ?? string(tool.title) ?? "").toLowerCase();
      const variant = (string(rawInput.variant) ?? "").toLowerCase();
      if (this.grok && (["task", "spawn_subagent"].includes(toolName) || toolName.includes("spawn subagent") || ["cursortask", "task", "spawn_subagent"].includes(variant) || typeof rawInput.subagent_type === "string" || typeof rawInput.subagentType === "string")) {
        const result = typeof tool.rawOutput === "string" ? tool.rawOutput : string(record(tool.rawOutput).output) ?? string(record(tool.rawOutput).text) ?? text;
        const childSessionId = /(?:^|\n)\s*(?:Agent ID|subagent_id):\s*([0-9a-f]{8}-[0-9a-f-]{27,})\b/i.exec(result)?.[1] ?? /===\s*Task\s+([0-9a-f]{8}-[0-9a-f-]{27,})\s*===/i.exec(result)?.[1];
        const background = /subagent started in background/i.test(result) || (/subagent_id:/i.test(result) && /get_command_or_subagent_output/i.test(result));
        this.put({ id: `acp:subagent:${native}`, type: "subagent", nativeItemId: native, status: background ? "running" : status(tool.status), ...(childSessionId ? { childSessionId } : {}), ...(string(rawInput.description) ? { title: string(rawInput.description) } : {}), ...(string(rawInput.prompt) ? { text: string(rawInput.prompt) } : {}), ...(string(rawInput.model) ? { model: string(rawInput.model) } : {}), ...(!background && result ? { output: result } : {}) });
      }
      const item: NativeOutputItem = { id, type: itemType, nativeItemId: native, status: status(tool.status), ...(string(tool.title) ? { title: string(tool.title) } : {}), ...(string(tool.name) ? { toolName: string(tool.name) } : {}), ...(tool.rawInput !== undefined ? { input: tool.rawInput } : {}), ...(rawOutput !== undefined || text ? { output: rawOutput ?? text } : {}), ...(changes.length ? { changes } : {}), ...(diff && string(diff.path) ? { fileName: string(diff.path) } : {}), ...(diff && typeof diff.oldText === "string" ? { oldText: diff.oldText } : {}), ...(diff && typeof diff.newText === "string" ? { newText: diff.newText } : {}), ...(diff && typeof record(diff.patch).text === "string" ? { diff: record(diff.patch).text as string } : {}) };
      const chunk = type === "tool_call_content_chunk" && itemType === "command_execution" && record(update.content).type === "content" ? contentText(record(update.content).content) : "";
      if (chunk) {
        if (!this.items.has(id)) this.put({ id, type: itemType, nativeItemId: native, status: item.status, ...(item.title ? { title: item.title } : {}) });
        this.items.set(id, item);
        this.emit?.({ type: "command.output", itemId: id, chunk });
      } else this.put(item);
      return;
    }
    if (type === "terminal_update" || type === "terminal_output_chunk") {
      this.closeMessage(); const native = string(update.terminalId); if (!native) return;
      const id = `acp:terminal:${native}`; const old = this.items.get(id);
      const exit = record(update.exitStatus); const payload = record(update.output);
      const chunk = type === "terminal_output_chunk" ? string(update.data) : undefined;
      const combined = chunk !== undefined ? (old?.output ?? "") + chunk : string(payload.data) ?? old?.output;
      const output = combined?.slice(-4 * 1024 * 1024);
      const exitCode = typeof exit.exitCode === "number" ? exit.exitCode : undefined;
      const item: NativeOutputItem = { id, type: "command_execution", nativeItemId: native, status: update.exitStatus ? (exitCode === 0 ? "completed" : "failed") : "running", ...(this.terminalParents.get(native) ? { parentItemId: this.terminalParents.get(native) } : {}), ...(string(update.command) ?? old?.title ? { title: string(update.command) ?? old?.title } : {}), ...(output !== undefined ? { output } : {}), ...(payload.truncated === true || (combined !== undefined && output !== combined) || old?.outputTruncated ? { outputTruncated: true } : {}), ...(exitCode !== undefined ? { exitCode } : {}) };
      if (chunk !== undefined) {
        if (!old) this.put({ id, type: "command_execution", nativeItemId: native, status: "running", ...(item.parentItemId ? { parentItemId: item.parentItemId } : {}) });
        this.items.set(id, item);
        if (chunk) this.emit?.({ type: "command.output", itemId: id, chunk });
      } else this.put(item);
      return;
    }
    if (type === "plan" || type === "plan_update" || type === "plan_removed") {
      this.closeMessage(); const plan = type === "plan" ? update : record(update.plan); const native = string(plan.planId) ?? string(update.planId) ?? "default"; const id = `acp:plan:${native}`;
      if (type === "plan_removed") { const old = this.items.get(id); if (old) this.put({ ...old, status: "cancelled" }); return; }
      const steps: NonNullable<NativeOutputItem["steps"]> = Array.isArray(plan.entries) ? plan.entries.map(record).map((entry, index) => ({ id: String(index), text: string(entry.content) ?? "", status: entry.status === "completed" ? "completed" : entry.status === "cancelled" ? "cancelled" : entry.status === "in_progress" ? "running" : "pending" })) : [];
      this.put({ id, type: plan.type === "markdown" || plan.type === "file" ? "proposed_plan" : "todo_list", nativeItemId: native, status: steps.length && steps.every((step) => step.status === "completed") ? "completed" : "running", ...(steps.length ? { steps } : {}), ...(string(plan.content) ?? string(plan.uri) ? { text: string(plan.content) ?? string(plan.uri) } : {}) }); return;
    }
    if (type === "compaction_update" || type === "compaction_summary_chunk") {
      this.closeMessage(); const native = string(update.compactionId); if (!native) return;
      const id = `acp:compaction:${native}`; const old = this.items.get(id); const text = type === "compaction_summary_chunk" ? (old?.text ?? "") + contentText(update.content) : contentText(update.summary) || old?.text;
      this.put({ id, type: "compaction", nativeItemId: native, status: status(update.status), ...(text ? { text } : {}), ...(string(update.error) ? { error: string(update.error) } : {}) });
    }
  }
  notification(method: string, params: RecordValue) {
    if (method !== "github.com/copilot/sessionEvent" || !["subagent.started", "subagent.completed", "subagent.failed"].includes(String(params.type))) return;
    const data = record(params.data); const native = string(data.toolCallId); if (!native) return;
    this.closeMessage(); const id = `acp:subagent:${native}`;
    this.put({ id, type: "subagent", nativeItemId: native, childSessionId: `copilot-task:${native}`, status: params.type === "subagent.started" ? "running" : params.type === "subagent.failed" ? "failed" : "completed", ...(string(data.error) ? { error: string(data.error) } : {}) });
  }
  async grokQuestion(params: RecordValue, onRequest: (request: NativeInteractionRequest) => Promise<NativeInteractionResponse>, signal?: AbortSignal): Promise<RecordValue> {
    const source = record(params.params).questions ? record(params.params) : params;
    if (!Array.isArray(source.questions) || !source.questions.length) throw new Error("Invalid Grok user question request.");
    const nativeQuestions = source.questions.map(record);
    if (nativeQuestions.some((question) => typeof question.question !== "string" || !Array.isArray(question.options) || question.options.some((option: unknown) => typeof record(option).label !== "string"))) throw new Error("Invalid Grok user question request.");
    if (signal?.aborted) return { outcome: "cancelled" };
    this.closeMessage();
    const id = `acp:question:${++this.serial}`;
    const questions = nativeQuestions.map((question, index) => ({
      id: `q:${index}`, prompt: question.question as string, multiple: question.multiSelect === true, allowText: true,
      options: (question.options as unknown[]).map((entry, optionIndex) => { const option = record(entry); return { id: `option:${optionIndex}`, label: option.label as string, ...(typeof option.description === "string" ? { description: option.description } : {}) }; }),
    }));
    const request: NativeInteractionRequest = { id, itemId: id, kind: "user_input", title: "Grok question", respondable: true, questions };
    this.put({ id, type: "user_input_request", status: "waiting", title: request.title, request });
    const cancelled = Promise.withResolvers<NativeInteractionResponse>();
    const abort = () => cancelled.resolve({ cancelled: true });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let response: NativeInteractionResponse;
    try { response = await Promise.race([onRequest(request), cancelled.promise]); }
    finally { signal?.removeEventListener("abort", abort); }
    const isCancelled = response.cancelled === true || signal?.aborted === true;
    this.put({ id, type: "user_input_request", status: isCancelled ? "cancelled" : "completed", title: request.title, request: { ...request, respondable: false } });
    if (isCancelled) return { outcome: "cancelled" };
    const answers: Record<string, string[]> = {}; const annotations: Record<string, { preview?: string; notes?: string }> = {};
    for (let index = 0; index < nativeQuestions.length; index++) {
      const question = nativeQuestions[index]!; const value = response.answers?.[`q:${index}`];
      const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
      const nativeOptions = (question.options as unknown[]).map(record);
      const selected: string[] = []; const notes: string[] = []; let preview: string | undefined;
      for (const answer of values) {
        const match = /^option:(\d+)$/.exec(answer);
        const option = match ? nativeOptions[Number(match[1])] : undefined;
        if (option && typeof option.label === "string") { selected.push(option.label); if (question.multiSelect !== true && typeof option.preview === "string") preview = option.preview; }
        else if (answer.trim()) notes.push(answer.trim());
      }
      if (!selected.length && !notes.length) continue;
      const questionText = question.question as string;
      answers[questionText] = selected.length ? selected : ["Other"];
      if (preview || notes.length) annotations[questionText] = { ...(preview ? { preview } : {}), ...(notes.length ? { notes: notes.join("\n") } : {}) };
    }
    return { outcome: "accepted", answers, ...(Object.keys(annotations).length ? { annotations } : {}) };
  }
  rejectedRequest(method: string, params: RecordValue) {
    const relevant = method === "session/request_permission" || ["elicitation/create", "session/elicitation", "_session/elicitation", "x.ai/ask_user_question", "_x.ai/ask_user_question", "x.ai/exit_plan_mode", "_x.ai/exit_plan_mode"].includes(method);
    if (!relevant) return;
    this.closeMessage(); const id = `acp:request:${++this.serial}`; const approval = method === "session/request_permission" || method.endsWith("exit_plan_mode");
    const title = string(params.title) ?? string(params.message) ?? (approval ? "Permission request" : "User input request");
    const request = { id, itemId: id, kind: approval ? "approval" as const : "user_input" as const, title, respondable: false, unavailableReason: "The current provider policy rejects this native request." };
    this.put({ id, type: approval ? "approval_request" : "user_input_request", status: "cancelled", title, input: params, request });
  }
}
