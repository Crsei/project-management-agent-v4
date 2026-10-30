import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGrokModelsCliOutput } from "@t3tools/provider-grok/testing";
import { grokAdapter } from "./grok.ts";
import { createAcpTestHarness } from "./acp-test-harness.ts";

test("Grok public settings and source model parser retain native identifiers and login verdict", () => {
  const parsed = parseGrokModelsCliOutput("You are logged in with grok.com.\n* grok-4.7 (default)\n- custom_model");
  assert.equal(parsed.authenticated, true); assert.deepEqual(parsed.models.map(model => model.slug), ["grok-4.7", "custom_model"]);
  assert.equal(parseGrokModelsCliOutput("You are not authenticated.").authenticated, false);
  assert.equal(grokAdapter.validateConfig({}).binaryPath, "grok");
  assert.throws(() => grokAdapter.validateConfig({ apiKey: "not-a-native-setting" }));
  assert.throws(() => grokAdapter.validateConfig({ binaryPath: "bad\0path" }));
});

test("original Grok check keeps external-auth state distinct from native catalog readiness without inference", { timeout: 30_000 }, async t => {
  const f = await createAcpTestHarness("grok");
  try {
    const status = await grokAdapter.check(f.context, t.signal);
    assert.equal(status.installation.status, "installed"); assert.equal(status.authentication, "unauthenticated");
    assert.deepEqual(status.methods, []); assert.equal(status.canLogout, false);
    const wire = await f.records();
    const probes = wire.filter(record => record.method === "cli");
    assert.ok(probes.some(record => JSON.stringify(record.args) === JSON.stringify(["models"])));
    assert.ok(probes.every(record => record.home === f.context.homeDirectory && record.cwd === f.context.cwd));
    assert.equal(wire.some(record => record.method === "session/new" || record.method === "session/prompt" || record.method === "auth/login"), false);
    await assert.rejects(grokAdapter.authenticate(f.context, { signal: t.signal, onUpdate() {}, readInput: async () => "" }),
      { code: "unsupported_auth", status: 409 });
    await assert.rejects(grokAdapter.logout(f.context, t.signal), { code: "unsupported_logout", status: 409 });
    assert.equal((await f.records()).some(record => record.method === "session/prompt" || record.method === "auth/login"), false);
  } finally { await f.close(); }
});

test("original Grok native execution uses its supervised launch and bound native Home", { timeout: 30_000 }, async t => {
  const f = await createAcpTestHarness("grok");
  try {
    const result = await f.run(f.context, { model: "native/default", prompt: "ADD 10 5", signal: t.signal });
    assert.equal(result.text, "Native total=15");
    const wire = await f.records();
    const launches = wire.filter(record => record.method === "cli");
    assert.ok(launches.some(record => JSON.stringify(record.args) === JSON.stringify(["--permission-mode", "default", "agent", "stdio"])));
    assert.ok(launches.every(record => record.home === f.context.homeDirectory && record.cwd === f.context.cwd));
    const initialized = wire.find(record => record.method === "initialize");
    assert.equal(initialized?.home, f.context.homeDirectory); assert.equal(initialized?.cwd, f.context.cwd);
    assert.ok(wire.some(record => record.method === "session/set_config_option"
      && record.type === "id" && record.configId === "model" && record.value === "native/default"));
    const prompt = wire.find(record => record.method === "session/prompt");
    assert.equal(prompt?.model, "native/default");
    assert.equal(result.nativeSession?.driver, "grok");
    assert.equal(result.nativeSession?.cwd, f.context.cwd);
  } finally { await f.close(); }
});
