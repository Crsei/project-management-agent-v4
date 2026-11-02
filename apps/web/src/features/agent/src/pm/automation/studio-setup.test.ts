import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { applyStudioAssistantPatch, clearStudioRecovery, cronFor, emptyStudioConfig, frequencyOf, interpolateStudioExpression, interpolateStudioTemplate, onceInZone, parseStudioObject, readStudioDraft, redactStudioRecovery, settleStudioPriorRequest, studioConnectionSupportsAction, studioDraftKey, studioPendingFromPriorMembership, studioProviderToolReadiness, type StudioDraftState, type StudioPending } from "./studio-setup.ts";
import type { AutomationIntegrationConnection } from "../../../../../../../../packages/contracts/src/automation-integrations.ts";
import type { StudioCapabilities, StudioConfig } from "../../../../../../../../packages/contracts/src/automation-studio.ts";

function installStorage(t: TestContext) {
  const entries = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); },
  } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "sessionStorage", previous); else Reflect.deleteProperty(globalThis, "sessionStorage"); });
  return entries;
}

test("all six time frequencies preserve their actual trigger semantics", () => {
  assert.equal(cronFor("hourly", "09:17", "1", ""), "17 * * * *");
  assert.equal(cronFor("daily", "09:17", "1", ""), "17 9 * * *");
  assert.equal(cronFor("weekdays", "09:17", "1", ""), "17 9 * * 1-5");
  assert.equal(cronFor("weekly", "09:17", "4", ""), "17 9 * * 4");
  assert.equal(cronFor("custom", "09:17", "1", "*/7 2-4 * * 0,6"), "*/7 2-4 * * 0,6");
  const once = onceInZone("2027-01-02T09:17", "Asia/Shanghai");
  assert.equal(once, "2027-01-02T01:17:00.000Z");
  assert.equal(frequencyOf({ kind: "once", at: once, timezone: "Asia/Shanghai" }), "once");
  assert.equal(frequencyOf({ kind: "cron", expression: "17 9 * * 1-5", timezone: "UTC" }), "weekdays");
  assert.equal(frequencyOf({ kind: "cron", expression: "*/7 2-4 * * 0,6", timezone: "UTC" }), "custom");
});

test("once rejects a nonexistent DST local time instead of shifting or creating an annual cron", () => {
  assert.throws(() => onceInZone("2027-03-14T02:30", "America/New_York"), /does not exist/);
  assert.equal(onceInZone("2027-03-14T03:30", "America/New_York"), "2027-03-14T07:30:00.000Z");
});

test("test payload and filters must be JSON objects", () => {
  for (const text of ["[]", "null", '"value"', "42", "true"]) assert.throws(() => parseStudioObject(text));
  assert.deepEqual(parseStudioObject('{"repository":{"full_name":"org/repo"}}'), { repository: { full_name: "org/repo" } });
});

test("source bundle values retain arrays/numbers while expression literals are escaped", () => {
  const values = { repositories: ["org/a", "org/b"], maxNewPerRun: 2, triggerReviewer: "a'b\\c" };
  assert.deepEqual(interpolateStudioTemplate({ repos: "{{form.repositories}}", limit: "{{form.maxNewPerRun}}" }, values), { repos: ["org/a", "org/b"], limit: 2 });
  assert.equal(interpolateStudioExpression("contains({{form.repositories}}, repository.full_name)", values), "contains(['org/a', 'org/b'], repository.full_name)");
  assert.equal(interpolateStudioExpression("review.user.login == '{{form.triggerReviewer}}'", values), "review.user.login == 'a\\'b\\\\c'");
});

