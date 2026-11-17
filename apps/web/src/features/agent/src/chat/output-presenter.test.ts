import assert from "node:assert/strict";
import test from "node:test";
import type { NativeOutputItem } from "@agent-workspace/contracts/output";
import { assistantMessageKind, canRespondToInteraction, changedFileSummary, createOutputDisclosureStore, generationIndicator, generationWorkState, isCompletedAutoApproval, latestReasoning, presentOutputItems, reasoningPreview, reliableDurationMs, requiresVisibleDetails, semanticToolSummary } from "./output-presenter.ts";

const item = (id: string, type: NativeOutputItem["type"], extra: Partial<NativeOutputItem> = {}): NativeOutputItem => ({ id, type, status: "completed", ...extra });
const identities = (items: NativeOutputItem[]) => presentOutputItems(items).map(row => "items" in row ? [row.kind, row.items.map(entry => entry.id)] : [row.kind, row.item.id]);

test("output-only and interleaved progress retain authoritative order without inventing a final phase", () => {
  const reply = item("reply", "assistant_message", { text: "Result" });
  assert.deepEqual(identities([reply]), [["item", "reply"]]);
  assert.equal(assistantMessageKind(reply), "unknown");
  const progress = item("progress", "assistant_message", { phase: "commentary", text: "Checking the next file" });
  const final = item("final", "assistant_message", { phase: "final_answer", text: "Done" });
  assert.deepEqual(identities([
    item("thought", "reasoning", { text: "Check the existing behavior" }),
    item("first", "file_search"), progress, item("second", "file_search"), final,
  ]), [["reasoning", ["thought"]], ["tools", ["first"]], ["item", "progress"], ["tools", ["second"]], ["item", "final"]]);
  assert.equal(assistantMessageKind(progress), "progress");
  assert.equal(assistantMessageKind(final), "final");
  // A complete final body does not imply a complete generation.
  assert.equal(generationIndicator("running", [final]), "processing");
});

test("same-id accumulated updates replace only that identity; equal text and legacy order survive", () => {
  const rows = presentOutputItems([
    item("a", "assistant_message", { text: "first" }),
    item("b", "assistant_message", { text: "same text" }),
    item("a", "assistant_message", { text: "same text" }),
  ]);
  assert.deepEqual(rows.map(row => row.kind === "item" && [row.item.id, row.item.text]), [["a", "same text"], ["b", "same text"]]);
  const ordered = [item("domain-b", "assistant_message", { order: { scope: "b", ordinal: 1 } }), item("legacy", "assistant_message"), item("domain-a", "assistant_message", { order: { scope: "a", ordinal: 1 } })];
  assert.deepEqual(identities(ordered), [["item", "domain-b"], ["item", "legacy"], ["item", "domain-a"]]);
});

test("only adjacent reasoning of compatible parent, domain and part kind groups; raw summaries are retained", () => {
  const summary = (id: string, text: string, extra: Partial<NativeOutputItem> = {}) => item(id, "reasoning", { text, nativeItemId: "original-reasoning", parentItemId: "parent", order: { scope: "turn", ordinal: 1 }, reasoningPart: { kind: "summary", index: 0 }, ...extra });
  const a = summary("a", "Inspect original behavior");
  const b = summary("b", "Preserve the exact request", { reasoningPart: { kind: "summary", index: 1 } });
  assert.deepEqual(identities([a, b]), [["reasoning", ["a", "b"]]]);
  for (const boundary of [item("body", "assistant_message"), item("plan", "proposed_plan"), item("notice", "notification"), item("compact", "compaction"), item("question", "user_input_request"), item("approval", "approval_request"), item("error", "error")]) {
    assert.deepEqual(identities([a, boundary, b]), [["reasoning", ["a"]], ["item", boundary.id], ["reasoning", ["b"]]]);
  }
  for (const changed of [summary("b", "Other parent", { parentItemId: "other" }), summary("b", "Other domain", { order: { scope: "other", ordinal: 1 } }), summary("b", "Other native reasoning", { nativeItemId: "other-native" }), summary("b", "Missing native identity", { nativeItemId: undefined }), summary("b", "Raw text", { reasoningPart: { kind: "text", index: 0 } })]) {
    assert.equal(presentOutputItems([a, changed]).length, 2);
  }
});

test("reasoning previews use the first available line without heading wrappers or subsequent detail", () => {
  const source = item("summary", "reasoning", { text: "\n## **Check file_path.ts**\nAdditional provider detail\n" });
  assert.equal(reasoningPreview([item("empty", "reasoning"), source, item("next", "reasoning", { text: "Next step" })]), "Check file_path.ts");
  assert.equal(reasoningPreview([item("plain", "reasoning", { text: "Inspect foo_bar and *.ts" })]), "Inspect foo_bar and *.ts");
});

