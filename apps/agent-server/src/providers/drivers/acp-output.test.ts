import assert from "node:assert/strict";
import { test } from "node:test";
import type { NativeOutputEvent } from "@agent-workspace/contracts/output";
import { AcpTurnOutput } from "./acp-output.ts";

test("ACP preserves ordered assistant and thought blocks, tool patches and native diffs", () => {
  const events: NativeOutputEvent[] = [];
  const turn = new AcpTurnOutput((event) => events.push(event));
  turn.consume({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "one" } });
  turn.consume({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "reason" } });
  turn.consume({ sessionUpdate: "tool_call", toolCallId: "t", kind: "edit", title: "Edit", status: "in_progress", rawInput: { path: "a" } });
  turn.consume({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed", content: [{ type: "diff", changes: [{ operation: "modify", path: "/a" }], patch: { format: "git_patch", text: "--- a\n+++ b" } }] });
  turn.consume({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "two" } });
  turn.finish();
  const latest = new Map(events.flatMap((event) => event.type === "item.upsert" ? [[event.item.id, event.item] as const] : []));
  const items = [...latest.values()];
  assert.deepEqual(items.map((item) => item.type), ["assistant_message", "reasoning", "file_change", "assistant_message"]);
  assert.deepEqual(items.map((item) => item.status), ["completed", "completed", "completed", "completed"]);
  assert.equal(items[0]?.text, "one"); assert.equal(items[3]?.text, "two");
  assert.deepEqual(items[2]?.input, { path: "a" }); assert.equal(items[2]?.changes?.[0]?.operation, "modify"); assert.equal(items[2]?.diff, "--- a\n+++ b");
});

test("ACP command chunks remain separate from durable item updates and finish with complete output", () => {
  const events: NativeOutputEvent[] = [];
  const turn = new AcpTurnOutput((event) => events.push(event));
  turn.consume({ sessionUpdate: "terminal_update", terminalId: "term", command: "echo" });
  turn.consume({ sessionUpdate: "terminal_output_chunk", terminalId: "term", data: "a" });
  turn.consume({ sessionUpdate: "terminal_output_chunk", terminalId: "term", data: "b" });
  turn.consume({ sessionUpdate: "terminal_update", terminalId: "term", exitStatus: { exitCode: 0 } });
  assert.equal(events.filter((event) => event.type === "item.upsert").length, 2);
  assert.deepEqual(events.filter((event) => event.type === "command.output").map((event) => event.type === "command.output" && event.chunk), ["a", "b"]);
  const final = events.at(-1); assert.equal(final?.type, "item.upsert");
  if (final?.type === "item.upsert") { assert.equal(final.item.output, "ab"); assert.equal(final.item.status, "completed"); }
});

test("ACP rejected native requests are visible and cannot be answered", () => {
  const events: NativeOutputEvent[] = [];
  const turn = new AcpTurnOutput((event) => events.push(event));
  turn.rejectedRequest("session/request_permission", { title: "Run command", options: [{ optionId: "allow", kind: "allow_once" }] });
  const event = events[0]; assert.equal(event?.type, "item.upsert");
  if (event?.type === "item.upsert") { assert.equal(event.item.request?.respondable, false); assert.equal(event.item.status, "cancelled"); }
  assert.throws(() => new AcpTurnOutput(() => { throw new Error("consumer failed"); }).consume({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } }), /consumer failed/);
});

test("Grok informational questions return actual selected options and custom notes", async () => {
  const events: NativeOutputEvent[] = [];
  const turn = new AcpTurnOutput((event) => events.push(event));
  const result = await turn.grokQuestion({ questions: [
    { question: "Scope?", options: [{ label: "Workspace", preview: "preview" }, { label: "Session" }] },
    { question: "Extra?", options: [], multiSelect: true },
  ] }, async (request) => {
    assert.equal(request.kind, "user_input"); assert.equal(request.respondable, true);
    return { answers: { "q:0": "option:0", "q:1": ["custom"] } };
  });
  assert.deepEqual(result, { outcome: "accepted", answers: { "Scope?": ["Workspace"], "Extra?": ["Other"] }, annotations: { "Scope?": { preview: "preview" }, "Extra?": { notes: "custom" } } });
  const last = events.at(-1); assert.equal(last?.type, "item.upsert");
  if (last?.type === "item.upsert") assert.equal(last.item.request?.respondable, false);
});

test("Grok informational question cancellation does not send a late answer", async () => {
  const controller = new AbortController();
  const turn = new AcpTurnOutput();
  const gate = Promise.withResolvers<{ answers: Record<string, string> }>();
  const result = turn.grokQuestion({ questions: [{ question: "Scope?", options: [{ label: "Workspace" }] }] }, () => gate.promise, controller.signal);
  controller.abort();
  assert.deepEqual(await result, { outcome: "cancelled" });
  gate.resolve({ answers: { "q:0": "option:0" } });
});
