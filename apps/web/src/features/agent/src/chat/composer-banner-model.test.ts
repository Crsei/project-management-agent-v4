import assert from "node:assert/strict";
import test from "node:test";
import type { NativeOutputItem } from "@agent-workspace/contracts/output";
import {
  COMPOSER_BANNER_STORAGE_PREFIX,
  classifyReadiness,
  compareApiVersion,
  parseRuntimeInfo,
  summarizeTodoProgress,
  composerBannerDismissToken,
  composerBannerStorageKey,
  dismissComposerBanner,
  readDismissedBanners,
  sortComposerBanners,
  splitBannerPeek,
  visibleComposerBanners,
  writeDismissedBanners,
  type ComposerBannerModel,
} from "./composer-banner-model.ts";

const banner = (overrides: Partial<ComposerBannerModel> & Pick<ComposerBannerModel, "id" | "kind">): ComposerBannerModel => ({
  severity: "warning",
  dismissible: true,
  ...overrides,
});

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

test("emergency errors sort above warnings and informational banners", () => {
  const sorted = sortComposerBanners([
    banner({ id: "plan", kind: "plan", severity: "info" }),
    banner({ id: "usage", kind: "usage" }),
    banner({ id: "save", kind: "save", severity: "alert" }),
    banner({ id: "offline", kind: "offline", severity: "alert", dismissible: false }),
  ]);
  assert.deepEqual(sorted.map(item => item.kind), ["offline", "save", "usage", "plan"]);
});

test("equal ranks stay deterministic", () => {
  const sorted = sortComposerBanners([
    banner({ id: "b", kind: "provider", severity: "alert" }),
    banner({ id: "a", kind: "provider", severity: "alert" }),
  ]);
  assert.deepEqual(sorted.map(item => item.id), ["a", "b"]);
});

test("dismissal tokens separate banners and their data signatures", () => {
  assert.equal(composerBannerDismissToken({ id: "save", signature: "message-a" }), "save|message-a");
  assert.notEqual(
    composerBannerDismissToken({ id: "save", signature: "message-a" }),
    composerBannerDismissToken({ id: "save", signature: "message-b" }),
  );
  assert.equal(composerBannerStorageKey("thread-1"), `${COMPOSER_BANNER_STORAGE_PREFIX}thread-1`);
});

test("non-dismissible banners are never removed", () => {
  const offline = banner({ id: "offline", kind: "offline", dismissible: false });
  const next = dismissComposerBanner([offline], new Set(), offline);
  assert.equal(next.size, 0);
  assert.equal(visibleComposerBanners([offline], next).length, 1);
});

test("dismissals survive a storage round trip and clear when empty", () => {
  const storage = memoryStorage();
  const first = banner({ id: "provider", kind: "provider", severity: "alert", signature: "catalog failed" });
  const dismissed = dismissComposerBanner([first], readDismissedBanners(storage, "t1"), first);
  writeDismissedBanners(storage, "t1", dismissed);
  assert.equal(visibleComposerBanners([first], readDismissedBanners(storage, "t1")).length, 0);
  // A different error under the same kind is not hidden by the old dismissal.
  const second = banner({ id: "provider", kind: "provider", severity: "alert", signature: "other failure" });
  assert.equal(visibleComposerBanners([second], readDismissedBanners(storage, "t1")).length, 1);
  writeDismissedBanners(storage, "t1", new Set());
  assert.equal(storage.data.has(composerBannerStorageKey("t1")), false);
});

test("corrupt storage is treated as no dismissal", () => {
  const storage = memoryStorage();
  storage.setItem(composerBannerStorageKey("t1"), "{not json");
  assert.equal(readDismissedBanners(storage, "t1").size, 0);
  storage.setItem(composerBannerStorageKey("t1"), JSON.stringify([1, "save|x", null]));
  assert.deepEqual([...readDismissedBanners(storage, "t1")], ["save|x"]);
});

test("peek keeps one primary banner and hides the rest", () => {
  const visible = visibleComposerBanners(
    [
      banner({ id: "save", kind: "save", severity: "alert" }),
      banner({ id: "queue", kind: "queue" }),
    ],
    new Set(),
  );
  const peek = splitBannerPeek(visible);
  assert.equal(peek.primary?.kind, "save");
  assert.deepEqual(peek.hidden.map(item => item.kind), ["queue"]);
  assert.equal(splitBannerPeek([]).primary, undefined);
});

test("a newer alert kind still sorts behind stream errors but above warnings", () => {
  const sorted = sortComposerBanners([
    banner({ id: "plan", kind: "plan", severity: "info" }),
    banner({ id: "progress", kind: "progress", severity: "info" }),
    banner({ id: "sync", kind: "sync", severity: "warning" }),
    banner({ id: "runtime", kind: "runtime", severity: "alert" }),
    banner({ id: "stream", kind: "stream", severity: "alert", dismissible: false }),
  ]);
  assert.deepEqual(sorted.map(item => item.kind), ["stream", "runtime", "sync", "progress", "plan"]);
});