test("only completed adjacent tools group; live tools remain individually visible", () => {
  const first = item("one", "file_search");
  const second = item("two", "dynamic_tool");
  const grouped = presentOutputItems([first, second]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]!.kind, "tools");
  if (grouped[0]!.kind === "tools") assert.deepEqual(grouped[0]!.items.map(entry => [entry.id, entry.status]), [["one", "completed"], ["two", "completed"]]);
  for (const boundary of [item("running", "command_execution", { status: "running" }), item("pending", "dynamic_tool", { status: "pending" }), item("failed", "dynamic_tool", { status: "failed", error: "Permission denied" }), item("exit", "command_execution", { exitCode: 2 }), item("waiting", "dynamic_tool", { status: "waiting" }), item("answer", "assistant_message"), item("input", "user_input_request"), item("plan", "todo_list")]) {
    assert.deepEqual(identities([first, boundary, second]), [["tools", ["one"]], ["item", boundary.id], ["tools", ["two"]]]);
  }
  assert.equal(presentOutputItems([first, { ...second, parentItemId: "child" }]).length, 2);
  assert.equal(requiresVisibleDetails(item("failed", "command_execution", { status: "failed" })), true);
  assert.equal(requiresVisibleDetails(item("approval", "approval_request")), true);
});

test("PM operation IDs deduplicate cards, without grouping across the receipt boundary", () => {
  const native = item("native", "dynamic_tool", { output: JSON.stringify({ operationId: "op" }) });
  const bridge = item("pm-tool:op", "dynamic_tool");
  const rows = presentOutputItems([item("a", "file_search"), native, bridge, item("b", "file_search")], ["op"]);
  assert.deepEqual(rows.map(row => row.kind), ["tools", "pm_tool", "tools"]);
  assert.equal(rows[1]!.kind === "pm_tool" && rows[1]!.operationId, "op");
  assert.equal(presentOutputItems([native, { ...native, id: "other-native" }], ["op"]).length, 1);
  assert.equal(presentOutputItems([native])[0]!.kind, "tools");
});

test("missing reasoning is never fabricated, and only active generations get the generic processing placeholder", () => {
  const empty = item("empty", "reasoning", { status: "running" });
  assert.deepEqual(presentOutputItems([empty]), []);
  assert.equal(reasoningPreview([empty]), "");
  assert.equal(generationIndicator("running", [empty]), "processing");
  assert.equal(generationIndicator("queued", []), "queued");
  assert.equal(generationIndicator("running", [item("tool", "dynamic_tool", { status: "running" })]), undefined);
  assert.equal(generationIndicator("running", [item("thought", "reasoning", { status: "running", text: "Actual provider summary" })]), undefined);
  for (const status of ["completed", "failed", "cancelled", "interrupted"] as const) assert.notEqual(generationIndicator(status, [empty]), "processing");
  assert.equal(generationIndicator("completed", [empty]), undefined);
});

test("precise durations require provider timestamps, a real interval, and no terminal fallback to now", () => {
  const timed = item("timed", "reasoning", { startedAt: "2026-11-10T00:00:00Z", completedAt: "2026-11-10T00:00:02Z", timing: { source: "provider" } });
  const now = Date.parse("2026-11-10T00:00:05Z");
  assert.equal(reliableDurationMs(timed, "completed", now), 2000);
  assert.equal(reliableDurationMs({ ...timed, timing: undefined }, "completed", now), undefined);
  assert.equal(reliableDurationMs({ ...timed, timing: { source: "observed" } }, "completed", now), undefined);
  assert.equal(reliableDurationMs({ ...timed, completedAt: timed.startedAt }, "completed", now), undefined);
  assert.equal(reliableDurationMs({ ...timed, completedAt: undefined }, "completed", now), undefined);
  assert.equal(reliableDurationMs({ ...timed, status: "running", completedAt: undefined }, "running", now), 5000);
  assert.equal(reliableDurationMs({ ...timed, startedAt: "invalid" }, "completed", now), undefined);
});

test("manual expansion and collapse survive stream appends, prepends, remounts and terminal defaults", () => {
  const store = createOutputDisclosureStore();
  store.set(["generation:a", "generation:b"], true);
  assert.equal(store.read(["generation:a", "generation:b", "generation:c"], false), true);
  assert.equal(store.read(["generation:late", "generation:a", "generation:b"], false), true);
  store.set(["generation:a", "generation:b", "generation:c"], false);
  assert.equal(store.read(["generation:a", "generation:b"], true), false);
  assert.equal(store.read(["another-generation:a"], true), true);
  const bounded = createOutputDisclosureStore(2);
  bounded.set(["old", "new", "latest"], true);
  assert.equal(bounded.read(["old"], false), false);
  assert.equal(bounded.read(["latest"], false), true);
});

