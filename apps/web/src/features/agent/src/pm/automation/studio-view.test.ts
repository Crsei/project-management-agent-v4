import assert from "node:assert/strict";
import { test } from "node:test";
import { csvCell, executionDuration, parseStudioDraftRoute, readEveryStudioPage } from "./studio-view.ts";

test("Chat return local recovery IDs never masquerade as saved definitions", () => {
  assert.deepEqual(parseStudioDraftRoute("new:github-pr-reviewer:PRJ-001"), { templateId: "github-pr-reviewer", projectId: "PRJ-001" });
  assert.deepEqual(parseStudioDraftRoute("new:blank:"), { templateId: null, projectId: "" });
  assert.equal(parseStudioDraftRoute("98f6eae9-e01b-4c71-8431-b9af4aad07c5"), null);
  assert.equal(parseStudioDraftRoute("new:blank:another-workspace"), null);
});

test("complete history export traverses every cursor, including empty authorization-filtered pages", async () => {
  const requested: (string | undefined)[] = [];
  const items = await readEveryStudioPage(async cursor => {
    requested.push(cursor);
    if (cursor === undefined) return { items: ["first"], nextCursor: "middle" };
    if (cursor === "middle") return { items: [], nextCursor: "last" };
    return { items: ["last"], nextCursor: null };
  });
  assert.deepEqual(requested, [undefined, "middle", "last"]);
  assert.deepEqual(items, ["first", "last"]);
});

test("repeated cursor or failed later page rejects the entire export", async () => {
  await assert.rejects(readEveryStudioPage(async () => ({ items: ["not a complete export"], nextCursor: "loop" })), /invalid_pagination_cursor/);
  await assert.rejects(readEveryStudioPage(async cursor => {
    if (cursor) throw new Error("authorization_revoked");
    return { items: ["first page only"], nextCursor: "next" };
  }), /authorization_revoked/);
});

test("CSV preserves quotes and multiline logs without spreadsheet formula execution", () => {
  assert.equal(csvCell('line 1\n"line 2"'), '"line 1\n""line 2"""');
  assert.equal(csvCell("=HYPERLINK(\"external\")"), '"\'=HYPERLINK(""external"")"');
  assert.equal(csvCell("  +SUM(1,2)"), '"\'  +SUM(1,2)"');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(2), '"2"');
});

test("unfinished and invalid execution durations remain unavailable, not zero", () => {
  assert.equal(executionDuration({ startedAt: null, finishedAt: null }), null);
  assert.equal(executionDuration({ startedAt: "2026-11-01T00:00:10.000Z", finishedAt: null }), null);
  assert.equal(executionDuration({ startedAt: "2026-11-01T00:00:10.000Z", finishedAt: "2026-11-01T00:00:00.000Z" }), null);
  assert.equal(executionDuration({ startedAt: "2026-11-01T00:00:00.000Z", finishedAt: "2026-11-01T00:00:01.250Z" }), 1250);
});
