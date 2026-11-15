import assert from "node:assert/strict";
import test from "node:test";
import { planFilename, planMarkdown } from "./plan-presenter.ts";
import type { NativeOutputItem } from "@agent-workspace/contracts/output";

const plan = (extra: Partial<NativeOutputItem>): NativeOutputItem => ({ id: "plan", type: "proposed_plan", status: "completed", ...extra });

test("plan copy and download preserve exact provider Markdown, including fences and whitespace", () => {
  const text = "# Migration plan\n\n```ts\nconst value = 1;\n```\n";
  assert.equal(planMarkdown(plan({ text })), text);
  assert.equal(planMarkdown(plan({ steps: [{ id: "one", text: "Read current behavior", status: "completed" }, { id: "two", text: "Make the change", status: "running" }] })), "- [x] Read current behavior\n- [ ] Make the change");
  assert.equal(planMarkdown(plan({})), "");
});

test("plan export names cannot become paths or control-bearing download names", () => {
  assert.equal(planFilename(plan({ title: "../../release/plan" })), "release-plan.md");
  assert.equal(planFilename(plan({ title: "\u0000/" })), "proposed-plan.md");
  assert.equal(planFilename(plan({ text: "# 修复依赖\nDetails" })), "修复依赖.md");
  assert.ok(planFilename(plan({ title: "a".repeat(200) })).length <= 83);
});
