import assert from "node:assert/strict";
import { test } from "node:test";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { OrchestrationV2TurnItem, OrchestrationV2ConversationMessage, OrchestrationV2RuntimeRequest, OrchestrationV2PlanArtifact, ProviderDriverKind, ProviderSessionId } from "@t3tools/contracts";
import type { NativeInteractionRequest, NativeOutputEvent } from "@agent-workspace/contracts/output";
import { makePmEventAdapter, pmAdapterBoundaryError } from "./events.ts";
import { ProviderAdapterOpenSessionError } from "@t3tools/provider-core/server/ProviderAdapter";

const now = DateTime.makeUnsafe("2026-10-30T00:00:00.000Z");
const driver = ProviderDriverKind.make("codex");
const base = { id: "item", threadId: "thread", runId: "generation", nodeId: "root", providerThreadId: "native-thread", providerTurnId: "native-turn",
  nativeItemRef: { driver: "codex", nativeId: "native-item", strength: "strong" }, parentItemId: null, ordinal: 0,
  status: "running", title: null, startedAt: now, completedAt: null, updatedAt: now };
const item = Schema.decodeUnknownSync(Schema.toType(OrchestrationV2TurnItem));
const message = Schema.decodeUnknownSync(Schema.toType(OrchestrationV2ConversationMessage));
const request = Schema.decodeUnknownSync(Schema.toType(OrchestrationV2RuntimeRequest));

test("messages hydrate omitted bodies without duplicating text; corrections replace cumulative state and child answers stay separate", () => {
  const events: NativeOutputEvent[] = [];
  let deltas = "";
  const adapter = makePmEventAdapter({ canRespond: false, onRequest: () => assert.fail("unexpected request"), onRequestClosed: () => {},
    isRootItem: (row) => row.threadId === "thread", onEvent: (event) => events.push(event), onText: (text) => { deltas += text; } });
  const row = item({ ...base, type: "assistant_message", messageId: "message", text: "", textOmitted: true, streaming: true });
  adapter.handle({ type: "turn_item.updated", driver, turnItem: row });
  const body = message({ id: "message", threadId: "thread", runId: "generation", nodeId: "root", role: "assistant", text: "first",
    attachments: [], streaming: false, createdBy: "agent", creationSource: "provider", createdAt: now, updatedAt: now });
  adapter.handle({ type: "message.updated", driver, message: body });
  adapter.handle({ type: "message.updated", driver, message: body });
  adapter.handle({ type: "turn_item.updated", driver, turnItem: item({ ...base, type: "assistant_message", messageId: "message", text: "corrected", streaming: false }) });
  adapter.handle({ type: "turn_item.updated", driver, turnItem: item({ ...base, id: "child-answer", threadId: "child", type: "assistant_message", messageId: "child-message", text: "child output", streaming: false }) });
  assert.equal(deltas, "first");
  assert.equal(adapter.finalText(), "corrected");
  assert.equal(adapter.items.get("child-answer")?.text, "child output");
  assert.equal(adapter.items.get("child-answer")?.parentItemId, "native-child:child");
  assert.equal(events.filter((event) => event.type === "item.upsert").length, 5);
});

test("request and item ordering joins once, default-denies native approval, and observes native closure", () => {
  const offered: NativeInteractionRequest[] = [];
  const closed: string[] = [];
  const adapter = makePmEventAdapter({ canRespond: true, onRequest: (value) => offered.push(value), onRequestClosed: (id) => closed.push(id),
    isLiveRequest: (value) => value.responseCapability.type === "live" && value.responseCapability.providerSessionId === "session" });
  const live = request({ id: "question", nodeId: "root", providerTurnId: "native-turn", nativeRequestRef: null, kind: "user_input", status: "pending",
    responseCapability: { type: "live", providerSessionId: "session" }, createdAt: now, resolvedAt: null });
  adapter.handle({ type: "runtime_request.updated", driver, runtimeRequest: live });
  assert.equal(offered.length, 0);
  const question = item({ ...base, type: "user_input_request", requestId: "question", questions: [{ id: "color", header: "Color", question: "Choose colors",
    options: [{ label: "Red", value: "red", description: "warm" }], multiSelect: true, allowCustomAnswer: false }] });
  adapter.handle({ type: "turn_item.updated", driver, turnItem: question });
  adapter.handle({ type: "turn_item.updated", driver, turnItem: question });
  assert.equal(offered.length, 1);
  assert.deepEqual(offered[0].questions?.[0], { id: "color", title: "Color", prompt: "Choose colors", options: [{ id: "red", label: "Red", description: "warm" }], multiple: true, allowText: false });
  adapter.handle({ type: "runtime_request.updated", driver, runtimeRequest: { ...live, status: "cancelled" } });
  assert.deepEqual(closed, ["question"]);
  assert.equal(adapter.items.get("item")?.request?.respondable, false);
  adapter.handle({ type: "turn_item.updated", driver, turnItem: item({ ...base, id: "approval-item", type: "approval_request", requestId: "approval", requestKind: "command", prompt: "Run shell?" }) });
  adapter.handle({ type: "runtime_request.updated", driver, runtimeRequest: { ...live, id: Schema.decodeUnknownSync(OrchestrationV2RuntimeRequest.fields.id)("approval"), kind: "command" } });
  assert.equal(offered[1].kind, "approval");
  assert.equal(offered[1].respondable, false);
  assert.match(offered[1].unavailableReason!, /PM business approvals remain separate/);
});

