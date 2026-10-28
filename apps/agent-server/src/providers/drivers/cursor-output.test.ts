import assert from "node:assert/strict";
import test from "node:test";
import type { InteractionUpdate } from "@cursor/sdk";
import type { NativeOutputEvent, NativeOutputItem } from "@agent-workspace/contracts/output";
import { CursorOutput } from "./cursor-output.ts";

function capture() {
  const events: NativeOutputEvent[] = [];
  const output = new CursorOutput((event) => events.push(event));
  const items = () => events.flatMap((event) => event.type === "item.upsert" ? [event.item] : []);
  return { events, items, output };
}
function last(items: NativeOutputItem[], nativeItemId: string): NativeOutputItem {
  const item = items.filter((candidate) => candidate.nativeItemId === nativeItemId).at(-1);
  assert.ok(item);
  return item;
}

test("Cursor streams separate cumulative assistant and reasoning items", () => {
  const { output, items } = capture();
  output.update({ type: "thinking-delta", text: "think" });
  output.update({ type: "thinking-delta", text: "ing" });
  output.update({ type: "thinking-completed", thinkingDurationMs: 10 });
  output.update({ type: "text-delta", text: "hello" });
  output.update({ type: "text-delta", text: " world" });
  output.update({ type: "step-completed", stepId: 1, stepDurationMs: 1 });
  output.update({ type: "text-delta", text: "after" });
  output.finish();
  const all = items();
  assert.deepEqual(all.map((item) => [item.type, item.text, item.status]), [
    ["reasoning", "think", "running"], ["reasoning", "thinking", "running"], ["reasoning", "thinking", "completed"],
    ["assistant_message", "hello", "running"], ["assistant_message", "hello world", "running"],
    ["assistant_message", "hello world", "completed"], ["assistant_message", "after", "running"],
    ["assistant_message", "after", "completed"],
  ]);
  assert.equal(all[3]?.id, all[5]?.id);
  assert.notEqual(all[5]?.id, all[6]?.id);
});

test("Cursor shell deltas go once to command output and final upsert uses complete result", () => {
  const { output, events, items } = capture();
  const update = (event: InteractionUpdate) => output.update(event);
  update({ type: "partial-tool-call", callId: "s1", modelCallId: "m", toolCall: { type: "shell", args: { command: "echo", workingDirectory: "/workspace" } } });
  update({ type: "tool-call-started", callId: "s1", modelCallId: "m", toolCall: { type: "shell", args: { command: "echo hi" } } });
  update({ type: "shell-output-delta", event: { callId: "s1", stdout: "hi" } });
  update({ type: "shell-output-delta", event: { callId: "s1", chunk: "\n" } });
  update({ type: "tool-call-completed", callId: "s1", modelCallId: "m", toolCall: { type: "shell", args: { command: "echo hi" }, result: { status: "success", value: { stdout: "hi\n", stderr: "", exitCode: 0, signal: "", executionTime: 1 } } } });
  update({ type: "partial-tool-call", callId: "s1", modelCallId: "m", toolCall: { type: "shell", args: { command: "stale" } } });
  output.finish();
  const shell = last(items(), "s1");
  assert.equal(shell.type, "command_execution");
  assert.equal(shell.status, "completed");
  assert.deepEqual(shell.input, { command: "echo hi", workingDirectory: "/workspace" });
  assert.equal(shell.output, "hi\n");
  assert.equal(shell.exitCode, 0);
  assert.deepEqual(events.filter((event) => event.type === "command.output"), [
    { type: "command.output", itemId: shell.id, chunk: "hi" },
    { type: "command.output", itemId: shell.id, chunk: "\n" },
  ]);
});

