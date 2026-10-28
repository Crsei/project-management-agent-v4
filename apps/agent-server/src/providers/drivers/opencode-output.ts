// Adapted from t3code packages/provider-opencode (toolItems and v1/v2 adapters).
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import type { NativeOutputEvent, NativeOutputItem, OutputStatus } from "@agent-workspace/contracts/output";
import { object, string, type OpenCodeGeneration } from "./opencode-transport.ts";

type ItemType = NativeOutputItem["type"];
type ToolState = { name: string; input: unknown; raw: string; output?: string; item: NativeOutputItem };

function field(value: unknown, ...keys: string[]): string | undefined {
  const record = object(value);
  for (const key of keys) if (typeof record[key] === "string" && record[key] !== "") return record[key] as string;
  return undefined;
}
function textContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => field(entry, "text") ?? "").join("");
}
function toolType(name: string): ItemType {
  const lower = name.toLowerCase();
  if (lower === "task" || lower === "subagent") return "subagent";
  if (lower === "todowrite" || lower === "todo_write" || lower === "plan") return "todo_list";
  if (lower.includes("bash") || lower.includes("shell")) return "command_execution";
  if (lower.includes("edit") || lower.includes("write") || lower.includes("patch")) return "file_change";
  if (lower.includes("web") || lower === "codesearch" || lower === "code_search") return "web_search";
  if (lower.includes("glob") || lower.includes("grep") || lower.includes("search") || lower.includes("lsp")) return "file_search";
  return "dynamic_tool";
}
function status(value: unknown): OutputStatus {
  switch (value) {
    case "pending": return "pending";
    case "completed": case "success": return "completed";
    case "error": case "failed": return "failed";
    case "aborted": case "interrupted": return "interrupted";
    default: return "running";
  }
}
function steps(value: unknown): NativeOutputItem["steps"] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry, index) => {
    const row = object(entry);
    const text = field(row, "content", "text", "description", "title");
    if (!text) return [];
    const state = string(row.status);
    return [{ id: field(row, "id") ?? String(index), text, status: state === "completed" ? "completed" as const : state === "cancelled" ? "cancelled" as const : state === "in_progress" || state === "running" ? "running" as const : "pending" as const }];
  });
}

export class OpenCodeOutput {
  private readonly items = new Map<string, NativeOutputItem>();
  private readonly roles = new Map<string, string>();
  private readonly parts = new Map<string, { itemId: string; messageId: string; kind: "text" | "reasoning" }>();
  private readonly tools = new Map<string, ToolState>();
  private readonly parents = new Map<string, string>();
  private readonly seen = new Set<string>();
  private readonly shells = new Map<string, { toolId?: string; chunks: string; exitCode?: number }>();

  private readonly emit: (event: NativeOutputEvent) => void;
  constructor(emit: (event: NativeOutputEvent) => void) { this.emit = emit; }

  private upsert(item: NativeOutputItem): void {
    const previous = this.items.get(item.id);
    if (previous && JSON.stringify(previous) === JSON.stringify(item)) return;
    this.items.set(item.id, item);
    this.emit({ type: "item.upsert", item });
  }


