import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderInstance } from "@agent-workspace/contracts/provider";
import { FANOUT_LIMIT, type FanoutModelSelection } from "./model-fanout.ts";
import {
  beginFanoutStacking,
  exitFanoutStacking,
  fanoutModelAvailability,
  fanoutPickerActive,
  fanoutPickerCandidate,
  fanoutPickerCapacity,
  fanoutPickerSingle,
  fanoutTriggerSummary,
  toggleFanoutPickerModel,
} from "./model-fanout-picker-model.ts";

const a: FanoutModelSelection = { providerInstanceId: "p", model: "a" };
const b: FanoutModelSelection = { providerInstanceId: "p", model: "b" };
const c: FanoutModelSelection = { providerInstanceId: "q", model: "c" };

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
      { id: "b", label: "Model B", temperature: false, disabledReason: "retired" },
    ],
    modelsSource: "builtin",
    canLogin: true,
    canLogout: false,
    ...overrides,
  };
}

test("trigger labels keep one or two names and collapse the rest into +N", () => {
  assert.deepEqual(fanoutTriggerSummary([]), {
    names: [], visible: [], overflow: 0, count: 0, short: "", full: "",
  });
  assert.equal(fanoutTriggerSummary(["Opus"]).short, "Opus");
  const stacked = fanoutTriggerSummary(["Opus", "GPT-5", "Sonnet"]);
  assert.deepEqual(stacked.visible, ["Opus", "GPT-5"]);
  assert.equal(stacked.overflow, 1);
  assert.equal(stacked.short, "Opus · GPT-5 +1");
  assert.equal(stacked.full, "Opus · GPT-5 · Sonnet");
  assert.equal(fanoutTriggerSummary(["Opus", "GPT-5"]).short, "Opus · GPT-5");
  assert.equal(fanoutTriggerSummary(["  Opus  ", ""]).short, "Opus");
});

test("stacking activates at two models and falls back to single below two", () => {
  const started = beginFanoutStacking(a);
  assert.equal(started.mode, "stacking");
  assert.equal(fanoutPickerActive(started), false);

  const two = toggleFanoutPickerModel(started, b);
  assert.equal(two.changed, true);
  assert.deepEqual(two.state.selections, [a, b]);
  assert.equal(fanoutPickerActive(two.state), true);

  const three = toggleFanoutPickerModel(two.state, c);
  assert.deepEqual(three.state.selections, [a, b, c]);
  assert.equal(fanoutPickerActive(three.state), true);

  const removed = toggleFanoutPickerModel(three.state, b);
  assert.deepEqual(removed.state.selections, [a, c]);
  assert.equal(fanoutPickerActive(removed.state), true);

  const exited = toggleFanoutPickerModel(removed.state, a);
  assert.equal(exited.changed, true);
  assert.equal(exited.state.mode, "single");
  assert.deepEqual(exited.state.single, c);
  assert.equal(fanoutPickerActive(exited.state), false);
});

test("single-model state ignores toggle candidates and explicit exit keeps the first stack", () => {
  const single = fanoutPickerSingle(a);
  const ignored = toggleFanoutPickerModel(single, b);
  assert.equal(ignored.changed, false);
  assert.equal(ignored.state, single);

  const exited = exitFanoutStacking(toggleFanoutPickerModel(beginFanoutStacking(a), b).state);
  assert.equal(exited.mode, "single");
  assert.deepEqual(exited.single, a);
  assert.deepEqual(exited.selections, []);
});

test("stacking stops at eight visible selections and keeps the limit reported", () => {
  let state = beginFanoutStacking(a);
  for (let index = 1; index < FANOUT_LIMIT; index++) {
    state = toggleFanoutPickerModel(state, { providerInstanceId: "p", model: `m${index}` }).state;
  }
  assert.equal(fanoutPickerCapacity(state.selections).count, FANOUT_LIMIT);
  assert.deepEqual(fanoutPickerCapacity(state.selections), {
    count: FANOUT_LIMIT, limit: FANOUT_LIMIT, atLimit: true,
  });

  const blocked = toggleFanoutPickerModel(state, { providerInstanceId: "p", model: "overflow" });
  assert.equal(blocked.changed, false);
  assert.equal(blocked.limitReached, true);
  assert.equal(blocked.state.selections.length, FANOUT_LIMIT);

  const removed = toggleFanoutPickerModel(state, a);
  assert.equal(removed.limitReached, false);
  assert.equal(removed.state.selections.length, FANOUT_LIMIT - 1);
  assert.equal(fanoutPickerCapacity(removed.state.selections).atLimit, false);
});

test("deduplication and a custom smaller limit keep capacity honest", () => {
  const deduped = toggleFanoutPickerModel(beginFanoutStacking(a), a);
  assert.equal(deduped.changed, true);
  assert.equal(deduped.state.mode, "single");

  const limited = toggleFanoutPickerModel(beginFanoutStacking(a), b, 2);
  assert.deepEqual(limited.state.selections, [a, b]);
  const blocked = toggleFanoutPickerModel(limited.state, c, 2);
  assert.equal(blocked.limitReached, true);
  assert.equal(blocked.changed, false);
});

test("row toggles reuse stacked options so the same model can be unchecked", () => {
  const configured: FanoutModelSelection = { providerInstanceId: "p", model: "a", modelOptions: [{ id: "reasoning", value: "high" }] };
  const state = toggleFanoutPickerModel(beginFanoutStacking(configured), b).state;
  assert.equal(fanoutPickerCandidate(state.selections, a, configured), state.selections[0]);
  assert.deepEqual(fanoutPickerCandidate(state.selections, a, configured), configured);
  assert.deepEqual(fanoutPickerCandidate([], a, configured), configured);
  assert.deepEqual(fanoutPickerCandidate([], b, configured), b);

  const removed = toggleFanoutPickerModel(state, fanoutPickerCandidate(state.selections, a, configured));
  assert.equal(removed.state.mode, "single");
  assert.deepEqual(removed.state.single, b);
});

test("unavailable or signed-out providers cannot join a stack", () => {
  assert.equal(fanoutModelAvailability(provider(), "a"), "available");
  assert.equal(fanoutModelAvailability(provider({ authStatus: "unknown" }), "a"), "available");
  assert.equal(fanoutModelAvailability(provider({ enabled: false }), "a"), "provider-disabled");
  assert.equal(fanoutModelAvailability(provider({ authStatus: "unauthenticated" }), "a"), "provider-unauthenticated");
  assert.equal(fanoutModelAvailability(provider({ authStatus: "not-installed" }), "a"), "provider-unauthenticated");
  assert.equal(fanoutModelAvailability(provider({ nativeSessionReady: false }), "a"), "provider-not-ready");
  assert.equal(fanoutModelAvailability(provider(), "missing"), "model-missing");
  assert.equal(fanoutModelAvailability(provider(), "b"), "model-disabled");
  assert.equal(fanoutModelAvailability(undefined, "a"), "provider-missing");
  assert.equal(fanoutModelAvailability(provider({ authStatus: "unauthenticated" }), "a"), "provider-unauthenticated");
});