test("assistant updates protect nested native arguments and edits made after preview", () => {
  const config = emptyStudioConfig("PRJ-001");
  config.name = "My name";
  config.action = { kind: "template", templateId: "github-issue-to-pr", arguments: { triggerLabel: "mine", branchPrefix: "old" }, providerInstanceId: "provider-a", model: "real-model", options: {}, repositories: [], plugins: [], timeoutSeconds: 600 };
  const patch = { name: "AI name", description: "AI description", action: { ...config.action, arguments: { triggerLabel: "AI label", branchPrefix: "new" }, providerInstanceId: "provider-b" } };
  const merged = applyStudioAssistantPatch(config, patch, new Set(["name", "action.arguments.triggerLabel", "action.providerInstanceId"]));
  assert.equal(merged.name, "My name");
  assert.equal(merged.description, "AI description");
  assert.equal(merged.action.kind, "template");
  if (merged.action.kind === "template") {
    assert.equal(merged.action.arguments.triggerLabel, "mine");
    assert.equal(merged.action.arguments.branchPrefix, "new");
    assert.equal(merged.action.providerInstanceId, "provider-a");
  }
  const afterUserEdit = { ...merged, description: "Typed after preview" };
  assert.equal(applyStudioAssistantPatch(afterUserEdit, merged, new Set(["description"])).description, "Typed after preview");
  const switched = applyStudioAssistantPatch(config, { action: { kind: "script", files: [], content: "print(1)", setup: "", entrypoint: "python3 main.py", bundleRef: null, repositories: [], plugins: [], timeoutSeconds: 600 } }, new Set(["action.arguments.triggerLabel"]));
  assert.equal(switched.action.kind, "template");
  assert.deepEqual(config.action.arguments, { triggerLabel: "mine", branchPrefix: "old" });
});

test("membership cutovers redact private drafts but retain original unknown request identity", t => {
  const entries = installStorage(t);
  const config = { ...emptyStudioConfig("PRJ-001"), name: "Private input" };
  const pending: StudioPending = { requestId: "original-key", kind: "create", definitionId: null, expectedRevision: null, config, after: "test", payload: { private: true } };
  const draft: StudioDraftState = { version: 1, config, baseline: config, definition: null, values: { notes: "private" }, touched: ["name"], pending, test: null, testPayload: '{"private":true}' };
  const oldKey = studioDraftKey("actor", "workspace", 1, "new:blank:PRJ-001");
  entries.set(oldKey, JSON.stringify(draft));
  const retained = studioPendingFromPriorMembership("actor", "workspace", 2, "new:blank:PRJ-001");
  assert.equal(retained?.requestId, "original-key");
  assert.equal(retained?.config, null);
  assert.equal(retained?.payload, null);
  assert.equal(retained?.after, null);
  redactStudioRecovery("actor", "workspace", 2);
  assert.equal(entries.get(oldKey)?.includes("Private input"), false);
  assert.equal(readStudioDraft(oldKey), null);
  assert.equal(studioPendingFromPriorMembership("other", "workspace", 2, "new:blank:PRJ-001"), null);
  assert.equal(studioPendingFromPriorMembership("actor", "other", 2, "new:blank:PRJ-001"), null);
  settleStudioPriorRequest("actor", "workspace", "original-key", "new-key");
  assert.equal(entries.has(oldKey), false);
});

test("explicit access loss redacts the current membership without fabricating a receipt", t => {
  const entries = installStorage(t);
  const key = studioDraftKey("actor", "workspace", 3, "definition-id");
  entries.set(key, JSON.stringify({ version: 1, config: { private: true }, pending: { requestId: "unknown", kind: "test", config: { private: true }, payload: { private: true }, after: "enable" } }));
  clearStudioRecovery("actor", "workspace");
  assert.equal(entries.get(key)?.includes('"private"'), false);
  assert.equal(studioPendingFromPriorMembership("actor", "workspace", 3, "definition-id")?.requestId, "unknown");
});


test("API-only verification enables native workflows without pretending MCP is connected", () => {
  const connection: AutomationIntegrationConnection = {
    id: "connection", revision: 3, projectId: "PRJ-001", provider: "github", label: "Authorized repository API",
    endpoint: "https://api.github.com", readTools: [], writeTools: [], nativeApi: { baseUrl: "https://api.github.com", repositories: ["org/repo"], allowWrites: true },
    status: "verified", verification: { mcp: false, nativeApi: true }, hasCredentials: true, lastCheckedAt: "2026-11-01T00:00:00.000Z", lastError: null, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
  };
  assert.equal(studioConnectionSupportsAction(connection, "template"), true);
  assert.equal(studioConnectionSupportsAction(connection, "prompt"), false);
  assert.equal(studioConnectionSupportsAction(connection, "script"), false);
  assert.equal(studioConnectionSupportsAction({ ...connection, verification: { mcp: false, nativeApi: false } }, "template"), false);
  assert.equal(studioConnectionSupportsAction({ ...connection, status: "revoked" }, "template"), false);
});

