// Adapted from t3code ClaudeAdapterV2 and Claude Agent SDK message types.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import type { NativeInteractionRequest, NativeOutputEvent, NativeOutputItem } from "@agent-workspace/contracts/output";
import { object } from "./codex-rpc.ts";

const str = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const display = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value) ?? "";

type Block = { id: string; kind: string; text: string; json: string; finalized: boolean; toolId?: string };
export class ClaudeOutput {
  private items = new Map<string, NativeOutputItem>();
  private blocks = new Map<string, Block[]>();
  private seenSnapshots = new Set<string>();
  private activeMessages = new Map<string, string>();
  private taskItems = new Map<string, string>();
  private compactionId: string | undefined;
  private sequence = 0;
  private emit: ((event: NativeOutputEvent) => void) | undefined;
  private onText: ((text: string) => void) | undefined;
  constructor(emit?: (event: NativeOutputEvent) => void, onText?: (text: string) => void) { this.emit = emit; this.onText = onText; }
  private put(item: NativeOutputItem): void { this.items.set(item.id, item); this.emit?.({ type: "item.upsert", item }); }
  private tool(id: string, name: string, input: unknown, parent?: string): void {
    const key = `claude:tool:${id}`; const previous = this.items.get(key); const record = object(input);
    const normalized = name.toLowerCase().replaceAll(/[\s_-]/g, "");
    const type: NativeOutputItem["type"] = normalized === "bash" ? "command_execution" : ["edit", "multiedit", "write", "notebookedit"].includes(normalized) ? "file_change" : ["glob", "grep"].includes(normalized) ? "file_search" : ["websearch", "webfetch"].includes(normalized) ? "web_search" : ["agent", "task"].includes(normalized) ? "subagent" : normalized === "todowrite" ? "todo_list" : normalized === "exitplanmode" ? "proposed_plan" : "dynamic_tool";
    const steps: NonNullable<NativeOutputItem["steps"]> | undefined = Array.isArray(record.todos) ? record.todos.flatMap((value, index) => { const todo = object(value); return typeof todo.content === "string" ? [{ id: `todo-${index}`, text: todo.content, status: todo.status === "completed" ? "completed" as const : todo.status === "in_progress" ? "running" as const : "pending" as const }] : []; }) : undefined;
    this.put({ ...previous, id: key, nativeItemId: id, type, status: previous?.status ?? "running", toolName: name, input, ...(parent ? { parentItemId: `claude:tool:${parent}` } : {}), ...(str(record.file_path) ? { fileName: str(record.file_path) } : {}), ...(str(record.old_string) ? { oldText: str(record.old_string) } : {}), ...(str(record.new_string) ? { newText: str(record.new_string) } : {}), ...(type === "command_execution" ? { title: str(record.command) } : {}), ...(type === "proposed_plan" ? { text: str(record.plan) } : {}), ...(steps ? { steps } : {}) });
  }
  private blockItem(block: Block, parent?: string, complete = false): void {
    if (block.kind === "tool_use" || block.kind === "server_tool_use") {
      const item = this.items.get(`claude:tool:${block.toolId}`); if (!item) return;
      let input: unknown = item.input;
      if (block.json) { try { input = JSON.parse(block.json); } catch { input = block.json; } }
      this.tool(block.toolId!, item.toolName ?? "Tool", input, parent); return;
    }
    if (block.kind !== "text" && block.kind !== "thinking") return;
    this.put({ id: block.id, type: block.kind === "text" ? "assistant_message" : "reasoning", status: complete ? "completed" : "running", text: block.text, streaming: !complete, ...(parent ? { parentItemId: `claude:tool:${parent}` } : {}) });
  }
  handle(value: unknown): void {
    const message = object(value); const type = str(message.type); const parent = str(message.parent_tool_use_id);
    if (type === "stream_event") {
      const event = object(message.event); const eventType = str(event.type);
      const scope = parent ?? "";
      if (eventType === "message_start") { const id = str(object(event.message).id) ?? `stream-${++this.sequence}`; this.activeMessages.set(scope, id); if (!this.blocks.has(id)) this.blocks.set(id, []); return; }
      const activeMessage = this.activeMessages.get(scope) ?? ""; const blocks = this.blocks.get(activeMessage); if (!blocks) return;
      const index = typeof event.index === "number" ? event.index : 0;
      if (eventType === "content_block_start") {
        const content = object(event.content_block); const kind = str(content.type) ?? ""; const toolId = str(content.id);
        const block: Block = { id: `claude:message:${activeMessage}:${index}`, kind, text: str(content.text) ?? str(content.thinking) ?? "", json: "", finalized: false, ...(toolId ? { toolId } : {}) };
        blocks[index] = block;
        if (toolId && (kind === "tool_use" || kind === "server_tool_use")) this.tool(toolId, str(content.name) ?? "Tool", content.input ?? {}, parent);
        else this.blockItem(block, parent);
        if (kind === "text" && block.text && !parent) this.onText?.(block.text);
      } else if (eventType === "content_block_delta") {
        const delta = object(event.delta); let block = blocks[index];
        if (!block && delta.type === "text_delta") { block = { id: `claude:message:${activeMessage}:${index}`, kind: "text", text: "", json: "", finalized: false }; blocks[index] = block; }
        if (!block) return;
        if (delta.type === "text_delta" && typeof delta.text === "string") { block.text += delta.text; if (!parent) this.onText?.(delta.text); }
        else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") block.text += delta.thinking;
        else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") block.json += delta.partial_json;
        else return;
        this.blockItem(block, parent);
      } else if (eventType === "content_block_stop") { const block = blocks[index]; if (block) this.blockItem(block, parent, true); }
      return;
    }
    if (type === "assistant") {
      if (message.error) { this.put({ id: `claude:error:${str(message.uuid) ?? ++this.sequence}`, type: "error", status: "failed", text: str(message.error) }); return; }
      const snapshotId = str(message.uuid);
      if (snapshotId && this.seenSnapshots.has(snapshotId)) return;
      if (snapshotId) this.seenSnapshots.add(snapshotId);
      const body = object(message.message); const messageId = str(body.id) ?? `snapshot-${++this.sequence}`;
      let blocks = this.blocks.get(messageId);
      const activeMessage = this.activeMessages.get(parent ?? "") ?? "";
      if (!blocks && activeMessage.startsWith("stream-")) blocks = this.blocks.get(activeMessage);
      if (!blocks) blocks = [];
      this.blocks.set(messageId, blocks);
      const content = Array.isArray(body.content) ? body.content : [];
      for (const [index, raw] of content.entries()) {
        const part = object(raw); const kind = str(part.type) ?? ""; const toolId = str(part.id);
        if (typeof part.tool_use_id === "string") { this.result(part, undefined); continue; }
        if (kind !== "text" && kind !== "thinking" && kind !== "tool_use" && kind !== "server_tool_use") continue;
        const full = str(part.text) ?? str(part.thinking) ?? "";
        const indexed = content.length > 1 ? blocks[index] : undefined;
        if (indexed?.finalized && indexed.kind === kind && (toolId ? indexed.toolId === toolId : indexed.text === full)) continue;
        let block = indexed?.kind === kind && !indexed.finalized ? indexed : blocks.find((b) => b && !b.finalized && b.kind === kind && (toolId ? b.toolId === toolId : full.startsWith(b.text)));
        if (!block && kind === "text") block = blocks.find((b) => b && !b.finalized && b.kind === kind);
        if (!block) {
          block = { id: `claude:message:${messageId}:${blocks.length}`, kind, text: "", json: "", finalized: false, ...(toolId ? { toolId } : {}) }; blocks.push(block);
        }
        if (kind === "text" && !parent) {
          if (!full.startsWith(block.text)) throw new Error("Claude returned assistant text inconsistent with its streamed deltas.");
          const suffix = full.slice(block.text.length); if (suffix) this.onText?.(suffix);
        }
        block.text = full; block.finalized = true;
        if (toolId) this.tool(toolId, str(part.name) ?? "Tool", part.input ?? {}, parent);
        else this.blockItem(block, parent, true);
      }
      return;
    }
    if (type === "user") {
      const content = object(message.message).content;
      if (Array.isArray(content)) for (const value of content) { const part = object(value); if (typeof part.tool_use_id === "string") this.result(part, message.tool_use_result); }
      return;
    }
    if (type === "tool_progress" && typeof message.tool_use_id === "string") {
      const id = `claude:tool:${message.tool_use_id}`; const prev = this.items.get(id);
      if (prev) this.put({ ...prev, text: typeof message.elapsed_time_seconds === "number" ? `${message.elapsed_time_seconds}s` : prev.text });
      return;
    }
    if (type === "tool_use_summary") {
      this.put({ id: `claude:notification:${str(message.uuid) ?? ++this.sequence}`, type: "notification", status: "completed", title: "Tool summary", text: str(message.summary) }); return;
    }
    if (type === "system") {
      const subtype = str(message.subtype) ?? "";
      if (["task_started", "task_progress", "task_notification", "task_updated"].includes(subtype) && typeof message.task_id === "string") {
        const taskId = message.task_id;
        const id = typeof message.tool_use_id === "string" ? `claude:tool:${message.tool_use_id}` : this.taskItems.get(taskId) ?? `claude:task:${taskId}`;
        this.taskItems.set(taskId, id);
        const prev = this.items.get(id); const patch = object(message.patch); const state = str(message.status) ?? str(patch.status);
        this.put({ ...prev, id, type: prev?.type ?? "subagent", status: state === "completed" ? "completed" : state === "failed" ? "failed" : state === "stopped" || state === "killed" ? "cancelled" : "running", childSessionId: message.task_id, title: str(message.description) ?? str(patch.description) ?? prev?.title, text: str(message.summary) ?? prev?.text, ...(str(patch.error) ? { error: str(patch.error) } : {}) });
      } else if (subtype === "status" && message.status === "compacting") {
        this.compactionId = `claude:compaction:${str(message.uuid) ?? ++this.sequence}`;
        this.put({ id: this.compactionId, type: "compaction", status: "running" });
      } else if (subtype === "compact_boundary") {
        const id = this.compactionId ?? `claude:compaction:${str(message.uuid) ?? ++this.sequence}`;
        this.put({ id, type: "compaction", status: "completed", input: message.compact_metadata }); this.compactionId = undefined;
      }
      else if (["status", "api_retry", "hook_response"].includes(subtype)) this.put({ id: `claude:notification:${str(message.uuid) ?? ++this.sequence}`, type: "notification", status: "completed", title: subtype, text: display(message) });
    }
  }
  private result(part: Record<string, unknown>, structured: unknown): void {
    const id = `claude:tool:${String(part.tool_use_id)}`; const prev = this.items.get(id);
    const result = structured ?? part.content; const record = object(result);
    const deferred = record.detachedToolCall === true || (prev?.type === "subagent" && (record.isAsync === true || record.status === "async_launched" || (typeof result === "string" && result.startsWith("Async agent launched successfully."))));
    const status = part.is_error === true ? "failed" : deferred ? "running" : "completed";
    let output = display(result);
    if (prev?.type === "command_execution" && (typeof record.stdout === "string" || typeof record.stderr === "string")) {
      const stdout = str(record.stdout) ?? ""; const stderr = str(record.stderr) ?? "";
      output = stdout && stderr && !stdout.endsWith("\n") ? `${stdout}\n${stderr}` : stdout + stderr;
    }
    const results: NativeOutputItem["results"] = prev?.type === "web_search" && Array.isArray(record.results) ? record.results.flatMap((entry) => {
      const group = object(entry); return Array.isArray(group.content) ? group.content.map((value) => { const item = object(value); return { title: str(item.title), url: str(item.url) }; }) : [];
    }) : prev?.type === "file_search" && Array.isArray(record.filenames) ? record.filenames.flatMap((path) => typeof path === "string" ? [{ path }] : []) : undefined;
    this.put({ ...prev, id, nativeItemId: String(part.tool_use_id), type: prev?.type ?? "dynamic_tool", status, output, ...(results ? { results } : {}), ...(record.truncated === true ? { outputTruncated: true } : {}), ...(part.is_error === true ? { error: output } : {}) });
  }
  permission(toolName: string, input: Record<string, unknown>, toolUseId: string): void {
    const id = `claude:request:${toolUseId}`; const isInput = toolName === "AskUserQuestion";
    const questions = Array.isArray(input.questions) ? input.questions.flatMap((value) => { const q = object(value); if (typeof q.question !== "string") return []; return [{ id: q.question, title: str(q.header), prompt: q.question, multiple: q.multiSelect === true, allowText: true, options: Array.isArray(q.options) ? q.options.flatMap((v) => { const o = object(v); return typeof o.label === "string" ? [{ id: o.label, label: o.label, description: str(o.description) }] : []; }) : undefined }]; }) : undefined;
    const request: NativeInteractionRequest = { id, itemId: id, kind: isInput ? "user_input" : "approval", title: isInput ? "User input requested" : `Permission requested: ${toolName}`, respondable: false, unavailableReason: "This PM session does not authorize interactive native tool permissions.", ...(questions ? { questions } : {}) };
    this.put({ id, type: isInput ? "user_input_request" : "approval_request", status: "failed", parentItemId: `claude:tool:${toolUseId}`, input, request });
  }
}
