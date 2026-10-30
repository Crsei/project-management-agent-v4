import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Hono } from "hono";
import type { RemoteThread } from "@agent-workspace/contracts/chat";
import type { ChatDefaultsResponse } from "@agent-workspace/contracts/settings";
import { chatRoutes } from "../chat.ts";
import { closeStore, writeRecord } from "../durable/store.ts";
import { ensureThread, forkThreadHistory, getThread, importThreads, listThreads } from "../durable/threads.ts";
import { createProviderInstance, deleteProviderInstance, getStoredInstance, updateProviderInstance } from "../providers/instances.ts";
import { getNativeProviderAdapter } from "../providers/driver-registry.ts";
import { resolveProviderRuntime } from "../providers/runtime.ts";
import { getChatDefaults, readChatDefaults, saveChatDefaults } from "./chat-defaults.ts";
import { settingsRoutes } from "./routes.ts";

let directory: string;
const originalDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
const app = new Hono().route("/api", settingsRoutes).route("/api", chatRoutes);
const adapter = getNativeProviderAdapter("codex")!;
const originalCheck = adapter.check;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agent-chat-defaults-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  adapter.check = async () => ({ installation: { status: "installed" }, authentication: "authenticated", nativeSessionReady: true, models: [], methods: [], canLogout: false });
  createProviderInstance({ instanceId: "only-codex", driver: "codex", label: "Controlled native catalog", customModels: [{ id: "native-fixture-a", label: "A" }, { id: "native-fixture-b", label: "B" }] });
  for (const id of ["codex", "claude"]) deleteProviderInstance(id);
});
afterEach(async () => {
  closeStore();
  adapter.check = originalCheck;
  if (originalDirectory === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR;
  else process.env.AGENT_WORKSPACE_DATA_DIR = originalDirectory;
  await rm(directory, { recursive: true, force: true });
});
const pair = { providerInstanceId: "only-codex", model: "native-fixture-a" };
async function put(path: string, body: unknown): Promise<Response> {
  return app.request(`http://localhost/api${path}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("unset defaults never auto-select the sole native provider or create a thread", async () => {
  const response = await app.request("http://localhost/api/settings/chat-defaults");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { defaults: { revision: 0, selection: null }, availability: { status: "unset" } });
  assert.equal(listThreads().length, 0);
  ensureThread("unselected");
  assert.deepEqual(getThread("unselected")!.settings, { providerInstanceId: "", model: "", systemPrompt: "", temperature: 1 });
  assert.equal(getThread("unselected")!.defaultsRevision, 0);
});

test("explicit native defaults survive SQLite reopen and snapshot only newly created threads", async () => {
  ensureThread("before-default");
  const first = await put("/settings/chat-defaults", { revision: 0, selection: pair });
  assert.equal(first.status, 200);
  assert.deepEqual((await first.json() as ChatDefaultsResponse).defaults, { revision: 1, selection: pair });
  const created = await app.request("http://localhost/api/chat/threads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "first" }) });
  assert.equal(created.status, 200);
  const publicFirst = (await created.json() as { thread: RemoteThread }).thread;
  assert.deepEqual(publicFirst.settings, { ...pair, systemPrompt: "", temperature: 1 });
  assert.equal(publicFirst.defaultsRevision, 1);
  assert.deepEqual(publicFirst.settings, getThread("first")!.settings);
  await saveChatDefaults({ revision: 1, selection: { ...pair, model: "native-fixture-b" } });
  ensureThread("second");
  forkThreadHistory("first", "fork");
  const snapshot = getThread("first");
  closeStore();
  assert.deepEqual(readChatDefaults(), { revision: 2, selection: { ...pair, model: "native-fixture-b" } });
  assert.deepEqual(getThread("first"), snapshot);
  assert.equal(getThread("first")!.settings.model, pair.model);
  assert.equal(getThread("first")!.defaultsRevision, 1);
  assert.equal(getThread("second")!.settings.model, "native-fixture-b");
  assert.equal(getThread("second")!.defaultsRevision, 2);
  assert.equal(getThread("before-default")!.settings.model, "");
  assert.equal(getThread("fork")!.defaultsRevision, 1);
  assert.deepEqual(getThread("fork")!.settings, snapshot!.settings);
});

test("model options and interaction mode persist in defaults and thread snapshots with revision validation", async () => {
  updateProviderInstance(pair.providerInstanceId, { customModels: [{
    id: pair.model, label: "A",
    capabilities: { optionDescriptors: [{ id: "effort", label: "Effort", type: "select",
      options: [{ id: "high", label: "High" }, { id: "xhigh", label: "Extra high" }] }] },
  }] });
  const selection = { ...pair, modelOptions: [{ id: "effort", value: "xhigh" }], interactionMode: "plan" as const };
  await saveChatDefaults({ revision: 0, selection });
  ensureThread("options-default");
  closeStore();
  assert.deepEqual(readChatDefaults().selection, selection);
  assert.deepEqual(getThread("options-default")!.settings, { ...selection, systemPrompt: "", temperature: 1 });
  await assert.rejects(saveChatDefaults({ revision: 1, selection: {
    ...selection, modelOptions: [{ id: "effort", value: "unknown" }],
  } }), { status: 400 });
  assert.deepEqual(readChatDefaults(), { revision: 1, selection });
});

test("default validation and compare-and-swap never replace saved selection on failure", async () => {
  await saveChatDefaults({ revision: 0, selection: pair });
  const stale = await put("/settings/chat-defaults", { revision: 0, selection: null });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json() as { code: string }).code, "chat_defaults_conflict");
  for (const selection of [{ providerInstanceId: "missing-provider", model: pair.model }, { ...pair, model: "not-registered" }, { providerInstanceId: "", model: "" }]) {
    const invalid = await put("/settings/chat-defaults", { revision: 1, selection });
    assert.equal(invalid.status, 400);
    assert.deepEqual(readChatDefaults(), { revision: 1, selection: pair });
  }
  await saveChatDefaults({ revision: 1, selection: null });
  ensureThread("after-clear");
  assert.equal((await getChatDefaults()).availability.status, "unset");
  assert.equal(getThread("after-clear")!.settings.providerInstanceId, "");
  assert.equal(getThread("after-clear")!.defaultsRevision, 2);
});

test("disabled/deleted providers and removed custom models remain unavailable without fallback", async () => {
  const originalModels = getStoredInstance(pair.providerInstanceId)!.customModels!;
  updateProviderInstance(pair.providerInstanceId, { customModels: [...originalModels, { id: "removed-custom", label: "Custom" }] });
  await saveChatDefaults({ revision: 0, selection: { ...pair, model: "removed-custom" } });
  ensureThread("custom-history");
  updateProviderInstance(pair.providerInstanceId, { customModels: originalModels });
  assert.equal((await getChatDefaults()).availability.status, "unavailable");
  assert.equal(readChatDefaults().selection!.model, "removed-custom");
  assert.equal(getThread("custom-history")!.settings.model, "removed-custom");
  await assert.rejects(resolveProviderRuntime({ providerInstanceId: pair.providerInstanceId, modelName: "removed-custom" }), { code: "invalid_model" });
  await saveChatDefaults({ revision: 1, selection: pair });
  updateProviderInstance(pair.providerInstanceId, { enabled: false });
  assert.equal((await getChatDefaults()).availability.status, "unavailable");
  await assert.rejects(saveChatDefaults({ revision: 2, selection: pair }), { code: "disabled_provider" });
  deleteProviderInstance(pair.providerInstanceId);
  const defaults = await getChatDefaults();
  assert.equal(defaults.availability.status, "unavailable");
  assert.deepEqual(defaults.defaults.selection, pair);
  ensureThread("deleted-default");
  assert.deepEqual(getThread("deleted-default")!.settings, { ...pair, systemPrompt: "", temperature: 1 });
  await assert.rejects(resolveProviderRuntime({ providerInstanceId: pair.providerInstanceId, modelName: pair.model }), { code: "unknown_provider" });
});

test("a cold dynamic native catalog is checked before marking persisted defaults unavailable", async () => {
  const dynamic = { ...pair, model: "discovered-after-restart" };
  writeRecord("settings:chat-defaults", "default", { revision: 7, selection: dynamic });
  let checks = 0;
  adapter.check = async () => { checks++; return { installation: { status: "installed" }, authentication: "authenticated", nativeSessionReady: true, models: [{ id: dynamic.model, label: "Discovered", temperature: false }], methods: [], canLogout: false }; };
  const before = await readFile(join(directory, "provider-instances.json"), "utf8");
  assert.equal((await getChatDefaults()).availability.status, "available");
  assert.ok(checks > 0);
  assert.deepEqual(readChatDefaults(), { revision: 7, selection: dynamic });
  assert.equal(await readFile(join(directory, "provider-instances.json"), "utf8"), before);
  assert.equal((await saveChatDefaults({ revision: 7, selection: dynamic })).availability.status, "available");
});

test("async native discovery cannot save over changed Provider configuration or defaults revisions", async () => {
  await saveChatDefaults({ revision: 0, selection: pair });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  adapter.check = async () => {
    entered.resolve();
    await release.promise;
    return { installation: { status: "installed" }, authentication: "authenticated", nativeSessionReady: true,
      models: [{ id: "race-discovered-model", label: "Race", temperature: false }], methods: [], canLogout: false };
  };
  const pending = saveChatDefaults({ revision: 1, selection: { ...pair, model: "race-discovered-model" } });
  const rejected = assert.rejects(pending, { status: 409, code: "provider_changed" });
  await entered.promise;
  updateProviderInstance(pair.providerInstanceId, { label: "Changed during native check" });
  release.resolve();
  await rejected;
  assert.deepEqual(readChatDefaults(), { revision: 1, selection: pair });
  const enteredAgain = Promise.withResolvers<void>();
  const releaseAgain = Promise.withResolvers<void>();
  adapter.check = async () => {
    enteredAgain.resolve();
    await releaseAgain.promise;
    return { installation: { status: "installed" }, authentication: "authenticated", nativeSessionReady: true,
      models: [{ id: "defaults-race-model", label: "Race", temperature: false }], methods: [], canLogout: false };
  };
  const defaultsPending = saveChatDefaults({ revision: 1, selection: { ...pair, model: "defaults-race-model" } });
  const defaultsRejected = assert.rejects(defaultsPending, { status: 409, code: "chat_defaults_conflict" });
  await enteredAgain.promise;
  await saveChatDefaults({ revision: 1, selection: null });
  releaseAgain.resolve();
  await defaultsRejected;
  assert.deepEqual(readChatDefaults(), { revision: 2, selection: null });
});

test("obsolete saved defaults remain exact readable history but cannot be saved or executed", async () => {
  const target = join(directory, "provider-instances.json");
  const config = JSON.parse(await readFile(target, "utf8"));
  config.instances.push({ instanceId: "old-api", driver: "openai", label: "Historical", revision: 99, env: { OLD_KEY: "offline-secret" }, baseUrl: "http://127.0.0.1:1/never-contact" });
  const bytes = JSON.stringify(config);
  await writeFile(target, bytes);
  const legacy = { providerInstanceId: "old-api", model: "historical-model" };
  writeRecord("settings:chat-defaults", "default", { revision: 4, selection: legacy });
  assert.equal((await getChatDefaults()).availability.status, "unavailable");
  assert.deepEqual(readChatDefaults(), { revision: 4, selection: legacy });
  ensureThread("historical-default");
  assert.deepEqual(getThread("historical-default")!.settings, { ...legacy, systemPrompt: "", temperature: 1 });
  await assert.rejects(saveChatDefaults({ revision: 4, selection: legacy }), { code: "unknown_provider" });
  await assert.rejects(resolveProviderRuntime({ providerInstanceId: legacy.providerInstanceId, modelName: legacy.model }), { code: "unknown_provider" });
  assert.equal(await readFile(target, "utf8"), bytes);
});

test("session settings update provider/model atomically and reject stale or invalid pairs", async () => {
  ensureThread("session");
  const initial = getThread("session")!;
  const selected = { ...pair, systemPrompt: "Keep the saved instruction.", temperature: 0.3 };
  const saved = await put("/chat/threads/session", { revision: initial.revision, settings: selected });
  assert.equal(saved.status, 200);
  const publicSaved = (await saved.json() as { thread: RemoteThread }).thread;
  assert.deepEqual(publicSaved.settings, selected);
  assert.equal(publicSaved.revision, initial.revision + 1);
  const invalid = await put("/chat/threads/session", { revision: publicSaved.revision, settings: { ...selected, model: "not-registered" } });
  assert.equal(invalid.status, 400);
  assert.deepEqual(getThread("session")!.settings, selected);
  assert.equal(getThread("session")!.revision, publicSaved.revision);
  const stale = await put("/chat/threads/session", { revision: initial.revision, settings: { ...selected, model: "native-fixture-b" } });
  assert.equal(stale.status, 409);
  assert.deepEqual(getThread("session")!.settings, selected);
});

test("imported legacy history never acquires today's defaults or rewrites an existing thread", async () => {
  await saveChatDefaults({ revision: 0, selection: pair });
  importThreads("legacy-import", [{ remoteId: "legacy" }]);
  assert.equal(getThread("legacy")!.settings.model, "");
  assert.equal(getThread("legacy")!.defaultsRevision, undefined);
  const original = getThread("legacy");
  await saveChatDefaults({ revision: 1, selection: { ...pair, model: "native-fixture-b" } });
  ensureThread("legacy");
  assert.deepEqual(getThread("legacy"), original);
});

test("corrupt persisted defaults fail closed without restoring a built-in selection", () => {
  writeRecord("settings:chat-defaults", "default", { revision: 5, selection: { model: "bad" } });
  assert.throws(() => ensureThread("must-not-create"), { code: "invalid_chat_defaults" });
  assert.equal(getThread("must-not-create"), null);
});