test("MCP and native API probes cannot substitute for each other on a dual-channel connector", () => {
  const connection: AutomationIntegrationConnection = {
    id: "connection", revision: 4, projectId: "PRJ-001", provider: "gitlab", label: "Dual channel",
    endpoint: "https://gitlab.example.test/mcp", readTools: ["get_issue"], writeTools: [], nativeApi: { baseUrl: "https://gitlab.example.test/api/v4", repositories: ["group/project"], allowWrites: false },
    status: "verified", verification: { mcp: true, nativeApi: false }, hasCredentials: true, lastCheckedAt: "2026-11-01T00:00:00.000Z", lastError: null, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
  };
  assert.equal(studioConnectionSupportsAction(connection, "prompt"), true);
  assert.equal(studioConnectionSupportsAction(connection, "script"), true);
  assert.equal(studioConnectionSupportsAction(connection, "template"), false);
  assert.equal(studioConnectionSupportsAction({ ...connection, verification: { mcp: false, nativeApi: true } }, "prompt"), false);
  assert.equal(studioConnectionSupportsAction({ ...connection, verification: { mcp: true, nativeApi: true } }, "template"), true);
});

test("selected Provider tool limits do not disable ordinary model-only prompts", () => {
  const capabilities: StudioCapabilities = {
    canWrite: true, actions: [], providers: [], repositories: [], plugins: [], scheduler: { authority: "worker", ready: true, reason: null },
    features: [
      { id: "provider:restricted:promptConnectors", available: false, reason: "This driver cannot receive PM and integration servers together." },
      { id: "provider:supported:promptConnectors", available: true, reason: null },
    ],
  };
  const config = emptyStudioConfig("PRJ-001");
  config.action = { kind: "prompt", prompt: "Summarize this text", providerInstanceId: "restricted", model: "configured-model", options: {}, repositories: [], plugins: [], timeoutSeconds: 600 };
  assert.deepEqual(studioProviderToolReadiness(config, capabilities), { featureId: null, available: true, reason: null });
  config.action.plugins = [{ id: "integration:connection", version: "3" }];
  const blocked = studioProviderToolReadiness(config, capabilities);
  assert.equal(blocked.available, false);
  assert.equal(blocked.reason, "This driver cannot receive PM and integration servers together.");
  assert.equal(studioProviderToolReadiness({ ...config, action: { ...config.action, providerInstanceId: "supported" } }, capabilities).available, true);
  assert.equal(studioProviderToolReadiness(config, null).available, false);
});

test("workspace-tool limits apply to repository templates, not news or deterministic native workflows", () => {
  const capabilities: StudioCapabilities = {
    canWrite: true, actions: [], providers: [], repositories: [], plugins: [], scheduler: { authority: "worker", ready: true, reason: null },
    features: [{ id: "provider:model-only:templateWorkspace", available: false, reason: "This driver has no scoped repository workspace adapter." }],
  };
  const config: StudioConfig = { ...emptyStudioConfig("PRJ-001"), action: { kind: "template", templateId: "github-issue-to-pr", arguments: {}, providerInstanceId: "model-only", model: "configured-model", options: {}, repositories: [], plugins: [], timeoutSeconds: 600 } };
  assert.equal(studioProviderToolReadiness(config, capabilities).reason, "This driver has no scoped repository workspace adapter.");
  if (config.action.kind !== "template") throw new Error("Expected template test configuration");
  const news = { ...config, action: { ...config.action, templateId: "news-digest" as const } };
  assert.deepEqual(studioProviderToolReadiness(news, capabilities), { featureId: null, available: true, reason: null });
  const deterministic = { ...config, action: { ...config.action, templateId: "github-delivery-watchdog" as const, providerInstanceId: null, model: null, options: {} } };
  assert.deepEqual(studioProviderToolReadiness(deterministic, capabilities), { featureId: null, available: true, reason: null });
});