test("closed and historical native questions stay visible but cannot be answered", () => {
  const question = item("question", "user_input_request", { status: "waiting", request: { id: "request", itemId: "question", kind: "user_input", title: "Choose a scope", respondable: true, questions: [{ id: "scope", prompt: "Which scope?", allowText: true }] } });
  assert.equal(canRespondToInteraction(question, "running"), true);
  assert.equal(requiresVisibleDetails(question), true);
  assert.equal(generationIndicator("running", [question]), undefined);
  assert.equal(canRespondToInteraction({ ...question, request: { ...question.request!, respondable: false } }, "running"), false);
  assert.equal(canRespondToInteraction({ ...question, status: "completed" }, "running"), false);
  for (const status of ["completed", "failed", "cancelled", "interrupted"] as const) assert.equal(canRespondToInteraction(question, status), false);
});

test("native MCP Apps retain their own visible row and association boundary beside deduplicated PM cards", () => {
  const app = item("app", "dynamic_tool", {
    output: JSON.stringify({ operationId: "operation" }),
    mcpApp: {
      attachmentId: "attachment", server: "server", tool: "tool", resourceUri: "ui://resource",
      producing: { threadId: "thread", itemId: "app", generationId: "generation", providerInstanceId: "provider", instanceRevision: 1, providerSessionId: "session", providerThreadId: "native-thread", nativeSessionId: "native-session" },
    },
  });
  assert.equal(requiresVisibleDetails(app), true);
  const rows = presentOutputItems([item("before", "file_search"), app, item("pm-tool:operation", "dynamic_tool"), item("after", "file_search")], ["operation"]);
  assert.deepEqual(rows.map(row => row.kind), ["tools", "item", "pm_tool", "tools"]);
  assert.equal(rows[1]!.kind === "item" && rows[1]!.item.mcpApp, app.mcpApp);
  assert.equal(generationIndicator("running", [item("native-terminal:hidden", "command_execution", { status: "running" })]), "processing");
});

test("unknown outcomes remain visible and do not imply failure, activity, or a completed duration", () => {
  const unresolved = item("unknown", "dynamic_tool", { status: "unknown", startedAt: "2026-11-10T00:00:00Z", timing: { source: "provider" } });
  assert.deepEqual(identities([item("before", "file_search"), unresolved, item("after", "file_search")]), [["tools", ["before"]], ["item", "unknown"], ["tools", ["after"]]]);
  assert.equal(requiresVisibleDetails(unresolved), true);
  assert.equal(generationIndicator("completed", [unresolved]), undefined);
  assert.equal(reliableDurationMs(unresolved, "running", Date.parse("2026-11-10T00:00:05Z")), undefined);
});

test("hidden native results are standalone placeholders and cannot expose a summary or answer request", () => {
  const hidden = item("pm-tool:hidden", "reasoning", {
    visibility: "redacted", status: "waiting", text: "private project title",
    request: { id: "request", itemId: "pm-tool:hidden", kind: "approval", title: "private action", respondable: true },
  });
  assert.deepEqual(identities([item("before", "file_search"), hidden, item("after", "file_search")]), [["tools", ["before"]], ["item", "pm-tool:hidden"], ["tools", ["after"]]]);
  assert.equal(reasoningPreview([hidden]), "");
  assert.equal(canRespondToInteraction(hidden, "running"), false);
  assert.equal(requiresVisibleDetails(hidden), true);
});

test("only explicit completed auto-approval records collapse, never unknown or unsafe requests", () => {
  const approved = item("permission", "approval_request", {
    request: { id: "permission", itemId: "permission", kind: "approval", title: "Permission", respondable: false, resolution: "auto_approved" },
  });
  assert.equal(isCompletedAutoApproval(approved), true);
  assert.equal(requiresVisibleDetails(approved), false);
  assert.deepEqual(identities([item("before", "file_search"), approved, item("after", "command_execution")]), [["tools", ["before", "permission", "after"]]]);
  const variants: Partial<NativeOutputItem>[] = [
    { status: "pending" }, { status: "running" }, { status: "waiting" }, { status: "unknown" },
    { status: "failed" }, { status: "interrupted" }, { status: "cancelled" },
    { error: "Response acknowledgement missing" }, { exitCode: 1 }, { visibility: "redacted" }, { visibility: "unavailable" },
    { request: { ...approved.request!, respondable: true } },
    { request: { ...approved.request!, resolution: undefined, title: "Native permission auto-approved", unavailableReason: "Auto-approved by configuration; no action required." } },
    { request: { ...approved.request!, resolution: "approved" } },
  ];
  for (const extra of variants) {
    const unsafe = { ...approved, ...extra };
    assert.equal(requiresVisibleDetails(unsafe), true, JSON.stringify(extra));
    assert.equal(presentOutputItems([unsafe])[0]!.kind, "item");
  }
});

