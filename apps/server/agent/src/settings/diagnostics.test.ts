import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import { accessGuard } from "../access.ts";
import { closeStore, writeRecord } from "../durable/store.ts";
import { collectAgentDiagnostics, collectAgentStorage, diagnosticsRoutes } from "./diagnostics.ts";

function isolated(task: (directory: string) => void | Promise<void>) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "agent-diagnostics-test-"));
  const oldDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
  const oldToken = process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
  const oldSecret = process.env.DIAGNOSTICS_TEST_SECRET;
  closeStore();
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
  process.env.DIAGNOSTICS_TEST_SECRET = "fake-process-env-secret";
  return Promise.resolve().then(() => task(directory)).finally(() => {
    closeStore();
    if (oldDirectory === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR;
    else process.env.AGENT_WORKSPACE_DATA_DIR = oldDirectory;
    if (oldToken === undefined) delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
    else process.env.AGENT_WORKSPACE_ACCESS_TOKEN = oldToken;
    if (oldSecret === undefined) delete process.env.DIAGNOSTICS_TEST_SECRET;
    else process.env.DIAGNOSTICS_TEST_SECRET = oldSecret;
    rmSync(directory, { recursive: true, force: true });
  });
}

test("diagnostics never initializes a missing store/provider config or claims Provider readiness", () => isolated((directory) => {
  const before = readdirSync(directory);
  const report = collectAgentDiagnostics();
  assert.equal(report.service.durableStore, "unavailable");
  assert.equal(report.service.ownsStore, false);
  assert.equal(report.service.threads, null);
  assert.equal(report.providers.configuration, "unavailable");
  assert.equal(report.privacy.providerExecutionVerified, false);
  assert.equal(report.recentFailures.available, false);
  assert.deepEqual(readdirSync(directory), before);
}));

test("actual store ownership/counts and revision-bound Provider observations are separated without secrets", () => isolated((directory) => {
  writeRecord("chat:threads", "fake-private-thread-id", { title: "fake-private-thread-title", settings: { systemPrompt: "fake-private-prompt" } });
  writeRecord("chat:history", "history", { messages: [{ text: "fake-private-message" }, { text: "other private message" }] });
  writeRecord("chat:generations", "fake-private-failure-id", { status: "failed", errorClass: "authentication",
    error: "fake-provider-error-secret", endedAt: "2026-10-27T12:00:00.000Z", request: { messages: ["fake-private-message"] } });
  writeRecord("durable:runs", "fake-private-run-id", { status: "interrupted", errorClass: "fake-provider-error-secret",
    error: "fake-provider-error-secret", endedAt: "fake-private-invalid-timestamp" });
  const configuration = JSON.stringify({ version: 1, instances: [
    { instanceId: "fake-private-provider-id", driver: "openai", label: "fake-private-provider-label", revision: 4,
      baseUrl: "https://user:fake-url-secret@private.invalid/v1", env: { API_KEY: "fake-inline-secret" },
      observations: { instanceRevision: 4, lastConnectionTest: { ok: true, authentication: "authenticated", instanceRevision: 4,
        checkedAt: "2026-10-27T12:00:00.000Z", error: "fake-provider-error-secret" } } },
    { instanceId: "codex", driver: "codex", revision: 5, cliHome: path.join(directory, "outside-default-homes"),
      observations: { instanceRevision: 4,
      lastConnectionTest: { ok: true, authentication: "authenticated", instanceRevision: 4, checkedAt: "2026-10-27T12:00:00.000Z" },
      installation: { status: "installed", executablePath: "/fake-private-executable", version: "fake-private-version" } } },
    { instanceId: "native-secret-agent", driver: "opencode", label: "private-native-label", enabled: false, revision: 6,
      config: { serverUrl: "https://private.invalid", serverPassword: "fake-native-config-secret" },
      observations: { instanceRevision: 6, lastConnectionTest: { ok: true, authentication: "authenticated",
        instanceRevision: 6, checkedAt: "2026-10-27T12:00:00.000Z" } } },
  ] });
  writeFileSync(path.join(directory, "provider-instances.json"), configuration, { mode: 0o600 });
  // A credential path that cannot be read: collecting a report must not try to read it.
  symlinkSync(path.join(directory, "missing-secret-file"), path.join(directory, "providers.json"));
  const report = collectAgentDiagnostics();
  assert.equal(report.service.durableStore, "ok");
  assert.equal(report.service.ownsStore, true);
  assert.deepEqual([report.service.threads, report.service.histories, report.service.messages], [1, 1, 2]);
  assert.deepEqual([report.providers.total, report.providers.native, report.providers.inactive], [3, 2, 1]);
  assert.equal(report.providers.observations[0]!.driver, "codex");
  assert.equal(report.providers.observations[0]!.connection, "unknown");
  assert.equal(report.providers.observations[0]!.authentication, "unknown");
  assert.equal(report.providers.observations[1]!.enabled, false);
  assert.equal(report.providers.observations[1]!.connection, "unknown");
  assert.equal(report.providers.observations[1]!.authentication, "unknown");
  assert.equal(report.recentFailures.available, true);
  assert.equal(report.recentFailures.items.length, 2);
  assert.deepEqual(report.recentFailures.items.find((item) => item.source === "chat"),
    { source: "chat", status: "failed", errorClass: "authentication", endedAt: "2026-10-27T12:00:00.000Z" });
  assert.deepEqual(report.recentFailures.items.find((item) => item.source === "execution"),
    { source: "execution", status: "interrupted", errorClass: "unknown", endedAt: null });
  const serialized = JSON.stringify(report);
  for (const secret of [directory, "fake-private-thread", "fake-private-prompt", "fake-private-message", "fake-private-provider", "fake-url-secret", "fake-inline-secret", "fake-process-env-secret", "fake-provider-error-secret", "fake-private-executable", "fake-private-version", "fake-native-config-secret", "private-native-label"])
    assert.equal(serialized.includes(secret), false, `Report leaked fixture category: ${secret}`);
  assert.equal(readFileSync(path.join(directory, "provider-instances.json"), "utf8"), configuration);
  const storage = collectAgentStorage();
  assert.equal(storage.dataDirectory, directory);
  assert.equal(storage.entries.find((entry) => entry.kind === "provider-credentials")!.status, "unavailable");
  assert.equal(storage.maintenance.httpBackupAvailable, false);
  for (let index = 0; index < 15; index++) writeRecord("durable:runs", `fake-private-run-${index}`,
    { status: "failed", errorClass: "provider_error", endedAt: `2026-10-28T12:00:${String(index).padStart(2, "0")}.000Z` });
  assert.equal(collectAgentDiagnostics().recentFailures.items.length, 10);
}));

