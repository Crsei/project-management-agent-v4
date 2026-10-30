import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteSettings } from "@agent-workspace/contracts/chat";
import { pendingRemoteSettings } from "./remote-settings-patch.ts";

const keys = new Set(["providerInstanceId", "model", "systemPrompt", "temperature", "modelOptions", "interactionMode"]);
const saved: RemoteSettings = { providerInstanceId: "controlled", model: "model", systemPrompt: "", temperature: 1, modelOptions: [] };

test("saving a session dialog with local voice preferences clears the completed remote patch", () => {
  // The former dialog spread a ChatSettings value containing these local-only fields.
  const dialogValue = { ...saved, dictation: false, speak: false };
  assert.deepEqual(pendingRemoteSettings(dialogValue, keys), saved);
  assert.equal(pendingRemoteSettings(dialogValue, keys, saved), undefined);
  // Hydrating the same thread after a handoff also removes already-stuck voice keys.
  assert.equal(pendingRemoteSettings({ dictation: false, speak: false } as unknown as Partial<RemoteSettings>, keys), undefined);
});

test("a remote edit made during an in-flight save is retained", () => {
  const pending = { ...saved, systemPrompt: "newer draft", dictation: true };
  assert.deepEqual(pendingRemoteSettings(pending, keys, saved), { systemPrompt: "newer draft" });
});
