import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { after, test, type TestContext } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RemoteSettings, RemoteThread } from "@agent-workspace/contracts/chat";

// Resolve the Web app's existing aliases without changing product imports for Node tests.
const agentRoot = new URL("../", import.meta.url).href;
const resolver = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@agent/")) {
      const relative = specifier.slice("@agent/".length);
      return nextResolve(new URL(`${relative}${relative.endsWith(".ts") ? "" : ".ts"}`, agentRoot).href, context);
    }
    if (context.parentURL?.startsWith(agentRoot) && specifier.startsWith(".") && !/\.[a-z]+$/u.test(specifier))
      return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.startsWith(agentRoot) || !url.endsWith(".ts")) return nextLoad(url, context);
    // Web runtime parameter properties need transformation, not Node's default strip-only mode.
    return {
      format: "module", shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform", sourceUrl: url }),
    };
  },
});
after(() => resolver.deregister());
// Module-loading boundary: a static import runs before the test-only alias resolver is registered.
const { acceptInitializedThread, acceptThreadSettings, flushThreadSettings, loadThreadSettings, useChatSettings } =
  await import("./use-chat-settings.ts");
const { acceptRemoteThread } = await import("../src/pm/state.ts");

function chatSettings(threadId?: string, initialize?: () => Promise<string>, draftId = "new") {
  const capture: { current?: {
    setSettings: (patch: Partial<RemoteSettings>) => Promise<void>;
    retry: () => Promise<void>;
  } } = {};
  function Probe() {
    capture.current = useChatSettings(threadId, initialize, draftId);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  assert.ok(capture.current);
  return capture.current;
}
const saveThreadSettings = (patch: Partial<RemoteSettings>, threadId?: string, initialize?: () => Promise<string>, draftId = "new") =>
  chatSettings(threadId, initialize, draftId).setSettings(patch);
const retryThreadSettings = (threadId?: string, initialize?: () => Promise<string>, draftId = "new") =>
  chatSettings(threadId, initialize, draftId).retry();

const originalSettings: RemoteSettings = {
  providerInstanceId: "original-provider", model: "original-model", systemPrompt: "Keep this instruction.",
  temperature: 0.3, modelOptions: [{ id: "old-only-option", value: true }], interactionMode: "plan",
};
function thread(id: string, settings = originalSettings, revision = 0): RemoteThread {
  return {
    remoteId: id, status: "regular", revision, settings: structuredClone(settings),
    executionSelection: { version: 2, agentWorkspaceId: null, agentWorkspaceRevision: null },
    createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
    sidebar: {
      revision: 0, pinnedAt: null, settledAt: null, snoozedAt: null, snoozedUntil: null,
      autoSettle: true, lastVisitedAt: null, unread: false, section: "active", running: false, canSnooze: false,
    },
  };
}
type Write = { revision: number; settings: RemoteSettings };
function sessionServer(t: TestContext, initial: RemoteThread) {
  const server = {
    thread: structuredClone(initial), reads: 0, writes: [] as Write[],
    onPut: undefined as ((write: Write) => Response | Promise<Response>) | undefined,
  };
  const original = globalThis.fetch;
  const apply = (write: Write) => {
    if (write.revision !== server.thread.revision)
      return Response.json({ error: "Settings revision conflict", code: "thread_conflict" }, { status: 409 });
    server.thread = { ...server.thread, settings: structuredClone(write.settings), revision: write.revision + 1 };
    return Response.json({ thread: server.thread });
  };
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), `/agent/api/chat/threads/${encodeURIComponent(initial.remoteId)}`);
    if (init?.method === "PUT") {
      const write = JSON.parse(String(init.body)) as Write;
      server.writes.push(write);
      return server.onPut ? server.onPut(write) : apply(write);
    }
    assert.equal(init?.method ?? "GET", "GET");
    server.reads++;
    return Response.json({ thread: server.thread });
  };
  t.after(() => { globalThis.fetch = original; });
  return { server, apply };
}