test("auto-approve labels native approvals as configuration decisions", () => {
  const previousMode = process.env.AGENT_APPROVAL_MODE;
  process.env.AGENT_APPROVAL_MODE = "auto-approve";
  try {
    const offered: NativeInteractionRequest[] = [];
    const adapter = makePmEventAdapter({ canRespond: true, onRequest: (value) => offered.push(value), onRequestClosed: () => {},
      isLiveRequest: (value) => value.responseCapability.type === "live" && value.responseCapability.providerSessionId === "session" });
    const live = request({ id: "question", nodeId: "root", providerTurnId: "native-turn", nativeRequestRef: null, kind: "user_input", status: "pending",
      responseCapability: { type: "live", providerSessionId: "session" }, createdAt: now, resolvedAt: null });
    adapter.handle({ type: "turn_item.updated", driver, turnItem: item({ ...base, id: "approval-item", type: "approval_request", requestId: "approval", requestKind: "command", prompt: "Run shell?" }) });
    adapter.handle({ type: "runtime_request.updated", driver, runtimeRequest: { ...live, id: Schema.decodeUnknownSync(OrchestrationV2RuntimeRequest.fields.id)("approval"), kind: "command" } });
    assert.equal(offered.length, 1);
    assert.equal(offered[0].kind, "approval");
    assert.equal(offered[0].respondable, false);
    assert.equal(offered[0].title, "Native permission auto-approved");
    assert.match(offered[0].unavailableReason!, /Auto-approved by configuration/);
  } finally {
    if (previousMode === undefined) delete process.env.AGENT_APPROVAL_MODE; else process.env.AGENT_APPROVAL_MODE = previousMode;
  }
});

test("plan-before-row does not duplicate a visible artifact; command deltas stay separate from final output", () => {
  const events: NativeOutputEvent[] = [];
  const adapter = makePmEventAdapter({ canRespond: false, onRequest: () => {}, onRequestClosed: () => {}, onEvent: (event) => events.push(event) });
  const plan = Schema.decodeUnknownSync(Schema.toType(OrchestrationV2PlanArtifact))({ id: "plan", threadId: "thread", runId: "generation", nodeId: "root", kind: "proposed_plan", status: "completed", markdown: "final plan" });
  adapter.handle({ type: "plan.updated", driver, plan });
  adapter.handle({ type: "turn_item.updated", driver, turnItem: item({ ...base, id: "original-plan-item", type: "proposed_plan", planId: "plan", markdown: "final plan", streaming: false }) });
  adapter.flushPlans();
  assert.deepEqual([...adapter.items.keys()], ["original-plan-item"]);
  adapter.handle({ type: "command_output.delta", driver, threadId: plan.threadId, itemId: Schema.decodeUnknownSync(OrchestrationV2TurnItem.members[0].fields.id)("cmd"), chunk: "partial" });
  adapter.handle({ type: "turn_item.updated", driver, turnItem: item({ ...base, id: "cmd", type: "command_execution", input: "echo final", output: "final", status: "completed" }) });
  assert.equal(adapter.items.get("cmd")?.output, "final");
  assert.equal(events.filter((event) => event.type === "command.output").length, 1);
});

test("original adapter errors retain structured auth/quota/payment evidence without exposing private causes", () => {
  const wrap = (cause: unknown) => new ProviderAdapterOpenSessionError({ driver, providerSessionId: ProviderSessionId.make("session"), cause });
  const authenticated = pmAdapterBoundaryError(wrap(Object.assign(new Error("private body and secret"), { status: 401, code: "unauthorized" })));
  assert.equal(authenticated.status, 401);
  assert.equal(authenticated.errorClass, "authentication");
  assert.doesNotMatch(authenticated.message, /private body and secret/);
  assert.equal("cause" in authenticated, false);
  const resetAt = "2026-10-31T00:00:00.000Z";
  const quota = pmAdapterBoundaryError(wrap({ statusCode: 429, code: "rate_limit_exceeded", resetAt }));
  assert.equal(quota.errorClass, "usage_limit");
  assert.equal(quota.resetAt, resetAt);
  const payment = pmAdapterBoundaryError(wrap({ statusCode: 402, code: "payment_required" }));
  assert.equal(payment.status, 402);
  assert.equal(payment.errorClass, "provider_error");
  const missing = pmAdapterBoundaryError(wrap({ status: 404, code: "native_session_missing" }), "session_mismatch", 409);
  assert.equal(missing.code, "session_mismatch");
  assert.equal(missing.status, 409);
});

test("nullable original native IDs remain absent and notification detail is not discarded", () => {
  const adapter = makePmEventAdapter({ canRespond: false, onRequest: () => assert.fail("unexpected request"), onRequestClosed: () => {} });
  adapter.handle({ type: "turn_item.updated", driver, turnItem: item({ ...base, type: "notification",
    nativeItemRef: { driver, nativeId: null, strength: "none" }, status: "completed",
    source: { kind: "command" }, outcome: "completed", summary: "Native result", detail: "Complete native detail" }) });
  const output = adapter.items.get(base.id)!;
  assert.equal(output.nativeItemId, undefined);
  assert.equal(output.text, "Native result\n\nComplete native detail");
});

test("string-valued structured HTTP status survives the original adapter error boundary", () => {
  const error = new ProviderAdapterOpenSessionError({ driver, providerSessionId: ProviderSessionId.make("session"),
    cause: { statusCode: "403", code: "forbidden" } });
  const publicError = pmAdapterBoundaryError(error);
  assert.equal(publicError.status, 403);
  assert.equal(publicError.errorClass, "authentication");
  assert.equal("cause" in publicError, false);
});
