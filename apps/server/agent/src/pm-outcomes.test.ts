import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PmToolCallRecord } from "@agent-workspace/contracts/pm-tools";
import { upsertNativeOutputItem, type NativeOutputItem } from "@agent-workspace/contracts/output";
import { normalizePmToolResult, pmOutcomeFromToolOutput, projectPmNativeOutcome } from "./pm-outcomes.ts";
import { closeStore } from "./durable/store.ts";
import { emitNativeOutput, endNativeOutput, getNativeOutput, initializeNativeOutput, recoverNativeOutputs } from "./durable/native-output.ts";

const record: PmToolCallRecord = { operationId: randomUUID(), name: "pm_update_task", status: "unknown", result: null, error: null,
  threadId: "thread", messageId: "assistant", generationId: "generation", workspaceId: randomUUID(), createdAt: "2026-11-10T00:00:00.000Z", finishedAt: null };
test("native/MCP output envelopes retain unknown instead of their transport failure flag", () => {
  for (const output of [record, JSON.stringify(record), { isError: true, structuredContent: record }, { result: { content: [{ type: "text", text: JSON.stringify(record) }] } }]) {
    assert.equal(pmOutcomeFromToolOutput(output)?.operationId, record.operationId);
    const item = projectPmNativeOutcome({ id: "provider-tool", type: "dynamic_tool", status: "failed", completedAt: "2026-11-10T00:00:01.000Z", output: JSON.stringify(output) });
    assert.equal(item.status, "unknown"); assert.equal(item.completedAt, undefined);
  }
  const legacyFailure = { ...record, status: "failed" as const };
  assert.equal(normalizePmToolResult(legacyFailure).status, "unknown");
  assert.equal(normalizePmToolResult({ ...legacyFailure, certainty: { dispatch: "possibly_sent", evidence: "unresolved" } }).status, "unknown");
  assert.equal(normalizePmToolResult({ ...legacyFailure, certainty: { dispatch: "possibly_sent", evidence: "pm_result" } }).status, "failed");
  assert.equal(normalizePmToolResult({ ...legacyFailure, certainty: { dispatch: "not_sent", evidence: "local_rejection" } }).status, "failed");
  const items: NativeOutputItem[] = [{ id: `pm-tool:${record.operationId}`, type: "dynamic_tool", status: "completed" }];
  for (const status of ["running", "unknown", "failed", "cancelled"] as const) upsertNativeOutputItem(items, { ...items[0]!, status });
  assert.equal(items[0]!.status, "completed");
  upsertNativeOutputItem(items, { id: items[0]!.id, type: "notification", status: "unknown", visibility: "redacted" });
  assert.equal(items[0]!.visibility, "redacted", "monotonic success cannot defeat current-reader redaction");
});

test("provider duplicate unknown tools survive generation cancellation and store restart without fake duration", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pm-native-outcome-"));
  const previous = process.env.AGENT_WORKSPACE_DATA_DIR; process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  try {
    initializeNativeOutput(record.generationId, record.threadId, "running");
    emitNativeOutput(record.generationId, { type: "item.upsert", item: { id: "provider-copy", type: "dynamic_tool", status: "failed", output: JSON.stringify({ isError: true, structuredContent: record }) } });
    endNativeOutput(record.generationId, "cancelled"); closeStore(); recoverNativeOutputs();
    const item = getNativeOutput(record.generationId)!.items[0]!;
    assert.equal(item.status, "unknown"); assert.equal(item.completedAt, undefined);
  } finally {
    closeStore(); if (previous === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