test("semantic tool labels retain exact inputs without treating shell text as an achieved outcome", () => {
  assert.deepEqual(semanticToolSummary(item("read", "dynamic_tool", { toolName: "functions.read", input: { path: "src/file.ts:1-100" } })), { action: "read", target: "src/file.ts:1-100" });
  assert.deepEqual(semanticToolSummary(item("cat", "command_execution", { input: { command: "cat README.md" } })), { action: "read", target: "README.md" });
  const compound = "cat README.md && rm generated.tmp";
  assert.deepEqual(semanticToolSummary(item("compound", "command_execution", { input: { command: compound } })), { action: "command", target: compound });
  assert.deepEqual(semanticToolSummary(item("multiline", "command_execution", { input: "printf hi\nprintf bye" })), { action: "command", target: "printf hi" });
  assert.deepEqual(semanticToolSummary(item("hidden", "dynamic_tool", { visibility: "redacted", toolName: "secret", input: { path: "/secret" } })), { action: "tool" });
});

test("changed files preserve observed order, deduplicate same-id updates, and exclude inaccessible payloads", () => {
  const a = item("a", "file_change", { changes: [{ path: "src/a.ts", operation: "update", diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more" }] });
  const b = item("b", "file_change", { fileName: "src/b.ts", additions: 3, deletions: 1 });
  const later = item("c", "file_change", { status: "unknown", changes: [{ path: "src/a.ts", oldPath: "old.ts", operation: "rename" }] });
  const files = changedFileSummary([a, b, { ...a }, later, item("hidden", "file_change", { visibility: "unavailable", fileName: "private.ts", additions: 100 }), item("title-only", "file_change", { title: "Not a path" })]);
  assert.deepEqual(files.map(file => [file.path, file.additions, file.deletions, file.records.map(record => record.id)]), [["src/a.ts", 2, 1, ["a", "c"]], ["src/b.ts", 3, 1, ["b"]]]);
  assert.equal(files[0]!.records[1]!.status, "unknown");
  assert.equal(files[0]!.partialCounts, true);
  assert.equal(files[1]!.partialCounts, undefined);
  assert.equal(changedFileSummary([item("unknown-count", "file_change", { fileName: "file.ts" })])[0]!.additions, undefined);
  assert.equal(changedFileSummary([item("binary", "file_change", { fileName: "image.png", diff: "Binary files differ" })])[0]!.additions, undefined);
});

test("active-turn state is provider-timed, compaction-aware, and never fabricated for finished generations", () => {
  assert.equal(generationWorkState("completed", []), undefined);
  assert.deepEqual(generationWorkState("queued", []), { kind: "queued" });
  assert.deepEqual(generationWorkState("running", []), { kind: "working" });
  const observed = item("observed", "reasoning", { status: "running", timing: { source: "observed" }, startedAt: "2026-01-01T00:00:00.000Z" });
  assert.deepEqual(generationWorkState("running", [observed]), { kind: "working" });
  const later = item("later", "reasoning", { status: "running", timing: { source: "provider" }, startedAt: "2026-01-01T00:00:05.000Z" });
  const earlier = item("earlier", "file_search", { status: "completed", timing: { source: "provider" }, startedAt: "2026-01-01T00:00:02.000Z" });
  assert.deepEqual(generationWorkState("running", [later, earlier]), { kind: "working", startedAt: "2026-01-01T00:00:02.000Z" });
  assert.deepEqual(generationWorkState("running", [
    item("compact", "compaction", { status: "running" }),
  ]), { kind: "compacting" });
  assert.deepEqual(generationWorkState("running", [
    item("hidden-compact", "compaction", { visibility: "redacted", status: "running" }),
    item("done-compact", "compaction", { status: "completed" }),
  ]), { kind: "working" });
});

test("the live thought line uses the newest visible reasoning item only", () => {
  assert.deepEqual(latestReasoning([]), { preview: "", streaming: false });
  const old = item("old", "reasoning", { text: "## First thought", status: "completed" });
  const live = item("live", "reasoning", { text: "**Second thought**", status: "running", streaming: true });
  const hidden = item("hidden", "reasoning", { text: "private", visibility: "redacted", status: "running", streaming: true });
  const noise = item("noise", "assistant_message", { text: "Answer", status: "running", streaming: true });
  assert.deepEqual(latestReasoning([old, live, hidden, noise]), { preview: "Second thought", streaming: true });
  assert.deepEqual(latestReasoning([old, { ...live, streaming: false }]), { preview: "Second thought", streaming: false });
  assert.deepEqual(latestReasoning([old, { ...live, visibility: "unavailable" }]), { preview: "First thought", streaming: false });
});
