import assert from "node:assert/strict";
import test from "node:test";
import { breadcrumbLayout, initialsTone, workspaceInitials } from "./chat-header-model.ts";

test("breadcrumb keeps the full trail until the container is measured", () => {
  assert.deepEqual(breadcrumbLayout(undefined, { workspace: true, parent: true }), {
    tier: "wide",
    showWorkspace: true,
    showParent: true,
  });
});

test("breadcrumb collapses the workspace label before the parent entry", () => {
  const both = { workspace: true, parent: true };
  assert.deepEqual(breadcrumbLayout(720, both), { tier: "wide", showWorkspace: true, showParent: true });
  assert.deepEqual(breadcrumbLayout(500, both), { tier: "compact", showWorkspace: false, showParent: true });
  assert.deepEqual(breadcrumbLayout(330, both), { tier: "tight", showWorkspace: false, showParent: true });
  assert.deepEqual(breadcrumbLayout(299, both), { tier: "tight", showWorkspace: false, showParent: false });
  assert.deepEqual(breadcrumbLayout(0, both), { tier: "tight", showWorkspace: false, showParent: false });
});

test("breadcrumb keeps the workspace label longer when there is no parent", () => {
  const solo = { workspace: true, parent: false };
  assert.deepEqual(breadcrumbLayout(440, solo), { tier: "compact", showWorkspace: true, showParent: false });
  assert.deepEqual(breadcrumbLayout(400, solo), { tier: "compact", showWorkspace: false, showParent: false });
});

test("initials are deterministic for latin, cjk and empty names", () => {
  assert.equal(workspaceInitials("Acme Robotics"), "AR");
  assert.equal(workspaceInitials("acme"), "AC");
  assert.equal(workspaceInitials("UI-Examples"), "UE");
  assert.equal(workspaceInitials("星海科技"), "星海");
  assert.equal(workspaceInitials("A"), "A");
  assert.equal(workspaceInitials("   "), "?");
  assert.equal(workspaceInitials(undefined), "?");
  assert.equal(workspaceInitials("🙂"), "?");
});

test("fallback badge tone is stable and inside the palette range", () => {
  for (const name of ["Acme Robotics", "星海科技", "workspace", ""]) {
    const tone = initialsTone(name);
    assert.equal(tone, initialsTone(name));
    assert.ok(Number.isInteger(tone) && tone >= 0 && tone < 6);
  }
});
