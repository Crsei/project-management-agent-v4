import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { NativeInteractionRequest, NativeOutputItem } from "@agent-workspace/contracts/output";
import { DurableError } from "./errors.ts";
import {
  closeNativeInteractions, emitNativeNotification, emitNativeOutput, endNativeOutput, getNativeOutput,
  initializeNativeOutput, recoverNativeOutputs, requestNativeInteraction,
  respondNativeInteraction, setNativeOutputStatus, subscribeCommandOutput,
  subscribeNativeOutput,
} from "./native-output.ts";
import { closeStore, writeRecord } from "./store.ts";

let directory: string;
const originalDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "native-output-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
});
afterEach(async () => {
  closeStore();
  await rm(directory, { recursive: true, force: true });
  if (originalDirectory === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR;
  else process.env.AGENT_WORKSPACE_DATA_DIR = originalDirectory;
});
const approval = (id: string): NativeInteractionRequest => ({
  id, itemId: id, kind: "approval", title: "Permission", respondable: true,
  options: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }],
});

test("coalescing preserves first appearance and finishes with durable sequence", async () => {
  initializeNativeOutput("order", "thread");
  setNativeOutputStatus("order", "running");
  const reader = subscribeNativeOutput("order").getReader();
  assert.equal((await reader.read()).value?.kind, "snapshot");
  emitNativeOutput("order", { type: "item.upsert", item: { id: "a", type: "assistant_message", status: "completed", text: "one" } });
  emitNativeOutput("order", { type: "item.upsert", item: { id: "b", type: "notification", status: "completed" } });
  emitNativeOutput("order", { type: "item.upsert", item: { id: "a", type: "assistant_message", status: "completed", text: "two" } });
  endNativeOutput("order", "completed");
  const frames = [];
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    frames.push(result.value);
  }
  const items = frames.filter((frame) => frame.kind === "item");
  assert.deepEqual(items.map((frame) => frame.item.id), ["a", "b", "a"]);
  const sequences = frames.map((frame) => frame.kind === "snapshot" ? frame.snapshot.sequence : frame.sequence);
  assert.ok(sequences.every((sequence, index) => index === 0 || sequence > sequences[index - 1]));
  assert.equal(getNativeOutput("order")?.items[0].text, "two");
  assert.equal(getNativeOutput("order")?.status, "completed");
});

test("recovery interrupts only existing active output and closes pending requests", async () => {
  initializeNativeOutput("recover", "thread");
  setNativeOutputStatus("recover", "running");
  const rejected = assert.rejects(requestNativeInteraction("recover", approval("request")), DurableError);
  closeStore();
  recoverNativeOutputs();
  await rejected;
  const snapshot = getNativeOutput("recover");
  assert.equal(snapshot?.status, "interrupted");
  assert.equal(snapshot?.items[0].status, "cancelled");
  assert.equal(snapshot?.items[0].request?.respondable, false);
  assert.equal(getNativeOutput("legacy"), null);
});

test("broker validates choices, rejects duplicate requests, and promptly closes", async () => {
  initializeNativeOutput("broker", "thread", "running");
  const result = requestNativeInteraction("broker", approval("first"));
  assert.throws(() => respondNativeInteraction("broker", "first", { optionId: "unknown" }), DurableError);
  await assert.rejects(requestNativeInteraction("broker", approval("first")), DurableError);
  respondNativeInteraction("broker", "first", { optionId: "allow" });
  assert.deepEqual(await result, { optionId: "allow" });
  await assert.rejects(requestNativeInteraction("broker", approval("first")), DurableError);
  const cancelled = assert.rejects(requestNativeInteraction("broker", approval("second")), DurableError);
  closeNativeInteractions("broker");
  await cancelled;
  await assert.rejects(requestNativeInteraction("broker", approval("third")), DurableError);
  assert.equal(getNativeOutput("broker")?.items.find((item) => item.id === "second")?.status, "cancelled");
  endNativeOutput("broker", "cancelled");
});