test("model changes use the revision hydrated after an execution-directory change and survive refresh", async t => {
  const initial = thread("directory-revision", originalSettings, 4);
  const { server } = sessionServer(t, initial);
  acceptThreadSettings(initial);
  server.thread = {
    ...initial, revision: 5,
    executionSelection: { version: 2, agentWorkspaceId: "explicit-folder", agentWorkspaceRevision: 2 },
  };
  acceptRemoteThread(server.thread);
  const patch = { providerInstanceId: "chosen-provider", model: "chosen-model", modelOptions: [{ id: "effort", value: "xhigh" }] };
  await saveThreadSettings(patch, initial.remoteId);
  assert.deepEqual(server.writes, [{ revision: 5, settings: { ...originalSettings, ...patch } }]);
  assert.equal(server.reads, 0, "Use the accepted folder-save revision without an extra fetch");
  await loadThreadSettings(initial.remoteId, true);
  const saved = await flushThreadSettings(initial.remoteId);
  assert.equal(saved.revision, 6);
  assert.equal(saved.ready, true);
  assert.deepEqual(saved.settings, { ...originalSettings, ...patch });
});

test("an out-of-order accepted PM snapshot cannot roll settings back to an older revision or model", async t => {
  const initial = thread("accepted-snapshot-order", originalSettings, 6);
  const { server } = sessionServer(t, initial);
  acceptThreadSettings(initial);
  acceptRemoteThread({
    ...initial, revision: 5,
    settings: { ...initial.settings, providerInstanceId: "stale-default", model: "stale-model", modelOptions: [] },
  });
  await saveThreadSettings({ systemPrompt: "Explicit updated instruction" }, initial.remoteId);
  assert.deepEqual(server.writes, [{
    revision: 6, settings: { ...originalSettings, systemPrompt: "Explicit updated instruction" },
  }]);
  assert.equal(server.reads, 0);
  assert.equal((await flushThreadSettings(initial.remoteId)).ready, true);
});

test("switching provider/model discards incompatible previous-model options, never choosing a fallback", async t => {
  const initial = thread("different-capabilities");
  const { server } = sessionServer(t, initial);
  acceptThreadSettings(initial);
  await saveThreadSettings({ providerInstanceId: "explicit-provider", model: "explicit-model" }, initial.remoteId);
  assert.deepEqual(server.thread.settings, {
    ...originalSettings, providerInstanceId: "explicit-provider", model: "explicit-model", modelOptions: [],
  });
  assert.equal((await flushThreadSettings(initial.remoteId)).pendingPatch, undefined);
});

test("new-session initialization is single-flight and its defaults cannot overwrite the explicit selection", async t => {
  const draftId = "new-selection-draft";
  const initial = thread("new-selection-remote", {
    providerInstanceId: "global-default", model: "default-model", systemPrompt: "", temperature: 1,
    modelOptions: [{ id: "default-only", value: true }],
  });
  const { server } = sessionServer(t, initial);
  const release = Promise.withResolvers<void>();
  let creations = 0;
  const initialize = async () => {
    creations++;
    await release.promise;
    acceptInitializedThread(draftId, initial);
    return initial.remoteId;
  };
  const first = saveThreadSettings({ providerInstanceId: "first-choice", model: "first-model" }, undefined, initialize, draftId);
  const last = saveThreadSettings({
    providerInstanceId: "final-choice", model: "final-model", modelOptions: [{ id: "effort", value: "xhigh" }],
  }, undefined, initialize, draftId);
  release.resolve();
  await Promise.all([first, last]);
  assert.equal(creations, 1);
  assert.equal(server.writes.length, 1);
  assert.deepEqual(server.thread.settings, {
    providerInstanceId: "final-choice", model: "final-model", systemPrompt: "", temperature: 1,
    modelOptions: [{ id: "effort", value: "xhigh" }],
  });
  await loadThreadSettings(initial.remoteId, true);
  assert.deepEqual((await flushThreadSettings(initial.remoteId)).settings, server.thread.settings);
});

