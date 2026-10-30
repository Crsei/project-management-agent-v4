import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ProvidersResponse } from "@agent-workspace/contracts/provider";
import { closeStore } from "./durable/store.ts";
import { nativeProviderAdapters } from "./providers/driver-registry.ts";
import { createProviderInstance } from "./providers/instances.ts";

// Keep every native home private and every status check deterministic; contract
// tests must not inspect an installed CLI account or make a model request.
const dataDirectory = await mkdtemp(path.join(tmpdir(), "agent-workspace-contracts-"));
process.env.AGENT_WORKSPACE_DATA_DIR = dataDirectory;
const originals = nativeProviderAdapters.map((adapter) => ({
  adapter,
  check: adapter.check,
  run: adapter.run,
}));
let nativeTurns = 0;
for (const { adapter } of originals) {
  adapter.check = async () => ({
    installation: { status: "not-installed" },
    authentication: "unknown",
    models: [],
    methods: [],
    canLogout: false,
  });
  adapter.run = async () => {
    nativeTurns += 1;
    throw new Error("Contract tests must never execute a native turn.");
  };
}
// Import the app only after its native homes and adapter seams are isolated.

const { app } = await import("./app.ts");

after(async () => {
  for (const { adapter, check, run } of originals) {
    adapter.check = check;
    adapter.run = run;
  }
  closeStore();
  await rm(dataDirectory, { recursive: true, force: true });
});

const localRequest = (input: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  // The provider routes only accept localhost hosts; app.request() does not add
  // a Host header on its own.
  headers.set("host", "localhost");
  return app.request(`http://localhost${input}`, { ...init, headers });
};

const postJson = (input: string, body: unknown) =>
  localRequest(input, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const validStep = (id: string) => ({
  id,
  name: `步骤 ${id}`,
  model: "gpt-5.4",
  providerInstanceId: "codex",
  system: "",
  instruction: "总结输入。",
});

const validRun = () => ({
  runId: "run-contract",
  threadId: "thread-contract",
  name: "契约测试",
  kind: "workflow",
  input: "请总结这段文本。",
  context: "",
  temperature: 0.7,
  steps: [validStep("step-1")],
});

const assertJsonError = async (response: Response, status: number) => {
  assert.equal(response.status, status);
  const payload = (await response.json()) as { error?: unknown; code?: unknown };
  assert.equal(typeof payload.error, "string");
  return payload;
};

test("GET /api/providers exposes the native inventory and source metadata without credential material", async () => {
  const secret = "contract-native-server-password";
  const envSecret = "contract-private-environment-value";
  createProviderInstance({
    instanceId: "contract-native",
    driver: "opencode",
    label: "Private native server",
    config: { serverUrl: "https://native.invalid", serverPassword: secret },
    environment: [{ name: "CONTRACT_NATIVE_KEY", value: envSecret, sensitive: true }],
  });
  const response = await localRequest("/api/providers");
  assert.equal(response.status, 200);

  const text = await response.text();
  const payload = JSON.parse(text) as ProvidersResponse;
  for (const provider of payload.providers) {
    assert.equal(provider.authMode, "agent");
    assert.equal(provider.configured, false);
    assert.equal(provider.credentialSource, null);
    assert.equal(Object.hasOwn(provider, "apiKey"), false);
    assert.equal(Object.hasOwn(provider, "hint"), false);
  }
  const privateProvider = payload.providers.find((provider) => provider.instanceId === "contract-native");
  assert.ok(privateProvider);
  assert.equal(privateProvider.config.serverPassword, undefined);
  assert.deepEqual(privateProvider.secretConfigKeys, ["serverPassword"]);
  assert.deepEqual(privateProvider.environment, [{ name: "CONTRACT_NATIVE_KEY", value: "", sensitive: true, valueRedacted: true }]);
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes(envSecret), false);
  assert.equal(/sk-[A-Za-z0-9_-]{8,}/.test(text), false);
  assert.equal(nativeTurns, 0);
});

test("POST /api/chat rejects malformed and incomplete bodies", async () => {
  const invalidJson = await localRequest("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not-json{",
  });
  await assertJsonError(invalidJson, 400);

  const missingMessages = await postJson("/api/chat", { system: "测试" });
  const payload = await assertJsonError(missingMessages, 400);
  assert.equal(payload.code, "invalid_request");
});

test("POST /api/chat refuses legacy unscoped execution without defaulting to the repository", async () => {
  const response = await postJson("/api/chat", {
    id: "thread-contract",
    messages: [{ id: "m-1", role: "user", parts: [{ type: "text", text: "你好" }] }],
  });

  const payload = await assertJsonError(response, 412);
  assert.equal(payload.code, "scope_required");
});

test("POST /api/workspace/runs validates request boundaries", async () => {
  const missing = await postJson("/api/workspace/runs", {});
  await assertJsonError(missing, 400);

  const tooManySteps = await postJson("/api/workspace/runs", {
    ...validRun(),
    steps: Array.from({ length: 9 }, (_, index) => validStep(`step-${index + 1}`)),
  });
  await assertJsonError(tooManySteps, 400);

  const duplicateIds = await postJson("/api/workspace/runs", {
    ...validRun(),
    steps: [validStep("step-1"), validStep("step-1")],
  });
  await assertJsonError(duplicateIds, 400);

  const longInput = await postJson("/api/workspace/runs", {
    ...validRun(),
    input: "x".repeat(8001),
  });
  await assertJsonError(longInput, 400);
});

test("POST /api/workspace/runs rejects bodies over 2 MiB with 413", async () => {
  const oversized = await postJson("/api/workspace/runs", {
    ...validRun(),
    context: "x".repeat(2 * 1024 * 1024),
  });
  assert.equal(oversized.status, 413);
  const payload = (await oversized.json()) as { error?: unknown };
  assert.equal(typeof payload.error, "string");
});
