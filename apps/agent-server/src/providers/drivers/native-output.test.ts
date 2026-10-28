import assert from "node:assert/strict";
import test from "node:test";
import type { NativeOutputEvent, NativeOutputItem } from "@agent-workspace/contracts/output";
import { CodexOutput } from "./codex-output.ts";
import { ClaudeOutput } from "./claude-output.ts";

function collector() {
  const events: NativeOutputEvent[] = []; const items = new Map<string, NativeOutputItem>();
  return { events, items, emit: (event: NativeOutputEvent) => { events.push(event); if (event.type === "item.upsert") items.set(event.item.id, event.item); } };
}

test("Codex projects ordered native items and command chunks without persisting each chunk", () => {
  const c = collector(); const output = new CodexOutput(c.emit);
  output.handle("item/started", { item: { id: "a", type: "agentMessage", text: "" } });
  output.handle("item/agentMessage/delta", { itemId: "a", delta: "before " });
  output.handle("item/completed", { item: { id: "a", type: "agentMessage", text: "before tool" } });
  output.handle("item/started", { item: { id: "c", type: "commandExecution", command: "echo hi", status: "inProgress" } });
  const count = c.events.length;
  output.handle("item/commandExecution/outputDelta", { itemId: "c", delta: "hi\r" });
  output.handle("item/commandExecution/outputDelta", { itemId: "c", delta: "hello\n" });
  assert.deepEqual(c.events.slice(count), [{ type: "command.output", itemId: "codex:c", chunk: "hi\r" }, { type: "command.output", itemId: "codex:c", chunk: "hello\n" }]);
  output.handle("item/completed", { item: { id: "c", type: "commandExecution", command: "echo hi", status: "completed", aggregatedOutput: "hello\n", exitCode: 0 } });
  output.handle("item/started", { item: { id: "r", type: "reasoning" } });
  output.handle("item/reasoning/summaryTextDelta", { itemId: "r", summaryIndex: 0, delta: "think" });
  output.handle("item/completed", { item: { id: "r", type: "reasoning", summary: ["think"] } });
  output.handle("item/completed", { item: { id: "f", type: "fileChange", status: "completed", changes: [{ path: "a.ts", kind: { type: "update" }, diff: "+one" }] } });
  output.handle("turn/plan/updated", { turnId: "t", plan: [{ step: "edit", status: "inProgress" }] });
  output.handle("item/completed", { item: { id: "b", type: "agentMessage", text: "after tool" } });
  assert.deepEqual([...c.items.keys()], ["codex:a", "codex:c", "codex:r", "codex:f", "codex:turn-plan:t", "codex:b"]);
  assert.equal(c.items.get("codex:a")?.text, "before tool");
  assert.equal(c.items.get("codex:c")?.output, "hello\n");
  assert.equal(c.items.get("codex:r")?.text, "think");
  assert.equal(c.items.get("codex:f")?.changes?.[0]?.diff, "+one");
  assert.equal(c.items.get("codex:turn-plan:t")?.steps?.[0]?.status, "running");
  assert.equal(c.items.get("codex:b")?.text, "after tool");
});

test("Codex exposes blocked native requests without making them respondable", () => {
  const c = collector(); const output = new CodexOutput(c.emit);
  output.handle("$request", { id: 7, method: "item/tool/requestUserInput", params: { itemId: "tool", questions: [{ id: "q", header: "Choice", question: "Which?", options: [{ label: "One", description: "First" }] }] } });
  const request = c.items.get("codex:request:7")?.request;
  assert.equal(request?.respondable, false); assert.equal(request?.questions?.[0]?.options?.[0]?.id, "One");
});

test("Codex user input validates answers, cancels safely and expires pending requests", async () => {
  const c = collector(); const output = new CodexOutput(c.emit);
  const params = { itemId: "tool", questions: [{ id: "choice", header: "Choose", question: "Which?", options: [{ label: "One", description: "First" }] }] };
  const response = await output.userInput("valid", params, async () => ({ answers: { choice: "One" } }));
  assert.deepEqual(response, { answers: { choice: { answers: ["One"] } } });
  assert.equal(c.items.get("codex:request:string:valid")?.status, "completed");
  assert.equal(await output.userInput("cancel", params, async () => ({ cancelled: true })), null);
  assert.equal(c.items.get("codex:request:string:cancel")?.status, "cancelled");
  await assert.rejects(output.userInput("invalid", params, async () => ({ answers: { choice: "not offered" } })), /offered question/);
  const pending = Promise.withResolvers<{ answers: Record<string, string> }>();
  const expired = output.userInput("expired", params, () => pending.promise);
  output.expireRequest("expired");
  assert.equal(c.items.get("codex:request:string:expired")?.request?.respondable, false);
  assert.equal(c.items.get("codex:request:string:expired")?.status, "interrupted");
  pending.resolve({ answers: { choice: "One" } });
  assert.equal(await expired, null);
  assert.equal(c.items.get("codex:request:string:expired")?.status, "interrupted");
});