test("Cursor maps files, searches, plans, todos, failures and nested task output", () => {
  const { output, items } = capture();
  output.update({ type: "tool-call-completed", modelCallId: "m", callId: "edit", toolCall: { type: "edit", args: { path: "src/a.ts" }, result: { status: "success", value: { linesAdded: 2, linesRemoved: 1, diffString: "+new" } } } });
  output.update({ type: "tool-call-completed", modelCallId: "m", callId: "find", toolCall: { type: "glob", args: { globPattern: "*.ts" }, result: { status: "success", value: { files: ["src/a.ts"], totalFiles: 1, clientTruncated: false, ripgrepTruncated: false } } } });
  output.update({ type: "tool-call-completed", modelCallId: "m", callId: "plan", toolCall: { type: "createPlan", args: { plan: "# Plan" }, result: { status: "success", value: {} } } });
  output.update({ type: "tool-call-started", modelCallId: "m", callId: "todos", toolCall: { type: "updateTodos", args: { todos: [{ content: "Build", status: "inProgress" }, { content: "Ship", status: "pending" }] } } });
  output.update({ type: "tool-call-completed", modelCallId: "m", callId: "fail", toolCall: { type: "grep", args: { pattern: "x" }, result: { status: "error", error: "denied" } } });
  output.update({ type: "tool-call-started", modelCallId: "m", callId: "task", toolCall: { type: "task", args: { description: "Investigate", prompt: "Inspect code", model: "model" } } });
  output.update({ type: "tool-call-delta", callId: "task", modelCallId: "m", taskUpdate: { type: "text-delta", text: "Child reply" } });
  output.update({ type: "tool-call-delta", callId: "task", modelCallId: "m", taskUpdate: { type: "tool-call-completed", modelCallId: "child", callId: "read", toolCall: { type: "read", args: { path: "src/a.ts" }, result: { status: "success", value: { content: "source", fileSize: 6, totalLines: 1 } } } } });
  output.update({ type: "tool-call-completed", modelCallId: "m", callId: "task", toolCall: { type: "task", args: { description: "Investigate", prompt: "Inspect code" }, result: { status: "success", value: { agentId: "child-1", isBackground: false, backgroundReason: "unspecified" } } } });
  output.finish();
  const all = items();
  assert.deepEqual(last(all, "edit").changes, [{ path: "src/a.ts", operation: "edit", diff: "+new" }]);
  assert.equal(last(all, "edit").additions, 2);
  assert.deepEqual(last(all, "find").results, [{ path: "src/a.ts" }]);
  assert.equal(last(all, "plan").text, "# Plan");
  assert.deepEqual(last(all, "todos").steps?.map(({ text, status }) => [text, status]), [["Build", "running"], ["Ship", "pending"]]);
  assert.equal(last(all, "todos").status, "interrupted");
  assert.equal(last(all, "fail").error, "denied");
  assert.equal(last(all, "fail").status, "failed");
  const task = last(all, "task");
  assert.equal(task.type, "subagent");
  assert.equal(task.childSessionId, "child-1");
  assert.equal(task.model, "model");
  assert.equal(last(all, "read").parentItemId, task.id);
  assert.ok(all.some((item) => item.parentItemId === task.id && item.text === "Child reply" && item.status === "completed"));
});

test("Cursor retains interrupted streamed output and never reopens completed calls", () => {
  const { output, items } = capture();
  output.update({ type: "tool-call-started", modelCallId: "m", callId: "s", toolCall: { type: "shell", args: { command: "sleep 10" } } });
  output.update({ type: "shell-output-delta", event: { data: "partial" } });
  output.finish();
  output.finish();
  assert.equal(last(items(), "s").status, "interrupted");
  assert.equal(last(items(), "s").output, "partial");
});

test("Cursor decodes native shell byte envelopes across chunks and streams", () => {
  const { output, events, items } = capture();
  output.update({ type: "tool-call-started", modelCallId: "m", callId: "s", toolCall: { type: "shell", args: { command: "printf" } } });
  output.update({ type: "shell-output-delta", event: { case: "stdout", value: { data: "4g==" } } });
  output.update({ type: "shell-output-delta", event: { case: "stderr", value: { data: "IQ==" } } });
  output.update({ type: "shell-output-delta", event: { case: "stdout", value: { data: "gqw=" } } });
  output.update({ type: "shell-output-delta", event: { case: "stderr", value: { data: "4g==" } } });
  output.update({ type: "tool-call-completed", modelCallId: "m", callId: "s", toolCall: { type: "shell", args: { command: "printf" }, result: { status: "success", value: { stdout: "", stderr: "", exitCode: 0, signal: "", executionTime: 1 } } } });
  const item = last(items(), "s");
  assert.equal(item.output, "!€�");
  assert.deepEqual(events.filter((event) => event.type === "command.output"), [
    { type: "command.output", itemId: item.id, chunk: "!" },
    { type: "command.output", itemId: item.id, chunk: "€" },
    { type: "command.output", itemId: item.id, chunk: "�" },
  ]);
});
