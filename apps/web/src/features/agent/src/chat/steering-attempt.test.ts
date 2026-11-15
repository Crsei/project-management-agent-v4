import assert from "node:assert/strict";
import { test } from "node:test";
import { steeringAttemptAfterError, type SteeringAttempt } from "./steering-attempt.ts";

test("stale generation rejection releases its attempt so a later generation in the same thread can be steered", async () => {
  let attempt: SteeringAttempt | null = { id: "attempt-a", generationId: "generation-a", text: "Keep the intended instruction" };
  const dispatched: string[] = [];
  const submit = async (value: SteeringAttempt) => {
    if (value.generationId === "generation-a") throw Object.assign(new Error("Active generation changed before dispatch"), { status: 409, code: "stale_execution" });
    dispatched.push(value.generationId);
  };
  try { await submit(attempt); } catch (error) { attempt = steeringAttemptAfterError(attempt, error); }
  assert.equal(attempt, null); assert.deepEqual(dispatched, []);
  attempt = { id: "attempt-b", generationId: "generation-b", text: "Keep the intended instruction" };
  await submit(attempt);
  assert.deepEqual(dispatched, ["generation-b"]);
});
test("a definite capability/confirmation rejection permits editing, but unknown dispatch results retain the exact identity", () => {
  const attempt: SteeringAttempt = { id: "same-id", generationId: "generation", text: "same instruction" };
  for (const error of [{ status: 409, code: "unsupported_steering" }, { status: 400, code: "confirmation_required" }, { status: 403, code: "actor_changed" }])
    assert.equal(steeringAttemptAfterError(attempt, error), null);
  for (const error of [new TypeError("connection lost"), { status: 500, code: "operation_unknown" }, { status: 409, code: "steering_unknown" },
    { status: 409, code: "idempotency_conflict" }, { status: 500, code: "stale_execution" }, { status: 409, code: "unrecognized" }])
    assert.equal(steeringAttemptAfterError(attempt, error), attempt);
});