  private updateTool(id: string, patch: { name?: string; input?: unknown; raw?: string; state?: OutputStatus; output?: string; metadata?: unknown; error?: string; parent?: string }): void {
    let tool = this.tools.get(id);
    if (!tool) {
      if (!patch.name) return;
      const item: NativeOutputItem = { id: `opencode:tool:${id}`, nativeItemId: id, type: toolType(patch.name), status: "pending", toolName: patch.name, ...(patch.parent ? { parentItemId: patch.parent } : {}) };
      tool = { name: patch.name, input: {}, raw: "", item };
      this.tools.set(id, tool);
    }
    if ((tool.item.status === "completed" || tool.item.status === "failed" || tool.item.status === "interrupted") &&
      (patch.state === "pending" || patch.state === "running")) return;
    if (patch.name) tool.name = patch.name;
    if (patch.input !== undefined) tool.input = patch.input;
    if (patch.raw !== undefined) {
      tool.raw = patch.raw;
      try { tool.input = JSON.parse(tool.raw); } catch { tool.input = tool.raw; }
    }
    const input = object(tool.input);
    const meta = object(patch.metadata);
    const child = field(meta, "sessionID", "sessionId", "session_id");
    const type = toolType(tool.name);
    if (type === "command_execution" && patch.output !== undefined) {
      const previous = tool.output ?? "";
      if (patch.output.startsWith(previous) && patch.output.length > previous.length) {
        if (!this.items.has(tool.item.id)) {
          this.upsert({ ...tool.item, type, input: tool.input, status: patch.state === "pending" ? "pending" : "running" });
        }
        this.emit({ type: "command.output", itemId: tool.item.id, chunk: patch.output.slice(previous.length) });
      }
      tool.output = patch.output;
    }
    const result = type === "command_execution" ? tool.output : patch.output ?? tool.item.output;
    const itemStatus = patch.state ?? tool.item.status;
    const terminal = itemStatus === "completed" || itemStatus === "failed" || itemStatus === "cancelled" || itemStatus === "interrupted";
    const fileName = field(input, "filePath", "file_path", "path", "file");
    const diff = field(meta, "diff", "patch");
    const oldText = field(input, "oldString", "old_string", "oldText");
    const newText = field(input, "newString", "new_string", "content", "newText");
    const todoSteps = steps(input.todos ?? input.steps);
    const exit = meta.exit ?? meta.exitCode;
    const title = field(meta, "title") ?? field(input, "description", "title") ?? tool.item.title;
    const modelValue = input.model ?? meta.model;
    const model = typeof modelValue === "string" ? modelValue : field(modelValue, "modelID", "id");
    const item: NativeOutputItem = { ...tool.item, type, toolName: tool.name, input: tool.input,
      status: itemStatus,
      ...(title ? { title } : {}), ...(result !== undefined && (type !== "command_execution" || terminal) ? { output: result } : {}),
      ...(patch.error ? { error: patch.error } : {}),
      ...(typeof exit === "number" && Number.isInteger(exit) ? { exitCode: exit } : {}),
      ...(typeof meta.truncated === "boolean" ? { outputTruncated: meta.truncated } : {}),
      ...(type === "file_change" && fileName ? { fileName } : {}),
      ...(type === "file_change" && diff ? { diff } : {}),
      ...(type === "file_change" && oldText !== undefined ? { oldText } : {}),
      ...(type === "file_change" && newText !== undefined ? { newText } : {}),
      ...((type === "file_search" || type === "web_search") && result ? { results: [{ ...(type === "file_search" && fileName ? { path: fileName } : {}), ...(type === "web_search" && field(input, "url") ? { url: field(input, "url") } : {}), text: result }] } : {}),
      ...(type === "todo_list" && todoSteps ? { steps: todoSteps } : {}),
      ...(type === "subagent" && child ? { childSessionId: child } : {}),
      ...(type === "subagent" && model ? { model } : {}),
    };
    if (child && type === "subagent") this.parents.set(child, item.id);
    tool.item = item;
    this.upsert(item);
    const shellId = field(meta, "shellID", "shellId");
    if (shellId) {
      const shell = this.shells.get(shellId);
      if (shell) {
        shell.toolId = id;
        if (shell.chunks) {
          const full = (tool.output ?? "") + shell.chunks;
          shell.chunks = "";
          this.updateTool(id, { output: full, metadata: shell.exitCode === undefined ? undefined : { exit: shell.exitCode } });
        } else if (shell.exitCode !== undefined) this.updateTool(id, { metadata: { exit: shell.exitCode } });
      } else this.shells.set(shellId, { toolId: id, chunks: "" });
    }
  }

  private text(id: string, kind: "text" | "reasoning", value: string, complete: boolean, nativeId: string, parent?: string): void {
    const old = this.items.get(id);
    if (old?.status === "completed" && !complete) return;
    this.upsert({ id, nativeItemId: nativeId, type: kind === "text" ? "assistant_message" : "reasoning", status: complete ? "completed" : "running", text: value, streaming: !complete, ...(parent ? { parentItemId: parent } : {}) });
  }