test("all nine native kinds retain revision-bound status while arbitrary obsolete kinds stay inert", () => isolated((directory) => {
  const drivers = ["codex", "claude", "cursor", "grok", "opencode", "antigravity", "muse", "pi", "acpRegistry"];
  const configuration = JSON.stringify({ version: 1, instances: [
    ...drivers.map((driver, index) => ({ instanceId: `native-${index}`, driver, label: driver, enabled: true, revision: 2,
      config: {}, observations: { instanceRevision: 2, lastConnectionTest: { ok: true, instanceRevision: 2,
        authentication: "authenticated", checkedAt: "2026-10-27T12:00:00.000Z" } } })),
    { instanceId: "obsolete", driver: "unrecognized-old-extension", privateUnknown: { token: "do-not-return" } },
  ] });
  writeFileSync(path.join(directory, "provider-instances.json"), configuration);
  const report = collectAgentDiagnostics();
  assert.equal(report.providers.configuration, "ok");
  assert.deepEqual([report.providers.total, report.providers.native, report.providers.inactive], [10, 9, 1]);
  assert.deepEqual(report.providers.observations.map((entry) => entry.driver), drivers);
  assert.equal(report.providers.observations.every((entry) => entry.authentication === "authenticated"), true);
  assert.doesNotMatch(JSON.stringify(report), /do-not-return|unrecognized-old-extension/);
  assert.equal(readFileSync(path.join(directory, "provider-instances.json"), "utf8"), configuration);
}));

test("safe downloadable report retains existing access/origin guards and has no HTTP secret backup endpoint", () => isolated(async () => {
  const app = new Hono().use("/api/*", accessGuard).route("/api", diagnosticsRoutes);
  const denied = await app.request("http://localhost/api/settings/diagnostics/report", { headers: { host: "localhost", origin: "https://evil.invalid" } });
  assert.equal(denied.status, 403);
  const downloaded = await app.request("http://localhost/api/settings/diagnostics/report?filename=secret.env", { headers: { host: "localhost" } });
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get("cache-control"), "no-store");
  assert.equal(downloaded.headers.get("content-disposition"), 'attachment; filename="agent-diagnostics.json"');
  assert.equal(downloaded.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await downloaded.json()).privacy.reportContains, "allowlisted-status-only");
  assert.equal((await app.request("http://localhost/api/settings/backup", { headers: { host: "localhost" } })).status, 404);
  process.env.AGENT_WORKSPACE_ACCESS_TOKEN = "fixture-token-" + "x".repeat(40);
  assert.equal((await app.request("https://private.example/api/settings/diagnostics/report", { headers: { host: "private.example" } })).status, 401);
}));