test("runtime info parsing rejects anything without a usable version", () => {
  assert.deepEqual(parseRuntimeInfo({ apiVersion: " 2026-11-18.1 " }), { apiVersion: "2026-11-18.1" });
  assert.deepEqual(parseRuntimeInfo({ apiVersion: "v1", buildMode: "production" }), { apiVersion: "v1", buildMode: "production" });
  assert.equal(parseRuntimeInfo(null), undefined);
  assert.equal(parseRuntimeInfo([]), undefined);
  assert.equal(parseRuntimeInfo({ apiVersion: 1 }), undefined);
  assert.equal(parseRuntimeInfo({ apiVersion: "   " }), undefined);
  assert.equal(parseRuntimeInfo({ apiVersion: "v1", buildMode: 7 }), undefined);
  assert.equal(parseRuntimeInfo({ apiVersion: "x".repeat(65) }), undefined);
});

test("version comparison reports only observed differences", () => {
  assert.deepEqual(compareApiVersion("v2", { status: "ok", apiVersion: "v2" }), { state: "match" });
  assert.deepEqual(compareApiVersion("v2", { status: "ok", apiVersion: "v1", buildMode: "production" }), {
    state: "mismatch", local: "v2", remote: "v1", buildMode: "production",
  });
  // An absent endpoint is a server build without the runtime contract.
  assert.deepEqual(compareApiVersion("v2", { status: "missing" }), { state: "mismatch", local: "v2" });
  // Transport or authorization failures stay unknown: no banner is displayed.
  assert.deepEqual(compareApiVersion("v2", { status: "error" }), { state: "unknown" });
});

test("readiness classifies only the two signals the UI can state honestly", () => {
  assert.deepEqual(classifyReadiness({ status: "ready", checks: { worker: true, quarantinedEvents: 0 } }), { kind: "healthy" });
  assert.deepEqual(classifyReadiness({ status: "not_ready", checks: { worker: false, quarantinedEvents: 0 } }), {
    kind: "degraded", workerOffline: true, quarantinedEvents: 0,
  });
  assert.deepEqual(classifyReadiness({ status: "not_ready", checks: { worker: true, quarantinedEvents: 3 } }), {
    kind: "degraded", workerOffline: false, quarantinedEvents: 3,
  });
  assert.deepEqual(classifyReadiness({ checks: { worker: false, quarantinedEvents: 2 } }), {
    kind: "degraded", workerOffline: true, quarantinedEvents: 2,
  });
  assert.deepEqual(classifyReadiness({ status: "not_ready", reason: "backend_not_initialized" }), { kind: "unreadable" });
  assert.deepEqual(classifyReadiness({ checks: { worker: true } }), { kind: "unreadable" });
  assert.deepEqual(classifyReadiness({ checks: { worker: "yes", quarantinedEvents: 0 } }), { kind: "unreadable" });
  assert.deepEqual(classifyReadiness({ checks: { worker: true, quarantinedEvents: -1 } }), { kind: "unreadable" });
  assert.deepEqual(classifyReadiness("not json"), { kind: "unreadable" });
  assert.deepEqual(classifyReadiness(undefined), { kind: "unreadable" });
});

const outputItem = (overrides: Partial<NativeOutputItem> & Pick<NativeOutputItem, "id" | "type">): NativeOutputItem => ({
  status: "completed",
  ...overrides,
});

test("todo progress only exists while the generation is running", () => {
  const items = [outputItem({
    id: "todo-1",
    type: "todo_list",
    steps: [
      { id: "s1", text: "Read the code", status: "completed" },
      { id: "s2", text: "Write the change", status: "running" },
      { id: "s3", text: "Verify", status: "pending" },
    ],
  })];
  assert.deepEqual(summarizeTodoProgress({ status: "running", items }), {
    itemId: "todo-1",
    completed: 1,
    total: 3,
    running: [{ id: "s2", text: "Write the change" }],
  });
  assert.equal(summarizeTodoProgress({ status: "completed", items }), undefined);
  assert.equal(summarizeTodoProgress({ status: "running", items: [] }), undefined);
  assert.equal(summarizeTodoProgress(undefined), undefined);
  assert.equal(summarizeTodoProgress({ status: "running", items: [outputItem({ id: "todo-2", type: "todo_list", steps: [] })] }), undefined);
  assert.equal(
    summarizeTodoProgress({ status: "running", items: [outputItem({ id: "todo-3", type: "todo_list", visibility: "redacted", steps: [{ id: "s1", text: "hidden", status: "running" }] })] }),
    undefined,
  );
});

test("the latest cumulative todo list wins and cancelled steps stay incomplete", () => {
  const progress = summarizeTodoProgress({
    status: "running",
    items: [
      outputItem({ id: "todo-old", type: "todo_list", steps: [{ id: "a", text: "old", status: "completed" }] }),
      outputItem({ id: "noise", type: "assistant_message", text: "still working" }),
      outputItem({
        id: "todo-new",
        type: "todo_list",
        steps: [
          { id: "a", text: "done", status: "completed" },
          { id: "b", text: "dropped", status: "cancelled" },
          { id: "c", text: "active", status: "running" },
        ],
      }),
    ],
  });
  assert.deepEqual(progress, { itemId: "todo-new", completed: 1, total: 3, running: [{ id: "c", text: "active" }] });
});
