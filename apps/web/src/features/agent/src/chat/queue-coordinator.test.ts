import assert from "node:assert/strict";
import { test } from "node:test";
import { ForegroundQueueCoordinator, type QueueSnapshot, type QueuePauseReason } from "./queue-coordinator.ts";

function snapshot(status: "running" | "completed" | "failed" = "running"): QueueSnapshot {
  return { runtimeId: "server-one", headId: status === "completed" ? "reply-one" : "input-one", latest: { id: "generation-one", messageId: "reply-one", status }, messages: [{
    id: "queued", threadId: "session", revision: 0, status: "queued", createdAt: "2026-11-13T00:00:00Z", updatedAt: "2026-11-13T00:00:00Z",
    afterGenerationId: "generation-one", afterHeadId: "input-one", afterGenerationWasActive: true, draft: { message: { id: "queued-input", role: "user", parts: [{ type: "text", text: "Second real turn" }] } },
  }] };
}
test("explicit enqueue waits for blocked first turn, then dispatches exactly once with completed-head CAS", async () => {
  const calls: unknown[] = [];
  const owner = new ForegroundQueueCoordinator(async (message, expected) => { calls.push({ id: message.id, expected }); return { generationId: "generation-two" }; }, () => {});
  const running = snapshot(); owner.enqueueIntent(running, "queued");
  await owner.advance(running); await owner.advance(running); assert.equal(calls.length, 0);
  const completed = snapshot("completed"); await owner.advance(completed);
  assert.deepEqual(calls, [{ id: "queued", expected: { expectedHeadId: "reply-one", expectedGenerationId: "generation-one" } }]);
  await owner.advance({ ...completed, latest: { id: "generation-two", messageId: "reply-two", status: "running" }, messages: [{ ...completed.messages[0]!, status: "sent", generationId: "generation-two" }] });
  assert.equal(calls.length, 1);
});
test("mount/restart/hidden failure never resumes original queued intent without explicit review", async () => {
  let calls = 0; let reason: QueuePauseReason | undefined;
  const owner = new ForegroundQueueCoordinator(async () => { calls++; return { generationId: "sent" }; }, state => { reason = state.reason; });
  const completed = snapshot("completed"); await owner.advance(completed); assert.equal(calls, 0);
  owner.enqueueIntent(completed, "queued"); owner.pause("hidden"); await owner.advance(completed); assert.equal(calls, 0); assert.equal(reason, "hidden");
  owner.resume(completed); await owner.advance({ ...completed, runtimeId: "server-two" }); assert.equal(calls, 0); assert.equal(reason, "server-restarted");
});
test("changed history, failed previous execution and unknown rows block automatic dispatch", async () => {
  for (const variant of ["changed", "failed", "unknown"] as const) {
    let calls = 0; let reason: QueuePauseReason | undefined;
    const owner = new ForegroundQueueCoordinator(async () => { calls++; return { generationId: "sent" }; }, state => { reason = state.reason; });
    const current = snapshot(); owner.enqueueIntent(current, "queued");
    const next = snapshot(variant === "failed" ? "failed" : "completed");
    if (variant === "changed") next.headId = "another-branch";
    if (variant === "unknown") next.messages[0]!.status = "unknown";
    await owner.advance(next); assert.equal(calls, 0); assert.equal(reason, variant === "changed" ? "history-changed" : variant === "failed" ? "previous-failed" : "unknown");
  }
});
test("network-unknown dispatch is attempted once and cannot auto replay", async () => {
  let calls = 0;
  const owner = new ForegroundQueueCoordinator(async () => { calls++; throw new Error("HTTP result lost"); }, () => {});
  const completed = snapshot("completed"); owner.enqueueIntent(completed, "queued");
  await owner.advance(completed); await owner.advance(completed); assert.equal(calls, 1);
});
test("adding a new draft does not resume an older paused backlog", async () => {
  let calls = 0;
  const owner = new ForegroundQueueCoordinator(async () => { calls++; return { generationId: "sent" }; }, () => {});
  const current = snapshot("completed"); current.messages.push({ ...current.messages[0]!, id: "new-draft" });
  owner.enqueueIntent(current, "new-draft"); await owner.advance(current); assert.equal(calls, 0);
  owner.resume(current); await owner.advance(current); assert.equal(calls, 1);
});
test("explicit review of a failed previous result authorizes only the next new message, not a retry", async () => {
  let dispatched: unknown;
  const owner = new ForegroundQueueCoordinator(async (message, expected) => { dispatched = { inputId: message.draft!.message.id, expected }; return { generationId: "new-generation" }; }, () => {});
  const failed = snapshot("failed"); owner.resume(failed, "generation-one"); await owner.advance(failed);
  assert.deepEqual(dispatched, { inputId: "queued-input", expected: { expectedHeadId: "input-one", expectedGenerationId: "generation-one", confirmAfterGenerationId: "generation-one" } });
});
test("enqueue and explicit resume adopt a confirmed rewound branch, then await the new generation normally", async () => {
  for (const entry of ["enqueue", "resume"] as const) {
    const calls: unknown[] = [];
    const owner = new ForegroundQueueCoordinator(async (message, expected) => { calls.push({ id: message.id, expected }); return { generationId: "generation-two" }; }, () => {});
    const rewound = snapshot("completed"); rewound.headId = "reply-earlier";
    rewound.messages[0] = { ...rewound.messages[0]!, afterHeadId: "reply-earlier", afterGenerationWasActive: false };
    if (entry === "enqueue") owner.enqueueIntent(rewound, "queued"); else owner.resume(rewound);
    await owner.advance(rewound);
    assert.deepEqual(calls, [{ id: "queued", expected: { expectedHeadId: "reply-earlier", expectedGenerationId: "generation-one" } }]);
    const second = { ...rewound.messages[0]!, id: "another", draft: { message: { ...rewound.messages[0]!.draft!.message, id: "another-input" } } };
    const waiting: QueueSnapshot = { ...rewound, headId: "another-input", latest: { id: "generation-two", messageId: "reply-two", status: "running" },
      messages: [{ ...rewound.messages[0]!, status: "sent", generationId: "generation-two" }, second] };
    await owner.advance(waiting); assert.equal(calls.length, 1);
    await owner.advance({ ...waiting, headId: "reply-two", latest: { ...waiting.latest!, status: "completed" } });
    assert.equal(calls.length, 2);
  }
});
test("adopting a rewound branch never adopts a later unsolicited head or an awaited completion on another branch", async () => {
  for (const awaiting of [false, true]) {
    let calls = 0; let reason: QueuePauseReason | undefined;
    const owner = new ForegroundQueueCoordinator(async () => { calls++; return { generationId: "new" }; }, state => { reason = state.reason; });
    const original = snapshot(awaiting ? "running" : "completed");
    original.headId = "reply-earlier";
    original.messages[0] = { ...original.messages[0]!, afterHeadId: "reply-earlier", afterGenerationWasActive: awaiting };
    owner.enqueueIntent(original, "queued");
    await owner.advance({ ...original, headId: "unsolicited-head", latest: { ...original.latest!, status: "completed" } });
    assert.equal(calls, 0); assert.equal(reason, "history-changed");
  }
});
