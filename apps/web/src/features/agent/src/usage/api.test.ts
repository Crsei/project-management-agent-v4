import assert from "node:assert/strict";
import { test } from "node:test";
import { usageApi } from "./api.ts";

test("usage snapshot reads do not trigger probes and encode thread IDs", async (t) => {
  const original = globalThis.fetch;
  const calls: { url: string; method: string }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    return Response.json({});
  };
  t.after(() => { globalThis.fetch = original; });
  await usageApi.limits();
  await usageApi.thread("thread /?#");
  assert.deepEqual(calls, [
    { url: "/agent/api/usage/limits", method: "GET" },
    { url: "/agent/api/usage/threads/thread%20%2F%3F%23", method: "GET" },
  ]);
});

test("source deletion sends revision and reset is explicit and never retried", async (t) => {
  const original = globalThis.fetch;
  const calls: { url: string; method: string; body: unknown }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    if (String(input).endsWith("/reset")) return Response.json({ error: "unknown outcome" }, { status: 503 });
    return Response.json({ deleted: true });
  };
  t.after(() => { globalThis.fetch = original; });
  await usageApi.deleteSource("hub/a", 4);
  await assert.rejects(usageApi.reset({ instanceId: "account" }));
  assert.deepEqual(calls, [
    { url: "/agent/api/usage/sources/hub%2Fa?revision=4", method: "DELETE", body: null },
    { url: "/agent/api/usage/limits/reset", method: "POST", body: { instanceId: "account" } },
  ]);
});
