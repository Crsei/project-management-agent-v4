import assert from "node:assert/strict";
import test from "node:test";
import {
  dismissStorageKey,
  environmentStatusItem,
  generationStatusItem,
  providerAuthStatusItem,
  providerCatalogStatusItem,
  providerReadinessItem,
  providerStatusItem,
  readDismissed,
  rememberDismissed,
  sortStatusItems,
  visibleStatusItems,
} from "./chat-status-model.ts";

const english = (_zh: string, en: string) => en;
type GenerationInput = NonNullable<Parameters<typeof generationStatusItem>[0]>;
const failed = (overrides: Partial<GenerationInput> = {}) =>
  generationStatusItem({ id: "generation-1", status: "failed", error: "quota exceeded", errorClass: "usage_limit", ...overrides }, english);

test("generation banner carries the reported error class verbatim", () => {
  const item = failed();
  assert.equal(item?.code, "usage_limit");
  assert.equal(item?.message, "quota exceeded");
  assert.deepEqual(item?.actions, ["provider-settings"]);
  assert.equal(item?.category, "generation");
});

test("generation without an error class shows only the reported message", () => {
  const item = failed({ errorClass: undefined, error: "process exited" });
  assert.equal(item?.code, undefined);
  assert.equal(item?.message, "process exited");
  assert.deepEqual(item?.actions, []);
  const silent = failed({ errorClass: undefined, error: undefined });
  assert.equal(silent?.code, undefined);
  assert.equal(silent?.message, "No error details were reported.");
});

test("only failed generations become error banners", () => {
  assert.equal(failed({ status: "running" }), undefined);
  assert.equal(failed({ status: "completed" }), undefined);
  assert.equal(failed({ status: "interrupted" }), undefined);
  assert.equal(generationStatusItem(undefined, english), undefined);
});

test("unsupported generation errors point at session settings only", () => {
  assert.deepEqual(failed({ errorClass: "unsupported" })?.actions, ["session-settings"]);
});

test("provider issues keep their explicit configuration state", () => {
  assert.equal(providerStatusItem({ instanceId: "codex", name: "Codex", issue: "missing" }, english).tone, "error");
  assert.equal(providerStatusItem({ instanceId: "codex", name: "Codex", issue: "disabled" }, english).title, "Codex is disabled");
  assert.equal(providerStatusItem({ instanceId: "codex", name: "Codex", issue: "not-installed" }, english).title, "Codex is not installed");
  assert.equal(providerStatusItem({ instanceId: "codex", issue: "missing" }, english).title, "Provider configuration not found");
  assert.deepEqual(providerStatusItem({ instanceId: "codex", name: "Codex", issue: "missing" }, english).actions, ["provider-settings"]);
  const unselected = providerStatusItem({ instanceId: "", issue: "unselected" }, english);
  assert.equal(unselected.tone, "warning");
  assert.equal(unselected.title, "No model selected");
  assert.deepEqual(unselected.actions, ["session-settings"]);
  assert.equal(unselected.id, "provider:unselected");
});

test("provider auth banner needs a checked, not-ready runtime", () => {
  const input = { instanceId: "codex", name: "Codex", authStatus: "unauthenticated", nativeSessionReady: false };
  assert.equal(providerAuthStatusItem(input, english)?.tone, "warning");
  assert.deepEqual(providerAuthStatusItem(input, english)?.actions, ["provider-settings"]);
  assert.equal(providerAuthStatusItem({ ...input, authStatus: "unknown" }, english), undefined);
  assert.equal(providerAuthStatusItem({ ...input, authStatus: "authenticated" }, english), undefined);
  assert.equal(providerAuthStatusItem({ ...input, nativeSessionReady: true }, english), undefined);
});

test("a checked, not-ready provider becomes a top status notice with the probe error", () => {
  const item = providerReadinessItem(
    { instanceId: "codex", name: "Codex", nativeSessionReady: false, modelCount: 0, lastError: "workspace routing discovery timed out" },
    english,
  );
  assert.equal(item?.tone, "warning");
  assert.equal(item?.title, "Provider is unavailable");
  assert.match(item?.message ?? "", /Codex/);
  assert.match(item?.message ?? "", /workspace routing discovery timed out/);
  assert.deepEqual(item?.actions, ["provider-settings"]);
  assert.equal(providerReadinessItem({ instanceId: "codex", nativeSessionReady: true, modelCount: 2 }, english), undefined);
  assert.equal(providerReadinessItem({ instanceId: "codex", modelCount: 1 }, english), undefined);
  assert.equal(providerReadinessItem({ instanceId: "codex" }, english), undefined);
  assert.match(providerReadinessItem({ instanceId: "codex", nativeSessionReady: true, modelCount: 0 }, english)?.message ?? "", /no usable model catalog/i);
});

test("missing catalog and environment data stays hidden instead of guessed", () => {
  assert.equal(providerCatalogStatusItem(undefined, english), undefined);
  assert.equal(providerCatalogStatusItem("   ", english), undefined);
  assert.equal(environmentStatusItem(undefined, english), undefined);
  assert.equal(providerCatalogStatusItem("offline", english)?.actions.join(), "retry,provider-settings");
  assert.deepEqual(environmentStatusItem("missing folder", english)?.actions, ["retry"]);
});

test("errors sort before warnings and earlier categories first", () => {
  const items = [
    providerStatusItem({ instanceId: "a", name: "A", issue: "disabled" }, english),
    providerStatusItem({ instanceId: "b", name: "B", issue: "missing" }, english),
    environmentStatusItem("gone", english)!,
    failed()!,
  ];
  assert.deepEqual(sortStatusItems(items).map((item) => item.id), [
    "environment:gone",
    "generation:generation-1",
    "provider:b:missing",
    "provider:a:disabled",
  ]);
});

test("dismissals are stored per session and survive a reload", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
  assert.equal(readDismissed(storage, "thread-1").size, 0);
  rememberDismissed(storage, "thread-1", "provider:codex:missing");
  assert.deepEqual([...readDismissed(storage, "thread-1")], ["provider:codex:missing"]);
  assert.equal(readDismissed(storage, "thread-2").size, 0);
  assert.equal(readDismissed(storage, undefined).size, 0);
  assert.notEqual(dismissStorageKey("thread-1"), dismissStorageKey("thread-2"));
  assert.equal(dismissStorageKey(undefined), dismissStorageKey(undefined));
});

test("corrupted dismiss storage falls back to no dismissals", () => {
  const storage = { getItem: () => "{not-json" };
  assert.equal(readDismissed(storage, "thread-1").size, 0);
});

test("visible items exclude dismissed ids only", () => {
  const first = providerStatusItem({ instanceId: "a", name: "A", issue: "missing" }, english);
  const second = failed()!;
  assert.deepEqual(visibleStatusItems([first, second], new Set([first.id])).map((item) => item.id), [second.id]);
});
