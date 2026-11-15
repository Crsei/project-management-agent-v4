import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { createWorkspaceClient } from "@agent-workspace/client-runtime";
import { createAgentSessionLifecycle } from "./session-lifecycle-model.ts";

const workspaceClient = createWorkspaceClient({ basePath: "/agent" });
const { setAgentSessionStatus, deleteAgentSession } = createAgentSessionLifecycle({
  client: workspaceClient,
  storage: {
    getItem: key => sessionStorage.getItem(key),
    setItem: (key, value) => sessionStorage.setItem(key, value),
    removeItem: key => sessionStorage.removeItem(key),
  },
  confirm: () => true,
  text: (_zh, en) => en,
});

function storage(t: TestContext) {
  const entries = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } } });
  t.after(() => { if (original) Object.defineProperty(globalThis, "sessionStorage", original); else Reflect.deleteProperty(globalThis, "sessionStorage"); });
  return entries;
}

test("archive uses current independent lifecycle CAS, never the settings revision", async t => {
  const writes: unknown[] = [];
  t.mock.method(workspaceClient, "json", async <T>(_path: string, init?: RequestInit): Promise<T> => {
    if (init?.method === "PUT") writes.push(JSON.parse(String(init.body)));
    return { thread: { status: init?.method === "PUT" ? "archived" : "regular", revision: 99, lifecycleRevision: 7 } } as T;
  });
  await setAgentSessionStatus("session", "archived");
  assert.deepEqual(writes, [{ status: "archived", lifecycleRevision: 7 }]);
});

test("lost committed deletion reconciles original receipt without reading deleted thread or resending DELETE", async t => {
  const entries = storage(t);
  const deletes: { operationId: string; body: unknown }[] = [];
  const reads: string[] = [];
  let committed = false;
  t.mock.method(workspaceClient, "json", async <T>(path: string, init?: RequestInit): Promise<T> => {
    if (init?.method === "DELETE") {
      deletes.push({ operationId: new Headers(init.headers).get("Idempotency-Key")!, body: JSON.parse(String(init.body)) });
      committed = true;
      throw new TypeError("response lost after commit");
    }
    reads.push(path);
    if (path.includes("/lifecycle-operations/")) return { operation: { operationId: path.split("/").at(-1), state: "committed", closingClaimed: true, reasons: [] } } as T;
    if (committed) throw new Error("must not read a deleted Session to reconcile its deletion");
    if (path.endsWith("/generations")) return { generations: [{ id: "exact-generation", status: "running" }] } as T;
    return { thread: { remoteId: "session", lifecycleRevision: 8 } } as T;
  });
  await assert.rejects(deleteAgentSession("session", () => true), /response lost/);
  assert.equal(entries.size, 1);
  assert.deepEqual(deletes[0]?.body, { lifecycleRevision: 8, confirm: true, expectedGenerationId: "exact-generation", stopActive: true });
  await deleteAgentSession("session");
  assert.equal(deletes.length, 1);
  assert.equal(entries.size, 0);
  assert.match(reads.at(-1) ?? "", /\/lifecycle-operations\//);
});

test("ambiguous multiple active generations never dispatches a broad cancellation or deletion", async t => {
  storage(t);
  let deletes = 0;
  t.mock.method(workspaceClient, "json", async <T>(path: string, init?: RequestInit): Promise<T> => {
    if (init?.method === "DELETE") deletes++;
    return (path.endsWith("/generations") ? { generations: [{ id: "one", status: "running" }, { id: "two", status: "queued" }] } : { thread: { lifecycleRevision: 1 } }) as T;
  });
  await assert.rejects(deleteAgentSession("ambiguous"), /generation/);
  assert.equal(deletes, 0);
});

test("pre-closing blocked receipt is immutable and only a later explicit action creates a new delete identity", async t => {
  const entries = storage(t);
  const original = { operationId: "original-blocked", body: { lifecycleRevision: 1, confirm: true, expectedGenerationId: null, stopActive: false } };
  entries.set("agent-chat:delete:before-closing", JSON.stringify(original));
  const deletions: string[] = [];
  t.mock.method(workspaceClient, "json", async <T>(path: string, init?: RequestInit): Promise<T> => {
    if (path.includes("/lifecycle-operations/")) return { operation: { operationId: original.operationId, state: "blocked", closingClaimed: false, reasons: ["unresolved_effect"] } } as T;
    if (init?.method === "DELETE") { deletions.push(new Headers(init.headers).get("Idempotency-Key")!); return { deleted: true, operation: { state: "committed", closingClaimed: true } } as T; }
    return (path.endsWith("/generations") ? { generations: [] } : { thread: { lifecycleRevision: 2 } }) as T;
  });
  await assert.rejects(deleteAgentSession("before-closing"), /before closing|未进入 closing/);
  assert.equal(entries.size, 0);
  assert.equal(deletions.length, 0);
  await deleteAgentSession("before-closing");
  assert.equal(deletions.length, 1);
  assert.notEqual(deletions[0], original.operationId);
});

test("post-closing blocked receipt keeps the exact original identity and body on explicit continuation", async t => {
  const entries = storage(t);
  const original = { operationId: "original-closing", body: { lifecycleRevision: 3, confirm: true, expectedGenerationId: "original-generation", stopActive: true } };
  entries.set("agent-chat:delete:after-closing", JSON.stringify(original));
  const writes: { operationId: string; body: unknown }[] = [];
  t.mock.method(workspaceClient, "json", async <T>(path: string, init?: RequestInit): Promise<T> => {
    if (path.includes("/lifecycle-operations/")) return { operation: { operationId: original.operationId, state: "blocked", closingClaimed: true, reasons: ["stop_unconfirmed"] } } as T;
    if (init?.method === "DELETE") { writes.push({ operationId: new Headers(init.headers).get("Idempotency-Key")!, body: JSON.parse(String(init.body)) }); return { deleted: true, operation: { state: "committed", closingClaimed: true } } as T; }
    throw new Error("post-closing continuation must not rebuild a deletion from current Session state");
  });
  await deleteAgentSession("after-closing");
  assert.deepEqual(writes, [original]);
  assert.equal(entries.size, 0);
});