test("command subscribers receive the authoritative final output and can reconnect", async () => {
  initializeNativeOutput("command", "thread", "running");
  emitNativeOutput("command", { type: "item.upsert", item: { id: "cmd", type: "command_execution", status: "running" } });
  const reader = subscribeCommandOutput("command", "cmd").getReader();
  assert.deepEqual(await reader.read(), { done: false, value: { kind: "replace", text: "", truncated: false, running: true } });
  emitNativeOutput("command", { type: "command.output", itemId: "cmd", chunk: "partial" });
  emitNativeOutput("command", { type: "item.upsert", item: { id: "cmd", type: "command_execution", status: "completed", output: "final" } });
  endNativeOutput("command", "completed");
  const final = await reader.read();
  assert.equal(final.value?.kind, "replace");
  assert.equal(final.value?.text, "final");
  assert.equal(final.value?.running, false);
  assert.equal((await reader.read()).done, true);
  const reopened = subscribeCommandOutput("command", "cmd").getReader();
  assert.equal((await reopened.read()).value?.text, "final");
  assert.equal((await reopened.read()).done, true);
});

test("running full command snapshots replace the live tail without losing later raw chunks", async () => {
  initializeNativeOutput("snapshots", "thread", "running");
  const item = { id: "cmd", type: "command_execution" as const, status: "running" as const };
  emitNativeOutput("snapshots", { type: "item.upsert", item: { ...item, output: "one" } });
  const first = subscribeCommandOutput("snapshots", "cmd").getReader();
  assert.equal((await first.read()).value?.text, "one");
  assert.equal(getNativeOutput("snapshots")?.items[0].output, undefined);

  emitNativeOutput("snapshots", { type: "command.output", itemId: "cmd", chunk: "!" });
  emitNativeOutput("snapshots", { type: "item.upsert", item: { ...item, output: "one" } });
  const second = subscribeCommandOutput("snapshots", "cmd").getReader();
  assert.deepEqual((await first.read()).value, { kind: "append", text: "!", truncated: false, running: true });
  assert.equal((await second.read()).value?.text, "one!");

  emitNativeOutput("snapshots", { type: "item.upsert", item: { ...item, output: "one! more" } });
  const third = subscribeCommandOutput("snapshots", "cmd").getReader();
  assert.deepEqual((await first.read()).value, { kind: "replace", text: "one! more", truncated: false, running: true });
  assert.equal((await second.read()).value?.text, "one! more");
  assert.equal((await third.read()).value?.text, "one! more");

  endNativeOutput("snapshots", "completed");
  assert.equal(getNativeOutput("snapshots")?.items[0].output, "one! more");
  await Promise.all([first.cancel(), second.cancel(), third.cancel()]);
});

test("final command tail is durable without persisting live raw chunks", async () => {
  initializeNativeOutput("tail", "thread", "running");
  emitNativeOutput("tail", { type: "item.upsert", item: { id: "cmd", type: "command_execution", status: "running" } });
  emitNativeOutput("tail", { type: "command.output", itemId: "cmd", chunk: "before\rfinal" });
  assert.equal(getNativeOutput("tail")?.items[0].output, undefined);
  endNativeOutput("tail", "completed");
  closeStore();
  assert.equal(getNativeOutput("tail")?.items[0].output, "finale");
  const reader = subscribeCommandOutput("tail", "cmd").getReader();
  assert.equal((await reader.read()).value?.text, "finale");
  assert.equal((await reader.read()).done, true);
});

test("slow subscribers reset to a snapshot with monotonic sequences", async () => {
  initializeNativeOutput("slow", "thread", "running");
  const reader = subscribeNativeOutput("slow").getReader();
  for (let index = 0; index < 150; index++) {
    emitNativeOutput("slow", { type: "item.upsert", item: { id: String(index), type: "notification", status: "completed" } });
  }
  endNativeOutput("slow", "completed");
  const first = await reader.read();
  assert.equal(first.value?.kind, "snapshot");
  assert.ok(first.value?.kind === "snapshot" && first.value.snapshot.items.length > 0);
  let sequence = first.value?.kind === "snapshot" ? first.value.snapshot.sequence : -1;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    const next = result.value.kind === "snapshot" ? result.value.snapshot.sequence : result.value.sequence;
    assert.ok(next > sequence);
    sequence = next;
  }
  assert.equal(sequence, getNativeOutput("slow")?.sequence);
});

