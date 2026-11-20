import assert from "node:assert/strict";
import test from "node:test";
import {
  shortCommit,
  worktreeCreateBlockers,
  worktreeEndBlockers,
  worktreeEndStateSchema,
  worktreeHealth,
  worktreeMutationRevisions,
  worktreeStateSchema,
  type WorktreeSnapshot,
} from "./thread-worktree-model.ts";

const worktree = (patch: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot => ({
  branch: "chat/abc",
  directory: "/data/chat-worktrees/t1",
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  clean: true,
  state: "active",
  ...patch,
});

test("short commits keep the full identity available", () => {
  assert.equal(shortCommit("a".repeat(40)), "a".repeat(10));
  assert.equal(shortCommit("abc"), "abc");
  assert.equal(shortCommit("  " + "c".repeat(40) + "  ", 8), "c".repeat(8));
});

test("worktree health reflects a transition before tree cleanliness", () => {
  assert.equal(worktreeHealth(worktree()), "clean");
  assert.equal(worktreeHealth(worktree({ clean: false })), "dirty");
  assert.equal(worktreeHealth(worktree({ clean: false, state: "transitioning" })), "transitioning");
});

test("create is blocked for an existing worktree, local busy, transition and live terminals", () => {
  assert.deepEqual(worktreeCreateBlockers({ worktree: null, busy: false, activeTerminals: 0 }), []);
  assert.deepEqual(worktreeCreateBlockers({ worktree: worktree(), busy: false, activeTerminals: 0 }), ["exists"]);
  assert.deepEqual(worktreeCreateBlockers({ worktree: null, busy: true, activeTerminals: 0 }), ["busy"]);
  assert.deepEqual(worktreeCreateBlockers({ worktree: worktree({ state: "transitioning" }), busy: false, activeTerminals: 0 }), ["exists", "transitioning"]);
  assert.deepEqual(worktreeCreateBlockers({ worktree: null, busy: false, activeTerminals: 1 }), ["terminals"]);
});

test("end reports every server-side refusal that applies", () => {
  assert.deepEqual(worktreeEndBlockers({ worktree: null, busy: false, activeTerminals: 0 }), []);
  assert.deepEqual(worktreeEndBlockers({ worktree: worktree(), busy: false, activeTerminals: 0 }), []);
  assert.deepEqual(worktreeEndBlockers({ worktree: worktree({ clean: false }), busy: false, activeTerminals: 0 }), ["dirty"]);
  assert.deepEqual(worktreeEndBlockers({ worktree: worktree({ clean: false }), busy: true, activeTerminals: 2 }), ["busy", "terminals", "dirty"]);
  assert.deepEqual(worktreeEndBlockers({ worktree: worktree({ state: "transitioning" }), busy: false, activeTerminals: 0 }), ["transitioning"]);
});

test("mutations only forward the revisions read from the server", () => {
  assert.deepEqual(
    worktreeMutationRevisions({ worktree: worktree(), revision: 7, lifecycleRevision: 3 }),
    { revision: 7, lifecycleRevision: 3 },
  );
});

test("worktree payloads are validated at the boundary and unknown fields are ignored", () => {
  const parsed = worktreeStateSchema.parse({
    worktree: {
      branch: "chat/abc",
      directory: "/data/chat-worktrees/t1",
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      clean: true,
      state: "active",
      threadId: "t1",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    revision: 4,
    lifecycleRevision: 2,
  });
  assert.equal(parsed.worktree?.branch, "chat/abc");
  assert.equal(parsed.worktree?.clean, true);
  assert.equal(parsed.revision, 4);
  assert.equal(worktreeStateSchema.safeParse({ worktree: null, revision: 0, lifecycleRevision: 0 }).success, true);
  assert.equal(worktreeStateSchema.safeParse({ worktree: null, revision: -1, lifecycleRevision: 0 }).success, false);
  assert.equal(worktreeStateSchema.safeParse({ worktree: { branch: "" }, revision: 0, lifecycleRevision: 0 }).success, false);

  const ended = worktreeEndStateSchema.parse({ worktree: null, revision: 5, lifecycleRevision: 2, retainedBranch: "chat/abc" });
  assert.equal(ended.retainedBranch, "chat/abc");
  assert.equal(worktreeEndStateSchema.safeParse({ worktree: null, revision: 5, lifecycleRevision: 2 }).success, false);
});
