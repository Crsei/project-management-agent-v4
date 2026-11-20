import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderInstance } from "@agent-workspace/contracts/provider";
import { FANOUT_LIMIT, type FanoutModelSelection, type FanoutOutcome } from "./model-fanout.ts";
import {
  buildFanoutUserMessage,
  composerFanoutBlockerCopy,
  composerFanoutGate,
  fanoutReceiptSucceeded,
  fanoutSelectionsAvailable,
  firstFanoutChildThread,
  resolveFanoutOperationId,
  type ComposerFanoutBlocker,
  type ComposerFanoutGateInput,
} from "./composer-fanout.ts";

const a: FanoutModelSelection = { providerInstanceId: "p", model: "a" };
const b: FanoutModelSelection = { providerInstanceId: "p", model: "b" };

const gate = (overrides: Partial<ComposerFanoutGateInput> = {}): ComposerFanoutGateInput => ({
  selections: [a, b],
  hasText: true,
  attachmentCount: 0,
  quote: false,
  contextItemCount: 0,
  pmReferenceCount: 0,
  running: false,
  historyBlocked: false,
  providerAvailable: true,
  remoteId: "remote-thread",
  composerUnavailable: false,
  ...overrides,
});

test("single-model mode is never intercepted by fanout", () => {
  assert.deepEqual(composerFanoutGate(gate({ selections: null })), { active: false, blocker: null });
  assert.deepEqual(composerFanoutGate(gate({ selections: [a] })), { active: false, blocker: null });
  assert.deepEqual(composerFanoutGate(gate({ selections: [] })), { active: false, blocker: null });
});

test("a plain-text draft against a real session passes the gate", () => {
  assert.deepEqual(composerFanoutGate(gate()), { active: true, blocker: null });
});

test("non-text drafts are refused instead of silently sending single-model", () => {
  assert.equal(composerFanoutGate(gate({ hasText: false })).blocker, "fanout_text_required");
  assert.equal(composerFanoutGate(gate({ attachmentCount: 1 })).blocker, "fanout_attachment_unsupported");
  assert.equal(composerFanoutGate(gate({ quote: true })).blocker, "fanout_quote_unsupported");
  assert.equal(composerFanoutGate(gate({ contextItemCount: 2 })).blocker, "fanout_context_unsupported");
  assert.equal(composerFanoutGate(gate({ pmReferenceCount: 1 })).blocker, "fanout_context_unsupported");
  assert.equal(composerFanoutGate(gate({ composerUnavailable: true })).blocker, "fanout_composer_unavailable");
});

test("runtime and session preconditions reuse the server fanoutBlocker reasons", () => {
  assert.equal(composerFanoutGate(gate({ running: true })).blocker, "fanout_session_running");
  assert.equal(composerFanoutGate(gate({ historyBlocked: true })).blocker, "fanout_history_blocked");
  assert.equal(composerFanoutGate(gate({ providerAvailable: false })).blocker, "fanout_provider_unavailable");
  assert.equal(
    composerFanoutGate(gate({ selections: Array.from({ length: FANOUT_LIMIT + 1 }, (_, index) => ({ providerInstanceId: "p", model: `m${index}` })) })).blocker,
    "fanout_exceeds_limit",
  );
});

test("a draft without a remote session is blocked with the explicit save-first reason", () => {
  assert.equal(composerFanoutGate(gate({ remoteId: undefined })).blocker, "fanout_requires_remote_session");
});

test("every blocker has localized copy and the remote-session reason is honest", () => {
  const blockers: ComposerFanoutBlocker[] = [
    "fanout_requires_two_models", "fanout_exceeds_limit", "fanout_text_required",
    "fanout_attachment_unsupported", "fanout_session_running", "fanout_history_blocked",
    "fanout_provider_unavailable", "fanout_context_unsupported", "fanout_quote_unsupported",
    "fanout_requires_remote_session", "fanout_composer_unavailable",
  ];
  for (const blocker of blockers) {
    const copy = composerFanoutBlockerCopy(blocker);
    assert.ok(copy.zh.length > 0, blocker);
    assert.ok(copy.en.length > 0, blocker);
  }
  assert.match(composerFanoutBlockerCopy("fanout_requires_remote_session").zh, /先发送一条单模型消息或设置会话参数/u);
});

test("the fanout message carries one plain text part and no metadata", () => {
  assert.deepEqual(buildFanoutUserMessage({ id: "m-1", text: "hello" }), {
    id: "m-1",
    role: "user",
    parts: [{ type: "text", text: "hello" }],
  });
});

test("operation ids are reused from the pending attempt, then session storage, and only then generated", () => {
  let generated = 0;
  const create = () => { generated += 1; return "fresh"; };
  assert.deepEqual(
    resolveFanoutOperationId({ pending: "op-pending", stored: "op-stored", generate: create }),
    { operationId: "op-pending", reused: true },
  );
  assert.deepEqual(
    resolveFanoutOperationId({ stored: "op-stored", generate: create }),
    { operationId: "op-stored", reused: true },
  );
  assert.deepEqual(
    resolveFanoutOperationId({ generate: create }),
    { operationId: "fresh", reused: false },
  );
  assert.equal(generated, 1);
});

function provider(overrides: Partial<ProviderInstance> = {}): ProviderInstance {
  return {
    instanceId: "p",
    driver: "codex",
    label: "Codex",
    enabled: true,
    config: {},
    secretConfigKeys: [],
    authMode: "agent",
    authStatus: "authenticated",
    nativeSessionReady: true,
    configured: true,
    credentialSource: null,
    models: [
      { id: "a", label: "Model A", temperature: false },
      { id: "b", label: "Model B", temperature: false },
    ],
    modelsSource: "builtin",
    canLogin: true,
    canLogout: false,
    ...overrides,
  };
}

test("availability requires every stacked provider and model to be ready", () => {
  assert.equal(fanoutSelectionsAvailable([provider()], [a, b]), true);
  assert.equal(fanoutSelectionsAvailable([provider()], [a, { providerInstanceId: "q", model: "c" }]), false);
  assert.equal(fanoutSelectionsAvailable([], [a, b]), false);
  assert.equal(fanoutSelectionsAvailable([provider({ enabled: false })], [a, b]), false);
  assert.equal(fanoutSelectionsAvailable([provider({ authStatus: "unauthenticated" })], [a, b]), false);
  assert.equal(fanoutSelectionsAvailable([provider({ nativeSessionReady: false })], [a, b]), false);
  assert.equal(fanoutSelectionsAvailable([provider({ models: [{ id: "a", label: "Model A", temperature: false }] })], [a, b]), false);
});

const outcome = (
  status: FanoutOutcome["status"],
  children: FanoutOutcome["children"],
): FanoutOutcome => ({ operationId: "op", sourceThreadId: "source", status, children, createdAt: "2026-01-01T00:00:00.000Z" });

test("only a final receipt clears the stack; failed stays retryable", () => {
  assert.equal(fanoutReceiptSucceeded({ status: "created" }), true);
  assert.equal(fanoutReceiptSucceeded({ status: "partial" }), true);
  assert.equal(fanoutReceiptSucceeded({ status: "failed" }), false);
});

test("the default open target is the first child without an error", () => {
  const receipt = outcome("partial", [
    { selection: a, threadId: "failed-child", error: "model unavailable" },
    { selection: b, threadId: "created-child", generationId: "g-1" },
  ]);
  assert.equal(firstFanoutChildThread(receipt), "created-child");
  assert.equal(firstFanoutChildThread(outcome("failed", [{ selection: a, threadId: "t", error: "boom" }])), undefined);
});
