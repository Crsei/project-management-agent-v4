// Adapted from t3code's Cursor provider adapter.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { StringDecoder } from "node:string_decoder";
import type { InteractionUpdate, NestedTaskUpdate } from "@cursor/sdk";
import type { NativeOutputEvent, NativeOutputItem } from "@agent-workspace/contracts/output";

type RecordValue = Record<string, unknown>;
type Scope = { parentItemId?: string; assistant?: NativeOutputItem; reasoning?: NativeOutputItem };
type ToolState = {
  item: NativeOutputItem;
  args: RecordValue;
  output: string;
  callId: string;
  scope: string;
  decoders?: Map<string, StringDecoder>;
};

function record(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function render(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
// SDK partial tool calls contain snapshots, not JSON string deltas. Preserve fields
// omitted by later snapshots while replacing arrays and scalar values.
function merge(previous: RecordValue, next: RecordValue): RecordValue {
  const result = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue;
    result[key] = value !== null && typeof value === "object" && !Array.isArray(value)
      ? merge(record(previous[key]), record(value)) : value;
  }
  return result;
}
function itemType(name: string): NativeOutputItem["type"] {
  switch (name) {
    case "shell": return "command_execution";
    case "write": case "edit": case "delete": return "file_change";
    case "glob": case "grep": case "semSearch": return "file_search";
    case "createPlan": return "proposed_plan";
    case "updateTodos": return "todo_list";
    case "task": return "subagent";
    default: return "dynamic_tool";
  }
}
function searchResults(name: string, value: RecordValue): NativeOutputItem["results"] {
  if (name === "glob" && Array.isArray(value.files)) {
    return value.files.filter((file): file is string => typeof file === "string").map((path) => ({ path }));
  }
  if (name === "semSearch" && typeof value.results === "string") return [{ text: value.results }];
  if (name !== "grep") return undefined;
  const groups = [...Object.values(record(value.workspaceResults)), value.activeEditorResult];
  const results: NonNullable<NativeOutputItem["results"]> = [];
  for (const group of groups) {
    const output = record(record(group).output);
    if (Array.isArray(output.files)) for (const path of output.files) if (typeof path === "string") results.push({ path });
    if (Array.isArray(output.matches)) for (const match of output.matches) {
      const entry = record(match);
      if (typeof entry.file === "string") results.push({ path: entry.file, text: string(entry.line), line: typeof entry.lineNumber === "number" ? entry.lineNumber : undefined });
    }
    if (Array.isArray(output.counts)) for (const count of output.counts) {
      const entry = record(count);
      if (typeof entry.file === "string") results.push({ path: entry.file, text: render(entry.count) });
    }
  }
  return results;
}

export class CursorOutput {
  private readonly tools = new Map<string, ToolState>();
  private readonly scopes = new Map<string, Scope>();
  private sequence = 0;
  private finished = false;

  private readonly emit: (event: NativeOutputEvent) => void;
  constructor(emit: (event: NativeOutputEvent) => void) { this.emit = emit; }

  update(update: InteractionUpdate): void {
    if (!this.finished) this.process(update, "root");
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    for (const scope of this.scopes.values()) this.closeStreams(scope);
    for (const state of this.tools.values()) {
      if (state.item.status !== "running") continue;
      this.flushCommand(state);
      state.item = { ...state.item, status: "interrupted", streaming: false,
        ...(state.item.type === "command_execution" ? { output: state.output } : {}) };
      this.upsert(state.item);
    }
  }

  private scope(key: string, parentItemId?: string): Scope {
    let scope = this.scopes.get(key);
    if (!scope) { scope = { parentItemId }; this.scopes.set(key, scope); }
    return scope;
  }

  private upsert(item: NativeOutputItem): void { this.emit({ type: "item.upsert", item }); }

  private commandChunk(state: ToolState, chunk: string): void {
    if (!chunk) return;
    state.output += chunk;
    this.emit({ type: "command.output", itemId: state.item.id, chunk });
  }

  private flushCommand(state: ToolState): void {
    if (!state.decoders) return;
    for (const decoder of state.decoders.values()) this.commandChunk(state, decoder.end());
    state.decoders.clear();
  }

  private closeStream(scope: Scope, kind: "assistant" | "reasoning"): void {
    const item = scope[kind];
    if (!item) return;
    scope[kind] = undefined;
    this.upsert({ ...item, status: "completed", streaming: false });
  }

  private closeStreams(scope: Scope): void {
    this.closeStream(scope, "assistant");
    this.closeStream(scope, "reasoning");
  }

  private append(scope: Scope, kind: "assistant" | "reasoning", text: string): void {
    if (!text) return;
    this.closeStream(scope, kind === "assistant" ? "reasoning" : "assistant");
    const current = scope[kind];
    const item: NativeOutputItem = current ? { ...current, text: (current.text ?? "") + text } : {
      id: `cursor:${kind}:${++this.sequence}`, type: kind === "assistant" ? "assistant_message" : "reasoning",
      parentItemId: scope.parentItemId, status: "running", streaming: true, text,
    };
    scope[kind] = item;
    this.upsert(item);
  }

  private process(update: InteractionUpdate | NestedTaskUpdate, scopeKey: string, parentItemId?: string): void {
    const scope = this.scope(scopeKey, parentItemId);
    switch (update.type) {
      case "text-delta": this.append(scope, "assistant", update.text); return;
      case "thinking-delta": this.append(scope, "reasoning", update.text); return;
      case "thinking-completed": this.closeStream(scope, "reasoning"); return;
      case "step-completed": case "turn-ended": this.closeStreams(scope); return;
      case "tool-call-started": case "partial-tool-call": case "tool-call-completed":
        this.closeStreams(scope);
        this.tool(update, scopeKey, scope.parentItemId);
        return;
      case "shell-output-delta": {
        const event = update.event;
        const nativeId = string(event.callId) ?? string(event.call_id) ?? string(event.toolCallId) ?? string(event.tool_call_id);
        const candidates = Array.from(this.tools.values()).reverse();
        const tool = candidates.find((candidate) => candidate.scope === scopeKey && candidate.item.type === "command_execution" && candidate.item.status === "running" && (!nativeId || candidate.callId === nativeId));
        if (!tool) return;
        const stream = string(event.case);
        const data = string(record(event.value).data);
        if ((stream === "stdout" || stream === "stderr") && data !== undefined) {
          tool.decoders ??= new Map();
          let decoder = tool.decoders.get(stream);
          if (!decoder) { decoder = new StringDecoder("utf8"); tool.decoders.set(stream, decoder); }
          this.commandChunk(tool, decoder.write(Buffer.from(data, "base64")));
        } else {
          const chunk = [event.text, event.output, event.data, event.stdout, event.stderr, event.chunk].filter((part): part is string => typeof part === "string").join("");
          this.commandChunk(tool, chunk);
        }
        return;
      }
      case "tool-call-delta": {
        const key = `${scopeKey}/${update.callId}`;
        const parent = this.tools.get(key);
        this.process(update.taskUpdate, key, parent?.item.id ?? `cursor:tool:${encodeURIComponent(key)}`);
        return;
      }
      default: return;
    }
  }

  private tool(update: Extract<InteractionUpdate | NestedTaskUpdate, { type: "tool-call-started" | "partial-tool-call" | "tool-call-completed" }>, scopeKey: string, parentItemId?: string): void {
    const key = `${scopeKey}/${update.callId}`;
    const call = update.toolCall;
    const previous = this.tools.get(key);
    // Do not reopen an already completed tool if a late partial update arrives.
    if (previous && previous.item.status !== "running") return;
    const args = merge(previous?.args ?? {}, record(call.args));
    const result = record(call.result);
    const value = record(result.value);
    const completed = update.type === "tool-call-completed";
    if (completed && previous) this.flushCommand(previous);
    const failed = result.status === "error" || (call.type === "mcp" && value.isError === true);
    const error = failed ? render(result.error ?? result.value) : undefined;
    const type = itemType(call.type);
    const id = previous?.item.id ?? `cursor:tool:${encodeURIComponent(key)}`;
    const item: NativeOutputItem = {
      ...previous?.item, id, nativeItemId: update.callId, parentItemId, type,
      status: completed ? (failed ? "failed" : "completed") : "running",
      streaming: !completed, toolName: call.type, input: args,
      title: string(args.command) ?? string(args.description) ?? string(args.toolName) ?? call.type,
      ...(error !== undefined ? { error } : {}),
    };
    if (type === "command_execution") {
      if (completed) {
        const finalOutput = [string(value.stdout), string(value.stderr)].filter((part): part is string => !!part).join("\n");
        item.output = finalOutput || previous?.output || (failed ? error : "");
        if (typeof value.exitCode === "number" && Number.isInteger(value.exitCode)) item.exitCode = value.exitCode;
      }
    } else if (completed && result.status) {
      item.output = render(result.status === "success" ? result.value : result.error);
    }
    if (type === "file_change") {
      item.fileName = string(args.path);
      item.newText = string(args.fileText);
      item.diff = string(value.diffString);
      if (typeof value.linesAdded === "number" && Number.isInteger(value.linesAdded) && value.linesAdded >= 0) item.additions = value.linesAdded;
      if (typeof value.linesRemoved === "number" && Number.isInteger(value.linesRemoved) && value.linesRemoved >= 0) item.deletions = value.linesRemoved;
      if (item.fileName) item.changes = [{ path: item.fileName, operation: call.type === "write" ? "write" : call.type, diff: item.diff }];
    }
    if (type === "file_search" && result.status === "success") item.results = searchResults(call.type, value);
    if (type === "proposed_plan") item.text = string(args.plan);
    if (type === "todo_list") {
      const todos = Array.isArray(value.todos) ? value.todos : args.todos;
      if (Array.isArray(todos)) item.steps = todos.flatMap((todo, index) => {
        const entry = record(todo);
        if (typeof entry.content !== "string") return [];
        const status = entry.status === "inProgress" ? "running" : entry.status;
        if (status !== "pending" && status !== "running" && status !== "completed" && status !== "cancelled") return [];
        return [{ id: `${id}:step:${index}`, text: entry.content, status }];
      });
    }
    if (type === "subagent") {
      item.text = string(args.prompt);
      item.model = string(args.model);
      item.childSessionId = string(value.agentId) ?? string(args.agentId) ?? string(args.resume);
    }
    const state: ToolState = { item, args, output: previous?.output ?? "", callId: update.callId, scope: scopeKey, decoders: previous?.decoders };
    this.tools.set(key, state);
    this.upsert(item);
  }
}