test("secret answers are forwarded without entering the durable output", async () => {
  initializeNativeOutput("secret", "thread", "running");
  const response = requestNativeInteraction("secret", {
    id: "question", itemId: "question", kind: "user_input", title: "Secret",
    respondable: true, questions: [{ id: "password", prompt: "Password", allowText: true, secret: true }],
  });
  respondNativeInteraction("secret", "question", { answers: { password: "private-answer" } });
  assert.deepEqual(await response, { answers: { password: "private-answer" } });
  assert.equal(JSON.stringify(getNativeOutput("secret")).includes("private-answer"), false);
  endNativeOutput("secret", "completed");
});

test("tool payload normalization handles cycles and bounds stored output", () => {
  initializeNativeOutput("payload", "thread", "running");
  const input: Record<string, unknown> = { integer: 5n, large: "x".repeat(100_000) };
  input.self = input;
  emitNativeOutput("payload", { type: "item.upsert", item: {
    id: "tool", type: "dynamic_tool", status: "running", input, output: "y".repeat(100_000),
  } });
  const item = getNativeOutput("payload")!.items[0];
  assert.equal((item.input as Record<string, unknown>).integer, "5");
  assert.equal((item.input as Record<string, unknown>).self, "[circular]");
  assert.ok(((item.input as Record<string, string>).large).length < 20_000);
  assert.equal(item.output?.length, 64 * 1024);
  assert.equal(item.outputTruncated, true);
  emitNativeOutput("payload", { type: "item.upsert", item: {
    id: "opaque", type: "dynamic_tool", status: "completed",
    input: new Proxy({}, { ownKeys() { throw new Error("inaccessible"); } }),
  } });
  assert.equal(getNativeOutput("payload")?.items.find((entry) => entry.id === "opaque")?.input, "[uninspectable]");
  endNativeOutput("payload", "cancelled");
});

test("an abort cannot turn an active command into a successful command", () => {
  initializeNativeOutput("abort", "thread", "running");
  emitNativeOutput("abort", { type: "item.upsert", item: { id: "cmd", type: "command_execution", status: "running", output: "live" } });
  assert.equal(getNativeOutput("abort")?.items[0].output, undefined);
  closeNativeInteractions("abort");
  emitNativeOutput("abort", { type: "item.upsert", item: { id: "cmd", type: "command_execution", status: "completed", output: "final" } });
  assert.equal(getNativeOutput("abort")?.items[0].status, "running");
  endNativeOutput("abort", "cancelled");
  assert.equal(getNativeOutput("abort")?.items[0].status, "cancelled");
  assert.equal(getNativeOutput("abort")?.items[0].output, "final");
});

test("provider resolution rejects the active broker request immediately", async () => {
  initializeNativeOutput("expired", "thread", "running");
  const rejected = assert.rejects(requestNativeInteraction("expired", approval("request")), DurableError);
  emitNativeOutput("expired", { type: "item.upsert", item: {
    id: "request", type: "approval_request", status: "completed",
  } });
  await rejected;
  assert.throws(() => respondNativeInteraction("expired", "request", { optionId: "allow" }), DurableError);
  assert.equal(getNativeOutput("expired")?.items[0].request?.respondable, false);
  endNativeOutput("expired", "completed");
});

test("late native notifications survive SSE snapshot replay without reopening a settled generation", async () => {
  initializeNativeOutput("late-native", "owner", "running");
  endNativeOutput("late-native", "interrupted");
  const sequence = getNativeOutput("late-native")!.sequence;
  emitNativeNotification("late-native", "owner", { id: "wake", type: "notification", status: "interrupted", text: "Background work was not automatically resumed." });
  assert.equal(getNativeOutput("late-native")?.status, "interrupted");
  assert.ok(getNativeOutput("late-native")!.sequence > sequence);
  assert.throws(() => emitNativeNotification("late-native", "other-thread", { id: "wrong", type: "notification", status: "completed" }), DurableError);
  const reader = subscribeNativeOutput("late-native").getReader();
  const frame = (await reader.read()).value;
  assert.equal(frame?.kind, "snapshot");
  if (frame?.kind === "snapshot") assert.equal(frame.snapshot.items[0].text, "Background work was not automatically resumed.");
  assert.equal((await reader.read()).done, true);
  await assert.rejects(requestNativeInteraction("late-native", approval("late-request")), DurableError);
});

