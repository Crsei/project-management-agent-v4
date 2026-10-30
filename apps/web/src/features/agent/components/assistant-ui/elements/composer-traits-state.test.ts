import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderModel, ProviderOptionSelection } from "@agent-workspace/contracts/provider";
import { getProviderModelTraits, ULTRATHINK_PROMPT_PREFIX } from "@agent-workspace/client-runtime/providers";
import { getComposerTraitChange } from "./composer-traits-state.ts";

const model: ProviderModel = {
  id: "native-model", label: "Native model", temperature: false,
  capabilities: { optionDescriptors: [
    { id: "effort", label: "Reasoning", type: "select", currentValue: "high", promptInjectedValues: ["ultrathink"], options: [
      { id: "high", label: "High", isDefault: true }, { id: "max", label: "Max" }, { id: "ultrathink", label: "Ultrathink" },
    ] },
    { id: "serviceTier", label: "Speed", type: "select", currentValue: "default", options: [{ id: "default", label: "Normal", isDefault: true }, { id: "fast", label: "Fast" }] },
    { id: "fastMode", label: "Fast mode", type: "boolean", currentValue: false },
  ] },
};
const change = (prompt: string, value: string | boolean, selections?: readonly ProviderOptionSelection[], id = "effort") =>
  getComposerTraitChange({ driver: "claude", model, prompt, value, selections, id });

test("editing one native trait retains unrelated invalid and explicit options without materializing defaults", () => {
  const selections: readonly ProviderOptionSelection[] = Object.freeze([
    Object.freeze({ id: "removed", value: "still-visible" }),
    Object.freeze({ id: "effort", value: "removed-level" }),
    Object.freeze({ id: "effort", value: "high" }),
    Object.freeze({ id: "fastMode", value: true }),
  ]);
  const result = change("hello", "max", selections);
  assert.deepEqual(result, { prompt: "hello", modelOptions: [
    { id: "removed", value: "still-visible" }, { id: "fastMode", value: true }, { id: "effort", value: "max" },
  ] });
  assert.equal(selections.length, 4);
  assert.deepEqual(getProviderModelTraits({ driver: "claude", model, options: result?.modelOptions }).invalidOptions, [{ id: "removed", value: "still-visible" }]);
  assert.deepEqual(change("hello", false, result?.modelOptions, "fastMode")?.modelOptions, [
    { id: "removed", value: "still-visible" }, { id: "effort", value: "max" }, { id: "fastMode", value: false },
  ]);
});

test("prompt-injected effort edits the actual prompt rather than saving an ultrathink option", () => {
  const selections = [{ id: "effort", value: "max" }, { id: "serviceTier", value: "fast" }];
  assert.deepEqual(change("hello", "ultrathink", selections), { prompt: `${ULTRATHINK_PROMPT_PREFIX}hello` });
  assert.deepEqual(change("", "ultrathink", selections), { prompt: ULTRATHINK_PROMPT_PREFIX });
  assert.deepEqual(change("/help", "ultrathink", selections), { prompt: "/help" });
  assert.deepEqual(selections, [{ id: "effort", value: "max" }, { id: "serviceTier", value: "fast" }]);
});

test("leaving prefix-controlled effort removes only the native prefix and keeps explicit options", () => {
  assert.deepEqual(change(`${ULTRATHINK_PROMPT_PREFIX}hello`, "high", [{ id: "serviceTier", value: "fast" }]), {
    prompt: "hello", modelOptions: [{ id: "serviceTier", value: "fast" }, { id: "effort", value: "high" }],
  });
  assert.equal(change("Please ultrathink about this", "high"), null);
  assert.equal(change(`${ULTRATHINK_PROMPT_PREFIX}Please ultrathink about this`, "high"), null);
});

test("unknown traits and invalid native choices never produce a patch", () => {
  assert.equal(change("hello", "invented"), null);
  assert.equal(change("hello", true), null);
  assert.equal(change("hello", "true", [], "fastMode"), null);
  assert.equal(change("hello", "high", [], "removed"), null);
});