test("an edit made while saving is not cleared by the earlier acknowledgement", async t => {
  const initial = thread("pending-edit");
  const { server, apply } = sessionServer(t, initial);
  acceptThreadSettings(initial);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  server.onPut = async write => {
    if (server.writes.length === 1) { entered.resolve(); await release.promise; }
    return apply(write);
  };
  const first = saveThreadSettings({ systemPrompt: "first instruction" }, initial.remoteId);
  await entered.promise;
  const second = saveThreadSettings({
    providerInstanceId: "new-provider", model: "new-model", systemPrompt: "latest instruction",
    modelOptions: [{ id: "effort", value: "high" }],
  }, initial.remoteId);
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(server.writes.map(write => write.revision), [0, 1]);
  assert.deepEqual(server.thread.settings, {
    ...originalSettings, providerInstanceId: "new-provider", model: "new-model", systemPrompt: "latest instruction",
    modelOptions: [{ id: "effort", value: "high" }],
  });
  assert.equal((await flushThreadSettings(initial.remoteId)).pendingPatch, undefined);
});

test("a real revision failure remains visible and explicit retry rebases only the retained draft fields", async t => {
  const initial = thread("revision-retry", originalSettings, 2);
  const { server } = sessionServer(t, initial);
  acceptThreadSettings(initial);
  acceptRemoteThread(initial);
  server.thread = { ...initial, revision: 3, settings: { ...initial.settings, systemPrompt: "Changed in another window" } };
  const patch = { providerInstanceId: "retained-provider", model: "retained-model", modelOptions: [{ id: "effort", value: "xhigh" }] };
  await assert.rejects(saveThreadSettings(patch, initial.remoteId), /Settings revision conflict/);
  await assert.rejects(flushThreadSettings(initial.remoteId), /Settings revision conflict/);
  assert.equal(server.writes.length, 1, "No automatic replay after conflict");
  assert.equal(server.reads, 0, "An unseen revision change must remain a real conflict, not an implicit refresh");
  await retryThreadSettings(initial.remoteId);
  assert.equal(server.reads, 1);
  assert.deepEqual(server.writes[1], {
    revision: 3, settings: { ...originalSettings, systemPrompt: "Changed in another window", ...patch },
  });
  assert.equal((await flushThreadSettings(initial.remoteId)).ready, true);
});

test("explicit dialog resubmission reloads a failed revision while preserving all edited fields", async t => {
  const initial = thread("dialog-resubmit", originalSettings, 7);
  const { server } = sessionServer(t, initial);
  acceptThreadSettings(initial);
  server.thread = { ...initial, revision: 8 };
  const draft = {
    ...originalSettings, providerInstanceId: "dialog-provider", model: "dialog-model", systemPrompt: "Unsaved dialog instruction",
    modelOptions: [{ id: "variant", value: "high" }], dictation: true, speak: false,
  };
  await assert.rejects(saveThreadSettings(draft, initial.remoteId), /Settings revision conflict/);
  await saveThreadSettings(draft, initial.remoteId);
  const remote = {
    ...originalSettings, providerInstanceId: "dialog-provider", model: "dialog-model", systemPrompt: "Unsaved dialog instruction",
    modelOptions: [{ id: "variant", value: "high" }],
  };
  assert.equal(server.reads, 1);
  assert.deepEqual(server.writes[1], { revision: 8, settings: remote });
  assert.equal((await flushThreadSettings(initial.remoteId)).ready, true);
});

test("failed first-session creation retains the chosen model/options until explicit retry", async t => {
  const draftId = "creation-retry-draft";
  const initial = thread("creation-retry-remote", { providerInstanceId: "", model: "", systemPrompt: "", temperature: 1 });
  const { server } = sessionServer(t, initial);
  let creations = 0;
  const initialize = async () => {
    if (++creations === 1) throw new Error("Private scratch is unavailable");
    acceptInitializedThread(draftId, initial);
    return initial.remoteId;
  };
  const chosen = { providerInstanceId: "chosen-provider", model: "chosen-model", modelOptions: [{ id: "effort", value: "xhigh" }] };
  await assert.rejects(saveThreadSettings(chosen, undefined, initialize, draftId), /Private scratch is unavailable/);
  assert.equal(creations, 1);
  assert.equal(server.writes.length, 0);
  await retryThreadSettings(undefined, initialize, draftId);
  assert.equal(creations, 2);
  assert.deepEqual(server.thread.settings, { ...initial.settings, ...chosen });
  assert.equal((await flushThreadSettings(initial.remoteId)).ready, true);
});