test("native scopes order late items without comparing unrelated ordinals or duplicating revisions", async () => {
  initializeNativeOutput("scopes", "thread", "running");
  const put = (id: string, scope?: string, ordinal = 0, text = id) => emitNativeOutput("scopes", {
    type: "item.upsert", item: { id, type: "assistant_message", status: "completed", text,
      ...(scope ? { order: { scope, ordinal } } : {}) },
  });
  put("old-one");
  put("a-late-position", "turn-a", 30);
  put("b-first-position", "turn-b", 0);
  put("old-two");
  put("a-first-position", "turn-a", 10);
  put("a-middle-position", "turn-a", 20);
  put("a-late-position", "turn-a", 30, "same ID, revised body");
  put("b-other-turn", "turn-b-retry", 0);
  const snapshot = getNativeOutput("scopes")!;
  assert.deepEqual(snapshot.items.map(item => item.id), [
    "old-one", "a-first-position", "a-middle-position", "a-late-position",
    "b-first-position", "old-two", "b-other-turn",
  ]);
  assert.equal(snapshot.items.filter(item => item.id === "a-late-position").length, 1);
  assert.equal(snapshot.items[3]?.text, "same ID, revised body");
  assert.equal(snapshot.status, "running");
  endNativeOutput("scopes", "completed");
  closeStore();
  assert.deepEqual(getNativeOutput("scopes")?.items.map(item => item.id), snapshot.items.map(item => item.id));
  const replay = subscribeNativeOutput("scopes").getReader();
  assert.deepEqual((await replay.read()).value, { kind: "snapshot", snapshot: getNativeOutput("scopes")! });
  assert.equal((await replay.read()).done, true);
});

test("phase is explicit and independent of generation completion; timing never promotes observations or legacy history", () => {
  initializeNativeOutput("semantics", "thread", "running");
  const start = "2026-11-01T10:00:00.000Z";
  const end = "2026-11-01T10:00:05.000Z";
  const items: NativeOutputItem[] = [
    { id: "progress", type: "assistant_message", status: "completed", phase: "commentary", text: "Working" },
    { id: "final", type: "assistant_message", status: "completed", phase: "final_answer", text: "Answer",
      startedAt: start, completedAt: end, timing: { source: "provider" } },
    { id: "unknown", type: "assistant_message", status: "completed", text: "Unclassified text" },
    { id: "reason", type: "reasoning", status: "completed", text: "Summary received only at completion" },
    { id: "clock", type: "reasoning", status: "completed", startedAt: start, completedAt: end },
    { id: "active", type: "reasoning", status: "running", startedAt: start, timing: { source: "provider" } },
  ];
  for (const item of items) emitNativeOutput("semantics", { type: "item.upsert", item });
  let snapshot = getNativeOutput("semantics")!;
  assert.equal(snapshot.status, "running", "Neither final_answer nor item completion ends a generation.");
  assert.deepEqual(snapshot.items.find(item => item.id === "final")?.timing, { source: "provider" });
  for (const id of ["unknown", "reason", "clock"]) assert.deepEqual(snapshot.items.find(item => item.id === id)?.timing, { source: "observed" });
  assert.equal(snapshot.items.find(item => item.id === "unknown")?.phase, undefined);
  emitNativeOutput("semantics", { type: "item.upsert", item: { id: "final", type: "assistant_message", status: "completed", text: "Answer revised" } });
  assert.equal(getNativeOutput("semantics")?.items.find(item => item.id === "final")?.phase, "final_answer");
  endNativeOutput("semantics", "cancelled");
  snapshot = getNativeOutput("semantics")!;
  assert.equal(snapshot.items.find(item => item.id === "final")?.phase, "final_answer");
  assert.equal(snapshot.items.find(item => item.id === "active")?.status, "cancelled");
  assert.deepEqual(snapshot.items.find(item => item.id === "active")?.timing, { source: "observed" });
  const legacy = { generationId: "old", threadId: "thread", sequence: 4, status: "completed", items: [
    { id: "old-b", type: "reasoning", status: "completed", startedAt: start, completedAt: end, text: "Old text" },
    { id: "old-a", type: "assistant_message", status: "completed", text: "Unchanged old body" },
  ] };
  writeRecord("native-output", "old", legacy);
  closeStore();
  recoverNativeOutputs();
  assert.deepEqual(getNativeOutput("old"), legacy, "Reading old records must not rewrite text, assign a phase or invent timestamp provenance.");
});