test("Claude accumulates text and tool JSON, reconciles snapshots and results without inventing command chunks", () => {
  const c = collector(); let text = ""; const output = new ClaudeOutput(c.emit, (delta) => { text += delta; });
  const stream = (event: unknown) => output.handle({ type: "stream_event", parent_tool_use_id: null, event });
  stream({ type: "message_start", message: { id: "m" } });
  stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "before" } });
  stream({ type: "content_block_stop", index: 0 });
  output.handle({ type: "assistant", uuid: "one", message: { id: "m", content: [{ type: "text", text: "before" }] } });
  stream({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool", name: "Bash", input: {} } });
  stream({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"echo hi"}' } });
  output.handle({ type: "assistant", uuid: "two", message: { id: "m", content: [{ type: "tool_use", id: "tool", name: "Bash", input: { command: "echo hi" } }] } });
  output.handle({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool", content: "hi" }] }, tool_use_result: { stdout: "hi", stderr: "" } });
  stream({ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } });
  stream({ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "after" } });
  const snapshot = { type: "assistant", uuid: "three", message: { id: "m", content: [{ type: "text", text: "after" }] } };
  output.handle(snapshot); output.handle(snapshot);
  assert.equal(text, "beforeafter");
  assert.deepEqual([...c.items.keys()], ["claude:message:m:0", "claude:tool:tool", "claude:message:m:2"]);
  assert.deepEqual(c.items.get("claude:tool:tool")?.input, { command: "echo hi" });
  assert.equal(c.items.get("claude:tool:tool")?.output, "hi");
  assert.equal(c.items.get("claude:tool:tool")?.status, "completed");
  assert.equal(c.events.some((event) => event.type === "command.output"), false);
});

test("Claude projects thinking, file edits, denied questions and task completion", () => {
  const c = collector(); const output = new ClaudeOutput(c.emit);
  output.handle({ type: "assistant", uuid: "a", message: { id: "m1", content: [{ type: "thinking", thinking: "reason" }, { type: "tool_use", id: "edit", name: "Edit", input: { file_path: "a.ts", old_string: "old", new_string: "new" } }] } });
  output.permission("AskUserQuestion", { questions: [{ question: "Which?", header: "Choice", multiSelect: true, options: [{ label: "A" }] }] }, "ask");
  output.handle({ type: "system", subtype: "task_started", task_id: "task", tool_use_id: "sub", description: "Investigate" });
  output.handle({ type: "system", subtype: "task_notification", task_id: "task", status: "completed", summary: "Done" });
  assert.equal(c.items.get("claude:message:m1:0")?.text, "reason");
  assert.equal(c.items.get("claude:tool:edit")?.newText, "new");
  assert.equal(c.items.get("claude:request:ask")?.request?.respondable, false);
  assert.equal(c.items.get("claude:request:ask")?.request?.questions?.[0]?.multiple, true);
  assert.equal(c.items.get("claude:tool:sub")?.status, "completed");
});

test("Claude preserves deferred tool state and maps structured file search results", () => {
  const c = collector(); const output = new ClaudeOutput(c.emit);
  output.handle({ type: "assistant", uuid: "search", message: { id: "s", content: [{ type: "tool_use", id: "glob", name: "Glob", input: { pattern: "*.ts" } }] } });
  output.handle({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "glob", content: "" }] }, tool_use_result: { filenames: ["a.ts", "b.ts"], truncated: true, numFiles: 2, durationMs: 1 } });
  assert.deepEqual(c.items.get("claude:tool:glob")?.results, [{ path: "a.ts" }, { path: "b.ts" }]);
  assert.equal(c.items.get("claude:tool:glob")?.outputTruncated, true);
  output.handle({ type: "assistant", uuid: "spawn", message: { id: "spawn", content: [{ type: "tool_use", id: "child", name: "Agent", input: { prompt: "inspect" } }] } });
  output.handle({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "child", content: "" }] }, tool_use_result: { isAsync: true } });
  assert.equal(c.items.get("claude:tool:child")?.status, "running");
});

test("native output callback failures propagate", () => {
  const failure = new Error("consumer failed");
  assert.throws(() => new CodexOutput(() => { throw failure; }).handle("item/started", { item: { id: "x", type: "contextCompaction" } }), failure);
  assert.throws(() => new ClaudeOutput(() => { throw failure; }).permission("Bash", {}, "x"), failure);
});