  update(version: OpenCodeGeneration, event: Record<string, unknown>): void {
    const eventId = string(event.id);
    if (eventId && this.seen.has(eventId)) return;
    if (eventId) this.seen.add(eventId);
    const type = string(event.type);
    const data = object(version === "v2" ? event.data : event.properties);
    const session = string(data.sessionID);
    const parent = this.parents.get(session);
    if (version === "v1") {
      if (type === "message.updated") {
        const info = object(data.info);
        if (info.id && info.role) this.roles.set(string(info.id), string(info.role));
        return;
      }
      if (type === "message.part.updated") {
        const part = object(data.part);
        const partId = string(part.id);
        const messageId = string(part.messageID);
        if (!partId || this.roles.get(messageId) !== "assistant") return;
        const partParent = this.parents.get(string(part.sessionID)) ?? parent;
        if (part.type === "text" || part.type === "reasoning") {
          if (part.type === "text" && (part.synthetic === true || part.ignored === true)) return;
          const itemId = `opencode:part:${partId}`;
          this.parts.set(partId, { itemId, messageId, kind: part.type });
          this.text(itemId, part.type, string(part.text), object(part.time).end !== undefined, partId, partParent);
        } else if (part.type === "tool") {
          const state = object(part.state);
          const toolId = string(part.callID) || partId;
          const error = field(state, "error");
          this.updateTool(toolId, { name: string(part.tool), input: state.input, state: status(state.status), output: textContent(state.output ?? object(state.metadata).output), metadata: { ...object(state.metadata), ...(state.title ? { title: state.title } : {}) }, error, parent: partParent });
        }
        return;
      }
      if (type === "message.part.delta" && data.field === "text") {
        const part = this.parts.get(string(data.partID));
        if (!part || part.messageId !== string(data.messageID)) return;
        const item = this.items.get(part.itemId);
        if (item) this.text(item.id, part.kind, (item.text ?? "") + string(data.delta), false, item.nativeItemId ?? string(data.partID), item.parentItemId);
        return;
      }
      if (type === "todo.updated") {
        const list = steps(data.todos);
        if (list) this.upsert({ id: `opencode:todo:${session}`, nativeItemId: session, type: "todo_list", status: list.length > 0 && list.every((step) => step.status === "completed" || step.status === "cancelled") ? "completed" : "running", steps: list, ...(parent ? { parentItemId: parent } : {}) });
      }
      return;
    }
    const textMatch = /^session\.(text|reasoning)\.(started|delta|ended)$/.exec(type);
    if (textMatch) {
      const message = string(data.assistantMessageID);
      if (!message || typeof data.ordinal !== "number") return;
      const kind = textMatch[1] as "text" | "reasoning";
      const nativeId = `${message}:${kind}:${data.ordinal}`;
      const id = `opencode:${nativeId}`;
      const previous = this.items.get(id)?.text ?? "";
      const value = textMatch[2] === "delta" ? previous + string(data.delta) : textMatch[2] === "ended" ? string(data.text) : previous;
      this.text(id, kind, value, textMatch[2] === "ended", nativeId, parent);
      return;
    }
    if (type.startsWith("session.tool.")) {
      const id = string(data.id);
      if (!id) return;
      const existing = this.tools.get(id);
      if (type === "session.tool.input.started") this.updateTool(id, { name: string(data.name), state: "pending", parent });
      else if (type === "session.tool.input.delta" && existing) this.updateTool(id, { raw: existing.raw + string(data.delta), state: "pending" });
      else if (type === "session.tool.input.ended" && existing) this.updateTool(id, { raw: string(data.text), state: "pending" });
      else if (type === "session.tool.called") this.updateTool(id, { input: data.input, state: "running" });
      else if (type === "session.tool.progress") this.updateTool(id, { metadata: data.metadata, state: "running", output: textContent(data.output ?? object(data.metadata).output) });
      else if (type === "session.tool.success") this.updateTool(id, { state: object(data.metadata).status === "running" && existing?.item.type === "subagent" ? "running" : "completed", output: textContent(data.content), metadata: data.metadata });
      else if (type === "session.tool.failed") {
        const error = object(data.error);
        this.updateTool(id, { state: error.type === "aborted" ? "interrupted" : "failed", error: field(error, "message"), output: field(error, "message"), metadata: data.metadata });
      }
      return;
    }
    if (type === "shell.created") {
      const info = object(data.info);
      const id = string(info.id);
      if (id && !this.shells.has(id) && this.shells.size < 512) this.shells.set(id, { chunks: "" });
      return;
    }
    if (type.startsWith("shell.")) {
      const id = string(data.id);
      const shell = this.shells.get(id);
      if (!shell) return;
      const exit = data.exit;
      if (typeof exit === "number" && Number.isInteger(exit)) shell.exitCode = exit;
      const chunk = field(data, "chunk", "delta", "output", "text");
      if (shell.toolId) {
        const tool = this.tools.get(shell.toolId);
        if (tool) this.updateTool(shell.toolId, { ...(chunk && (tool.item.status === "pending" || tool.item.status === "running") ? { output: (tool.output ?? "") + chunk } : {}), ...(shell.exitCode !== undefined ? { metadata: { exit: shell.exitCode } } : {}) });
      } else if (chunk) shell.chunks = (shell.chunks + chunk).slice(-262144);
    }
  }

  finish(): void {
    for (const item of this.items.values()) {
      if ((item.type === "assistant_message" || item.type === "reasoning") && item.status === "running") this.upsert({ ...item, status: "completed", streaming: false });
    }
  }
}
